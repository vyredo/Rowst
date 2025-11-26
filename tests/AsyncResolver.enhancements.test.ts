import { describe, expect, it, vi } from "vitest";
import { AsyncResolver } from "../src/core/AsyncResolver.js";
import { MockTransport } from "./mocks/MockTransport.js";

describe("AsyncResolver - connection state", () => {
	it("waitForReady resolves when transport opens", async () => {
		const transport = new MockTransport({ openDelayMs: 20 });
		const resolver = new AsyncResolver(transport);
		await resolver.waitForReady({ timeout: 5000 });
		expect(resolver.isReady()).toBe(true);
		resolver.destroy();
	});
});

describe("AsyncResolver - custom metadata", () => {
	it("includes custom meta in request", async () => {
		const transport = new MockTransport();
		const resolver = new AsyncResolver(transport);
		const response = await resolver.request(
			{ hello: "world" },
			{ meta: { wsEvent: "test", custom: 123 } },
		);
		expect(response.meta?.wsEvent).toBe("test");
		expect(response.meta?.custom).toBe(123);
		resolver.destroy();
	});
});

describe("AsyncResolver - response interceptor", () => {
	it("validates and rejects when invalid", async () => {
		const transport = new MockTransport();
		const resolver = new AsyncResolver(transport, {
			responseInterceptor: (message) => {
				if (!message.payload) {
					throw new Error("Payload required");
				}
				return message;
			},
		});
		await expect(resolver.request(null as any)).rejects.toThrow(
			"Payload required",
		);
		resolver.destroy();
	});
});

describe("AsyncResolver - request deduplication", () => {
	it("deduplicates identical inflight requests", async () => {
		const transport = new MockTransport({ delayMs: 30 });
		const resolver = new AsyncResolver(transport, {
			deduplicateRequests: true,
		});
		const sendSpy = vi.spyOn(transport, "send");
		const payload = { action: "fetch", id: "123" };
		const p1 = resolver.request(payload);
		const p2 = resolver.request(payload);
		const p3 = resolver.request(payload);
		const results = await Promise.all([p1, p2, p3]);
		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(results[0].id).toBe(results[1].id);
		expect(results[1].id).toBe(results[2].id);
		resolver.destroy();
	});
});

describe("AsyncResolver - graceful shutdown", () => {
	it("close waits for pending requests", async () => {
		const transport = new MockTransport({ delayMs: 50 });
		const resolver = new AsyncResolver(transport);
		const request = resolver.request({ slow: true });
		const closePromise = resolver.close({ timeout: 5000 });
		await request;
		await closePromise;
		expect(resolver.getInflightCount()).toBe(0);
	});
});
