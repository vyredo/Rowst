import type { RowstRouter } from "../RowstRouter.js";
import type { HttpRequest } from "../types.js";

/**
 * Adapter for Express framework.
 * Note: This file does NOT import Express directly.
 * Users must have Express installed as a peer dependency.
 */
type ExpressApp = any;
type ExpressRequest = any;
type ExpressResponse = any;

export class ExpressAdapter {
	constructor(private readonly router: RowstRouter) {}

	/** Register the router to an Express app. */
	register(app: ExpressApp, pattern: string = "/*"): void {
		if (!app || typeof app.all !== "function") {
			throw new Error(
				"ExpressAdapter.register expects an Express app instance with an .all() method",
			);
		}

		app.all(pattern, async (req: ExpressRequest, res: ExpressResponse) => {
			try {
				const request = this.toHttpRequest(req);
				const response = await this.router.handle(request);
				this.toExpressResponse(response, res);
			} catch (error) {
				res.status(500).json({
					error: "Internal server error",
					message: error instanceof Error ? error.message : "Unknown error",
				});
			}
		});
	}

	/** Convert Express request to normalized HttpRequest. */
	private toHttpRequest(req: ExpressRequest): HttpRequest {
		const rawUrl: string = req.originalUrl || req.url || "";
		const qIndex = rawUrl.indexOf("?");
		const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
		const query = qIndex >= 0 ? rawUrl.slice(qIndex) : "";

		// Normalize headers to Record<string, string>
		const headers: Record<string, string> = {};
		const srcHeaders = req.headers as Record<
			string,
			string | string[] | undefined
		>;
		for (const [k, v] of Object.entries(srcHeaders)) {
			if (typeof v === "string") headers[k] = v;
			else if (Array.isArray(v)) headers[k] = v.join(", ");
		}

		return {
			method: req.method,
			path,
			query,
			headers,
			body: req.body,
		};
	}

	/** Send HttpResponse via Express response object. */
	private toExpressResponse(
		response: { status: number; headers: Record<string, string>; body: string },
		res: ExpressResponse,
	): void {
		for (const [key, value] of Object.entries(response.headers)) {
			if (typeof value === "string") {
				res.setHeader(key, value);
			}
		}
		res.status(response.status).send(response.body);
	}
}
