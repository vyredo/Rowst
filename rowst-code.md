```src/core/AsyncResolver.ts
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

```

```src/core/errors.ts
import type { Message } from './types.js';

export class RowstError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = 'RowstError';
  }
}

export class TimeoutError extends RowstError {
  constructor(message = 'Request timed out', details?: unknown) {
    super(message, 'TIMEOUT', details);
    this.name = 'TimeoutError';
  }
}

export class TransportClosedError extends RowstError {
  constructor(message = 'Transport is closed', details?: unknown) {
    super(message, 'TRANSPORT_CLOSED', details);
    this.name = 'TransportClosedError';
  }
}

export class TransportError extends RowstError {
  constructor(message = 'Transport error', details?: unknown) {
    super(message, 'TRANSPORT_ERROR', details);
    this.name = 'TransportError';
  }
}

export class BackpressureError extends RowstError {
  constructor(message = 'Too many inflight requests', details?: unknown) {
    super(message, 'BACKPRESSURE', details);
    this.name = 'BackpressureError';
  }
}

export class InvalidMessageError extends RowstError {
  constructor(message = 'Invalid message received', details?: unknown) {
    super(message, 'INVALID_MESSAGE', details);
    this.name = 'InvalidMessageError';
  }
}

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
}

export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof RowstError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: 'UNKNOWN_ERROR',
      message: error.message,
      details: {
        name: error.name,
        stack: error.stack
      }
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: 'An unknown error occurred',
    details: error
  };
}

export function isErrorMessage(message: Message): boolean {
  return typeof message.error !== 'undefined';
}
```

```src/core/logger.ts
export enum LogLevel {
  SILENT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5
}

export interface LogTransport {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  transports: LogTransport[];
  prefix?: string;
}

export class Logger {
  constructor(private options: LoggerOptions) {}

  private shouldLog(level: LogLevel): boolean {
    return this.options.level >= level;
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const prefixedMessage = this.options.prefix
      ? `[${this.options.prefix}] ${message}`
      : message;

    for (const transport of this.options.transports) {
      try {
        transport.log(level, prefixedMessage, meta);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Logger transport failure', {
          level,
          message: prefixedMessage,
          meta,
          error
        });
      }
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit(LogLevel.ERROR, message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit(LogLevel.WARN, message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit(LogLevel.INFO, message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit(LogLevel.DEBUG, message, meta);
  }

  trace(message: string, meta?: Record<string, unknown>): void {
    this.emit(LogLevel.TRACE, message, meta);
  }

  setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  addTransport(transport: LogTransport): void {
    this.options.transports.push(transport);
  }

  removeTransport(transport: LogTransport): void {
    const index = this.options.transports.indexOf(transport);
    if (index > -1) {
      this.options.transports.splice(index, 1);
    }
  }
}

export class ConsoleTransport implements LogTransport {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const levelName = LogLevel[level];
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const formatted = `[${timestamp}] [${levelName}] ${message}${metaStr}`;

    switch (level) {
      case LogLevel.ERROR:
        console.error(formatted);
        break;
      case LogLevel.WARN:
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  }
}

export class NoopTransport implements LogTransport {
  log(): void {
    // Intentionally empty
  }
}
```

```src/core/types.ts
import type { Logger } from "./logger.js";

export type MessageType = "request" | "response" | "notification";

export interface Message<TPayload = unknown> {
	id: string;
	type: MessageType;
	payload: TPayload;
	timestamp?: string;
	meta?: {
		attempts?: number;
		tags?: string[];
		[key: string]: unknown;
	};
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
	latency?: number;
}

export enum ErrorCode {
	TIMEOUT = "TIMEOUT",
	TRANSPORT_CLOSED = "TRANSPORT_CLOSED",
	TRANSPORT_ERROR = "TRANSPORT_ERROR",
	BACKPRESSURE = "BACKPRESSURE",
	INVALID_MESSAGE = "INVALID_MESSAGE",
	SEND_FAILED = "SEND_FAILED",
}

export interface CorrelatorOptions {
	/**
	 * Default request timeout in milliseconds
	 */
	defaultTimeout?: number;
	/**
	 * Maximum number of concurrent inflight requests
	 */
	maxInflight?: number;
	/**
	 * Custom logger
	 */
	logger?: Logger;
	/**
	 * Response interceptor to validate/transform responses before resolving
	 */
	responseInterceptor?: <T>(
		message: Message<T>,
	) => Message<T> | Promise<Message<T>>;
	/**
	 * Request deduplication strategy. If true, uses JSON.stringify(payload) as the key.
	 * Or provide a function that returns a cache key string for the given payload.
	 */
	deduplicateRequests?: boolean | ((payload: unknown) => string);
}

export interface RequestOptions {
	timeout?: number;
	retries?: number;
	tags?: string[];
	jitterFactor?: number;
	backoffMultiplier?: number;
	/**
	 * Custom metadata to attach to the request envelope
	 */
	meta?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface Metrics {
	inflightCount: number;
	totalRequests: number;
	totalResponses: number;
	totalTimeouts: number;
	totalErrors: number;
	latencies: number[];
}

export interface LatencyStats {
	min: number;
	max: number;
	mean: number;
	median: number;
	p50: number;
	p95: number;
	p99: number;
}

```

```src/core/uuid.ts
/**
 * Generates RFC4122-compliant v4 UUIDs using cryptographically secure random numbers
 * Zero dependencies - works in Node.js and browser environments
 */

 // Detect environment and get crypto
const getCrypto = (() => {
	let cached: Crypto | null = null;

	return (): Crypto => {
		if (cached) return cached;

		if (typeof globalThis !== "undefined") {
			const candidate = (globalThis as typeof globalThis & { crypto?: Crypto; webcrypto?: Crypto }).crypto ??
				(globalThis as typeof globalThis & { crypto?: Crypto; webcrypto?: Crypto }).webcrypto;

			if (candidate && typeof candidate.getRandomValues === "function") {
				cached = candidate;
				return cached;
			}
		}

		throw new Error("No crypto implementation available");
	};
})();

export function generateUUID(): string {
	const bytes = new Uint8Array(16);
	getCrypto().getRandomValues(bytes);

	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return [
		hex.substring(0, 8),
		hex.substring(8, 12),
		hex.substring(12, 16),
		hex.substring(16, 20),
		hex.substring(20, 32),
	].join("-");
}

export function isValidUUID(uuid: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		uuid,
	);
}

```

