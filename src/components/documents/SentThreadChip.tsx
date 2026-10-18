// src/components/documents/SentThreadChip.tsx
// "This was emailed — here's the conversation." Sits next to the freshness chip
// in DocumentActionsBar so the answer to "did anyone send this, and what did
// they say?" is on the record itself rather than in someone's Sent folder.
//
// Presentational on purpose: DocumentActionsBar already runs
// useItemThreadLinks (it needs the same thread for the composer's "Reply in
// existing thread" option), so the chip takes the resolved values instead of
// loading them a second time — except when that pre-resolution came back
// empty, in which case a click still gets one more shot via `openThreadLink`
// (spec Goal 3 / "#5"): a mailbox added after the hook last resolved, or the
// subject+date fallback finding a match the exact-only prior check couldn't.
// No match either way and the chip shows the read-only ThreadReferenceCard
// instead of pretending the item was never sent.
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { formatMailDate } from '../../pages/mail/mailFormat';
import { openThreadLink } from '../../pages/mail/openThreadLink';
import { ThreadReferenceCard } from '../../pages/mail/ThreadReferenceCard';
import type { ItemThread } from '../../hooks/useItemThreadLinks';
import type { ThreadLink } from '../../pages/mail/types';

// MailPage reads `_` as "no folder filter" (useThreadList.NO_FOLDER). A link
// row records the thread, not which folder it was filed in, so the deep link
// says "any folder" and lets the page settle the rest.
const ANY_FOLDER = '_';

export const SentThreadChip: React.FC<{
  /** The newest thread link for this item, or null when it has never been sent. */
  link: ThreadLink | null;
  /** Set when one of the current user's mailboxes already resolves to that thread. */
  myThread: ItemThread | null;
  /** True while we are still asking which mailbox holds it. */
  resolving?: boolean;
  'data-testid'?: string;
}> = ({ link, myThread, resolving = false, 'data-testid': testId = 'sent-thread-chip' }) => {
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [showCard, setShowCard] = useState(false);

  if (!link) return null;

  const date = formatMailDate(link.firstDate ?? link.createdAt);
  const base = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap';

  // Already known to be one of this user's own threads: a real link, no round
  // trip needed.
  if (myThread) {
    return (
      <Link
        to={`/mail/${encodeURIComponent(myThread.accountId)}/${ANY_FOLDER}/${encodeURIComponent(myThread.threadKey)}`}
        className={`${base} border-edge bg-raised text-ink hover:bg-hover`}
        data-testid={testId}
        title={link.subjectSnapshot ?? 'Open the email thread'}
      >
        <MailCheck size={12} />
        Sent{date ? ` · ${date}` : ''} · Open thread
      </Link>
    );
  }

  const handleClick = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const result = await openThreadLink(link, (path) => navigate(path));
      if (result === 'card') setShowCard(true);
    } catch {
      // A network/server blip — say nothing new, the chip is still accurate
      // ("it was sent"); the user can just click again.
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`${base} border-edge bg-sunken text-ink-faint hover:bg-hover`}
        data-testid={testId}
        onClick={() => { void handleClick(); }}
        disabled={opening}
        title={resolving ? 'Looking for the conversation…' : 'View this conversation'}
      >
        <MailCheck size={12} />
        Sent{date ? ` · ${date}` : ''}
      </button>
      {showCard && <ThreadReferenceCard links={[link]} onClose={() => setShowCard(false)} />}
    </>
  );
};
