import type { Transport, TransportEvents, TransportState } from '../../src/transports/Transport.js';

type ListenerMap = {
  [K in keyof TransportEvents]: Set<TransportEvents[K]>;
};

export interface MockTransportOptions {
  delayMs?: number;
  failSend?: boolean;
  echoTransform?: (payload: unknown) => unknown;
}

/**
 * Simple in-memory Transport mock that immediately echoes responses for "request" messages.
 * It simulates a server by parsing Rowst request envelopes and emitting matching responses.
 */
export class MockTransport implements Transport {
  private _readyState: TransportState = 'open';
  private readonly listeners: ListenerMap = {
    message: new Set(),
    open: new Set(),
    close: new Set(),
    error: new Set()
  };

  constructor(private readonly options: MockTransportOptions = {}) {}

  get readyState(): TransportState {
    return this._readyState;
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.listeners[event].add(handler);
    // If consumer subscribes to "open" after construction, emit once to simulate connected state
    if (event === 'open' && this._readyState === 'open') {
      queueMicrotask(() => {
        try {
          (handler as () => void)();
        } catch {
          // ignore
        }
      });
    }
  }

  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.listeners[event].delete(handler);
  }

  close(): void {
    if (this._readyState === 'closed' || this._readyState === 'closing') return;
    this._readyState = 'closing';
    const delay = this.options.delayMs ?? 0;
    setTimeout(() => {
      this._readyState = 'closed';
      this.dispatch('close');
    }, delay);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this._readyState !== 'open') {
      throw new Error('MockTransport is not open');
    }
    if (this.options.failSend) {
      this.dispatch('error', new Error('MockTransport configured to fail send'));
      throw new Error('send failed');
    }

    const raw = this.decodeData(data);

    // Expect a Rowst Message envelope
    let envelope: {
      id: string;
      type: 'request' | 'response' | 'notification';
      payload: unknown;
      timestamp?: string;
      meta?: Record<string, unknown>;
    };

    try {
      envelope = JSON.parse(raw);
    } catch (e) {
      // Malformed input; emit error to listeners
      this.dispatch('error', e instanceof Error ? e : new Error(String(e)));
      return;
    }

    // For "request", synthesize a matching "response"
    if (envelope.type === 'request') {
      const delay = this.options.delayMs ?? 0;
      setTimeout(() => {
        const payload =
          typeof this.options.echoTransform === 'function'
            ? this.options.echoTransform(envelope.payload)
            : envelope.payload;

        const response = {
          id: envelope.id,
          type: 'response' as const,
          payload,
          timestamp: new Date().toISOString(),
          meta: envelope.meta ?? {}
        };

        const serialized = JSON.stringify(response);
        this.dispatch('message', serialized);
      }, delay);
      return;
    }

    // Notifications are ignored in mock server; just drop them.
    if (envelope.type === 'notification') {
      return;
    }

    // If test wants to push arbitrary raw message, forward as-is
    this.dispatch('message', raw);
  }

  private dispatch<K extends keyof TransportEvents>(event: K, arg?: Parameters<TransportEvents[K]>[0]): void {
    const set = this.listeners[event];
    for (const listener of set) {
      try {
        if (typeof arg === 'undefined') {
          (listener as () => void)();
        } else {
          (listener as (a: typeof arg) => void)(arg);
        }
      } catch {
        // swallow test listener errors
      }
    }
  }

  // Public API for tests to inject raw messages into the transport
  injectMessage(data: string | ArrayBuffer | Uint8Array): void {
    const raw = this.decodeData(data);
    this.dispatch('message', raw);
  }

  private decodeData(data: string | ArrayBuffer | Uint8Array): string {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    throw new Error('Unsupported data type');
  }
}