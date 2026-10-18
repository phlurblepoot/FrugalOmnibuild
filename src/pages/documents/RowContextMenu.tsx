// src/pages/documents/RowContextMenu.tsx
// Fixed-position, viewport-clamped context menu for a single Documents row —
// replaces the per-row action buttons formerly in DocumentsTable's RowActions
// (spec docs/superpowers/specs/2026-08-17-documents-context-menu-design.md).
// Opened by right-click (desktop) or a ~500ms long-press (mobile cards); acts
// only on the row it was opened for. Items are policy-gated via
// documentsPolicy.ts's selectionPolicy — same source the old buttons used —
// and simply absent (not disabled) when the row doesn't qualify.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, Download, ExternalLink, Link as LinkIcon, Tag, Trash2,
} from 'lucide-react';
import { DocumentRow } from '../../utils/store';
import { CustomDocType, retypeOptions } from './docTypes';
import { selectionPolicy } from './documentsPolicy';
import { clampToViewport } from './previewPosition';

export interface RowContextMenuState {
  x: number;
  y: number;
  row: DocumentRow;
}

const itemCls = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover';

export const RowContextMenu: React.FC<{
  state: RowContextMenuState;
  customTypes: CustomDocType[];
  onClose: () => void;
  onOpen: (row: DocumentRow) => void;
  onDownload: (row: DocumentRow) => void;
  onArchive: (row: DocumentRow, archived: boolean) => void;
  onChangeKind: (row: DocumentRow, kind: string) => void;
  onDelete: (row: DocumentRow) => void;
  onShare: (row: DocumentRow) => void;
}> = ({ state, customTypes, onClose, onOpen, onDownload, onArchive, onChangeKind, onDelete, onShare }) => {
  const { row } = state;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });
  const [changeTypeOpen, setChangeTypeOpen] = useState(false);

  const { archivable, deletable, retypeable } = selectionPolicy([row]);
  const archivableRow = archivable.length > 0;
  const deletableRow = deletable.length > 0;
  const directUpload = retypeable.length > 0;

  // Clamp to the viewport once the menu's real size is known — re-measured
  // whenever the nested change-type list opens/closes since that changes the
  // menu's height. Runs before paint (useLayoutEffect) so there's no flash at
  // the unclamped position. The clamp itself is shared with the hover preview
  // card (previewPosition.ts).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampToViewport(
      state.x,
      state.y,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [state.x, state.y, changeTypeOpen]);

  // Outside-click/Escape/scroll all close the menu. The menu's own root stops
  // mousedown propagation (below), so this window listener only ever sees
  // genuinely outside clicks — no contains() check needed.
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  const typeOptions = retypeOptions(customTypes);

  return (
    <div
      ref={ref}
      data-testid="doc-context-menu"
      role="menu"
      aria-label={`Actions for ${row.name ?? row.id}`}
      className="fixed z-50 w-52 rounded-lg border border-edge bg-raised py-1 shadow-lg"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
    >
      <button role="menuitem" className={itemCls} onClick={() => { onClose(); onOpen(row); }}>
        <ExternalLink size={14} /> Open in editor
      </button>
      <button role="menuitem" className={itemCls} onClick={() => { onClose(); onDownload(row); }}>
        <Download size={14} /> Download
      </button>
      {archivableRow && (
        row.archived ? (
          <button role="menuitem" className={itemCls} onClick={() => { onClose(); onArchive(row, false); }}>
            <ArchiveRestore size={14} /> Restore
          </button>
        ) : (
          <button
            role="menuitem"
            title={row.source ? 'Managed by its source — archive here' : undefined}
            className={itemCls}
            onClick={() => { onClose(); onArchive(row, true); }}
          >
            <Archive size={14} /> Archive
          </button>
        )
      )}
      {directUpload && (
        <div className="relative">
          <button
            role="menuitem"
            data-testid="doc-context-change-type"
            aria-expanded={changeTypeOpen}
            className={itemCls}
            onClick={() => setChangeTypeOpen(o => !o)}
          >
            <Tag size={14} /> Change type
          </button>
          {changeTypeOpen && (
            <div className="max-h-64 overflow-y-auto border-t border-edge py-1">
              {typeOptions.map(o => (
                <button
                  key={o.id}
                  role="menuitem"
                  onClick={() => { onClose(); if (o.id !== row.kind) onChangeKind(row, o.id); }}
                  className={`block w-full truncate py-1.5 pl-8 pr-3 text-left text-sm hover:bg-hover ${
                    o.id === row.kind ? 'font-semibold text-accent-600 dark:text-accent-400' : 'text-ink'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Any document can be shared (ONLYOFFICE Phase 7); the server refuses
          what this person can't see. */}
      <button role="menuitem" className={itemCls} onClick={() => { onClose(); onShare(row); }}>
        <LinkIcon size={14} /> Share…
      </button>
      {deletableRow && (
        <button
          role="menuitem"
          className={`${itemCls} text-red-600 dark:text-red-400`}
          onClick={() => { onClose(); onDelete(row); }}
        >
          <Trash2 size={14} /> Delete
        </button>
      )}
    </div>
  );
};
