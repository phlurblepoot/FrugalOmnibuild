// src/hooks/useItemThreadLinks.ts
// "Has this invoice / RFI / proposal already been emailed, and can I open that
// conversation?" — the data behind SentThreadChip and behind the composer's
// "Reply in existing thread" option.
//
// A mail_thread_links row is shared by everyone who can see the item, but the
// THREAD itself lives in one person's mailbox. So a link alone cannot be
// turned into a deep link: `myThread` asks GET /api/mail/resolve-thread
// (exact threadKey, else a subject+date+participant fallback) which one
// server-side call the server itself answers against every mailbox this user
// owns — see openThreadLink.ts, the single place that query is made from.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { mailApi } from '../utils/mailApi';
import { resolveThreadMatch } from '../pages/mail/openThreadLink';
import type { ThreadLink } from '../pages/mail/types';

export interface ItemThread {
  accountId: string;
  threadKey: string;
  subject: string;
}

export interface ItemThreadLinksState {
  /** Newest first. */
  links: ThreadLink[];
  newest: ThreadLink | null;
  /** The newest link resolved to a mailbox this user owns, or null. */
  myThread: ItemThread | null;
  loading: boolean;
  resolving: boolean;
  reload: () => void;
}

const stamp = (l: ThreadLink): number => Date.parse(l.firstDate ?? l.createdAt) || 0;

export function useItemThreadLinks(
  itemType: string | undefined,
  itemId: string | undefined,
): ItemThreadLinksState {
  const [links, setLinks] = useState<ThreadLink[]>([]);
  const [loading, setLoading] = useState(false);
  // The finished answer, stamped with the question it answers. Deriving
  // `resolving` from "is there an answer for the CURRENT question" — rather
  // than from a flag an effect sets — is what keeps the chip from showing one
  // frame of "not mine" before the resolve request has even started.
  const [resolved, setResolved] = useState<{ key: string; thread: ItemThread | null } | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    if (!itemType || !itemId) {
      setLinks([]);
      setResolved(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      let rows: ThreadLink[] = [];
      try {
        rows = await mailApi.links(itemType, itemId);
      } catch {
        // No mail account, no server, no links — all the same to this chip:
        // there is nothing to show. Never surface it as an error.
        rows = [];
      }
      if (cancelled) return;
      setLinks(Array.isArray(rows) ? [...rows].sort((a, b) => stamp(b) - stamp(a)) : []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [itemType, itemId, nonce]);

  const newest = links[0] ?? null;

  // The question being asked right now: which thread, as of which reload.
  const resolveKey = newest ? `${nonce}::${newest.id}` : null;
  const answered = resolved !== null && resolved.key === resolveKey;
  const myThread = answered ? resolved.thread : null;
  const resolving = resolveKey !== null && !answered;

  useEffect(() => {
    if (!resolveKey || !newest) return;
    let cancelled = false;
    void (async () => {
      let thread: ItemThread | null = null;
      try {
        const match = await resolveThreadMatch(newest);
        if (match) thread = { accountId: match.accountId, threadKey: match.threadKey, subject: newest.subjectSnapshot ?? '' };
      } catch {
        // A network/server blip says nothing about ownership — leave `thread`
        // null for now rather than risk a stale positive; a fresh mount or an
        // explicit reload() asks again.
      }
      if (!cancelled) setResolved({ key: resolveKey, thread });
    })();
    return () => { cancelled = true; };
  }, [resolveKey, newest]);

  return useMemo(
    () => ({ links, newest, myThread, loading, resolving, reload }),
    [links, newest, myThread, loading, resolving, reload],
  );
}
