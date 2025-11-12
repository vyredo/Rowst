export type TransportState = 'connecting' | 'open' | 'closing' | 'closed';

export interface TransportEvents {
  message: (data: string | ArrayBuffer | Uint8Array) => void;
  open: () => void;
  close: (event?: unknown) => void;
  error: (error: Error) => void;
}

export interface Transport {
  readonly readyState: TransportState;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
}