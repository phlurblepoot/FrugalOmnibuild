import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor, waitForConnectError } from './testHarness';

describe('registerRealtime auth', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  it('rejects a connection with no token', async () => {
    const client = connectClient(srv.port, undefined);
    const err = await waitForConnectError(client);
    expect(err.message).toBe('unauthorized');
    client.close();
  });

  it('rejects a connection with a garbage token', async () => {
    const client = connectClient(srv.port, 'not-a-jwt');
    const err = await waitForConnectError(client);
    expect(err.message).toBe('unauthorized');
    client.close();
  });

  it('accepts a valid token and sends a sessions-snapshot with identity from the JWT, not the client', async () => {
    // Client tries to spoof identity via auth payload — must be ignored.
    const client = connectClient(srv.port, makeToken({ id: 'u1', username: 'noah' }), {
      userId: 'evil-spoof', name: 'evil-spoof',
    });
    const snapshot = await waitFor<{ selfId: string; sessions: any[] }>(client, 'sessions-snapshot');
    expect(snapshot.selfId).toBeTruthy();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].userId).toBe('u1');
    expect(snapshot.sessions[0].name).toBe('noah');
    expect(snapshot.sessions[0].sessionId).toBe(snapshot.selfId);
    client.close();
  });

  it('registry reflects the connected session and clears on disconnect', async () => {
    const client = connectClient(srv.port, makeToken(), { color: '#ef4444' });
    await waitFor(client, 'sessions-snapshot');
    expect(srv.handle.registry.all()).toHaveLength(1);
    expect(srv.handle.registry.all()[0].color).toBe('#ef4444');
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.handle.registry.all()).toHaveLength(0);
  });
});
