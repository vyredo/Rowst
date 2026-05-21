import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/core/types.js";
import { RowstRoute } from "../../src/express/RowstRoute.js";
import { MockAsyncResolver } from "../mocks/MockAsyncResolver.js";
import { MockWebSocketTransport } from "../mocks/MockWebSocketTransport.js";

describe("RowstRoute - Unified Context", () => {
	let app: Hono;
	let transport: MockWebSocketTransport;
	let resolver: MockAsyncResolver;
	let routes: RowstRoute;

	beforeEach(() => {
		app = new Hono();
		transport = new MockWebSocketTransport();
		resolver = new MockAsyncResolver(transport);
		routes = new RowstRoute({ app, resolver: resolver as any });
	});

	describe("HTTP Origin", () => {
		it("should handle ctx.body() and ctx.json() for HTTP requests", async () => {
			routes.post({ rest: "/api/test", event: "test_event" }, async (ctx) => {
				expect(ctx.origin).toBe("http");
				const data = await ctx.body<{ message: string }>();
				return ctx.json({ received: data.message, origin: ctx.origin });
			});

			const req = new Request("http://localhost/api/test", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "hello" }),
			});

			const res = await app.fetch(req);
			expect(res.status).toBe(200);

			const json = await res.json();
			expect(json).toEqual({ received: "hello", origin: "http" });
		});

		it("should handle non-JSON body with fallback", async () => {
			routes.post({ rest: "/api/text", event: "text_event" }, async (ctx) => {
				const data = await ctx.body<string>();
				return ctx.json({ received: data, type: typeof data });
			});

			const req = new Request("http://localhost/api/text", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "plain text",
			});

			const res = await app.fetch(req);
			expect(res.status).toBe(200);

			const json = await res.json();
			expect(json.received).toBe("plain text");
		});

		it("should handle ctx.status() sticky behavior", async () => {
			routes.post(
				{ rest: "/api/created", event: "create_event" },
				async (ctx) => {
					ctx.status(201);
					return ctx.json({ created: true });
				},
			);

			const req = new Request("http://localhost/api/created", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});

			const res = await app.fetch(req);
			expect(res.status).toBe(201);
		});

		it("should handle ctx.text() response", async () => {
			routes.get(
				{ rest: "/api/health", event: "health_event" },
				async (ctx) => {
					return ctx.text("OK", { status: 200 });
				},
			);

			const req = new Request("http://localhost/api/health", {
				method: "GET",
			});

			const res = await app.fetch(req);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("OK");
		});

		it("should handle custom headers in response", async () => {
			routes.post(
				{ rest: "/api/custom", event: "custom_event" },
				async (ctx) => {
					return ctx.json(
						{ data: "test" },
						{
							status: 200,
							headers: {
								"x-custom-header": "custom-value",
								"cache-control": "no-cache",
							},
						},
					);
				},
			);

			const req = new Request("http://localhost/api/custom", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});

			const res = await app.fetch(req);
			expect(res.headers.get("x-custom-header")).toBe("custom-value");
			expect(res.headers.get("cache-control")).toBe("no-cache");
		});

		it("should expose headers, query, and params", async () => {
			routes.get({ rest: "/api/users/:id", event: "get_user" }, async (ctx) => {
				return ctx.json({
					headers: ctx.headers,
					query: ctx.query,
					params: ctx.params,
				});
			});

			const req = new Request("http://localhost/api/users/123?foo=bar", {
				method: "GET",
				headers: {
					"user-agent": "test-agent",
					"x-custom": "value",
				},
			});

			const res = await app.fetch(req);
			const json = await res.json();

			expect(json.query).toBe("?foo=bar");
			expect(json.headers["user-agent"]).toBe("test-agent");
			expect(json.headers["x-custom"]).toBe("value");
		});

		it("should handle ctx.notify() for fire-and-forget", async () => {
			const notifySpy = vi.spyOn(resolver, "notify");

			routes.post({ rest: "/api/track", event: "track_event" }, async (ctx) => {
				ctx.notify({ event: "page_view", page: "/home" });
				return ctx.json({ tracked: true });
			});

			const req = new Request("http://localhost/api/track", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});

			const res = await app.fetch(req);
			expect(res.status).toBe(200);
			expect(notifySpy).toHaveBeenCalledWith({
				event: "page_view",
				page: "/home",
			});
		});

		it("should handle ctx.forward() to upstream", async () => {
			// Mock upstream response
			resolver.mockResponse({
				status: 200,
				headers: { "content-type": "application/json" },
				bodyText: JSON.stringify({ upstream: "data" }),
			});

			routes.post(
				{ rest: "/api/forward", event: "forward_event" },
				async (ctx) => {
					const result = await ctx.forward<{ upstream: string }>(
						{ action: "process" },
						{ timeout: 5000 },
					);
					return ctx.json({ result, origin: ctx.origin });
				},
			);

			const req = new Request("http://localhost/api/forward", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});

			const res = await app.fetch(req);
			const json = await res.json();

			expect(json.result).toEqual({ upstream: "data" });
			expect(json.origin).toBe("http");
		});

		it("should handle errors in handler", async () => {
			routes.post({ rest: "/api/error", event: "error_event" }, async (ctx) => {
				throw new Error("Test error");
			});

			const req = new Request("http://localhost/api/error", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});

			// Should return 502 with JSON error payload
			const res = await app.fetch(req);
			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({ error: "Test error" });
		});
	});

	describe("WebSocket Origin", () => {
		let mockSocket: any;
		let sentMessages: any[];

		beforeEach(() => {
			sentMessages = [];
			mockSocket = {
				send: vi.fn((data: string) => {
					sentMessages.push(JSON.parse(data));
				}),
				on: vi.fn(),
			};
		});

		it("should handle ctx.body() and ctx.json() for WS requests", async () => {
			routes.post({ rest: "/api/test", event: "test_event" }, async (ctx) => {
				expect(ctx.origin).toBe("ws");
				const data = await ctx.body<{ message: string }>();
				return ctx.json({ received: data.message, origin: ctx.origin });
			});

			// Simulate WebSocket server
			const mockWss = {
				on: vi.fn((event: string, callback: (socket: any) => void) => {
					if (event === "connection") {
						// Simulate connection
						callback(mockSocket);

						// Simulate incoming message
						const messageHandler = mockSocket.on.mock.calls.find(
							(call: any[]) => call[0] === "message",
						)?.[1];

						if (messageHandler) {
							const wsRequest: Message<any> = {
								id: "ws-test-1",
								type: "request",
								payload: {
									event: "test_event",
									body: { message: "hello from ws" },
								},
								timestamp: new Date().toISOString(),
							};

							messageHandler(JSON.stringify(wsRequest));
						}
					}
				}),
			};

			routes.attachWebSocketServer(mockWss);

			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(sentMessages).toHaveLength(1);
			expect(sentMessages[0].id).toBe("ws-test-1");
			expect(sentMessages[0].type).toBe("response");

			const payload = JSON.parse(sentMessages[0].payload.body);
			expect(payload).toEqual({
				received: "hello from ws",
				origin: "ws",
			});
		});

		it("should handle WS request with status code", async () => {
			routes.post(
				{ rest: "/api/validate", event: "validate_event" },
				async (ctx) => {
					const data = await ctx.body<{ email?: string }>();
					if (!data.email) {
						ctx.status(400);
						return ctx.json({ error: "Email required" });
					}
					return ctx.json({ valid: true });
				},
			);

			const mockWss = {
				on: vi.fn((event: string, callback: (socket: any) => void) => {
					if (event === "connection") {
						callback(mockSocket);

						const messageHandler = mockSocket.on.mock.calls.find(
							(call: any[]) => call[0] === "message",
						)?.[1];

						if (messageHandler) {
							const wsRequest: Message<any> = {
								id: "ws-test-2",
								type: "request",
								payload: {
									event: "validate_event",
									body: {},
								},
								timestamp: new Date().toISOString(),
							};

							messageHandler(JSON.stringify(wsRequest));
						}
					}
				}),
			};

			routes.attachWebSocketServer(mockWss);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(sentMessages[0].payload.status).toBe(400);
			const payload = JSON.parse(sentMessages[0].payload.body);
			expect(payload.error).toBe("Email required");
		});

		it("should handle WS request returning Response (auto-conversion)", async () => {
			routes.post(
				{ rest: "/api/legacy", event: "legacy_event" },
				async (ctx) => {
					// Handler returns Response instead of using ctx.json
					return new Response(
						JSON.stringify({ legacy: true, origin: ctx.origin }),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				},
			);

			const mockWss = {
				on: vi.fn((event: string, callback: (socket: any) => void) => {
					if (event === "connection") {
						callback(mockSocket);

						const messageHandler = mockSocket.on.mock.calls.find(
							(call: any[]) => call[0] === "message",
						)?.[1];

						if (messageHandler) {
							const wsRequest: Message<any> = {
								id: "ws-test-3",
								type: "request",
								payload: {
									event: "legacy_event",
									body: {},
								},
								timestamp: new Date().toISOString(),
							};

							messageHandler(JSON.stringify(wsRequest));
						}
					}
				}),
			};

			routes.attachWebSocketServer(mockWss);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(sentMessages[0].type).toBe("response");
			expect(sentMessages[0].payload.status).toBe(200);

			const payload = JSON.parse(sentMessages[0].payload.body);
			expect(payload.legacy).toBe(true);
			expect(payload.origin).toBe("ws");
		});

		it("should handle WS request with headers and query", async () => {
			routes.get({ rest: "/api/info", event: "info_event" }, async (ctx) => {
				return ctx.json({
					headers: ctx.headers,
					query: ctx.query,
					params: ctx.params,
				});
			});

			const mockWss = {
				on: vi.fn((event: string, callback: (socket: any) => void) => {
					if (event === "connection") {
						callback(mockSocket);

						const messageHandler = mockSocket.on.mock.calls.find(
							(call: any[]) => call[0] === "message",
						)?.[1];

						if (messageHandler) {
							const wsRequest: Message<any> = {
								id: "ws-test-4",
								type: "request",
								payload: {
									event: "info_event",
									headers: {
										"user-agent": "ws-client",
										"x-custom": "ws-value",
									},
									query: "?foo=bar",
									params: { id: "123" },
								},
								timestamp: new Date().toISOString(),
							};

							messageHandler(JSON.stringify(wsRequest));
						}
					}
				}),
			};

			routes.attachWebSocketServer(mockWss);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const payload = JSON.parse(sentMessages[0].payload.body);
			expect(payload.headers["user-agent"]).toBe("ws-client");
			expect(payload.query).toBe("?foo=bar");
			expect(payload.params.id).toBe("123");
		});

		it("should handle unknown event with 404", async () => {
			const mockWss = {
				on: vi.fn((event: string, callback: (socket: any) => void) => {
					if (event === "connection") {
						callback(mockSocket);

						const messageHandler = mockSocket.on.mock.calls.find(
							(call: any[]) => call[0] === "message",
						)?.[1];

						if (messageHandler) {
							const wsRequest: Message<any> = {
								id: "ws-test-5",
								type: "request",
								payload: {
									event: "unknown_event",
								},
								timestamp: new Date().toISOString(),
							};

							messageHandler(JSON.stringify(wsRequest));
						}
					}
				}),
			};

			routes.attachWebSocketServer(mockWss);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(sentMessages[0].payload.status).toBe(404);
			const payload = JSON.parse(sentMessages[0].payload.body);
			expect(payload.error).toContain("No handler for event");
		});

		it("should handle WS handler errors with 500", async () => {
			routes.post({ rest: "/api/error", event: "error_event" }, async (ctx) => {
				throw new Error("WS handler error");
			});

			const mockWss = {
				on: vi.fn((event: string, callback: (socket: any) => void) => {
					if (event === "connection") {
						callback(mockSocket);

						const messageHandler = mockSocket.on.mock.calls.find(
							(call: any[]) => call[0] === "message",
						)?.[1];

						if (messageHandler) {
							const wsRequest: Message<any> = {
								id: "ws-test-6",
								type: "request",
								payload: {
									event: "error_event",
								},
								timestamp: new Date().toISOString(),
							};

							messageHandler(JSON.stringify(wsRequest));
						}
					}
				}),
			};

			routes.attachWebSocketServer(mockWss);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(sentMessages[0].payload.status).toBe(500);
			const payload = JSON.parse(sentMessages[0].payload.body);
			expect(payload.error).toBe("WS handler error");
		});
	});

	describe("Origin-Aware Behavior", () => {
		it("should allow different behavior based on origin", async () => {
			routes.post(
				{ rest: "/api/adaptive", event: "adaptive_event" },
				async (ctx) => {
					const data = await ctx.body<{ value: number }>();

					if (ctx.origin === "http") {
						// HTTP: add caching
						return ctx.json(
							{ result: data.value * 2, cached: true },
							{ headers: { "cache-control": "max-age=60" } },
						);
					} else {
						// WS: real-time, no caching
						return ctx.json({ result: data.value * 2, realtime: true });
					}
				},
			);

			// Test HTTP
			const httpReq = new Request("http://localhost/api/adaptive", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: 5 }),
			});

			const httpRes = await app.fetch(httpReq);
			const httpJson = await httpRes.json();
			expect(httpJson.cached).toBe(true);
			expect(httpRes.headers.get("cache-control")).toBe("max-age=60");

			// Test WS
			const sentMessages: any[] = [];
			const mockSocket = {
				send: vi.fn((data: string) => {
					sentMessages.push(JSON.parse(data));
				}),
				on: vi.fn(),
			};

			const mockWss = {
				on: vi.fn((event: string, callback: (socket: any) => void) => {
					if (event === "connection") {
						callback(mockSocket);

						const messageHandler = mockSocket.on.mock.calls.find(
							(call: any[]) => call[0] === "message",
						)?.[1];

						if (messageHandler) {
							const wsRequest: Message<any> = {
								id: "ws-adaptive",
								type: "request",
								payload: {
									event: "adaptive_event",
									body: { value: 5 },
								},
								timestamp: new Date().toISOString(),
							};

							messageHandler(JSON.stringify(wsRequest));
						}
					}
				}),
			};

			routes.attachWebSocketServer(mockWss);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const wsPayload = JSON.parse(sentMessages[0].payload.body);
			expect(wsPayload.realtime).toBe(true);
			expect(wsPayload.cached).toBeUndefined();
		});
	});
});
