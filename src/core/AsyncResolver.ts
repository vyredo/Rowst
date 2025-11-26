import type {
	Transport,
	TransportEvents,
	TransportState,
} from "../transports/Transport.js";
import {
	BackpressureError,
	InvalidMessageError,
	RowstError,
	TimeoutError,
	TransportClosedError,
	TransportError,
} from "./errors.js";
import { Logger, LogLevel, NoopTransport } from "./logger.js";
import type {
	CorrelatorOptions,
	LatencyStats,
	Message,
	Metrics,
	RequestOptions,
} from "./types.js";
import { ErrorCode } from "./types.js";
import { generateUUID } from "./uuid.js";

type TransportData = string | ArrayBuffer | Uint8Array;
type TimeoutHandle = ReturnType<typeof setTimeout>;

interface PendingRequest<TResponse = unknown> {
	resolve: (message: Message<TResponse>) => void;
	reject: (error: unknown) => void;
	timeoutHandle: TimeoutHandle;
	createdAt: number;
	attempts: number;
	meta: Record<string, unknown>;
}

type MessageHandler = TransportEvents["message"];
type CloseHandler = TransportEvents["close"];
type ErrorHandler = TransportEvents["error"];
type OpenHandler = TransportEvents["open"];

export interface AsyncResolverOptions extends CorrelatorOptions {
	latencySampleSize?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_INFLIGHT = 1_000;
const DEFAULT_LATENCY_SAMPLE_SIZE = 1_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_JITTER_FACTOR = 0.25;

const fallbackLogger = new Logger({
	level: LogLevel.SILENT,
	transports: [new NoopTransport()],
});

const textDecoder =
	typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

const bufferDecoder = (() => {
	if (typeof globalThis === "undefined") {
		return null;
	}

	const candidate = (
		globalThis as typeof globalThis & {
			Buffer?: {
				from(input: ArrayBuffer | Uint8Array): {
					toString(encoding: string): string;
				};
			};
		}
	).Buffer;

	if (!candidate || typeof candidate.from !== "function") {
		return null;
	}

	return (input: ArrayBuffer | Uint8Array): string =>
		candidate.from(input).toString("utf8");
})();

function decodeTransportData(data: TransportData): string {
	if (typeof data === "string") {
		return data;
	}

	if (data instanceof ArrayBuffer) {
		if (textDecoder) {
			return textDecoder.decode(new Uint8Array(data));
		}
		if (bufferDecoder) {
			return bufferDecoder(new Uint8Array(data));
		}
	}

	if (data instanceof Uint8Array) {
		if (textDecoder) {
			return textDecoder.decode(data);
		}
		if (bufferDecoder) {
			return bufferDecoder(data);
		}
	}

	throw new InvalidMessageError("Unsupported message data type");
}

function cloneOptions(options?: RequestOptions): Record<string, unknown> {
	if (!options) return {};
	const clone: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		clone[key] = Array.isArray(value) ? [...value] : value;
	}
	return clone;
}

function ensureLatencyStats(latencies: number[]): LatencyStats {
	if (latencies.length === 0) {
		return {
			min: 0,
			max: 0,
			mean: 0,
			median: 0,
			p50: 0,
			p95: 0,
			p99: 0,
		};
	}

	const sorted = [...latencies].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	const mean = sum / sorted.length;

	const percentile = (p: number): number => {
		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
	};

	const median =
		sorted.length % 2 === 0
			? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
			: sorted[Math.floor(sorted.length / 2)];

	return {
		min: sorted[0],
		max: sorted[sorted.length - 1],
		mean,
		median,
		p50: percentile(50),
		p95: percentile(95),
		p99: percentile(99),
	};
}

export class AsyncResolver {
	private readonly transport: Transport;
	private readonly logger: Logger;
	private readonly options: Required<
		Pick<
			AsyncResolverOptions,
			"defaultTimeout" | "maxInflight" | "latencySampleSize"
		>
	>;
	private readonly pending = new Map<string, PendingRequest<unknown>>();
	private readonly metrics: Metrics = {
		inflightCount: 0,
		totalRequests: 0,
		totalResponses: 0,
		totalTimeouts: 0,
		totalErrors: 0,
		latencies: [],
	};

