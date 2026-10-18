// src/pages/mail/useMailFolders.ts — folder list for one account, refetched
// when the account changes and refreshed live (unread counts move with mail).
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi } from '../../utils/mailApi';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import type { MailFolder } from './types';

export interface MailFoldersState {
  folders: MailFolder[];
  loading: boolean;
  reload: () => void;
}

export function useMailFolders(accountId: string | null): MailFoldersState {
  // The account the loaded folders belong to is part of the state: without it
  // a render between "account switched" and "new folders arrived" would hand
  // the caller the previous mailbox's folders, and the page would redirect
  // into a folder id that belongs to another account.
  const [loaded, setLoaded] = useState<{ accountId: string; folders: MailFolder[] } | null>(null);
  const [fetching, setFetching] = useState(!!accountId);
  const readyRef = useRef(false);

  const load = useCallback(async () => {
    if (!accountId) {
      setFetching(false);
      return;
    }
    setFetching(true);
    try {
      const rows = await mailApi.folders(accountId);
      setLoaded({ accountId, folders: Array.isArray(rows) ? rows : [] });
    } catch {
      // Record the failure against this account so the page stops waiting on
      // folders that are never going to arrive.
      setLoaded({ accountId, folders: [] });
    } finally {
      setFetching(false);
    }
  }, [accountId]);

  // Live events only; the effect below owns the account-change load (see the
  // same note in useThreadList).
  useLiveQuery(
    () => {
      if (readyRef.current) void load();
    },
    { types: ['mailThread', 'mailAccount'] },
    { debounceMs: 1000 },
  );

  useEffect(() => {
    readyRef.current = true;
    void load();
  }, [load]);

  const fresh = !!accountId && loaded?.accountId === accountId;
  return {
    folders: fresh ? loaded.folders : [],
    loading: !!accountId && (fetching || !fresh),
    reload: load,
  };
}
