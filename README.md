# Rowst

**Zero-dependency request-response correlation over bidirectional transports**

*REST over WebSocket • REST over WebRTC • Transport-Agnostic RPC*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-green.svg)](https://www.npmjs.com/package/rowst)

---

A TypeScript library that adds request-response semantics (correlation, timeouts, retries, metrics) on top of any bidirectional transport like WebSocket or WebRTC DataChannel. Zero runtime dependencies.

## Features

- **Zero dependencies** — no external libraries, 100% self-contained
- **Transport agnostic** — works with WebSocket, WebRTC DataChannel, or custom transports
- **Request-response correlation** — UUID-based tracking for async requests
- **Built-in metrics** — latency percentiles (p50/p95/p99), inflight count, error tracking
- **Pluggable logging** — custom log transports with configurable levels
- **Retry logic** — exponential backoff with jitter for failed requests
- **Backpressure** — configurable max inflight limit
- **Type-safe** — full TypeScript with strict mode

## Quick Start

### WebSocket Example

```ts
import {
  AsyncResolver,
  WebSocketTransport,
  Logger,
  LogLevel,
  ConsoleTransport
} from './src/index.js';

const logger = new Logger({
  level: LogLevel.INFO,
  transports: [new ConsoleTransport()],
  prefix: 'MyApp'
});

const ws = new WebSocket('wss://api.example.com');
const transport = new WebSocketTransport(ws);

const resolver = new AsyncResolver(transport, {
  defaultTimeout: 30000,
  maxInflight: 1000,
  logger
});

const response = await resolver.request<{ user: unknown }>({
  action: 'fetchUser',
  userId: 123
}, {
  timeout: 5000,
  tags: ['users', 'read']
});

console.log(response.payload);
```

### WebRTC Example

```ts
import { AsyncResolver, WebRTCTransport } from './src/index.js';

const peerConnection = new RTCPeerConnection();
const dataChannel = peerConnection.createDataChannel('rpc', {
  ordered: true,
  maxRetransmits: 3
});

const transport = new WebRTCTransport(dataChannel);
const resolver = new AsyncResolver(transport, { defaultTimeout: 10000 });

const result = await resolver.request<{ command: string }>({ command: 'ping' });
console.log(`RTT: ${result.latency}ms`);
```

## Core Concepts

### Transport

A transport is any bidirectional communication channel that implements the `Transport` interface:

```ts
interface Transport {
  readonly readyState: TransportState;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
}
```

**Built-in transports:**

- `WebSocketTransport` — wraps browser WebSocket or Node.js `ws` module
- `WebRTCTransport` — wraps `RTCDataChannel`

### AsyncResolver

The core correlation engine that manages request-response pairs:

```ts
const resolver = new AsyncResolver(transport, {
  defaultTimeout: 30000,   // 30 seconds
  maxInflight: 1000,       // max concurrent requests
  logger: myLogger         // optional
});
```

### Message Format

```ts
interface Message<T> {
  id: string;
  type: 'request' | 'response' | 'notification';
  payload: T;
  timestamp?: string;
  meta?: { attempts?: number; tags?: string[] };
  error?: { code: string; message: string; details?: unknown };
}
```

## API Reference

### AsyncResolver

**Constructor:** `new AsyncResolver(transport, options?)`

| Option | Default | Description |
|---|---|---|
| `defaultTimeout` | 30000 | Default request timeout (ms) |
| `maxInflight` | 1000 | Maximum concurrent requests |
| `latencySampleSize` | 1000 | Rolling sample size for latency stats |
| `logger` | silent | Logger instance |

**Methods:**

`request<TResponse, TRequest>(payload, options?)` — Send a request and wait for response.

```ts
const response = await resolver.request<{ data: unknown }>(
  { action: 'getData' },
  { timeout: 5000, tags: ['api'] }
);
```

`requestWithRetry<TResponse, TRequest>(payload, options?)` — Send with automatic retry on timeout.

```ts
const response = await resolver.requestWithRetry(
  { action: 'getData' },
  { retries: 3, timeout: 5000 }
);
```

`notify(payload)` — Fire-and-forget notification (no response expected).

`getMetrics()` — Returns current metrics including latency percentiles (p50/p95/p99).

`getInflightCount()` — Number of pending requests.

`destroy()` — Cleanup and reject all pending requests.

### Logger

Pluggable logging with configurable levels: `SILENT`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE`.

Built-in transports: `ConsoleTransport`, `NoopTransport`. Custom transports implement the `LogTransport` interface.

## Examples

See [`examples/`](./examples):

- **[WebSocket Basic](./examples/websocket-basic)** — client-server example
- **[WebRTC P2P](./examples/webrtc-p2p)** — peer-to-peer communication

## HTTP Router

Maps REST-style HTTP routes to WebSocket events, with framework adapters for Hono, Express, and Fastify.

```ts
import { RowstRouter } from './src/http/index.js';

const router = new RowstRouter(resolver);

router.get('/api/users', 'get_users');
router.post('/api/users', 'create_user');
router.get('/api/users/:id', 'get_user_by_id');

const response = await router.handle({
  method: 'GET',
  path: '/api/users/42',
  headers: {},
});
```

Route parameters (`:id`) are extracted and passed as `payload.params` to the WebSocket handler. Built-in error mapping: timeouts → 504, transport closed → 503, etc.

## Development

```bash
npm install        # install dev dependencies
npm run typecheck  # TypeScript strict check
npm run build      # build CJS + ESM + type declarations
npm test           # build + run all tests
npm run lint       # ESLint
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). PRs welcome.

## License

MIT © [Vidy Alfredo](https://github.com/vyredo)