	// Response interceptor if configured
	private readonly responseInterceptor?: <T>(
		message: Message<T>,
	) => Message<T> | Promise<Message<T>>;

	// Request deduplication
	private readonly deduplicateFn?: (payload: unknown) => string;
	private readonly inflightByKey = new Map<string, Promise<Message<unknown>>>();
	// Graceful shutdown guard
	private shuttingDown = false;

	private readonly handleMessage: MessageHandler = (data) => {
		void this.onTransportMessage(data).catch((error) => {
			this.logger.error(
				"Failed to process transport message",
				this.describeError(error),
			);
			this.metrics.totalErrors += 1;
		});
	};

	private readonly handleOpen: OpenHandler = () => {
		this.logger.debug("Transport opened");
	};

	private readonly handleClose: CloseHandler = (event) => {
		this.logger.warn("Transport closed", { event });
		this.rejectAllPending(new TransportClosedError("Transport closed", event));
	};

	private readonly handleError: ErrorHandler = (error) => {
		this.logger.error("Transport error", this.describeError(error));
		this.metrics.totalErrors += 1;
	};

	constructor(transport: Transport, options: AsyncResolverOptions = {}) {
		this.transport = transport;
		this.logger = options.logger ?? fallbackLogger;
		this.responseInterceptor = options.responseInterceptor;
		this.options = {
			defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
			maxInflight: options.maxInflight ?? DEFAULT_MAX_INFLIGHT,
			latencySampleSize:
				options.latencySampleSize ?? DEFAULT_LATENCY_SAMPLE_SIZE,
		};

		// Configure request deduplication
		if (options.deduplicateRequests === true) {
			this.deduplicateFn = (payload) => JSON.stringify(payload);
		} else if (typeof options.deduplicateRequests === "function") {
			this.deduplicateFn = options.deduplicateRequests;
		}

		this.transport.on("message", this.handleMessage);
		this.transport.on("open", this.handleOpen);
		this.transport.on("close", this.handleClose);
		this.transport.on("error", this.handleError);
	}

	async request<TResponse = unknown, TRequest = unknown>(
		payload: TRequest,
		options?: RequestOptions,
	): Promise<Message<TResponse>> {
		if (this.shuttingDown) {
			throw new TransportClosedError("Resolver is closing");
		}

		if (this.deduplicateFn) {
			const cacheKey = this.deduplicateFn(payload as unknown);
			const existing = this.inflightByKey.get(cacheKey);
			if (existing) {
				this.logger.debug("Deduplicating request", { cacheKey });
				return existing as Promise<Message<TResponse>>;
			}

			const promise = this.requestAttempt<TResponse, TRequest>(
				payload,
				options,
				1,
			);
			this.inflightByKey.set(cacheKey, promise as Promise<Message<unknown>>);

			promise.finally(() => {
				this.inflightByKey.delete(cacheKey);
			});

			return promise;
		}

		return this.requestAttempt<TResponse, TRequest>(payload, options, 1);
	}

	async requestWithRetry<TResponse = unknown, TRequest = unknown>(
		payload: TRequest,
		options?: RequestOptions,
	): Promise<Message<TResponse>> {
		const retries = options?.retries ?? 0;
		let attempt = 1;
		let lastError: unknown;

		while (attempt <= retries + 1) {
			try {
				const response = await this.requestAttempt<TResponse, TRequest>(
					payload,
					options,
					attempt,
				);
				if (!response.meta) {
					response.meta = { attempts: attempt };
				} else {
					response.meta.attempts = attempt;
				}
				return response;
			} catch (error) {
				lastError = error;
				if (attempt > retries || this.shouldNotRetry(error)) {
					throw error;
				}
				const delay = this.calculateBackoffDelay(attempt, options);
				this.logger.warn("Request attempt failed, retrying", {
					attempt,
					retries,
					delay,
					error: this.describeError(error),
				});
				await this.wait(delay);
				attempt += 1;
			}
		}

		throw lastError ?? new TransportError("Request failed after retries");
	}

