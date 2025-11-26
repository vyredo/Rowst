# Rowst

Request-response correlation over bidirectional transports (WebSocket, WebRTC). Build REST-like APIs over WebSocket with automatic request/response matching, timeouts, retries, and type safety.

## Features

- 🔄 **Request-Response Correlation** - Automatic matching of requests with responses
- 🌐 **Multiple Transports** - WebSocket, WebRTC, or custom transports
- ⚡ **Express-like API** - Familiar routing patterns for WebSocket communication
- 🔌 **HTTP Bridge** - Route HTTP requests to WebSocket backends
- 🎯 **Type Safe** - Full TypeScript support with generics
- ⏱️ **Timeouts & Retries** - Built-in error handling and retry logic
- 🧩 **MCP Integration** - Model Context Protocol server support
- 🔧 **Framework Adapters** - Works with Hono, Express, and Fastify

## Installation

```bash
npm install rowst
```

Optional peer dependencies for specific features:

```bash
# For Express-like API or HTTP Router
npm install hono

# For Express adapter
npm install express

# For Fastify adapter
npm install fastify
```

## Quick Start

### Basic Request-Response

```typescript
import { AsyncResolver, WebSocketTransport } from 'rowst';

// Connect to WebSocket server
const ws = new WebSocket('ws://localhost:8080');
const transport = new WebSocketTransport(ws);
const resolver = new AsyncResolver(transport);

// Send request and await response
const response = await resolver.request(
  { action: 'getData', id: 123 },
  { timeout: 5000 }
);

console.log(response.payload);
```

### Express-like API (NEW!)

The simplest way to build REST-like APIs over WebSocket:

```typescript
import { Hono } from 'hono';
import { AsyncResolver, WebSocketTransport } from 'rowst';
import { RowstRoute } from 'rowst/express';

// Setup
const app = new Hono();
const ws = new WebSocket('ws://upstream-service');
const resolver = new AsyncResolver(new WebSocketTransport(ws));
const routes = new RowstRoute({ app, resolver });

// Register routes
routes.post(
  { rest: '/api/comments', event: 'get_comment', timeoutMs: 10000 },
  async ({ honoContext, websocketContext }) => {
    const { postUrl, limit } = await honoContext.req.json();
    
    // Forward to upstream WebSocket
    const result = await websocketContext.request({ postUrl, limit });
    
    return honoContext.json(result.data, result.status);
  }
);

routes.get(
  { rest: '/api/users/:id', event: 'get_user' },
  async ({ honoContext, websocketContext }) => {
    const userId = honoContext.req.param('id');
    
    const result = await websocketContext.request({ userId });
    
    return honoContext.json(result.data);
  }
);

// Start server
export default app;
```

**Benefits:**

- Single file per route (vs 3+ files with manual implementation)
- Automatic request/response correlation
- Built-in error handling and retries
- Type-safe with full IntelliSense

See [`docs/EXPRESS_API.md`](docs/EXPRESS_API.md) for complete documentation.

### HTTP-to-WebSocket Router

Bridge HTTP REST APIs to WebSocket backends with Express-style routing:

```typescript
import { AsyncResolver, WebSocketTransport } from 'rowst';
import { RowstRouter, HonoAdapter } from 'rowst/http';
import { Hono } from 'hono';

// Create WebSocket connection
const ws = new WebSocket('ws://backend.example.com');
const resolver = new AsyncResolver(new WebSocketTransport(ws));

// Create router
const router = new RowstRouter(resolver);

// Register routes
router.get('/api/users/:id', 'fetchUser');
router.post('/api/posts', 'createPost');
router.delete('/api/posts/:id', 'deletePost');

// Integrate with Hono
const app = new Hono();
new HonoAdapter(router).register(app);
```

**What the backend receives:**

```json
{
  "method": "GET",
  "path": "/api/users/123",
  "query": "?include=posts",
  "headers": { "authorization": "Bearer ..." },
  "params": { "id": "123" },
  "event": "fetchUser"
}
```

**What the backend responds:**

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "bodyText": "{\"user\":{\"id\":\"123\"}}"
}
```

See [`docs/HTTP_ROUTER.md`](docs/HTTP_ROUTER.md) for details.

## Core Concepts

### AsyncResolver

The core correlation engine that matches requests with responses:

```typescript
import { AsyncResolver, WebSocketTransport } from 'rowst';

