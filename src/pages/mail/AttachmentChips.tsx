// src/pages/mail/AttachmentChips.tsx — the attachment row under an expanded
// message. Attachments are streamed from the provider on demand (nothing is
// stored until the user saves it), so a chip is just a link to the mail
// attachment route: PDFs and images open inline in a tab; Word, Excel and
// PowerPoint files (old formats too) open in the ONLYOFFICE viewer in a tab
// (ONLYOFFICE Phase 6); everything else downloads. "Save to Documents…" hands
// off to the caller's modal.
import React from 'react';
import { Save } from 'lucide-react';
import { MimeIcon } from '../documents/MimeIcon';
import { mailApi } from '../../utils/mailApi';
import { officeFormatOf } from '../../utils/officeFormats';
import { attachmentViewerPath } from '../../utils/editorLinks';
import type { AttachmentMeta } from './types';

/** Same short form the Documents picker uses (src/components/FilePickerModal.tsx). */
export const fmtSize = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Types the browser can display itself. */
const opensInline = (mime: string): boolean => mime === 'application/pdf' || mime.startsWith('image/');
/** Word, Excel and PowerPoint files (by type or name): the document viewer. */
const opensInViewer = (att: AttachmentMeta): boolean => {
  const format = officeFormatOf({ mime: att.mime, name: att.name });
  return !!format && format.documentType !== 'pdf';
};

const CHIP =
  'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-edge bg-raised px-2 py-1 text-xs ' +
  'text-ink transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40';

export const AttachmentChips: React.FC<{
  messageId: string;
  attachments: AttachmentMeta[];
  /** Opens the Save-to-Documents modal. Omitted while no caller offers one —
   *  the button is then left out rather than rendered dead. */
  onSave?: () => void;
}> = ({ messageId, attachments, onSave }) => {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="mail-attachment-chips">
      {attachments.map(att => {
        const label = (
          <>
            <MimeIcon mime={att.mime} size={14} />
            <span className="min-w-0 truncate">{att.name}</span>
            <span className="shrink-0 text-ink-faint">{fmtSize(att.size)}</span>
          </>
        );

        if (opensInViewer(att)) {
          return (
            <button
              key={att.attId}
              type="button"
              data-testid="mail-attachment-chip"
              data-opens="viewer"
              title="Open in the document viewer"
              className={CHIP}
              onClick={() => window.open(attachmentViewerPath(messageId, att.attId, att.name), '_blank', 'noopener')}
            >
              {label}
            </button>
          );
        }
        return opensInline(att.mime) ? (
          <button
            key={att.attId}
            type="button"
            data-testid="mail-attachment-chip"
            className={CHIP}
            onClick={() => window.open(mailApi.attachmentUrl(messageId, att.attId, { inline: true }), '_blank', 'noopener')}
          >
            {label}
          </button>
        ) : (
          <a
            key={att.attId}
            data-testid="mail-attachment-chip"
            className={CHIP}
            href={mailApi.attachmentUrl(messageId, att.attId)}
            download={att.name}
          >
            {label}
          </a>
        );
      })}

      {onSave && (
        <button
          type="button"
          data-testid="mail-save-attachments"
          onClick={onSave}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent-700 transition-colors hover:bg-hover dark:text-accent-300"
        >
          <Save size={14} />
          <span>Save to Documents…</span>
        </button>
      )}
    </div>
  );
};
