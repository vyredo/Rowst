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