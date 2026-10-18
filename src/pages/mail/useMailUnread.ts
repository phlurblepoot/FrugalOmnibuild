// src/pages/mail/useMailUnread.ts — total unread count across all of the
// user's mail accounts, for the sidebar badge and (later) the mail UI itself.
// Kept live via useLiveQuery; a failed fetch (no mail accounts configured, or
// an older server without the mail routes) resolves to 0 rather than
// surfacing an error, since this only drives a badge.
import { useCallback, useState } from 'react';
import { mailApi } from '../../utils/mailApi';
import { useLiveQuery } from '../../hooks/useLiveQuery';

export function useMailUnread(): number {
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await mailApi.unreadCount();
      setTotal(result.total);
    } catch {
      setTotal(0);
    }
  }, []);

  useLiveQuery(load, { types: ['mailThread', 'mailAccount'] }, { debounceMs: 1000 });

  return total;
}
