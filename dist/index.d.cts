import { M as Message } from './AsyncResolver-BAKw2H2q.cjs';
export { A as AsyncResolver, a as AsyncResolverOptions, C as CorrelatorOptions, E as ErrorCode, L as LatencyStats, b as MessageType, c as Metrics, R as RequestOptions } from './AsyncResolver-BAKw2H2q.cjs';
export { C as ConsoleTransport, b as LogLevel, c as LogTransport, L as Logger, a as LoggerOptions, N as NoopTransport, T as Transport, d as TransportEvents, e as TransportState } from './Transport-sRzkGEga.cjs';
export { WorkerPool, WorkerPoolResolver } from './workers/index.cjs';
export { RowstMCPServer } from './mcp/index.cjs';
export { WebRTCTransport, WebSocketTransport } from './transports/index.cjs';

declare class RowstError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    constructor(message: string, code: string, details?: unknown | undefined);
}
declare class TimeoutError extends RowstError {
    constructor(message?: string, details?: unknown);
}
declare class TransportClosedError extends RowstError {
    constructor(message?: string, details?: unknown);
}
declare class TransportError extends RowstError {
    constructor(message?: string, details?: unknown);
}
declare class BackpressureError extends RowstError {
    constructor(message?: string, details?: unknown);
}
declare class InvalidMessageError extends RowstError {
    constructor(message?: string, details?: unknown);
}
interface ErrorResponse {
    code: string;
    message: string;
    details?: unknown;
}
declare function toErrorResponse(error: unknown): ErrorResponse;
declare function isErrorMessage(message: Message): boolean;

/**
 * Generates RFC4122-compliant v4 UUIDs using cryptographically secure random numbers
 * Zero dependencies - works in Node.js and browser environments
 */
declare function generateUUID(): string;
declare function isValidUUID(uuid: string): boolean;

export { BackpressureError, type ErrorResponse, InvalidMessageError, Message, RowstError, TimeoutError, TransportClosedError, TransportError, generateUUID, isErrorMessage, isValidUUID, toErrorResponse };
