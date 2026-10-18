// src/pages/project/ProjectMail.tsx
// Project Mail tab (mail phase 2 spec Goal 5): one row per distinct email
// thread linked to this project or one of its items — GET
// /api/mail/project-threads (mailApi.projectThreads). Cross-user opening
// reuses the same openThreadLink/ThreadReferenceCard machinery as
// SentThreadChip (spec Goal 3 / "#5"): a mail_thread_links row is shared app
// data everyone on the job can see, but the actual conversation lives in ONE
// person's mailbox — a click may resolve into the current viewer's own
// mailbox (navigate straight in) or fall back to the read-only reference
// card. No admin gating: mail links are not billing data.
//
// TRUST BOUNDARY: subjectSnapshot/participants are email-derived text —
// rendered below only as React text children, never dangerouslySetInnerHTML.
import React, { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Mail as MailIcon } from 'lucide-react';
import { mailApi } from '../../utils/mailApi';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { ReplyFlagChip } from '../../components/documents/ReplyFlagChip';
import { Card, EmptyState, Skeleton, Table, TBody, TD, TH, THead, TR } from '../../components/ui';
import { useMailAccounts } from '../mail/useMailAccounts';
import { formatMailDate, itemTypeLabel, participantsLabel } from '../mail/mailFormat';
import { openThreadLink } from '../mail/openThreadLink';
import { ThreadReferenceCard } from '../mail/ThreadReferenceCard';
import type { ProjectThreadLinkRef, ProjectThreadRow, ThreadLink } from '../mail/types';

// A row of chips beyond this many folds into a "+N" chip — same density cap
// as ThreadRow's link chips in the mail inbox itself.
const CHIP_LIMIT = 3;

/**
 * A ProjectThreadRow carries the app-written snapshot (subject/participants/
 * date at link time) and resolved item labels, aggregated across every
 * mail_thread_links row this project's threads touch — it does not carry a
 * specific link row's id or linkedByUserId (there can be several, one per
 * linked item). Synthesizing one pseudo `ThreadLink` per item chip lets this
 * page reuse openThreadLink/ThreadReferenceCard exactly as SentThreadChip
 * does, rather than forking the cross-user-opening logic for this page.
 * openThreadLink only reads threadKey/subjectSnapshot/firstDate/
 * participantsJson; ThreadReferenceCard additionally renders id/itemType/
 * itemId/label per row and "linked by" from linkedByUserId — left blank here
 * since the aggregate row doesn't know who linked which item.
 */
function toPseudoLink(row: ProjectThreadRow, ref: ProjectThreadLinkRef): ThreadLink {
  return {
    id: `${row.threadKey}:${ref.itemType}:${ref.itemId}`,
    threadKey: row.threadKey,
    subjectSnapshot: row.subjectSnapshot,
    firstDate: row.firstDate,
    participantsJson: JSON.stringify(row.participants),
    itemType: ref.itemType,
    itemId: ref.itemId,
    projectId: null,
    customerId: null,
    linkedByUserId: '',
    createdAt: row.firstDate ?? '',
    label: ref.label,
  };
}

export const ProjectMail: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { accounts } = useMailAccounts();
  const ownAddresses = accounts.map(a => a.emailAddress);

  const [rows, setRows] = useState<ProjectThreadRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [cardRow, setCardRow] = useState<ProjectThreadRow | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    mailApi.projectThreads(projectId).then(setRows).catch(() => setRows([]));
  }, [projectId]);
  useLiveQuery(load, { types: ['mailThread'], projectId });

  const handleOpen = async (row: ProjectThreadRow) => {
    if (busy || row.links.length === 0) return;
    setBusy(true);
    try {
      const result = await openThreadLink(toPseudoLink(row, row.links[0]), navigate);
      if (result === 'card') setCardRow(row);
    } catch {
      // A network/server blip — same treatment as SentThreadChip: say
      // nothing new, the row is still accurate, and the user can click again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-4 text-xl font-bold text-ink">Mail</h1>

      {rows === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<MailIcon size={22} />}
          title="No email threads linked to this project yet."
          description="Link a thread from an item's Mail chip, or from the mail inbox, and it will show up here."
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR><TH>Subject</TH><TH>Linked to</TH><TH>Participants</TH><TH>Last activity</TH></TR>
            </THead>
            <TBody>
              {rows.map(row => {
                const chipLabels = Array.from(new Set(row.links.map(l => l.label || itemTypeLabel(l.itemType))));
                const visibleChips = chipLabels.slice(0, CHIP_LIMIT);
                const overflowChips = chipLabels.slice(CHIP_LIMIT);
                // Floored at the thread's earliest link, not just lastOutboundDate
                // (spec Goal 4's max(lastOutboundDate, link.createdAt), same rule
                // the per-item reply-flags route applies) — otherwise linking an
                // already-old inbound-only thread reads as an unanswered reply
                // from before anyone here was tracking it.
                const floor = row.lastOutboundDate && row.lastOutboundDate > row.earliestLinkCreatedAt
                  ? row.lastOutboundDate : row.earliestLinkCreatedAt;
                const hasReply = !!row.lastInboundDate && row.lastInboundDate > floor;

                return (
                  <TR
                    key={row.threadKey}
                    interactive
                    onClick={() => void handleOpen(row)}
                    data-testid="project-mail-row"
                  >
                    <TD className="max-w-xs">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium text-ink">{row.subjectSnapshot || '(no subject)'}</span>
                        {hasReply && <ReplyFlagChip data-testid={`project-mail-reply-${row.threadKey}`} />}
                      </span>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {visibleChips.map(label => (
                          <span
                            key={label}
                            data-testid="project-mail-chip"
                            title={label}
                            className="max-w-[140px] truncate rounded bg-accent-500/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-700 dark:text-accent-300"
                          >
                            {label}
                          </span>
                        ))}
                        {overflowChips.length > 0 && (
                          <span
                            data-testid="project-mail-chip-overflow"
                            title={overflowChips.join(', ')}
                            className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-faint"
                          >
                            +{overflowChips.length}
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD className="text-ink-soft">{participantsLabel(row.participants, ownAddresses)}</TD>
                    <TD className="text-ink-faint">{formatMailDate(row.lastActivity)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}

      {cardRow && (
        <ThreadReferenceCard
          links={cardRow.links.map(ref => toPseudoLink(cardRow, ref))}
          onClose={() => setCardRow(null)}
        />
      )}
    </div>
  );
};
