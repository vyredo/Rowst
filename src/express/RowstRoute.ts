import type { Context as HonoContext } from "hono";
import type { AsyncResolver } from "../core/AsyncResolver.js";
import type { Message } from "../core/types.js";
import type {
  Origin,
  RowstHandler,
  RowstRouteConfig,
  RowstRouteContext,
  RowstRouteOptions,
  UpstreamRequestPayload,
  UpstreamResponse,
  UpstreamResponseEnvelope,
  WebSocketContext,
} from "./types.js";

/**
 * RowstRoute provides an Express-like API for integrating HTTP REST endpoints
 * with WebSocket event handlers via AsyncResolver.
 *
 * @example
 * ```typescript
 * const app = new Hono();
 * const resolver = new AsyncResolver(transport);
 * const routes = new RowstRoute({ app, resolver });
 *
 * routes.post(
 *   { rest: "/api/comments", event: "get_comment" },
 *   async (ctx) => {
 *     const data = await ctx.body();
 *     return ctx.json({ ok: true, origin: ctx.origin });
 *   }
 * );
 * ```
 */
export class RowstRoute {
  private readonly app: RowstRouteOptions["app"];
  private readonly resolver: AsyncResolver;
  // Keep an event → handler registry so we can also serve direct WebSocket requests
  private readonly eventRegistry = new Map<string, RowstHandler>();

  constructor(options: RowstRouteOptions) {
    this.app = options.app;
    this.resolver = options.resolver;
  }

  /**
   * Register a GET route
   */
  get(config: RowstRouteConfig, handler: RowstHandler): void {
    this.registerRoute("GET", config, handler);
  }

  /**
   * Register a POST route
   */
  post(config: RowstRouteConfig, handler: RowstHandler): void {
    this.registerRoute("POST", config, handler);
  }

  /**
   * Register a PUT route
   */
  put(config: RowstRouteConfig, handler: RowstHandler): void {
    this.registerRoute("PUT", config, handler);
  }

  /**
   * Register a DELETE route
   */
  delete(config: RowstRouteConfig, handler: RowstHandler): void {
    this.registerRoute("DELETE", config, handler);
  }

  /**
   * Register a PATCH route
   */
  patch(config: RowstRouteConfig, handler: RowstHandler): void {
    this.registerRoute("PATCH", config, handler);
  }

  /**
   * Register a route for all HTTP methods
   */
  all(config: RowstRouteConfig, handler: RowstHandler): void {
    this.registerRoute("ALL", config, handler);
  }

