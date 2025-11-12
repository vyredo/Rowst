# MCP Integration Guide

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Registering Transports](#registering-transports)
4. [MCP Tools](#mcp-tools)
   - [rowst.request](#rowstrequest)
   - [rowst.metrics](#rowstmetrics)
5. [Configuration](#configuration)
6. [Running the MCP Server](#running-the-mcp-server)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)

---

## Overview

Rowst ships with a Model Context Protocol (MCP) adapter that exposes request-response functionality as MCP tools. The `RowstMCPServer` class manages `AsyncResolver` instances keyed by transport IDs.

Use cases include:

- Connecting LLM agents to WebSocket or WebRTC backends.
- Sharing a single transport across multiple MCP tools.
- Gathering metrics from active transports.

---

## Installation

Ensure Rowst is installed:

```bash
npm install rowst
```

The MCP module is exported via the `rowst/mcp` entry point.

---

## Registering Transports

Register an already connected transport with a unique identifier:

```ts
import { RowstMCPServer } from 'rowst/mcp';
import { WebSocketTransport } from 'rowst';

const server = new RowstMCPServer();

const socket = new WebSocket('wss://api.example.com');
const transport = new WebSocketTransport(socket);

server.registerTransport('backend', transport, {
  defaultTimeout: 10000,
  maxInflight: 500
});
```

To remove a transport:

```ts
server.unregisterTransport('backend');
```

---

## MCP Tools

### rowst.request

Sends a correlated request over the registered transport and awaits a response.

**Input Schema**

```json
{
  "type": "object",
  "properties": {
    "transportId": { "type": "string" },
    "payload": { "type": "object" },
    "options": { "type": "object" }
  },
  "required": ["transportId", "payload"]
}
```

**Example**

```json
{
  "transportId": "backend",
  "payload": {
    "action": "fetchUser",
    "userId": 42
  },
  "options": {
    "timeout": 5000,
    "tags": ["users", "read"]
  }
}
```

### rowst.metrics

Retrieves resolver metrics and latency statistics.

**Input Schema**

```json
{
  "type": "object",
  "properties": {
    "transportId": { "type": "string" }
  },
  "required": ["transportId"]
}
```

**Sample Output**

```json
{
  "inflightCount": 2,
  "totalRequests": 120,
  "totalResponses": 118,
  "totalTimeouts": 2,
  "totalErrors": 3,
  "latencies": [12, 18, 25, 40],
  "stats": {
    "min": 12,
    "max": 110,
    "mean": 38.4,
    "median": 24,
    "p50": 24,
    "p95": 90,
    "p99": 110
  }
}
```

---

## Configuration

`RowstMCPServer#getMCPConfig()` returns a MCP configuration object for tooling discovery:

```ts
const config = server.getMCPConfig();
```

Example config snippet:

```json
{
  "name": "rowst",
  "version": "0.1.0",
  "tools": [
    { "name": "rowst.request", "description": "Send a request over a Rowst transport", ... },
    { "name": "rowst.metrics", "description": "Get metrics for a Rowst transport", ... }
  ]
}
```

To integrate with an MCP controller, add a configuration entry:

```json
{
  "mcpServers": {
    "rowst": {
      "command": "node",
      "args": ["./dist/mcp-server.js"],
      "env": {
        "LOG_LEVEL": "INFO"
      }
    }
  }
}
```

---

## Running the MCP Server

1. Build Rowst (`npm run build`).
2. Create an entry point that instantiates the MCP server and registers transports.
3. Launch via your MCP host (e.g. [Claude MCP](https://modelcontextprotocol.io)).

Example `server.ts`:

```ts
import { RowstMCPServer } from 'rowst/mcp';
import { WebSocketTransport } from 'rowst';

const server = new RowstMCPServer();

async function main() {
  const socket = new WebSocket('wss://api.example.com');
  const transport = new WebSocketTransport(socket);

  server.registerTransport('backend', transport, {
    defaultTimeout: 15000
  });

  // Expose tools via your MCP host environment
  process.on('SIGINT', () => {
    server.unregisterTransport('backend');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('MCP server failed to start', error);
  process.exit(1);
});
```

---

## Best Practices

- Use descriptive transport IDs (`"backend"`, `"analytics"`, `"realtime"`).
- Wrap registration in retry logic for transports that connect asynchronously.
- Deregister transports on disconnect to avoid stale references.
- Monitor metrics periodically via `rowst.metrics`.
- Use the built-in logging facilities to debug MCP interactions.

---

## Troubleshooting

| Issue | Possible Cause | Resolution |
|-------|----------------|------------|
| `Transport X not found` | Transport not registered or ID mismatch | Verify ID consistency, ensure registration completes |
| Requests timeout | Transport not open or remote endpoint not responding | Check transport readiness, review remote service logs |
| Metrics show high backpressure | Max inflight reached | Increase `maxInflight` or throttle client requests |
| Unexpected JSON errors | Payload not serializable | Ensure payloads are JSON-safe without functions or circular references |
| MCP host fails to load tools | `getMCPConfig` not wired into host | Ensure host consumes the config output or use static JSON configuration |

For verbose logging, instantiate `Logger` with `LogLevel.DEBUG` and attach to transports and resolvers used within the MCP server.