	notify<TPayload = unknown>(payload: TPayload): void {
		const message: Message<TPayload> = {
			id: generateUUID(),
			type: "notification",
			payload,
			timestamp: new Date().toISOString(),
		};

		this.sendSerialized(message);
	}

	getInflightCount(): number {
		return this.pending.size;
	}

	getMetrics(): Metrics & { stats: LatencyStats; dedupCacheSize: number } {
		return {
			...this.metrics,
			inflightCount: this.pending.size,
			stats: ensureLatencyStats(this.metrics.latencies),
			// Add deduplication stats
			dedupCacheSize: this.inflightByKey.size,
		};
	}

	/**
	 * Wait for transport to reach 'open' state.
	 * Resolves immediately if already open.
	 * Rejects on timeout or if transport closes/errors.
	 */
	async waitForReady(options?: {
		timeout?: number;
		throwOnTimeout?: boolean;
	}): Promise<void> {
		const timeout = options?.timeout ?? 5000;
		const throwOnTimeout = options?.throwOnTimeout ?? true;

		if (this.transport.readyState === "open") {
			return;
		}

		if (
			this.transport.readyState === "closed" ||
			this.transport.readyState === "closing"
		) {
			throw new TransportClosedError("Transport is not open");
		}

		return new Promise<void>((resolve, reject) => {
			let timeoutHandle: TimeoutHandle | null = null;

			const cleanup = () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				this.transport.off("open", onOpen);
				this.transport.off("close", onClose);
				this.transport.off("error", onError);
			};

			const onOpen = () => {
				cleanup();
				resolve();
			};

			const onClose = (event?: unknown) => {
				cleanup();
				reject(
					new TransportClosedError("Transport closed while waiting", event),
				);
			};

			const onError = (error: Error | unknown) => {
				cleanup();
				reject(new TransportError("Transport error while waiting", error));
			};

			this.transport.on("open", onOpen);
			this.transport.on("close", onClose);
			this.transport.on("error", onError);

			timeoutHandle = setTimeout(() => {
				cleanup();
				if (throwOnTimeout) {
					reject(
						new TimeoutError(`Transport did not open within ${timeout}ms`),
					);
				} else {
					resolve();
				}
			}, timeout);
		});
	}

	/**
	 * Check if transport is ready to send requests.
	 */
	isReady(): boolean {
		return this.transport.readyState === "open";
	}

	/**
	 * Get current transport state.
	 */
	getTransportState(): TransportState {
		return this.transport.readyState;
	}

	/**
	 * Gracefully close the resolver.
	 * - Stop accepting new requests
	 * - Wait for pending requests to complete or timeout
	 * - Close transport
	 */
	async close(options?: { timeout?: number; force?: boolean }): Promise<void> {
		const timeout = options?.timeout ?? 30_000;
		const force = options?.force ?? false;

		this.logger.info("Closing AsyncResolver", {
			pendingCount: this.pending.size,
			timeout,
			force,
		});

		// Stop accepting new requests
		this.shuttingDown = true;

		if (this.pending.size === 0 || force) {
			this.destroy();
			this.transport.close();
			return;
		}

		const startTime = Date.now();
		await new Promise<void>((resolve) => {
			const checkInterval = setInterval(() => {
				const elapsed = Date.now() - startTime;

				if (this.pending.size === 0) {
					clearInterval(checkInterval);
					this.destroy();
					this.transport.close();
					resolve();
					return;
				}

				if (elapsed >= timeout) {
					clearInterval(checkInterval);
					this.logger.warn("Close timeout reached, forcing shutdown", {
						remainingRequests: this.pending.size,
					});
					this.destroy();
					this.transport.close();
					resolve();
				}
			}, 100);
		});
	}

	/**
	 * Get detailed info about pending requests (for debugging).
	 */
	getDebugInfo(): {
		pending: Array<{
			id: string;
			age: number;
			attempts: number;
			meta: Record<string, unknown>;
		}>;
		metrics: ReturnType<AsyncResolver["getMetrics"]>;
		transportState: TransportState;
	} {
		const now = Date.now();
		const pending = Array.from(this.pending.entries()).map(([id, req]) => ({
			id,
			age: now - req.createdAt,
			attempts: req.attempts,
			meta: req.meta,
		}));

		return {
			pending,
			metrics: this.getMetrics(),
			transportState: this.transport.readyState,
		};
	}

	/**
	 * Enable/disable trace logging at runtime.
	 */
	setLogLevel(level: LogLevel): void {
		this.logger.setLevel(level);
	}

	destroy(): void {
		this.transport.off("message", this.handleMessage);
		this.transport.off("open", this.handleOpen);
		this.transport.off("close", this.handleClose);
		this.transport.off("error", this.handleError);
		this.rejectAllPending(new TransportClosedError("Resolver destroyed"));
	}

	private requestAttempt<TResponse, TRequest>(
		payload: TRequest,
		options: RequestOptions | undefined,
		attempt: number,
	): Promise<Message<TResponse>> {
		if (
			this.transport.readyState === "closing" ||
			this.transport.readyState === "closed"
		) {
			throw new TransportClosedError();
		}

		if (this.pending.size >= this.options.maxInflight) {
			throw new BackpressureError(
				`Max inflight requests (${this.options.maxInflight}) exceeded`,
			);
		}

		const requestId = generateUUID();
		const timeout = options?.timeout ?? this.options.defaultTimeout;
		const createdAt = Date.now();

		const meta = this.buildMeta(options, attempt);

		const requestMessage: Message<TRequest> = {
			id: requestId,
			type: "request",
			payload,
			timestamp: new Date().toISOString(),
			meta,
		};

		this.metrics.totalRequests += 1;
		this.metrics.inflightCount = this.pending.size + 1;

		return new Promise<Message<TResponse>>((resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				this.pending.delete(requestId);
				this.metrics.totalTimeouts += 1;
				this.metrics.inflightCount = this.pending.size;
				const timeoutError = new TimeoutError(
					`Request ${requestId} timed out after ${timeout}ms`,
					{
						requestId,
						timeout,
					},
				);
				this.logger.warn("Request timed out", { requestId, timeout });
				reject(timeoutError);
			}, timeout);

			const pendingRequest: PendingRequest<TResponse> = {
				resolve: (message) => {
					clearTimeout(timeoutHandle);
					this.metrics.totalResponses += 1;
					this.recordLatency(Date.now() - createdAt);
					resolve(message);
				},
				reject: (error) => {
					clearTimeout(timeoutHandle);
					this.metrics.totalErrors += 1;
					reject(error);
				},
				timeoutHandle,
				createdAt,
				attempts: attempt,
				meta,
			};

			this.pending.set(requestId, pendingRequest as PendingRequest<unknown>);

			try {
				this.sendSerialized(requestMessage);
			} catch (error) {
				clearTimeout(timeoutHandle);
				this.pending.delete(requestId);
				this.metrics.inflightCount = this.pending.size;
				const transportError =
					error instanceof RowstError
						? error
						: new TransportError("Failed to send request", error);
				this.logger.error("Failed to send request", {
					requestId,
					error: this.describeError(transportError),
				});
				reject(transportError);
			}
		});
	}

	private sendSerialized(message: Message<unknown>): void {
		try {
			const serialized = JSON.stringify(message);
			this.transport.send(serialized);
			this.logger.trace("Sent message", {
				id: message.id,
				type: message.type,
			});
		} catch (error) {
			throw new TransportError("Transport send failed", error);
		}
	}

	private async onTransportMessage(data: TransportData): Promise<void> {
		const raw = decodeTransportData(data);
		let parsed: Message;

		try {
			parsed = JSON.parse(raw) as Message;
		} catch (error) {
			throw new InvalidMessageError("Received invalid JSON message", error);
		}

		this.validateMessage(parsed);

		if (parsed.type === "response") {
			await this.handleResponse(parsed);
			return;
		}

		if (parsed.type === "notification") {
			this.logger.info("Received notification", {
				id: parsed.id,
				meta: parsed.meta,
			});
			return;
		}

		this.logger.warn("Unhandled message type", {
			type: parsed.type,
			id: parsed.id,
		});
	}

	private async handleResponse(message: Message): Promise<void> {
		const pending = this.pending.get(message.id) as
			| PendingRequest<unknown>
			| undefined;
		if (!pending) {
			this.logger.warn("Received response for unknown request", {
				id: message.id,
			});
			return;
		}

		this.pending.delete(message.id);
		this.metrics.inflightCount = this.pending.size;

		const latency = Date.now() - pending.createdAt;
		this.recordLatency(latency);

		if (!message.meta) {
			message.meta = {};
		}
		message.meta.attempts = pending.attempts;
		message.latency = latency;

		// Apply response interceptor if configured
		let processedMessage = message;
		if (this.responseInterceptor) {
			try {
				processedMessage = await this.responseInterceptor(message);
			} catch (error) {
				this.logger.error("Response interceptor failed", {
					id: message.id,
					error: this.describeError(error),
				});
				pending.reject(error);
				return;
			}
		}

		if (processedMessage.error) {
			const rowstError = new RowstError(
				processedMessage.error.message,
				processedMessage.error.code,
				processedMessage.error.details,
			);
			rowstError.name = "RowstRemoteError";
			this.logger.warn("Request failed with remote error", {
				id: processedMessage.id,
				error: processedMessage.error,
			});
			pending.reject(rowstError);
			return;
		}

		this.logger.debug("Resolved request", { id: processedMessage.id, latency });
		pending.resolve(processedMessage);
	}

	private validateMessage(message: Message): void {
		if (typeof message !== "object" || message === null) {
			throw new InvalidMessageError("Message must be an object");
		}

		if (!message.id || typeof message.id !== "string") {
			throw new InvalidMessageError("Message is missing a string id");
		}

		if (!["request", "response", "notification"].includes(message.type)) {
			throw new InvalidMessageError("Unsupported message type");
		}
	}

	private rejectAllPending(error: RowstError): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timeoutHandle);
			pending.reject(error);
		}
		this.pending.clear();
		this.metrics.inflightCount = 0;
	}

	private shouldNotRetry(error: unknown): boolean {
		if (!(error instanceof RowstError)) return false;
		return (
			error.code === ErrorCode.INVALID_MESSAGE ||
			error.code === ErrorCode.BACKPRESSURE
		);
	}

	private calculateBackoffDelay(
		attempt: number,
		options?: RequestOptions,
	): number {
		const baseTimeout = options?.timeout ?? this.options.defaultTimeout;
		const multiplier = options?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
		const jitterFactor = options?.jitterFactor ?? DEFAULT_JITTER_FACTOR;

		let delay = baseTimeout * Math.pow(multiplier, attempt - 1);

		if (jitterFactor > 0) {
			const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
			delay += jitter;
		}

		return Math.max(0, delay);
	}

	private wait(duration: number): Promise<void> {
		if (duration <= 0) return Promise.resolve();
		return new Promise((resolve) => {
			setTimeout(resolve, duration);
		});
	}

	private recordLatency(latency: number): void {
		const samples = this.metrics.latencies;
		samples.push(latency);
		if (samples.length > this.options.latencySampleSize) {
			samples.splice(0, samples.length - this.options.latencySampleSize);
		}
	}

	private buildMeta(
		options: RequestOptions | undefined,
		attempt: number,
	): Record<string, unknown> {
		const meta = cloneOptions(options);
		meta.attempts = attempt;

		// Remove internal options that shouldn't be in meta
		delete (meta as { timeout?: unknown }).timeout;
		delete (meta as { retries?: unknown }).retries;
		delete (meta as { jitterFactor?: unknown }).jitterFactor;
		delete (meta as { backoffMultiplier?: unknown }).backoffMultiplier;

		if (options?.tags) {
			(meta as { tags?: string[] }).tags = [...options.tags];
		}

		// Merge custom meta if provided
		if (options?.meta) {
			Object.assign(meta, options.meta);
		}

		return meta;
	}

	private describeError(error: unknown): Record<string, unknown> {
		if (error instanceof RowstError) {
			return {
				name: error.name,
				code: error.code,
				message: error.message,
				details: error.details,
			};
		}

		if (error instanceof Error) {
			return {
				name: error.name,
				message: error.message,
				stack: error.stack,
			};
		}

		return { error };
	}
}
