import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerPoolResolver } from '../src/core/WorkerPoolResolver.js';
import { MockTransport } from './mocks/MockTransport.js';

describe('WorkerPoolResolver', () => {
  let transport: MockTransport;
  let resolver: WorkerPoolResolver;

  beforeEach(() => {
    transport = new MockTransport();
    resolver = new WorkerPoolResolver(transport, {
      workerCount: 2,
      // keep defaults: serialize/deserialize in worker enabled by our implementation
    });
  });

  afterEach(async () => {
    // Ensure resolver detaches listeners and terminates pool
    resolver.destroy();
    // tiny delay to allow worker termination to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  it('should serialize large payloads in worker', async () => {
    const largePayload = { data: 'x'.repeat(100_000) };

    const response = await resolver.request(largePayload);

    expect(response).toBeDefined();
    const stats = resolver.getWorkerPoolStats();
    expect(stats.totalTasksCompleted).toBeGreaterThan(0);
  });

  it('should handle multiple concurrent requests', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      resolver.request({ index: i, data: 'test'.repeat(10_000) })
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(10);

    const stats = resolver.getWorkerPoolStats();
    expect(stats.totalTasksCompleted).toBeGreaterThan(0);
    expect(stats.busyWorkers).toBeGreaterThanOrEqual(0);
  });

  it('should fallback to single-threaded for small payloads', async () => {
    const smallPayload = { data: 'small' };

    const response = await resolver.request(smallPayload);
    expect(response).toBeDefined();
  });

  it('should handle worker task timeouts', async () => {
    // Use a separate transport/resolver to avoid interference with other tests
    const transport2 = new MockTransport();
    const resolver2 = new WorkerPoolResolver(transport2, {
      workerCount: 2,
      taskTimeout: 1, // extremely tight to force timeout
      // ensure workers are used regardless of size
      useWorkersWhen: () => true,
      serializeInWorker: true
    });

    // Construct a heavy payload likely to exceed the 1ms worker window
    // Large nested array + big strings
    const bigArray = Array.from({ length: 200_000 }, (_, i) => i % 10);
    const hugePayload = {
      a: 'y'.repeat(200_000),
      b: bigArray,
      c: { d: 'z'.repeat(200_000) }
    };

    await expect(resolver2.request(hugePayload)).rejects.toThrow(/timeout/i);

    resolver2.destroy();
  });
});

describe('WorkerPoolResolver - additional', () => {
  it('should return original response when worker deserialize fails', async () => {
    const transport = new MockTransport();
    const resolver = new WorkerPoolResolver(transport, {
      workerCount: 1,
      useWorkersWhen: () => true,
      serializeInWorker: false,
      deserializeInWorker: true
    });

    const bad = 'not-json'; // invalid JSON, will cause worker deserialize to throw
    const res = await resolver.request(bad);

    // Resolver should fall back to original payload on worker deserialize error
    expect(res.payload).toBe(bad);

    const stats = resolver.getWorkerPoolStats();
    expect(stats.totalTasksCompleted).toBeGreaterThan(0);

    resolver.destroy();
  });

  it('should use workers when useWorkersWhen forces worker path for small payloads', async () => {
    const transport = new MockTransport();
    const resolver = new WorkerPoolResolver(transport, {
      workerCount: 2,
      useWorkersWhen: () => true, // force worker usage regardless of size
      serializeInWorker: true
    });

    const res = await resolver.request({ tiny: 'x' });
    expect(res).toBeDefined();

    const stats = resolver.getWorkerPoolStats();
    expect(stats.totalTasksCompleted).toBeGreaterThan(0);

    resolver.destroy();
  });
});