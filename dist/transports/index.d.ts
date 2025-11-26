import { T as Transport, L as Logger, b as LogLevel, e as TransportState, d as TransportEvents } from '../logger-CBj8alH5.js';
export { i as isTransportClosed, f as isTransportReady } from '../logger-CBj8alH5.js';

interface WebRTCTransportOptions {
    logger?: Logger;
    logLevel?: LogLevel;
    ordered?: boolean;
    maxRetransmits?: number;
    negotiated?: boolean;
    id?: number;
    protocol?: string;
}
declare class WebRTCTransport implements Transport {
    private readonly channel;
    private readonly logger;
    private readonly listeners;
    private readonly messageListener;
    private readonly openListener;
    private readonly closeListener;
    private readonly errorListener;
    constructor(channel: RTCDataChannel, options?: WebRTCTransportOptions);
    static create(peer: RTCPeerConnection, label: string, options?: WebRTCTransportOptions): WebRTCTransport;
    get readyState(): TransportState;
    send(data: string | ArrayBuffer | Uint8Array): void;
    close(): void;
    on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
    off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
    private bindChannelEvents;
    private dispatch;
    private dispatchMessage;
    private normalizeInbound;
}

interface WebSocketTransportOptions {
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
declare class WebSocketTransport implements Transport {
    private readonly socket;
    private readonly logger;
    private readonly listeners;
    private cleanupListeners?;
    private readonly messageListener;
    private readonly openListener;
    private readonly closeListener;
    private readonly errorListener;
    private readonly handleNodeMessage;
    private readonly handleNodeOpen;
    private readonly handleNodeClose;
    private readonly handleNodeError;
    constructor(socket: WebSocketLike, options?: WebSocketTransportOptions);
    get readyState(): TransportState;
    send(data: string | ArrayBuffer | Uint8Array): void;
    close(): void;
    on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
    off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
    private bindSocketEvents;
    private dispatch;
    private dispatchMessage;
    private normalizeData;
}

export { Transport, TransportEvents, TransportState, WebRTCTransport, WebSocketTransport };