```src/core/WorkerPoolResolver.ts
// src/core/WorkerPoolResolver.ts
import { AsyncResolver } from './AsyncResolver.js';
import type { Transport } from '../transports/Transport.js';
import type { Message, RequestOptions, CorrelatorOptions } from './types.js';
import { WorkerPool, type WorkerPoolOptions } from '../workers/WorkerPool.js';
import { Logger, LogLevel, NoopTransport } from './logger.js';

export interface WorkerPoolResolverOptions extends CorrelatorOptions, WorkerPoolOptions {
  useWorkersWhen?: (payload: unknown) => boolean;
  serializeInWorker?: boolean;
  deserializeInWorker?: boolean;
  validateInWorker?: boolean;
}

/**
 * WorkerPoolResolver extends AsyncResolver and opportunistically offloads
 * CPU-heavy operations (e.g., JSON stringify/parse, validation, transforms)
 * to a pool of worker threads based on a selection strategy.
 *
 * Note:
 * - For compatibility with the existing AsyncResolver, message I/O (transport.send / receive)
 *   remains on the main thread.
 * - We avoid changing AsyncResolver internals; therefore, we do not replace its JSON
 *   serialization of the whole message. Instead, we may do prework (e.g., validation) and
 *   postwork (e.g., parsing string payloads) in workers when beneficial.
 */
export class WorkerPoolResolver extends AsyncResolver {
  private readonly workerPool: WorkerPool;
  private readonly useWorkersWhen: (payload: unknown) => boolean;
  private readonly serializeInWorker: boolean;
  private readonly deserializeInWorker: boolean;
  private readonly validateInWorker: boolean;
  private readonly internalLogger: Logger;

  constructor(transport: Transport, options: WorkerPoolResolverOptions = {}) {
    super(transport, options);

    this.internalLogger =
      options.logger ??
      new Logger({
        level: LogLevel.INFO,
        transports: [new NoopTransport()],
        prefix: 'WorkerPoolResolver'
      });

    this.workerPool = new WorkerPool({
      workerCount: options.workerCount,
      workerScript: options.workerScript,
      taskTimeout: options.taskTimeout,
      logger: this.internalLogger
    });

    this.useWorkersWhen = options.useWorkersWhen ?? this.defaultWorkerStrategy;
    this.serializeInWorker = options.serializeInWorker ?? true;
    this.deserializeInWorker = options.deserializeInWorker ?? true;
    this.validateInWorker = options.validateInWorker ?? false;

    this.internalLogger.info('WorkerPoolResolver initialized', {
      serializeInWorker: this.serializeInWorker,
      deserializeInWorker: this.deserializeInWorker,
      validateInWorker: this.validateInWorker
    });
  }

  private defaultWorkerStrategy(payload: unknown): boolean {
    // Use workers for payloads larger than 30KB (estimated)
    try {
      const serialized = JSON.stringify(payload);
      return serialized.length > 30_000;
    } catch {
      return false;
    }
  }

  private estimatePayloadSize(payload: unknown): number {
    try {
      return JSON.stringify(payload).length;
    } catch {
      return 0;
    }
  }

  /**
   * Executes a request; if the worker strategy is enabled for the given payload,
   * perform CPU-heavy steps in the worker pool before/after delegating to AsyncResolver.
   *
   * Important:
   * - We DO NOT mutate the payload shape sent over the wire to preserve protocol compatibility.
   * - We may run "serialize" (JSON.stringify) in workers as a "pre-flight" warmup/measurement
   *   step to parallelize CPU work across concurrent requests while the main thread handles I/O.
   */
  async request<TResponse = unknown, TRequest = unknown>(
    payload: TRequest,
    options: RequestOptions = {}
  ): Promise<Message<TResponse>> {
    const shouldUseWorkers = this.useWorkersWhen(payload);
    if (!shouldUseWorkers) {
      this.internalLogger.debug('Using single-threaded AsyncResolver path', {
        reason: 'payload under threshold'
      });
      return super.request<TResponse, TRequest>(payload, options);
    }

    this.internalLogger.debug('Using worker pool path', {
      payloadSize: this.estimatePayloadSize(payload)
    });

    // Step 1: Optional pre-validation in worker
    if (this.validateInWorker) {
      try {
        // Validate the original payload structure (not altering it)
        await this.workerPool.execute('validate', payload, {
          schema: (options as Record<string, unknown>)?.schema
        });
        this.internalLogger.trace('Payload validated in worker');
      } catch (error) {
        this.internalLogger.error('Worker validation failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }

    // Step 2: Optional serialization warmup in worker
    // We do not replace the payload; we just perform the expensive stringify
    // in parallel to amortize CPU across threads. This also provides realistic
    // worker task load for metrics.
    if (this.serializeInWorker) {
      try {
        await this.workerPool.execute('serialize', payload);
        this.internalLogger.trace('Payload serialization warmup in worker');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // If the worker task timed out, escalate so callers can react (e.g., tests).
        if (/timeout/i.test(msg)) {
          this.internalLogger.error('Worker serialization timed out', { error: msg });
          throw error;
        }
        // Otherwise, continue with single-threaded path
        this.internalLogger.warn('Worker serialization failed, continuing on main thread', {
          error: msg
        });
      }
    }

    // Step 3: Perform the actual network request via AsyncResolver (main thread I/O)
    const response = await super.request<TResponse, TRequest>(payload, options);

    // Step 4: Optional post-deserialization in worker (only if response payload is a string)
    if (this.deserializeInWorker && typeof response.payload === 'string') {
      try {
        const parsed = await this.workerPool.execute('deserialize', response.payload);
        const next: Message<TResponse> = {
          ...response,
          payload: parsed as TResponse
        };
        this.internalLogger.trace('Response payload deserialized in worker');
        return next;
      } catch (error) {
        // If deserialization fails in worker, return original response
        this.internalLogger.warn('Worker deserialization failed, returning original payload', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return response;
  }

  getWorkerPoolStats() {
    return this.workerPool.getStats();
  }

  // Keep signature compatible with base class (void). Tests can still `await` this safely.
  destroy(): void {
    // Fire-and-forget; terminates workers in the background
    void this.workerPool.destroy();
    super.destroy();
  }
}
```

```src/http/adapters/ExpressAdapter.ts
import type { RowstRouter } from "../RowstRouter.js";
import type { HttpRequest } from "../types.js";

/**
 * Adapter for Express framework.
 * Note: This file does NOT import Express directly.
 * Users must have Express installed as a peer dependency.
 */
type ExpressApp = any;
type ExpressRequest = any;
type ExpressResponse = any;

export class ExpressAdapter {
	constructor(private readonly router: RowstRouter) {}

	/** Register the router to an Express app. */
	register(app: ExpressApp, pattern: string = "/*"): void {
		if (!app || typeof app.all !== "function") {
			throw new Error(
				"ExpressAdapter.register expects an Express app instance with an .all() method",
			);
		}

		app.all(pattern, async (req: ExpressRequest, res: ExpressResponse) => {
			try {
				const request = this.toHttpRequest(req);
				const response = await this.router.handle(request);
				this.toExpressResponse(response, res);
			} catch (error) {
				res.status(500).json({
					error: "Internal server error",
					message: error instanceof Error ? error.message : "Unknown error",
				});
			}
		});
	}

	/** Convert Express request to normalized HttpRequest. */
	private toHttpRequest(req: ExpressRequest): HttpRequest {
		const rawUrl: string = req.originalUrl || req.url || "";
		const qIndex = rawUrl.indexOf("?");
		const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
		const query = qIndex >= 0 ? rawUrl.slice(qIndex) : "";

		// Normalize headers to Record<string, string>
		const headers: Record<string, string> = {};
		const srcHeaders = req.headers as Record<
			string,
			string | string[] | undefined
		>;
		for (const [k, v] of Object.entries(srcHeaders)) {
			if (typeof v === "string") headers[k] = v;
			else if (Array.isArray(v)) headers[k] = v.join(", ");
		}

		return {
			method: req.method,
			path,
			query,
			headers,
			body: req.body,
		};
	}

	/** Send HttpResponse via Express response object. */
	private toExpressResponse(
		response: { status: number; headers: Record<string, string>; body: string },
		res: ExpressResponse,
	): void {
		for (const [key, value] of Object.entries(response.headers)) {
			if (typeof value === "string") {
				res.setHeader(key, value);
			}
		}
		res.status(response.status).send(response.body);
	}
}

```

```src/http/adapters/FastifyAdapter.ts
import type { RowstRouter } from "../RowstRouter.js";
import type { HttpRequest } from "../types.js";

/**
 * Adapter for Fastify framework.
 * Note: This file does NOT import Fastify directly.
 * Users must have Fastify installed as a peer dependency.
 */
type FastifyInstance = any;
type FastifyRequest = any;
type FastifyReply = any;

export class FastifyAdapter {
	constructor(private readonly router: RowstRouter) {}

	/** Register the router to a Fastify instance. */
	async register(fastify: FastifyInstance): Promise<void> {
		if (!fastify || typeof fastify.all !== "function") {
			throw new Error(
				"FastifyAdapter.register expects a Fastify instance with an .all() method",
			);
		}

		fastify.all("/*", async (request: FastifyRequest, reply: FastifyReply) => {
			try {
				const httpRequest = await this.toHttpRequest(request);
				const response = await this.router.handle(httpRequest);
				await this.toFastifyResponse(response, reply);
			} catch (error) {
				reply.status(500).send({
					error: "Internal server error",
					message: error instanceof Error ? error.message : "Unknown error",
				});
			}
		});
	}

	/** Convert Fastify request to normalized HttpRequest. */
	private async toHttpRequest(req: FastifyRequest): Promise<HttpRequest> {
		const rawUrl: string = req.url || "";
		const qIndex = rawUrl.indexOf("?");
		const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
		const query = qIndex >= 0 ? rawUrl.slice(qIndex) : "";

		// Normalize headers to Record<string, string>
		const headers: Record<string, string> = {};
		const srcHeaders = req.headers as Record<
			string,
			string | string[] | undefined
		>;
		for (const [k, v] of Object.entries(srcHeaders)) {
			if (typeof v === "string") headers[k] = v;
			else if (Array.isArray(v)) headers[k] = v.join(", ");
		}

		// Fastify parses body when content-type is JSON and body parser is enabled
		const body = (req as any).body;

		return {
			method: req.method,
			path,
			query,
			headers,
			body,
		};
	}

	/** Send HttpResponse via Fastify reply object. */
	private async toFastifyResponse(
		response: { status: number; headers: Record<string, string>; body: string },
		reply: FastifyReply,
	): Promise<void> {
		for (const [key, value] of Object.entries(response.headers)) {
			if (typeof value === "string") {
				reply.header(key, value);
			}
		}
		reply.status(response.status).send(response.body);
	}
}

```

