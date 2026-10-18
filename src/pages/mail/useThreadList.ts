// src/pages/mail/useThreadList.ts — the thread list's data: first page on any
// account/folder/query change, `before`-cursor paging for older threads, and a
// live refresh that keeps every page the user already scrolled into view.
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi } from '../../utils/mailApi';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useToast } from '../../components/Toast';
import type { ThreadListRow } from './types';

export const PAGE_SIZE = 50;

/** Folder id used in the URL for "this account, no folder filter". */
export const NO_FOLDER = '_';

export interface ThreadListState {
  threads: ThreadListRow[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  indexedSince: string | null;
  reload: () => void;
  /** Non-null while the list is showing an explicit set of conversations from
   *  a whole-mailbox search rather than the current folder. */
  serverResultKeys: string[] | null;
  showServerResults: (threadKeys: string[]) => void;
  clearServerResults: () => void;
}

export function useThreadList(accountId: string | null, folderId: string | null, q: string): ThreadListState {
  const { toast } = useToast();
  const [threads, setThreads] = useState<ThreadListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [indexedSince, setIndexedSince] = useState<string | null>(null);

  // How many rows are on screen, so a live refresh can ask for the same depth
  // instead of snapping the user back to page one.
  const loadedRef = useRef(0);
  const busyRef = useRef(false);
  const readyRef = useRef(false);
  useEffect(() => {
    loadedRef.current = threads.length;
  }, [threads]);

  const folderParam = folderId && folderId !== NO_FOLDER ? folderId : undefined;
  const query = q.trim() || undefined;

  // "Server results" mode: /api/mail/search files its hits and hands back the
  // conversations they landed in, and the list then asks for exactly those
  // keys. It cannot just re-run the local query — a provider match is usually
  // on body text the local index never sees, and the hit is usually archived,
  // so both the q LIKE and the active folder filter would hide it. That is why
  // "search the whole mailbox" used to find things and then show nothing.
  const [serverKeys, setServerKeys] = useState<string[] | null>(null);
  // Moving to another account, folder or query leaves those results behind.
  useEffect(() => {
    setServerKeys(null);
  }, [accountId, folderParam, query]);

  const fetchFirst = useCallback(async () => {
    if (!accountId) {
      setThreads([]);
      setHasMore(false);
      setIndexedSince(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await mailApi.threads(
        serverKeys
          ? { accountId, threadKeys: serverKeys, limit: Math.max(PAGE_SIZE, serverKeys.length) }
          : { accountId, folderId: folderParam, q: query, limit: Math.max(PAGE_SIZE, loadedRef.current) },
      );
      setThreads(res.threads);
      setHasMore(res.hasMore);
      setIndexedSince(res.indexedSince ?? null);
    } catch {
      toast('Failed to load mail.', { type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [accountId, folderParam, query, serverKeys, toast]);

  // Live events only — the initial load belongs to the effect below, which is
  // the one that knows the account/folder/query changed. (useLiveQuery also
  // fires its own load on mount; readyRef swallows that duplicate.)
  useLiveQuery(
    () => {
      if (readyRef.current) void fetchFirst();
    },
    { types: ['mailThread'] },
    { debounceMs: 500 },
  );

  useEffect(() => {
    // Drop the previous folder's/query's rows rather than showing them under
    // the new heading while the fetch is in flight.
    loadedRef.current = 0;
    readyRef.current = true;
    setThreads([]);
    setHasMore(false);
    void fetchFirst();
  }, [fetchFirst]);

  const loadMore = useCallback(() => {
    const last = threads[threads.length - 1];
    // Server results are a fixed set, not a window onto one — there is no
    // older page of them to ask for.
    if (!accountId || !last || busyRef.current || serverKeys) return;
    busyRef.current = true;
    setLoading(true);
    mailApi
      .threads({ accountId, folderId: folderParam, q: query, before: last.lastDate, limit: PAGE_SIZE })
      .then(res => {
        setThreads(prev => {
          const seen = new Set(prev.map(t => t.threadKey));
          return [...prev, ...res.threads.filter(t => !seen.has(t.threadKey))];
        });
        setHasMore(res.hasMore);
        if (res.indexedSince) setIndexedSince(res.indexedSince);
      })
      .catch(() => toast('Failed to load more mail.', { type: 'error' }))
      .finally(() => {
        busyRef.current = false;
        setLoading(false);
      });
  }, [accountId, folderParam, query, threads, serverKeys, toast]);

  const reload = useCallback(() => {
    void fetchFirst();
  }, [fetchFirst]);

  // Both go through state, so the effect that owns fetching does the refetch —
  // there is no second code path that loads the list.
  const showServerResults = useCallback((threadKeys: string[]) => {
    setServerKeys(threadKeys.length ? threadKeys : null);
  }, []);
  const clearServerResults = useCallback(() => setServerKeys(null), []);

  return {
    threads, loading, hasMore, loadMore, indexedSince, reload,
    serverResultKeys: serverKeys, showServerResults, clearServerResults,
  };
}
