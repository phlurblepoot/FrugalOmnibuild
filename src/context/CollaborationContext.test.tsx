import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// Fake socket: an event-emitter with spies. hoisted so the module mock sees it.
// ackResponders lets a test register a canned ack for an acked event (e.g.
// 'measurement-op', 'canvas-join'): when emit() is called with a callback as
// the 3rd arg, it's invoked synchronously with the responder's return value.
const { fakeSocket, ioMock, ackResponders } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const ackResponders: Record<string, (payload: any) => any> = {};
  const fakeSocket = {
    handlers,
    connected: true,
    on: vi.fn((evt: string, cb: any) => { (handlers[evt] ??= []).push(cb); return fakeSocket; }),
    emit: vi.fn((evt: string, payload?: any, cb?: any) => {
      if (typeof cb === 'function' && ackResponders[evt]) {
        cb(ackResponders[evt](payload));
      }
    }),
    close: vi.fn(),
    connect: vi.fn(),
    fire: (evt: string, ...args: any[]) => (handlers[evt] ?? []).forEach(cb => cb(...args)),
  };
  return { fakeSocket, ioMock: vi.fn((_opts?: any) => fakeSocket), ackResponders };
});
vi.mock('socket.io-client', () => ({ io: ioMock }));

const navigateSpy = vi.hoisted(() => vi.fn());
// locationOverrideRef lets a test force location.pathname to a specific value
// on the next render, layered on top of the real (MemoryRouter-derived)
// location — used to construct a single commit where both `sessions` and
// `location.pathname` change together, without depending on react-router's
// own navigation timing (Link/navigate defer their location update via
// React.startTransition, landing in a separate, later commit — no good for
// forcing a genuinely simultaneous change).
const locationOverrideRef = vi.hoisted(() => ({ current: null as { pathname: string } | null }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    useLocation: () => {
      const real = actual.useLocation();
      return locationOverrideRef.current ? { ...real, ...locationOverrideRef.current } : real;
    },
  };
});

import { CollaborationProvider, useCollaboration } from './CollaborationContext';
import { CLIENT_SESSION_ID } from '../utils/clientSession';

const SESSION = {
  sessionId: 'sA', userId: 'u1', name: 'noah', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome',
  location: { path: '/dashboard', label: 'Dashboard' },
  editing: null, cursor: null, lastActive: 111,
};

function Probe() {
  const { sessions, globalUsers, mySessionId } = useCollaboration();
  return (
    <div>
      <span data-testid="count">{sessions.length}</span>
      <span data-testid="self">{mySessionId ?? 'none'}</span>
      <span data-testid="legacy">{globalUsers.map(u => `${u.id}:${u.pageId}`).join(',')}</span>
    </div>
  );
}

function FollowProbe() {
  const { sessions, followedSessionId, setFollowedSessionId } = useCollaboration();
  return (
    <div>
      <span data-testid="followed">{followedSessionId ?? 'none'}</span>
      <button data-testid="follow-sB" onClick={() => setFollowedSessionId('sB')}>follow</button>
      <span data-testid="count">{sessions.length}</span>
    </div>
  );
}

// Exposes the raw context value to the test body (rather than rendering it),
// so async op/subscribe calls can be driven and awaited directly.
function ContextCapture({ onReady }: { onReady: (ctx: ReturnType<typeof useCollaboration>) => void }) {
  const ctx = useCollaboration();
  onReady(ctx);
  return null;
}

const OTHER = {
  ...SESSION, sessionId: 'sB', userId: 'u2', name: 'sam',
  location: { path: '/project/p1/billing', projectId: 'p1', section: 'billing' },
};