```src/http/adapters/HonoAdapter.ts
import type { RowstRouter } from "../RowstRouter.js";
import type { HttpRequest } from "../types.js";

/**
 * Adapter for Hono framework.
 * Note: This file does NOT import Hono directly to avoid adding it as a dependency.
 * Users must have Hono installed as a peer dependency.
 */
type HonoApp = any;
type HonoContext = any;

export class HonoAdapter {
	constructor(private readonly router: RowstRouter) {}

	/** Register the router to a Hono app. Creates a catch-all route handler. */
	register(app: HonoApp, pattern: string = "/*"): void {
		if (!app || typeof app.all !== "function") {
			throw new Error(
				"HonoAdapter.register expects a Hono app instance with an .all() method",
			);
		}
		app.all(pattern, async (c: HonoContext) => {
			const request = await this.toHttpRequest(c);
			const response = await this.router.handle(request);
			return this.toHonoResponse(response);
		});
	}

	/** Convert Hono context to normalized HttpRequest. */
	private async toHttpRequest(c: HonoContext): Promise<HttpRequest> {
		const url = new URL(c.req.url);

		// Headers
		const headers: Record<string, string> = {};
		const rawHeaders = c?.req?.raw?.headers ?? c?.req?.headers;
		if (rawHeaders) {
			try {
				if (typeof rawHeaders.forEach === "function") {
					rawHeaders.forEach((value: string, key: string) => {
						headers[key] = value;
					});
				} else if (typeof (rawHeaders as any)[Symbol.iterator] === "function") {
					for (const [key, value] of rawHeaders as any) {
						headers[String(key)] = String(value);
					}
				}
			} catch {
				// ignore header extraction errors
			}
		}

		// Body
		let body: unknown;
		try {
			const contentType: string =
				(typeof c.req.header === "function"
					? c.req.header("content-type")
					: undefined) ??
				c?.req?.raw?.headers?.get?.("content-type") ??
				"";

			if (contentType.includes("application/json")) {
				body = await c.req.json();
			} else {
				const text = await c.req.text();
				if (text && text.length > 0) {
					try {
						body = JSON.parse(text);
					} catch {
						body = text;
					}
				}
			}
		} catch {
			// leave body undefined on parsing error
		}

		return {
			method: c.req.method,
			path: url.pathname,
			query: url.search,
			headers,
			body,
		};
	}

	/** Convert HttpResponse to Hono Response. */
	private toHonoResponse(response: {
		status: number;
		headers: Record<string, string>;
		body: string;
	}): Response {
		const headers = new Headers();
		for (const [key, value] of Object.entries(response.headers)) {
			if (typeof value === "string") {
				headers.set(key, value);
			}
		}
		return new Response(response.body, { status: response.status, headers });
	}
}

```

```src/http/index.ts
/**
 * Rowst HTTP-to-WebSocket Router Module
 *
 * Provides Express-style routing for bridging HTTP REST APIs to WebSocket backends.
 *
 * Example:
 *   import { AsyncResolver, WebSocketTransport } from 'rowst'
 *   import { RowstRouter, HonoAdapter } from 'rowst/http'
 *
 *   const ws = new WebSocket('ws://backend.example.com')
 *   const resolver = new AsyncResolver(new WebSocketTransport(ws))
 *   const router = new RowstRouter(resolver)
 *
 *   router.get('/users/:id', 'fetchUser')
 *   router.post('/posts', 'createPost')
 *
 *   const adapter = new HonoAdapter(router)
 *   adapter.register(app)
 */

export { ExpressAdapter } from "./adapters/ExpressAdapter.js";
export { FastifyAdapter } from "./adapters/FastifyAdapter.js";
// Framework adapters
export { HonoAdapter } from "./adapters/HonoAdapter.js";
export { ResponseParser } from "./ResponseParser.js";
export { RouteCompiler } from "./RouteCompiler.js";
// Core
export { RowstRouter } from "./RowstRouter.js";

// Types
export type {
	CompiledRoute,
	HttpMethod,
	HttpRequest,
	HttpResponse,
	RouteConfig,
	RouteMatch,
	RowstRouterOptions,
	UpstreamRequestPayload,
	UpstreamResponse,
} from "./types.js";

```

```src/http/ResponseParser.ts
import type { Message } from "../core/types.js";
import type { HttpResponse, UpstreamResponse } from "./types.js";

/**
 * Parses Rowst Message responses from upstream into HTTP responses.
 */
export class ResponseParser {
	/**
	 * Parse a Rowst message payload into an HTTP response.
	 * Handles multiple payload formats for flexibility.
	 */
	static parse(message: Message<unknown>): HttpResponse {
		const payload = message.payload as UpstreamResponse | undefined;

		if (!payload || typeof payload !== "object") {
			// Empty or invalid payload: return 200 with empty body
			return {
				status: 200,
				headers: { "content-type": "text/plain" },
				body: "",
			};
		}

		// Extract status (default: 200)
		const status = this.extractStatus(payload);

		// Extract headers (default: content-type text/plain)
		const headers = this.extractHeaders(payload);

		// Extract body
		const body = this.extractBody(payload, headers);

		return { status, headers, body };
	}

	private static extractStatus(payload: UpstreamResponse): number {
		if (typeof payload.status === "number") {
			return payload.status;
		}
		return 200;
	}

	private static extractHeaders(
		payload: UpstreamResponse,
	): Record<string, string> {
		const headers: Record<string, string> = {};

		if (payload.headers && typeof payload.headers === "object") {
			for (const [key, value] of Object.entries(payload.headers)) {
				if (typeof value === "string") {
					headers[key.toLowerCase()] = value;
				}
			}
		}

		// Set default content-type if not provided
		if (!headers["content-type"]) {
			headers["content-type"] = "text/plain";
		}

		return headers;
	}

	private static extractBody(
		payload: UpstreamResponse,
		headers: Record<string, string>,
	): string {
		// Priority 1: bodyText (raw string)
		if (typeof payload.bodyText === "string") {
			return payload.bodyText;
		}

		// Priority 2: body (structured data - stringify if needed)
		if (typeof payload.body !== "undefined") {
			if (typeof payload.body === "string") {
				return payload.body;
			}
			// Stringify and set content-type to JSON if not already set
			if (
				!headers["content-type"] ||
				headers["content-type"] === "text/plain"
			) {
				headers["content-type"] = "application/json";
			}
			try {
				return JSON.stringify(payload.body);
			} catch {
				return String(payload.body);
			}
		}

		// No body provided
		return "";
	}

	/** Create an error response. */
	static error(
		status: number,
		message: string,
		details?: unknown,
	): HttpResponse {
		const body = JSON.stringify({
			error: message,
			...(details ? { details } : {}),
		});
		return {
			status,
			headers: { "content-type": "application/json" },
			body,
		};
	}
}

```

```src/http/RouteCompiler.ts
import type { CompiledRoute, RouteConfig } from "./types.js";

/**
 * Compiles Express-style path patterns into regex for matching:
 *  - Named params: /users/:id
 *  - Multiple params: /posts/:postId/comments/:commentId
 *  - Wildcards: /files/*
 *  - Optional segments: /posts/:id? (slash+segment optional)
 */
export class RouteCompiler {
	/** Compile a route config into a CompiledRoute with regex and param extraction. */
	static compile(config: RouteConfig): CompiledRoute {
		const { pathRegex, paramNames } = RouteCompiler.compilePath(config.path);
		return { ...config, pathRegex, paramNames };
	}

	/** Convert Express-style path pattern to regex. */
	private static compilePath(pattern: string): {
		pathRegex: RegExp;
		paramNames: string[];
	} {
		const paramNames: string[] = [];
		const segments = pattern.split("/");

		let regex = "";

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];

			// Wildcard segment
			if (seg === "*") {
				// include preceding slash for non-first segments
				regex += (i === 0 ? "" : "\\/") + ".*";
				continue;
			}

			// Parameter segment
			if (seg.startsWith(":")) {
				const { cleaned, optional } = parseParam(seg);
				paramNames.push(cleaned);
				if (optional) {
					// include slash inside optional group so '/:id?' makes the entire '/id' optional
					regex += "(?:\\/([^/]+))?";
				} else {
					regex += "\\/([^/]+)";
				}
				continue;
			}

			// Static segment (may be empty for leading/trailing '/')
			if (seg.length > 0) {
				regex += (i === 0 ? "" : "\\/") + escapeSegment(seg);
			} else if (i > 0) {
				// preserve explicit trailing slash
				regex += "\\/";
			}
		}

		const pathRegex = new RegExp("^" + regex + "$");
		return { pathRegex, paramNames };
	}

	/** Extract parameter values from a path using compiled route. */
	static extractParams(
		path: string,
		compiledRoute: CompiledRoute,
	): Record<string, string> | null {
		const match = compiledRoute.pathRegex.exec(path);
		if (!match) return null;
		const params: Record<string, string> = {};
		compiledRoute.paramNames.forEach((name, index) => {
			const value = match[index + 1];
			if (typeof value !== "undefined") {
				params[name] = safeDecode(value);
			}
		});
		return params;
	}
}

function parseParam(segment: string): { cleaned: string; optional: boolean } {
	let name = segment.slice(1);
	let optional = false;
	if (name.endsWith("?")) {
		name = name.slice(0, -1);
		optional = true;
	}
	return { cleaned: name, optional };
}

function escapeSegment(segment: string): string {
	return segment.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

```

