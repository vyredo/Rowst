import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RowstRoute } from "../../src/express/RowstRoute.js";
import { MockAsyncResolver } from "../mocks/MockAsyncResolver.js";
import { MockWebSocketTransport } from "../mocks/MockWebSocketTransport.js";

describe("RowstRoute", () => {
	let app: Hono;
	let mockTransport: MockWebSocketTransport;
	let mockResolver: MockAsyncResolver;
	let routes: RowstRoute;

	beforeEach(() => {
		app = new Hono();
		mockTransport = new MockWebSocketTransport();
		mockResolver = new MockAsyncResolver(mockTransport);
		routes = new RowstRoute({ app, resolver: mockResolver as any });
	});

	afterEach(() => {
		mockTransport.close();
	});

	describe("HTTP Method Registration", () => {
		it("should register POST route", async () => {
			routes.post(
				{ rest: "/api/test", event: "test_event" },
				async ({ honoContext }) => honoContext.json({ ok: true }),
			);

			const res = await app.request("/api/test", { method: "POST" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		});

		it("should register GET route with path parameters", async () => {
			routes.get(
				{ rest: "/api/users/:id", event: "get_user" },
				async ({ honoContext }) => {
					const id = honoContext.req.param("id");
					return honoContext.json({ userId: id });
				},
			);

			const res = await app.request("/api/users/123");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ userId: "123" });
		});

		it("should register ALL methods", async () => {
			routes.all(
				{ rest: "/api/wildcard", event: "any_event" },
				async ({ honoContext }) =>
					honoContext.json({ method: honoContext.req.method }),
			);

			for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
				const res = await app.request("/api/wildcard", { method });
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ method });
			}
		});

		it("should register PUT route", async () => {
			routes.put(
				{ rest: "/api/update", event: "update_event" },
				async ({ honoContext }) => honoContext.json({ updated: true }),
			);

			const res = await app.request("/api/update", { method: "PUT" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ updated: true });
		});

		it("should register DELETE route", async () => {
			routes.delete(
				{ rest: "/api/delete", event: "delete_event" },
				async ({ honoContext }) => honoContext.json({ deleted: true }),
			);

			const res = await app.request("/api/delete", { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ deleted: true });
		});

		it("should register PATCH route", async () => {
			routes.patch(
				{ rest: "/api/patch", event: "patch_event" },
				async ({ honoContext }) => honoContext.json({ patched: true }),
			);

			const res = await app.request("/api/patch", { method: "PATCH" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ patched: true });
		});
	});

	describe("WebSocket Context", () => {
		it("should forward request to upstream and return response", async () => {
			mockResolver.mockResponse({
				status: 200,
				headers: { "content-type": "application/json" },
				bodyText: JSON.stringify({ result: "success" }),
			});

			routes.post(
				{ rest: "/api/forward", event: "forward_event" },
				async ({ honoContext, websocketContext }) => {
					const result = await websocketContext.request({ test: "data" });
					return honoContext.json(result.data);
				},
			);

			const res = await app.request("/api/forward", {
				method: "POST",
				body: JSON.stringify({ test: "data" }),
				headers: { "content-type": "application/json" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ result: "success" });
			expect(mockTransport.sentMessages).toHaveLength(1);
		});

		it("should handle upstream timeout", async () => {
			mockResolver.mockTimeout();

			routes.post(
				{ rest: "/api/timeout", event: "timeout_event", timeoutMs: 100 },
				async ({ honoContext, websocketContext }) => {
					try {
						await websocketContext.request();
						return honoContext.json({ ok: true });
					} catch (error) {
						return honoContext.json({ error: "timeout" }, 504);
					}
				},
			);

			const res = await app.request("/api/timeout", { method: "POST" });
			expect(res.status).toBe(504);
			expect(await res.json()).toEqual({ error: "timeout" });
		});

		it("should handle disconnected upstream", async () => {
			mockTransport.disconnect();

			routes.post(
				{ rest: "/api/disconnected", event: "test_event" },
				async ({ honoContext, websocketContext }) => {
					if (!websocketContext.connected) {
						return honoContext.json({ error: "service unavailable" }, 503);
					}
					return honoContext.json({ ok: true });
				},
			);

			const res = await app.request("/api/disconnected", { method: "POST" });
			expect(res.status).toBe(503);
		});

		it("should support fire-and-forget send", async () => {
			routes.post(
				{ rest: "/api/fire-forget", event: "analytics" },
				async ({ honoContext, websocketContext }) => {
					websocketContext.send({ action: "log_event" });
					return honoContext.json({ ok: true });
				},
			);

			const res = await app.request("/api/fire-forget", { method: "POST" });
			expect(res.status).toBe(200);
			expect(mockTransport.sentMessages).toHaveLength(1);
		});

		it("should check connection state", async () => {
			routes.get(
				{ rest: "/api/status", event: "status_event" },
				async ({ honoContext, websocketContext }) => {
					return honoContext.json({ connected: websocketContext.connected });
				},
			);

			const res = await app.request("/api/status");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ connected: true });

			mockTransport.disconnect();
			const res2 = await app.request("/api/status");
			expect(await res2.json()).toEqual({ connected: false });
		});
	});

	describe("Request Payload Building", () => {
		it("should extract HTTP method, path, and query params", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: "{}",
			});

			routes.get(
				{ rest: "/api/extract", event: "extract_event" },
				async ({ websocketContext }) => {
					await websocketContext.request();
					return new Response(null, { status: 204 });
				},
			);

			await app.request("/api/extract?foo=bar&baz=qux");

			expect(mockTransport.sentMessages).toHaveLength(1);
			const payload = mockTransport.sentMessages[0].payload as any;
			expect(payload.method).toBe("GET");
			expect(payload.path).toBe("/api/extract");
			expect(payload.query).toBe("?foo=bar&baz=qux");
		});

		it("should extract JSON body from POST request", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: "{}",
			});

			routes.post(
				{ rest: "/api/json", event: "json_event" },
				async ({ websocketContext }) => {
					await websocketContext.request();
					return new Response(null, { status: 204 });
				},
			);

			await app.request("/api/json", {
				method: "POST",
				body: JSON.stringify({ key: "value" }),
				headers: { "content-type": "application/json" },
			});

			expect(mockTransport.sentMessages).toHaveLength(1);
			const payload = mockTransport.sentMessages[0].payload as any;
			expect(payload.body).toEqual({ key: "value" });
		});

		it("should override body when provided to request()", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: "{}",
			});

			routes.post(
				{ rest: "/api/override", event: "override_event" },
				async ({ websocketContext }) => {
					await websocketContext.request({ overridden: true });
					return new Response(null, { status: 204 });
				},
			);

			await app.request("/api/override", {
				method: "POST",
				body: JSON.stringify({ original: true }),
				headers: { "content-type": "application/json" },
			});

			expect(mockTransport.sentMessages).toHaveLength(1);
			const payload = mockTransport.sentMessages[0].payload as any;
			expect(payload.body).toEqual({ overridden: true });
		});

		it("should include event in payload", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: "{}",
			});

			routes.post(
				{ rest: "/api/event", event: "custom_event" },
				async ({ websocketContext }) => {
					await websocketContext.request();
					return new Response(null, { status: 204 });
				},
			);

			await app.request("/api/event", { method: "POST" });

			expect(mockTransport.sentMessages).toHaveLength(1);
			const payload = mockTransport.sentMessages[0].payload as any;
			expect(payload.event).toBe("custom_event");
		});
	});

	describe("Response Handling", () => {
		it("should parse JSON response body", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: JSON.stringify({ parsed: true }),
			});

			routes.get(
				{ rest: "/api/parse", event: "parse_event" },
				async ({ honoContext, websocketContext }) => {
					const result = await websocketContext.request();
					return honoContext.json({ data: result.data });
				},
			);

			const res = await app.request("/api/parse");
			expect(await res.json()).toEqual({ data: { parsed: true } });
		});

		it("should handle non-JSON response body", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: "plain text",
			});

			routes.get(
				{ rest: "/api/text", event: "text_event" },
				async ({ honoContext, websocketContext }) => {
					const result = await websocketContext.request();
					return honoContext.text(result.bodyText);
				},
			);

			const res = await app.request("/api/text");
			expect(await res.text()).toBe("plain text");
		});

		it("should preserve HTTP status codes", async () => {
			mockResolver.mockResponse({
				status: 404,
				bodyText: JSON.stringify({ error: "not found" }),
			});

			routes.get(
				{ rest: "/api/status", event: "status_event" },
				async ({ honoContext, websocketContext }) => {
					const result = await websocketContext.request();
					return honoContext.json(result.data, result.status as any);
				},
			);

			const res = await app.request("/api/status");
			expect(res.status).toBe(404);
		});

		it("should handle response without envelope structure", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: JSON.stringify({ direct: "data" }),
			});

			routes.get(
				{ rest: "/api/direct", event: "direct_event" },
				async ({ honoContext, websocketContext }) => {
					const result = await websocketContext.request();
					return honoContext.json(result.data);
				},
			);

			const res = await app.request("/api/direct");
			expect(res.status).toBe(200);
		});
	});

	describe("Error Handling", () => {
		it("should handle resolver errors gracefully", async () => {
			mockResolver.mockError(new Error("Connection failed"));

			routes.post(
				{ rest: "/api/error", event: "error_event" },
				async ({ honoContext, websocketContext }) => {
					try {
						await websocketContext.request();
						return honoContext.json({ ok: true });
					} catch (error: any) {
						return honoContext.json({ error: error.message }, 500);
					}
				},
			);

			const res = await app.request("/api/error", { method: "POST" });
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ error: "Connection failed" });
		});

		it("should support retry logic", async () => {
			let attemptCount = 0;
			mockResolver.mockDynamicResponse(() => {
				attemptCount++;
				if (attemptCount < 3) {
					throw new Error("Temporary failure");
				}
				return {
					status: 200,
					bodyText: JSON.stringify({ success: true, attempts: attemptCount }),
				};
			});

			routes.post(
				{ rest: "/api/retry", event: "retry_event" },
				async ({ honoContext, websocketContext }) => {
					const result = await websocketContext.request(undefined, {
						retries: 2,
						timeout: 1000,
					});
					return honoContext.json(result.data);
				},
			);

			const res = await app.request("/api/retry", { method: "POST" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ success: true, attempts: 3 });
		});
	});

	describe("Integration with Real Upstream", () => {
		it("should handle real comment retrieval flow", async () => {
			// Mock upstream response matching actual backend format
			mockResolver.mockResponse({
				status: 200,
				bodyText: JSON.stringify({
					type: "get_comment_response",
					data: {
						comments: [
							{ id: "1", text: "Test comment", author: "User1" },
							{ id: "2", text: "Another comment", author: "User2" },
						],
						total: 2,
					},
				}),
			});

			routes.post(
				{ rest: "/scrape/api/comments", event: "get_comment" },
				async ({ honoContext, websocketContext }) => {
					const { postUrl, limit, offset } = await honoContext.req.json();

					const result = await websocketContext.request({
						postUrl,
						limit,
						offset,
					});

					return honoContext.json(result.data);
				},
			);

			const res = await app.request("/scrape/api/comments", {
				method: "POST",
				body: JSON.stringify({
					postUrl: "https://facebook.com/post/123",
					limit: 50,
					offset: 0,
				}),
				headers: { "content-type": "application/json" },
			});

			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json.data.comments).toHaveLength(2);
			expect(json.data.total).toBe(2);
		});

		it("should handle scrape job creation", async () => {
			mockResolver.mockResponse({
				status: 201,
				bodyText: JSON.stringify({ jobId: "job-123", status: "pending" }),
			});

			routes.post(
				{ rest: "/scrape/api/jobs", event: "start_scrape", timeoutMs: 5000 },
				async ({ honoContext, websocketContext }) => {
					const { postUrl, depth = 1 } = await honoContext.req.json();

					if (!postUrl || !postUrl.startsWith("https://facebook.com")) {
						return honoContext.json({ error: "Invalid Facebook URL" }, 400);
					}

					if (!websocketContext.connected) {
						return honoContext.json(
							{ error: "Scraper service unavailable" },
							503,
						);
					}

					const result = await websocketContext.request({
						postUrl,
						depth,
						priority: "normal",
					});

					return honoContext.json(result.data, result.status as any);
				},
			);

			const res = await app.request("/scrape/api/jobs", {
				method: "POST",
				body: JSON.stringify({
					postUrl: "https://facebook.com/post/456",
					depth: 2,
				}),
				headers: { "content-type": "application/json" },
			});

			expect(res.status).toBe(201);
			const json = await res.json();
			expect(json.jobId).toBe("job-123");
		});
	});

	describe("Route Configuration", () => {
		it("should use route-specific timeout", async () => {
			mockResolver.mockTimeout();

			routes.post(
				{ rest: "/api/custom-timeout", event: "test", timeoutMs: 50 },
				async ({ honoContext, websocketContext }) => {
					try {
						await websocketContext.request();
						return honoContext.json({ ok: true });
					} catch {
						return honoContext.json({ error: "timeout" }, 504);
					}
				},
			);

			const res = await app.request("/api/custom-timeout", { method: "POST" });
			expect(res.status).toBe(504);
		});

		it("should handle multiple routes with same path but different methods", async () => {
			mockResolver.mockResponse({
				status: 200,
				bodyText: JSON.stringify({ method: "GET" }),
			});

			routes.get(
				{ rest: "/api/multi", event: "get_event" },
				async ({ honoContext }) => honoContext.json({ method: "GET" }),
			);

			routes.post(
				{ rest: "/api/multi", event: "post_event" },
				async ({ honoContext }) => honoContext.json({ method: "POST" }),
			);

			const getRes = await app.request("/api/multi", { method: "GET" });
			expect(await getRes.json()).toEqual({ method: "GET" });

			const postRes = await app.request("/api/multi", { method: "POST" });
			expect(await postRes.json()).toEqual({ method: "POST" });
		});
	});
});
