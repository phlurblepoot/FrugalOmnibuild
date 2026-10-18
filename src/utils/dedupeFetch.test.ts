import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dedupeInFlight, __clearDedupeCache } from './dedupeFetch';

describe('dedupeInFlight', () => {
  beforeEach(() => {
    __clearDedupeCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one in-flight call across concurrent callers with the same key', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve('value');
    };

    const [a, b, c] = await Promise.all([
      dedupeInFlight('k1', fn),
      dedupeInFlight('k1', fn),
      dedupeInFlight('k1', fn),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe('value');
    expect(b).toBe('value');
    expect(c).toBe('value');
  });

  it('re-invokes fn for a call made after the TTL has elapsed', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve(`value-${calls}`);
    };

    const first = await dedupeInFlight('k2', fn, 250);
    expect(first).toBe('value-1');
    expect(calls).toBe(1);

    // Advance past the TTL so the cached resolution evicts.
    await vi.advanceTimersByTimeAsync(251);

    const second = await dedupeInFlight('k2', fn, 250);
    expect(second).toBe('value-2');
    expect(calls).toBe(2);
  });

  it('serves a cached resolution to a call made before the TTL elapses', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve(`value-${calls}`);
    };

    const first = await dedupeInFlight('k3', fn, 250);
    expect(first).toBe('value-1');

    await vi.advanceTimersByTimeAsync(100);

    const second = await dedupeInFlight('k3', fn, 250);
    expect(second).toBe('value-1');
    expect(calls).toBe(1);
  });

  it('evicts immediately on rejection so a retry re-invokes fn', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve('recovered');
    };

    await expect(dedupeInFlight('k4', fn, 250)).rejects.toThrow('boom');
    expect(calls).toBe(1);

    // No need to advance time — rejection should not be cached at all.
    const retry = await dedupeInFlight('k4', fn, 250);
    expect(retry).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('treats concurrent callers with different keys independently', async () => {
    let callsA = 0;
    let callsB = 0;
    const fnA = () => { callsA++; return Promise.resolve('a'); };
    const fnB = () => { callsB++; return Promise.resolve('b'); };

    const [a, b] = await Promise.all([
      dedupeInFlight('key-a', fnA),
      dedupeInFlight('key-b', fnB),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });

  it('defaults ttlMs to 250', async () => {
    let calls = 0;
    const fn = () => { calls++; return Promise.resolve('v'); };

    await dedupeInFlight('k5', fn);
    await vi.advanceTimersByTimeAsync(249);
    await dedupeInFlight('k5', fn);
    expect(calls).toBe(1); // still cached just under the default TTL

    await vi.advanceTimersByTimeAsync(2);
    await dedupeInFlight('k5', fn);
    expect(calls).toBe(2); // evicted after the default TTL
  });
});