```src/http/RowstRouter.ts
import type { AsyncResolver } from "../core/AsyncResolver.js";
import { TimeoutError, TransportClosedError } from "../core/errors.js";
import { ResponseParser } from "./ResponseParser.js";
import { RouteCompiler } from "./RouteCompiler.js";
import type {
	CompiledRoute,
	HttpRequest,
	HttpResponse,
	RouteConfig,
	RouteMatch,
	RowstRouterOptions,
	UpstreamRequestPayload,
} from "./types.js";

const DEFAULT_TIMEOUT = 15_000;

/**
 * Framework-agnostic HTTP-to-WebSocket router.
 * Matches HTTP requests to routes and forwards them to upstream WebSocket handlers.
 */
export class RowstRouter {
	private readonly routes: CompiledRoute[] = [];
	private readonly options: Required<
		Pick<RowstRouterOptions, "defaultTimeout" | "prefix">
	>;
	private readonly beforeRequest?: RowstRouterOptions["beforeRequest"];
	private readonly afterResponse?: RowstRouterOptions["afterResponse"];
	private readonly onError?: RowstRouterOptions["onError"];

	constructor(
		private readonly resolver: AsyncResolver,
		options: RowstRouterOptions = {},
	) {
		this.options = {
			defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
			prefix: options.prefix ?? "",
		};
		this.beforeRequest = options.beforeRequest;
		this.afterResponse = options.afterResponse;
		this.onError = options.onError;
	}

	/** Register a route. */
	register(config: RouteConfig): void {
		const fullPath = this.options.prefix + config.path;
		const compiled = RouteCompiler.compile({ ...config, path: fullPath });
		this.routes.push(compiled);
	}

	/** Register a GET route. */
	get(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "GET", ...options });
	}

	/** Register a POST route. */
	post(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "POST", ...options });
	}

	/** Register a PUT route. */
	put(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "PUT", ...options });
	}

	/** Register a DELETE route. */
	delete(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "DELETE", ...options });
	}

	/** Register a PATCH route. */
	patch(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "PATCH", ...options });
	}

	/** Register a route that matches all HTTP methods. */
	all(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "ALL", ...options });
	}

	/**
	 * Handle an incoming HTTP request.
	 * Matches against registered routes and forwards to upstream WebSocket.
	 */
	async handle(request: HttpRequest): Promise<HttpResponse> {
		try {
			const match = this.match(request.method, request.path);

			if (this.beforeRequest) {
				await this.beforeRequest(request, match);
			}

			const payload: UpstreamRequestPayload = {
				method: request.method,
				path: request.path,
				query: request.query,
				headers: request.headers,
				body: request.body,
			};

			if (match) {
				payload.params = match.params;
				payload.event = match.route.event;
			}

			const timeout = match?.route.timeout ?? this.options.defaultTimeout;

			const requestOptions: any = { timeout };
			if (match?.route.meta) {
				requestOptions.meta = { ...match.route.meta, event: match.route.event };
			} else if (match) {
				requestOptions.meta = { event: match.route.event };
			}

			const message = await (this.resolver as any).request(
				payload,
				requestOptions,
			);

			let response = ResponseParser.parse(message);

			if (this.afterResponse) {
				await this.afterResponse(response, request);
			}

			return response;
		} catch (error) {
			return this.handleError(error, request);
		}
	}

	/** Match an HTTP request to a registered route. */
	private match(method: string, path: string): RouteMatch | null {
		for (const route of this.routes) {
			const routeMethod = route.method ?? "ALL";
			const methodMatches =
				routeMethod === "ALL" ||
				routeMethod.toUpperCase() === method.toUpperCase();
			if (!methodMatches) continue;

			const params = RouteCompiler.extractParams(path, route);
			if (params !== null) {
				return { route, params };
			}
		}
		return null;
	}

	/** Handle errors during request processing. */
	private handleError(error: unknown, _request: HttpRequest): HttpResponse {
		if (this.onError) {
			try {
				return this.onError(error, _request);
			} catch (handlerError) {
				return ResponseParser.error(500, "Internal server error", {
					original: describeUnknownError(error),
					handlerError: describeUnknownError(handlerError),
				});
			}
		}

		if (error instanceof TimeoutError) {
			return ResponseParser.error(504, "Gateway timeout", {
				message: error.message,
			});
		}
		if (error instanceof TransportClosedError) {
			return ResponseParser.error(503, "Service unavailable", {
				message: "Upstream connection closed",
			});
		}
		if (error instanceof Error) {
			return ResponseParser.error(502, "Bad gateway", {
				message: error.message,
			});
		}
		return ResponseParser.error(500, "Internal server error");
	}

	/** Get all registered routes (for debugging/introspection). */
	getRoutes(): Array<{ method: string; path: string; event: string }> {
		return this.routes.map((r) => ({
			method: r.method ?? "ALL",
			path: r.path,
			event: r.event,
		}));
	}
}

function describeUnknownError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack };
	}
	return { error };
}

```

```src/http/types.ts
// Rowst HTTP module types

// HTTP methods supported by the router.
export type HttpMethod =
	| "GET"
	| "POST"
	| "PUT"
	| "DELETE"
	| "PATCH"
	| "HEAD"
	| "OPTIONS"
	| "ALL";

// Route configuration for registering HTTP→WS mappings.
export interface RouteConfig {
	// Express-style path pattern with parameters.
	// Examples: "/users/:id", "/posts/:postId/comments/:commentId"
	path: string;
	// WebSocket event name to send to upstream handler.
	// This will be included in the request payload as `meta.event`.
	event: string;
	// HTTP method(s) to match. Use 'ALL' to match any method.
	// @default 'ALL'
	method?: HttpMethod;
	// Request timeout in milliseconds. Overrides AsyncResolver's default timeout for this route.
	timeout?: number;
	// Custom metadata to attach to requests for this route.
	meta?: Record<string, unknown>;
}

// Normalized HTTP request representation (framework-agnostic).
export interface HttpRequest {
	method: string;
	path: string;
	query: string; // Raw query string including "?" if present
	headers: Record<string, string>;
	body?: unknown; // Parsed body (JSON object, string, or undefined)
}

// Normalized HTTP response representation.
export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: string; // Response body as string
}

// Upstream WebSocket response payload format.
// This is what upstream handlers should send back.
export interface UpstreamResponse {
	status?: number; // HTTP status code (default: 200)
	headers?: Record<string, string>; // Response headers
	bodyText?: string; // Response body as text
	body?: unknown; // Alternative: structured body (will be JSON.stringify'd)
}

// Compiled route with regex and parameter extraction info.
export interface CompiledRoute extends RouteConfig {
	pathRegex: RegExp;
	paramNames: string[];
}

// Result of matching a request to a route.
export interface RouteMatch {
	route: CompiledRoute;
	params: Record<string, string>; // Extracted path parameters
}

// Options for RowstRouter.
export interface RowstRouterOptions {
	// Default timeout for all routes (can be overridden per route).
	// @default 15000
	defaultTimeout?: number;
	// Prefix to add to all registered routes.
	// Example: "/api" → routes become "/api/users/:id"
	prefix?: string;
	// Custom error handler for when routes throw errors.
	onError?: (error: unknown, request: HttpRequest) => HttpResponse;
	// Hook called before forwarding request to WebSocket. Can modify the request or throw to abort.
	beforeRequest?: (
		request: HttpRequest,
		match: RouteMatch | null,
	) => void | Promise<void>;
	// Hook called after receiving response from WebSocket. Can modify the response before returning to client.
	afterResponse?: (
		response: HttpResponse,
		request: HttpRequest,
	) => void | Promise<void>;
}

// Request payload sent to upstream WebSocket handler.
export interface UpstreamRequestPayload {
	method: string;
	path: string;
	query: string;
	headers: Record<string, string>;
	body?: unknown;
	params?: Record<string, string>; // Extracted path parameters (if route matched)
	event?: string; // WebSocket event name (if route matched)
}

```

