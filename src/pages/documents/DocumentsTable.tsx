// src/pages/documents/DocumentsTable.tsx
// Table (+ mobile card list) for the global Documents page. Version-history
// expandable row and open-on-click logic are extracted from the retired
// src/pages/project/ProjectDocuments.tsx (spec §Client). Per-row
// archive/delete/change-type affordances used to live as always-visible
// buttons in this column; they're now a right-click/long-press context menu
// (RowContextMenu.tsx, spec docs/superpowers/specs/2026-08-17-documents-context-menu-design.md)
// so a single mis-click can't trigger a destructive action. A row click no
// longer jumps straight to an editor either — it opens DocumentViewerModal,
// with the old behavior kept as that modal's "Open in editor" (spec
// docs/superpowers/specs/2026-08-17-document-previews-design.md). The actual
// mutations (patchFile/deleteFile calls) live in DocumentsPage — this only
// decides what to offer via selectionPolicy (inside RowContextMenu) and
// confirms before delete.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { DocumentRow, fetchFileBlob, formatBytes } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { useShare } from '../../components/ShareLinkModal';
import { useConfirm } from '../../components/ConfirmDialog';
import { FileViewerDots } from '../../components/FileViewerDots';
import { Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR } from '../../components/ui';
import { CustomDocType, kindLabel, kindTone } from './docTypes';
import { DocumentHoverPreview } from './DocumentHoverPreview';
import { DocumentViewerModal } from './DocumentViewerModal';
import { FileThumb } from './FileThumb';
import { openTargetFor } from './openTarget';
import { RowContextMenu, RowContextMenuState } from './RowContextMenu';
import { VersionHistory } from './VersionHistory';
import { downloadBlob } from '../../utils/download';

// Moved to src/utils/download.ts (shared with DocumentActionsBar); re-exported
// here so the page-local imports keep working.
export { downloadBlob } from '../../utils/download';

const iconBtnCls = 'flex min-h-9 min-w-9 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink md:min-h-0 md:min-w-0';

// Long-press duration (ms) and move tolerance (px) before it's treated as a
// scroll/drag instead — mirrors the timer-ref idiom in PdfCanvas.tsx.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

// Row actions column: the version-history toggle is the only affordance left
// here (spec: "ONLY the version-history toggle remains, rendered ONLY when
// row.versionNumber > 1") — everything else moved into RowContextMenu.
const RowActions: React.FC<{ row: DocumentRow; onHistory: () => void }> = ({ row, onHistory }) => {
  if (row.versionNumber <= 1) return null;
  return (
    <div className="flex items-center justify-end">
      <button title="Version history" aria-label="Version history" onClick={onHistory} className={iconBtnCls}>
        <History size={14} />
      </button>
    </div>
  );
};

