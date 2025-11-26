"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/http/index.ts
var http_exports = {};
__export(http_exports, {
  ExpressAdapter: () => ExpressAdapter,
  FastifyAdapter: () => FastifyAdapter,
  HonoAdapter: () => HonoAdapter,
  ResponseParser: () => ResponseParser,
  RouteCompiler: () => RouteCompiler,
  RowstRouter: () => RowstRouter
});
module.exports = __toCommonJS(http_exports);

// src/http/adapters/ExpressAdapter.ts
var ExpressAdapter = class {
  constructor(router) {
    this.router = router;
  }
  /** Register the router to an Express app. */
  register(app, pattern = "/*") {
    if (!app || typeof app.all !== "function") {
      throw new Error(
        "ExpressAdapter.register expects an Express app instance with an .all() method"
      );
    }
    app.all(pattern, async (req, res) => {
      try {
        const request = this.toHttpRequest(req);
        const response = await this.router.handle(request);
        this.toExpressResponse(response, res);
      } catch (error) {
        res.status(500).json({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });
  }
  /** Convert Express request to normalized HttpRequest. */
  toHttpRequest(req) {
    const rawUrl = req.originalUrl || req.url || "";
    const qIndex = rawUrl.indexOf("?");
    const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const query = qIndex >= 0 ? rawUrl.slice(qIndex) : "";
    const headers = {};
    const srcHeaders = req.headers;
    for (const [k, v] of Object.entries(srcHeaders)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    return {
      method: req.method,
      path,
      query,
      headers,
      body: req.body
    };
  }
  /** Send HttpResponse via Express response object. */
  toExpressResponse(response, res) {
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === "string") {
        res.setHeader(key, value);
      }
    }
    res.status(response.status).send(response.body);
  }
};

// src/http/adapters/FastifyAdapter.ts
var FastifyAdapter = class {
  constructor(router) {
    this.router = router;
  }
  /** Register the router to a Fastify instance. */
  async register(fastify) {
    if (!fastify || typeof fastify.all !== "function") {
      throw new Error(
        "FastifyAdapter.register expects a Fastify instance with an .all() method"
      );
    }
    fastify.all("/*", async (request, reply) => {
      try {
        const httpRequest = await this.toHttpRequest(request);
        const response = await this.router.handle(httpRequest);
        await this.toFastifyResponse(response, reply);
      } catch (error) {
        reply.status(500).send({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });
  }
  /** Convert Fastify request to normalized HttpRequest. */
  async toHttpRequest(req) {
    const rawUrl = req.url || "";
    const qIndex = rawUrl.indexOf("?");
    const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const query = qIndex >= 0 ? rawUrl.slice(qIndex) : "";
    const headers = {};
    const srcHeaders = req.headers;
    for (const [k, v] of Object.entries(srcHeaders)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    const body = req.body;
    return {
      method: req.method,
      path,
      query,
      headers,
      body
    };
  }
  /** Send HttpResponse via Fastify reply object. */
  async toFastifyResponse(response, reply) {
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === "string") {
        reply.header(key, value);
      }
    }
    reply.status(response.status).send(response.body);
  }
};

// src/http/adapters/HonoAdapter.ts
var HonoAdapter = class {
  constructor(router) {
    this.router = router;
  }
  /** Register the router to a Hono app. Creates a catch-all route handler. */
  register(app, pattern = "/*") {
    if (!app || typeof app.all !== "function") {
      throw new Error(
        "HonoAdapter.register expects a Hono app instance with an .all() method"
      );
    }
    app.all(pattern, async (c) => {
      const request = await this.toHttpRequest(c);
      const response = await this.router.handle(request);
      return this.toHonoResponse(response);
    });
  }
  /** Convert Hono context to normalized HttpRequest. */
  async toHttpRequest(c) {
    const url = new URL(c.req.url);
    const headers = {};
    const rawHeaders = c?.req?.raw?.headers ?? c?.req?.headers;
    if (rawHeaders) {
      try {
        if (typeof rawHeaders.forEach === "function") {
          rawHeaders.forEach((value, key) => {
            headers[key] = value;
          });
        } else if (typeof rawHeaders[Symbol.iterator] === "function") {
          for (const [key, value] of rawHeaders) {
            headers[String(key)] = String(value);
          }
        }
      } catch {
      }
    }
    let body;
    try {
      const contentType = (typeof c.req.header === "function" ? c.req.header("content-type") : void 0) ?? c?.req?.raw?.headers?.get?.("content-type") ?? "";
      if (contentType.includes("application/json")) {
        body = await c.req.json();
      } else {
        const text = await c.req.text();
        if (text && text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
      }
    } catch {
    }
    return {
      method: c.req.method,
      path: url.pathname,
      query: url.search,
      headers,
      body
    };
  }
  /** Convert HttpResponse to Hono Response. */
  toHonoResponse(response) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      }
    }
    return new Response(response.body, { status: response.status, headers });
  }
};

// src/http/ResponseParser.ts
var ResponseParser = class {
  /**
   * Parse a Rowst message payload into an HTTP response.
   * Handles multiple payload formats for flexibility.
   */
  static parse(message) {
    const payload = message.payload;
    if (!payload || typeof payload !== "object") {
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: ""
      };
    }
    const status = this.extractStatus(payload);
    const headers = this.extractHeaders(payload);
    const body = this.extractBody(payload, headers);
    return { status, headers, body };
  }
  static extractStatus(payload) {
    if (typeof payload.status === "number") {
      return payload.status;
    }
    return 200;
  }
  static extractHeaders(payload) {
    const headers = {};
    if (payload.headers && typeof payload.headers === "object") {
      for (const [key, value] of Object.entries(payload.headers)) {
        if (typeof value === "string") {
          headers[key.toLowerCase()] = value;
        }
      }
    }
    if (!headers["content-type"]) {
      headers["content-type"] = "text/plain";
    }
    return headers;
  }
  static extractBody(payload, headers) {
    if (typeof payload.bodyText === "string") {
      return payload.bodyText;
    }
    if (typeof payload.body !== "undefined") {
      if (typeof payload.body === "string") {
        return payload.body;
      }
      if (!headers["content-type"] || headers["content-type"] === "text/plain") {
        headers["content-type"] = "application/json";
      }
      try {
        return JSON.stringify(payload.body);
      } catch {
        return String(payload.body);
      }
    }
    return "";
  }
  /** Create an error response. */
  static error(status, message, details) {
    const body = JSON.stringify({
      error: message,
      ...details ? { details } : {}
    });
    return {
      status,
      headers: { "content-type": "application/json" },
      body
    };
  }
};

// src/http/RouteCompiler.ts
var RouteCompiler = class _RouteCompiler {
  /** Compile a route config into a CompiledRoute with regex and param extraction. */
  static compile(config) {
    const { pathRegex, paramNames } = _RouteCompiler.compilePath(config.path);
    return { ...config, pathRegex, paramNames };
  }
  /** Convert Express-style path pattern to regex. */
  static compilePath(pattern) {
    const paramNames = [];
    const segments = pattern.split("/");
    let regex = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === "*") {
        regex += (i === 0 ? "" : "\\/") + ".*";
        continue;
      }
      if (seg.startsWith(":")) {
        const { cleaned, optional } = parseParam(seg);
        paramNames.push(cleaned);
        if (optional) {
          regex += "(?:\\/([^/]+))?";
        } else {
          regex += "\\/([^/]+)";
        }
        continue;
      }
      if (seg.length > 0) {
        regex += (i === 0 ? "" : "\\/") + escapeSegment(seg);
      } else if (i > 0) {
        regex += "\\/";
      }
    }
    const pathRegex = new RegExp("^" + regex + "$");
    return { pathRegex, paramNames };
  }
  /** Extract parameter values from a path using compiled route. */
  static extractParams(path, compiledRoute) {
    const match = compiledRoute.pathRegex.exec(path);
    if (!match) return null;
    const params = {};
    compiledRoute.paramNames.forEach((name, index) => {
      const value = match[index + 1];
      if (typeof value !== "undefined") {
        params[name] = safeDecode(value);
      }
    });
    return params;
  }
};
function parseParam(segment) {
  let name = segment.slice(1);
  let optional = false;
  if (name.endsWith("?")) {
    name = name.slice(0, -1);
    optional = true;
  }
  return { cleaned: name, optional };
}
function escapeSegment(segment) {
  return segment.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
}
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// src/core/errors.ts
var RowstError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "RowstError";
  }
};
var TimeoutError = class extends RowstError {
  constructor(message = "Request timed out", details) {
    super(message, "TIMEOUT", details);
    this.name = "TimeoutError";
  }
};
var TransportClosedError = class extends RowstError {
  constructor(message = "Transport is closed", details) {
    super(message, "TRANSPORT_CLOSED", details);
    this.name = "TransportClosedError";
  }
};

