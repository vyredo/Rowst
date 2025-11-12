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