import type { RowstRouter } from "../RowstRouter.js";
import type { HttpRequest } from "../types.js";

/**
 * Adapter for Fastify framework.
 * Note: This file does NOT import Fastify directly.
 * Users must have Fastify installed as a peer dependency.
 */
type FastifyInstance = any;
type FastifyRequest = any;
type FastifyReply = any;

export class FastifyAdapter {
	constructor(private readonly router: RowstRouter) {}

	/** Register the router to a Fastify instance. */
	async register(fastify: FastifyInstance): Promise<void> {
		if (!fastify || typeof fastify.all !== "function") {
			throw new Error(
				"FastifyAdapter.register expects a Fastify instance with an .all() method",
			);
		}

		fastify.all("/*", async (request: FastifyRequest, reply: FastifyReply) => {
			try {
				const httpRequest = await this.toHttpRequest(request);
				const response = await this.router.handle(httpRequest);
				await this.toFastifyResponse(response, reply);
			} catch (error) {
				reply.status(500).send({
					error: "Internal server error",
					message: error instanceof Error ? error.message : "Unknown error",
				});
			}
		});
	}

	/** Convert Fastify request to normalized HttpRequest. */
	private async toHttpRequest(req: FastifyRequest): Promise<HttpRequest> {
		const rawUrl: string = req.url || "";
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

		// Fastify parses body when content-type is JSON and body parser is enabled
		const body = (req as any).body;

		return {
			method: req.method,
			path,
			query,
			headers,
			body,
		};
	}

	/** Send HttpResponse via Fastify reply object. */
	private async toFastifyResponse(
		response: { status: number; headers: Record<string, string>; body: string },
		reply: FastifyReply,
	): Promise<void> {
		for (const [key, value] of Object.entries(response.headers)) {
			if (typeof value === "string") {
				reply.header(key, value);
			}
		}
		reply.status(response.status).send(response.body);
	}
}