describe('CollaborationContext', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'tok123');
    localStorage.setItem('user', JSON.stringify({ id: 'u1', username: 'noah' }));
    ioMock.mockClear(); fakeSocket.emit.mockClear(); navigateSpy.mockClear();
    locationOverrideRef.current = null;
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
    for (const k of Object.keys(ackResponders)) delete ackResponders[k];
  });

  function mount(initialEntries: string[] = ['/dashboard']) {
    return render(
      <MemoryRouter initialEntries={initialEntries}>
        <CollaborationProvider><Probe /></CollaborationProvider>
      </MemoryRouter>
    );
  }

  it('connects with an auth payload and reports its location', () => {
    mount();
    expect(ioMock).toHaveBeenCalledTimes(1);
    const opts = ioMock.mock.calls[0][0];
    // auth is a function form so reconnects pick up fresh tokens
    const authArg = typeof opts.auth === 'function'
      ? (() => { let got: any; opts.auth((v: any) => { got = v; }); return got; })()
      : opts.auth;
    expect(authArg.token).toBe('tok123');
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-location',
      expect.objectContaining({ path: '/dashboard' }));
  });

  it('builds sessions from snapshot and applies joined/left/updated deltas', () => {
    mount();
    act(() => fakeSocket.fire('sessions-snapshot', { selfId: 'sA', sessions: [SESSION] }));
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('self').textContent).toBe('sA');
    act(() => fakeSocket.fire('session-joined', { ...SESSION, sessionId: 'sB', userId: 'u2', name: 'sam' }));
    expect(screen.getByTestId('count').textContent).toBe('2');
    act(() => fakeSocket.fire('session-updated', { ...SESSION, sessionId: 'sB', userId: 'u2', name: 'sam', color: '#000000' }));
    expect(screen.getByTestId('count').textContent).toBe('2');
    act(() => fakeSocket.fire('session-left', { sessionId: 'sB' }));
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('derives the legacy globalUsers shape (id=sessionId, pageId=location.path)', () => {
    mount();
    act(() => fakeSocket.fire('sessions-snapshot', { selfId: 'sA', sessions: [SESSION] }));
    expect(screen.getByTestId('legacy').textContent).toBe('sA:/dashboard');
  });

  it('does not connect when no token is stored', () => {
    localStorage.removeItem('token');
    mount();
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('re-emits set-location on reconnect (rooms are lost server-side on a new session)', () => {
    mount();
    fakeSocket.emit.mockClear();
    act(() => fakeSocket.fire('connect'));
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-location',
      expect.objectContaining({ path: '/dashboard' }));
  });

  it('navigates to the followed session path and clears follow when the session disconnects', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CollaborationProvider><FollowProbe /></CollaborationProvider>
      </MemoryRouter>
    );
    act(() => fakeSocket.fire('sessions-snapshot', { selfId: 'sA', sessions: [SESSION, OTHER] }));
    act(() => { screen.getByTestId('follow-sB').click(); });
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/project/p1/billing'));
    act(() => fakeSocket.fire('session-left', { sessionId: 'sB' }));
    await waitFor(() => expect(screen.getByTestId('followed').textContent).toBe('none'));
  });

  // Stop-on-manual-navigation is deliberately NOT covered here: jsdom + MemoryRouter
  // makes simulating a real user-driven URL change (as opposed to our own navigate()
  // call) awkward inside this provider-only test. It's covered by the FollowPill RTL
  // test (Task 4) and the e2e suite (Task 9).

  it('clears follow when a manual nav and a followed-session move land in the same commit (race regression)', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CollaborationProvider><FollowProbe /></CollaborationProvider>
      </MemoryRouter>
    );
    // OTHER starts at our own path so following it doesn't itself trigger an
    // auto-nav (keeps followNavRef.current at its baseline, '/dashboard').
    act(() => fakeSocket.fire('sessions-snapshot', {
      selfId: 'sA', sessions: [SESSION, { ...OTHER, location: { path: '/dashboard' } }],
    }));
    act(() => { screen.getByTestId('follow-sB').click(); });
    expect(screen.getByTestId('followed').textContent).toBe('sB');
    navigateSpy.mockClear();

    // Force the pathname change and the followed-session move into the same
    // commit: react-router's own navigate()/Link defer their location update
    // via React.startTransition, which lands in a separate, later commit —
    // no good for constructing a genuinely simultaneous change. Overriding
    // useLocation's return value directly (see the module mock above) and
    // then firing the session update in one act() guarantees the merged
    // effect sees both changes in a single execution — this is what makes
    // the ordering fix's determinism actually testable. Pre-merge, whether
    // the manual-nav check or the auto-nav ran "first" for such a commit
    // depended on effect declaration order; the merge makes the manual
    // check run first unconditionally.
    locationOverrideRef.current = { pathname: '/somewhere-else' };
    act(() => {
      fakeSocket.fire('session-updated', { ...OTHER, location: { path: '/project/p1/billing' } });
    });

    expect(screen.getByTestId('followed').textContent).toBe('none');
    expect(navigateSpy).not.toHaveBeenCalledWith('/project/p1/billing');
  });

  it('sends label only on canvas routes', () => {
    const { unmount } = mount(['/project/p1/page/pg1']);
    const canvasCalls = fakeSocket.emit.mock.calls.filter(c => c[0] === 'set-location');
    expect(canvasCalls.length).toBeGreaterThan(0);
    expect(canvasCalls[canvasCalls.length - 1][1].label).toBe('Projects');
    unmount();

    fakeSocket.emit.mockClear();
    mount(['/project/p1/billing']);
    const nonCanvasCalls = fakeSocket.emit.mock.calls.filter(c => c[0] === 'set-location');
    expect(nonCanvasCalls.length).toBeGreaterThan(0);
    expect(nonCanvasCalls[nonCanvasCalls.length - 1][1].label).toBeUndefined();
  });

  function mountCtx(initialEntries: string[] = ['/dashboard']) {
    let ctx!: ReturnType<typeof useCollaboration>;
    render(
      <MemoryRouter initialEntries={initialEntries}>
        <CollaborationProvider><ContextCapture onReady={(c) => { ctx = c; }} /></CollaborationProvider>
      </MemoryRouter>
    );
    return () => ctx;
  }

  it('sendMeasurementOp emits measurement-op with clientTabId and resolves the ack', async () => {
    ackResponders['measurement-op'] = () => ({ ok: true, version: 7 });
    const getCtx = mountCtx();
    const op = {
      projectId: 'p1', pageId: 'pg1', action: 'add' as const,
      measurement: { id: 'm1', type: 'line' },
    };
    const result = await getCtx().sendMeasurementOp(op);
    expect(fakeSocket.emit).toHaveBeenCalledWith(
      'measurement-op',
      expect.objectContaining({ ...op, clientTabId: CLIENT_SESSION_ID }),
      expect.any(Function)
    );
    expect(result).toEqual({ ok: true, version: 7 });
  });

  it('sendMeasurementOp resolves {ok:false, error:"offline"} with no socket', async () => {
    localStorage.removeItem('token');
    const getCtx = mountCtx();
    const result = await getCtx().sendMeasurementOp({
      projectId: 'p1', pageId: 'pg1', action: 'add', measurement: { id: 'm1' },
    });
    expect(result).toEqual({ ok: false, error: 'offline' });
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('measurement-op', expect.anything(), expect.anything());
  });

  it('onMeasurementApplied fires on measurement-applied events and unsubscribes cleanly', () => {
    const getCtx = mountCtx();
    const cb = vi.fn();
    const unsubscribe = getCtx().onMeasurementApplied(cb);
    const event = { pageId: 'pg1', action: 'add' as const, measurement: { id: 'm1' }, version: 2, bySessionId: 'other-tab' };
    act(() => fakeSocket.fire('measurement-applied', event));
    expect(cb).toHaveBeenCalledWith(event);
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    act(() => fakeSocket.fire('measurement-applied', event));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('no longer registers a project-sync listener', () => {
    mountCtx();
    expect(fakeSocket.handlers['project-sync']).toBeUndefined();
  });
});
