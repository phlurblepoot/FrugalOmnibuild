import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { CLIENT_SESSION_ID } from '../utils/clientSession';

const { fakeSocket } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((evt: string, cb: any) => { (handlers[evt] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((evt: string, cb: any) => { handlers[evt] = (handlers[evt] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (evt: string, ...args: any[]) => (handlers[evt] ?? []).forEach(cb => cb(...args)),
  };
  return { fakeSocket };
});
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));

import { useLiveQuery, type LiveFilter } from './useLiveQuery';

function Harness({ load, filter }: { load: () => void; filter: LiveFilter }) {
  useLiveQuery(load, filter, { debounceMs: 50 });
  return null;
}

const evt = (over: Record<string, unknown> = {}) => ({
  type: 'issue', id: 'i1', projectId: 'p1', action: 'updated', bySessionId: 'other-tab', ...over,
});

describe('useLiveQuery', () => {
  beforeEach(() => { vi.useFakeTimers(); for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k]; });
  afterEach(() => vi.useRealTimers());

  it('loads on mount and refetches (debounced) on a matching event', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'], projectId: 'p1' }} />);
    expect(load).toHaveBeenCalledTimes(1);
    act(() => { fakeSocket.fire('entity-changed', evt()); fakeSocket.fire('entity-changed', evt({ id: 'i2' })); });
    expect(load).toHaveBeenCalledTimes(1);          // debounced, not yet
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(2);          // burst coalesced to one
  });

  it('skips self-echo, foreign types, and foreign projects', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'], projectId: 'p1' }} />);
    act(() => {
      fakeSocket.fire('entity-changed', evt({ bySessionId: CLIENT_SESSION_ID }));
      fakeSocket.fire('entity-changed', evt({ type: 'task' }));
      fakeSocket.fire('entity-changed', evt({ projectId: 'p2' }));
    });
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(1);          // only the mount load
  });

  it('matches events without projectId even when filter has one (safe over-refetch)', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['task'], projectId: 'p1' }} />);
    act(() => { fakeSocket.fire('entity-changed', evt({ type: 'task', projectId: undefined })); });
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('version dedupe skips stale/duplicate versions per entity', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'] }} />);
    act(() => { fakeSocket.fire('entity-changed', evt({ version: 5 })); });
    await act(async () => { vi.advanceTimersByTime(60); });
    act(() => { fakeSocket.fire('entity-changed', evt({ version: 5 })); fakeSocket.fire('entity-changed', evt({ version: 4 })); });
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(2);          // mount + v5; v5-dup and v4 skipped
  });

  it('refetches once on socket reconnect', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'] }} />);
    act(() => { fakeSocket.fire('connect'); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<Harness load={vi.fn()} filter={{ types: ['issue'] }} />);
    unmount();
    expect((fakeSocket.handlers['entity-changed'] ?? []).length).toBe(0);
  });
});
