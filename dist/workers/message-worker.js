// src/workers/message-worker.ts
import { parentPort } from "worker_threads";
var port = parentPort;
if (!port) {
  throw new Error("message-worker must be run as a worker thread");
}
port.on("message", async (task) => {
  const taskStart = Date.now();
  try {
    let result;
    switch (task.type) {
      case "serialize":
        result = JSON.stringify(task.data);
        break;
      case "deserialize":
        result = JSON.parse(task.data);
        break;
      case "validate":
        result = validateMessage(task.data, task.options?.schema);
        break;
      case "compress":
        result = await compressData(task.data);
        break;
      case "decompress":
        result = await decompressData(task.data);
        break;
      case "transform":
        result = await transformPayload(task.data, task.options?.transformer);
        break;
      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }
    const duration = Date.now() - taskStart;
    port.postMessage({
      id: task.id,
      result,
      duration
    });
  } catch (error) {
    const duration = Date.now() - taskStart;
    const typedError = error;
    port.postMessage({
      id: task.id,
      error: {
        message: typedError.message,
        stack: typedError.stack
      },
      duration
    });
  }
});
function validateMessage(data, schema) {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid message format");
  }
  const candidate = data;
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string") {
    throw new Error("Message must have id and type fields");
  }
  if (schema) {
    const validator = schema.validate;
    if (validator && !validator(candidate)) {
      throw new Error("Message does not match schema");
    }
  }
  return true;
}
async function compressData(data) {
  const { gzip } = await import("zlib");
  const { promisify } = await import("util");
  const gzipAsync = promisify(gzip);
  const buffer = Buffer.from(JSON.stringify(data));
  return gzipAsync(buffer);
}
async function decompressData(data) {
  const { gunzip } = await import("zlib");
  const { promisify } = await import("util");
  const gunzipAsync = promisify(gunzip);
  const decompressed = await gunzipAsync(data);
  return JSON.parse(decompressed.toString());
}
async function transformPayload(data, transformer) {
  if (transformer) {
    return transformer(data);
  }
  return data;
}
port.postMessage({ ready: true });
//# sourceMappingURL=message-worker.js.map