```src/index.ts
export {
	AsyncResolver,
	type AsyncResolverOptions,
} from "./core/AsyncResolver.js";
export {
	BackpressureError,
	type ErrorResponse,
	InvalidMessageError,
	isErrorMessage,
	RowstError,
	TimeoutError,
	TransportClosedError,
	TransportError,
	toErrorResponse,
} from "./core/errors.js";
export {
	ConsoleTransport,
	Logger,
	type LoggerOptions,
	LogLevel,
	type LogTransport,
	NoopTransport,
} from "./core/logger.js";
export {
	type CorrelatorOptions,
	ErrorCode,
	type LatencyStats,
	type Message,
	type MessageType,
	type Metrics,
	type RequestOptions,
} from "./core/types.js";
export { generateUUID, isValidUUID } from "./core/uuid.js";
export { WorkerPoolResolver } from "./core/WorkerPoolResolver.js";
export { RowstMCPServer } from "./mcp/RowstMCPServer.js";
export type {
	Transport,
	TransportEvents,
	TransportState,
} from "./transports/Transport.js";
export { isTransportClosed, isTransportReady } from "./transports/Transport.js";
export { WebRTCTransport } from "./transports/WebRTCTransport.js";
export { WebSocketTransport } from "./transports/WebSocketTransport.js";
export { WorkerPool } from "./workers/WorkerPool.js";

```

```src/mcp/index.ts
export { RowstMCPServer, type MCPRequestParams } from './RowstMCPServer.js';
```

```src/mcp/RowstMCPServer.ts
import { AsyncResolver } from '../core/AsyncResolver.js';
import type { Message } from '../core/types.js';
import type { Transport } from '../transports/Transport.js';

export interface MCPRequestParams {
  transportId: string;
  payload: unknown;
  options?: Record<string, unknown>;
}

export class RowstMCPServer {
  private readonly resolvers = new Map<string, AsyncResolver>();

  registerTransport(id: string, transport: Transport, options?: Record<string, unknown>): void {
    if (this.resolvers.has(id)) {
      throw new Error(`Transport ${id} already registered`);
    }
    const resolver = new AsyncResolver(transport, options);
    this.resolvers.set(id, resolver);
  }

  unregisterTransport(id: string): void {
    const resolver = this.resolvers.get(id);
    if (!resolver) {
      return;
    }
    resolver.destroy();
    this.resolvers.delete(id);
  }

  async handleRequest(params: MCPRequestParams): Promise<Message> {
    const resolver = this.resolvers.get(params.transportId);
    if (!resolver) {
      throw new Error(`Transport ${params.transportId} not found`);
    }

    return await resolver.request(params.payload, params.options);
  }

  getMetrics(transportId: string): ReturnType<AsyncResolver['getMetrics']> {
    const resolver = this.resolvers.get(transportId);
    if (!resolver) {
      throw new Error(`Transport ${transportId} not found`);
    }

    return resolver.getMetrics();
  }

  getMCPConfig(): Record<string, unknown> {
    return {
      name: 'rowst',
      version: '0.1.0',
      tools: [
        {
          name: 'rowst.request',
          description: 'Send a request over a Rowst transport',
          inputSchema: {
            type: 'object',
            properties: {
              transportId: { type: 'string' },
              payload: { type: 'object' },
              options: { type: 'object' }
            },
            required: ['transportId', 'payload']
          }
        },
        {
          name: 'rowst.metrics',
          description: 'Get metrics for a Rowst transport',
          inputSchema: {
            type: 'object',
            properties: {
              transportId: { type: 'string' }
            },
            required: ['transportId']
          }
        }
      ]
    };
  }
}
```

```src/transports/index.ts
export type {
	Transport,
	TransportEvents,
	TransportState,
} from "./Transport.js";
export { isTransportReady, isTransportClosed } from "./Transport.js";
export { WebRTCTransport } from "./WebRTCTransport.js";
export { WebSocketTransport } from "./WebSocketTransport.js";

```

```src/transports/Transport.ts
export type TransportState = "connecting" | "open" | "closing" | "closed";

export interface TransportEvents {
	message: (data: string | ArrayBuffer | Uint8Array) => void;
	open: () => void;
	close: (event?: unknown) => void;
	error: (error: Error | unknown) => void;
}

export interface Transport {
	readonly readyState: TransportState;
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(): void;

	on<K extends keyof TransportEvents>(
		event: K,
		handler: TransportEvents[K],
	): void;
	off<K extends keyof TransportEvents>(
		event: K,
		handler: TransportEvents[K],
	): void;

	/**
	 * Optional one-time listener registration
	 */
	once?<K extends keyof TransportEvents>(
		event: K,
		handler: TransportEvents[K],
	): void;
}

/**
 * Type guard for transport 'open' state
 */
export function isTransportReady(transport: Transport): boolean {
	return transport.readyState === "open";
}

/**
 * Type guard for transport 'closed' or 'closing' state
 */
export function isTransportClosed(transport: Transport): boolean {
	return (
		transport.readyState === "closed" || transport.readyState === "closing"
	);
}

```

