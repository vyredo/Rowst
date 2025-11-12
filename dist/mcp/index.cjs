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

// src/mcp/index.ts
var mcp_exports = {};
__export(mcp_exports, {
  RowstMCPServer: () => RowstMCPServer
});
module.exports = __toCommonJS(mcp_exports);

// src/core/uuid.ts
var getCrypto = /* @__PURE__ */ (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    if (typeof globalThis !== "undefined") {
      const candidate = globalThis.crypto ?? globalThis.webcrypto;
      if (candidate && typeof candidate.getRandomValues === "function") {
        cached = candidate;
        return cached;
      }
    }
    throw new Error("No crypto implementation available");
  };
})();
function generateUUID() {
  const bytes = new Uint8Array(16);
  getCrypto().getRandomValues(bytes);
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join("-");
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
var TransportError = class extends RowstError {
  constructor(message = "Transport error", details) {
    super(message, "TRANSPORT_ERROR", details);
    this.name = "TransportError";
  }
};
var BackpressureError = class extends RowstError {
  constructor(message = "Too many inflight requests", details) {
    super(message, "BACKPRESSURE", details);
    this.name = "BackpressureError";
  }
};
var InvalidMessageError = class extends RowstError {
  constructor(message = "Invalid message received", details) {
    super(message, "INVALID_MESSAGE", details);
    this.name = "InvalidMessageError";
  }
};

// src/core/logger.ts
var Logger = class {
  constructor(options) {
    this.options = options;
  }
  shouldLog(level) {
    return this.options.level >= level;
  }
  emit(level, message, meta) {
    if (!this.shouldLog(level)) return;
    const prefixedMessage = this.options.prefix ? `[${this.options.prefix}] ${message}` : message;
    for (const transport of this.options.transports) {
      try {
        transport.log(level, prefixedMessage, meta);
      } catch (error) {
        console.error("Logger transport failure", {
          level,
          message: prefixedMessage,
          meta,
          error
        });
      }
    }
  }
  error(message, meta) {
    this.emit(1 /* ERROR */, message, meta);
  }
  warn(message, meta) {
    this.emit(2 /* WARN */, message, meta);
  }
  info(message, meta) {
    this.emit(3 /* INFO */, message, meta);
  }
  debug(message, meta) {
    this.emit(4 /* DEBUG */, message, meta);
  }
  trace(message, meta) {
    this.emit(5 /* TRACE */, message, meta);
  }
  setLevel(level) {
    this.options.level = level;
  }
  addTransport(transport) {
    this.options.transports.push(transport);
  }
  removeTransport(transport) {
    const index = this.options.transports.indexOf(transport);
    if (index > -1) {
      this.options.transports.splice(index, 1);
    }
  }
};
var NoopTransport = class {
  log() {
  }
};

// src/core/AsyncResolver.ts
var DEFAULT_TIMEOUT = 3e4;
var DEFAULT_MAX_INFLIGHT = 1e3;
var DEFAULT_LATENCY_SAMPLE_SIZE = 1e3;
var DEFAULT_BACKOFF_MULTIPLIER = 2;
var DEFAULT_JITTER_FACTOR = 0.25;
var fallbackLogger = new Logger({
  level: 0 /* SILENT */,
  transports: [new NoopTransport()]
});
var textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
var bufferDecoder = (() => {
  if (typeof globalThis === "undefined") {
    return null;
  }
  const candidate = globalThis.Buffer;
  if (!candidate || typeof candidate.from !== "function") {
    return null;
  }
  return (input) => candidate.from(input).toString("utf8");
})();
function decodeTransportData(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    if (textDecoder) {
      return textDecoder.decode(new Uint8Array(data));
    }
    if (bufferDecoder) {
      return bufferDecoder(new Uint8Array(data));
    }
  }
  if (data instanceof Uint8Array) {
    if (textDecoder) {
      return textDecoder.decode(data);
    }
    if (bufferDecoder) {
      return bufferDecoder(data);
    }
  }
  throw new InvalidMessageError("Unsupported message data type");
}
function cloneOptions(options) {
  if (!options) return {};
  const clone = {};
  for (const [key, value] of Object.entries(options)) {
    clone[key] = Array.isArray(value) ? [...value] : value;
  }
  return clone;
}
function ensureLatencyStats(latencies) {
  if (latencies.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p50: 0,
      p95: 0,
      p99: 0
    };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / sorted.length;
  const percentile = (p) => {
    const index = Math.ceil(p / 100 * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  };
  const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99)
  };
}
var AsyncResolver = class {
  constructor(transport, options = {}) {
    this.pending = /* @__PURE__ */ new Map();
    this.metrics = {
      inflightCount: 0,
      totalRequests: 0,
      totalResponses: 0,
      totalTimeouts: 0,
      totalErrors: 0,
      latencies: []
    };
    this.handleMessage = (data) => {
      try {
        this.onTransportMessage(data);
      } catch (error) {
        this.logger.error("Failed to process transport message", this.describeError(error));
        this.metrics.totalErrors += 1;
      }
    };
    this.handleOpen = () => {
      this.logger.debug("Transport opened");
    };
    this.handleClose = (event) => {
      this.logger.warn("Transport closed", { event });
      this.rejectAllPending(new TransportClosedError("Transport closed", event));
    };
    this.handleError = (error) => {
      this.logger.error("Transport error", this.describeError(error));
      this.metrics.totalErrors += 1;
    };
    this.transport = transport;
    this.logger = options.logger ?? fallbackLogger;
    this.options = {
      defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
      maxInflight: options.maxInflight ?? DEFAULT_MAX_INFLIGHT,
      latencySampleSize: options.latencySampleSize ?? DEFAULT_LATENCY_SAMPLE_SIZE
    };
    this.transport.on("message", this.handleMessage);
    this.transport.on("open", this.handleOpen);
    this.transport.on("close", this.handleClose);
    this.transport.on("error", this.handleError);
  }
  async request(payload, options) {
    return this.requestAttempt(payload, options, 1);
  }
  async requestWithRetry(payload, options) {
    const retries = options?.retries ?? 0;
    let attempt = 1;
    let lastError;
    while (attempt <= retries + 1) {
      try {
        const response = await this.requestAttempt(payload, options, attempt);
        if (!response.meta) {
          response.meta = { attempts: attempt };
        } else {
          response.meta.attempts = attempt;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt > retries || this.shouldNotRetry(error)) {
          throw error;
        }
        const delay = this.calculateBackoffDelay(attempt, options);
        this.logger.warn("Request attempt failed, retrying", {
          attempt,
          retries,
          delay,
          error: this.describeError(error)
        });
        await this.wait(delay);
        attempt += 1;
      }
    }
    throw lastError ?? new TransportError("Request failed after retries");
  }
  notify(payload) {
    const message = {
      id: generateUUID(),
      type: "notification",
      payload,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.sendSerialized(message);
  }
  getInflightCount() {
    return this.pending.size;
  }
  getMetrics() {
    return {
      ...this.metrics,
      inflightCount: this.pending.size,
      stats: ensureLatencyStats(this.metrics.latencies)
    };
  }
  destroy() {
    this.transport.off("message", this.handleMessage);
    this.transport.off("open", this.handleOpen);
    this.transport.off("close", this.handleClose);
    this.transport.off("error", this.handleError);
    this.rejectAllPending(new TransportClosedError("Resolver destroyed"));
  }
  requestAttempt(payload, options, attempt) {
    if (this.transport.readyState === "closing" || this.transport.readyState === "closed") {
      throw new TransportClosedError();
    }
    if (this.pending.size >= this.options.maxInflight) {
      throw new BackpressureError(`Max inflight requests (${this.options.maxInflight}) exceeded`);
    }
    const requestId = generateUUID();
    const timeout = options?.timeout ?? this.options.defaultTimeout;
    const createdAt = Date.now();
    const meta = this.buildMeta(options, attempt);
    const requestMessage = {
      id: requestId,
      type: "request",
      payload,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      meta
    };
    this.metrics.totalRequests += 1;
    this.metrics.inflightCount = this.pending.size + 1;
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(requestId);
        this.metrics.totalTimeouts += 1;
        this.metrics.inflightCount = this.pending.size;
        const timeoutError = new TimeoutError(`Request ${requestId} timed out after ${timeout}ms`, {
          requestId,
          timeout
        });
        this.logger.warn("Request timed out", { requestId, timeout });
        reject(timeoutError);
      }, timeout);
      const pendingRequest = {
        resolve: (message) => {
          clearTimeout(timeoutHandle);
          this.metrics.totalResponses += 1;
          this.recordLatency(Date.now() - createdAt);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeoutHandle);
          this.metrics.totalErrors += 1;
          reject(error);
        },
        timeoutHandle,
        createdAt,
        attempts: attempt,
        meta
      };
      this.pending.set(requestId, pendingRequest);
      try {
        this.sendSerialized(requestMessage);
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pending.delete(requestId);
        this.metrics.inflightCount = this.pending.size;
        const transportError = error instanceof RowstError ? error : new TransportError("Failed to send request", error);
        this.logger.error("Failed to send request", {
          requestId,
          error: this.describeError(transportError)
        });
        reject(transportError);
      }
    });
  }
  sendSerialized(message) {
    try {
      const serialized = JSON.stringify(message);
      this.transport.send(serialized);
      this.logger.trace("Sent message", {
        id: message.id,
        type: message.type
      });
    } catch (error) {
      throw new TransportError("Transport send failed", error);
    }
  }
  onTransportMessage(data) {
    const raw = decodeTransportData(data);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InvalidMessageError("Received invalid JSON message", error);
    }
    this.validateMessage(parsed);
    if (parsed.type === "response") {
      this.handleResponse(parsed);
      return;
    }
    if (parsed.type === "notification") {
      this.logger.info("Received notification", { id: parsed.id, meta: parsed.meta });
      return;
    }
    this.logger.warn("Unhandled message type", { type: parsed.type, id: parsed.id });
  }
  handleResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.logger.warn("Received response for unknown request", { id: message.id });
      return;
    }
    this.pending.delete(message.id);
    this.metrics.inflightCount = this.pending.size;
    const latency = Date.now() - pending.createdAt;
    this.recordLatency(latency);
    if (!message.meta) {
      message.meta = {};
    }
    message.meta.attempts = pending.attempts;
    message.latency = latency;
    if (message.error) {
      const rowstError = new RowstError(message.error.message, message.error.code, message.error.details);
      rowstError.name = "RowstRemoteError";
      this.logger.warn("Request failed with remote error", {
        id: message.id,
        error: message.error
      });
      pending.reject(rowstError);
      return;
    }
    this.logger.debug("Resolved request", { id: message.id, latency });
    pending.resolve(message);
  }
  validateMessage(message) {
    if (typeof message !== "object" || message === null) {
      throw new InvalidMessageError("Message must be an object");
    }
    if (!message.id || typeof message.id !== "string") {
      throw new InvalidMessageError("Message is missing a string id");
    }
    if (!["request", "response", "notification"].includes(message.type)) {
      throw new InvalidMessageError("Unsupported message type");
    }
  }
  rejectAllPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
    }
    this.pending.clear();
    this.metrics.inflightCount = 0;
  }
  shouldNotRetry(error) {
    if (!(error instanceof RowstError)) return false;
    return error.code === "INVALID_MESSAGE" /* INVALID_MESSAGE */ || error.code === "BACKPRESSURE" /* BACKPRESSURE */;
  }
  calculateBackoffDelay(attempt, options) {
    const baseTimeout = options?.timeout ?? this.options.defaultTimeout;
    const multiplier = options?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    const jitterFactor = options?.jitterFactor ?? DEFAULT_JITTER_FACTOR;
    let delay = baseTimeout * Math.pow(multiplier, attempt - 1);
    if (jitterFactor > 0) {
      const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
      delay += jitter;
    }
    return Math.max(0, delay);
  }
  wait(duration) {
    if (duration <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      setTimeout(resolve, duration);
    });
  }
  recordLatency(latency) {
    const samples = this.metrics.latencies;
    samples.push(latency);
    if (samples.length > this.options.latencySampleSize) {
      samples.splice(0, samples.length - this.options.latencySampleSize);
    }
  }
  buildMeta(options, attempt) {
    const meta = cloneOptions(options);
    meta.attempts = attempt;
    delete meta.timeout;
    delete meta.retries;
    delete meta.jitterFactor;
    delete meta.backoffMultiplier;
    if (options?.tags) {
      meta.tags = [...options.tags];
    }
    return meta;
  }
  describeError(error) {
    if (error instanceof RowstError) {
      return {
        name: error.name,
        code: error.code,
        message: error.message,
        details: error.details
      };
    }
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
    return { error };
  }
};

