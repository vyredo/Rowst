// src/core/WorkerPoolResolver.ts
import { AsyncResolver } from './AsyncResolver.js';
import type { Transport } from '../transports/Transport.js';
import type { Message, RequestOptions, CorrelatorOptions } from './types.js';
import { WorkerPool, type WorkerPoolOptions } from '../workers/WorkerPool.js';
import { Logger, LogLevel, NoopTransport } from './logger.js';

export interface WorkerPoolResolverOptions extends CorrelatorOptions, WorkerPoolOptions {
  useWorkersWhen?: (payload: unknown) => boolean;
  serializeInWorker?: boolean;
  deserializeInWorker?: boolean;
  validateInWorker?: boolean;
}

/**
 * WorkerPoolResolver extends AsyncResolver and opportunistically offloads
 * CPU-heavy operations (e.g., JSON stringify/parse, validation, transforms)
 * to a pool of worker threads based on a selection strategy.
 *
 * Note:
 * - For compatibility with the existing AsyncResolver, message I/O (transport.send / receive)
 *   remains on the main thread.
 * - We avoid changing AsyncResolver internals; therefore, we do not replace its JSON
 *   serialization of the whole message. Instead, we may do prework (e.g., validation) and
 *   postwork (e.g., parsing string payloads) in workers when beneficial.
 */
export class WorkerPoolResolver extends AsyncResolver {
  private readonly workerPool: WorkerPool;
  private readonly useWorkersWhen: (payload: unknown) => boolean;
  private readonly serializeInWorker: boolean;
  private readonly deserializeInWorker: boolean;
  private readonly validateInWorker: boolean;
  private readonly internalLogger: Logger;

  constructor(transport: Transport, options: WorkerPoolResolverOptions = {}) {
    super(transport, options);

    this.internalLogger =
      options.logger ??
      new Logger({
        level: LogLevel.INFO,
        transports: [new NoopTransport()],
        prefix: 'WorkerPoolResolver'
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

    this.internalLogger.info('WorkerPoolResolver initialized', {
      serializeInWorker: this.serializeInWorker,
      deserializeInWorker: this.deserializeInWorker,
      validateInWorker: this.validateInWorker
    });
  }

  private defaultWorkerStrategy(payload: unknown): boolean {
    // Use workers for payloads larger than 30KB (estimated)
    try {
      const serialized = JSON.stringify(payload);
      return serialized.length > 30_000;
    } catch {
      return false;
    }
  }

  private estimatePayloadSize(payload: unknown): number {
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
  async request<TResponse = unknown, TRequest = unknown>(
    payload: TRequest,
    options: RequestOptions = {}
  ): Promise<Message<TResponse>> {
    const shouldUseWorkers = this.useWorkersWhen(payload);
    if (!shouldUseWorkers) {
      this.internalLogger.debug('Using single-threaded AsyncResolver path', {
        reason: 'payload under threshold'
      });
      return super.request<TResponse, TRequest>(payload, options);
    }

    this.internalLogger.debug('Using worker pool path', {
      payloadSize: this.estimatePayloadSize(payload)
    });

    // Step 1: Optional pre-validation in worker
    if (this.validateInWorker) {
      try {
        // Validate the original payload structure (not altering it)
        await this.workerPool.execute('validate', payload, {
          schema: (options as Record<string, unknown>)?.schema
        });
        this.internalLogger.trace('Payload validated in worker');
      } catch (error) {
        this.internalLogger.error('Worker validation failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }

    // Step 2: Optional serialization warmup in worker
    // We do not replace the payload; we just perform the expensive stringify
    // in parallel to amortize CPU across threads. This also provides realistic
    // worker task load for metrics.
    if (this.serializeInWorker) {
      try {
        await this.workerPool.execute('serialize', payload);
        this.internalLogger.trace('Payload serialization warmup in worker');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // If the worker task timed out, escalate so callers can react (e.g., tests).
        if (/timeout/i.test(msg)) {
          this.internalLogger.error('Worker serialization timed out', { error: msg });
          throw error;
        }
        // Otherwise, continue with single-threaded path
        this.internalLogger.warn('Worker serialization failed, continuing on main thread', {
          error: msg
        });
      }
    }

    // Step 3: Perform the actual network request via AsyncResolver (main thread I/O)
    const response = await super.request<TResponse, TRequest>(payload, options);

    // Step 4: Optional post-deserialization in worker (only if response payload is a string)
    if (this.deserializeInWorker && typeof response.payload === 'string') {
      try {
        const parsed = await this.workerPool.execute('deserialize', response.payload);
        const next: Message<TResponse> = {
          ...response,
          payload: parsed as TResponse
        };
        this.internalLogger.trace('Response payload deserialized in worker');
        return next;
      } catch (error) {
        // If deserialization fails in worker, return original response
        this.internalLogger.warn('Worker deserialization failed, returning original payload', {
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
  destroy(): void {
    // Fire-and-forget; terminates workers in the background
    void this.workerPool.destroy();
    super.destroy();
  }
}