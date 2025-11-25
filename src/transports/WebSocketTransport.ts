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