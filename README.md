# Rowst

Zero-dependency request–response correlation over bidirectional transports (WebSocket, WebRTC, and more). Correlate requests with responses using a tiny envelope format, robust timeouts, retries, metrics, and optional worker offloading.

- Core correlator: AsyncResolver
- Transports: WebSocketTransport, WebRTCTransport
- Optional modules: MCP server, Worker pool
- New module: HTTP-to-WebSocket Router (rowst/http)

## Install

```bash
npm install rowst
```

Optional peer deps if using adapters:

```bash
npm install hono      # or
npm install express   # or
npm install fastify
```

## Quick Start

```ts
import { AsyncResolver, WebSocketTransport } from 'rowst'

const ws = new WebSocket('ws://localhost:8081')
const resolver = new AsyncResolver(new WebSocketTransport(ws))

const res = await resolver.request({ ping: true }, { timeout: 2000 })
console.log(res.payload)
```

## Transports

- WebSocket: Use browser WebSocket or ws in Node via WebSocketTransport
- WebRTC: Peer-to-peer via WebRTCTransport

See examples in ./examples.

## 🧩 MCP Integration

Rowst includes an optional MCP server module to expose tools via the Model Context Protocol.

- Entry: rowst/mcp
- Server: RowstMCPServer

Read the MCP guide in ./docs/MCP_INTEGRATION.md.

## 🌐 HTTP-to-WebSocket Router

Bridge HTTP REST APIs to WebSocket backends with Express-style routing:

```ts
import { AsyncResolver, WebSocketTransport } from 'rowst'
import { RowstRouter, HonoAdapter } from 'rowst/http'
import { Hono } from 'hono'

// Create WebSocket connection to backend
const ws = new WebSocket('ws://backend.example.com')
const resolver = new AsyncResolver(new WebSocketTransport(ws))

// Create router
const router = new RowstRouter(resolver)

// Register routes
router.get('/api/users/:id', 'fetchUser')
router.post('/api/posts', 'createPost')
router.delete('/api/posts/:id', 'deletePost')

// Integrate with Hono
const app = new Hono()
new HonoAdapter(router).register(app)

// Or Express
// import express from 'express'
// const expressApp = express()
// expressApp.use(express.json())
// new ExpressAdapter(router).register(expressApp)

// Or Fastify
// import Fastify from 'fastify'
// const fastify = Fastify()
// await new FastifyAdapter(router).register(fastify)
```

Backend receives:

```json
{
  "method": "GET",
  "path": "/api/users/123",
  "query": "?include=posts",
  "headers": {
    "authorization": "Bearer ..."
  },
  "params": {
    "id": "123"
  },
  "event": "fetchUser"
}
```

Backend responds:

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json"
  },
  "bodyText": "{\"user\":{\"id\":\"123\"}}"
}
```

### Features

- Express-style path patterns (/users/:id)
- Path parameter extraction (+ URL decoding)
- Multiple HTTP methods (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, ALL)
- Framework adapters (Hono, Express, Fastify)
- Request/response hooks
- Custom error handling
- Route-specific timeouts

See the HTTP Router Guide in ./docs/HTTP_ROUTER.md for details.

## Workers (Optional)

Heavy JSON serialize/deserialize can be offloaded to Workers using WorkerPoolResolver. See ./src/workers and examples.

## API Docs

- Core: ./docs/API.md
- Transport Guide: ./docs/TRANSPORT_GUIDE.md
- HTTP Router Guide: ./docs/HTTP_ROUTER.md
- MCP Integration: ./docs/MCP_INTEGRATION.md

## License

MIT
