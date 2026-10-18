// src/hooks/useReplyFlags.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { replyFlags } = vi.hoisted(() => ({ replyFlags: vi.fn() }));
vi.mock('../utils/mailApi', () => ({ mailApi: { replyFlags } }));

// A fake socket (on/off/fire), same pattern as useThread.test.ts /
// useLiveQuery.test.tsx, so a live 'mailThread' event can be simulated and its
// debounce observed for real rather than just asserting wiring.
const { fakeSocket } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket };
});
vi.mock('../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: fakeSocket }) }));

import { useReplyFlags } from './useReplyFlags';

const mailThreadEvent = (over: Record<string, unknown> = {}) => ({
  type: 'mailThread', id: 'tk-1', action: 'updated', bySessionId: 'other-tab', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  replyFlags.mockResolvedValue({ flagged: [] });
});

describe('useReplyFlags', () => {
  it('fetches nothing and returns an empty set when ids is empty', async () => {
    const { result } = renderHook(() => useReplyFlags('invoice', []));
    await new Promise(r => setTimeout(r, 0));
    expect(replyFlags).not.toHaveBeenCalled();
    expect(result.current).toEqual(new Set());
  });

  it('fetches nothing when itemType is undefined', async () => {
    const { result } = renderHook(() => useReplyFlags(undefined, ['a']));
    await new Promise(r => setTimeout(r, 0));
    expect(replyFlags).not.toHaveBeenCalled();
    expect(result.current).toEqual(new Set());
  });

  it('batches one call for the given itemType and ids, exposing the result as a Set', async () => {
    replyFlags.mockResolvedValue({ flagged: ['a', 'c'] });
    const { result } = renderHook(() => useReplyFlags('invoice', ['a', 'b', 'c']));
    await waitFor(() => expect(result.current).toEqual(new Set(['a', 'c'])));
    expect(replyFlags).toHaveBeenCalledTimes(1);
    expect(replyFlags).toHaveBeenCalledWith('invoice', ['a', 'b', 'c']);
  });

  it('chunks more than 100 ids into multiple <=100-id calls', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    replyFlags.mockImplementation((_t: string, chunk: string[]) => Promise.resolve({ flagged: [chunk[0]] }));
    const { result } = renderHook(() => useReplyFlags('invoice', ids));
    await waitFor(() => expect(replyFlags).toHaveBeenCalledTimes(2));
    expect(replyFlags.mock.calls[0][1]).toHaveLength(100);
    expect(replyFlags.mock.calls[1][1]).toHaveLength(50);
    await waitFor(() => expect(result.current).toEqual(new Set(['id-0', 'id-100'])));
  });

  it('stays stable across re-renders with the same ids content (no request storm)', async () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useReplyFlags('invoice', ids),
      { initialProps: { ids: ['a', 'b'] } },
    );
    await waitFor(() => expect(replyFlags).toHaveBeenCalledTimes(1));
    // New array instance, same content — must not trigger a second fetch.
    rerender({ ids: ['a', 'b'] });
    await new Promise(r => setTimeout(r, 0));
    expect(replyFlags).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(new Set());
  });

  it('refetches once, debounced, when a mailThread event fires', async () => {
    vi.useFakeTimers();
    try {
      replyFlags.mockResolvedValue({ flagged: [] });
      const { result } = renderHook(() => useReplyFlags('rfi', ['r1']));
      await act(async () => { await Promise.resolve(); });
      expect(replyFlags).toHaveBeenCalledTimes(1);

      replyFlags.mockResolvedValue({ flagged: ['r1'] });
      act(() => {
        fakeSocket.fire('entity-changed', mailThreadEvent());
        fakeSocket.fire('entity-changed', mailThreadEvent({ id: 'tk-2' }));
      });
      expect(replyFlags).toHaveBeenCalledTimes(1); // debounced, not yet

      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(replyFlags).toHaveBeenCalledTimes(2); // burst coalesced to one refetch
      await act(async () => { await Promise.resolve(); });
      expect(result.current).toEqual(new Set(['r1']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refetch on unrelated entity types', async () => {
    vi.useFakeTimers();
    try {
      const { renderHook: rh } = await import('@testing-library/react');
      rh(() => useReplyFlags('invoice', ['a']));
      await act(async () => { await Promise.resolve(); });
      expect(replyFlags).toHaveBeenCalledTimes(1);
      act(() => { fakeSocket.fire('entity-changed', { type: 'task', id: 't1', action: 'updated', bySessionId: 'other-tab' }); });
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(replyFlags).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
