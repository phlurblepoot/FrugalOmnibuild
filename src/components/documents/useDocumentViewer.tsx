// src/components/documents/useDocumentViewer.tsx
// "Peek at this record's generated document" for list rows — the same viewer
// the Documents page opens, minus the things a list row has no business doing
// (archiving lives on /documents). DocumentActionsBar has its own copy of this
// flow because it must first resolve a file id to metadata; a row already
// holds the metadata from the batch lookup, so this hook takes the file itself
// and opens instantly (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CustomDocType, DocumentRow, GeneratedDoc, fetchFileBlob, getDocumentTypes,
} from '../../utils/store';
import { downloadBlob } from '../../utils/download';
import { DocumentViewerModal } from '../../pages/documents/DocumentViewerModal';
import { openTargetFor } from '../../pages/documents/openTarget';
import { useToast } from '../Toast';

export interface DocumentViewerHandle {
  /** kind/projectId come from the host (a row's batch lookup returns neither). */
  open: (file: GeneratedDoc, kind: string, projectId: string | null) => void;
  /** Render this once in the host — null while nothing is open. */
  modal: React.ReactNode;
}

export function useDocumentViewer(): DocumentViewerHandle {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [row, setRow] = useState<DocumentRow | null>(null);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const open = useCallback((file: GeneratedDoc, kind: string, projectId: string | null) => {
    setRow({
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      kind,
      createdAt: file.createdAt,
      versionNumber: file.versionNumber,
      archived: false,
      projectId,
      projectName: null,
      customerId: null,
      customerName: null,
      source: null,
    });
    // Only feeds the viewer's kind label — a failure leaves the built-in
    // labels, so it must never block opening.
    getDocumentTypes()
      .then(types => { if (mountedRef.current) setCustomTypes(types); })
      .catch(() => {});
  }, []);

  const download = useCallback(async (r: DocumentRow) => {
    try {
      downloadBlob(await fetchFileBlob(r.id), r.name ?? 'document');
    } catch {
      toast('Download failed', { type: 'error' });
    }
  }, [toast]);

  const openInEditor = useCallback((r: DocumentRow) => {
    const target = openTargetFor(r);
    if (!target.url) { void download(r); return; }
    if (target.type === 'image') { window.open(target.url, '_blank', 'noopener'); return; }
    navigate(target.url);
  }, [download, navigate]);

  const modal = row ? (
    <DocumentViewerModal
      row={row}
      customTypes={customTypes}
      hideArchive
      onClose={() => setRow(null)}
      onOpenInEditor={openInEditor}
      onDownload={r => { void download(r); }}
      // Never reached — hideArchive removes the only caller.
      onArchive={async () => {}}
    />
  ) : null;

  return { open, modal };
}
