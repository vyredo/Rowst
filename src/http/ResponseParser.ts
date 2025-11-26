import type { Message } from "../core/types.js";
import type { HttpResponse, UpstreamResponse } from "./types.js";

/**
 * Parses Rowst Message responses from upstream into HTTP responses.
 */
export class ResponseParser {
	/**
	 * Parse a Rowst message payload into an HTTP response.
	 * Handles multiple payload formats for flexibility.
	 */
	static parse(message: Message<unknown>): HttpResponse {
		const payload = message.payload as UpstreamResponse | undefined;

		if (!payload || typeof payload !== "object") {
			// Empty or invalid payload: return 200 with empty body
			return {
				status: 200,
				headers: { "content-type": "text/plain" },
				body: "",
			};
		}

		// Extract status (default: 200)
		const status = this.extractStatus(payload);

		// Extract headers (default: content-type text/plain)
		const headers = this.extractHeaders(payload);

		// Extract body
		const body = this.extractBody(payload, headers);

		return { status, headers, body };
	}

	private static extractStatus(payload: UpstreamResponse): number {
		if (typeof payload.status === "number") {
			return payload.status;
		}
		return 200;
	}

	private static extractHeaders(
		payload: UpstreamResponse,
	): Record<string, string> {
		const headers: Record<string, string> = {};

		if (payload.headers && typeof payload.headers === "object") {
			for (const [key, value] of Object.entries(payload.headers)) {
				if (typeof value === "string") {
					headers[key.toLowerCase()] = value;
				}
			}
		}

		// Set default content-type if not provided
		if (!headers["content-type"]) {
			headers["content-type"] = "text/plain";
		}

		return headers;
	}

	private static extractBody(
		payload: UpstreamResponse,
		headers: Record<string, string>,
	): string {
		// Priority 1: bodyText (raw string)
		if (typeof payload.bodyText === "string") {
			return payload.bodyText;
		}

		// Priority 2: body (structured data - stringify if needed)
		if (typeof payload.body !== "undefined") {
			if (typeof payload.body === "string") {
				return payload.body;
			}
			// Stringify and set content-type to JSON if not already set
			if (
				!headers["content-type"] ||
				headers["content-type"] === "text/plain"
			) {
				headers["content-type"] = "application/json";
			}
			try {
				return JSON.stringify(payload.body);
			} catch {
				return String(payload.body);
			}
		}

		// No body provided
		return "";
	}

	/** Create an error response. */
	static error(
		status: number,
		message: string,
		details?: unknown,
	): HttpResponse {
		const body = JSON.stringify({
			error: message,
			...(details ? { details } : {}),
		});
		return {
			status,
			headers: { "content-type": "application/json" },
			body,
		};
	}
}