export const DocumentsTable: React.FC<{
  rows: DocumentRow[];
  customTypes: CustomDocType[];
  selected: Set<string>;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onArchiveRows: (rows: DocumentRow[], archived: boolean) => Promise<void>;
  onDeleteRows: (rows: DocumentRow[]) => Promise<void>;
  onChangeKind: (row: DocumentRow, kind: string) => Promise<void>;
}> = ({ rows, customTypes, selected, onToggleRow, onToggleAll, onArchiveRows, onDeleteRows, onChangeKind }) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const share = useShare();
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<RowContextMenuState | null>(null);
  // Viewer state lives here rather than in DocumentsPage: the row click, the
  // openTargetFor navigation and the archive callback the modal needs are all
  // already in this component.
  const [viewerRow, setViewerRow] = useState<DocumentRow | null>(null);
  const [hover, setHover] = useState<{ row: DocumentRow; x: number; y: number } | null>(null);

  // Hover previews are desktop-only (spec: "never trigger on touch devices").
  // Evaluated once — a pointer type doesn't change mid-session in practice,
  // and this keeps the listeners off the mobile card path entirely.
  const [hoverCapable] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches
  );
  const hideHover = useCallback(() => setHover(null), []);

  const handleOpen = async (row: DocumentRow) => {
    const target = openTargetFor(row);
    if (target.type === 'edit') navigate(target.url!);
    else if (target.type === 'image') window.open(target.url!, '_blank');
    else {
      try { downloadBlob(await fetchFileBlob(row.id), row.name ?? row.id); }
      catch { toast('Download failed', { type: 'error' }); }
    }
  };

  // Row click used to call handleOpen directly; it now opens the viewer modal
  // and handleOpen survives as the modal's (and the context menu's) "Open in
  // editor". Hiding the card here is belt-and-braces — DocumentHoverPreview
  // also hides itself on any window click — so the card can't outlive the row
  // it describes once the modal is up.
  const handleRowClick = (row: DocumentRow) => {
    setHover(null);
    setViewerRow(row);
  };

  const handleDownload = async (row: DocumentRow) => {
    try { downloadBlob(await fetchFileBlob(row.id), row.name ?? row.id); }
    catch { toast('Download failed', { type: 'error' }); }
  };

  const handleDelete = async (row: DocumentRow) => {
    const ok = await confirm({
      title: 'Delete document',
      message: `Delete "${row.name ?? row.id}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    onDeleteRows([row]);
  };

  // Share any document (ONLYOFFICE Phase 7): the share window lists the
  // links already working for it and makes new ones with an expiry.
  const handleShare = (row: DocumentRow) => {
    const name = row.name ?? 'Document';
    share({ title: `Share ${name}`, target: { type: 'file', resourceId: row.id }, name });
  };

  const handleHistory = (row: DocumentRow) => {
    setHistoryFor(historyFor === row.id ? null : row.id);
  };

  // ── Long-press → context menu (touch/mobile cards). A timer armed on
  // touchstart opens the menu at the touch point if the finger hasn't moved
  // or lifted by LONG_PRESS_MS; any move past the tolerance (scroll/drag) or
  // an early lift cancels it. Mirrors PdfCanvas.tsx's longPressTimerRef idiom.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  useEffect(() => () => cancelLongPress(), []);

  const handleTouchStart = (row: DocumentRow) => (e: React.TouchEvent) => {
    if (e.touches.length !== 1) { cancelLongPress(); return; }
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    longPressFiredRef.current = false;
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      longPressTimerRef.current = null;
      setContextMenu({ x: touch.clientX, y: touch.clientY, row });
    }, LONG_PRESS_MS);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    const touch = e.touches[0];
    if (!start || !touch) return;
    if (
      Math.abs(touch.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE
      || Math.abs(touch.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
    ) cancelLongPress();
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    cancelLongPress();
    // A long-press already opened the menu — suppress the synthetic click
    // that would otherwise follow and open the file (mirrors PdfCanvas's
    // onTap longPressFiredRef check).
    if (longPressFiredRef.current) {
      e.preventDefault();
      longPressFiredRef.current = false;
    }
  };

  // `block truncate` + title: inside the fixed-layout desktop table the
  // Source column has a set width, so a long subject line (mail-sourced rows
  // carry the email's subject as the label) ellipsizes instead of widening
  // the column. In the mobile cards the enclosing div is min-w-0 already.
  const SourceCell: React.FC<{ row: DocumentRow }> = ({ row }) => {
    if (!row.source) return <span className="text-ink-faint">—</span>;
    if (row.source.href) {
      return (
        <Link
          to={row.source.href}
          onClick={e => e.stopPropagation()}
          title={row.source.label}
          className="block truncate text-accent-600 hover:underline dark:text-accent-400"
        >
          {row.source.label}
        </Link>
      );
    }
    return <span className="block truncate" title={row.source.label}>{row.source.label}</span>;
  };

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));

  return (
    <>
      {/* Fixed table layout: every column but Name has an explicit width, so
          Name gets whatever is left and its `truncate` actually bites. With
          automatic layout a long unbreakable file name made the Name column
          as wide as the name, the table overflowed its wrapper and only the
          first two columns stayed on screen. The fixed widths are trimmed at
          md (a 768px tablet next to the 208px sidebar leaves <500px) and the
          Source column only appears from lg and the Date column from xl —
          below those the date rides in the Name cell's subline, and a
          sourced row still reaches its record through the row menu. */}
      <div className="hidden md:block">
        <Table className="table-fixed">
          <THead>
            <TR>
              <TH className="w-10">
                <input
                  type="checkbox"
                  className="size-4 rounded border-edge-strong accent-accent-600"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label="Select all documents"
                />
              </TH>
              <TH>Name</TH>
              <TH className="w-24 lg:w-28">Type</TH>
              <TH className="w-24 lg:w-36">Project</TH>
              <TH className="hidden w-40 lg:table-cell">Source</TH>
              <TH className="hidden w-28 xl:table-cell">Date</TH>
              <TH className="w-20 text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map(row => (
              <React.Fragment key={row.id}>
                <TR
                  data-testid="documents-row"
                  interactive
                  onClick={() => handleRowClick(row)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setHover(null);
                    setContextMenu({ x: e.clientX, y: e.clientY, row });
                  }}
                  // Desktop rows only — the mobile card list below gets no
                  // hover handlers at all.
                  {...(hoverCapable ? {
                    onMouseEnter: (e: React.MouseEvent) => setHover({ row, x: e.clientX, y: e.clientY }),
                    onMouseLeave: () => setHover(null),
                  } : {})}
                >
                  <TD className="w-10" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      data-testid="doc-row-select"
                      className="size-4 rounded border-edge-strong accent-accent-600"
                      checked={selected.has(row.id)}
                      onChange={() => onToggleRow(row.id)}
                      aria-label={`Select ${row.name ?? row.id}`}
                    />
                  </TD>
                  <TD className="font-medium text-ink">
                    {/* Page one (ONLYOFFICE Phase 4) or the type icon, beside both lines. */}
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex w-6 shrink-0 justify-center"><FileThumb row={row} box="h-8 w-6" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate" title={row.name ?? row.id}>{row.name ?? row.id}</span>
                          <FileViewerDots fileId={row.id} />
                        </div>
                        <div className="truncate text-xs font-normal text-ink-faint">
                          {formatBytes(row.size)}{row.versionNumber > 1 ? ` · v${row.versionNumber}` : ''}
                          <span className="xl:hidden"> · {new Date(row.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                  </TD>
                  <TD className="overflow-hidden"><StatusPill tone={kindTone(row.kind)}>{kindLabel(row.kind, customTypes)}</StatusPill></TD>
                  <TD className="text-ink-soft">
                    <span className="block truncate" title={row.projectName ?? undefined}>{row.projectName ?? '—'}</span>
                  </TD>
                  <TD className="hidden lg:table-cell"><SourceCell row={row} /></TD>
                  <TD className="hidden text-ink-soft xl:table-cell">{new Date(row.createdAt).toLocaleDateString()}</TD>
                  <TD className="text-right" onClick={e => e.stopPropagation()}>
                    <RowActions row={row} onHistory={() => handleHistory(row)} />
                  </TD>
                </TR>
                {historyFor === row.id && (
                  <TR>
                    <TD colSpan={7} className="bg-sunken/50">
                      <VersionHistory fileId={row.id} fileName={row.name} />
                    </TD>
                  </TR>
                )}
              </React.Fragment>
            ))}
          </TBody>
        </Table>
      </div>

      {/* Mobile document cards — same data + handlers as the table. */}
      <ul className="space-y-3 md:hidden">
        {rows.map(row => (
          <li
            key={row.id}
            data-testid="documents-row"
            className="rounded-xl border border-edge bg-raised p-3"
            onContextMenu={e => e.preventDefault()}
            onTouchStart={handleTouchStart(row)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                data-testid="doc-row-select"
                className="mt-0.5 size-4 shrink-0 rounded border-edge-strong accent-accent-600"
                checked={selected.has(row.id)}
                onChange={() => onToggleRow(row.id)}
                aria-label={`Select ${row.name ?? row.id}`}
              />
              <button type="button" onClick={() => handleRowClick(row)} className="block min-w-0 flex-1 text-left">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
                    <FileThumb row={row} box="h-10 w-8" />
                    <span className="truncate break-words">{row.name ?? row.id}</span>
                    <FileViewerDots fileId={row.id} />
                  </span>
                  <StatusPill tone={kindTone(row.kind)}>{kindLabel(row.kind, customTypes)}</StatusPill>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-soft">
                  <span>{formatBytes(row.size)}</span>
                  {row.versionNumber > 1 && <span>v{row.versionNumber}</span>}
                  <span>{new Date(row.createdAt).toLocaleDateString()}</span>
                  {row.projectName && <span>{row.projectName}</span>}
                </div>
                {row.source && (
                  <div className="mt-1 text-xs" onClick={e => e.stopPropagation()}>
                    <SourceCell row={row} />
                  </div>
                )}
              </button>
            </div>
            {row.versionNumber > 1 && (
              <div className="mt-2 flex items-center justify-end border-t border-edge pt-2">
                <RowActions row={row} onHistory={() => handleHistory(row)} />
              </div>
            )}
            {historyFor === row.id && (
              <div className="mt-2 rounded-lg bg-sunken/50 p-2">
                <VersionHistory fileId={row.id} fileName={row.name} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* One card at a time, and never while the modal or the context menu
          owns the pointer. Moving between rows swaps this instance's `row`
          prop rather than unmounting it (leave+enter land in one React batch)
          — which is exactly why the card carries a generation guard. */}
      {hoverCapable && hover && !viewerRow && !contextMenu && (
        <DocumentHoverPreview
          row={hover.row}
          startX={hover.x}
          startY={hover.y}
          customTypes={customTypes}
          onHide={hideHover}
        />
      )}

      {viewerRow && (
        <DocumentViewerModal
          row={viewerRow}
          customTypes={customTypes}
          onClose={() => setViewerRow(null)}
          onOpenInEditor={handleOpen}
          onDownload={handleDownload}
          onArchive={(row, archived) => onArchiveRows([row], archived)}
          onShare={handleShare}
        />
      )}

      {contextMenu && (
        <RowContextMenu
          state={contextMenu}
          customTypes={customTypes}
          onClose={() => setContextMenu(null)}
          onOpen={handleOpen}
          onDownload={handleDownload}
          onArchive={(row, archived) => onArchiveRows([row], archived)}
          onChangeKind={(row, kind) => onChangeKind(row, kind)}
          onDelete={handleDelete}
          onShare={handleShare}
        />
      )}
    </>
  );
};
