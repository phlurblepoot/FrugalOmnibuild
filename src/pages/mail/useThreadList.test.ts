// src/pages/mail/useThreadList.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ThreadListRow } from './types';

const { threads, toast } = vi.hoisted(() => ({ threads: vi.fn(), toast: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: { threads } }));
// useLiveQuery only needs a socket-shaped context; null means "no live events".
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: null }) }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast }),
}));

import { PAGE_SIZE, useThreadList } from './useThreadList';

const row = (i: number): ThreadListRow => ({
  threadKey: `t${i}`, subject: `S${i}`, firstDate: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
  lastDate: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`, messageCount: 1, unreadCount: 0,
  hasAttachments: 0, isStarred: 0, participants: [], folderIds: ['f-inbox'], snippet: '', links: [],
});
const page = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => row(offset + i));
const lastCall = () => threads.mock.calls[threads.mock.calls.length - 1][0];

beforeEach(() => {
  vi.clearAllMocks();
  threads.mockResolvedValue({ threads: page(2), hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z' });
});

describe('useThreadList', () => {
  it('loads the first page once for the given account and folder', async () => {
    const { result } = renderHook(() => useThreadList('a1', 'f-inbox', ''));
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    expect(threads).toHaveBeenCalledTimes(1);
    expect(lastCall()).toEqual({ accountId: 'a1', folderId: 'f-inbox', limit: PAGE_SIZE });
    expect(result.current.indexedSince).toBe('2026-02-01T00:00:00.000Z');
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('treats the "_" folder id as no folder filter and passes a search query through', async () => {
    const { result } = renderHook(() => useThreadList('a1', '_', 'roof'));
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    expect(lastCall()).toEqual({ accountId: 'a1', q: 'roof', limit: PAGE_SIZE });
  });

  it('fetches nothing without an account', async () => {
    const { result } = renderHook(() => useThreadList(null, 'f-inbox', ''));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(threads).not.toHaveBeenCalled();
    expect(result.current.threads).toEqual([]);
  });

  it('refetches from the first page when the folder changes', async () => {
    const { result, rerender } = renderHook(({ f }: { f: string }) => useThreadList('a1', f, ''), {
      initialProps: { f: 'f-inbox' },
    });
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    rerender({ f: 'f-sent' });
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(2));
    expect(lastCall()).toEqual({ accountId: 'a1', folderId: 'f-sent', limit: PAGE_SIZE });
  });

  it('pages older threads with `before` and appends them, skipping duplicates', async () => {
    threads.mockResolvedValueOnce({ threads: page(2), hasMore: true, indexedSince: 'x' });
    const { result } = renderHook(() => useThreadList('a1', 'f-inbox', ''));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    threads.mockResolvedValueOnce({ threads: [row(1), row(2)], hasMore: false, indexedSince: 'x' });
    await act(async () => { result.current.loadMore(); });

    expect(lastCall()).toEqual({ accountId: 'a1', folderId: 'f-inbox', before: row(1).lastDate, limit: PAGE_SIZE });
    await waitFor(() => expect(result.current.threads.map(t => t.threadKey)).toEqual(['t0', 't1', 't2']));
    expect(result.current.hasMore).toBe(false);
  });

  it('reloads every page it has already loaded rather than collapsing back to one', async () => {
    threads.mockResolvedValueOnce({ threads: page(PAGE_SIZE), hasMore: true, indexedSince: 'x' });
    const { result } = renderHook(() => useThreadList('a1', 'f-inbox', ''));
    await waitFor(() => expect(result.current.threads).toHaveLength(PAGE_SIZE));

    threads.mockResolvedValueOnce({ threads: page(1, PAGE_SIZE), hasMore: false, indexedSince: 'x' });
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.threads).toHaveLength(PAGE_SIZE + 1));

    await act(async () => { result.current.reload(); });
    expect(lastCall()).toEqual({ accountId: 'a1', folderId: 'f-inbox', limit: PAGE_SIZE + 1 });
  });

  // Server-search results cannot be shown by re-running the local query: the
  // hits are usually archived (so the folder filter hides them) and usually
  // matched on body text the local LIKE never sees. The list asks for them by
  // key instead, with both filters bypassed server-side.
  describe('server-results mode', () => {
    it('asks for exactly the given keys, without the folder or the query', async () => {
      const { result } = renderHook(() => useThreadList('a1', 'f-inbox', 'shingle'));
      await waitFor(() => expect(result.current.threads).toHaveLength(2));

      await act(async () => { result.current.showServerResults(['tk-9', 'tk-8']); });
      await waitFor(() => expect(threads).toHaveBeenCalledTimes(2));
      expect(lastCall()).toEqual({ accountId: 'a1', threadKeys: ['tk-9', 'tk-8'], limit: PAGE_SIZE });
      expect(result.current.serverResultKeys).toEqual(['tk-9', 'tk-8']);
    });

    it('asks for every key even past a page', async () => {
      const keys = Array.from({ length: PAGE_SIZE + 7 }, (_, i) => `k${i}`);
      const { result } = renderHook(() => useThreadList('a1', 'f-inbox', 'shingle'));
      await waitFor(() => expect(result.current.threads).toHaveLength(2));

      await act(async () => { result.current.showServerResults(keys); });
      await waitFor(() => expect(lastCall().limit).toBe(keys.length));
    });

    it('goes back to the folder view on Clear', async () => {
      const { result } = renderHook(() => useThreadList('a1', 'f-inbox', 'shingle'));
      await waitFor(() => expect(result.current.threads).toHaveLength(2));
      await act(async () => { result.current.showServerResults(['tk-9']); });
      await waitFor(() => expect(result.current.serverResultKeys).toEqual(['tk-9']));

      await act(async () => { result.current.clearServerResults(); });
      await waitFor(() => expect(result.current.serverResultKeys).toBeNull());
      expect(lastCall()).toEqual({ accountId: 'a1', folderId: 'f-inbox', q: 'shingle', limit: PAGE_SIZE });
    });

    it('leaves the results behind when the folder or the query moves on', async () => {
      const { result, rerender } = renderHook(({ f }: { f: string }) => useThreadList('a1', f, 'shingle'), {
        initialProps: { f: 'f-inbox' },
      });
      await waitFor(() => expect(result.current.threads).toHaveLength(2));
      await act(async () => { result.current.showServerResults(['tk-9']); });
      await waitFor(() => expect(result.current.serverResultKeys).toEqual(['tk-9']));

      rerender({ f: 'f-sent' });
      await waitFor(() => expect(result.current.serverResultKeys).toBeNull());
      expect(lastCall()).toEqual({ accountId: 'a1', folderId: 'f-sent', q: 'shingle', limit: PAGE_SIZE });
    });

    it('does not page a fixed result set', async () => {
      threads.mockResolvedValue({ threads: page(2), hasMore: true, indexedSince: 'x' });
      const { result } = renderHook(() => useThreadList('a1', 'f-inbox', 'shingle'));
      await waitFor(() => expect(result.current.threads).toHaveLength(2));
      await act(async () => { result.current.showServerResults(['tk-9']); });
      await waitFor(() => expect(threads).toHaveBeenCalledTimes(2));

      await act(async () => { result.current.loadMore(); });
      expect(threads).toHaveBeenCalledTimes(2);
    });

    it('treats an empty key list as "no server results"', async () => {
      const { result } = renderHook(() => useThreadList('a1', 'f-inbox', 'shingle'));
      await waitFor(() => expect(result.current.threads).toHaveLength(2));
      await act(async () => { result.current.showServerResults([]); });
      expect(result.current.serverResultKeys).toBeNull();
    });
  });

  it('surfaces a failed load as a toast and leaves the list empty', async () => {
    threads.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useThreadList('a1', 'f-inbox', ''));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(result.current.threads).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
