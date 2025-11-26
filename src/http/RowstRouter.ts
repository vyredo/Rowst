import type { AsyncResolver } from "../core/AsyncResolver.js";
import { TimeoutError, TransportClosedError } from "../core/errors.js";
import { ResponseParser } from "./ResponseParser.js";
import { RouteCompiler } from "./RouteCompiler.js";
import type {
	CompiledRoute,
	HttpRequest,
	HttpResponse,
	RouteConfig,
	RouteMatch,
	RowstRouterOptions,
	UpstreamRequestPayload,
} from "./types.js";

const DEFAULT_TIMEOUT = 15_000;

/**
 * Framework-agnostic HTTP-to-WebSocket router.
 * Matches HTTP requests to routes and forwards them to upstream WebSocket handlers.
 */
export class RowstRouter {
	private readonly routes: CompiledRoute[] = [];
	private readonly options: Required<
		Pick<RowstRouterOptions, "defaultTimeout" | "prefix">
	>;
	private readonly beforeRequest?: RowstRouterOptions["beforeRequest"];
	private readonly afterResponse?: RowstRouterOptions["afterResponse"];
	private readonly onError?: RowstRouterOptions["onError"];

	constructor(
		private readonly resolver: AsyncResolver,
		options: RowstRouterOptions = {},
	) {
		this.options = {
			defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
			prefix: options.prefix ?? "",
		};
		this.beforeRequest = options.beforeRequest;
		this.afterResponse = options.afterResponse;
		this.onError = options.onError;
	}

	/** Register a route. */
	register(config: RouteConfig): void {
		const fullPath = this.options.prefix + config.path;
		const compiled = RouteCompiler.compile({ ...config, path: fullPath });
		this.routes.push(compiled);
	}

	/** Register a GET route. */
	get(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "GET", ...options });
	}

	/** Register a POST route. */
	post(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "POST", ...options });
	}

	/** Register a PUT route. */
	put(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "PUT", ...options });
	}

	/** Register a DELETE route. */
	delete(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "DELETE", ...options });
	}

	/** Register a PATCH route. */
	patch(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "PATCH", ...options });
	}

	/** Register a route that matches all HTTP methods. */
	all(path: string, event: string, options?: Partial<RouteConfig>): void {
		this.register({ path, event, method: "ALL", ...options });
	}

	/**
	 * Handle an incoming HTTP request.
	 * Matches against registered routes and forwards to upstream WebSocket.
	 */
	async handle(request: HttpRequest): Promise<HttpResponse> {
		try {
			const match = this.match(request.method, request.path);

			if (this.beforeRequest) {
				await this.beforeRequest(request, match);
			}

			const payload: UpstreamRequestPayload = {
				method: request.method,
				path: request.path,
				query: request.query,
				headers: request.headers,
				body: request.body,
			};

			if (match) {
				payload.params = match.params;
				payload.event = match.route.event;
			}

			const timeout = match?.route.timeout ?? this.options.defaultTimeout;

			const requestOptions: any = { timeout };
			if (match?.route.meta) {
				requestOptions.meta = { ...match.route.meta, event: match.route.event };
			} else if (match) {
				requestOptions.meta = { event: match.route.event };
			}

			const message = await (this.resolver as any).request(
				payload,
				requestOptions,
			);

			let response = ResponseParser.parse(message);

			if (this.afterResponse) {
				await this.afterResponse(response, request);
			}

			return response;
		} catch (error) {
			return this.handleError(error, request);
		}
	}

	/** Match an HTTP request to a registered route. */
	private match(method: string, path: string): RouteMatch | null {
		for (const route of this.routes) {
			const routeMethod = route.method ?? "ALL";
			const methodMatches =
				routeMethod === "ALL" ||
				routeMethod.toUpperCase() === method.toUpperCase();
			if (!methodMatches) continue;

			const params = RouteCompiler.extractParams(path, route);
			if (params !== null) {
				return { route, params };
			}
		}
		return null;
	}

	/** Handle errors during request processing. */
	private handleError(error: unknown, _request: HttpRequest): HttpResponse {
		if (this.onError) {
			try {
				return this.onError(error, _request);
			} catch (handlerError) {
				return ResponseParser.error(500, "Internal server error", {
					original: describeUnknownError(error),
					handlerError: describeUnknownError(handlerError),
				});
			}
		}

		if (error instanceof TimeoutError) {
			return ResponseParser.error(504, "Gateway timeout", {
				message: error.message,
			});
		}
		if (error instanceof TransportClosedError) {
			return ResponseParser.error(503, "Service unavailable", {
				message: "Upstream connection closed",
			});
		}
		if (error instanceof Error) {
			return ResponseParser.error(502, "Bad gateway", {
				message: error.message,
			});
		}
		return ResponseParser.error(500, "Internal server error");
	}

	/** Get all registered routes (for debugging/introspection). */
	getRoutes(): Array<{ method: string; path: string; event: string }> {
		return this.routes.map((r) => ({
			method: r.method ?? "ALL",
			path: r.path,
			event: r.event,
		}));
	}
}

function describeUnknownError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack };
	}
	return { error };
}
