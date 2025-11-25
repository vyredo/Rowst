"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/workers/message-worker.ts
var import_worker_threads = require("worker_threads");
var port = import_worker_threads.parentPort;
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
        result = await transformPayload(
          task.data,
          task.options?.transformer
        );
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
//# sourceMappingURL=message-worker.cjs.map