```src/transports/WebRTCTransport.ts
import type { Transport, TransportEvents, TransportState } from './Transport.js';
import type { Logger } from '../core/logger.js';
import { Logger as InternalLogger, LogLevel, ConsoleTransport } from '../core/logger.js';

type InboundData = string | ArrayBuffer | Uint8Array;

export interface WebRTCTransportOptions {
  logger?: Logger;
  logLevel?: LogLevel;
  ordered?: boolean;
  maxRetransmits?: number;
  negotiated?: boolean;
  id?: number;
  protocol?: string;
}

const createDefaultLogger = (level: LogLevel = LogLevel.ERROR): Logger =>
  new InternalLogger({
    level,
    transports: [new ConsoleTransport()],
    prefix: 'WebRTCTransport'
  });

function cloneToArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = view.buffer;
  const start = view.byteOffset;
  const end = start + view.byteLength;

  if (typeof (buffer as ArrayBuffer).slice === 'function') {
    return (buffer as ArrayBuffer).slice(start, end);
  }

  const result = new ArrayBuffer(view.byteLength);
  new Uint8Array(result).set(new Uint8Array(buffer, start, view.byteLength));
  return result;
}

export class WebRTCTransport implements Transport {
  private readonly channel: RTCDataChannel;
  private readonly logger: Logger;
  private readonly listeners: { [K in keyof TransportEvents]: Set<TransportEvents[K]> } = {
    message: new Set(),
    open: new Set(),
    close: new Set(),
    error: new Set()
  };

  private readonly messageListener = (event: MessageEvent): void => {
    this.dispatchMessage(event.data);
  };

  private readonly openListener = (): void => {
    this.dispatch('open');
  };

  private readonly closeListener = (): void => {
    this.dispatch('close');
  };

  private readonly errorListener = (event: Event): void => {
    const rtcError = (event as RTCErrorEvent).error;
    const error = rtcError instanceof Error ? rtcError : new Error('RTCDataChannel error event');
    this.dispatch('error', error);
  };

  constructor(channel: RTCDataChannel, options: WebRTCTransportOptions = {}) {
    if (!channel) {
      throw new Error('RTCDataChannel instance is required');
    }

    this.channel = channel;
    this.logger = options.logger ?? createDefaultLogger(options.logLevel);

    this.bindChannelEvents();
  }

  static create(peer: RTCPeerConnection, label: string, options?: WebRTCTransportOptions): WebRTCTransport {
    const channel = peer.createDataChannel(label, {
      ordered: options?.ordered,
      maxRetransmits: options?.maxRetransmits,
      negotiated: options?.negotiated,
      id: options?.id,
      protocol: options?.protocol
    });
    return new WebRTCTransport(channel, options);
  }

  get readyState(): TransportState {
    switch (this.channel.readyState) {
      case 'connecting':
        return 'connecting';
      case 'open':
        return 'open';
      case 'closing':
        return 'closing';
      case 'closed':
      default:
        return 'closed';
    }
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') {
      throw new Error('RTCDataChannel is not open');
    }

    try {
      if (typeof data === 'string') {
        this.channel.send(data);
        return;
      }

      if (data instanceof ArrayBuffer) {
        this.channel.send(data);
        return;
      }

      const buffer = cloneToArrayBuffer(data);
      this.channel.send(buffer);
    } catch (error) {
      this.logger.error('Failed to send RTC message', { error });
      throw error;
    }
  }

  close(): void {
    try {
      this.channel.close();
    } catch (error) {
      this.logger.warn('Failed to close RTCDataChannel gracefully', { error });
    }
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.listeners[event].add(handler);
  }

  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.listeners[event].delete(handler);
  }

  private bindChannelEvents(): void {
    if (typeof this.channel.addEventListener === 'function') {
      this.channel.addEventListener('message', this.messageListener);
      this.channel.addEventListener('open', this.openListener);
      this.channel.addEventListener('close', this.closeListener);
      this.channel.addEventListener('error', this.errorListener);
    } else {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - legacy RTCDataChannel implementations
      this.channel.onmessage = this.messageListener;
      // @ts-ignore
      this.channel.onopen = this.openListener;
      // @ts-ignore
      this.channel.onclose = this.closeListener;
      // @ts-ignore
      this.channel.onerror = this.errorListener;
    }
  }

  private dispatch<K extends keyof TransportEvents>(event: K, payload?: unknown): void {
    const handlers = this.listeners[event];
    if (handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        if (typeof payload === 'undefined') {
          (handler as () => void)();
        } else {
          (handler as (arg: unknown) => void)(payload);
        }
      } catch (error) {
        this.logger.error(`Transport handler for event "${event}" threw`, { error });
      }
    }
  }

  private dispatchMessage(data: unknown): void {
    if (this.listeners.message.size === 0) {
      return;
    }

    const normalized = this.normalizeInbound(data);
    if (normalized === null) {
      this.logger.warn('Unsupported RTCDataChannel message payload', { type: typeof data });
      return;
    }

    for (const handler of this.listeners.message) {
      try {
        handler(normalized);
      } catch (error) {
        this.logger.error('Message handler threw an error', { error });
      }
    }
  }

  private normalizeInbound(data: unknown): InboundData | null {
    if (typeof data === 'string') {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return data;
    }

    if (data instanceof Uint8Array) {
      return data;
    }

    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }

    if (typeof globalThis !== 'undefined') {
      const bufferCtor = (globalThis as typeof globalThis & {
        Buffer?: {
          isBuffer(value: unknown): value is Uint8Array;
        };
      }).Buffer;

      if (bufferCtor && bufferCtor.isBuffer(data)) {
        const buffer = data as Uint8Array;
        return buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
          ? buffer
          : buffer.slice();
      }
    }

    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buffer) => this.dispatchMessage(new Uint8Array(buffer)))
        .catch((error) => {
          this.logger.error('Failed to decode Blob message', { error });
        });
      return null;
    }

    return null;
  }
}
```

```src/transports/WebSocketTransport.ts
import type { Transport, TransportEvents, TransportState } from './Transport.js';
import type { Logger } from '../core/logger.js';
import { Logger as InternalLogger, LogLevel, ConsoleTransport } from '../core/logger.js';

export interface WebSocketTransportOptions {
  logger?: Logger;
  logLevel?: LogLevel;
  binaryType?: string;
}

type ListenerFn = (...args: unknown[]) => void;

type WebSocketLike = {
  readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  // Widen to support both DOM WebSocket and `ws` types
  addEventListener?(...args: any[]): void;
  removeEventListener?(...args: any[]): void;
  onmessage?: ((event: MessageEvent) => void) | null;
  onopen?: ((event: Event) => void) | null;
  onclose?: ((event: CloseEvent) => void) | null;
  onerror?: ((event: Event) => void) | null;
  on?(event: string, listener: ListenerFn): void;
  off?(event: string, listener: ListenerFn): void;
  removeListener?(event: string, listener: ListenerFn): void;
};

const READY_STATE_MAP: Record<number, TransportState> = {
  0: 'connecting',
  1: 'open',
  2: 'closing',
  3: 'closed'
};

const createDefaultLogger = (level: LogLevel = LogLevel.ERROR): Logger =>
  new InternalLogger({
    level,
    transports: [new ConsoleTransport()],
    prefix: 'WebSocketTransport'
  });

export class WebSocketTransport implements Transport {
  private readonly socket: WebSocketLike;
  private readonly logger: Logger;
  private readonly listeners: { [K in keyof TransportEvents]: Set<TransportEvents[K]> } = {
    message: new Set(),
    open: new Set(),
    close: new Set(),
    error: new Set()
  };
  private cleanupListeners?: () => void;

  private readonly messageListener = (event: MessageEvent): void => {
    this.dispatchMessage(event.data);
  };

  private readonly openListener = (): void => {
    this.dispatch('open');
  };

  private readonly closeListener = (event: CloseEvent): void => {
    this.dispatch('close', event);
  };

  private readonly errorListener = (event: Event): void => {
    const error = (event as ErrorEvent).error ?? new Error('WebSocket error event');
    this.dispatch('error', error instanceof Error ? error : new Error(String(error)));
  };

  private readonly handleNodeMessage = (...args: unknown[]): void => {
    const [data] = args;
    this.dispatchMessage(data);
  };

  private readonly handleNodeOpen = (): void => {
    this.dispatch('open');
  };

  private readonly handleNodeClose = (...args: unknown[]): void => {
    const [code, reason] = args as [number | undefined, Buffer | string | undefined];
    const reasonText =
      typeof reason === 'string'
        ? reason
        : typeof Buffer !== 'undefined' && Buffer.isBuffer(reason)
          ? reason.toString('utf8')
          : undefined;

    this.dispatch('close', { code, reason: reasonText });
  };

  private readonly handleNodeError = (...args: unknown[]): void => {
    const [error] = args;
    const err = error instanceof Error ? error : new Error(String(error));
    this.dispatch('error', err);
  };

  constructor(socket: WebSocketLike, options: WebSocketTransportOptions = {}) {
    if (!socket) {
      throw new Error('WebSocket instance is required');
    }

    this.socket = socket;
    this.logger = options.logger ?? createDefaultLogger(options.logLevel);

    if (options.binaryType && 'binaryType' in this.socket) {
      this.socket.binaryType = options.binaryType;
    }

    this.bindSocketEvents();
  }

  get readyState(): TransportState {
    return READY_STATE_MAP[this.socket.readyState] ?? 'closed';
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') {
      throw new Error('WebSocket is not open');
    }

    try {
      const payload: string | ArrayBuffer | Uint8Array =
        typeof data === 'string'
          ? data
          : data instanceof ArrayBuffer
            ? data
            : data;

      (this.socket as { send(message: typeof payload): void }).send(payload);
    } catch (error) {
      this.logger.error('Failed to send WebSocket message', { error });
      throw error;
    }
  }

  close(): void {
    try {
      this.cleanupListeners?.();
      this.cleanupListeners = undefined;
      this.socket.close();
    } catch (error) {
      this.logger.warn('Failed to close WebSocket gracefully', { error });
    }
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.listeners[event].add(handler);
  }

  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.listeners[event].delete(handler);
  }

  private bindSocketEvents(): void {
    const addListener = this.socket.addEventListener?.bind(this.socket);
    const removeListener = this.socket.removeEventListener?.bind(this.socket);

    if (addListener) {
      addListener('message', this.messageListener as EventListener);
      addListener('open', this.openListener as EventListener);
      addListener('close', this.closeListener as EventListener);
      addListener('error', this.errorListener as EventListener);

      if (removeListener) {
        this.cleanupListeners = () => {
          removeListener('message', this.messageListener as EventListener);
          removeListener('open', this.openListener as EventListener);
          removeListener('close', this.closeListener as EventListener);
          removeListener('error', this.errorListener as EventListener);
        };
      }
      return;
    }

    if (typeof this.socket.on === 'function') {
      const on = this.socket.on.bind(this.socket) as (event: string, listener: ListenerFn) => void;
      const off =
        (this.socket.off?.bind(this.socket) as ((event: string, listener: ListenerFn) => void) | undefined) ??
        (this.socket.removeListener?.bind(this.socket) as
          | ((event: string, listener: ListenerFn) => void)
          | undefined);

      on('message', this.handleNodeMessage);
      on('open', this.handleNodeOpen);
      on('close', this.handleNodeClose);
      on('error', this.handleNodeError);

      if (off) {
        this.cleanupListeners = () => {
          off('message', this.handleNodeMessage);
          off('open', this.handleNodeOpen);
          off('close', this.handleNodeClose);
          off('error', this.handleNodeError);
        };
      }
      return;
    }

    this.socket.onmessage = this.messageListener;
    this.socket.onopen = this.openListener;
    this.socket.onclose = this.closeListener;
    this.socket.onerror = this.errorListener as (event: Event) => void;

    this.cleanupListeners = () => {
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
    };
  }

  private dispatch<K extends keyof TransportEvents>(event: K, payload?: unknown): void {
    const handlers = this.listeners[event];
    if (handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        if (typeof payload === 'undefined') {
          (handler as () => void)();
        } else {
          (handler as (arg: unknown) => void)(payload);
        }
      } catch (error) {
        this.logger.error(`Transport handler for event "${event}" threw`, { error });
      }
    }
  }

  private dispatchMessage(data: unknown): void {
    if (this.listeners.message.size === 0) {
      return;
    }

    const normalized = this.normalizeData(data);
    if (normalized === null) {
      this.logger.warn('Unsupported WebSocket message payload', { type: typeof data });
      return;
    }

    for (const handler of this.listeners.message) {
      try {
        handler(normalized);
      } catch (error) {
        this.logger.error('Message handler threw an error', { error });
      }
    }
  }

  private normalizeData(data: unknown): string | ArrayBuffer | Uint8Array | null {
    if (typeof data === 'string') {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return data;
    }

    if (data instanceof Uint8Array) {
      return data;
    }

    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      return new Uint8Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
      );
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      const buffer = data as Buffer;
      return new Uint8Array(buffer);
    }

    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      (data as Blob)
        .arrayBuffer()
        .then((buffer) => this.dispatchMessage(new Uint8Array(buffer)))
        .catch((error) => {
          this.logger.error('Failed to decode Blob message', { error });
        });
      return null;
    }

    return null;
  }
}
```

