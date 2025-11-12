import { generateUUID } from './uuid.js';
import { BackpressureError, InvalidMessageError, TimeoutError, TransportClosedError, TransportError, RowstError } from './errors.js';
import { Logger, LogLevel, NoopTransport } from './logger.js';
import type { LatencyStats, Message, Metrics, RequestOptions, CorrelatorOptions } from './types.js';
import { ErrorCode } from './types.js';
import type { Transport, TransportEvents } from '../transports/Transport.js';

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

type MessageHandler = TransportEvents['message'];
type CloseHandler = TransportEvents['close'];
type ErrorHandler = TransportEvents['error'];
type OpenHandler = TransportEvents['open'];

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
  transports: [new NoopTransport()]
});

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

const bufferDecoder = (() => {
  if (typeof globalThis === 'undefined') {
    return null;
  }

  const candidate = (globalThis as typeof globalThis & {
    Buffer?: {
      from(input: ArrayBuffer | Uint8Array): { toString(encoding: string): string };
    };
  }).Buffer;

  if (!candidate || typeof candidate.from !== 'function') {
    return null;
  }

  return (input: ArrayBuffer | Uint8Array): string => candidate.from(input).toString('utf8');
})();

function decodeTransportData(data: TransportData): string {
  if (typeof data === 'string') {
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

  throw new InvalidMessageError('Unsupported message data type');
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
      p99: 0
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
    p99: percentile(99)
  };
}

export class AsyncResolver {
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly options: Required<Pick<AsyncResolverOptions, 'defaultTimeout' | 'maxInflight' | 'latencySampleSize'>>;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly metrics: Metrics = {
    inflightCount: 0,
    totalRequests: 0,
    totalResponses: 0,
    totalTimeouts: 0,
    totalErrors: 0,
    latencies: []
  };

  private readonly handleMessage: MessageHandler = (data) => {
    try {
      this.onTransportMessage(data);
    } catch (error) {
      this.logger.error('Failed to process transport message', this.describeError(error));
      this.metrics.totalErrors += 1;
    }
  };

  private readonly handleOpen: OpenHandler = () => {
    this.logger.debug('Transport opened');
  };

  private readonly handleClose: CloseHandler = (event) => {
    this.logger.warn('Transport closed', { event });
    this.rejectAllPending(new TransportClosedError('Transport closed', event));
  };

  private readonly handleError: ErrorHandler = (error) => {
    this.logger.error('Transport error', this.describeError(error));
    this.metrics.totalErrors += 1;
  };

  constructor(transport: Transport, options: AsyncResolverOptions = {}) {
    this.transport = transport;
    this.logger = options.logger ?? fallbackLogger;
    this.options = {
      defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
      maxInflight: options.maxInflight ?? DEFAULT_MAX_INFLIGHT,
      latencySampleSize: options.latencySampleSize ?? DEFAULT_LATENCY_SAMPLE_SIZE
    };

    this.transport.on('message', this.handleMessage);
    this.transport.on('open', this.handleOpen);
    this.transport.on('close', this.handleClose);
    this.transport.on('error', this.handleError);
  }

  async request<TResponse = unknown, TRequest = unknown>(
    payload: TRequest,
    options?: RequestOptions
  ): Promise<Message<TResponse>> {
    return this.requestAttempt<TResponse, TRequest>(payload, options, 1);
  }

  async requestWithRetry<TResponse = unknown, TRequest = unknown>(
    payload: TRequest,
    options?: RequestOptions
  ): Promise<Message<TResponse>> {
    const retries = options?.retries ?? 0;
    let attempt = 1;
    let lastError: unknown;

    while (attempt <= retries + 1) {
      try {
        const response = await this.requestAttempt<TResponse, TRequest>(payload, options, attempt);
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
        this.logger.warn('Request attempt failed, retrying', {
          attempt,
          retries,
          delay,
          error: this.describeError(error)
        });
        await this.wait(delay);
        attempt += 1;
      }
    }

    throw lastError ?? new TransportError('Request failed after retries');
  }

  notify<TPayload = unknown>(payload: TPayload): void {
    const message: Message<TPayload> = {
      id: generateUUID(),
      type: 'notification',
      payload,
      timestamp: new Date().toISOString()
    };

    this.sendSerialized(message);
  }

  getInflightCount(): number {
    return this.pending.size;
  }

  getMetrics(): Metrics & { stats: LatencyStats } {
    return {
      ...this.metrics,
      inflightCount: this.pending.size,
      stats: ensureLatencyStats(this.metrics.latencies)
    };
  }

