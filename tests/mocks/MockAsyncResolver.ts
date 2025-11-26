import type { AsyncResolver } from "../../src/core/AsyncResolver.js";
import type { Message, RequestOptions } from "../../src/core/types.js";
import type { MockWebSocketTransport } from "./MockWebSocketTransport.js";

type DynamicResponseFn = () => {
	status: number;
	headers?: Record<string, string>;
	bodyText: string;
};

/**
 * Mock AsyncResolver for testing RowstRoute
 */
export class MockAsyncResolver {
	private mockResponses: Map<string, unknown> = new Map();
	private mockErrors: Map<string, Error> = new Map();
	private timeouts: Set<string> = new Set();
	private dynamicResponseFn?: DynamicResponseFn;
	public readonly transport: MockWebSocketTransport;

	constructor(transport: MockWebSocketTransport) {
		this.transport = transport;
	}

	/**
	 * Mock a successful response for a specific event or default
	 */
	mockResponse(
		response: {
			status: number;
			headers?: Record<string, string>;
			bodyText: string;
		},
		event?: string,
	): void {
		this.mockResponses.set(event ?? "default", response);
	}

	/**
	 * Mock an error for a specific event or default
	 */
	mockError(error: Error, event?: string): void {
		this.mockErrors.set(event ?? "default", error);
	}

	/**
	 * Mock a timeout for a specific event or default
	 */
	mockTimeout(event?: string): void {
		this.timeouts.add(event ?? "default");
	}

	/**
	 * Mock a dynamic response function that's called on each request
	 */
	mockDynamicResponse(fn: DynamicResponseFn): void {
		this.dynamicResponseFn = fn;
	}

	/**
	 * Simulate AsyncResolver.request()
	 */
	async request<TResponse = unknown, TRequest = unknown>(
		payload: TRequest,
		options?: RequestOptions,
	): Promise<Message<TResponse>> {
		const event = (options?.meta?.event as string) ?? "default";

		// Record the sent message
		this.transport.sentMessages.push({
			payload,
			options,
		});

		// Check for timeout
		if (this.timeouts.has(event) || this.timeouts.has("default")) {
			return new Promise((_, reject) => {
				setTimeout(() => reject(new Error("Timeout")), options?.timeout ?? 100);
			});
		}

		// Check for error
		if (this.mockErrors.has(event) || this.mockErrors.has("default")) {
			const error =
				this.mockErrors.get(event) ?? this.mockErrors.get("default");
			throw error;
		}

		// Use dynamic response if available
		if (this.dynamicResponseFn) {
			const response = this.dynamicResponseFn();
			return {
				id: "mock-id",
				type: "response",
				payload: response as TResponse,
				timestamp: new Date().toISOString(),
			};
		}

		// Use mocked response
		const response =
			this.mockResponses.get(event) ?? this.mockResponses.get("default");

		if (!response) {
			throw new Error(`No mock response configured for event: ${event}`);
		}

		return {
			id: "mock-id",
			type: "response",
			payload: response as TResponse,
			timestamp: new Date().toISOString(),
		};
	}

	/**
	 * Simulate AsyncResolver.requestWithRetry()
	 */
	async requestWithRetry<TResponse = unknown, TRequest = unknown>(
		payload: TRequest,
		options?: RequestOptions,
	): Promise<Message<TResponse>> {
		const retries = options?.retries ?? 0;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				return await this.request<TResponse, TRequest>(payload, options);
			} catch (error) {
				lastError = error as Error;
				if (attempt === retries) {
					throw error;
				}
				// Small delay between retries
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}

		throw lastError ?? new Error("Request failed");
	}

	/**
	 * Simulate AsyncResolver.notify()
	 */
	notify<TPayload = unknown>(payload: TPayload): void {
		this.transport.sentMessages.push({
			payload,
			options: undefined,
		});
	}

	/**
	 * Simulate AsyncResolver.isReady()
	 */
	isReady(): boolean {
		return this.transport.isConnected();
	}

	/**
	 * Simulate AsyncResolver.getTransportState()
	 */
	getTransportState(): "connecting" | "open" | "closing" | "closed" {
		return this.transport.isConnected() ? "open" : "closed";
	}
}