// src/http/RowstRouter.ts
var DEFAULT_TIMEOUT = 15e3;
var RowstRouter = class {
  constructor(resolver, options = {}) {
    this.resolver = resolver;
    this.routes = [];
    this.options = {
      defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
      prefix: options.prefix ?? ""
    };
    this.beforeRequest = options.beforeRequest;
    this.afterResponse = options.afterResponse;
    this.onError = options.onError;
  }
  /** Register a route. */
  register(config) {
    const fullPath = this.options.prefix + config.path;
    const compiled = RouteCompiler.compile({ ...config, path: fullPath });
    this.routes.push(compiled);
  }
  /** Register a GET route. */
  get(path, event, options) {
    this.register({ path, event, method: "GET", ...options });
  }
  /** Register a POST route. */
  post(path, event, options) {
    this.register({ path, event, method: "POST", ...options });
  }
  /** Register a PUT route. */
  put(path, event, options) {
    this.register({ path, event, method: "PUT", ...options });
  }
  /** Register a DELETE route. */
  delete(path, event, options) {
    this.register({ path, event, method: "DELETE", ...options });
  }
  /** Register a PATCH route. */
  patch(path, event, options) {
    this.register({ path, event, method: "PATCH", ...options });
  }
  /** Register a route that matches all HTTP methods. */
  all(path, event, options) {
    this.register({ path, event, method: "ALL", ...options });
  }
  /**
   * Handle an incoming HTTP request.
   * Matches against registered routes and forwards to upstream WebSocket.
   */
  async handle(request) {
    try {
      const match = this.match(request.method, request.path);
      if (this.beforeRequest) {
        await this.beforeRequest(request, match);
      }
      const payload = {
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
        body: request.body
      };
      if (match) {
        payload.params = match.params;
        payload.event = match.route.event;
      }
      const timeout = match?.route.timeout ?? this.options.defaultTimeout;
      const requestOptions = { timeout };
      if (match?.route.meta) {
        requestOptions.meta = { ...match.route.meta, event: match.route.event };
      } else if (match) {
        requestOptions.meta = { event: match.route.event };
      }
      const message = await this.resolver.request(
        payload,
        requestOptions
      );
      let response = ResponseParser.parse(message);
      if (this.afterResponse) {
        await this.afterResponse(response, request);
      }
      return response;
    } catch (error) {
      return this.handleError(error, request);
    }
  }
  /** Match an HTTP request to a registered route. */
  match(method, path) {
    for (const route of this.routes) {
      const routeMethod = route.method ?? "ALL";
      const methodMatches = routeMethod === "ALL" || routeMethod.toUpperCase() === method.toUpperCase();
      if (!methodMatches) continue;
      const params = RouteCompiler.extractParams(path, route);
      if (params !== null) {
        return { route, params };
      }
    }
    return null;
  }
  /** Handle errors during request processing. */
  handleError(error, _request) {
    if (this.onError) {
      try {
        return this.onError(error, _request);
      } catch (handlerError) {
        return ResponseParser.error(500, "Internal server error", {
          original: describeUnknownError(error),
          handlerError: describeUnknownError(handlerError)
        });
      }
    }
    if (error instanceof TimeoutError) {
      return ResponseParser.error(504, "Gateway timeout", {
        message: error.message
      });
    }
    if (error instanceof TransportClosedError) {
      return ResponseParser.error(503, "Service unavailable", {
        message: "Upstream connection closed"
      });
    }
    if (error instanceof Error) {
      return ResponseParser.error(502, "Bad gateway", {
        message: error.message
      });
    }
    return ResponseParser.error(500, "Internal server error");
  }
  /** Get all registered routes (for debugging/introspection). */
  getRoutes() {
    return this.routes.map((r) => ({
      method: r.method ?? "ALL",
      path: r.path,
      event: r.event
    }));
  }
};
function describeUnknownError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { error };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ExpressAdapter,
  FastifyAdapter,
  HonoAdapter,
  ResponseParser,
  RouteCompiler,
  RowstRouter
});
//# sourceMappingURL=index.cjs.map