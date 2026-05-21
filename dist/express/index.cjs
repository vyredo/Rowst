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

// src/express/index.ts
var express_exports = {};
__export(express_exports, {
  RowstRoute: () => RowstRoute
});
module.exports = __toCommonJS(express_exports);

// src/express/RowstRoute.ts
var RowstRoute = class {
  constructor(options) {
    // Keep an event → handler registry so we can also serve direct WebSocket requests
    this.eventRegistry = /* @__PURE__ */ new Map();
    this.app = options.app;
    this.resolver = options.resolver;
  }
  /**
   * Register a GET route
   */
  get(config, handler) {
    this.registerRoute("GET", config, handler);
  }
  /**
   * Register a POST route
   */
  post(config, handler) {
    this.registerRoute("POST", config, handler);
  }
  /**
   * Register a PUT route
   */
  put(config, handler) {
    this.registerRoute("PUT", config, handler);
  }
  /**
   * Register a DELETE route
   */
  delete(config, handler) {
    this.registerRoute("DELETE", config, handler);
  }
  /**
   * Register a PATCH route
   */
  patch(config, handler) {
    this.registerRoute("PATCH", config, handler);
  }
  /**
   * Register a route for all HTTP methods
   */
  all(config, handler) {
    this.registerRoute("ALL", config, handler);
  }
  /**
   * Internal method to register a route with the Hono app
   */
  registerRoute(method, config, handler) {
    const honoHandler = async (honoContext) => {
      try {
        const ctx = this.createHttpContext(honoContext, config);
        const result = await handler(ctx);
        if (result instanceof Response) {
          return result;
        }
        return new Response(null, { status: 204 });
      } catch (e) {
        const message = e?.message ?? "Handler error";
        return new Response(JSON.stringify({ error: message }), {
          status: 502,
          headers: { "content-type": "application/json" }
        });
      }
    };
    try {
      if (config?.event && typeof config.event === "string") {
        this.eventRegistry.set(config.event, handler);
      }
    } catch {
    }
    switch (method) {
      case "GET":
        this.app.get(config.rest, honoHandler);
        break;
      case "POST":
        this.app.post(config.rest, honoHandler);
        break;
      case "PUT":
        this.app.put(config.rest, honoHandler);
        break;
      case "DELETE":
        this.app.delete(config.rest, honoHandler);
        break;
      case "PATCH":
        this.app.patch(config.rest, honoHandler);
        break;
      case "ALL":
        this.app.all(config.rest, honoHandler);
        break;
    }
  }
  /**
   * Create unified context for HTTP origin
   */
  createHttpContext(honoContext, config) {
    const origin = "http";
    let pendingStatus;
    let pendingHeaders;
    const headers = {};
    honoContext.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const url = new URL(honoContext.req.url);
    const query = url.search || "";
    const params = {};
    try {
      const paramKeys = honoContext.req.param();
      if (paramKeys && typeof paramKeys === "object") {
        Object.assign(params, paramKeys);
      }
    } catch {
    }
    const websocketContext = this.createWebSocketContext(
      honoContext,
      config,
      origin
    );
    const ctx = {
      origin,
      forwardingHttp: true,
      meta: { forwarded: false },
      honoContext,
      websocketContext,
      body: async () => {
        try {
          return await honoContext.req.json();
        } catch {
          try {
            const text = await honoContext.req.text();
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          } catch {
            return {};
          }
        }
      },
      json: (data, init) => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = new Headers(init?.headers ?? pendingHeaders);
        if (!responseHeaders.has("content-type")) {
          responseHeaders.set("content-type", "application/json");
        }
        pendingStatus = void 0;
        pendingHeaders = void 0;
        return new Response(JSON.stringify(data), {
          status,
          headers: responseHeaders
        });
      },
      text: (body, init) => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = new Headers(init?.headers ?? pendingHeaders);
        pendingStatus = void 0;
        pendingHeaders = void 0;
        return new Response(body, {
          status,
          headers: responseHeaders
        });
      },
      status: (code) => {
        pendingStatus = code;
      },
      headers,
      query,
      params,
      notify: (payload) => {
        this.resolver.notify(payload);
      },
      forward: async (payload, opts) => {
        const requestPayload = await this.buildRequestPayload(
          honoContext,
          config.event,
          payload
        );
        const timeout = opts?.timeout ?? config.timeoutMs;
        let message;
        if (opts?.retries !== void 0 && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(requestPayload, {
            timeout,
            retries: opts.retries,
            meta: { event: config.event }
          });
        } else {
          message = await this.resolver.request(requestPayload, {
            timeout,
            meta: { event: config.event }
          });
        }
        const response = this.parseResponse(message);
        return response.data;
      },
      _honoContext: honoContext,
      _websocketContext: websocketContext
    };
    return ctx;
  }
  /**
   * Create a WebSocket context for the current request
   */
  createWebSocketContext(honoContext, config, origin) {
    return {
      connected: this.resolver.isReady(),
      request: async (payload, opts) => {
        const requestPayload = await this.buildRequestPayload(
          honoContext,
          config.event,
          payload
        );
        const timeout = opts?.timeout ?? config.timeoutMs;
        let message;
        if (opts?.retries !== void 0 && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(requestPayload, {
            timeout,
            retries: opts.retries,
            meta: { event: config.event }
          });
        } else {
          message = await this.resolver.request(requestPayload, {
            timeout,
            meta: { event: config.event }
          });
        }
        return this.parseResponse(message);
      },
      send: (payload, init) => {
        if (origin === "http") {
          const notificationPayload = {
            event: config.event,
            method: honoContext.req.method,
            path: honoContext.req.path
          };
          if (payload !== void 0) {
            notificationPayload.data = payload;
          }
          this.resolver.notify(notificationPayload);
        }
      }
    };
  }
  /**
   * Build the request payload to send to upstream
   */
  async buildRequestPayload(honoContext, event, overridePayload) {
    const method = honoContext.req.method;
    const path = honoContext.req.path;
    const url = new URL(honoContext.req.url);
    const query = url.search || void 0;
    const headers = {};
    honoContext.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });
    let body = void 0;
    if (overridePayload !== void 0) {
      body = overridePayload;
    } else if (method !== "GET" && method !== "HEAD" && headers["content-type"]?.includes("application/json")) {
      try {
        body = await honoContext.req.json();
      } catch {
      }
    }
    return {
      method,
      path,
      query,
      headers,
      body,
      event
    };
  }
  /**
   * Parse the response from upstream into a structured format
   */
  parseResponse(message) {
    const payload = message.payload;
    if (payload && typeof payload === "object" && "status" in payload && typeof payload.status === "number") {
      const envelope = payload;
      const bodyText = envelope.body ?? envelope.bodyText ?? "";
      let data;
      if (bodyText) {
        try {
          data = JSON.parse(bodyText);
        } catch {
        }
      }
      return {
        status: envelope.status,
        headers: envelope.headers ?? {},
        bodyText,
        data,
        message
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify(payload),
      data: payload,
      message
    };
  }
  /**
   * Attach a Node-style WebSocket server (e.g., ws.WebSocketServer) to handle
   * Rowst "request" envelopes directly using the SAME registered handlers.
   * Each incoming WS "request" must contain payload.event set to the event name.
   * Replies are sent as Rowst "response" envelopes with the same id.
   */
  attachWebSocketServer(server) {
    if (!server || typeof server.on !== "function") {
      throw new Error(
        "attachWebSocketServer(server) requires a WebSocket server with .on('connection')"
      );
    }
    server.on("connection", (socket) => {
      if (!socket || typeof socket.on !== "function" || typeof socket.send !== "function") {
        return;
      }
      socket.on("message", async (raw) => {
        let text = "";
        try {
          if (typeof raw === "string") {
            text = raw;
          } else if (raw && typeof raw.toString === "function") {
            text = raw.toString("utf8");
          } else {
            text = String(raw ?? "");
          }
          const msg = JSON.parse(text);
          if (!msg || msg.type !== "request") {
            return;
          }
          const payload = msg.payload ?? {};
          const event = String(payload.event ?? "");
          const handler = this.eventRegistry.get(event);
          if (!handler) {
            const notFound = {
              id: msg.id,
              type: "response",
              payload: {
                status: 404,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  error: `No handler for event '${event}'`
                })
              },
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            };
            socket.send(JSON.stringify(notFound));
            return;
          }
          const ctx = this.createWsContext(payload, event, socket, msg.id);
          let response;
          try {
            response = await handler(ctx);
          } catch (handlerError) {
            const errorEnvelope = {
              id: msg.id,
              type: "response",
              payload: {
                status: 500,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  error: handlerError?.message ?? "Handler error"
                })
              },
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            };
            socket.send(JSON.stringify(errorEnvelope));
            return;
          }
          if (response instanceof Response) {
            const envelope = await this.responseToEnvelope(response);
            const wsResponse = {
              id: msg.id,
              type: "response",
              payload: envelope,
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            };
            socket.send(JSON.stringify(wsResponse));
          }
        } catch (e) {
          const errorPayload = {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              error: "Invalid WS request",
              details: e?.message
            })
          };
          try {
            const fallback = {
              id: JSON.parse(text)?.id ?? "",
              type: "response",
              payload: errorPayload,
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            };
            socket.send(JSON.stringify(fallback));
          } catch {
            const fallback = {
              id: "",
              type: "response",
              payload: errorPayload,
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            };
            socket.send(JSON.stringify(fallback));
          }
        }
      });
    });
  }
  /**
   * Create unified context for WebSocket origin
   */
  createWsContext(payload, event, socket, requestId) {
    const origin = "ws";
    let pendingStatus;
    let pendingHeaders;
    let responded = false;
    const headers = payload.headers ?? {};
    const query = String(payload.query ?? "");
    const params = payload.params ?? {};
    const honoContext = this.createSyntheticHonoContext(payload);
    const sendWsResponse = (status, responseHeaders, body) => {
      if (responded) return;
      responded = true;
      const wsResponse = {
        id: requestId,
        type: "response",
        payload: {
          status,
          headers: responseHeaders,
          body
        },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      socket.send(JSON.stringify(wsResponse));
    };
    const websocketContext = {
      connected: this.resolver.isReady(),
      request: async (overrideBody, opts) => {
        const forwardPayload = {
          method: String(payload.method ?? "WS"),
          path: String(payload.path ?? "/"),
          query: payload.query,
          headers: payload.headers,
          body: overrideBody ?? payload.body,
          event
        };
        let message;
        if (opts?.retries && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(forwardPayload, {
            timeout: opts?.timeout,
            retries: opts?.retries,
            meta: { event }
          });
        } else {
          message = await this.resolver.request(forwardPayload, {
            timeout: opts?.timeout,
            meta: { event }
          });
        }
        return this.parseResponse(message);
      },
      send: (fireAndForget, init) => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = init?.headers ?? pendingHeaders ?? {};
        if (!responseHeaders["content-type"]) {
          responseHeaders["content-type"] = "application/json";
        }
        const body = JSON.stringify(fireAndForget);
        sendWsResponse(status, responseHeaders, body);
        pendingStatus = void 0;
        pendingHeaders = void 0;
      }
    };
    const ctx = {
      origin,
      forwardingHttp: false,
      meta: { requestId, forwarded: false, transport: "ws" },
      honoContext,
      websocketContext,
      body: async () => {
        const bodyData = payload.body ?? payload;
        return bodyData;
      },
      json: (data, init) => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = init?.headers ?? pendingHeaders ?? {};
        if (!responseHeaders["content-type"]) {
          responseHeaders["content-type"] = "application/json";
        }
        const body = JSON.stringify(data);
        sendWsResponse(status, responseHeaders, body);
        pendingStatus = void 0;
        pendingHeaders = void 0;
      },
      text: (body, init) => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = init?.headers ?? pendingHeaders ?? {};
        sendWsResponse(status, responseHeaders, body);
        pendingStatus = void 0;
        pendingHeaders = void 0;
      },
      status: (code) => {
        pendingStatus = code;
      },
      headers,
      query,
      params,
      notify: (notifyPayload) => {
        this.resolver.notify(notifyPayload);
      },
      forward: async (forwardPayload, opts) => {
        const requestPayload = {
          method: String(payload.method ?? "WS"),
          path: String(payload.path ?? "/"),
          query: payload.query,
          headers: payload.headers,
          body: forwardPayload ?? payload.body,
          event
        };
        let message;
        if (opts?.retries && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(requestPayload, {
            timeout: opts?.timeout,
            retries: opts?.retries,
            meta: { event }
          });
        } else {
          message = await this.resolver.request(requestPayload, {
            timeout: opts?.timeout,
            meta: { event }
          });
        }
        const response = this.parseResponse(message);
        return response.data;
      },
      _honoContext: honoContext,
      _websocketContext: websocketContext
    };
    return ctx;
  }
  /** Create a minimal Hono-like context backed by the WS payload */
  createSyntheticHonoContext(payload) {
    const method = String(payload.method ?? "WS");
    const path = String(payload.path ?? "/");
    const query = String(payload.query ?? "");
    const fullUrl = `http://local${path}${query}`;
    const headersIn = payload.headers ?? {};
    const paramsIn = payload.params ?? {};
    const headers = new Headers();
    for (const [k, v] of Object.entries(headersIn)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const req = {
      method,
      path,
      url: fullUrl,
      raw: { headers },
      json: async () => payload.body,
      param: (name) => {
        if (name) return paramsIn?.[name];
        return paramsIn;
      },
      header: (name) => headers.get(name),
      text: async () => {
        try {
          return JSON.stringify(payload.body ?? {});
        } catch {
          return "";
        }
      }
    };
    const ctx = {
      req,
      // Return a Response for JSON
      json: (object, initOrStatus) => {
        let init;
        if (typeof initOrStatus === "number") {
          init = { status: initOrStatus };
        } else {
          init = initOrStatus;
        }
        const headers2 = new Headers(init?.headers);
        if (!headers2.has("content-type")) {
          headers2.set("content-type", "application/json");
        }
        return new Response(JSON.stringify(object), {
          ...init,
          headers: headers2
        });
      },
      text: (body, initOrStatus) => {
        let init;
        if (typeof initOrStatus === "number") {
          init = { status: initOrStatus };
        } else {
          init = initOrStatus;
        }
        return new Response(body, init);
      }
    };
    return ctx;
  }
  /** Convert a Response to an UpstreamResponseEnvelope */
  async responseToEnvelope(resp) {
    const headers = {};
    resp.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = await resp.text();
    return {
      status: resp.status,
      headers,
      body
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RowstRoute
});
//# sourceMappingURL=index.cjs.map