// Upstream WebSocket service that handles the SAME event used by RowstRoute HTTP bridge.
// It replies via ws.send(JSON.stringify(responseEnvelope)) using the SAME correlation id.

import { WebSocketServer } from "ws";
import type { Message } from "../../dist/index.js";

type UpstreamResponseEnvelope = {
	status: number;
	headers?: Record<string, string>;
	body?: string; // RowstRoute also accepts 'bodyText', but 'body' is fine
};

const wss = new WebSocketServer({ port: 4100 });

wss.on("listening", () => {
	// eslint-disable-next-line no-console
	console.log("Upstream WS listening on ws://localhost:4100");
});

wss.on("connection", (socket) => {
	socket.on("message", (raw) => {
		let msg: Message<any>;
		try {
			msg = JSON.parse(
				typeof raw === "string"
					? raw
					: Buffer.from(raw as Buffer).toString("utf8"),
			) as Message<any>;
		} catch {
			return;
		}

		if (msg.type !== "request") {
			// Ignore non-request, but you could log or handle "notification" here.
			return;
		}

		// RowstRoute sends a payload like:
		// { event, method, path, query, headers, body }
		// Direct WS clients may send: { event, body } OR just { event, ...domain }
		const payload = (msg.payload ?? {}) as Record<string, any>;
		const event = payload.event as string | undefined;

		// Normalize domain input:
		// - Prefer payload.body when coming from RowstRoute
		// - Fallback to the payload itself for direct WS callers
		const domain =
			typeof payload.body !== "undefined"
				? (payload.body as Record<string, any>)
				: payload;

		if (event === "get_comment") {
			const postUrl = String(domain?.postUrl ?? "");
			const limit = Number.isFinite(domain?.limit) ? Number(domain.limit) : 2;
			const offset = Number.isFinite(domain?.offset)
				? Number(domain.offset)
				: 0;

			const comments = [
				{ id: "1", text: `Comment A for ${postUrl}`, author: "User1" },
				{ id: "2", text: `Comment B for ${postUrl}`, author: "User2" },
				{ id: "3", text: `Comment C for ${postUrl}`, author: "User3" },
			].slice(offset, offset + limit);

			const response: Message<UpstreamResponseEnvelope> = {
				id: msg.id, // IMPORTANT: echo the same id so AsyncResolver correlates
				type: "response",
				payload: {
					status: 200,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						data: { comments, total: comments.length },
					}),
				},
				timestamp: new Date().toISOString(),
			};

			socket.send(JSON.stringify(response));
			return;
		}

		// Unknown event
		const notFound: Message<UpstreamResponseEnvelope> = {
			id: msg.id,
			type: "response",
			payload: {
				status: 404,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ error: `Unknown event: ${event}` }),
			},
			timestamp: new Date().toISOString(),
		};
		socket.send(JSON.stringify(notFound));
	});
});
