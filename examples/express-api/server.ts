import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AsyncResolver, WebSocketTransport } from "rowst";
import { RowstRoute } from "rowst/express";

// Create Hono app
const app = new Hono();

// Setup WebSocket transport and resolver
const transport = new WebSocketTransport("ws://localhost:8080");
const resolver = new AsyncResolver(transport);

// Create RowstRoute instance
const routes = new RowstRoute({ app, resolver });

// Example 1: Simple GET request
routes.get(
	{ rest: "/api/users/:id", event: "get_user" },
	async ({ honoContext, websocketContext }) => {
		const userId = honoContext.req.param("id");

		try {
			const result = await websocketContext.request({ userId });
			return honoContext.json(result.data, result.status as any);
		} catch (error: any) {
			return honoContext.json({ error: error.message }, 500);
		}
	},
);

// Example 2: POST with validation
routes.post(
	{ rest: "/api/comments", event: "get_comment", timeoutMs: 10000 },
	async ({ honoContext, websocketContext }) => {
		const { postUrl, limit = 50, offset = 0 } = await honoContext.req.json();

		// Validate input
		if (!postUrl) {
			return honoContext.json({ error: "postUrl is required" }, 400);
		}

		// Check connection
		if (!websocketContext.connected) {
			return honoContext.json({ error: "Service unavailable" }, 503);
		}

		try {
			const result = await websocketContext.request<{
				comments: Array<{ id: string; text: string; author: string }>;
				total: number;
			}>({ postUrl, limit, offset });

			// Fire-and-forget analytics
			websocketContext.send({
				event: "analytics",
				action: "comments_requested",
				postUrl,
			});

			return honoContext.json(result.data);
		} catch (error: any) {
			return honoContext.json({ error: error.message }, 500);
		}
	},
);

// Example 3: POST with retry logic
routes.post(
	{ rest: "/api/jobs", event: "start_job", timeoutMs: 5000 },
	async ({ honoContext, websocketContext }) => {
		const { url, depth = 1 } = await honoContext.req.json();

		if (!url || !url.startsWith("https://")) {
			return honoContext.json({ error: "Invalid URL" }, 400);
		}

		try {
			const result = await websocketContext.request(
				{ url, depth, priority: "normal" },
				{ timeout: 5000, retries: 2 },
			);

			return honoContext.json(result.data, result.status as any);
		} catch (error: any) {
			return honoContext.json(
				{ error: "Failed to start job", details: error.message },
				500,
			);
		}
	},
);

// Example 4: Health check endpoint
routes.get(
	{ rest: "/health", event: "ping" },
	async ({ honoContext, websocketContext }) => {
		return honoContext.json({
			status: "ok",
			upstream: websocketContext.connected ? "connected" : "disconnected",
			timestamp: new Date().toISOString(),
		});
	},
);

// Wait for transport to be ready
await resolver.waitForReady({ timeout: 5000 });

console.log("Server starting on http://localhost:3000");
serve({
	fetch: app.fetch,
	port: 3000,
});
