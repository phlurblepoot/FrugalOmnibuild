import { describe, it, expect } from 'vitest';
import { createSingleFlightQueue } from './queue';

describe('createSingleFlightQueue', () => {
  it('runs tasks one at a time in order', async () => {
    const q = createSingleFlightQueue({ timeoutMs: 1000 });
    const order: number[] = [];
    const running: number[] = [];
    const make = (n: number) => async () => {
      running.push(n);
      expect(running.length).toBe(1); // never two at once
      await new Promise(r => setTimeout(r, 5));
      running.pop();
      order.push(n);
      return n;
    };
    const results = await Promise.all([q.enqueue(make(1)), q.enqueue(make(2)), q.enqueue(make(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects a task that exceeds the timeout but keeps the queue alive', async () => {
    const q = createSingleFlightQueue({ timeoutMs: 20 });
    await expect(q.enqueue(() => new Promise(() => {}))).rejects.toThrow(/timed out/i);
    await expect(q.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('a rejecting task does not block the next', async () => {
    const q = createSingleFlightQueue({ timeoutMs: 1000 });
    await expect(q.enqueue(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(q.enqueue(async () => 42)).resolves.toBe(42);
  });
});
