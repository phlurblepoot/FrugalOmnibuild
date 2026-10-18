// src/pages/project/proposal/ProposalAttachmentsCard.tsx
// PDF attachments appended to the end of the generated proposal, in list
// order. Fully controlled and mutated straight through the API (no dirty
// state) — every action calls onChanged() so the editor reloads the proposal.
// Draft-only: the server rejects attachment edits on a locked proposal and
// requires the file to be a PDF.
import React from 'react';
import { ArrowDown, ArrowUp, FileText, X } from 'lucide-react';
import {
  type Proposal, type ProposalAttachment,
  addProposalAttachment, updateProposalAttachment, removeProposalAttachment,
} from '../../../utils/store';
import { Button, Card, CardBody, CardHeader } from '../../../components/ui';
import { AddFilesButton } from '../../../components/documents/AddFilesButton';
import { useAttachFiles } from '../../../components/documents/useAttachFiles';
import { useToast } from '../../../components/Toast';
import { handleProposalCardError, toastProposalCardError } from './proposalCardErrors';

const fmtSize = (n: number | null) => {
  if (n == null) return null;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

export const ProposalAttachmentsCard: React.FC<{
  proposal: Proposal;
  projectId: string;
  readOnly: boolean;
  onChanged: () => void;
}> = ({ proposal, projectId, readOnly, onChanged }) => {
  const { toast } = useToast();

  const attachments = [...proposal.attachments].sort((a, b) => a.sortOrder - b.sortOrder);

  // One affordance for both "upload a new PDF" and "reuse one already filed"
  // — and the same wiring for a PDF dropped onto the card. A per-row failure
  // (a stale fileId, or the proposal locking mid-pick) is summarised rather
  // than swallowed: a pick or a drop can carry many files at once.
  const attachmentUpload = { kind: 'document', projectId };
  const { dragActive, dropProps, busy, attachRows } = useAttachFiles({
    upload: attachmentUpload,
    accept: 'pdf',
    link: fileId => addProposalAttachment(proposal.id, fileId),
    onDone: onChanged,
    disabled: readOnly,
    disabledMessage: 'This proposal was sent and is now locked',
    noun: 'files',
  });

  // The two PATCHes are sequential rather than Promise.all'd: if the second
  // one fails, the server is left with one attachment's sortOrder already
  // moved — onChanged() always runs (via finally) so the card resyncs to
  // whatever sortOrder the server actually ended up with, instead of showing
  // a stale (and now duplicate) local order.
  const handleMove = async (index: number, dir: -1 | 1) => {
    const cur = attachments[index];
    const other = attachments[index + dir];
    if (!other) return;
    try {
      await updateProposalAttachment(proposal.id, cur.fileId, { sortOrder: other.sortOrder });
      await updateProposalAttachment(proposal.id, other.fileId, { sortOrder: cur.sortOrder });
    } catch (e) {
      toastProposalCardError(e, toast, 'Failed to reorder attachments');
    } finally {
      onChanged();
    }
  };

  const handleRemove = async (attachment: ProposalAttachment) => {
    try {
      await removeProposalAttachment(proposal.id, attachment.fileId);
      onChanged();
    } catch (e) { handleProposalCardError(e, toast, onChanged, 'Failed to remove attachment'); }
  };

  return (
    <Card
      data-testid="proposal-attachments"
      {...dropProps}
      className={dragActive ? 'ring-2 ring-accent-500' : ''}
    >
      <CardHeader
        title="Attachments"
        actions={!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            {busy && <span className="text-xs text-ink-faint">Uploading…</span>}
            <AddFilesButton
              label="Add PDFs"
              accept="pdf"
              size="sm"
              defaultTab="upload"
              upload={attachmentUpload}
              // Global by design: a proposal often appends a PDF filed under
              // another project (a standard warranty, a spec sheet).
              initialProjectIds={[]}
              excludeFileIds={proposal.attachments.map(a => a.fileId)}
              disabled={busy}
              onPick={attachRows}
            />
          </div>
        )}
      />
      <CardBody className="space-y-2">
        <p className="text-xs text-ink-faint">Attached PDFs are appended to the end of the generated proposal, in this order.</p>
        {attachments.length === 0 ? (
          <p className="text-sm text-ink-faint">No attachments.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {attachments.map((attachment, i) => (
              <li key={attachment.id} className="flex items-center gap-3 py-2" data-testid={`proposal-attachment-${attachment.id}`}>
                <FileText size={16} className="shrink-0 text-ink-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{attachment.name ?? attachment.fileId}</p>
                  {fmtSize(attachment.size) && <p className="text-xs text-ink-faint">{fmtSize(attachment.size)}</p>}
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => handleMove(i, -1)}><ArrowUp size={14} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Move down" title="Move down" disabled={i === attachments.length - 1} onClick={() => handleMove(i, 1)}><ArrowDown size={14} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Remove attachment" title="Remove" onClick={() => handleRemove(attachment)}><X size={14} /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
};