```src/workers/index.ts
// Re-export Worker Pool APIs on the "workers" subpath
export { WorkerPool, type WorkerPoolOptions } from './WorkerPool.js';
export { WorkerPoolResolver, type WorkerPoolResolverOptions } from '../core/WorkerPoolResolver.js';
```

```src/workers/message-worker.ts
import { parentPort } from "worker_threads";

interface WorkerTask {
	id: string;
	type:
		| "serialize"
		| "deserialize"
		| "validate"
		| "compress"
		| "decompress"
		| "transform";
	data: unknown;
	options?: Record<string, unknown>;
}

interface WorkerResult {
	id: string;
	result?: unknown;
	error?: {
		message: string;
		stack?: string;
	};
	duration: number;
}

const port = parentPort;

if (!port) {
	throw new Error("message-worker must be run as a worker thread");
}

port.on("message", async (task: WorkerTask) => {
	const taskStart = Date.now();

	try {
		let result: unknown;

		switch (task.type) {
			case "serialize":
				result = JSON.stringify(task.data);
				break;

			case "deserialize":
				result = JSON.parse(task.data as string);
				break;

			case "validate":
				result = validateMessage(task.data, task.options?.schema);
				break;

			case "compress":
				result = await compressData(task.data);
				break;

			case "decompress":
				result = await decompressData(task.data as Buffer);
				break;

			case "transform":
				result = await transformPayload(
					task.data,
					task.options?.transformer as
						| ((value: unknown) => unknown)
						| undefined,
				);
				break;

			default:
				throw new Error(`Unknown task type: ${task.type}`);
		}

		const duration = Date.now() - taskStart;

		port.postMessage({
			id: task.id,
			result,
			duration,
		} satisfies WorkerResult);
	} catch (error) {
		const duration = Date.now() - taskStart;
		const typedError = error as Error;

		port.postMessage({
			id: task.id,
			error: {
				message: typedError.message,
				stack: typedError.stack,
			},
			duration,
		} satisfies WorkerResult);
	}
});

function validateMessage(data: unknown, schema?: unknown): boolean {
	if (!data || typeof data !== "object") {
		throw new Error("Invalid message format");
	}

	const candidate = data as Record<string, unknown>;
	if (typeof candidate.id !== "string" || typeof candidate.type !== "string") {
		throw new Error("Message must have id and type fields");
	}

	if (schema) {
		// Extend validation using provided schema
		const validator = (schema as { validate?: (value: unknown) => boolean })
			.validate;
		if (validator && !validator(candidate)) {
			throw new Error("Message does not match schema");
		}
	}

	return true;
}

async function compressData(data: unknown): Promise<Buffer> {
	const { gzip } = await import("node:zlib");
	const { promisify } = await import("node:util");
	const gzipAsync = promisify(gzip);

	const buffer = Buffer.from(JSON.stringify(data));
	return gzipAsync(buffer);
}

async function decompressData(data: Buffer): Promise<unknown> {
	const { gunzip } = await import("node:zlib");
	const { promisify } = await import("node:util");
	const gunzipAsync = promisify(gunzip);

	const decompressed = await gunzipAsync(data);
	return JSON.parse(decompressed.toString());
}

async function transformPayload(
	data: unknown,
	transformer?: (value: unknown) => unknown,
): Promise<unknown> {
	if (transformer) {
		return transformer(data);
	}
	return data;
}

port.postMessage({ ready: true });

```

