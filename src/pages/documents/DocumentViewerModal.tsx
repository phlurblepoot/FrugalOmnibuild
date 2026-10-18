// src/pages/documents/DocumentViewerModal.tsx
// Centered viewer opened by a Documents row click
// (docs/superpowers/specs/2026-08-17-document-previews-design.md §Decisions).
// The old row-click behavior (jump straight to the document editor or a raw
// image tab) is still one click away as "Open in editor" — this just puts
// a look-before-you-leap step in front of it.
//
// Mounted only while a row is open (DocumentsTable renders it conditionally),
// so unmount is the single close path: it destroys the pdf.js document handle
// and cancels any in-flight page render.
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ChevronLeft, ChevronRight, Download, ExternalLink, Link2, Share2,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { DocumentRow, fetchFileBlob, formatBytes, getImageUrl } from '../../utils/store';
import { Button, Modal, Skeleton, Table, TBody, TD, TR } from '../../components/ui';
import { CustomDocType, kindLabel } from './docTypes';
import { MimeIcon } from './MimeIcon';
import { selectionPolicy } from './documentsPolicy';
import { PdfDocHandle, loadPdfDoc, previewKindFor, renderPdfPage } from './previewEngine';
import { Lightbox } from '../../components/Lightbox';

// How much of a spreadsheet the peek shows (spec: "first sheet's leading
// rows"). Anything larger belongs in the sheets editor.
const SHEET_MAX_ROWS = 20;
const SHEET_MAX_COLS = 8;

type SheetState = { rows: string[][] } | { error: true } | null;

const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3 text-sm">
    <span className="w-20 shrink-0 text-ink-faint">{label}</span>
    <span className="min-w-0 flex-1 text-ink">{children}</span>
  </div>
);

