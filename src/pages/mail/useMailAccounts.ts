// src/pages/mail/useMailAccounts.ts — the user's connected mailboxes, kept
// live so connecting/removing an account in Settings updates the mail page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi } from '../../utils/mailApi';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import type { MailAccount } from './types';

export interface MailAccountsState {
  accounts: MailAccount[];
  loading: boolean;
  reload: () => void;
}

/** `enabled: false` keeps the request off the wire entirely — DocumentActionsBar
 *  mounts on records that have no Send button at all. It is read on each load,
 *  so it is expected to be constant for the life of a mount. */
export function useMailAccounts({ enabled = true }: { enabled?: boolean } = {}): MailAccountsState {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(enabled);

  const load = useCallback(async () => {
    if (!enabled) { setAccounts([]); setLoading(false); return; }
    try {
      const rows = await mailApi.accounts();
      setAccounts(Array.isArray(rows) ? rows : []);
    } catch {
      // A failure here is indistinguishable to the user from "no mailboxes
      // connected", and that state already has a clear CTA — so fall back to
      // it rather than showing an error over an empty page.
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useLiveQuery(load, { types: ['mailAccount'] });

  // useLiveQuery's own initial load already ran — possibly while `enabled` was
  // still false. A caller that only learns it needs the mailbox list later (the
  // document bar, once an item turns out to have been emailed) has to be able
  // to switch it on without waiting for a socket event.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (enabled) void load();
  }, [enabled, load]);

  return { accounts, loading, reload: load };
}
