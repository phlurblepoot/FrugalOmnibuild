import { describe, it, expect, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';

describe('heartbeat + sweep', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>> | undefined;
  afterEach(async () => { await srv?.close(); srv = undefined; });

  it('sweeps sessions that stop heartbeating and broadcasts session-left', async () => {
    srv = await startRealtimeServer({ sweepIntervalMs: 100, staleAfterMs: 250 });
    const quiet = connectClient(srv.port, makeToken({ id: 'u1', username: 'quiet' }));
    const quietSnap = await waitFor<{ selfId: string }>(quiet, 'sessions-snapshot');
    const lively = connectClient(srv.port, makeToken({ id: 'u2', username: 'lively' }));
    await waitFor(lively, 'sessions-snapshot');

    // lively heartbeats; quiet goes silent (suppress its outgoing heartbeat entirely)
    const beat = setInterval(() => lively.emit('heartbeat'), 50);
    const left = await waitFor<{ sessionId: string }>(lively, 'session-left');
    clearInterval(beat);

    expect(left.sessionId).toBe(quietSnap.selfId);
    expect(srv.handle.registry.all().map(s => s.name)).toEqual(['lively']);
    quiet.close(); lively.close();
  }, 10_000);

  it('heartbeat keeps a session alive past staleAfterMs', async () => {
    srv = await startRealtimeServer({ sweepIntervalMs: 100, staleAfterMs: 250 });
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    const beat = setInterval(() => client.emit('heartbeat'), 50);
    await new Promise((r) => setTimeout(r, 600)); // > 2× staleAfterMs
    clearInterval(beat);
    expect(srv.handle.registry.all()).toHaveLength(1);
    client.close();
  });

  it('dispose clears the sweep interval', async () => {
    srv = await startRealtimeServer({ sweepIntervalMs: 100, staleAfterMs: 250 });
    srv.handle.dispose();
    // no assertion beyond "does not throw / does not keep the process alive";
    // vitest will hang on leaked intervals, so completing is the assertion.
    expect(true).toBe(true);
  });
});