export const DocumentViewerModal: React.FC<{
  row: DocumentRow;
  customTypes: CustomDocType[];
  onClose: () => void;
  /** openTargetFor semantics — the pre-preview row-click behavior. */
  onOpenInEditor: (row: DocumentRow) => void;
  onDownload: (row: DocumentRow) => void;
  onArchive: (row: DocumentRow, archived: boolean) => Promise<void>;
  /** Suppress the Archive button for hosts that don't own archiving (e.g. an
   *  editor's DocumentActionsBar preview). */
  hideArchive?: boolean;
  /** Share a public link to it (ONLYOFFICE Phase 7); left out where not given. */
  onShare?: (row: DocumentRow) => void;
}> = ({ row, customTypes, onClose, onOpenInEditor, onDownload, onArchive, hideArchive = false, onShare }) => {
  const kind = previewKindFor(row.mime);

  // ── PDF: one document handle for the modal's lifetime, page flips render
  // from it (no refetch), unmount destroys it. ─────────────────────────────
  const docRef = useRef<PdfDocHandle | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pdfFailed, setPdfFailed] = useState(false);

  useEffect(() => {
    if (kind !== 'pdf') return;
    let cancelled = false;
    setNumPages(0);
    setPageNum(1);
    setPdfFailed(false);
    loadPdfDoc(row.id)
      .then(doc => {
        // Closed (or switched rows) while the bytes were in flight — the
        // handle still has to be released.
        if (cancelled) { doc.destroy().catch(() => {}); return; }
        docRef.current = doc;
        setNumPages(doc.numPages);
      })
      .catch(() => { if (!cancelled) setPdfFailed(true); });
    return () => {
      cancelled = true;
      const doc = docRef.current;
      docRef.current = null;
      doc?.destroy().catch(() => {});
    };
  }, [row.id, kind]);

  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || numPages === 0) return;
    let cancelled = false;
    const task = renderPdfPage(doc, pageNum, canvas);
    task.promise.catch(() => { if (!cancelled) setPdfFailed(true); });
    // Flipping pages faster than a render finishes must cancel the outgoing
    // one — pdf.js throws on two concurrent renders into the same canvas.
    return () => { cancelled = true; task.cancel(); };
  }, [numPages, pageNum]);

  // ── Sheet: parse the first sheet client-side, same xlsx path as the AIA
  // schedule-of-values upload. ─────────────────────────────────────────────
  const [sheet, setSheet] = useState<SheetState>(null);

  useEffect(() => {
    if (kind !== 'sheet') return;
    let cancelled = false;
    setSheet(null);
    (async () => {
      const blob = await fetchFileBlob(row.id);
      const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error('no sheet');
      const raw = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, blankrows: false });
      return raw.slice(0, SHEET_MAX_ROWS).map(r =>
        Array.from({ length: SHEET_MAX_COLS }, (_, i) => String(r?.[i] ?? '')));
    })()
      .then(rows => { if (!cancelled) setSheet({ rows }); })
      .catch(() => { if (!cancelled) setSheet({ error: true }); });
    return () => { cancelled = true; };
  }, [row.id, kind]);

  const archivable = !hideArchive && selectionPolicy([row]).archivable.length > 0;
  const [archiving, setArchiving] = useState(false);

  // Image preview opens the same app-wide Lightbox as every other photo grid
  // — deliberately layered ON TOP of this Modal rather than folded into it,
  // so the Escape-ownership rule (Lightbox: capture-phase; Modal: bubble
  // phase, see components/Lightbox.tsx's header) is exercised for real here:
  // this is the one place in the app where the two are nested by default.
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const handleArchive = async () => {
    setArchiving(true);
    try {
      await onArchive(row, !row.archived);
      // The list refreshes behind us, so the row object here is now stale.
      onClose();
    } finally {
      setArchiving(false);
    }
  };

  const body = () => {
    if (kind === 'image') {
      return (
        <img
          src={getImageUrl(row.id)}
          alt={row.name ?? row.id}
          onClick={() => setLightboxOpen(true)}
          className="mx-auto max-h-[65dvh] w-auto max-w-full cursor-pointer object-contain"
        />
      );
    }

    if (kind === 'pdf') {
      if (pdfFailed) return <p className="py-8 text-center text-sm text-ink-faint">Couldn’t render this PDF. Try Download or Open in editor.</p>;
      return (
        <div className="space-y-3">
          {/* items-start: a flex row stretches children to its height by default,
              which would squash the page to the box instead of scaling it.
              The canvas keeps its intrinsic aspect via max-w/max-h + auto. */}
          <div className="flex max-h-[65dvh] items-start justify-center overflow-auto rounded-lg bg-sunken p-2">
            {numPages === 0 && <Skeleton className="h-[60dvh] w-full max-w-lg" />}
            <canvas ref={canvasRef} className={`h-auto w-auto max-h-[63dvh] max-w-full ${numPages === 0 ? 'hidden' : ''}`} />
          </div>
          {numPages > 1 && (
            <div className="flex items-center justify-center gap-3 text-sm text-ink-soft">
              <Button
                variant="secondary"
                size="sm"
                data-testid="doc-viewer-page-prev"
                aria-label="Previous page"
                disabled={pageNum <= 1}
                onClick={() => setPageNum(p => Math.max(1, p - 1))}
              >
                <ChevronLeft size={14} />
              </Button>
              <span>Page {pageNum} / {numPages}</span>
              <Button
                variant="secondary"
                size="sm"
                data-testid="doc-viewer-page-next"
                aria-label="Next page"
                disabled={pageNum >= numPages}
                onClick={() => setPageNum(p => Math.min(numPages, p + 1))}
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </div>
      );
    }

    if (kind === 'sheet') {
      if (sheet === null) return <Skeleton className="h-40 w-full" />;
      if ('error' in sheet) return <p className="py-8 text-center text-sm text-ink-faint">Couldn’t read this spreadsheet. Try Open in editor.</p>;
      return (
        <div className="max-h-[65dvh] overflow-auto rounded-lg border border-edge">
          <Table>
            <TBody>
              {sheet.rows.map((cells, r) => (
                <TR key={r}>
                  {cells.map((c, i) => (
                    <TD key={i} className={`whitespace-nowrap ${r === 0 ? 'font-semibold text-ink' : 'text-ink-soft'}`}>{c}</TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-edge px-4 py-2 text-xs text-ink-faint">
            First {SHEET_MAX_ROWS} rows of the first sheet — open in editor for the whole file.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="flex justify-center py-4"><MimeIcon mime={row.mime} size={40} className="text-ink-faint" /></div>
        <DetailRow label="Name">{row.name ?? row.id}</DetailRow>
        <DetailRow label="Size">{formatBytes(row.size)}</DetailRow>
        <DetailRow label="Type">{kindLabel(row.kind, customTypes)}</DetailRow>
        <DetailRow label="Project">{row.projectName ?? '—'}</DetailRow>
        <DetailRow label="Source">{row.source?.label ?? '—'}</DetailRow>
        <DetailRow label="Date">{new Date(row.createdAt).toLocaleString()}</DetailRow>
      </div>
    );
  };

  return (
    <>
    <Modal open onClose={onClose} title={row.name ?? row.id} width="xl" footer={
      <>
        {archivable && (
          <Button
            variant="secondary"
            data-testid="doc-viewer-archive"
            disabled={archiving}
            onClick={handleArchive}
          >
            {row.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            {row.archived ? 'Restore' : 'Archive'}
          </Button>
        )}
        {row.source?.href && (
          // A Link styled as a secondary Button rather than a Button inside a
          // Link — nesting a <button> in an <a> is invalid markup.
          <Link
            to={row.source.href}
            onClick={onClose}
            data-testid="doc-viewer-source"
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-edge bg-raised px-4 text-sm font-medium text-ink transition-colors hover:bg-hover md:h-9 md:min-h-0"
          >
            <Link2 size={15} />{row.source.label}
          </Link>
        )}
        {onShare && (
          <Button variant="secondary" data-testid="doc-viewer-share" onClick={() => onShare(row)}>
            <Share2 size={15} />Share
          </Button>
        )}
        <Button variant="secondary" data-testid="doc-viewer-download" onClick={() => onDownload(row)}>
          <Download size={15} />Download
        </Button>
        <Button
          data-testid="doc-viewer-open-editor"
          onClick={() => { onClose(); onOpenInEditor(row); }}
        >
          <ExternalLink size={15} />Open in editor
        </Button>
      </>
    }>
      <div data-testid="doc-viewer-modal">{body()}</div>
    </Modal>
    {lightboxOpen && kind === 'image' && (
      <Lightbox
        items={[{ src: getImageUrl(row.id), caption: row.name ?? undefined }]}
        index={0}
        onClose={() => setLightboxOpen(false)}
      />
    )}
    </>
  );
};
