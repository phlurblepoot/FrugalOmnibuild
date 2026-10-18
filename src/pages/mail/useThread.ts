// src/pages/mail/useThread.ts — one conversation's data: the thread row, its
// messages oldest-first, and the app items it is linked to. Refetches when the
// account/thread in the URL changes and stays live on `mailThread` events for
// this thread key (new replies, read/star flags moved from another device).
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi } from '../../utils/mailApi';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import type { MessageRow, ThreadLink, ThreadListRow } from './types';

export interface ThreadState {
  thread: ThreadListRow | null;
  messages: MessageRow[];
  links: ThreadLink[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

interface Loaded {
  key: string;
  thread: ThreadListRow;
  messages: MessageRow[];
  links: ThreadLink[];
}

/** Identity of a loaded conversation — both halves, so two accounts holding
 *  the same provider thread key can never be mistaken for one another. */
const cacheKey = (accountId: string, threadKey: string): string => `${accountId}::${threadKey}`;

const EMPTY_MESSAGES: MessageRow[] = [];
const EMPTY_LINKS: ThreadLink[] = [];

export function useThread(accountId: string | null, threadKey: string | null): ThreadState {
  // The identity of what is loaded travels with the data (same reasoning as
  // useMailFolders): between "the URL moved to another thread" and "its
  // messages arrived" the caller must not be handed the previous thread's
  // messages under the new subject.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The key the explicit effect below has (started) loading. Used to tell a
  // genuine live event on the already-open thread apart from useLiveQuery's
  // own "reload when the filter identity changes" effect firing merely
  // because the thread switched — that reload is redundant, since the
  // explicit effect below already owns loading the new key.
  const loadedKeyRef = useRef<string | null>(null);

  const key = accountId && threadKey ? cacheKey(accountId, threadKey) : null;

  const load = useCallback(async () => {
    if (!accountId || !threadKey) {
      setLoaded(null);
      setError(null);
      return;
    }
    try {
      const res = await mailApi.thread(accountId, threadKey);
      setLoaded({
        key: cacheKey(accountId, threadKey),
        thread: res.thread,
        messages: Array.isArray(res.messages) ? res.messages : [],
        links: Array.isArray(res.links) ? res.links : [],
      });
      setError(null);
    } catch (e) {
      setLoaded(null);
      setError(e instanceof Error ? e.message : 'Failed to load this conversation.');
    }
  }, [accountId, threadKey]);

  // Live events only. useLiveQuery also fires this callback on mount and
  // whenever its filter identity (built from threadKey) changes — the same
  // moments the effect below already handles via its own [load] dependency —
  // so it's gated to loadedKeyRef: only a call for the key already owned by
  // that effect (i.e. a real socket event on the thread that's open, not the
  // switch itself) goes through. On the switch, this callback runs BEFORE the
  // effect below updates the ref (effects run in declaration order), so the
  // stale mismatch correctly skips it there and leaves the single load to the
  // effect below (same idea as the readyRef gate in useThreadList).
  useLiveQuery(
    () => {
      if (loadedKeyRef.current === key) void load();
    },
    { types: ['mailThread'], id: threadKey ?? undefined },
    { debounceMs: 500 },
  );

  useEffect(() => {
    loadedKeyRef.current = key;
    // The previous thread's failure must not be shown over the new one while
    // its fetch is in flight.
    setError(null);
    void load();
  }, [load, key]);

  const fresh = !!key && loaded?.key === key;

  return {
    thread: fresh ? loaded.thread : null,
    messages: fresh ? loaded.messages : EMPTY_MESSAGES,
    links: fresh ? loaded.links : EMPTY_LINKS,
    // A failed load is not "still loading" — the caller shows the error.
    loading: !!key && !fresh && !error,
    error: fresh ? null : error,
    reload: load,
  };
}
