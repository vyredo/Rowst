import type { RowstRouter } from "../RowstRouter.js";
import type { HttpRequest } from "../types.js";

/**
 * Adapter for Hono framework.
 * Note: This file does NOT import Hono directly to avoid adding it as a dependency.
 * Users must have Hono installed as a peer dependency.
 */
type HonoApp = any;
type HonoContext = any;

export class HonoAdapter {
	constructor(private readonly router: RowstRouter) {}

	/** Register the router to a Hono app. Creates a catch-all route handler. */
	register(app: HonoApp, pattern: string = "/*"): void {
		if (!app || typeof app.all !== "function") {
			throw new Error(
				"HonoAdapter.register expects a Hono app instance with an .all() method",
			);
		}
		app.all(pattern, async (c: HonoContext) => {
			const request = await this.toHttpRequest(c);
			const response = await this.router.handle(request);
			return this.toHonoResponse(response);
		});
	}

	/** Convert Hono context to normalized HttpRequest. */
	private async toHttpRequest(c: HonoContext): Promise<HttpRequest> {
		const url = new URL(c.req.url);

		// Headers
		const headers: Record<string, string> = {};
		const rawHeaders = c?.req?.raw?.headers ?? c?.req?.headers;
		if (rawHeaders) {
			try {
				if (typeof rawHeaders.forEach === "function") {
					rawHeaders.forEach((value: string, key: string) => {
						headers[key] = value;
					});
				} else if (typeof (rawHeaders as any)[Symbol.iterator] === "function") {
					for (const [key, value] of rawHeaders as any) {
						headers[String(key)] = String(value);
					}
				}
			} catch {
				// ignore header extraction errors
			}
		}

		// Body
		let body: unknown;
		try {
			const contentType: string =
				(typeof c.req.header === "function"
					? c.req.header("content-type")
					: undefined) ??
				c?.req?.raw?.headers?.get?.("content-type") ??
				"";

			if (contentType.includes("application/json")) {
				body = await c.req.json();
			} else {
				const text = await c.req.text();
				if (text && text.length > 0) {
					try {
						body = JSON.parse(text);
					} catch {
						body = text;
					}
				}
			}
		} catch {
			// leave body undefined on parsing error
		}

		return {
			method: c.req.method,
			path: url.pathname,
			query: url.search,
			headers,
			body,
		};
	}

	/** Convert HttpResponse to Hono Response. */
	private toHonoResponse(response: {
		status: number;
		headers: Record<string, string>;
		body: string;
	}): Response {
		const headers = new Headers();
		for (const [key, value] of Object.entries(response.headers)) {
			if (typeof value === "string") {
				headers.set(key, value);
			}
		}
		return new Response(response.body, { status: response.status, headers });
	}
}
