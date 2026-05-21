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
 * Origin of the request
 */
type Origin = "http" | "ws";
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
     * Send a fire-and-forget message to upstream (HTTP origin)
     * OR respond directly to the current WS request (WS origin)
     * @param payload - Payload to send
     * @param init - Optional status and headers (WS origin only)
     */
    send(payload?: unknown, init?: {
        status?: number;
        headers?: Record<string, string>;
    }): void;
}
/**
 * Unified context for route handlers (works for both HTTP and WS)
 */
interface RowstRouteContext {
    /**
     * Origin of the request: "http" or "ws"
     */
    origin: Origin;
    /**
     * Optional convenience flags/metadata (additive)
     */
    forwardingHttp?: boolean;
    meta?: {
        requestId?: string;
        forwarded?: boolean;
        transport?: "ws";
    };
    /**
     * Unified input: parse request body
     * - HTTP: reads from honoContext.req.json() with fallback
     * - WS: returns payload.body ?? payload
     */
    body<T = unknown>(): Promise<T>;
    /**
     * Unified output: send JSON response
     * - HTTP: returns a Response object
     * - WS: sends Rowst response envelope and returns void
     */
    json(data: unknown, init?: {
        status?: number;
        headers?: Record<string, string>;
    }): Response | void;
    /**
     * Unified output: send text response
     * - HTTP: returns a Response object
     * - WS: sends Rowst response envelope and returns void
     */
    text(body: string, init?: {
        status?: number;
        headers?: Record<string, string>;
    }): Response | void;
    /**
     * Set status code for next json/text call (sticky)
     */
    status(code: number): void;
    /**
     * Request headers (normalized)
     */
    headers: Record<string, string>;
    /**
     * Query string (including leading ?)
     */
    query: string;
    /**
     * URL parameters
     */
    params: Record<string, string>;
    /**
     * Send a fire-and-forget notification
     */
    notify(payload: unknown): void;
    /**
     * Forward request to upstream and await response
     */
    forward<T = unknown>(payload?: unknown, opts?: {
        timeout?: number;
        retries?: number;
    }): Promise<T>;
    /**
     * Internal: Full Hono context (for advanced use cases)
     * @internal
     */
    _honoContext: Context;
    /**
     * Internal: WebSocket context (for advanced use cases)
     * @internal
     */
    _websocketContext: WebSocketContext;
    /**
     * Optional non-underscored aliases for convenience (back-compat helpers)
     */
    honoContext?: Context;
    websocketContext?: WebSocketContext;
}
/**
 * Context passed to route handlers (legacy, for backwards compatibility)
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
 * Route handler function (unified context)
 */
type RowstHandler = (ctx: RowstRouteContext) => Promise<Response | void> | Response | void;
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
 *   async (ctx) => {
 *     const data = await ctx.body();
 *     return ctx.json({ ok: true, origin: ctx.origin });
 *   }
 * );
 * ```
 */
declare class RowstRoute {
    private readonly app;
    private readonly resolver;
    private readonly eventRegistry;
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
     * Create unified context for HTTP origin
     */
    private createHttpContext;
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
    /**
     * Attach a Node-style WebSocket server (e.g., ws.WebSocketServer) to handle
     * Rowst "request" envelopes directly using the SAME registered handlers.
     * Each incoming WS "request" must contain payload.event set to the event name.
     * Replies are sent as Rowst "response" envelopes with the same id.
     */
    attachWebSocketServer(server: {
        on(event: "connection", cb: (socket: any) => void): void;
    }): void;
    /**
     * Create unified context for WebSocket origin
     */
    private createWsContext;
    /** Create a minimal Hono-like context backed by the WS payload */
    private createSyntheticHonoContext;
    /** Convert a Response to an UpstreamResponseEnvelope */
    private responseToEnvelope;
}

export { type RowstHandler, RowstRoute, type RowstRouteConfig, type RowstRouteHandlerContext, type RowstRouteOptions, type UpstreamRequestPayload, type UpstreamResponse, type UpstreamResponseEnvelope, type WebSocketContext };
