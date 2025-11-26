export type TransportState = "connecting" | "open" | "closing" | "closed";

export interface TransportEvents {
	message: (data: string | ArrayBuffer | Uint8Array) => void;
	open: () => void;
	close: (event?: unknown) => void;
	error: (error: Error | unknown) => void;
}

export interface Transport {
	readonly readyState: TransportState;
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(): void;

	on<K extends keyof TransportEvents>(
		event: K,
		handler: TransportEvents[K],
	): void;
	off<K extends keyof TransportEvents>(
		event: K,
		handler: TransportEvents[K],
	): void;

	/**
	 * Optional one-time listener registration
	 */
	once?<K extends keyof TransportEvents>(
		event: K,
		handler: TransportEvents[K],
	): void;
}

/**
 * Type guard for transport 'open' state
 */
export function isTransportReady(transport: Transport): boolean {
	return transport.readyState === "open";
}

/**
 * Type guard for transport 'closed' or 'closing' state
 */
export function isTransportClosed(transport: Transport): boolean {
	return (
		transport.readyState === "closed" || transport.readyState === "closing"
	);
}
