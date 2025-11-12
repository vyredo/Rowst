import { parentPort } from 'worker_threads';

interface WorkerTask {
  id: string;
  type: 'serialize' | 'deserialize' | 'validate' | 'compress' | 'decompress' | 'transform';
  data: unknown;
  options?: Record<string, unknown>;
}

interface WorkerResult {
  id: string;
  result?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
  duration: number;
}

const port = parentPort;

if (!port) {
  throw new Error('message-worker must be run as a worker thread');
}

port.on('message', async (task: WorkerTask) => {
  const taskStart = Date.now();

  try {
    let result: unknown;

    switch (task.type) {
      case 'serialize':
        result = JSON.stringify(task.data);
        break;

      case 'deserialize':
        result = JSON.parse(task.data as string);
        break;

      case 'validate':
        result = validateMessage(task.data, task.options?.schema);
        break;

      case 'compress':
        result = await compressData(task.data);
        break;

      case 'decompress':
        result = await decompressData(task.data as Buffer);
        break;

      case 'transform':
        result = await transformPayload(task.data, task.options?.transformer as ((value: unknown) => unknown) | undefined);
        break;

      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }

    const duration = Date.now() - taskStart;

    port.postMessage({
      id: task.id,
      result,
      duration
    } satisfies WorkerResult);
  } catch (error) {
    const duration = Date.now() - taskStart;
    const typedError = error as Error;

    port.postMessage({
      id: task.id,
      error: {
        message: typedError.message,
        stack: typedError.stack
      },
      duration
    } satisfies WorkerResult);
  }
});

function validateMessage(data: unknown, schema?: unknown): boolean {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid message format');
  }

  const candidate = data as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string') {
    throw new Error('Message must have id and type fields');
  }

  if (schema) {
    // Extend validation using provided schema
    const validator = (schema as { validate?: (value: unknown) => boolean }).validate;
    if (validator && !validator(candidate)) {
      throw new Error('Message does not match schema');
    }
  }

  return true;
}

async function compressData(data: unknown): Promise<Buffer> {
  const { gzip } = await import('zlib');
  const { promisify } = await import('util');
  const gzipAsync = promisify(gzip);

  const buffer = Buffer.from(JSON.stringify(data));
  return gzipAsync(buffer);
}

async function decompressData(data: Buffer): Promise<unknown> {
  const { gunzip } = await import('zlib');
  const { promisify } = await import('util');
  const gunzipAsync = promisify(gunzip);

  const decompressed = await gunzipAsync(data);
  return JSON.parse(decompressed.toString());
}

async function transformPayload(data: unknown, transformer?: (value: unknown) => unknown): Promise<unknown> {
  if (transformer) {
    return transformer(data);
  }
  return data;
}

port.postMessage({ ready: true });