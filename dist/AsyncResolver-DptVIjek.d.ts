import { L as Logger, T as Transport, e as TransportState, b as LogLevel } from './logger-CBj8alH5.js';

type MessageType = "request" | "response" | "notification";
interface Message<TPayload = unknown> {
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
declare enum ErrorCode {
    TIMEOUT = "TIMEOUT",
    TRANSPORT_CLOSED = "TRANSPORT_CLOSED",
    TRANSPORT_ERROR = "TRANSPORT_ERROR",
    BACKPRESSURE = "BACKPRESSURE",
    INVALID_MESSAGE = "INVALID_MESSAGE",
    SEND_FAILED = "SEND_FAILED"
}
interface CorrelatorOptions {
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
    responseInterceptor?: <T>(message: Message<T>) => Message<T> | Promise<Message<T>>;
    /**
     * Request deduplication strategy. If true, uses JSON.stringify(payload) as the key.
     * Or provide a function that returns a cache key string for the given payload.
     */
    deduplicateRequests?: boolean | ((payload: unknown) => string);
}
interface RequestOptions {
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
interface Metrics {
    inflightCount: number;
    totalRequests: number;
    totalResponses: number;
    totalTimeouts: number;
    totalErrors: number;
    latencies: number[];
}
interface LatencyStats {
    min: number;
    max: number;
    mean: number;
    median: number;
    p50: number;
    p95: number;
    p99: number;
}

interface AsyncResolverOptions extends CorrelatorOptions {
    latencySampleSize?: number;
}
declare class AsyncResolver {
    private readonly transport;
    private readonly logger;
    private readonly options;
    private readonly pending;
    private readonly metrics;
    private readonly responseInterceptor?;
    private readonly deduplicateFn?;
    private readonly inflightByKey;
    private shuttingDown;
    private readonly handleMessage;
    private readonly handleOpen;
    private readonly handleClose;
    private readonly handleError;
    constructor(transport: Transport, options?: AsyncResolverOptions);
    request<TResponse = unknown, TRequest = unknown>(payload: TRequest, options?: RequestOptions): Promise<Message<TResponse>>;
    requestWithRetry<TResponse = unknown, TRequest = unknown>(payload: TRequest, options?: RequestOptions): Promise<Message<TResponse>>;
    notify<TPayload = unknown>(payload: TPayload): void;
    getInflightCount(): number;
    getMetrics(): Metrics & {
        stats: LatencyStats;
        dedupCacheSize: number;
    };
    /**
     * Wait for transport to reach 'open' state.
     * Resolves immediately if already open.
     * Rejects on timeout or if transport closes/errors.
     */
    waitForReady(options?: {
        timeout?: number;
        throwOnTimeout?: boolean;
    }): Promise<void>;
    /**
     * Check if transport is ready to send requests.
     */
    isReady(): boolean;
    /**
     * Get current transport state.
     */
    getTransportState(): TransportState;
    /**
     * Gracefully close the resolver.
     * - Stop accepting new requests
     * - Wait for pending requests to complete or timeout
     * - Close transport
     */
    close(options?: {
        timeout?: number;
        force?: boolean;
    }): Promise<void>;
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
    };
    /**
     * Enable/disable trace logging at runtime.
     */
    setLogLevel(level: LogLevel): void;
    destroy(): void;
    private requestAttempt;
    private sendSerialized;
    private onTransportMessage;
    private handleResponse;
    private validateMessage;
    private rejectAllPending;
    private shouldNotRetry;
    private calculateBackoffDelay;
    private wait;
    private recordLatency;
    private buildMeta;
    private describeError;
}

export { AsyncResolver as A, type CorrelatorOptions as C, ErrorCode as E, type LatencyStats as L, type Message as M, type RequestOptions as R, type AsyncResolverOptions as a, type MessageType as b, type Metrics as c };