// src/mcp/RowstMCPServer.ts
var RowstMCPServer = class {
  constructor() {
    this.resolvers = /* @__PURE__ */ new Map();
  }
  registerTransport(id, transport, options) {
    if (this.resolvers.has(id)) {
      throw new Error(`Transport ${id} already registered`);
    }
    const resolver = new AsyncResolver(transport, options);
    this.resolvers.set(id, resolver);
  }
  unregisterTransport(id) {
    const resolver = this.resolvers.get(id);
    if (!resolver) {
      return;
    }
    resolver.destroy();
    this.resolvers.delete(id);
  }
  async handleRequest(params) {
    const resolver = this.resolvers.get(params.transportId);
    if (!resolver) {
      throw new Error(`Transport ${params.transportId} not found`);
    }
    return await resolver.request(params.payload, params.options);
  }
  getMetrics(transportId) {
    const resolver = this.resolvers.get(transportId);
    if (!resolver) {
      throw new Error(`Transport ${transportId} not found`);
    }
    return resolver.getMetrics();
  }
  getMCPConfig() {
    return {
      name: "rowst",
      version: "0.1.0",
      tools: [
        {
          name: "rowst.request",
          description: "Send a request over a Rowst transport",
          inputSchema: {
            type: "object",
            properties: {
              transportId: { type: "string" },
              payload: { type: "object" },
              options: { type: "object" }
            },
            required: ["transportId", "payload"]
          }
        },
        {
          name: "rowst.metrics",
          description: "Get metrics for a Rowst transport",
          inputSchema: {
            type: "object",
            properties: {
              transportId: { type: "string" }
            },
            required: ["transportId"]
          }
        }
      ]
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RowstMCPServer
});
//# sourceMappingURL=index.cjs.map