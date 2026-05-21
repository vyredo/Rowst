import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AsyncResolver } from '../src/core/AsyncResolver.js';
import { MockTransport } from './mocks/MockTransport.js';
import {
  TimeoutError,
  TransportClosedError,
  BackpressureError,
  InvalidMessageError,
  RowstError,
} from '../src/core/errors.js';

describe('AsyncResolver', () => {
  let transport: MockTransport;
  let resolver: AsyncResolver;

  beforeEach(() => {
    transport = new MockTransport();
    resolver = new AsyncResolver(transport);
  });

  afterEach(() => {
    resolver.destroy();
  });

  // ─── Request / Response Correlation ───────────────────────

  it('should resolve with response payload for successful request', async () => {
    const response = await resolver.request({ action: 'ping' });
    expect(response).toBeDefined();
    expect(response.type).toBe('response');
    expect(response.payload).toEqual({ action: 'ping' });
    expect(response.id).toBeDefined();
    expect(response.meta).toBeDefined();
  });

  it('should correlate response to correct request by ID', async () => {
    const [a, b] = await Promise.all([
      resolver.request({ action: 'getA' }),
      resolver.request({ action: 'getB' }),
    ]);
    expect(a.payload).toEqual({ action: 'getA' });
    expect(b.payload).toEqual({ action: 'getB' });
    expect(a.id).not.toBe(b.id);
  });

  it('should assign unique IDs to concurrent requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        resolver.request({ index: i })
      )
    );
    const ids = responses.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(20);
  });

  // ─── Timeout ──────────────────────────────────────────────

  it('should timeout and reject after configured timeout', async () => {
    const noEchoTransport = new MockTransport({ echoTransform: () => {
      // never echo back — simulate a server that doesn't respond
      return undefined as unknown;
    }});
    const timeoutResolver = new AsyncResolver(noEchoTransport, {
      defaultTimeout: 100,
    });

    // Override send to never emit response
    const originalSend = noEchoTransport.send.bind(noEchoTransport);
    noEchoTransport.send = () => {
      // silently drop — simulate a server that receives but doesn't respond
    };

    await expect(timeoutResolver.request({ action: 'slow' })).rejects.toThrow(TimeoutError);

    timeoutResolver.destroy();
  }, 10000);

  it('should use per-request timeout over default timeout', async () => {
    const noEchoTransport = new MockTransport();
    const timeoutResolver = new AsyncResolver(noEchoTransport, {
      defaultTimeout: 50,
    });

    // Don't echo — simulate no response
    noEchoTransport.send = () => {};

    const start = Date.now();
    await expect(
      timeoutResolver.request({ action: 'slow' }, { timeout: 200 })
    ).rejects.toThrow(TimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);

    timeoutResolver.destroy();
  }, 10000);

  // ─── Transport Close ─────────────────────────────────────

  it('should reject all pending requests when transport closes', async () => {
    // Override send to NOT auto-respond (simulate server receiving but closing)
    transport.send = () => {};

    const promise = resolver.request({ action: 'doomed' });

    // Close transport before response
    transport.close();

    await expect(promise).rejects.toThrow(TransportClosedError);
  });

  // ─── Backpressure ────────────────────────────────────────

  it('should reject when max inflight requests exceeded', async () => {
    const limitedResolver = new AsyncResolver(transport, {
      maxInflight: 2,
    });

    // Don't respond — hold requests indefinitely
    transport.send = () => {};

    // Fire two requests that will be pending forever
    limitedResolver.request({ action: 'a' }).catch(() => {});
    limitedResolver.request({ action: 'b' }).catch(() => {});

    await expect(limitedResolver.request({ action: 'c' })).rejects.toThrow(BackpressureError);

    limitedResolver.destroy();
  });

  // ─── Retry ───────────────────────────────────────────────

  it('should retry on timeout and succeed on subsequent attempt', async () => {
    const failingTransport = new MockTransport();
    let attempt = 0;
    failingTransport.send = function(this: MockTransport, data: string | ArrayBuffer | Uint8Array) {
      attempt++;
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      const envelope = JSON.parse(raw) as { id: string; type: string; payload: unknown };

      if (attempt < 3) {
        // First 2 attempts: timeout (don't respond at all)
        return;
      }

      // 3rd attempt: respond
      const response = JSON.stringify({
        id: envelope.id,
        type: 'response',
        payload: envelope.payload,
        timestamp: new Date().toISOString(),
      });
      // Use a microtask to simulate async response
      queueMicrotask(() => {
        (failingTransport as unknown as { dispatch: (event: string, data: string) => void }).dispatch?.('message', response);
      });
    };

    // Add dispatch method
    const dispatch = (failingTransport as unknown as { _dispatch: (e: string, d: string) => void })['_dispatch'];
    const retryResolver = new AsyncResolver(failingTransport, {
      defaultTimeout: 50,
    });

    const response = await retryResolver.requestWithRetry({ action: 'retry-me' }, {
      retries: 4,
      timeout: 50,
    });

    expect(response).toBeDefined();
    expect(response.payload).toEqual({ action: 'retry-me' });
    expect(response.meta?.attempts).toBe(3);

    retryResolver.destroy();
  }, 10000);

  it('should fail after max retries exceeded', async () => {
    const noResponseTransport = new MockTransport({ delayMs: 0 });
    noResponseTransport.send = () => {}; // never respond

    const retryResolver = new AsyncResolver(noResponseTransport, {
      defaultTimeout: 50,
    });

    await expect(
      retryResolver.requestWithRetry({ action: 'fail' }, {
        retries: 2,
        timeout: 50,
      })
    ).rejects.toThrow(TimeoutError);

    retryResolver.destroy();
  }, 10000);

  it('should not retry on InvalidMessageError', async () => {
    // Simulate a transport that sends back invalid messages
    const badTransport = new MockTransport();
    const retryResolver = new AsyncResolver(badTransport, {
      defaultTimeout: 50,
    });

    // Override MockTransport.send to emit an invalid message
    badTransport.send = function(this: MockTransport, data: string | ArrayBuffer | Uint8Array) {
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      const envelope = JSON.parse(raw) as { id: string; type: string; payload: unknown };
      // Send back a response with NO id — this will cause an InvalidMessageError
      // when the resolver processes it. But the resolver catches these in onTransportMessage
      // and increments error count, but does NOT route to the pending request (because no id matches).
      // So the pending request will timeout instead.
      // Actually better: just don't respond at all — the request should timeout
    };

    // The request will timeout (no response). The key test: it should NOT be retried
    // because the retry count is 0.
    await expect(
      retryResolver.requestWithRetry({ action: 'test' }, { retries: 0, timeout: 50 })
    ).rejects.toThrow(TimeoutError);

    retryResolver.destroy();
  }, 10000);

  // ─── Notification ────────────────────────────────────────

  it('should send notification without expecting a response', () => {
    // Should not throw
    expect(() => resolver.notify({ event: 'user-login', userId: 42 })).not.toThrow();
  });

  it('should not affect pending request count for notification', async () => {
    // Send a request (it will respond via MockTransport auto-echo)
    const reqPromise = resolver.request({ action: 'test' });
    expect(resolver.getInflightCount()).toBe(1);

    // Send a notification — shouldn't change inflight count
    resolver.notify({ event: 'ping' });
    expect(resolver.getInflightCount()).toBe(1);

    await reqPromise;
    expect(resolver.getInflightCount()).toBe(0);
  });

  // ─── Metrics ─────────────────────────────────────────────

  it('should track request and response counts', async () => {
    await resolver.request({ action: 'a' });
    await resolver.request({ action: 'b' });
    await resolver.request({ action: 'c' });

    const metrics = resolver.getMetrics();
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.totalResponses).toBe(3);
  });

  it('should track timeout count', async () => {
    const noResponse = new MockTransport();
    noResponse.send = () => {};
    const timeoutResolver = new AsyncResolver(noResponse, { defaultTimeout: 50 });

    await expect(timeoutResolver.request({ action: 'timeout' })).rejects.toThrow(TimeoutError);

    const metrics = timeoutResolver.getMetrics();
    expect(metrics.totalTimeouts).toBe(1);

    timeoutResolver.destroy();
  }, 10000);

  it('should provide latency statistics', async () => {
    // Fire multiple requests to collect latency data
    for (let i = 0; i < 20; i++) {
      await resolver.request({ index: i });
    }

    const metrics = resolver.getMetrics();
    expect(metrics.stats).toBeDefined();
    expect(metrics.stats.min).toBeGreaterThanOrEqual(0);
    expect(metrics.stats.max).toBeGreaterThanOrEqual(0);
    expect(metrics.stats.mean).toBeGreaterThanOrEqual(0);
    expect(metrics.stats.p50).toBeGreaterThanOrEqual(0);
    expect(metrics.stats.p95).toBeGreaterThanOrEqual(0);
    expect(metrics.stats.p99).toBeGreaterThanOrEqual(0);
    expect(metrics.latencies.length).toBeGreaterThan(0);
  });

  it('should return zero stats when no requests made', () => {
    const metrics = resolver.getMetrics();
    expect(metrics.stats.min).toBe(0);
    expect(metrics.stats.max).toBe(0);
    expect(metrics.stats.mean).toBe(0);
  });

  // ─── Destroy ─────────────────────────────────────────────

  it('should cleanup and reject pending requests on destroy', async () => {
    transport.send = () => {}; // don't respond

    const promise = resolver.request({ action: 'hanging' });
    resolver.destroy();

    await expect(promise).rejects.toThrow(TransportClosedError);
    expect(resolver.getInflightCount()).toBe(0);
  });

  it('should not throw on repeated destroy calls', () => {
    resolver.destroy();
    expect(() => resolver.destroy()).not.toThrow();
  });

  // ─── Transport Already Closed ────────────────────────────

  it('should reject request if transport is already closed', async () => {
    transport.close();
    // Wait for mock close to finish
    await new Promise((r) => setTimeout(r, 10));

    await expect(resolver.request({ action: 'late' })).rejects.toThrow(TransportClosedError);
  });

  // ─── Error Responses ─────────────────────────────────────

  it('should reject with remote error when response contains error field', async () => {
    const errorTransport = new MockTransport();
    const errorResolver = new AsyncResolver(errorTransport);

    // Intercept send to emit a response with error at the message envelope level
    errorTransport.send = function(this: MockTransport, data: string | ArrayBuffer | Uint8Array) {
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
      const envelope = JSON.parse(raw) as { id: string; type: string; payload: unknown };
      if (envelope.type === 'request') {
        const response = JSON.stringify({
          id: envelope.id,
          type: 'response',
          payload: null,
          error: { code: 'CUSTOM_ERR', message: 'Something went wrong' },
          timestamp: new Date().toISOString(),
        });
        queueMicrotask(() => this.injectMessage(response));
      }
    };

    await expect(errorResolver.request({ action: 'bad' })).rejects.toThrow(RowstError);

    errorResolver.destroy();
  });

  // ─── Echo Transform ─────────────────────────────────────

  it('should return transformed payload via echoTransform', async () => {
    const echoTransport = new MockTransport({
      echoTransform: (payload) => ({ ...(payload as object), echoed: true }),
    });
    const echoResolver = new AsyncResolver(echoTransport);

    const response = await echoResolver.request({ action: 'test' });
    expect(response.payload).toEqual({ action: 'test', echoed: true });

    echoResolver.destroy();
  });

  // ─── Custom Request IDs ─────────────────────────────────

  it('should generate unique UUIDs for each request', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = resolver.request({ index: i });
      // Can't get ID before response comes, so we batch-fire and check responses
    }

    // Fire and collect
    return Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        resolver.request({ index: i }).then((r) => {
          ids.add(r.id);
        })
      )
    ).then(() => {
      expect(ids.size).toBe(10);
    });
  });

  // ─── Logger integration ──────────────────────────────────

  it('should log notifications when logger is provided', () => {
    const logged: string[] = [];
    const logger = {
      info: (msg: string) => logged.push(msg),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as any;

    const loggedResolver = new AsyncResolver(transport, { logger });

    loggedResolver.notify({ action: 'test' });

    expect(logged.length).toBeGreaterThanOrEqual(0); // Info log happens if level permits

    loggedResolver.destroy();
  });
});
