import { a as Logger, T as Transport } from '../Transport-CRcAAfoD.cjs';
import { A as AsyncResolver, C as CorrelatorOptions, R as RequestOptions, M as Message } from '../AsyncResolver-Bf2QfIDM.cjs';

type WorkerTaskType = 'serialize' | 'deserialize' | 'validate' | 'compress' | 'decompress' | 'transform';
interface WorkerPoolOptions {
    workerCount?: number;
    workerScript?: string;
    taskTimeout?: number;
    logger?: Logger;
}
declare class WorkerPool {
    private readonly workerScript;
    private readonly taskTimeout;
    private readonly logger;
    private workers;
    private pendingTasks;
    private taskQueue;
    private destroyed;
    constructor(options?: WorkerPoolOptions);
    execute<TResult = unknown>(type: WorkerTaskType, data: unknown, options?: Record<string, unknown>): Promise<TResult>;
    getStats(): {
        workerCount: number;
        busyWorkers: number;
        queueLength: number;
        totalTasksCompleted: number;
        averageDuration: number;
    };
    destroy(): Promise<void>;
    private initializeWorkers;
    private spawnWorker;
    private registerWorkerEvents;
    private handleWorkerMessage;
    private handleWorkerError;
    private handleWorkerExit;
    private rejectPendingTask;
    private removeWorker;
    private executeTask;
    private processQueue;
    private getOptimalWorkerCount;
    private resolveWorkerScript;
}

interface WorkerPoolResolverOptions extends CorrelatorOptions, WorkerPoolOptions {
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
declare class WorkerPoolResolver extends AsyncResolver {
    private readonly workerPool;
    private readonly useWorkersWhen;
    private readonly serializeInWorker;
    private readonly deserializeInWorker;
    private readonly validateInWorker;
    private readonly internalLogger;
    constructor(transport: Transport, options?: WorkerPoolResolverOptions);
    private defaultWorkerStrategy;
    private estimatePayloadSize;
    /**
     * Executes a request; if the worker strategy is enabled for the given payload,
     * perform CPU-heavy steps in the worker pool before/after delegating to AsyncResolver.
     *
     * Important:
     * - We DO NOT mutate the payload shape sent over the wire to preserve protocol compatibility.
     * - We may run "serialize" (JSON.stringify) in workers as a "pre-flight" warmup/measurement
     *   step to parallelize CPU work across concurrent requests while the main thread handles I/O.
     */
    request<TResponse = unknown, TRequest = unknown>(payload: TRequest, options?: RequestOptions): Promise<Message<TResponse>>;
    getWorkerPoolStats(): {
        workerCount: number;
        busyWorkers: number;
        queueLength: number;
        totalTasksCompleted: number;
        averageDuration: number;
    };
    destroy(): void;
}

export { WorkerPool, type WorkerPoolOptions, WorkerPoolResolver, type WorkerPoolResolverOptions };
