# Rowst HTTP Router

Bridge HTTP REST APIs to WebSocket backends using Express-style routing with zero additional dependencies.

- Package: `rowst/http`
- Core: `RowstRouter`
- Adapters: Hono, Express, Fastify

## Getting Started

Install Rowst (adapters use peer deps; you only need to install your chosen framework yourself):

```bash
npm install rowst
# Then, if you plan to use an adapter:
npm install hono            # or
npm install express         # or
npm install fastify
```

Create a WebSocket connection to your backend and wire the router:

```ts
import { AsyncResolver, WebSocketTransport } from 'rowst'
import { RowstRouter, HonoAdapter } from 'rowst/http'
import { Hono } from 'hono'

const ws = new WebSocket('ws://backend.example.com')
const resolver = new AsyncResolver(new WebSocketTransport(ws))

const router = new RowstRouter(resolver, {
  // optional defaults
  defaultTimeout: 15000,
  prefix: '/api'
})

// Register routes (Express-style paths)
router.get('/users/:id', 'fetchUser')
router.post('/posts', 'createPost')

// Hono integration
const app = new Hono()
new HonoAdapter(router).register(app)
```

## Route Registration

```ts
router.get('/users/:id', 'fetchUser')
router.post('/posts', 'createPost')
router.put('/posts/:id', 'updatePost')
router.delete('/posts/:id', 'deletePost')
router.patch('/posts/:id', 'patchPost')

// Match all methods
router.all('/health', 'healthCheck')

// With options (timeout + custom meta)
router.get('/slow/:id', 'slowOperation', { timeout: 2000, meta: { requiresAuth: true } })
```

- Path patterns support:
  - Named params: `/users/:id`
  - Multiple params: `/posts/:postId/comments/:commentId`
  - Optional segments: `/posts/:id?`
  - Wildcards: `/files/*`

## Matching and Parameters

For `/posts/:postId/comments/:commentId` and request path `/posts/123/comments/999`, the upstream payload includes:

```json
{
  "method": "GET",
  "path": "/posts/123/comments/999",
  "query": "",
  "headers": {},
  "params": { "postId": "123", "commentId": "999" },
  "event": "fetchComment"
}
```

URL-decoding is applied on parameters (e.g. `/search/hello%20world` → `{ "query": "hello world" }`).

## Request/Response Format

Upstream request payload (sent with Rowst message envelope payload):

```ts
type UpstreamRequestPayload = {
  method: string
  path: string
  query: string                  // raw query string, including leading "?" if present
  headers: Record<string, string>
  body?: unknown
  params?: Record<string, string>
  event?: string
}
```

Upstream handlers should reply with one of:

```ts
type UpstreamResponse = {
  status?: number                // default 200
  headers?: Record<string, string>
  bodyText?: string              // raw string body
  body?: unknown                 // structured body, stringified if not a string
}
```

Examples:

```json
{ "status": 200, "headers": { "content-type": "application/json" }, "bodyText": "{\"ok\":true}" }
```

Or:

```json
{ "status": 201, "body": { "id": "abc", "title": "New" } }
```

If `body` is not a string, it will be `JSON.stringify`’d and `content-type` will default to `application/json` unless provided.

## Error Handling

The router converts common upstream errors to HTTP responses:

- TimeoutError → 504 Gateway Timeout
- TransportClosedError → 503 Service Unavailable
- Other Error → 502 Bad Gateway
- Unknown → 500 Internal Server Error

You can override with a custom handler:

```ts
const router = new RowstRouter(resolver, {
  onError: (error, req) => {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'custom', message: error instanceof Error ? error.message : String(error) })
    }
  }
})
```

## Hooks

- `beforeRequest(request, match)` – run before forwarding. Throw to abort.
- `afterResponse(response, request)` – run after receiving upstream response.

```ts
const router = new RowstRouter(resolver, {
  beforeRequest: async (req, match) => {
    if (match?.route.meta?.requiresAuth && !req.headers.authorization) {
      throw new Error('Unauthorized')
    }
  },
  afterResponse: async (res, req) => {
    // Example: add cache header to GETs
    if (req.method === 'GET' && !res.headers['cache-control']) {
      res.headers['cache-control'] = 'private, max-age=30'
    }
  }
})
```

## Framework Adapters

All adapters are zero-dependency shims; install your framework separately.

### Hono

```ts
import { Hono } from 'hono'
import { HonoAdapter } from 'rowst/http'

const app = new Hono()
new HonoAdapter(router).register(app, '/*')
```

### Express

```ts
import express from 'express'
import { ExpressAdapter } from 'rowst/http'

const app = express()
app.use(express.json())
new ExpressAdapter(router).register(app, '/*')
```

### Fastify

```ts
import Fastify from 'fastify'
import { FastifyAdapter } from 'rowst/http'

const fastify = Fastify()
await new FastifyAdapter(router).register(fastify)
```

## Backend Handler Example (WebSocket)

A minimal `ws` server that echoes based on `event`:

```ts
import { WebSocketServer } from 'ws'

// pseudo: validate incoming Rowst envelopes then respond
const wss = new WebSocketServer({ port: 8081 })
wss.on('connection', ws => {
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw)) // { id, type, payload, meta, ... }
    if (msg.type !== 'request') return

    const input = msg.payload // UpstreamRequestPayload
    let response

    switch (input.event) {
      case 'fetchUser':
        response = { status: 200, body: { id: input.params?.id, name: 'Ada' } }
        break
      case 'createPost':
        response = { status: 201, headers: { 'content-type': 'application/json' }, body: { id: 'p1' } }
        break
      default:
        response = { status: 404, body: { error: 'Not found' } }
    }

    ws.send(JSON.stringify({ id: msg.id, type: 'response', payload: response }))
  })
})
```

## Best Practices

- Register specific routes before wildcards for predictable matching
- Use `prefix` to group API routes (e.g. `/api`)
- Keep request bodies lightweight; avoid unnecessary stringify/parse cycles
- Use per-route `timeout` for slow endpoints
- Attach `meta` on routes to drive auth or logging in hooks
- Cache compiled route patterns (handled internally by router)

## API Reference

### RowstRouter

```ts
new RowstRouter(resolver: AsyncResolver, options?: RowstRouterOptions)
router.register(config: RouteConfig): void
router.get(path: string, event: string, options?: Partial<RouteConfig>): void
router.post(path: string, event: string, options?: Partial<RouteConfig>): void
router.put(path: string, event: string, options?: Partial<RouteConfig>): void
router.delete(path: string, event: string, options?: Partial<RouteConfig>): void
router.patch(path: string, event: string, options?: Partial<RouteConfig>): void
router.all(path: string, event: string, options?: Partial<RouteConfig>): void
router.handle(request: HttpRequest): Promise<HttpResponse>
router.getRoutes(): Array<{ method: string; path: string; event: string }>
```

### Types

```ts
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ALL'

interface RouteConfig {
  path: string
  event: string
  method?: HttpMethod
  timeout?: number
  meta?: Record<string, unknown>
}

interface HttpRequest {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body?: unknown
}

interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}
```

## Changelog & Compatibility

- Introduced as an optional subpath export `rowst/http`
- No new runtime dependencies
- Backwards compatible with core `rowst` consumers
