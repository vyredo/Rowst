/**
 * Mock WebSocket Transport for testing
 */
export class MockWebSocketTransport {
	public sentMessages: Array<{
		payload: unknown;
		options: unknown;
	}> = [];
	private connected = true;

	/**
	 * Simulate sending a message
	 */
	send(message: unknown): void {
		this.sentMessages.push({
			payload: message,
			options: undefined,
		});
	}

	/**
	 * Simulate disconnecting the transport
	 */
	disconnect(): void {
		this.connected = false;
	}

	/**
	 * Check if transport is connected
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Close and reset the transport
	 */
	close(): void {
		this.connected = false;
		this.sentMessages = [];
	}

	/**
	 * Reconnect the transport
	 */
	reconnect(): void {
		this.connected = true;
	}
}