  /**
   * Internal method to register a route with the Hono app
   */
  private registerRoute(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL",
    config: RowstRouteConfig,
    handler: RowstHandler,
  ): void {
    const honoHandler = async (honoContext: HonoContext): Promise<Response> => {
      try {
        const ctx = this.createHttpContext(honoContext, config);
        const result = await handler(ctx);

        // HTTP origin must return a Response
        if (result instanceof Response) {
          return result;
        }

        // If handler didn't return Response, create a default one
        return new Response(null, { status: 204 });
      } catch (e) {
        const message = (e as Error)?.message ?? "Handler error";
        return new Response(JSON.stringify({ error: message }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    };

    // Also register handler for direct WebSocket serving by event
    try {
      if (config?.event && typeof config.event === "string") {
        this.eventRegistry.set(config.event, handler);
      }
    } catch {
      // ignore registry errors
    }

    // Register with Hono based on method
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
  private createHttpContext(
    honoContext: HonoContext,
    config: RowstRouteConfig,
  ): RowstRouteContext {
    const origin: Origin = "http";
    let pendingStatus: number | undefined;
    let pendingHeaders: Record<string, string> | undefined;

    // Extract headers
    const headers: Record<string, string> = {};
    honoContext.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Extract query
    const url = new URL(honoContext.req.url);
    const query = url.search || "";

    // Extract params
    const params: Record<string, string> = {};
    // Hono doesn't expose all params easily, so we'll try to get them
    try {
      const paramKeys = honoContext.req.param();
      if (paramKeys && typeof paramKeys === "object") {
        Object.assign(params, paramKeys);
      }
    } catch {
      // params not available
    }

    // Create WebSocket context for upstream communication
    const websocketContext = this.createWebSocketContext(
      honoContext,
      config,
      origin,
    );

    const ctx: RowstRouteContext & any = {
      origin,
      forwardingHttp: true,
      meta: { forwarded: false },
      honoContext: honoContext,
      websocketContext: websocketContext,

      body: async <T = unknown>(): Promise<T> => {
        // Try to parse JSON body
        try {
          return (await honoContext.req.json()) as T;
        } catch {
          // If JSON parsing fails, try text
          try {
            const text = await honoContext.req.text();
            // Try to parse text as JSON
            try {
              return JSON.parse(text) as T;
            } catch {
              // Return text as-is
              return text as T;
            }
          } catch {
            // Return empty object as fallback
            return {} as T;
          }
        }
      },

      json: (
        data: unknown,
        init?: { status?: number; headers?: Record<string, string> },
      ): Response => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = new Headers(init?.headers ?? pendingHeaders);
        if (!responseHeaders.has("content-type")) {
          responseHeaders.set("content-type", "application/json");
        }

        // Reset pending status/headers
        pendingStatus = undefined;
        pendingHeaders = undefined;

        return new Response(JSON.stringify(data), {
          status,
          headers: responseHeaders,
        });
      },

      text: (
        body: string,
        init?: { status?: number; headers?: Record<string, string> },
      ): Response => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = new Headers(init?.headers ?? pendingHeaders);

        // Reset pending status/headers
        pendingStatus = undefined;
        pendingHeaders = undefined;

        return new Response(body, {
          status,
          headers: responseHeaders,
        });
      },

      status: (code: number): void => {
        pendingStatus = code;
      },

      headers,
      query,
      params,

      notify: (payload: unknown): void => {
        this.resolver.notify(payload);
      },

      forward: async <T = unknown>(
        payload?: unknown,
        opts?: { timeout?: number; retries?: number },
      ): Promise<T> => {
        const requestPayload = await this.buildRequestPayload(
          honoContext,
          config.event,
          payload,
        );

        const timeout = opts?.timeout ?? config.timeoutMs;

        let message: Message<unknown>;
        if (opts?.retries !== undefined && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(requestPayload, {
            timeout,
            retries: opts.retries,
            meta: { event: config.event },
          });
        } else {
          message = await this.resolver.request(requestPayload, {
            timeout,
            meta: { event: config.event },
          });
        }

        const response = this.parseResponse<T>(message);
        return response.data as T;
      },

      _honoContext: honoContext,
      _websocketContext: websocketContext,
    };

    return ctx;
  }

  /**
   * Create a WebSocket context for the current request
   */
  private createWebSocketContext(
    honoContext: HonoContext,
    config: RowstRouteConfig,
    origin: Origin,
  ): WebSocketContext {
    return {
      connected: this.resolver.isReady(),

      request: async <T = unknown>(
        payload?: unknown,
        opts?: { timeout?: number; retries?: number },
      ): Promise<UpstreamResponse<T>> => {
        // Build the request payload
        const requestPayload = await this.buildRequestPayload(
          honoContext,
          config.event,
          payload,
        );

        // Determine timeout
        const timeout = opts?.timeout ?? config.timeoutMs;

        // Make the request
        let message: Message<unknown>;
        if (opts?.retries !== undefined && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(requestPayload, {
            timeout,
            retries: opts.retries,
            meta: { event: config.event },
          });
        } else {
          message = await this.resolver.request(requestPayload, {
            timeout,
            meta: { event: config.event },
          });
        }

        // Parse the response
        return this.parseResponse<T>(message);
      },

      send: (
        payload?: unknown,
        init?: { status?: number; headers?: Record<string, string> },
      ): void => {
        // For HTTP origin, send is fire-and-forget notification
        if (origin === "http") {
          const notificationPayload: Record<string, unknown> = {
            event: config.event,
            method: honoContext.req.method,
            path: honoContext.req.path,
          };

          if (payload !== undefined) {
            notificationPayload.data = payload;
          }

          this.resolver.notify(notificationPayload);
        }
        // For WS origin, this will be handled in createWsContext
      },
    };
  }

  /**
   * Build the request payload to send to upstream
   */
  private async buildRequestPayload(
    honoContext: HonoContext,
    event: string,
    overridePayload?: unknown,
  ): Promise<UpstreamRequestPayload> {
    const method = honoContext.req.method;
    const path = honoContext.req.path;
    const url = new URL(honoContext.req.url);
    const query = url.search || undefined;

    // Extract headers
    const headers: Record<string, string> = {};
    honoContext.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Extract body if present and not overridden
    let body: unknown = undefined;
    if (overridePayload !== undefined) {
      body = overridePayload;
    } else if (
      method !== "GET" &&
      method !== "HEAD" &&
      headers["content-type"]?.includes("application/json")
    ) {
      try {
        body = await honoContext.req.json();
      } catch {
        // If JSON parsing fails, leave body undefined
      }
    }

    return {
      method,
      path,
      query,
      headers,
      body,
      event,
    };
  }

  /**
   * Parse the response from upstream into a structured format
   */
  private parseResponse<T>(message: Message<unknown>): UpstreamResponse<T> {
    const payload = message.payload as UpstreamResponseEnvelope | unknown;

    // Check if payload matches the expected envelope structure with body/bodyText
    if (
      payload &&
      typeof payload === "object" &&
      "status" in payload &&
      typeof (payload as UpstreamResponseEnvelope).status === "number"
    ) {
      const envelope = payload as UpstreamResponseEnvelope;

      // Handle both 'body' and 'bodyText' fields
      const bodyText = envelope.body ?? (envelope as any).bodyText ?? "";
      let data: T | undefined;

      // Try to parse JSON body
      if (bodyText) {
        try {
          data = JSON.parse(bodyText) as T;
        } catch {
          // Not JSON, leave data undefined
        }
      }

      return {
        status: envelope.status,
        headers: envelope.headers ?? {},
        bodyText,
        data,
        message,
      };
    }

    // Fallback: treat entire payload as data
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify(payload),
      data: payload as T,
      message,
    };
  }

  /**
   * Attach a Node-style WebSocket server (e.g., ws.WebSocketServer) to handle
   * Rowst "request" envelopes directly using the SAME registered handlers.
   * Each incoming WS "request" must contain payload.event set to the event name.
   * Replies are sent as Rowst "response" envelopes with the same id.
   */
  attachWebSocketServer(server: {
    on(event: "connection", cb: (socket: any) => void): void;
  }): void {
    if (!server || typeof server.on !== "function") {
      throw new Error(
        "attachWebSocketServer(server) requires a WebSocket server with .on('connection')",
      );
    }

    server.on("connection", (socket: any) => {
      if (
        !socket ||
        typeof socket.on !== "function" ||
        typeof socket.send !== "function"
      ) {
        return;
      }

      socket.on("message", async (raw: unknown) => {
        let text = "";
        try {
          if (typeof raw === "string") {
            text = raw;
          } else if (raw && typeof (raw as any).toString === "function") {
            // Node 'ws' Buffer
            text = (raw as any).toString("utf8");
          } else {
            text = String(raw ?? "");
          }

          const msg = JSON.parse(text) as Message<unknown>;

          if (!msg || msg.type !== "request") {
            // Only handle Rowst "request" envelopes here
            return;
          }

          const payload = (msg.payload ?? {}) as Record<string, unknown>;
          const event = String((payload as any).event ?? "");

          const handler = this.eventRegistry.get(event);
          if (!handler) {
            const notFound = {
              id: msg.id,
              type: "response",
              payload: {
                status: 404,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  error: `No handler for event '${event}'`,
                }),
              },
              timestamp: new Date().toISOString(),
            };
            socket.send(JSON.stringify(notFound));
            return;
          }

          // Build unified context for WS origin
          const ctx = this.createWsContext(payload, event, socket, msg.id);

          // Invoke the SAME registered handler
          let response: Response | void;
          try {
            response = await handler(ctx);
          } catch (handlerError) {
            // Handler threw an error
            const errorEnvelope = {
              id: msg.id,
              type: "response",
              payload: {
                status: 500,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  error: (handlerError as Error)?.message ?? "Handler error",
                }),
              },
              timestamp: new Date().toISOString(),
            };
            socket.send(JSON.stringify(errorEnvelope));
            return;
          }

          // If handler returned a Response, convert it to Rowst envelope
          if (response instanceof Response) {
            const envelope = await this.responseToEnvelope(response);
            const wsResponse: Message<UpstreamResponseEnvelope> = {
              id: msg.id,
              type: "response",
              payload: envelope,
              timestamp: new Date().toISOString(),
            };
            socket.send(JSON.stringify(wsResponse));
          }
          // If handler returned void, it should have called ctx.json/text/send
          // which already sent the response
        } catch (e) {
          const errorPayload = {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              error: "Invalid WS request",
              details: (e as Error)?.message,
            }),
          };
          try {
            const fallback = {
              id: (JSON.parse(text)?.id as string) ?? "",
              type: "response",
              payload: errorPayload,
              timestamp: new Date().toISOString(),
            };
            socket.send(JSON.stringify(fallback));
          } catch {
            // if parsing failed completely, just send a generic error without id
            const fallback = {
              id: "",
              type: "response",
              payload: errorPayload,
              timestamp: new Date().toISOString(),
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
  private createWsContext(
    payload: Record<string, unknown>,
    event: string,
    socket: any,
    requestId: string,
  ): RowstRouteContext {
    const origin: Origin = "ws";
    let pendingStatus: number | undefined;
    let pendingHeaders: Record<string, string> | undefined;
    let responded = false;

    // Extract metadata from payload
    const headers = ((payload as any).headers ?? {}) as Record<string, string>;
    const query = String((payload as any).query ?? "");
    const params = ((payload as any).params ?? {}) as Record<string, string>;

    // Build synthetic HonoContext
    const honoContext = this.createSyntheticHonoContext(payload);

    // Helper to send WS response
    const sendWsResponse = (
      status: number,
      responseHeaders: Record<string, string>,
      body: string,
    ): void => {
      if (responded) return;
      responded = true;

      const wsResponse = {
        id: requestId,
        type: "response",
        payload: {
          status,
          headers: responseHeaders,
          body,
        },
        timestamp: new Date().toISOString(),
      };

      socket.send(JSON.stringify(wsResponse));
    };

    // Create WebSocket context
    const websocketContext: WebSocketContext = {
      connected: this.resolver.isReady(),

      request: async <T = unknown>(
        overrideBody?: unknown,
        opts?: { timeout?: number; retries?: number },
      ): Promise<UpstreamResponse<T>> => {
        // Forward to upstream if needed
        const forwardPayload: UpstreamRequestPayload = {
          method: String((payload as any).method ?? "WS"),
          path: String((payload as any).path ?? "/"),
          query: (payload as any).query as string | undefined,
          headers: (payload as any).headers as
            | Record<string, string>
            | undefined,
          body: overrideBody ?? (payload as any).body,
          event,
        };

        let message: Message<unknown>;
        if (opts?.retries && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(forwardPayload, {
            timeout: opts?.timeout,
            retries: opts?.retries,
            meta: { event },
          });
        } else {
          message = await this.resolver.request(forwardPayload, {
            timeout: opts?.timeout,
            meta: { event },
          });
        }

        return this.parseResponse<T>(message);
      },

      send: (
        fireAndForget?: unknown,
        init?: { status?: number; headers?: Record<string, string> },
      ): void => {
        // For WS origin, send acts as respond
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = init?.headers ?? pendingHeaders ?? {};
        if (!responseHeaders["content-type"]) {
          responseHeaders["content-type"] = "application/json";
        }

        const body = JSON.stringify(fireAndForget);
        sendWsResponse(status, responseHeaders, body);

        // Reset pending
        pendingStatus = undefined;
        pendingHeaders = undefined;
      },
    };

    const ctx: RowstRouteContext & any = {
      origin,
      forwardingHttp: false,
      meta: { requestId, forwarded: false, transport: "ws" },
      honoContext: honoContext,
      websocketContext: websocketContext,

      body: async <T = unknown>(): Promise<T> => {
        // For WS, return payload.body or payload itself
        const bodyData = (payload as any).body ?? payload;
        return bodyData as T;
      },

      json: (
        data: unknown,
        init?: { status?: number; headers?: Record<string, string> },
      ): void => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = init?.headers ?? pendingHeaders ?? {};
        if (!responseHeaders["content-type"]) {
          responseHeaders["content-type"] = "application/json";
        }

        const body = JSON.stringify(data);
        sendWsResponse(status, responseHeaders, body);

        // Reset pending
        pendingStatus = undefined;
        pendingHeaders = undefined;
      },

      text: (
        body: string,
        init?: { status?: number; headers?: Record<string, string> },
      ): void => {
        const status = init?.status ?? pendingStatus ?? 200;
        const responseHeaders = init?.headers ?? pendingHeaders ?? {};

        sendWsResponse(status, responseHeaders, body);

        // Reset pending
        pendingStatus = undefined;
        pendingHeaders = undefined;
      },

      status: (code: number): void => {
        pendingStatus = code;
      },

      headers,
      query,
      params,

      notify: (notifyPayload: unknown): void => {
        this.resolver.notify(notifyPayload);
      },

      forward: async <T = unknown>(
        forwardPayload?: unknown,
        opts?: { timeout?: number; retries?: number },
      ): Promise<T> => {
        const requestPayload: UpstreamRequestPayload = {
          method: String((payload as any).method ?? "WS"),
          path: String((payload as any).path ?? "/"),
          query: (payload as any).query as string | undefined,
          headers: (payload as any).headers as
            | Record<string, string>
            | undefined,
          body: forwardPayload ?? (payload as any).body,
          event,
        };

        let message: Message<unknown>;
        if (opts?.retries && opts.retries > 0) {
          message = await this.resolver.requestWithRetry(requestPayload, {
            timeout: opts?.timeout,
            retries: opts?.retries,
            meta: { event },
          });
        } else {
          message = await this.resolver.request(requestPayload, {
            timeout: opts?.timeout,
            meta: { event },
          });
        }

        const response = this.parseResponse<T>(message);
        return response.data as T;
      },

      _honoContext: honoContext,
      _websocketContext: websocketContext,
    };

    return ctx;
  }

  /** Create a minimal Hono-like context backed by the WS payload */
  private createSyntheticHonoContext(
    payload: Record<string, unknown>,
  ): HonoContext {
    const method = String((payload as any).method ?? "WS");
    const path = String((payload as any).path ?? "/");
    const query = String((payload as any).query ?? "");
    const fullUrl = `http://local${path}${query}`;
    const headersIn = ((payload as any).headers ?? {}) as Record<
      string,
      string
    >;
    const paramsIn = ((payload as any).params ?? {}) as Record<string, string>;

    const headers = new Headers();
    for (const [k, v] of Object.entries(headersIn)) {
      if (typeof v === "string") headers.set(k, v);
    }

    const req = {
      method,
      path,
      url: fullUrl,
      raw: { headers },
      json: async () => (payload as any).body,
      param: (name?: string) => {
        if (name) return paramsIn?.[name];
        return paramsIn;
      },
      header: (name: string) => headers.get(name),
      text: async () => {
        try {
          return JSON.stringify((payload as any).body ?? {});
        } catch {
          return "";
        }
      },
    };

    const ctx: any = {
      req,
      // Return a Response for JSON
      json: (object: unknown, initOrStatus?: number | ResponseInit) => {
        let init: ResponseInit | undefined;
        if (typeof initOrStatus === "number") {
          init = { status: initOrStatus };
        } else {
          init = initOrStatus;
        }
        const headers = new Headers(init?.headers);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        return new Response(JSON.stringify(object), {
          ...init,
          headers,
        });
      },
      text: (body: string, initOrStatus?: number | ResponseInit) => {
        let init: ResponseInit | undefined;
        if (typeof initOrStatus === "number") {
          init = { status: initOrStatus };
        } else {
          init = initOrStatus;
        }
        return new Response(body, init);
      },
    };

    return ctx as HonoContext;
  }

  /** Convert a Response to an UpstreamResponseEnvelope */
  private async responseToEnvelope(
    resp: Response,
  ): Promise<UpstreamResponseEnvelope> {
    const headers: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = await resp.text();
    return {
      status: resp.status,
      headers,
      body,
    };
  }
}
