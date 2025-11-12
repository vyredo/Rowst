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

// src/transports/index.ts
var transports_exports = {};
__export(transports_exports, {
  WebRTCTransport: () => WebRTCTransport,
  WebSocketTransport: () => WebSocketTransport
});
module.exports = __toCommonJS(transports_exports);

// src/core/logger.ts
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["SILENT"] = 0] = "SILENT";
  LogLevel2[LogLevel2["ERROR"] = 1] = "ERROR";
  LogLevel2[LogLevel2["WARN"] = 2] = "WARN";
  LogLevel2[LogLevel2["INFO"] = 3] = "INFO";
  LogLevel2[LogLevel2["DEBUG"] = 4] = "DEBUG";
  LogLevel2[LogLevel2["TRACE"] = 5] = "TRACE";
  return LogLevel2;
})(LogLevel || {});
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
var ConsoleTransport = class {
  log(level, message, meta) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const levelName = LogLevel[level];
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    const formatted = `[${timestamp}] [${levelName}] ${message}${metaStr}`;
    switch (level) {
      case 1 /* ERROR */:
        console.error(formatted);
        break;
      case 2 /* WARN */:
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  }
};

// src/transports/WebSocketTransport.ts
var READY_STATE_MAP = {
  0: "connecting",
  1: "open",
  2: "closing",
  3: "closed"
};
var createDefaultLogger = (level = 1 /* ERROR */) => new Logger({
  level,
  transports: [new ConsoleTransport()],
  prefix: "WebSocketTransport"
});
var WebSocketTransport = class {
  constructor(socket, options = {}) {
    this.listeners = {
      message: /* @__PURE__ */ new Set(),
      open: /* @__PURE__ */ new Set(),
      close: /* @__PURE__ */ new Set(),
      error: /* @__PURE__ */ new Set()
    };
    this.messageListener = (event) => {
      this.dispatchMessage(event.data);
    };
    this.openListener = () => {
      this.dispatch("open");
    };
    this.closeListener = (event) => {
      this.dispatch("close", event);
    };
    this.errorListener = (event) => {
      const error = event.error ?? new Error("WebSocket error event");
      this.dispatch("error", error instanceof Error ? error : new Error(String(error)));
    };
    this.handleNodeMessage = (...args) => {
      const [data] = args;
      this.dispatchMessage(data);
    };
    this.handleNodeOpen = () => {
      this.dispatch("open");
    };
    this.handleNodeClose = (...args) => {
      const [code, reason] = args;
      const reasonText = typeof reason === "string" ? reason : typeof Buffer !== "undefined" && Buffer.isBuffer(reason) ? reason.toString("utf8") : void 0;
      this.dispatch("close", { code, reason: reasonText });
    };
    this.handleNodeError = (...args) => {
      const [error] = args;
      const err = error instanceof Error ? error : new Error(String(error));
      this.dispatch("error", err);
    };
    if (!socket) {
      throw new Error("WebSocket instance is required");
    }
    this.socket = socket;
    this.logger = options.logger ?? createDefaultLogger(options.logLevel);
    if (options.binaryType && "binaryType" in this.socket) {
      this.socket.binaryType = options.binaryType;
    }
    this.bindSocketEvents();
  }
  get readyState() {
    return READY_STATE_MAP[this.socket.readyState] ?? "closed";
  }
  send(data) {
    if (this.readyState !== "open") {
      throw new Error("WebSocket is not open");
    }
    try {
      const payload = typeof data === "string" ? data : data instanceof ArrayBuffer ? data : data;
      this.socket.send(payload);
    } catch (error) {
      this.logger.error("Failed to send WebSocket message", { error });
      throw error;
    }
  }
  close() {
    try {
      this.cleanupListeners?.();
      this.cleanupListeners = void 0;
      this.socket.close();
    } catch (error) {
      this.logger.warn("Failed to close WebSocket gracefully", { error });
    }
  }
  on(event, handler) {
    this.listeners[event].add(handler);
  }
  off(event, handler) {
    this.listeners[event].delete(handler);
  }
  bindSocketEvents() {
    const addListener = this.socket.addEventListener?.bind(this.socket);
    const removeListener = this.socket.removeEventListener?.bind(this.socket);
    if (addListener) {
      addListener("message", this.messageListener);
      addListener("open", this.openListener);
      addListener("close", this.closeListener);
      addListener("error", this.errorListener);
      if (removeListener) {
        this.cleanupListeners = () => {
          removeListener("message", this.messageListener);
          removeListener("open", this.openListener);
          removeListener("close", this.closeListener);
          removeListener("error", this.errorListener);
        };
      }
      return;
    }
    if (typeof this.socket.on === "function") {
      const on = this.socket.on.bind(this.socket);
      const off = this.socket.off?.bind(this.socket) ?? this.socket.removeListener?.bind(this.socket);
      on("message", this.handleNodeMessage);
      on("open", this.handleNodeOpen);
      on("close", this.handleNodeClose);
      on("error", this.handleNodeError);
      if (off) {
        this.cleanupListeners = () => {
          off("message", this.handleNodeMessage);
          off("open", this.handleNodeOpen);
          off("close", this.handleNodeClose);
          off("error", this.handleNodeError);
        };
      }
      return;
    }
    this.socket.onmessage = this.messageListener;
    this.socket.onopen = this.openListener;
    this.socket.onclose = this.closeListener;
    this.socket.onerror = this.errorListener;
    this.cleanupListeners = () => {
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
    };
  }
  dispatch(event, payload) {
    const handlers = this.listeners[event];
    if (handlers.size === 0) {
      return;
    }
    for (const handler of handlers) {
      try {
        if (typeof payload === "undefined") {
          handler();
        } else {
          handler(payload);
        }
      } catch (error) {
        this.logger.error(`Transport handler for event "${event}" threw`, { error });
      }
    }
  }
  dispatchMessage(data) {
    if (this.listeners.message.size === 0) {
      return;
    }
    const normalized = this.normalizeData(data);
    if (normalized === null) {
      this.logger.warn("Unsupported WebSocket message payload", { type: typeof data });
      return;
    }
    for (const handler of this.listeners.message) {
      try {
        handler(normalized);
      } catch (error) {
        this.logger.error("Message handler threw an error", { error });
      }
    }
  }
  normalizeData(data) {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data;
      return new Uint8Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
      );
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      const buffer = data;
      return new Uint8Array(buffer);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then((buffer) => this.dispatchMessage(new Uint8Array(buffer))).catch((error) => {
        this.logger.error("Failed to decode Blob message", { error });
      });
      return null;
    }
    return null;
  }
};

