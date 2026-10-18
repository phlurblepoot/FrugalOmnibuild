// src/components/documents/PdfAttachmentsCard.tsx
// The PDF attachments list invoices, change orders, RFIs, issues and daily
// reports all keep (spec docs/superpowers/specs/2026-10-06-pdf-attachments-design.md).
// Each attached PDF is appended to the end of the record's generated PDF,
// after its photos, in this list's order (appendAttachedPdfs). Lifted out of
// the invoice editor so the five share one list — one picker, one reorder,
// one remove; the owner supplies only its record's three API calls.
// Inline (no Card wrapper), like PhotoDropCard, and fully controlled: every
// action ends in onChanged() so the owner reloads the record.
import React from 'react';
import { ArrowDown, ArrowUp, FileText, X } from 'lucide-react';
import type { PdfAttachment } from '../../utils/store';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { AddFilesButton } from './AddFilesButton';
import { useAttachFiles } from './useAttachFiles';

const fmtAttachmentSize = (n: number | null) => {
  if (n == null) return null;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

export interface PdfAttachmentsCardProps {
  attachments: PdfAttachment[];
  /** A new upload is filed under this project as a document. */
  projectId: string;
  /** What the PDFs end up in, for the hint line — 'invoice', 'RFI', … */
  documentName: string;
  link: (fileId: string) => Promise<unknown>;
  update: (fileId: string, patch: { sortOrder: number }) => Promise<unknown>;
  remove: (fileId: string) => Promise<unknown>;
  onChanged: () => void;
  /** Prefix for each row's test id: `${testId}-attachment-${id}`. */
  testId: string;
  /** Refuse additions (e.g. unsaved edits), with the reason on the button. */
  disabled?: boolean;
  disabledMessage?: string;
}

export const PdfAttachmentsCard: React.FC<PdfAttachmentsCardProps> = ({
  attachments: unsorted, projectId, documentName, link, update, remove, onChanged, testId,
  disabled = false, disabledMessage,
}) => {
  const { toast } = useToast();
  const attachments = [...unsorted].sort((a, b) => a.sortOrder - b.sortOrder);

  const attachmentUpload = { kind: 'document', projectId };
  const { busy, attachRows } = useAttachFiles({
    upload: attachmentUpload,
    accept: 'pdf',
    link: fileId => link(fileId),
    onDone: onChanged,
    disabled,
    disabledMessage,
    noun: 'files',
  });

  // Sequential, not Promise.all'd: if the second PATCH fails the server is
  // left with one sortOrder moved, and onChanged() (always, via finally)
  // resyncs the list to whatever order the server actually holds.
  const handleMove = async (index: number, dir: -1 | 1) => {
    const cur = attachments[index];
    const other = attachments[index + dir];
    if (!other) return;
    try {
      await update(cur.fileId, { sortOrder: other.sortOrder });
      await update(other.fileId, { sortOrder: cur.sortOrder });
    } catch { toast('Failed to reorder attachments', { type: 'error' }); }
    finally { onChanged(); }
  };

  const handleRemove = async (attachment: PdfAttachment) => {
    try { await remove(attachment.fileId); onChanged(); }
    catch { toast('Failed to remove attachment', { type: 'error' }); }
  };

  return (
    <div className="mt-4 border-t border-edge pt-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">Attachments</h4>
        <div className="flex flex-wrap items-center gap-2">
          {busy && <span className="text-xs text-ink-faint">Uploading…</span>}
          <AddFilesButton
            label="Add PDFs"
            accept="pdf"
            size="sm"
            defaultTab="upload"
            upload={attachmentUpload}
            // Global by design: a record often appends a PDF filed under
            // another project (a standard warranty, a spec sheet).
            initialProjectIds={[]}
            excludeFileIds={unsorted.map(a => a.fileId)}
            disabled={disabled || busy}
            title={disabled ? disabledMessage : undefined}
            onPick={attachRows}
          />
        </div>
      </div>
      <p className="text-xs text-ink-faint">Attached PDFs are appended to the end of the generated {documentName}, after any photos, in this order.</p>
      {attachments.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">No attachments.</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge">
          {attachments.map((attachment, i) => (
            <li key={attachment.id} className="flex items-center gap-3 py-2" data-testid={`${testId}-attachment-${attachment.id}`}>
              <FileText size={16} className="shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{attachment.name ?? attachment.fileId}</p>
                {fmtAttachmentSize(attachment.size) && <p className="text-xs text-ink-faint">{fmtAttachmentSize(attachment.size)}</p>}
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => handleMove(i, -1)}><ArrowUp size={14} /></Button>
                <Button variant="ghost" size="sm" aria-label="Move down" title="Move down" disabled={i === attachments.length - 1} onClick={() => handleMove(i, 1)}><ArrowDown size={14} /></Button>
                <Button variant="ghost" size="sm" aria-label="Remove attachment" title="Remove" onClick={() => handleRemove(attachment)}><X size={14} /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
