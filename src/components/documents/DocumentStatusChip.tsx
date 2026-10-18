// src/components/documents/DocumentStatusChip.tsx
// "Does this record already have a generated document, and is it current?" —
// the one-glance half of DocumentActionsBar (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout). Pure display:
// the caller owns the useGeneratedDocument state.
import React from 'react';
import { GeneratedDoc } from '../../utils/store';
import { StatusPill } from '../ui';

export type DocFormat = 'pdf' | 'xlsx';

export const FORMAT_WORD: Record<DocFormat, string> = { pdf: 'PDF', xlsx: 'Excel' };

const EDITED_TITLE = 'Edited in the Document Editor after it was generated. Regenerating puts a fresh copy on top; the edited one stays in its version history.';
const RESTORED_TITLE = 'An earlier version was restored, so it may not match the record. Regenerate to bring it up to date.';

export const DocumentStatusChip: React.FC<{
  file: GeneratedDoc | null;
  upToDate: boolean | null;
  format?: DocFormat;
  size?: 'sm';
  /** 'unknown' for a record with no change clock to compare against (the
   *  project-level punch report): the chip then says only that a file exists,
   *  because claiming it is current would be a guess. */
  staleness?: 'unknown';
}> = ({ file, upToDate, format = 'pdf', size, staleness }) => {
  const word = FORMAT_WORD[format];
  // upToDate is null exactly when there is no file (see isUpToDate), but key
  // off `file` so a caller passing one without the other still reads right.
  const edited = file?.versionOrigin === 'editor';
  const restored = file?.versionOrigin === 'restore';
  const { tone, label, title } = !file
    ? { tone: 'slate' as const, label: `No ${word} yet`, title: undefined }
    : restored
      ? { tone: 'amber' as const, label: `Earlier ${word} restored`, title: RESTORED_TITLE }
      : staleness === 'unknown'
        ? { tone: 'slate' as const, label: edited ? `${word} edited` : `${word} saved`, title: edited ? EDITED_TITLE : undefined }
        : edited
          ? upToDate
            ? { tone: 'blue' as const, label: `${word} edited`, title: EDITED_TITLE }
            : { tone: 'amber' as const, label: `${word} edited, out of date`, title: `${EDITED_TITLE} The record has changed since.` }
          : upToDate
            ? { tone: 'emerald' as const, label: `${word} up to date`, title: undefined }
            : { tone: 'amber' as const, label: `${word} out of date`, title: undefined };

  return (
    <span title={title}>
      <StatusPill tone={tone} className={size === 'sm' ? 'px-2 py-0' : ''}>{label}</StatusPill>
    </span>
  );
};
