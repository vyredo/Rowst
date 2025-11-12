import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { cpus } from 'node:os';
import { existsSync } from 'node:fs';
import { generateUUID } from '../core/uuid.js';
import { Logger, LogLevel } from '../core/logger.js';

type WorkerTaskType = 'serialize' | 'deserialize' | 'validate' | 'compress' | 'decompress' | 'transform';

interface WorkerTaskEnvelope {
  id: string;
  type: WorkerTaskType;
  data: unknown;
  options?: Record<string, unknown>;
}

interface WorkerResultMessage {
  id?: string;
  result?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
  duration?: number;
  ready?: boolean;
}

interface PooledWorker {
  id: number;
  worker: Worker;
  busy: boolean;
  tasksCompleted: number;
  totalDuration: number;
  currentTaskId?: string;
  defunct: boolean;
}

interface PendingTask {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime: number;
}

interface QueueEntry {
  id: string;
  task: WorkerTaskEnvelope;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface WorkerPoolOptions {
  workerCount?: number;
  workerScript?: string;
  taskTimeout?: number;
  logger?: Logger;
}

export class WorkerPool {
  private readonly workerScript: string;
  private readonly taskTimeout: number;
  private readonly logger: Logger;

  private workers: PooledWorker[] = [];
  private pendingTasks = new Map<string, PendingTask>();
  private taskQueue: QueueEntry[] = [];
  private destroyed = false;

  constructor(options: WorkerPoolOptions = {}) {
    const workerCount = options.workerCount ?? this.getOptimalWorkerCount();
    this.workerScript = this.resolveWorkerScript(options.workerScript);
    this.taskTimeout = options.taskTimeout ?? 10_000;
    this.logger =
      options.logger ??
      new Logger({
        level: LogLevel.INFO,
        transports: [],
        prefix: 'WorkerPool'
      });

    this.logger.info('Initializing worker pool', {
      workerCount,
      workerScript: this.workerScript
    });

    this.initializeWorkers(workerCount);
  }

