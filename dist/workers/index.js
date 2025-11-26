// src/workers/WorkerPool.ts
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { dirname, isAbsolute, join } from "path";
import { cpus } from "os";
import { existsSync } from "fs";

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

// src/workers/WorkerPool.ts
var WorkerPool = class {
  constructor(options = {}) {
    this.workers = [];
    this.pendingTasks = /* @__PURE__ */ new Map();
    this.taskQueue = [];
    this.destroyed = false;
    const workerCount = options.workerCount ?? this.getOptimalWorkerCount();
    this.workerScript = this.resolveWorkerScript(options.workerScript);
    this.taskTimeout = options.taskTimeout ?? 1e4;
    this.logger = options.logger ?? new Logger({
      level: 3 /* INFO */,
      transports: [],
      prefix: "WorkerPool"
    });
    this.logger.info("Initializing worker pool", {
      workerCount,
      workerScript: this.workerScript
    });
    this.initializeWorkers(workerCount);
  }
  async execute(type, data, options) {
    if (this.destroyed) {
      throw new Error("Worker pool destroyed");
    }
    const id = generateUUID();
    const task = { id, type, data, options };
    return new Promise((resolve, reject) => {
      const resolver = (value) => resolve(value);
      const rejection = (error) => reject(error);
      const availableWorker = this.workers.find((worker) => !worker.busy && !worker.defunct);
      if (availableWorker) {
        this.executeTask(task, resolver, rejection, availableWorker);
      } else {
        this.taskQueue.push({ id, task, resolve: resolver, reject: rejection });
        this.logger.debug("Task queued", { id, queueLength: this.taskQueue.length });
      }
    });
  }
  getStats() {
    const workerCount = this.workers.length;
    const busyWorkers = this.workers.filter((worker) => worker.busy && !worker.defunct).length;
    const queueLength = this.taskQueue.length;
    const totalTasksCompleted = this.workers.reduce((sum, worker) => sum + worker.tasksCompleted, 0);
    const totalDuration = this.workers.reduce((sum, worker) => sum + worker.totalDuration, 0);
    const averageDuration = totalTasksCompleted > 0 ? totalDuration / totalTasksCompleted : 0;
    return {
      workerCount,
      busyWorkers,
      queueLength,
      totalTasksCompleted,
      averageDuration
    };
  }
  async destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.logger.info("Destroying worker pool");
    const destructionError = new Error("Worker pool destroyed");
    for (const pending of this.pendingTasks.values()) {
      clearTimeout(pending.timeout);
      pending.reject(destructionError);
    }
    this.pendingTasks.clear();
    for (const entry of this.taskQueue) {
      entry.reject(destructionError);
    }
    this.taskQueue = [];
    for (const pooledWorker of this.workers) {
      pooledWorker.defunct = true;
    }
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
    this.workers = [];
    this.logger.info("Worker pool destroyed");
  }
  initializeWorkers(count) {
    for (let i = 0; i < count; i++) {
      const pooledWorker = this.spawnWorker(i);
      if (pooledWorker) {
        this.workers.push(pooledWorker);
      }
    }
    this.logger.info("Worker pool initialized", { workerCount: this.workers.length });
  }
  spawnWorker(id) {
    try {
      const worker = new Worker(this.workerScript);
      const pooledWorker = {
        id,
        worker,
        busy: false,
        tasksCompleted: 0,
        totalDuration: 0,
        defunct: false
      };
      this.registerWorkerEvents(pooledWorker);
      return pooledWorker;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Failed to spawn worker", { workerId: id, error: message });
      return null;
    }
  }
  registerWorkerEvents(pooledWorker) {
    pooledWorker.worker.on("message", (message) => {
      this.handleWorkerMessage(pooledWorker, message);
    });
    pooledWorker.worker.on("error", (error) => {
      this.handleWorkerError(pooledWorker, error);
    });
    pooledWorker.worker.on("exit", (code) => {
      this.handleWorkerExit(pooledWorker, code);
    });
  }
  handleWorkerMessage(pooledWorker, message) {
    if (pooledWorker.defunct) {
      return;
    }
    if (message.ready) {
      this.logger.debug("Worker ready", { workerId: pooledWorker.id });
      return;
    }
    if (!message.id) {
      this.logger.warn("Received worker message without task id", { workerId: pooledWorker.id });
      return;
    }
    const pending = this.pendingTasks.get(message.id);
    if (!pending) {
      this.logger.warn("Received result for unknown task", { workerId: pooledWorker.id, taskId: message.id });
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingTasks.delete(message.id);
    pooledWorker.busy = false;
    pooledWorker.currentTaskId = void 0;
    pooledWorker.tasksCompleted += 1;
    pooledWorker.totalDuration += message.duration ?? 0;
    if (message.error) {
      const error = new Error(message.error.message);
      if (message.error.stack) {
        error.stack = message.error.stack;
      }
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
    this.processQueue();
  }
  handleWorkerError(pooledWorker, error) {
    if (pooledWorker.defunct) {
      return;
    }
    this.logger.error("Worker encountered error", {
      workerId: pooledWorker.id,
      error: error.message
    });
    this.rejectPendingTask(pooledWorker.currentTaskId, error);
    pooledWorker.busy = false;
    pooledWorker.currentTaskId = void 0;
    this.removeWorker(pooledWorker);
    if (!this.destroyed) {
      const replacement = this.spawnWorker(pooledWorker.id);
      if (replacement) {
        this.workers.push(replacement);
      }
    }
    this.processQueue();
  }
  handleWorkerExit(pooledWorker, code) {
    if (pooledWorker.defunct) {
      return;
    }
    const exitError = code === 0 ? null : new Error(`Worker exited with code ${code ?? "unknown"}`);
    if (exitError) {
      this.logger.error("Worker exited unexpectedly", {
        workerId: pooledWorker.id,
        code
      });
    } else {
      this.logger.debug("Worker exited", { workerId: pooledWorker.id, code });
    }
    this.rejectPendingTask(
      pooledWorker.currentTaskId,
      exitError ?? new Error("Worker terminated before completing task")
    );
    pooledWorker.busy = false;
    pooledWorker.currentTaskId = void 0;
    this.removeWorker(pooledWorker);
    if (!this.destroyed) {
      const replacement = this.spawnWorker(pooledWorker.id);
      if (replacement) {
        this.workers.push(replacement);
        this.processQueue();
      }
    }
  }
  rejectPendingTask(taskId, error) {
    if (!taskId) {
      return;
    }
    const pending = this.pendingTasks.get(taskId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingTasks.delete(taskId);
    pending.reject(error);
  }
  removeWorker(pooledWorker) {
    pooledWorker.defunct = true;
    this.workers = this.workers.filter((worker) => worker !== pooledWorker);
  }
  executeTask(task, resolve, reject, pooledWorker) {
    if (this.destroyed || pooledWorker.defunct) {
      reject(new Error("Worker pool destroyed"));
      return;
    }
    pooledWorker.busy = true;
    pooledWorker.currentTaskId = task.id;
    const timeout = setTimeout(() => {
      if (!this.pendingTasks.has(task.id)) {
        return;
      }
      this.pendingTasks.delete(task.id);
      pooledWorker.busy = false;
      pooledWorker.currentTaskId = void 0;
      const timeoutError = new Error(`Worker task timeout after ${this.taskTimeout}ms`);
      reject(timeoutError);
      this.logger.warn("Worker task timed out", {
        workerId: pooledWorker.id,
        taskId: task.id,
        timeout: this.taskTimeout
      });
      this.processQueue();
    }, this.taskTimeout);
    this.pendingTasks.set(task.id, {
      resolve,
      reject,
      timeout,
      startTime: Date.now()
    });
    try {
      pooledWorker.worker.postMessage(task);
      this.logger.trace("Task dispatched to worker", {
        workerId: pooledWorker.id,
        taskId: task.id
      });
    } catch (error) {
      clearTimeout(timeout);
      this.pendingTasks.delete(task.id);
      pooledWorker.busy = false;
      pooledWorker.currentTaskId = void 0;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Failed to post task to worker", {
        workerId: pooledWorker.id,
        taskId: task.id,
        error: message
      });
      reject(error instanceof Error ? error : new Error(message));
      this.processQueue();
    }
  }
  processQueue() {
    if (this.destroyed || this.taskQueue.length === 0) {
      return;
    }
    let availableWorker = this.workers.find((worker) => !worker.busy && !worker.defunct);
    while (availableWorker && this.taskQueue.length > 0) {
      const entry = this.taskQueue.shift();
      if (!entry) {
        break;
      }
      this.executeTask(entry.task, entry.resolve, entry.reject, availableWorker);
      availableWorker = this.workers.find((worker) => !worker.busy && !worker.defunct);
    }
  }
  getOptimalWorkerCount() {
    const hardwareConcurrency = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : void 0;
    if (typeof hardwareConcurrency === "number" && hardwareConcurrency > 1) {
      return Math.max(2, hardwareConcurrency - 1);
    }
    try {
      const cpuList = typeof cpus === "function" ? cpus() : [];
      if (cpuList.length > 1) {
        return Math.max(2, cpuList.length - 1);
      }
    } catch {
    }
    return 4;
  }
  resolveWorkerScript(scriptPath) {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    if (scriptPath) {
      if (isAbsolute(scriptPath)) {
        return scriptPath;
      }
      const candidateA = join(currentDir, scriptPath);
      if (existsSync(candidateA)) return candidateA;
      const candidateB = join(process.cwd(), scriptPath);
      if (existsSync(candidateB)) return candidateB;
    }
    const builtSibling = join(currentDir, "message-worker.js");
    if (existsSync(builtSibling)) return builtSibling;
    const distWorker = join(process.cwd(), "dist", "workers", "message-worker.js");
    if (existsSync(distWorker)) return distWorker;
    return builtSibling;
  }
};

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
    this.inflightByKey = /* @__PURE__ */ new Map();
    // Graceful shutdown guard
    this.shuttingDown = false;
    this.handleMessage = (data) => {
      void this.onTransportMessage(data).catch((error) => {
        this.logger.error(
          "Failed to process transport message",
          this.describeError(error)
        );
        this.metrics.totalErrors += 1;
      });
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
    this.responseInterceptor = options.responseInterceptor;
    this.options = {
      defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
      maxInflight: options.maxInflight ?? DEFAULT_MAX_INFLIGHT,
      latencySampleSize: options.latencySampleSize ?? DEFAULT_LATENCY_SAMPLE_SIZE
    };
    if (options.deduplicateRequests === true) {
      this.deduplicateFn = (payload) => JSON.stringify(payload);
    } else if (typeof options.deduplicateRequests === "function") {
      this.deduplicateFn = options.deduplicateRequests;
    }
    this.transport.on("message", this.handleMessage);
    this.transport.on("open", this.handleOpen);
    this.transport.on("close", this.handleClose);
    this.transport.on("error", this.handleError);
  }
  async request(payload, options) {
    if (this.shuttingDown) {
      throw new TransportClosedError("Resolver is closing");
    }
    if (this.deduplicateFn) {
      const cacheKey = this.deduplicateFn(payload);
      const existing = this.inflightByKey.get(cacheKey);
      if (existing) {
        this.logger.debug("Deduplicating request", { cacheKey });
        return existing;
      }
      const promise = this.requestAttempt(
        payload,
        options,
        1
      );
      this.inflightByKey.set(cacheKey, promise);
      promise.finally(() => {
        this.inflightByKey.delete(cacheKey);
      });
      return promise;
    }
    return this.requestAttempt(payload, options, 1);
  }
  async requestWithRetry(payload, options) {
    const retries = options?.retries ?? 0;
    let attempt = 1;
    let lastError;
    while (attempt <= retries + 1) {
      try {
        const response = await this.requestAttempt(
          payload,
          options,
          attempt
        );
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
      stats: ensureLatencyStats(this.metrics.latencies),
      // Add deduplication stats
      dedupCacheSize: this.inflightByKey.size
    };
  }
  /**
   * Wait for transport to reach 'open' state.
   * Resolves immediately if already open.
   * Rejects on timeout or if transport closes/errors.
   */
  async waitForReady(options) {
    const timeout = options?.timeout ?? 5e3;
    const throwOnTimeout = options?.throwOnTimeout ?? true;
    if (this.transport.readyState === "open") {
      return;
    }
    if (this.transport.readyState === "closed" || this.transport.readyState === "closing") {
      throw new TransportClosedError("Transport is not open");
    }
    return new Promise((resolve, reject) => {
      let timeoutHandle = null;
      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.transport.off("open", onOpen);
        this.transport.off("close", onClose);
        this.transport.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = (event) => {
        cleanup();
        reject(
          new TransportClosedError("Transport closed while waiting", event)
        );
      };
      const onError = (error) => {
        cleanup();
        reject(new TransportError("Transport error while waiting", error));
      };
      this.transport.on("open", onOpen);
      this.transport.on("close", onClose);
      this.transport.on("error", onError);
      timeoutHandle = setTimeout(() => {
        cleanup();
        if (throwOnTimeout) {
          reject(
            new TimeoutError(`Transport did not open within ${timeout}ms`)
          );
        } else {
          resolve();
        }
      }, timeout);
    });
  }
  /**
   * Check if transport is ready to send requests.
   */
  isReady() {
    return this.transport.readyState === "open";
  }
  /**
   * Get current transport state.
   */
  getTransportState() {
    return this.transport.readyState;
  }
  /**
   * Gracefully close the resolver.
   * - Stop accepting new requests
   * - Wait for pending requests to complete or timeout
   * - Close transport
   */
  async close(options) {
    const timeout = options?.timeout ?? 3e4;
    const force = options?.force ?? false;
    this.logger.info("Closing AsyncResolver", {
      pendingCount: this.pending.size,
      timeout,
      force
    });
    this.shuttingDown = true;
    if (this.pending.size === 0 || force) {
      this.destroy();
      this.transport.close();
      return;
    }
    const startTime = Date.now();
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        if (this.pending.size === 0) {
          clearInterval(checkInterval);
          this.destroy();
          this.transport.close();
          resolve();
          return;
        }
        if (elapsed >= timeout) {
          clearInterval(checkInterval);
          this.logger.warn("Close timeout reached, forcing shutdown", {
            remainingRequests: this.pending.size
          });
          this.destroy();
          this.transport.close();
          resolve();
        }
      }, 100);
    });
  }
  /**
   * Get detailed info about pending requests (for debugging).
   */
  getDebugInfo() {
    const now = Date.now();
    const pending = Array.from(this.pending.entries()).map(([id, req]) => ({
      id,
      age: now - req.createdAt,
      attempts: req.attempts,
      meta: req.meta
    }));
    return {
      pending,
      metrics: this.getMetrics(),
      transportState: this.transport.readyState
    };
  }
  /**
   * Enable/disable trace logging at runtime.
   */
  setLogLevel(level) {
    this.logger.setLevel(level);
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
      throw new BackpressureError(
        `Max inflight requests (${this.options.maxInflight}) exceeded`
      );
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
        const timeoutError = new TimeoutError(
          `Request ${requestId} timed out after ${timeout}ms`,
          {
            requestId,
            timeout
          }
        );
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
  async onTransportMessage(data) {
    const raw = decodeTransportData(data);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InvalidMessageError("Received invalid JSON message", error);
    }
    this.validateMessage(parsed);
    if (parsed.type === "response") {
      await this.handleResponse(parsed);
      return;
    }
    if (parsed.type === "notification") {
      this.logger.info("Received notification", {
        id: parsed.id,
        meta: parsed.meta
      });
      return;
    }
    this.logger.warn("Unhandled message type", {
      type: parsed.type,
      id: parsed.id
    });
  }
  async handleResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.logger.warn("Received response for unknown request", {
        id: message.id
      });
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
    let processedMessage = message;
    if (this.responseInterceptor) {
      try {
        processedMessage = await this.responseInterceptor(message);
      } catch (error) {
        this.logger.error("Response interceptor failed", {
          id: message.id,
          error: this.describeError(error)
        });
        pending.reject(error);
        return;
      }
    }
    if (processedMessage.error) {
      const rowstError = new RowstError(
        processedMessage.error.message,
        processedMessage.error.code,
        processedMessage.error.details
      );
      rowstError.name = "RowstRemoteError";
      this.logger.warn("Request failed with remote error", {
        id: processedMessage.id,
        error: processedMessage.error
      });
      pending.reject(rowstError);
      return;
    }
    this.logger.debug("Resolved request", { id: processedMessage.id, latency });
    pending.resolve(processedMessage);
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
    if (options?.meta) {
      Object.assign(meta, options.meta);
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

// src/core/WorkerPoolResolver.ts
var WorkerPoolResolver = class extends AsyncResolver {
  constructor(transport, options = {}) {
    super(transport, options);
    this.internalLogger = options.logger ?? new Logger({
      level: 3 /* INFO */,
      transports: [new NoopTransport()],
      prefix: "WorkerPoolResolver"
    });
    this.workerPool = new WorkerPool({
      workerCount: options.workerCount,
      workerScript: options.workerScript,
      taskTimeout: options.taskTimeout,
      logger: this.internalLogger
    });
    this.useWorkersWhen = options.useWorkersWhen ?? this.defaultWorkerStrategy;
    this.serializeInWorker = options.serializeInWorker ?? true;
    this.deserializeInWorker = options.deserializeInWorker ?? true;
    this.validateInWorker = options.validateInWorker ?? false;
    this.internalLogger.info("WorkerPoolResolver initialized", {
      serializeInWorker: this.serializeInWorker,
      deserializeInWorker: this.deserializeInWorker,
      validateInWorker: this.validateInWorker
    });
  }
  defaultWorkerStrategy(payload) {
    try {
      const serialized = JSON.stringify(payload);
      return serialized.length > 3e4;
    } catch {
      return false;
    }
  }
  estimatePayloadSize(payload) {
    try {
      return JSON.stringify(payload).length;
    } catch {
      return 0;
    }
  }
  /**
   * Executes a request; if the worker strategy is enabled for the given payload,
   * perform CPU-heavy steps in the worker pool before/after delegating to AsyncResolver.
   *
   * Important:
   * - We DO NOT mutate the payload shape sent over the wire to preserve protocol compatibility.
   * - We may run "serialize" (JSON.stringify) in workers as a "pre-flight" warmup/measurement
   *   step to parallelize CPU work across concurrent requests while the main thread handles I/O.
   */
  async request(payload, options = {}) {
    const shouldUseWorkers = this.useWorkersWhen(payload);
    if (!shouldUseWorkers) {
      this.internalLogger.debug("Using single-threaded AsyncResolver path", {
        reason: "payload under threshold"
      });
      return super.request(payload, options);
    }
    this.internalLogger.debug("Using worker pool path", {
      payloadSize: this.estimatePayloadSize(payload)
    });
    if (this.validateInWorker) {
      try {
        await this.workerPool.execute("validate", payload, {
          schema: options?.schema
        });
        this.internalLogger.trace("Payload validated in worker");
      } catch (error) {
        this.internalLogger.error("Worker validation failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
    if (this.serializeInWorker) {
      try {
        await this.workerPool.execute("serialize", payload);
        this.internalLogger.trace("Payload serialization warmup in worker");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/timeout/i.test(msg)) {
          this.internalLogger.error("Worker serialization timed out", { error: msg });
          throw error;
        }
        this.internalLogger.warn("Worker serialization failed, continuing on main thread", {
          error: msg
        });
      }
    }
    const response = await super.request(payload, options);
    if (this.deserializeInWorker && typeof response.payload === "string") {
      try {
        const parsed = await this.workerPool.execute("deserialize", response.payload);
        const next = {
          ...response,
          payload: parsed
        };
        this.internalLogger.trace("Response payload deserialized in worker");
        return next;
      } catch (error) {
        this.internalLogger.warn("Worker deserialization failed, returning original payload", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return response;
  }
  getWorkerPoolStats() {
    return this.workerPool.getStats();
  }
  // Keep signature compatible with base class (void). Tests can still `await` this safely.
  destroy() {
    void this.workerPool.destroy();
    super.destroy();
  }
};
export {
  WorkerPool,
  WorkerPoolResolver
};
//# sourceMappingURL=index.js.map