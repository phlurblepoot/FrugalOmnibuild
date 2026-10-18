// src/pages/mail/ThreadReferenceCard.tsx
// The read-only fallback for cross-user thread opening (spec Goal 3 / "#5"):
// when `openThreadLink` can't find the conversation in any of this viewer's
// own mailboxes, this is what they see instead of a 404 — everything the app
// itself knows about the thread (subject, participants, date, which items it
// is linked to, who linked it) without pretending they can open it.
import React, { useEffect, useState } from 'react';
import { Modal } from '../../components/ui';
import { getAssignableUsers } from '../../utils/store';
import { formatMailDate, itemTypeLabel } from './mailFormat';
import { parseLinkParticipants } from './openThreadLink';
import type { ThreadLink } from './types';

const addrText = (a: { addr: string; name?: string }): string =>
  a.name ? `${a.name} <${a.addr}>` : a.addr;

export const ThreadReferenceCard: React.FC<{
  /** Every known link for this thread — usually one (a chip the user just
   *  clicked), sometimes several (e.g. a Project Mail row aggregating every
   *  item the thread touches). All rows share one thread, so subject/date/
   *  participants are read off the first. */
  links: ThreadLink[];
  onClose: () => void;
}> = ({ links, onClose }) => {
  // Best-effort "who linked it" — a display name is nicer than a raw user id,
  // but the card is still complete without one, so a failed fetch just falls
  // back to the id rather than blocking the card.
  const [users, setUsers] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    getAssignableUsers()
      .then(list => {
        if (cancelled) return;
        setUsers(Object.fromEntries(list.map(u => [u.id, u.username])));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const first = links[0];
  const subject = first?.subjectSnapshot || '(no subject)';
  const date = formatMailDate(first?.firstDate ?? first?.createdAt ?? '');
  const participants = parseLinkParticipants(first?.participantsJson);

  return (
    <Modal open onClose={onClose} title={subject} width="md">
      <div className="space-y-4 text-sm" data-testid="thread-reference-card">
        {date && <div className="text-ink-faint">{date}</div>}

        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Participants</div>
          {participants.length > 0 ? (
            <div className="text-ink">{participants.map(addrText).join(', ')}</div>
          ) : (
            <div className="text-ink-faint">(unknown)</div>
          )}
        </div>

        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Linked to</div>
          <ul className="space-y-1">
            {links.map(l => (
              <li key={l.id} className="flex flex-wrap items-baseline gap-x-1.5" data-testid="thread-reference-link">
                <span className="rounded bg-accent-500/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-700 dark:text-accent-300">
                  {itemTypeLabel(l.itemType)}
                </span>
                <span className="text-ink">{l.label ?? l.itemId}</span>
                <span className="text-xs text-ink-faint">
                  · linked by {users[l.linkedByUserId] ?? l.linkedByUserId}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded border border-edge bg-sunken px-3 py-2 text-xs text-ink-faint" data-testid="thread-reference-no-copy">
          No copy of this conversation in your connected mailboxes.
        </div>
      </div>
    </Modal>
  );
};