```src/workers/WorkerPool.ts
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { cpus } from 'node:os';
import { existsSync } from 'node:fs';
import { generateUUID } from '../core/uuid.js';
import { Logger, LogLevel } from '../core/logger.js';

type WorkerTaskType = 'serialize' | 'deserialize' | 'validate' | 'compress' | 'decompress' | 'transform';

interface WorkerTaskEnvelope {
  id: string;
  type: WorkerTaskType;
  data: unknown;
  options?: Record<string, unknown>;
}

interface WorkerResultMessage {
  id?: string;
  result?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
  duration?: number;
  ready?: boolean;
}

interface PooledWorker {
  id: number;
  worker: Worker;
  busy: boolean;
  tasksCompleted: number;
  totalDuration: number;
  currentTaskId?: string;
  defunct: boolean;
}

interface PendingTask {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime: number;
}

interface QueueEntry {
  id: string;
  task: WorkerTaskEnvelope;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface WorkerPoolOptions {
  workerCount?: number;
  workerScript?: string;
  taskTimeout?: number;
  logger?: Logger;
}

export class WorkerPool {
  private readonly workerScript: string;
  private readonly taskTimeout: number;
  private readonly logger: Logger;

  private workers: PooledWorker[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private taskQueue: QueueEntry[] = [];
  private destroyed = false;

  constructor(options: WorkerPoolOptions = {}) {
    const workerCount = options.workerCount ?? this.getOptimalWorkerCount();
    this.workerScript = this.resolveWorkerScript(options.workerScript);
    this.taskTimeout = options.taskTimeout ?? 10_000;
    this.logger =
      options.logger ??
      new Logger({
        level: LogLevel.INFO,
        transports: [],
        prefix: 'WorkerPool'
      });

    this.logger.info('Initializing worker pool', {
      workerCount,
      workerScript: this.workerScript
    });

    this.initializeWorkers(workerCount);
  }

  async execute<TResult = unknown>(
    type: WorkerTaskType,
    data: unknown,
    options?: Record<string, unknown>
  ): Promise<TResult> {
    if (this.destroyed) {
      throw new Error('Worker pool destroyed');
    }

    const id = generateUUID();
    const task: WorkerTaskEnvelope = { id, type, data, options };

    return new Promise<TResult>((resolve, reject) => {
      const resolver = (value: unknown) => resolve(value as TResult);
      const rejection = (error: Error) => reject(error);

      const availableWorker = this.workers.find((worker) => !worker.busy && !worker.defunct);

      if (availableWorker) {
        this.executeTask(task, resolver, rejection, availableWorker);
      } else {
        this.taskQueue.push({ id, task, resolve: resolver, reject: rejection });
        this.logger.debug('Task queued', { id, queueLength: this.taskQueue.length });
      }
    });
  }

  getStats() {
    const workerCount = this.workers.length;
    const busyWorkers = this.workers.filter((worker) => worker.busy && !worker.defunct).length;
    const queueLength = this.taskQueue.length;
    const totalTasksCompleted = this.workers.reduce((sum, worker) => sum + worker.tasksCompleted, 0);
    const totalDuration = this.workers.reduce((sum, worker) => sum + worker.totalDuration, 0);
    const averageDuration = totalTasksCompleted > 0 ? totalDuration / totalTasksCompleted : 0;

    return {
      workerCount,
      busyWorkers,
      queueLength,
      totalTasksCompleted,
      averageDuration
    };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.logger.info('Destroying worker pool');

    const destructionError = new Error('Worker pool destroyed');

    for (const pending of this.pendingTasks.values()) {
      clearTimeout(pending.timeout);
      pending.reject(destructionError);
    }
    this.pendingTasks.clear();

    for (const entry of this.taskQueue) {
      entry.reject(destructionError);
    }
    this.taskQueue = [];

    for (const pooledWorker of this.workers) {
      pooledWorker.defunct = true;
    }

    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
    this.workers = [];

    this.logger.info('Worker pool destroyed');
  }

  private initializeWorkers(count: number): void {
    for (let i = 0; i < count; i++) {
      const pooledWorker = this.spawnWorker(i);
      if (pooledWorker) {
        this.workers.push(pooledWorker);
      }
    }

    this.logger.info('Worker pool initialized', { workerCount: this.workers.length });
  }

  private spawnWorker(id: number): PooledWorker | null {
    try {
      const worker = new Worker(this.workerScript);

      const pooledWorker: PooledWorker = {
        id,
        worker,
        busy: false,
        tasksCompleted: 0,
        totalDuration: 0,
        defunct: false
      };

      this.registerWorkerEvents(pooledWorker);

      return pooledWorker;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to spawn worker', { workerId: id, error: message });
      return null;
    }
  }

  private registerWorkerEvents(pooledWorker: PooledWorker): void {
    pooledWorker.worker.on('message', (message: WorkerResultMessage) => {
      this.handleWorkerMessage(pooledWorker, message);
    });

    pooledWorker.worker.on('error', (error: Error) => {
      this.handleWorkerError(pooledWorker, error);
    });

    pooledWorker.worker.on('exit', (code) => {
      this.handleWorkerExit(pooledWorker, code);
    });
  }

  private handleWorkerMessage(pooledWorker: PooledWorker, message: WorkerResultMessage): void {
    if (pooledWorker.defunct) {
      return;
    }

    if (message.ready) {
      this.logger.debug('Worker ready', { workerId: pooledWorker.id });
      return;
    }

    if (!message.id) {
      this.logger.warn('Received worker message without task id', { workerId: pooledWorker.id });
      return;
    }

    const pending = this.pendingTasks.get(message.id);
    if (!pending) {
      this.logger.warn('Received result for unknown task', { workerId: pooledWorker.id, taskId: message.id });
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingTasks.delete(message.id);

    pooledWorker.busy = false;
    pooledWorker.currentTaskId = undefined;
    pooledWorker.tasksCompleted += 1;
    pooledWorker.totalDuration += message.duration ?? 0;

    if (message.error) {
      const error = new Error(message.error.message);
      if (message.error.stack) {
        error.stack = message.error.stack;
      }
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }

    this.processQueue();
  }

  private handleWorkerError(pooledWorker: PooledWorker, error: Error): void {
    if (pooledWorker.defunct) {
      return;
    }

    this.logger.error('Worker encountered error', {
      workerId: pooledWorker.id,
      error: error.message
    });

    this.rejectPendingTask(pooledWorker.currentTaskId, error);

    pooledWorker.busy = false;
    pooledWorker.currentTaskId = undefined;

    this.removeWorker(pooledWorker);
    if (!this.destroyed) {
      const replacement = this.spawnWorker(pooledWorker.id);
      if (replacement) {
        this.workers.push(replacement);
      }
    }

    this.processQueue();
  }

  private handleWorkerExit(pooledWorker: PooledWorker, code: number | null): void {
    if (pooledWorker.defunct) {
      return;
    }

    const exitError = code === 0 ? null : new Error(`Worker exited with code ${code ?? 'unknown'}`);

    if (exitError) {
      this.logger.error('Worker exited unexpectedly', {
        workerId: pooledWorker.id,
        code
      });
    } else {
      this.logger.debug('Worker exited', { workerId: pooledWorker.id, code });
    }

    this.rejectPendingTask(
      pooledWorker.currentTaskId,
      exitError ?? new Error('Worker terminated before completing task')
    );

    pooledWorker.busy = false;
    pooledWorker.currentTaskId = undefined;

    this.removeWorker(pooledWorker);

    if (!this.destroyed) {
      const replacement = this.spawnWorker(pooledWorker.id);
      if (replacement) {
        this.workers.push(replacement);
        this.processQueue();
      }
    }
  }

  private rejectPendingTask(taskId: string | undefined, error: Error): void {
    if (!taskId) {
      return;
    }

    const pending = this.pendingTasks.get(taskId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingTasks.delete(taskId);
    pending.reject(error);
  }

  private removeWorker(pooledWorker: PooledWorker): void {
    pooledWorker.defunct = true;
    this.workers = this.workers.filter((worker) => worker !== pooledWorker);
  }

  private executeTask(
    task: WorkerTaskEnvelope,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    pooledWorker: PooledWorker
  ): void {
    if (this.destroyed || pooledWorker.defunct) {
      reject(new Error('Worker pool destroyed'));
      return;
    }

    pooledWorker.busy = true;
    pooledWorker.currentTaskId = task.id;

    const timeout = setTimeout(() => {
      if (!this.pendingTasks.has(task.id)) {
        return;
      }

      this.pendingTasks.delete(task.id);

      pooledWorker.busy = false;
      pooledWorker.currentTaskId = undefined;

      const timeoutError = new Error(`Worker task timeout after ${this.taskTimeout}ms`);
      reject(timeoutError);

      this.logger.warn('Worker task timed out', {
        workerId: pooledWorker.id,
        taskId: task.id,
        timeout: this.taskTimeout
      });

      this.processQueue();
    }, this.taskTimeout);

    this.pendingTasks.set(task.id, {
      resolve,
      reject,
      timeout,
      startTime: Date.now()
    });

    try {
      pooledWorker.worker.postMessage(task);
      this.logger.trace('Task dispatched to worker', {
        workerId: pooledWorker.id,
        taskId: task.id
      });
    } catch (error) {
      clearTimeout(timeout);
      this.pendingTasks.delete(task.id);

      pooledWorker.busy = false;
      pooledWorker.currentTaskId = undefined;

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to post task to worker', {
        workerId: pooledWorker.id,
        taskId: task.id,
        error: message
      });

      reject(error instanceof Error ? error : new Error(message));

      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.destroyed || this.taskQueue.length === 0) {
      return;
    }

    let availableWorker = this.workers.find((worker) => !worker.busy && !worker.defunct);

    while (availableWorker && this.taskQueue.length > 0) {
      const entry = this.taskQueue.shift();
      if (!entry) {
        break;
      }

      this.executeTask(entry.task, entry.resolve, entry.reject, availableWorker);

      availableWorker = this.workers.find((worker) => !worker.busy && !worker.defunct);
    }
  }

  private getOptimalWorkerCount(): number {
    const hardwareConcurrency =
      typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;

    if (typeof hardwareConcurrency === 'number' && hardwareConcurrency > 1) {
      return Math.max(2, hardwareConcurrency - 1);
    }

    try {
      const cpuList = typeof cpus === 'function' ? cpus() : [];
      if (cpuList.length > 1) {
        return Math.max(2, cpuList.length - 1);
      }
    } catch {
      // Ignored - fall back to default
    }

    return 4;
  }

  private resolveWorkerScript(scriptPath?: string): string {
    const currentDir = dirname(fileURLToPath(import.meta.url));

    // If explicit path provided, try absolute as-is, then relative to current module and CWD.
    if (scriptPath) {
      if (isAbsolute(scriptPath)) {
        return scriptPath;
      }
      const candidateA = join(currentDir, scriptPath);
      if (existsSync(candidateA)) return candidateA;

      const candidateB = join(process.cwd(), scriptPath);
      if (existsSync(candidateB)) return candidateB;

      // Fallthrough to default search below
    }

    // Preferred when running built code (dist): worker sits alongside WorkerPool.js
    const builtSibling = join(currentDir, 'message-worker.js');
    if (existsSync(builtSibling)) return builtSibling;

    // When running tests from TS sources, prefer built artifact under project dist
    const distWorker = join(process.cwd(), 'dist', 'workers', 'message-worker.js');
    if (existsSync(distWorker)) return distWorker;

    // As a last resort, return sibling path (may fail if not built)
    return builtSibling;
  }
}
```