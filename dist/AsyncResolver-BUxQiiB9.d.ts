import { L as Logger, T as Transport } from './Transport-sRzkGEga.js';

type MessageType = 'request' | 'response' | 'notification';
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
    defaultTimeout?: number;
    maxInflight?: number;
    logger?: Logger;
}
interface RequestOptions {
    timeout?: number;
    retries?: number;
    tags?: string[];
    jitterFactor?: number;
    backoffMultiplier?: number;
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
    };
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
