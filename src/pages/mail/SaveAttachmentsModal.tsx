// src/pages/mail/SaveAttachmentsModal.tsx — the remote-items variant of the
// Documents upload modal (Plan 3 Task 5): "Save to Documents…" on a message's
// AttachmentChips opens this. It's a thin wrapper around the shared
// UploadDocumentsModal — loading projects/customers/customTypes the same way
// DocumentsPage does — that turns a confirm into mailApi.saveAttachments.
//
// The server saves each item independently (a failure on one doesn't abort
// the rest), so a batch confirm can come back a mix of saved/failed. That
// per-item detail only exists here (UploadDocumentsModal's onUploadRemote
// contract is a coarse {ok,total}), so THIS component owns the toast and the
// "keep the modal open on exactly the failures" behavior: on any failure it
// narrows the working attachment list down to just the failed ones and hands
// that down as a new `remoteItems` array — UploadDocumentsModal re-seeds its
// chip list from that (without losing the Type/Project/Customer already
// picked) so pressing Save again retries only what didn't land.
import React, { useEffect, useMemo, useState } from 'react';
import { Customer } from '../../types';
import { CustomDocType, ProjectSummary, getCustomers, getDocumentTypes, getProjectsSummary } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { UploadDocumentsModal, RemoteUploadItem } from '../documents/UploadDocumentsModal';
import type { AttachmentMeta } from './types';

/** One file the server made from an attachment — the id AND the name it was
 *  saved under, because a caller acting on the result (the RFI pending-reply
 *  banner naming the file in its confirm) can't map ids back to names. */
export interface SavedAttachment { fileId: string; name: string; }

export const SaveAttachmentsModal: React.FC<{
  open: boolean;
  onClose: () => void;
  messageId: string;
  attachments: AttachmentMeta[];
  /** Preselects the Project when the mail thread this message belongs to is
   *  already linked to one. Not yet wired by any caller. */
  defaultProjectId?: string;
  /** The files the server made, for callers that want to do something with
   *  them (the RFI pending-reply banner offers one as the response document).
   *  Called once per confirm, only for what actually landed — this component
   *  is the only place that per-item detail exists. */
  onSaved?: (files: SavedAttachment[]) => void;
}> = ({ open, onClose, messageId, attachments, defaultProjectId, onSaved }) => {
  const { toast } = useToast();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);
  // The working set of attachments still to save — narrows on a partial
  // failure so a retry only resubmits what's left.
  const [remaining, setRemaining] = useState<AttachmentMeta[]>(attachments);

  // Gated on `open`: callers that keep the modal mounted while closed (the RFI
  // pending-reply banner does) would otherwise pay for three list requests on
  // every render of the host record.
  useEffect(() => {
    if (!open) return;
    getProjectsSummary().then(setProjects).catch(() => setProjects([]));
    getCustomers().then(setCustomers).catch(() => setCustomers([]));
    getDocumentTypes().then(setCustomTypes).catch(() => setCustomTypes([]));
  }, [open]);

  // Reset to the full attachment list every time the modal opens (a fresh
  // message, or the same message reopened after a prior save) — mirrors the
  // open-keyed reset UploadDocumentsModal itself does.
  useEffect(() => {
    if (open) setRemaining(attachments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageId]);

  const remoteItems = useMemo(
    () => remaining.map(a => ({ id: a.attId, name: a.name, size: a.size, mime: a.mime })),
    [remaining]
  );

  const onUploadRemote = async (items: RemoteUploadItem[]): Promise<{ ok: number; total: number }> => {
    const result = await mailApi.saveAttachments(
      messageId,
      items.map(it => ({ attId: it.id, name: it.name, kind: it.kind, projectId: it.projectId, customerId: it.customerId }))
    );
    const total = items.length;
    const ok = result.saved.length;
    const failedCount = result.failed.length;

    // Before the branch below: a partial save still produced real files, and a
    // caller waiting on them shouldn't have to care that a sibling failed. The
    // name comes from the item the caller submitted — result.saved carries ids
    // only, and the attId is the only thing that joins the two.
    const nameByAttId = new Map(items.map(it => [it.id, it.name]));
    const savedFiles = result.saved.map(s => ({ fileId: s.fileId, name: nameByAttId.get(s.attId) ?? '' }));
    if (savedFiles.length) onSaved?.(savedFiles);

    if (failedCount === 0) {
      toast(`Saved ${ok} file${ok === 1 ? '' : 's'} to Documents`, { type: 'success' });
      onClose();
    } else if (ok === 0) {
      // Nothing landed, so the count alone says nothing about WHY. The server's
      // per-item reason is the only thing that distinguishes "reconnect the
      // account" from "that attachment is not on this message".
      const why = result.failed.find(f => f.error)?.error;
      toast(`Failed to save ${failedCount} file${failedCount === 1 ? '' : 's'}${why ? ` — ${why}` : ''}`, { type: 'error' });
    } else {
      toast(`Saved ${ok} of ${total} files to Documents — ${failedCount} failed`, { type: 'warning' });
      const failedIds = new Set(result.failed.map(f => f.attId));
      setRemaining(prev => prev.filter(a => failedIds.has(a.attId)));
    }

    return { ok, total };
  };

  return (
    <UploadDocumentsModal
      open={open}
      onClose={onClose}
      onUploaded={() => {}}
      projects={projects}
      customers={customers}
      customTypes={customTypes}
      remoteItems={remoteItems}
      onUploadRemote={onUploadRemote}
      initialProjectId={defaultProjectId}
    />
  );
};
