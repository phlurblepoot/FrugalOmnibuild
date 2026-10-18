import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';

describe('set-editing', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  it('sets editing on the session and broadcasts session-updated to everyone (incl. self)', async () => {
    const a = connectClient(srv.port, makeToken({ id: 'u1', username: 'a' }));
    const aSnap = await waitFor<{ selfId: string }>(a, 'sessions-snapshot');
    const b = connectClient(srv.port, makeToken({ id: 'u2', username: 'b' }));
    await waitFor(b, 'sessions-snapshot');

    const bSees = waitFor<any>(b, 'session-updated');
    const aSees = waitFor<any>(a, 'session-updated');
    a.emit('set-editing', { type: 'invoice', id: 'inv1' });
    expect((await bSees).editing).toEqual({ type: 'invoice', id: 'inv1' });
    expect((await aSees).sessionId).toBe(aSnap.selfId);

    const cleared = waitFor<any>(b, 'session-updated');
    a.emit('set-editing', null);
    expect((await cleared).editing).toBeNull();
    expect(srv.handle.registry.get(aSnap.selfId)?.editing).toBeNull();
    a.close(); b.close();
  });

  it('ignores malformed payloads', async () => {
    const a = connectClient(srv.port, makeToken());
    const snap = await waitFor<{ selfId: string }>(a, 'sessions-snapshot');
    a.emit('set-editing', { type: 5 });
    a.emit('set-editing', 'garbage');
    await new Promise(r => setTimeout(r, 100));
    expect(srv.handle.registry.get(snap.selfId)?.editing).toBeNull();
    a.close();
  });
});