const resolver = new AsyncResolver(transport, {
  defaultTimeout: 30000,      // Default timeout in ms
  maxInflight: 1000,          // Max concurrent requests
  deduplicateRequests: true,  // Deduplicate identical requests
});

// Make a request
const response = await resolver.request(payload, {
  timeout: 5000,
  retries: 2,
  tags: ['important'],
});

// Fire-and-forget notification
resolver.notify({ event: 'log', message: 'Hello' });

// Get metrics
const metrics = resolver.getMetrics();
console.log(metrics.totalRequests, metrics.totalTimeouts);
```

### Transports

#### WebSocket Transport

```typescript
import { WebSocketTransport } from 'rowst';

// Browser WebSocket
const ws = new WebSocket('ws://localhost:8080');
const transport = new WebSocketTransport(ws);

// Node.js with 'ws' library
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8080');
const transport = new WebSocketTransport(ws);
```

#### WebRTC Transport

```typescript
import { WebRTCTransport } from 'rowst';

const peerConnection = new RTCPeerConnection(config);
const dataChannel = peerConnection.createDataChannel('rowst');
const transport = new WebRTCTransport(dataChannel);
```

#### Custom Transport

Implement the `Transport` interface:

```typescript
interface Transport {
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  on(event: 'message' | 'open' | 'close' | 'error', handler: Function): void;
  off(event: 'message' | 'open' | 'close' | 'error', handler: Function): void;
}
```

## Advanced Features

### Timeouts and Retries

```typescript
const response = await resolver.requestWithRetry(payload, {
  timeout: 5000,
  retries: 3,
  backoffMultiplier: 2,
  jitterFactor: 0.25,
});
```

### Request Deduplication

```typescript
const resolver = new AsyncResolver(transport, {
  deduplicateRequests: true,  // or provide custom function
});

// These will share the same underlying request
const [res1, res2] = await Promise.all([
  resolver.request({ id: 123 }),
  resolver.request({ id: 123 }),
]);
```

### Response Interceptor

```typescript
const resolver = new AsyncResolver(transport, {
  responseInterceptor: async (message) => {
    // Validate or transform responses
    if (message.payload.error) {
      throw new Error(message.payload.error);
    }
    return message;
  },
});
```

### Worker Pool (Optional)

Offload JSON serialization to worker threads:

```typescript
import { WorkerPoolResolver } from 'rowst/workers';

const resolver = new WorkerPoolResolver(transport, {
  poolSize: 4,
  defaultTimeout: 30000,
});
```

## MCP Integration

Expose tools via the Model Context Protocol:

```typescript
import { RowstMCPServer } from 'rowst/mcp';

const server = new RowstMCPServer(resolver, {
  name: 'my-service',
  version: '1.0.0',
});

server.addTool({
  name: 'getData',
  description: 'Fetch data by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const response = await resolver.request({ action: 'getData', ...input });
    return response.payload;
  },
});

await server.start();
```

See [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) for details.

## Examples

Check out the [`examples/`](examples/) directory:

- [`websocket-basic/`](examples/websocket-basic/) - Basic WebSocket client/server
- [`webrtc-p2p/`](examples/webrtc-p2p/) - Peer-to-peer WebRTC communication
- [`express-api/`](examples/express-api/) - Express-like API with Hono

## Documentation

- [API Reference](docs/API.md) - Core AsyncResolver API
- [Express-like API](docs/EXPRESS_API.md) - Simplified routing API
- [HTTP Router Guide](docs/HTTP_ROUTER.md) - HTTP-to-WebSocket bridge
- [Transport Guide](docs/TRANSPORT_GUIDE.md) - Transport implementations
- [MCP Integration](docs/MCP_INTEGRATION.md) - Model Context Protocol

## TypeScript Support

Rowst is written in TypeScript and provides full type definitions:

```typescript
interface User {
  id: string;
  name: string;
}

const response = await resolver.request<User>({ action: 'getUser', id: '123' });
// response.payload is typed as User
```

## Error Handling

```typescript
import { TimeoutError, TransportClosedError } from 'rowst';

try {
  const response = await resolver.request(payload, { timeout: 5000 });
} catch (error) {
  if (error instanceof TimeoutError) {
    console.error('Request timed out');
  } else if (error instanceof TransportClosedError) {
    console.error('Connection closed');
  }
}
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
