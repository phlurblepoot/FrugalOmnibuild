import { describe, it, expect } from 'vitest';
import { BodyCache } from './bodyCache';
describe('BodyCache', () => {
  it('evicts least-recently-used when over budget', () => {
    const c = new BodyCache<string>({ maxBytes: 10, ttlMs: 60_000 });
    c.set('a', 'A', 4); c.set('b', 'B', 4); c.get('a'); c.set('c', 'C', 4);
    expect(c.get('b')).toBeUndefined(); expect(c.get('a')).toBe('A'); expect(c.get('c')).toBe('C');
  });
  it('expires entries after ttl', () => {
    let now = 0; const c = new BodyCache<string>({ maxBytes: 100, ttlMs: 10, now: () => now });
    c.set('a', 'A', 1); now = 11; expect(c.get('a')).toBeUndefined();
  });
});
