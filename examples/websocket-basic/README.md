# WebSocket Basic Example

A minimal request/response demo using Rowst over a WebSocket transport.

## Prerequisites

- Node.js 18+
- Install dependencies and build the library:

```bash
npm install
npm run build
```

## Running the Example

In two separate terminals:

### 1. Start the server

```bash
node examples/websocket-basic/server.js
```

> Tip: You can compile the TypeScript file using `ts-node` or `tsx` if you prefer not to emit JavaScript.

### 2. Start the client

```bash
node examples/websocket-basic/client.js
```

### Expected Output

- Server logs connection events and echoes the payload.
- Client logs the echoed response and latency metadata.

## TypeScript Execution

If you want to execute the TypeScript sources directly, use a runner such as [`tsx`](https://github.com/esbuild-kit/tsx):

```bash
npx tsx examples/websocket-basic/server.ts
npx tsx examples/websocket-basic/client.ts
```

Ensure the library is built (`npm run build`) so the examples can import from `../../dist/index.js`.