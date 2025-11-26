import { describe, test, expect, beforeEach } from "vitest";
import type { AsyncResolver } from "../../src/core/AsyncResolver.js";
import type { Message } from "../../src/core/types.js";
import { RouteCompiler } from "../../src/http/RouteCompiler.js";
import { RowstRouter } from "../../src/http/RowstRouter.js";
import type { HttpRequest } from "../../src/http/types.js";

// Mock AsyncResolver
const createMockResolver = (): AsyncResolver => {
	return {
		request: async (payload: any): Promise<Message<unknown>> => {
			return {
				id: "test-id",
				type: "response",
				payload: {
					status: 200,
					headers: { "content-type": "application/json" },
					bodyText: JSON.stringify({ data: payload }),
				},
				timestamp: new Date().toISOString(),
			} as any;
		},
	} as any;
};

describe("RowstRouter", () => {
	let router: RowstRouter;

	beforeEach(() => {
		router = new RowstRouter(createMockResolver() as any);
	});

	test("registers and matches GET route", async () => {
		router.get("/users/:id", "fetchUser");
		const request: HttpRequest = {
			method: "GET",
			path: "/users/123",
			query: "",
			headers: {},
			body: undefined,
		};
		const response = await router.handle(request);
		expect(response.status).toBe(200);
	});

	test("extracts path parameters and forwards event", async () => {
		let capturedPayload: any;
		const mockResolver = {
			request: async (payload: any): Promise<Message<unknown>> => {
				capturedPayload = payload;
				return {
					id: "test",
					type: "response",
					payload: { status: 200, bodyText: "OK" },
					timestamp: new Date().toISOString(),
				} as any;
			},
		} as any;

		router = new RowstRouter(mockResolver);
		router.get("/posts/:postId/comments/:commentId", "fetchComment");

		await router.handle({
			method: "GET",
			path: "/posts/456/comments/789",
			query: "",
			headers: {},
			body: undefined,
		});

		expect(capturedPayload.params).toEqual({ postId: "456", commentId: "789" });
		expect(capturedPayload.event).toBe("fetchComment");
	});

	test("handles unmatched routes (fallback forwards without event/params)", async () => {
		router.get("/users/:id", "fetchUser");
		const response = await router.handle({
			method: "GET",
			path: "/unknown/route",
			query: "",
			headers: {},
			body: undefined,
		});
		expect(response.status).toBe(200);
	});

	test("applies route-specific timeout (registered)", async () => {
		router.get("/slow/:id", "slowOperation", { timeout: 1000 });
		const routes = router.getRoutes();
		expect(routes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "slowOperation",
					method: "GET",
					path: "/slow/:id",
				}),
			]),
		);
	});

	test("URL decodes path parameters", async () => {
		let capturedParams: any;
		const mockResolver = {
			request: async (payload: any): Promise<Message<unknown>> => {
				capturedParams = payload.params;
				return {
					id: "test",
					type: "response",
					payload: { status: 200, bodyText: "OK" },
					timestamp: new Date().toISOString(),
				} as any;
			},
		} as any;

		router = new RowstRouter(mockResolver);
		router.get("/search/:query", "search");
		await router.handle({
			method: "GET",
			path: "/search/hello%20world",
			query: "",
			headers: {},
			body: undefined,
		});
		expect(capturedParams.query).toBe("hello world");
	});
});

describe("RouteCompiler", () => {
	test("compiles simple path pattern and matches", () => {
		const compiled = RouteCompiler.compile({
			path: "/users/:id",
			event: "e",
			method: "GET",
		});
		expect("/users/123").toMatch(compiled.pathRegex);
		expect("/users/123/posts").not.toMatch(compiled.pathRegex);
		const params = RouteCompiler.extractParams("/users/123", compiled);
		expect(params).toEqual({ id: "123" });
	});

	test("compiles multiple parameters", () => {
		const compiled = RouteCompiler.compile({
			path: "/posts/:postId/comments/:commentId",
			event: "e",
			method: "GET",
		});
		expect("/posts/1/comments/2").toMatch(compiled.pathRegex);
		const params = RouteCompiler.extractParams("/posts/1/comments/2", compiled);
		expect(params).toEqual({ postId: "1", commentId: "2" });
	});

	test("compiles wildcard patterns", () => {
		const compiled = RouteCompiler.compile({
			path: "/files/*",
			event: "e",
			method: "GET",
		});
		expect("/files/a/b/c.txt").toMatch(compiled.pathRegex);
	});
});
