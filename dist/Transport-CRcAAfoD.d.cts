declare enum LogLevel {
    SILENT = 0,
    ERROR = 1,
    WARN = 2,
    INFO = 3,
    DEBUG = 4,
    TRACE = 5
}
interface LogTransport {
    log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}
interface LoggerOptions {
    level: LogLevel;
    transports: LogTransport[];
    prefix?: string;
}
declare class Logger {
    private options;
    constructor(options: LoggerOptions);
    private shouldLog;
    private emit;
    error(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    trace(message: string, meta?: Record<string, unknown>): void;
    setLevel(level: LogLevel): void;
    addTransport(transport: LogTransport): void;
    removeTransport(transport: LogTransport): void;
}
declare class ConsoleTransport implements LogTransport {
    log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}
declare class NoopTransport implements LogTransport {
    log(): void;
}

type TransportState = 'connecting' | 'open' | 'closing' | 'closed';
interface TransportEvents {
    message: (data: string | ArrayBuffer | Uint8Array) => void;
    open: () => void;
    close: (event?: unknown) => void;
    error: (error: Error) => void;
}
interface Transport {
    readonly readyState: TransportState;
    send(data: string | ArrayBuffer | Uint8Array): void;
    close(): void;
    on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
    off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
}

export { ConsoleTransport as C, LogLevel as L, NoopTransport as N, type Transport as T, Logger as a, type LoggerOptions as b, type LogTransport as c, type TransportEvents as d, type TransportState as e };
