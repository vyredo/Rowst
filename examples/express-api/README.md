# Express-like API Example

This example demonstrates how to use Rowst's Express-like API to create HTTP REST endpoints that communicate with WebSocket upstream services.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Start an upstream WebSocket service on `ws://localhost:8080` that responds to events like:
   - `get_user`
   - `get_comment`
   - `start_job`
   - `ping`

3. Run the server:

```bash
npx tsx server.ts
```

4. Test the endpoints:

```bash
# Health check
curl http://localhost:3000/health

# Get user
curl http://localhost:3000/api/users/123

# Get comments
curl -X POST http://localhost:3000/api/comments \
  -H "Content-Type: application/json" \
  -d '{"postUrl": "https://example.com/post/123", "limit": 50}'

# Start job
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "depth": 2}'
```

## Features Demonstrated

- **GET routes** with path parameters
- **POST routes** with JSON body parsing
- **Input validation** before forwarding to upstream
- **Connection state checking**
- **Error handling** with try-catch
- **Retry logic** for transient failures
- **Fire-and-forget** analytics events
- **Custom timeouts** per route
- **Type-safe** responses with TypeScript generics

## Code Structure

The example shows a complete server setup with:

1. WebSocket transport initialization
2. AsyncResolver configuration
3. RowstRoute instance creation
4. Multiple route registrations with different patterns
5. Server startup with connection readiness check
