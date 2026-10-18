import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';
import { projectRoom, pageRoom, pathRoom } from './registerRealtime';

describe('set-location and rooms', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  async function socketRooms(sessionId: string): Promise<Set<string>> {
    for (const [, s] of srv.io.of('/').sockets) {
      if (s.data.sessionId === sessionId) return new Set(s.rooms);
    }
    return new Set();
  }

  it('joins project/page/path rooms from location and leaves them on change', async () => {
    const client = connectClient(srv.port, makeToken());
    const snap = await waitFor<{ selfId: string }>(client, 'sessions-snapshot');

    client.emit('set-location', { path: '/project/p1/page/pg1', projectId: 'p1', pageId: 'pg1', label: 'Floor 6' });
    await new Promise((r) => setTimeout(r, 100));
    let rooms = await socketRooms(snap.selfId);
    expect(rooms.has(projectRoom('p1'))).toBe(true);
    expect(rooms.has(pageRoom('pg1'))).toBe(true);
    expect(rooms.has(pathRoom('/project/p1/page/pg1'))).toBe(true);

    client.emit('set-location', { path: '/dashboard' });
    await new Promise((r) => setTimeout(r, 100));
    rooms = await socketRooms(snap.selfId);
    expect(rooms.has(projectRoom('p1'))).toBe(false);
    expect(rooms.has(pageRoom('pg1'))).toBe(false);
    expect(rooms.has(pathRoom('/dashboard'))).toBe(true);
    expect(srv.handle.registry.get(snap.selfId)?.location?.path).toBe('/dashboard');
    client.close();
  });

  it('broadcasts session-updated with the new location to other clients', async () => {
    const a = connectClient(srv.port, makeToken({ id: 'u1', username: 'a' }));
    await waitFor(a, 'sessions-snapshot');
    const b = connectClient(srv.port, makeToken({ id: 'u2', username: 'b' }));
    const bSnap = await waitFor<{ selfId: string }>(b, 'sessions-snapshot');

    const updated = waitFor<any>(a, 'session-updated');
    b.emit('set-location', { path: '/project/p1/billing', projectId: 'p1', section: 'billing' });
    const evt = await updated;
    expect(evt.sessionId).toBe(bSnap.selfId);
    expect(evt.location.section).toBe('billing');
    a.close(); b.close();
  });

  it('update-user patches name/color only and broadcasts session-updated', async () => {
    const a = connectClient(srv.port, makeToken({ id: 'u1', username: 'a' }));
    const aSnap = await waitFor<{ selfId: string }>(a, 'sessions-snapshot');
    const b = connectClient(srv.port, makeToken({ id: 'u2', username: 'b' }));
    await waitFor(b, 'sessions-snapshot');

    const updated = waitFor<any>(b, 'session-updated');
    const selfUpdated = waitFor<any>(a, 'session-updated'); // acting client sees its own update too (I2)
    a.emit('update-user', { color: '#10b981', role: 'admin-spoof' });
    const evt = await updated;
    expect(evt.sessionId).toBe(aSnap.selfId);
    expect(evt.color).toBe('#10b981');
    expect(evt.role).toBe('admin'); // role can't be patched via update-user
    const selfEvt = await selfUpdated;
    expect(selfEvt.sessionId).toBe(aSnap.selfId);
    expect(selfEvt.color).toBe('#10b981');
    a.close(); b.close();
  });

  it('malformed set-location payloads are ignored without crashing', async () => {
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    client.emit('set-location', null);
    client.emit('set-location', { noPath: true });
    client.emit('set-location', 42);
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.handle.registry.all()).toHaveLength(1);
    client.close();
  });
});
