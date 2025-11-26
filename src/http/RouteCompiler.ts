import type { CompiledRoute, RouteConfig } from "./types.js";

/**
 * Compiles Express-style path patterns into regex for matching:
 *  - Named params: /users/:id
 *  - Multiple params: /posts/:postId/comments/:commentId
 *  - Wildcards: /files/*
 *  - Optional segments: /posts/:id? (slash+segment optional)
 */
export class RouteCompiler {
	/** Compile a route config into a CompiledRoute with regex and param extraction. */
	static compile(config: RouteConfig): CompiledRoute {
		const { pathRegex, paramNames } = RouteCompiler.compilePath(config.path);
		return { ...config, pathRegex, paramNames };
	}

	/** Convert Express-style path pattern to regex. */
	private static compilePath(pattern: string): {
		pathRegex: RegExp;
		paramNames: string[];
	} {
		const paramNames: string[] = [];
		const segments = pattern.split("/");

		let regex = "";

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];

			// Wildcard segment
			if (seg === "*") {
				// include preceding slash for non-first segments
				regex += (i === 0 ? "" : "\\/") + ".*";
				continue;
			}

			// Parameter segment
			if (seg.startsWith(":")) {
				const { cleaned, optional } = parseParam(seg);
				paramNames.push(cleaned);
				if (optional) {
					// include slash inside optional group so '/:id?' makes the entire '/id' optional
					regex += "(?:\\/([^/]+))?";
				} else {
					regex += "\\/([^/]+)";
				}
				continue;
			}

			// Static segment (may be empty for leading/trailing '/')
			if (seg.length > 0) {
				regex += (i === 0 ? "" : "\\/") + escapeSegment(seg);
			} else if (i > 0) {
				// preserve explicit trailing slash
				regex += "\\/";
			}
		}

		const pathRegex = new RegExp("^" + regex + "$");
		return { pathRegex, paramNames };
	}

	/** Extract parameter values from a path using compiled route. */
	static extractParams(
		path: string,
		compiledRoute: CompiledRoute,
	): Record<string, string> | null {
		const match = compiledRoute.pathRegex.exec(path);
		if (!match) return null;
		const params: Record<string, string> = {};
		compiledRoute.paramNames.forEach((name, index) => {
			const value = match[index + 1];
			if (typeof value !== "undefined") {
				params[name] = safeDecode(value);
			}
		});
		return params;
	}
}

function parseParam(segment: string): { cleaned: string; optional: boolean } {
	let name = segment.slice(1);
	let optional = false;
	if (name.endsWith("?")) {
		name = name.slice(0, -1);
		optional = true;
	}
	return { cleaned: name, optional };
}

function escapeSegment(segment: string): string {
	return segment.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
