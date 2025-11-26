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
      const websocketContext = this.createWebSocketContext(honoContext, config);
      const ctx = {
        honoContext,
        websocketContext
      };
      return handler(ctx);
    };
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
   * Create a WebSocket context for the current request
   */
  createWebSocketContext(honoContext, config) {
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
      send: (payload) => {
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
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RowstRoute
});
//# sourceMappingURL=index.cjs.map