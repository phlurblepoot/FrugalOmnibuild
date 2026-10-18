// src/components/documents/ReplyFlagChip.tsx
// Amber "Reply" chip — the linked email thread got a reply nobody has acted
// on yet (mail phase 2 spec Goal 4). Same visual language as the RFI
// pendingReply chip (ProjectRfis.tsx) so an item's reply state reads the same
// everywhere it can appear: list rows (invoices, change orders, proposals,
// issues, daily reports, tasks, pay apps) and DocumentActionsBar next to the
// Sent chip. RFI rows keep their own richer pendingReply chip instead of
// this one — see ProjectRfis.tsx's `rfi.pendingReply` branch — so a flagged
// RFI is never double-chipped.
import React from 'react';
import { Mail } from 'lucide-react';

export const REPLY_FLAG_TITLE = 'The linked email thread has a new reply';

export const ReplyFlagChip: React.FC<{ 'data-testid'?: string }> = ({ 'data-testid': testId }) => (
  <span
    title={REPLY_FLAG_TITLE}
    data-testid={testId}
    className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-300"
  >
    <Mail size={11} />Reply
  </span>
);
