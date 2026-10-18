import { describe, it, expect } from 'vitest';
import { PresenceRegistry } from './presenceRegistry';
import type { SessionInfo } from './types';

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1', userId: 'u1', name: 'noah', role: 'admin',
    color: '#3b82f6', device: 'Windows · Chrome',
    location: null, editing: null, cursor: null, lastActive: 1000,
    ...over,
  };
}

describe('PresenceRegistry', () => {
  it('adds and gets sessions', () => {
    const r = new PresenceRegistry();
    r.add(makeSession());
    expect(r.get('s1')?.userId).toBe('u1');
    expect(r.all()).toHaveLength(1);
  });

  it('remove returns the removed session, undefined for unknown', () => {
    const r = new PresenceRegistry();
    r.add(makeSession());
    expect(r.remove('s1')?.sessionId).toBe('s1');
    expect(r.remove('s1')).toBeUndefined();
    expect(r.all()).toHaveLength(0);
  });

  it('setLocation replaces location and bumps lastActive', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ lastActive: 1000 }));
    r.setLocation('s1', { path: '/project/p1/billing', projectId: 'p1', section: 'billing' });
    const s = r.get('s1')!;
    expect(s.location?.projectId).toBe('p1');
    expect(s.lastActive).toBeGreaterThan(1000);
  });

  it('update patches only allowed fields and bumps lastActive', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ lastActive: 1000 }));
    r.update('s1', { color: '#ef4444', cursor: { x: 5, y: 6 } });
    const s = r.get('s1')!;
    expect(s.color).toBe('#ef4444');
    expect(s.cursor).toEqual({ x: 5, y: 6 });
    expect(s.name).toBe('noah');
    expect(s.lastActive).toBeGreaterThan(1000);
  });

  it('touch with explicit now sets lastActive', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ lastActive: 1000 }));
    r.touch('s1', 5000);
    expect(r.get('s1')!.lastActive).toBe(5000);
  });

  it('sweep removes and returns sessions stale beyond staleAfterMs', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ sessionId: 'fresh', lastActive: 9000 }));
    r.add(makeSession({ sessionId: 'stale', lastActive: 1000 }));
    const swept = r.sweep(5000, 10000); // cutoff: lastActive < 5000
    expect(swept.map(s => s.sessionId)).toEqual(['stale']);
    expect(r.get('stale')).toBeUndefined();
    expect(r.get('fresh')).toBeDefined();
  });

  it('methods on unknown sessionId are no-ops', () => {
    const r = new PresenceRegistry();
    expect(() => {
      r.setLocation('nope', { path: '/' });
      r.update('nope', { color: '#fff' });
      r.touch('nope');
    }).not.toThrow();
  });
});