  destroy(): void {
    this.transport.off('message', this.handleMessage);
    this.transport.off('open', this.handleOpen);
    this.transport.off('close', this.handleClose);
    this.transport.off('error', this.handleError);
    this.rejectAllPending(new TransportClosedError('Resolver destroyed'));
  }

  private requestAttempt<TResponse, TRequest>(
    payload: TRequest,
    options: RequestOptions | undefined,
    attempt: number
  ): Promise<Message<TResponse>> {
    if (this.transport.readyState === 'closing' || this.transport.readyState === 'closed') {
      throw new TransportClosedError();
    }

    if (this.pending.size >= this.options.maxInflight) {
      throw new BackpressureError(`Max inflight requests (${this.options.maxInflight}) exceeded`);
    }

    const requestId = generateUUID();
    const timeout = options?.timeout ?? this.options.defaultTimeout;
    const createdAt = Date.now();

    const meta = this.buildMeta(options, attempt);

    const requestMessage: Message<TRequest> = {
      id: requestId,
      type: 'request',
      payload,
      timestamp: new Date().toISOString(),
      meta
    };

    this.metrics.totalRequests += 1;
    this.metrics.inflightCount = this.pending.size + 1;

    return new Promise<Message<TResponse>>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(requestId);
        this.metrics.totalTimeouts += 1;
        this.metrics.inflightCount = this.pending.size;
        const timeoutError = new TimeoutError(`Request ${requestId} timed out after ${timeout}ms`, {
          requestId,
          timeout
        });
        this.logger.warn('Request timed out', { requestId, timeout });
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
        meta
      };

      this.pending.set(requestId, pendingRequest as PendingRequest<unknown>);

      try {
        this.sendSerialized(requestMessage);
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pending.delete(requestId);
        this.metrics.inflightCount = this.pending.size;
        const transportError = error instanceof RowstError ? error : new TransportError('Failed to send request', error);
        this.logger.error('Failed to send request', {
          requestId,
          error: this.describeError(transportError)
        });
        reject(transportError);
      }
    });
  }

  private sendSerialized(message: Message<unknown>): void {
    try {
      const serialized = JSON.stringify(message);
      this.transport.send(serialized);
      this.logger.trace('Sent message', {
        id: message.id,
        type: message.type
      });
    } catch (error) {
      throw new TransportError('Transport send failed', error);
    }
  }

  private onTransportMessage(data: TransportData): void {
    const raw = decodeTransportData(data);
    let parsed: Message;

    try {
      parsed = JSON.parse(raw) as Message;
    } catch (error) {
      throw new InvalidMessageError('Received invalid JSON message', error);
    }

    this.validateMessage(parsed);

    if (parsed.type === 'response') {
      this.handleResponse(parsed);
      return;
    }

    if (parsed.type === 'notification') {
      this.logger.info('Received notification', { id: parsed.id, meta: parsed.meta });
      return;
    }

    this.logger.warn('Unhandled message type', { type: parsed.type, id: parsed.id });
  }

  private handleResponse(message: Message): void {
    const pending = this.pending.get(message.id) as PendingRequest<unknown> | undefined;
    if (!pending) {
      this.logger.warn('Received response for unknown request', { id: message.id });
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

    if (message.error) {
      const rowstError = new RowstError(message.error.message, message.error.code, message.error.details);
      rowstError.name = 'RowstRemoteError';
      this.logger.warn('Request failed with remote error', {
        id: message.id,
        error: message.error
      });
      pending.reject(rowstError);
      return;
    }

    this.logger.debug('Resolved request', { id: message.id, latency });
    pending.resolve(message);
  }

  private validateMessage(message: Message): void {
    if (typeof message !== 'object' || message === null) {
      throw new InvalidMessageError('Message must be an object');
    }

    if (!message.id || typeof message.id !== 'string') {
      throw new InvalidMessageError('Message is missing a string id');
    }

    if (!['request', 'response', 'notification'].includes(message.type)) {
      throw new InvalidMessageError('Unsupported message type');
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
    return error.code === ErrorCode.INVALID_MESSAGE || error.code === ErrorCode.BACKPRESSURE;
  }

  private calculateBackoffDelay(attempt: number, options?: RequestOptions): number {
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

  private buildMeta(options: RequestOptions | undefined, attempt: number): Record<string, unknown> {
    const meta = cloneOptions(options);
    meta.attempts = attempt;

    delete meta.timeout;
    delete meta.retries;
    delete meta.jitterFactor;
    delete meta.backoffMultiplier;

    if (options?.tags) {
      meta.tags = [...options.tags];
    }

    return meta;
  }

  private describeError(error: unknown): Record<string, unknown> {
    if (error instanceof RowstError) {
      return {
        name: error.name,
        code: error.code,
        message: error.message,
        details: error.details
      };
    }

    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }

    return { error };
  }
}