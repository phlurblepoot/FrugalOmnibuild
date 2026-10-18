// src/components/documents/useAttachFiles.ts
// The half of an "add files" surface that AddFilesButton doesn't cover: what
// happens to the files once they exist, and what happens when they arrive by
// drag-and-drop instead of through the picker
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
//
// Two arrival paths, one outcome:
//  - the picker's Upload tab has ALREADY stored what it hands back, so a
//    picked row only needs linking to the record;
//  - a dropped File never went near the picker, so it takes the same upload
//    path the picker would have taken first.
// Callers get both as one hook so no card has to re-derive "project upload vs
// global file store" from its upload config.
import { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { DocumentRow, saveBinaryFile, uploadProjectFile } from '../../utils/store';
import { FilePickerUploadConfig } from '../FilePickerModal';
import { DropAccept, DropZoneProps, useDropZone } from '../../hooks/useDropZone';
import { useToast } from '../Toast';

export interface UseAttachFilesOptions {
  /** Where a new file lands — the same config the picker is given. */
  upload: FilePickerUploadConfig;
  accept?: DropAccept;
  /** Points the record at a stored file (addIssuePhoto, addProposalAttachment, …). */
  link: (fileId: string, meta: { name: string | null }) => Promise<unknown> | unknown;
  /** Reload the record so what was just added shows up. */
  onDone: () => void;
  /** The owner is refusing additions right now (unsaved edits, locked record). */
  disabled?: boolean;
  /** Why it's refusing — toasted on a drop so the gesture never dies silently. */
  disabledMessage?: string;
  /** Plural noun for the partial-failure summary. */
  noun?: string;
}

export interface AttachFiles {
  dragActive: boolean;
  dropProps: DropZoneProps;
  /** An upload is in flight from a drop. */
  busy: boolean;
  /** onPick handler for AddFilesButton. */
  attachRows: (rows: DocumentRow[]) => Promise<void>;
}

export function useAttachFiles({
  upload, accept = 'image', link, onDone, disabled = false, disabledMessage, noun = 'photos',
}: UseAttachFilesOptions): AttachFiles {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { kind, projectId, customerId, sourceType, sourceId } = upload;

  // One summary for a batch rather than a toast per failure: a picker
  // selection or a drop can carry many files, and each one that fails is a row
  // the user can simply add again.
  const linkAll = useCallback(async (
    picked: { fileId: string; name: string | null }[], attempted: number,
  ) => {
    let ok = 0;
    for (const p of picked) {
      try { await link(p.fileId, { name: p.name }); ok++; } catch { /* keep going */ }
    }
    if (ok < attempted) toast(`Added ${ok} of ${attempted} ${noun}`, { type: ok ? 'warning' : 'error' });
    onDone();
  }, [link, onDone, toast, noun]);

  const attachRows = useCallback(async (rows: DocumentRow[]) => {
    if (!rows.length) return;
    setBusy(true);
    try {
      await linkAll(rows.map(r => ({ fileId: r.id, name: r.name })), rows.length);
    } finally { setBusy(false); }
  }, [linkAll]);

  const attachFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    // The dropzone stays live while disabled so the refusal can be explained —
    // a drop that vanishes silently reads as a broken page.
    if (disabled) {
      if (disabledMessage) toast(disabledMessage, { type: 'warning' });
      return;
    }
    setBusy(true);
    const stored: { fileId: string; name: string | null }[] = [];
    for (const file of files) {
      try {
        const res = projectId
          ? await uploadProjectFile(projectId, file, kind, { sourceType, sourceId })
          : await saveBinaryFile(uuidv4(), file, { kind, name: file.name, customerId, sourceType, sourceId });
        stored.push({ fileId: res.fileId, name: file.name });
      } catch { /* counted against `attempted` below */ }
    }
    try {
      await linkAll(stored, files.length);
    } finally { setBusy(false); }
  }, [disabled, disabledMessage, toast, projectId, customerId, kind, sourceType, sourceId, linkAll]);

  const onFiles = useCallback((files: File[]) => { void attachFiles(files); }, [attachFiles]);
  const { dragActive, dropProps } = useDropZone(onFiles, { accept, disabled: busy });

  return { dragActive, dropProps, busy, attachRows };
}