  async execute<TResult = unknown>(
    type: WorkerTaskType,
    data: unknown,
    options?: Record<string, unknown>
  ): Promise<TResult> {
    if (this.destroyed) {
      throw new Error('Worker pool destroyed');
    }

    const id = generateUUID();
    const task: WorkerTaskEnvelope = { id, type, data, options };

    return new Promise<TResult>((resolve, reject) => {
      const resolver = (value: unknown) => resolve(value as TResult);
      const rejection = (error: Error) => reject(error);

      const availableWorker = this.workers.find((worker) => !worker.busy && !worker.defunct);

      if (availableWorker) {
        this.executeTask(task, resolver, rejection, availableWorker);
      } else {
        this.taskQueue.push({ id, task, resolve: resolver, reject: rejection });
        this.logger.debug('Task queued', { id, queueLength: this.taskQueue.length });
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

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.logger.info('Destroying worker pool');

    const destructionError = new Error('Worker pool destroyed');

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

    this.logger.info('Worker pool destroyed');
  }

  private initializeWorkers(count: number): void {
    for (let i = 0; i < count; i++) {
      const pooledWorker = this.spawnWorker(i);
      if (pooledWorker) {
        this.workers.push(pooledWorker);
      }
    }

    this.logger.info('Worker pool initialized', { workerCount: this.workers.length });
  }

  private spawnWorker(id: number): PooledWorker | null {
    try {
      const worker = new Worker(this.workerScript);

      const pooledWorker: PooledWorker = {
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
      this.logger.error('Failed to spawn worker', { workerId: id, error: message });
      return null;
    }
  }

  private registerWorkerEvents(pooledWorker: PooledWorker): void {
    pooledWorker.worker.on('message', (message: WorkerResultMessage) => {
      this.handleWorkerMessage(pooledWorker, message);
    });

    pooledWorker.worker.on('error', (error: Error) => {
      this.handleWorkerError(pooledWorker, error);
    });

    pooledWorker.worker.on('exit', (code) => {
      this.handleWorkerExit(pooledWorker, code);
    });
  }

  private handleWorkerMessage(pooledWorker: PooledWorker, message: WorkerResultMessage): void {
    if (pooledWorker.defunct) {
      return;
    }

    if (message.ready) {
      this.logger.debug('Worker ready', { workerId: pooledWorker.id });
      return;
    }

    if (!message.id) {
      this.logger.warn('Received worker message without task id', { workerId: pooledWorker.id });
      return;
    }

    const pending = this.pendingTasks.get(message.id);
    if (!pending) {
      this.logger.warn('Received result for unknown task', { workerId: pooledWorker.id, taskId: message.id });
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingTasks.delete(message.id);

    pooledWorker.busy = false;
    pooledWorker.currentTaskId = undefined;
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

  private handleWorkerError(pooledWorker: PooledWorker, error: Error): void {
    if (pooledWorker.defunct) {
      return;
    }

    this.logger.error('Worker encountered error', {
      workerId: pooledWorker.id,
      error: error.message
    });

    this.rejectPendingTask(pooledWorker.currentTaskId, error);

    pooledWorker.busy = false;
    pooledWorker.currentTaskId = undefined;

    this.removeWorker(pooledWorker);
    if (!this.destroyed) {
      const replacement = this.spawnWorker(pooledWorker.id);
      if (replacement) {
        this.workers.push(replacement);
      }
    }

    this.processQueue();
  }

  private handleWorkerExit(pooledWorker: PooledWorker, code: number | null): void {
    if (pooledWorker.defunct) {
      return;
    }

    const exitError = code === 0 ? null : new Error(`Worker exited with code ${code ?? 'unknown'}`);

    if (exitError) {
      this.logger.error('Worker exited unexpectedly', {
        workerId: pooledWorker.id,
        code
      });
    } else {
      this.logger.debug('Worker exited', { workerId: pooledWorker.id, code });
    }

    this.rejectPendingTask(
      pooledWorker.currentTaskId,
      exitError ?? new Error('Worker terminated before completing task')
    );

    pooledWorker.busy = false;
    pooledWorker.currentTaskId = undefined;

    this.removeWorker(pooledWorker);

    if (!this.destroyed) {
      const replacement = this.spawnWorker(pooledWorker.id);
      if (replacement) {
        this.workers.push(replacement);
        this.processQueue();
      }
    }
  }

  private rejectPendingTask(taskId: string | undefined, error: Error): void {
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

  private removeWorker(pooledWorker: PooledWorker): void {
    pooledWorker.defunct = true;
    this.workers = this.workers.filter((worker) => worker !== pooledWorker);
  }

  private executeTask(
    task: WorkerTaskEnvelope,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    pooledWorker: PooledWorker
  ): void {
    if (this.destroyed || pooledWorker.defunct) {
      reject(new Error('Worker pool destroyed'));
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
      pooledWorker.currentTaskId = undefined;

      const timeoutError = new Error(`Worker task timeout after ${this.taskTimeout}ms`);
      reject(timeoutError);

      this.logger.warn('Worker task timed out', {
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
      this.logger.trace('Task dispatched to worker', {
        workerId: pooledWorker.id,
        taskId: task.id
      });
    } catch (error) {
      clearTimeout(timeout);
      this.pendingTasks.delete(task.id);

      pooledWorker.busy = false;
      pooledWorker.currentTaskId = undefined;

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to post task to worker', {
        workerId: pooledWorker.id,
        taskId: task.id,
        error: message
      });

      reject(error instanceof Error ? error : new Error(message));

      this.processQueue();
    }
  }

  private processQueue(): void {
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

  private getOptimalWorkerCount(): number {
    const hardwareConcurrency =
      typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;

    if (typeof hardwareConcurrency === 'number' && hardwareConcurrency > 1) {
      return Math.max(2, hardwareConcurrency - 1);
    }

    try {
      const cpuList = typeof cpus === 'function' ? cpus() : [];
      if (cpuList.length > 1) {
        return Math.max(2, cpuList.length - 1);
      }
    } catch {
      // Ignored - fall back to default
    }

    return 4;
  }

  private resolveWorkerScript(scriptPath?: string): string {
    const currentDir = dirname(fileURLToPath(import.meta.url));

    // If explicit path provided, try absolute as-is, then relative to current module and CWD.
    if (scriptPath) {
      if (isAbsolute(scriptPath)) {
        return scriptPath;
      }
      const candidateA = join(currentDir, scriptPath);
      if (existsSync(candidateA)) return candidateA;

      const candidateB = join(process.cwd(), scriptPath);
      if (existsSync(candidateB)) return candidateB;

      // Fallthrough to default search below
    }

    // Preferred when running built code (dist): worker sits alongside WorkerPool.js
    const builtSibling = join(currentDir, 'message-worker.js');
    if (existsSync(builtSibling)) return builtSibling;

    // When running tests from TS sources, prefer built artifact under project dist
    const distWorker = join(process.cwd(), 'dist', 'workers', 'message-worker.js');
    if (existsSync(distWorker)) return distWorker;

    // As a last resort, return sibling path (may fail if not built)
    return builtSibling;
  }
}