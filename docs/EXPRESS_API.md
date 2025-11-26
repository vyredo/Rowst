# Express-like API for Rowst

The Express-like API provides a simplified interface for integrating HTTP REST endpoints with WebSocket event handlers via Rowst's AsyncResolver. This eliminates boilerplate code and reduces complexity in hybrid REST/WebSocket applications.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Usage Examples](#usage-examples)
- [Best Practices](#best-practices)
- [Migration Guide](#migration-guide)

## Installation

```bash
npm install rowst hono
```

Note: Hono is a peer dependency. The Express-like API is designed to work with Hono's routing system.

## Quick Start

```typescript
import { Hono } from "hono";
import { AsyncResolver, WebSocketTransport } from "rowst";
import { RowstRoute } from "rowst/express";

// Setup
const app = new Hono();
const transport = new WebSocketTransport("ws://upstream-service");
const resolver = new AsyncResolver(transport);
const routes = new RowstRoute({ app, resolver });

// Register a route
routes.post(
  { rest: "/api/comments", event: "get_comment" },
  async ({ honoContext, websocketContext }) => {
    const data = await honoContext.req.json();
    const result = await websocketContext.request(data);
    return honoContext.json(result.data, result.status);
  }
);

// Start server
export default app;
```

## API Reference

### `RowstRoute`

The main class for registering routes.

#### Constructor

```typescript
new RowstRoute(options: RowstRouteOptions)
```

**Options:**

- `app`: Hono application instance
- `resolver`: AsyncResolver instance for WebSocket communication

#### Methods

##### `get(config, handler)`

Register a GET route.

##### `post(config, handler)`

Register a POST route.

##### `put(config, handler)`

Register a PUT route.

##### `delete(config, handler)`

Register a DELETE route.

##### `patch(config, handler)`

Register a PATCH route.

##### `all(config, handler)`

Register a route for all HTTP methods.

**Parameters:**

- `config`: `RowstRouteConfig` - Route configuration
  - `rest`: HTTP path pattern (Express-style, e.g., `/api/users/:id`)
  - `event`: WebSocket event name to send to upstream
  - `timeoutMs?`: Optional timeout in milliseconds for this route
- `handler`: `RowstHandler` - Route handler function

### `RowstRouteHandlerContext`

Context object passed to route handlers.

**Properties:**

- `honoContext`: Full Hono context (request, response, params, etc.)
- `websocketContext`: WebSocket context for upstream communication
  - `connected`: Boolean indicating if WebSocket is connected
  - `request<T>(payload?, opts?)`: Send request and await response
  - `send(payload?)`: Fire-and-forget message

### `UpstreamResponse<T>`

Response object from upstream WebSocket request.

**Properties:**

- `status`: HTTP status code
- `headers`: Response headers
- `bodyText`: Raw response body as text
- `data?`: Parsed response data (if JSON)
- `message`: Original message from AsyncResolver

## Usage Examples

### Basic GET Request

```typescript
routes.get(
  { rest: "/api/users/:id", event: "get_user" },
  async ({ honoContext, websocketContext }) => {
    const userId = honoContext.req.param("id");
    
    const result = await websocketContext.request({ userId });
    
    return honoContext.json(result.data, result.status);
  }
);
```

### POST with Validation

```typescript
routes.post(
  { rest: "/api/jobs", event: "start_job", timeoutMs: 5000 },
  async ({ honoContext, websocketContext }) => {
    const { url, depth = 1 } = await honoContext.req.json();
    
    // Validate input
    if (!url || !url.startsWith("https://")) {
      return honoContext.json({ error: "Invalid URL" }, 400);
    }
    
    // Check connection
    if (!websocketContext.connected) {
      return honoContext.json({ error: "Service unavailable" }, 503);
    }
    
    // Make request
    const result = await websocketContext.request({ url, depth });
    
    return honoContext.json(result.data, result.status);
  }
);
```

### Error Handling with Retry

```typescript
routes.post(
  { rest: "/api/data", event: "fetch_data" },
  async ({ honoContext, websocketContext }) => {
    try {
      const result = await websocketContext.request(
        await honoContext.req.json(),
        { timeout: 3000, retries: 2 }
      );
      
      return honoContext.json(result.data);
    } catch (error) {
      // Handle timeout or connection errors
      return honoContext.json(
        { error: "Request failed", details: error.message },
        504
      );
    }
  }
);
```

### Fire-and-Forget Analytics

```typescript
routes.post(
  { rest: "/api/action", event: "perform_action" },
  async ({ honoContext, websocketContext }) => {
    const data = await honoContext.req.json();
    
    // Main request
    const result = await websocketContext.request(data);
    
    // Fire-and-forget analytics event
    websocketContext.send({
      event: "analytics",
      action: "action_performed",
      timestamp: Date.now()
    });
    
    return honoContext.json(result.data);
  }
);
```

### Query Parameters

```typescript
routes.get(
  { rest: "/api/search", event: "search" },
  async ({ honoContext, websocketContext }) => {
    // Query params are automatically included in the upstream request
    const result = await websocketContext.request();
    
    return honoContext.json(result.data);
  }
);

// Request: GET /api/search?q=test&limit=10
// Upstream receives: { method: "GET", path: "/api/search", query: "?q=test&limit=10", ... }
```

### Custom Payload Override

```typescript
routes.post(
  { rest: "/api/process", event: "process_data" },
  async ({ honoContext, websocketContext }) => {
    const body = await honoContext.req.json();
    
    // Override the payload sent to upstream
    const result = await websocketContext.request({
      ...body,
      processedAt: Date.now(),
      version: "2.0"
    });
    
    return honoContext.json(result.data);
  }
);
```

### Fallback to Cache on Timeout

```typescript
routes.get(
  { rest: "/api/status/:jobId", event: "get_status", timeoutMs: 3000 },
  async ({ honoContext, websocketContext }) => {
    const jobId = honoContext.req.param("jobId");
    
    try {
      const result = await websocketContext.request({ jobId });
      return honoContext.json(result.data);
    } catch (error) {
      // Fallback to local cache
      const cached = await localCache.get(jobId);
      if (cached) {
        return honoContext.json({ ...cached, cached: true });
      }
      
      return honoContext.json({ error: "Job not found" }, 404);
    }
  }
);
```

## Best Practices

### 1. Connection State Checking

Always check the connection state before making critical requests:

```typescript
if (!websocketContext.connected) {
  return honoContext.json({ error: "Service unavailable" }, 503);
}
```

### 2. Timeout Configuration

Set appropriate timeouts based on operation complexity:

```typescript
// Quick operations
{ rest: "/api/ping", event: "ping", timeoutMs: 1000 }

// Standard operations
{ rest: "/api/data", event: "fetch", timeoutMs: 5000 }

// Long-running operations
{ rest: "/api/process", event: "process", timeoutMs: 30000 }
```

### 3. Error Handling

Always wrap upstream requests in try-catch blocks:

```typescript
try {
  const result = await websocketContext.request(data);
  return honoContext.json(result.data);
} catch (error) {
  // Log error
  logger.error("Upstream request failed", error);
  
  // Return appropriate error response
  return honoContext.json({ error: "Request failed" }, 500);
}
```

### 4. Input Validation

Validate input before forwarding to upstream:

```typescript
const { url, depth } = await honoContext.req.json();

if (!url || typeof depth !== "number" || depth < 1) {
  return honoContext.json({ error: "Invalid input" }, 400);
}
```

### 5. Use Retries for Transient Failures

Configure retries for operations that may fail temporarily:

```typescript
const result = await websocketContext.request(data, {
  timeout: 5000,
  retries: 2  // Will retry up to 2 times on failure
});
```

## Migration Guide

### From Manual Implementation

**Before:**

```typescript
// File 1: HTTP route
app.post("/api/comments", async (c) => {
  const envelope = buildRowstEnvelope(c.req);
  await upstreamWs.send(JSON.stringify(envelope));
  // Wait for response...
});

// File 2: WebSocket handler
export async function handleForwardedMessage(ws, message, state) {
  const resource = parsePath(message.path);
  const eventType = mapResourceToEvent(resource);
  // ...
}

// File 3: Domain handler
export async function handleGetComments(ws, message, state) {
  const { postUrl, limit, offset } = message.data;
  const comments = await repository.getComments(postUrl, { limit, offset });
  ws.send(JSON.stringify({ type: "get_comment_response", data: { comments } }));
}
```

**After:**

```typescript
// Single file
routes.post(
  { rest: "/api/comments", event: "get_comment" },
  async ({ honoContext, websocketContext }) => {
    const { postUrl, limit, offset } = await honoContext.req.json();
    const result = await websocketContext.request({ postUrl, limit, offset });
    return honoContext.json(result.data, result.status);
  }
);
```

### Benefits

1. **Reduced Code**: ~150 lines → ~20 lines
2. **Single File**: 3 files → 1 file
3. **Type Safety**: Full TypeScript support
4. **Automatic Correlation**: No manual envelope building
5. **Built-in Error Handling**: Timeout and retry support
6. **Testability**: Easy to mock and test

## TypeScript Support

The Express-like API is fully typed:

```typescript
interface Comment {
  id: string;
  text: string;
  author: string;
}

routes.post(
  { rest: "/api/comments", event: "get_comment" },
  async ({ honoContext, websocketContext }) => {
    const result = await websocketContext.request<{
      comments: Comment[];
      total: number;
    }>(await honoContext.req.json());
    
    // result.data is typed as { comments: Comment[]; total: number; }
    return honoContext.json(result.data);
  }
);
```

## Testing

See the comprehensive test suite in `tests/express/RowstRoute.test.ts` for examples of:

- HTTP method registration
- WebSocket context usage
- Request payload building
- Response handling
- Error handling
- Integration testing

## Performance

The Express-like API adds minimal overhead:

- **Request Correlation**: Uses existing AsyncResolver (no additional overhead)
- **Memory**: Only stores route registrations and active request promises
- **Latency**: ~1-2ms for context building and payload extraction
- **Throughput**: No bottleneck - delegates to Hono and AsyncResolver

## License

MIT
