# Rowst Transport Guide

## Table of Contents

1. [Overview](#overview)
2. [Choosing a Transport](#choosing-a-transport)
   - [Decision Matrix](#decision-matrix)
   - [WebSocket vs WebRTC](#websocket-vs-webrtc)
3. [WebSocket Transport](#websocket-transport)
   - [Client Setup](#client-setup)
   - [Server Setup](#server-setup)
   - [Production Considerations](#production-considerations)
4. [WebRTC Transport](#webrtc-transport)
   - [Peer-to-Peer Setup](#peer-to-peer-setup)
   - [Signaling](#signaling)
   - [Performance Tuning](#performance-tuning)
5. [Custom Transports](#custom-transports)
   - [Implementation Checklist](#implementation-checklist)
   - [Example Skeleton](#example-skeleton)
6. [Backpressure & Flow Control](#backpressure--flow-control)
7. [Testing Strategies](#testing-strategies)
8. [Troubleshooting](#troubleshooting)

---

## Overview

Rowst is transport-agnostic: any bidirectional channel that can send and receive text or binary payloads can adopt request-response semantics. The library ships with WebSocket and WebRTC transports, but implementing custom transports (e.g. QUIC, serial links, message queues with reply semantics) is straightforward.

---

## Choosing a Transport

### Decision Matrix

| Requirement                 | Recommended Transport |
|-----------------------------|------------------------|
| Browser ⇄ Server            | WebSocket              |
| Browser ⇄ Browser           | WebRTC DataChannel     |
| Server ⇄ Server (LAN)       | WebSocket / Custom     |
| Low-latency game state sync | WebRTC (unordered)     |
| Guaranteed ordering         | WebSocket or ordered WebRTC |
| NAT traversal               | WebRTC with STUN/TURN  |
| Requires UDP                | WebRTC (unreliable mode) |
| Restricted environments     | Custom Transport        |

### WebSocket vs WebRTC

- **WebSocket**
  - Runs over TCP
  - Simple API in browsers and Node.js
  - NAT traversal is handled via existing HTTP/S infrastructure
  - Best for client-server or server-server communication

- **WebRTC DataChannel**
  - Runs over SCTP/UDP (configurable reliability)
  - Requires signaling to exchange SDP/ICE candidates
  - Offers low-latency and partial reliability options
  - Ideal for peer-to-peer scenarios or high-frequency messaging

---

## WebSocket Transport

### Client Setup

```ts
import { WebSocketTransport, AsyncResolver } from 'rowst';

const ws = new WebSocket('wss://api.example.com/rpc');
const transport = new WebSocketTransport(ws);

const resolver = new AsyncResolver(transport, {
  defaultTimeout: 15000
});
```

### Server Setup

For Node.js servers, wrap the WebSocket instance from libraries such as `ws`:

```ts
import { WebSocketServer } from 'ws';
import { WebSocketTransport, AsyncResolver } from 'rowst';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (socket) => {
  const transport = new WebSocketTransport(socket);
  const resolver = new AsyncResolver(transport, {
    maxInflight: 500
  });

  resolver.request({ action: 'hello' }).catch(console.error);
});
```

### Production Considerations

- Set `binaryType = 'arraybuffer'` if sending binary payloads.
- Handle reconnection logic outside of Rowst and re-register transports.
- Configure TLS (`wss://`) for production to protect message contents.
- Use `maxInflight` to limit outstanding requests and avoid backpressure.

---

## WebRTC Transport

### Peer-to-Peer Setup

```ts
import { WebRTCTransport, AsyncResolver } from 'rowst';

const peer = new RTCPeerConnection();
const channel = peer.createDataChannel('rowst', {
  ordered: true,
  maxRetransmits: 3
});

const transport = new WebRTCTransport(channel);
const resolver = new AsyncResolver(transport);
```

### Signaling

Rowst does not handle signaling; you must exchange SDP offers/answers and ICE candidates via your own signaling channel (WebSocket, REST, etc.). Once the `RTCDataChannel` is open, Rowst can wrap it.

```ts
peer.onicecandidate = ({ candidate }) => {
  sendCandidateToPeer(candidate);
};

peer.setRemoteDescription(remoteDescription);
const answer = await peer.createAnswer();
await peer.setLocalDescription(answer);
```

### Performance Tuning

- Use unordered channels (`ordered: false`) for ultra-low latency.
- Configure `maxRetransmits` for acceptable loss levels.
- Adjust `bufferedAmountLowThreshold` to detect backpressure.
- Monitor `channel.bufferedAmount` and pause sending when needed.

---

## Custom Transports

Any transport must implement the `Transport` interface. Key behaviors:

1. Maintain an accurate `readyState`.
2. Normalize incoming data to string, `ArrayBuffer`, or `Uint8Array`.
3. Emit events using `on/off`.
4. Handle errors gracefully and log appropriately.

### Implementation Checklist

- [ ] Implements `send`, `close`, `on`, `off`, `readyState`.
- [ ] Converts messages to JSON-safe payloads.
- [ ] Handles cleanup on `close` and `error`.
- [ ] Supports binary data where applicable.
- [ ] Provides logging hooks or uses `Logger`.

### Example Skeleton

```ts
class GRPCTransport implements Transport {
  readonly readyState: TransportState = 'open';
  #handlers = {
    message: new Set<TransportEvents['message']>(),
    open: new Set<TransportEvents['open']>(),
    close: new Set<TransportEvents['close']>(),
    error: new Set<TransportEvents['error']>()
  };

  send(data: string | ArrayBuffer | Uint8Array) {
    // Serialize and forward to gRPC stream
  }

  close() {
    // Close stream
  }

  on(event, handler) {
    this.#handlers[event].add(handler);
  }

  off(event, handler) {
    this.#handlers[event].delete(handler);
  }
}
```

---

## Backpressure & Flow Control

- Set `maxInflight` on `AsyncResolver` to limit outstanding requests.
- Monitor transport-specific buffer indicators:
  - WebSocket: `socket.bufferedAmount`
  - WebRTC: `channel.bufferedAmount`
- Optionally introduce queueing or drop strategies before `send`.
- Use exponential backoff with jitter (`jitterFactor`, `backoffMultiplier`) for retries.

---

## Testing Strategies

- **Unit tests**: Verify custom transport event wiring using fake sockets/channels.
- **Integration tests**: Run WebSocket/WebRTC loops using loopback or local peers.
- **Load testing**: Simulate bursts of requests to validate `maxInflight` constraints.
- **Failure scenarios**: Test transport closures, errors, malformed messages.

---

## Troubleshooting

| Symptom | Possible Cause | Fix |
|---------|----------------|-----|
| Requests never resolve | Missing response handler or transport closed | Ensure remote endpoint sends matching responses; inspect metrics |
| Frequent `TIMEOUT` errors | Network congestion or low timeout | Increase `timeout` or `retries` |
| `BACKPRESSURE` errors | Too many inflight requests | Increase `maxInflight` or throttle requests |
| Invalid message errors | Non-JSON payloads or missing fields | Validate remote message schema, ensure `id`/`type` present |
| WebRTC data not received | Signaling incomplete or ICE failure | Confirm ICE candidates exchanged, check STUN/TURN configuration |

Use the built-in logger at `DEBUG`/`TRACE` levels to trace lifecycle events and payloads.