// src/pages/mail/openThreadLink.ts
// Cross-user thread opening (spec Goal 3 / "#5"): a mail_thread_links row is
// shared app data everyone on the job can see, but the actual conversation
// lives in ONE person's mailbox. This is the ONE place that turns a link into
// either a navigation (this viewer's own mailbox holds it — exact threadKey,
// or the server's subject+date+participant fallback) or a "no copy of this
// here" answer, via GET /api/mail/resolve-thread. SentThreadChip and
// useItemThreadLinks.myThread both go through it instead of each
// re-implementing the lookup — the code this replaced only ever tried an
// exact threadKey match against every one of the viewer's accounts in turn.
import { mailApi } from '../../utils/mailApi';
import type { Addr, ThreadLink } from './types';

export interface ThreadMatch { accountId: string; threadKey: string }

// Mirrors MAX_RESOLVE_PARTICIPANTS in server/mail/routes.ts — trimming here
// keeps the query string well short of the server's own cap rather than
// relying on the 400 it would otherwise answer with.
const MAX_RESOLVE_PARTICIPANTS = 20;

/** A link row's participant snapshot, defensively parsed — the column is
 *  app-written JSON, but a hand-edited or pre-existing null must not throw. */
export function parseLinkParticipants(json: string | null | undefined): Addr[] {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Ask the server whether one of THIS user's own mailboxes holds the thread
 * `link` points at. Resolves to `null` for a definitive "no" (nothing in any
 * of their mailboxes matches, even with the fallback); rejects on a genuine
 * network/server failure so a caller can tell the two apart rather than
 * treating a blip as "not yours".
 */
export async function resolveThreadMatch(link: ThreadLink): Promise<ThreadMatch | null> {
  const participants = parseLinkParticipants(link.participantsJson)
    .map(p => (p.addr ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_RESOLVE_PARTICIPANTS)
    .join(',');
  const { match } = await mailApi.resolveThread({
    threadKey: link.threadKey,
    subject: link.subjectSnapshot ?? '',
    firstDate: link.firstDate ?? '',
    participants,
  });
  return match;
}

/**
 * Open a linked thread for the current viewer. Resolves it against their own
 * mailboxes and navigates straight in on a match; on no match, navigation is
 * left untouched and the caller is expected to render `ThreadReferenceCard`
 * for `link` instead.
 */
export async function openThreadLink(
  link: ThreadLink,
  navigate: (path: string) => void,
): Promise<'opened' | 'card'> {
  const match = await resolveThreadMatch(link);
  if (!match) return 'card';
  // `_` is MailPage's "any folder" segment (useThreadList.NO_FOLDER) — a link
  // row records the thread, not which folder it was filed in.
  navigate(`/mail/${encodeURIComponent(match.accountId)}/_/${encodeURIComponent(match.threadKey)}`);
  return 'opened';
}
