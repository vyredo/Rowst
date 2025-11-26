import { A as AsyncResolver, M as Message } from '../AsyncResolver-DptVIjek.js';
import '../logger-CBj8alH5.js';

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "ALL";
interface RouteConfig {
    path: string;
    event: string;
    method?: HttpMethod;
    timeout?: number;
    meta?: Record<string, unknown>;
}
interface HttpRequest {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    body?: unknown;
}
interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}
interface UpstreamResponse {
    status?: number;
    headers?: Record<string, string>;
    bodyText?: string;
    body?: unknown;
}
interface CompiledRoute extends RouteConfig {
    pathRegex: RegExp;
    paramNames: string[];
}
interface RouteMatch {
    route: CompiledRoute;
    params: Record<string, string>;
}
interface RowstRouterOptions {
    defaultTimeout?: number;
    prefix?: string;
    onError?: (error: unknown, request: HttpRequest) => HttpResponse;
    beforeRequest?: (request: HttpRequest, match: RouteMatch | null) => void | Promise<void>;
    afterResponse?: (response: HttpResponse, request: HttpRequest) => void | Promise<void>;
}
interface UpstreamRequestPayload {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    body?: unknown;
    params?: Record<string, string>;
    event?: string;
}

/**
 * Framework-agnostic HTTP-to-WebSocket router.
 * Matches HTTP requests to routes and forwards them to upstream WebSocket handlers.
 */
declare class RowstRouter {
    private readonly resolver;
    private readonly routes;
    private readonly options;
    private readonly beforeRequest?;
    private readonly afterResponse?;
    private readonly onError?;
    constructor(resolver: AsyncResolver, options?: RowstRouterOptions);
    /** Register a route. */
    register(config: RouteConfig): void;
    /** Register a GET route. */
    get(path: string, event: string, options?: Partial<RouteConfig>): void;
    /** Register a POST route. */
    post(path: string, event: string, options?: Partial<RouteConfig>): void;
    /** Register a PUT route. */
    put(path: string, event: string, options?: Partial<RouteConfig>): void;
    /** Register a DELETE route. */
    delete(path: string, event: string, options?: Partial<RouteConfig>): void;
    /** Register a PATCH route. */
    patch(path: string, event: string, options?: Partial<RouteConfig>): void;
    /** Register a route that matches all HTTP methods. */
    all(path: string, event: string, options?: Partial<RouteConfig>): void;
    /**
     * Handle an incoming HTTP request.
     * Matches against registered routes and forwards to upstream WebSocket.
     */
    handle(request: HttpRequest): Promise<HttpResponse>;
    /** Match an HTTP request to a registered route. */
    private match;
    /** Handle errors during request processing. */
    private handleError;
    /** Get all registered routes (for debugging/introspection). */
    getRoutes(): Array<{
        method: string;
        path: string;
        event: string;
    }>;
}

/**
 * Adapter for Express framework.
 * Note: This file does NOT import Express directly.
 * Users must have Express installed as a peer dependency.
 */
type ExpressApp = any;
declare class ExpressAdapter {
    private readonly router;
    constructor(router: RowstRouter);
    /** Register the router to an Express app. */
    register(app: ExpressApp, pattern?: string): void;
    /** Convert Express request to normalized HttpRequest. */
    private toHttpRequest;
    /** Send HttpResponse via Express response object. */
    private toExpressResponse;
}

/**
 * Adapter for Fastify framework.
 * Note: This file does NOT import Fastify directly.
 * Users must have Fastify installed as a peer dependency.
 */
type FastifyInstance = any;
declare class FastifyAdapter {
    private readonly router;
    constructor(router: RowstRouter);
    /** Register the router to a Fastify instance. */
    register(fastify: FastifyInstance): Promise<void>;
    /** Convert Fastify request to normalized HttpRequest. */
    private toHttpRequest;
    /** Send HttpResponse via Fastify reply object. */
    private toFastifyResponse;
}

/**
 * Adapter for Hono framework.
 * Note: This file does NOT import Hono directly to avoid adding it as a dependency.
 * Users must have Hono installed as a peer dependency.
 */
type HonoApp = any;
declare class HonoAdapter {
    private readonly router;
    constructor(router: RowstRouter);
    /** Register the router to a Hono app. Creates a catch-all route handler. */
    register(app: HonoApp, pattern?: string): void;
    /** Convert Hono context to normalized HttpRequest. */
    private toHttpRequest;
    /** Convert HttpResponse to Hono Response. */
    private toHonoResponse;
}

/**
 * Parses Rowst Message responses from upstream into HTTP responses.
 */
declare class ResponseParser {
    /**
     * Parse a Rowst message payload into an HTTP response.
     * Handles multiple payload formats for flexibility.
     */
    static parse(message: Message<unknown>): HttpResponse;
    private static extractStatus;
    private static extractHeaders;
    private static extractBody;
    /** Create an error response. */
    static error(status: number, message: string, details?: unknown): HttpResponse;
}

/**
 * Compiles Express-style path patterns into regex for matching:
 *  - Named params: /users/:id
 *  - Multiple params: /posts/:postId/comments/:commentId
 *  - Wildcards: /files/*
 *  - Optional segments: /posts/:id? (slash+segment optional)
 */
declare class RouteCompiler {
    /** Compile a route config into a CompiledRoute with regex and param extraction. */
    static compile(config: RouteConfig): CompiledRoute;
    /** Convert Express-style path pattern to regex. */
    private static compilePath;
    /** Extract parameter values from a path using compiled route. */
    static extractParams(path: string, compiledRoute: CompiledRoute): Record<string, string> | null;
}

export { type CompiledRoute, ExpressAdapter, FastifyAdapter, HonoAdapter, type HttpMethod, type HttpRequest, type HttpResponse, ResponseParser, RouteCompiler, type RouteConfig, type RouteMatch, RowstRouter, type RowstRouterOptions, type UpstreamRequestPayload, type UpstreamResponse };