// src/transports/WebRTCTransport.ts
var createDefaultLogger2 = (level = 1 /* ERROR */) => new Logger({
  level,
  transports: [new ConsoleTransport()],
  prefix: "WebRTCTransport"
});
function cloneToArrayBuffer(view) {
  const buffer = view.buffer;
  const start = view.byteOffset;
  const end = start + view.byteLength;
  if (typeof buffer.slice === "function") {
    return buffer.slice(start, end);
  }
  const result = new ArrayBuffer(view.byteLength);
  new Uint8Array(result).set(new Uint8Array(buffer, start, view.byteLength));
  return result;
}
var WebRTCTransport = class _WebRTCTransport {
  constructor(channel, options = {}) {
    this.listeners = {
      message: /* @__PURE__ */ new Set(),
      open: /* @__PURE__ */ new Set(),
      close: /* @__PURE__ */ new Set(),
      error: /* @__PURE__ */ new Set()
    };
    this.messageListener = (event) => {
      this.dispatchMessage(event.data);
    };
    this.openListener = () => {
      this.dispatch("open");
    };
    this.closeListener = () => {
      this.dispatch("close");
    };
    this.errorListener = (event) => {
      const rtcError = event.error;
      const error = rtcError instanceof Error ? rtcError : new Error("RTCDataChannel error event");
      this.dispatch("error", error);
    };
    if (!channel) {
      throw new Error("RTCDataChannel instance is required");
    }
    this.channel = channel;
    this.logger = options.logger ?? createDefaultLogger2(options.logLevel);
    this.bindChannelEvents();
  }
  static create(peer, label, options) {
    const channel = peer.createDataChannel(label, {
      ordered: options?.ordered,
      maxRetransmits: options?.maxRetransmits,
      negotiated: options?.negotiated,
      id: options?.id,
      protocol: options?.protocol
    });
    return new _WebRTCTransport(channel, options);
  }
  get readyState() {
    switch (this.channel.readyState) {
      case "connecting":
        return "connecting";
      case "open":
        return "open";
      case "closing":
        return "closing";
      case "closed":
      default:
        return "closed";
    }
  }
  send(data) {
    if (this.readyState !== "open") {
      throw new Error("RTCDataChannel is not open");
    }
    try {
      if (typeof data === "string") {
        this.channel.send(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.channel.send(data);
        return;
      }
      const buffer = cloneToArrayBuffer(data);
      this.channel.send(buffer);
    } catch (error) {
      this.logger.error("Failed to send RTC message", { error });
      throw error;
    }
  }
  close() {
    try {
      this.channel.close();
    } catch (error) {
      this.logger.warn("Failed to close RTCDataChannel gracefully", { error });
    }
  }
  on(event, handler) {
    this.listeners[event].add(handler);
  }
  off(event, handler) {
    this.listeners[event].delete(handler);
  }
  bindChannelEvents() {
    if (typeof this.channel.addEventListener === "function") {
      this.channel.addEventListener("message", this.messageListener);
      this.channel.addEventListener("open", this.openListener);
      this.channel.addEventListener("close", this.closeListener);
      this.channel.addEventListener("error", this.errorListener);
    } else {
      this.channel.onmessage = this.messageListener;
      this.channel.onopen = this.openListener;
      this.channel.onclose = this.closeListener;
      this.channel.onerror = this.errorListener;
    }
  }
  dispatch(event, payload) {
    const handlers = this.listeners[event];
    if (handlers.size === 0) {
      return;
    }
    for (const handler of handlers) {
      try {
        if (typeof payload === "undefined") {
          handler();
        } else {
          handler(payload);
        }
      } catch (error) {
        this.logger.error(`Transport handler for event "${event}" threw`, { error });
      }
    }
  }
  dispatchMessage(data) {
    if (this.listeners.message.size === 0) {
      return;
    }
    const normalized = this.normalizeInbound(data);
    if (normalized === null) {
      this.logger.warn("Unsupported RTCDataChannel message payload", { type: typeof data });
      return;
    }
    for (const handler of this.listeners.message) {
      try {
        handler(normalized);
      } catch (error) {
        this.logger.error("Message handler threw an error", { error });
      }
    }
  }
  normalizeInbound(data) {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data;
      return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
    if (typeof globalThis !== "undefined") {
      const bufferCtor = globalThis.Buffer;
      if (bufferCtor && bufferCtor.isBuffer(data)) {
        const buffer = data;
        return buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength ? buffer : buffer.slice();
      }
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then((buffer) => this.dispatchMessage(new Uint8Array(buffer))).catch((error) => {
        this.logger.error("Failed to decode Blob message", { error });
      });
      return null;
    }
    return null;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WebRTCTransport,
  WebSocketTransport
});
//# sourceMappingURL=index.cjs.map