import type { Context as HonoContext } from "hono";
import type { AsyncResolver } from "../core/AsyncResolver.js";
import type { Message } from "../core/types.js";
import type {
	RowstHandler,
	RowstRouteConfig,
	RowstRouteHandlerContext,
	RowstRouteOptions,
	UpstreamRequestPayload,
	UpstreamResponse,
	UpstreamResponseEnvelope,
	WebSocketContext,
} from "./types.js";

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
export class RowstRoute {
	private readonly app: RowstRouteOptions["app"];
	private readonly resolver: AsyncResolver;

	constructor(options: RowstRouteOptions) {
		this.app = options.app;
		this.resolver = options.resolver;
	}

	/**
	 * Register a GET route
	 */
	get(config: RowstRouteConfig, handler: RowstHandler): void {
		this.registerRoute("GET", config, handler);
	}

	/**
	 * Register a POST route
	 */
	post(config: RowstRouteConfig, handler: RowstHandler): void {
		this.registerRoute("POST", config, handler);
	}

	/**
	 * Register a PUT route
	 */
	put(config: RowstRouteConfig, handler: RowstHandler): void {
		this.registerRoute("PUT", config, handler);
	}

	/**
	 * Register a DELETE route
	 */
	delete(config: RowstRouteConfig, handler: RowstHandler): void {
		this.registerRoute("DELETE", config, handler);
	}

	/**
	 * Register a PATCH route
	 */
	patch(config: RowstRouteConfig, handler: RowstHandler): void {
		this.registerRoute("PATCH", config, handler);
	}

	/**
	 * Register a route for all HTTP methods
	 */
	all(config: RowstRouteConfig, handler: RowstHandler): void {
		this.registerRoute("ALL", config, handler);
	}

	/**
	 * Internal method to register a route with the Hono app
	 */
	private registerRoute(
		method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL",
		config: RowstRouteConfig,
		handler: RowstHandler,
	): void {
		const honoHandler = async (honoContext: HonoContext): Promise<Response> => {
			const websocketContext = this.createWebSocketContext(honoContext, config);

			const ctx: RowstRouteHandlerContext = {
				honoContext,
				websocketContext,
			};

			return handler(ctx);
		};

		// Register with Hono based on method
		switch (method) {
			case "GET":
				this.app.get(config.rest, honoHandler);
				break;
			case "POST":
				this.app.post(config.rest, honoHandler);
				break;
			case "PUT":
				this.app.put(config.rest, honoHandler);
				break;
			case "DELETE":
				this.app.delete(config.rest, honoHandler);
				break;
			case "PATCH":
				this.app.patch(config.rest, honoHandler);
				break;
			case "ALL":
				this.app.all(config.rest, honoHandler);
				break;
		}
	}

	/**
	 * Create a WebSocket context for the current request
	 */
	private createWebSocketContext(
		honoContext: HonoContext,
		config: RowstRouteConfig,
	): WebSocketContext {
		return {
			connected: this.resolver.isReady(),

			request: async <T = unknown>(
				payload?: unknown,
				opts?: { timeout?: number; retries?: number },
			): Promise<UpstreamResponse<T>> => {
				// Build the request payload
				const requestPayload = await this.buildRequestPayload(
					honoContext,
					config.event,
					payload,
				);

				// Determine timeout
				const timeout = opts?.timeout ?? config.timeoutMs;

				// Make the request
				let message: Message<unknown>;
				if (opts?.retries !== undefined && opts.retries > 0) {
					message = await this.resolver.requestWithRetry(requestPayload, {
						timeout,
						retries: opts.retries,
						meta: { event: config.event },
					});
				} else {
					message = await this.resolver.request(requestPayload, {
						timeout,
						meta: { event: config.event },
					});
				}

				// Parse the response
				return this.parseResponse<T>(message);
			},

			send: (payload?: unknown): void => {
				// Build payload for fire-and-forget
				const notificationPayload: Record<string, unknown> = {
					event: config.event,
					method: honoContext.req.method,
					path: honoContext.req.path,
				};

				if (payload !== undefined) {
					notificationPayload.data = payload;
				}

				this.resolver.notify(notificationPayload);
			},
		};
	}

	/**
	 * Build the request payload to send to upstream
	 */
	private async buildRequestPayload(
		honoContext: HonoContext,
		event: string,
		overridePayload?: unknown,
	): Promise<UpstreamRequestPayload> {
		const method = honoContext.req.method;
		const path = honoContext.req.path;
		const url = new URL(honoContext.req.url);
		const query = url.search || undefined;

		// Extract headers
		const headers: Record<string, string> = {};
		honoContext.req.raw.headers.forEach((value, key) => {
			headers[key] = value;
		});

		// Extract body if present and not overridden
		let body: unknown = undefined;
		if (overridePayload !== undefined) {
			body = overridePayload;
		} else if (
			method !== "GET" &&
			method !== "HEAD" &&
			headers["content-type"]?.includes("application/json")
		) {
			try {
				body = await honoContext.req.json();
			} catch {
				// If JSON parsing fails, leave body undefined
			}
		}

		return {
			method,
			path,
			query,
			headers,
			body,
			event,
		};
	}

	/**
	 * Parse the response from upstream into a structured format
	 */
	private parseResponse<T>(message: Message<unknown>): UpstreamResponse<T> {
		const payload = message.payload as UpstreamResponseEnvelope | unknown;

		// Check if payload matches the expected envelope structure with body/bodyText
		if (
			payload &&
			typeof payload === "object" &&
			"status" in payload &&
			typeof (payload as UpstreamResponseEnvelope).status === "number"
		) {
			const envelope = payload as UpstreamResponseEnvelope;

			// Handle both 'body' and 'bodyText' fields
			const bodyText = envelope.body ?? (envelope as any).bodyText ?? "";
			let data: T | undefined;

			// Try to parse JSON body
			if (bodyText) {
				try {
					data = JSON.parse(bodyText) as T;
				} catch {
					// Not JSON, leave data undefined
				}
			}

			return {
				status: envelope.status,
				headers: envelope.headers ?? {},
				bodyText,
				data,
				message,
			};
		}

		// Fallback: treat entire payload as data
		return {
			status: 200,
			headers: { "content-type": "application/json" },
			bodyText: JSON.stringify(payload),
			data: payload as T,
			message,
		};
	}
}
