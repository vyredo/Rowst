import { Context } from 'hono';
import { A as AsyncResolver, M as Message } from '../AsyncResolver-C9T1x8hr.cjs';
import '../logger-CBj8alH5.cjs';

/**
 * Configuration for a Rowst route
 */
interface RowstRouteConfig {
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
interface UpstreamResponse<T = unknown> {
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
interface WebSocketContext {
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
    request<T = unknown>(payload?: unknown, opts?: {
        timeout?: number;
        retries?: number;
    }): Promise<UpstreamResponse<T>>;
    /**
     * Send a fire-and-forget message to upstream
     * @param payload - Payload to send
     */
    send(payload?: unknown): void;
}
/**
 * Context passed to route handlers
 */
interface RowstRouteHandlerContext {
    /**
     * Full Hono context (request, response, params, etc.)
     */
    honoContext: Context;
    /**
     * WebSocket context for upstream communication
     */
    websocketContext: WebSocketContext;
}
/**
 * Route handler function
 */
type RowstHandler = (ctx: RowstRouteHandlerContext) => Promise<Response> | Response;
/**
 * Options for creating a RowstRoute instance
 */
interface RowstRouteOptions {
    /**
     * Hono app instance
     */
    app: {
        get(path: string, handler: (c: Context) => Promise<Response> | Response): void;
        post(path: string, handler: (c: Context) => Promise<Response> | Response): void;
        put(path: string, handler: (c: Context) => Promise<Response> | Response): void;
        delete(path: string, handler: (c: Context) => Promise<Response> | Response): void;
        patch(path: string, handler: (c: Context) => Promise<Response> | Response): void;
        all(path: string, handler: (c: Context) => Promise<Response> | Response): void;
    };
    /**
     * AsyncResolver instance for WebSocket communication
     */
    resolver: AsyncResolver;
}
/**
 * Internal request payload sent to upstream
 */
interface UpstreamRequestPayload {
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
interface UpstreamResponseEnvelope {
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

/**
 * RowstRoute provides an Express-like API for integrating HTTP REST endpoints
 * with WebSocket event handlers via AsyncResolver.
 *
 * @example
 * ```typescript
 * const app = new Hono();
 * const resolver = new AsyncResolver(transport);
 * const routes = new RowstRoute({ app, resolver });
 *
 * routes.post(
 *   { rest: "/api/comments", event: "get_comment" },
 *   async ({ honoContext, websocketContext }) => {
 *     const data = await honoContext.req.json();
 *     const result = await websocketContext.request(data);
 *     return honoContext.json(result.data, result.status);
 *   }
 * );
 * ```
 */
declare class RowstRoute {
    private readonly app;
    private readonly resolver;
    constructor(options: RowstRouteOptions);
    /**
     * Register a GET route
     */
    get(config: RowstRouteConfig, handler: RowstHandler): void;
    /**
     * Register a POST route
     */
    post(config: RowstRouteConfig, handler: RowstHandler): void;
    /**
     * Register a PUT route
     */
    put(config: RowstRouteConfig, handler: RowstHandler): void;
    /**
     * Register a DELETE route
     */
    delete(config: RowstRouteConfig, handler: RowstHandler): void;
    /**
     * Register a PATCH route
     */
    patch(config: RowstRouteConfig, handler: RowstHandler): void;
    /**
     * Register a route for all HTTP methods
     */
    all(config: RowstRouteConfig, handler: RowstHandler): void;
    /**
     * Internal method to register a route with the Hono app
     */
    private registerRoute;
    /**
     * Create a WebSocket context for the current request
     */
    private createWebSocketContext;
    /**
     * Build the request payload to send to upstream
     */
    private buildRequestPayload;
    /**
     * Parse the response from upstream into a structured format
     */
    private parseResponse;
}

export { type RowstHandler, RowstRoute, type RowstRouteConfig, type RowstRouteHandlerContext, type RowstRouteOptions, type UpstreamRequestPayload, type UpstreamResponse, type UpstreamResponseEnvelope, type WebSocketContext };
