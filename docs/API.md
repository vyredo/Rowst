# Rowst API Reference

## Table of Contents

1. [Overview](#overview)
2. [Core Types](#core-types)
   - [Message](#message)
   - [ErrorCode](#errorcode)
   - [CorrelatorOptions](#correlatoroptions)
   - [RequestOptions](#requestoptions)
   - [Metrics](#metrics)
   - [LatencyStats](#latencystats)
3. [Logger](#logger)
   - [LogLevel](#loglevel)
   - [LoggerOptions](#loggeroptions)
   - [LogTransport](#logtransport)
   - [ConsoleTransport](#consoletransport)
   - [NoopTransport](#nooptransport)
4. [UUID Utilities](#uuid-utilities)
5. [Transports](#transports)
   - [Transport Interface](#transport-interface)
   - [WebSocketTransport](#websockettransport)
   - [WebRTCTransport](#webrtctransport)
6. [AsyncResolver](#asyncresolver)
   - [Constructor](#constructor)
   - [Methods](#methods)
7. [Errors](#errors)
8. [MCP Integration](#mcp-integration)

---

## Overview

Rowst provides request-response correlation semantics over bidirectional transports with zero runtime dependencies. The package exposes a core `AsyncResolver`, logging utilities, transport abstractions, error handling, and Model Context Protocol integration.

---

## Core Types

### Message

```ts
interface Message<TPayload = unknown> {
  id: string;
  type: 'request' | 'response' | 'notification';
  payload: TPayload;
  timestamp?: string;
  meta?: {
    attempts?: number;
    tags?: string[];
    [key: string]: unknown;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  latency?: number;
}
```

### ErrorCode

```ts
enum ErrorCode {
  TIMEOUT = 'TIMEOUT',
  TRANSPORT_CLOSED = 'TRANSPORT_CLOSED',
  TRANSPORT_ERROR = 'TRANSPORT_ERROR',
  BACKPRESSURE = 'BACKPRESSURE',
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  SEND_FAILED = 'SEND_FAILED'
}
```

### CorrelatorOptions

```ts
interface CorrelatorOptions {
  defaultTimeout?: number;
  maxInflight?: number;
  logger?: Logger;
}
```

### RequestOptions

```ts
interface RequestOptions {
  timeout?: number;
  retries?: number;
  tags?: string[];
  jitterFactor?: number;
  backoffMultiplier?: number;
  [key: string]: unknown;
}
```

### Metrics

```ts
interface Metrics {
  inflightCount: number;
  totalRequests: number;
  totalResponses: number;
  totalTimeouts: number;
  totalErrors: number;
  latencies: number[];
}
```

### LatencyStats

```ts
interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p50: number;
  p95: number;
  p99: number;
}
```

---

## Logger

### LogLevel

```ts
enum LogLevel {
  SILENT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5
}
```

### LoggerOptions

```ts
interface LoggerOptions {
  level: LogLevel;
  transports: LogTransport[];
  prefix?: string;
}
```

### LogTransport

```ts
interface LogTransport {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}
```

### ConsoleTransport

Logs entries to the console with timestamps and level names.

```ts
const logger = new Logger({
  level: LogLevel.INFO,
  transports: [new ConsoleTransport()]
});
```

### NoopTransport

No-op transport useful for silencing logs in production or tests.

```ts
const silent = new Logger({
  level: LogLevel.SILENT,
  transports: [new NoopTransport()]
});
```

---

## UUID Utilities

`generateUUID()` produces RFC4122-compliant UUID v4 strings using cryptographically secure random values. `isValidUUID(uuid)` validates UUID strings.

```ts
const id = generateUUID(); // e.g. '123e4567-e89b-12d3-a456-426614174000'
const valid = isValidUUID(id); // true
```

---

## Transports

### Transport Interface

```ts
type TransportState = 'connecting' | 'open' | 'closing' | 'closed';

interface TransportEvents {
  message: (data: string | ArrayBuffer | Uint8Array) => void;
  open: () => void;
  close: (event?: unknown) => void;
  error: (error: Error) => void;
}

interface Transport {
  readonly readyState: TransportState;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
}
```

### WebSocketTransport

Wraps a `WebSocket` instance, normalizes events, and supports binary data handling (string, ArrayBuffer, Uint8Array, Blob). Accepts optional logger overrides.

```ts
const ws = new WebSocket('wss://example.com');
const transport = new WebSocketTransport(ws);
```

### WebRTCTransport

Wraps an `RTCDataChannel`, automatically clones buffers for safe reuse, and normalizes inbound data. Works with `RTCDataChannel` created manually or via `WebRTCTransport.create(peer, label, options)` helper.

---

## AsyncResolver

### Constructor

```ts
new AsyncResolver(transport: Transport, options?: AsyncResolverOptions)
```

`AsyncResolverOptions` extends `CorrelatorOptions` with `latencySampleSize`.

### Methods

- `request(payload, options?)`: Promise resolving to a response `Message<T>`.
- `requestWithRetry(payload, options?)`: Retries on timeout with exponential backoff.
- `notify(payload)`: Fire-and-forget notification.
- `getInflightCount()`: Current number of inflight requests.
- `getMetrics()`: Returns metrics and latency stats.
- `destroy()`: Tears down listeners and rejects all pending requests.

Internals include detailed logging,  timeout handling, backpressure protection, and response validation.

---

## Errors

- `RowstError`: Base class with `code` and `details`.
- `TimeoutError`
- `TransportClosedError`
- `TransportError`
- `BackpressureError`
- `InvalidMessageError`

Utility helpers:

- `toErrorResponse(error)` converts an unknown error to serializable shape.
- `isErrorMessage(message)` checks if a response carries an error payload.

---

## MCP Integration

`RowstMCPServer` manages resolvers keyed by transport IDs, exposes two MCP tools:

- `rowst.request`: Send correlated requests.
- `rowst.metrics`: Retrieve metrics for monitoring.

### API

```ts
const server = new RowstMCPServer();
server.registerTransport('backend', backendTransport, { defaultTimeout: 15000 });

const result = await server.handleRequest({
  transportId: 'backend',
  payload: { action: 'fetchData' }
});

const metrics = server.getMetrics('backend');
const config = server.getMCPConfig();
```

The configuration returned by `getMCPConfig()` can be used to expose tools in MCP-compatible runtimes.