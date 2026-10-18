import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';
import { createChangeFeed, requestMeta, ENTITY_CHANGED, type EntityChangedEvent } from './changeFeed';

describe('createChangeFeed', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  it('broadcasts entity-changed globally to connected clients', async () => {
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    const broadcast = createChangeFeed(srv.io);
    const evt = waitFor<EntityChangedEvent>(client, ENTITY_CHANGED);
    broadcast({ type: 'issue', id: 'i1', projectId: 'p1', version: 3, action: 'updated', byUserId: 'u1', bySessionId: 'tab-1' });
    expect(await evt).toEqual({ type: 'issue', id: 'i1', projectId: 'p1', version: 3, action: 'updated', byUserId: 'u1', bySessionId: 'tab-1' });
    client.close();
  });

  it('reaches clients regardless of which project room they are in', async () => {
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    client.emit('set-location', { path: '/project/OTHER/billing', projectId: 'OTHER' });
    await new Promise(r => setTimeout(r, 100));
    const broadcast = createChangeFeed(srv.io);
    const evt = waitFor<EntityChangedEvent>(client, ENTITY_CHANGED);
    broadcast({ type: 'task', id: 't1', projectId: 'p1', action: 'created' });
    expect((await evt).id).toBe('t1');
    client.close();
  });
});

describe('requestMeta', () => {
  it('extracts user id and session header', () => {
    const req = { user: { id: 'u1' }, get: (n: string) => (n.toLowerCase() === 'x-session-id' ? 'tab-9' : undefined) };
    expect(requestMeta(req)).toEqual({ byUserId: 'u1', bySessionId: 'tab-9' });
  });
  it('tolerates missing user and header', () => {
    const req = { get: () => undefined };
    expect(requestMeta(req)).toEqual({ byUserId: undefined, bySessionId: undefined });
  });
});
