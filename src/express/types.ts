import type { Context as HonoContext } from "hono";
import type { AsyncResolver } from "../core/AsyncResolver.js";
import type { Message } from "../core/types.js";

/**
 * Configuration for a Rowst route
 */
export interface RowstRouteConfig {
	/**
	 * HTTP path pattern (Express-style, e.g., "/api/users/:id")
	 */
	rest: string;
	/**
	 * WebSocket event name to send to upstream
	 */
	event: string;
	/**
	 * Optional timeout in milliseconds for this specific route
	 */
	timeoutMs?: number;
}

/**
 * Response from upstream WebSocket request
 */
export interface UpstreamResponse<T = unknown> {
	/**
	 * HTTP status code
	 */
	status: number;
	/**
	 * Response headers
	 */
	headers: Record<string, string>;
	/**
	 * Raw response body as text
	 */
	bodyText: string;
	/**
	 * Parsed response data (if JSON)
	 */
	data?: T;
	/**
	 * Original message from AsyncResolver
	 */
	message: Message<unknown>;
}

/**
 * WebSocket context for making requests to upstream
 */
export interface WebSocketContext {
	/**
	 * Whether the WebSocket transport is currently connected
	 */
	connected: boolean;
	/**
	 * Send a request to upstream and await response
	 * @param payload - Optional payload to send (overrides HTTP body)
	 * @param opts - Request options (timeout, retries)
	 * @returns Promise resolving to upstream response
	 */
	request<T = unknown>(
		payload?: unknown,
		opts?: { timeout?: number; retries?: number },
	): Promise<UpstreamResponse<T>>;
	/**
	 * Send a fire-and-forget message to upstream
	 * @param payload - Payload to send
	 */
	send(payload?: unknown): void;
}

/**
 * Context passed to route handlers
 */
export interface RowstRouteHandlerContext {
	/**
	 * Full Hono context (request, response, params, etc.)
	 */
	honoContext: HonoContext;
	/**
	 * WebSocket context for upstream communication
	 */
	websocketContext: WebSocketContext;
}

/**
 * Route handler function
 */
export type RowstHandler = (
	ctx: RowstRouteHandlerContext,
) => Promise<Response> | Response;

/**
 * Options for creating a RowstRoute instance
 */
export interface RowstRouteOptions {
	/**
	 * Hono app instance
	 */
	app: {
		get(
			path: string,
			handler: (c: HonoContext) => Promise<Response> | Response,
		): void;
		post(
			path: string,
			handler: (c: HonoContext) => Promise<Response> | Response,
		): void;
		put(
			path: string,
			handler: (c: HonoContext) => Promise<Response> | Response,
		): void;
		delete(
			path: string,
			handler: (c: HonoContext) => Promise<Response> | Response,
		): void;
		patch(
			path: string,
			handler: (c: HonoContext) => Promise<Response> | Response,
		): void;
		all(
			path: string,
			handler: (c: HonoContext) => Promise<Response> | Response,
		): void;
	};
	/**
	 * AsyncResolver instance for WebSocket communication
	 */
	resolver: AsyncResolver;
}

/**
 * Internal request payload sent to upstream
 */
export interface UpstreamRequestPayload {
	/**
	 * HTTP method
	 */
	method: string;
	/**
	 * HTTP path
	 */
	path: string;
	/**
	 * Query string (including leading ?)
	 */
	query?: string;
	/**
	 * Request headers
	 */
	headers?: Record<string, string>;
	/**
	 * Request body (parsed JSON or raw)
	 */
	body?: unknown;
	/**
	 * WebSocket event name
	 */
	event: string;
}

/**
 * Internal response envelope from upstream
 */
export interface UpstreamResponseEnvelope {
	/**
	 * HTTP status code
	 */
	status: number;
	/**
	 * Response headers
	 */
	headers?: Record<string, string>;
	/**
	 * Response body as string
	 */
	body?: string;
}
