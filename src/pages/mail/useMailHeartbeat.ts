// src/pages/mail/useMailHeartbeat.ts — tells the server this mailbox is being
// watched so it syncs it aggressively. Beats every 25 s, but only while the
// tab is actually visible: a backgrounded tab should not keep a poller warm.
import { useEffect } from 'react';
import { mailApi } from '../../utils/mailApi';

export const HEARTBEAT_MS = 25_000;

export function useMailHeartbeat(accountId: string | null): void {
  useEffect(() => {
    if (!accountId) return;

    const beat = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void mailApi.heartbeat([accountId]).catch(() => {});
    };

    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    // Coming back to the tab should resync now, not up to 25 s later.
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [accountId]);
}
