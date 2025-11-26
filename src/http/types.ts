// Rowst HTTP module types

// HTTP methods supported by the router.
export type HttpMethod =
	| "GET"
	| "POST"
	| "PUT"
	| "DELETE"
	| "PATCH"
	| "HEAD"
	| "OPTIONS"
	| "ALL";

// Route configuration for registering HTTP→WS mappings.
export interface RouteConfig {
	// Express-style path pattern with parameters.
	// Examples: "/users/:id", "/posts/:postId/comments/:commentId"
	path: string;
	// WebSocket event name to send to upstream handler.
	// This will be included in the request payload as `meta.event`.
	event: string;
	// HTTP method(s) to match. Use 'ALL' to match any method.
	// @default 'ALL'
	method?: HttpMethod;
	// Request timeout in milliseconds. Overrides AsyncResolver's default timeout for this route.
	timeout?: number;
	// Custom metadata to attach to requests for this route.
	meta?: Record<string, unknown>;
}

// Normalized HTTP request representation (framework-agnostic).
export interface HttpRequest {
	method: string;
	path: string;
	query: string; // Raw query string including "?" if present
	headers: Record<string, string>;
	body?: unknown; // Parsed body (JSON object, string, or undefined)
}

// Normalized HTTP response representation.
export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: string; // Response body as string
}

// Upstream WebSocket response payload format.
// This is what upstream handlers should send back.
export interface UpstreamResponse {
	status?: number; // HTTP status code (default: 200)
	headers?: Record<string, string>; // Response headers
	bodyText?: string; // Response body as text
	body?: unknown; // Alternative: structured body (will be JSON.stringify'd)
}

// Compiled route with regex and parameter extraction info.
export interface CompiledRoute extends RouteConfig {
	pathRegex: RegExp;
	paramNames: string[];
}

// Result of matching a request to a route.
export interface RouteMatch {
	route: CompiledRoute;
	params: Record<string, string>; // Extracted path parameters
}

// Options for RowstRouter.
export interface RowstRouterOptions {
	// Default timeout for all routes (can be overridden per route).
	// @default 15000
	defaultTimeout?: number;
	// Prefix to add to all registered routes.
	// Example: "/api" → routes become "/api/users/:id"
	prefix?: string;
	// Custom error handler for when routes throw errors.
	onError?: (error: unknown, request: HttpRequest) => HttpResponse;
	// Hook called before forwarding request to WebSocket. Can modify the request or throw to abort.
	beforeRequest?: (
		request: HttpRequest,
		match: RouteMatch | null,
	) => void | Promise<void>;
	// Hook called after receiving response from WebSocket. Can modify the response before returning to client.
	afterResponse?: (
		response: HttpResponse,
		request: HttpRequest,
	) => void | Promise<void>;
}

// Request payload sent to upstream WebSocket handler.
export interface UpstreamRequestPayload {
	method: string;
	path: string;
	query: string;
	headers: Record<string, string>;
	body?: unknown;
	params?: Record<string, string>; // Extracted path parameters (if route matched)
	event?: string; // WebSocket event name (if route matched)
}
