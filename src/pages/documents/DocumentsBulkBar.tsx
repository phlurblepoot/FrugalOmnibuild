// src/pages/documents/DocumentsBulkBar.tsx
// Dark bulk-action bar shown once at least one row is selected (mockup: N
// selected · Download · Archive/Restore · Change type (N of M) · Delete (N of
// M) · clear). Purely presentational — DocumentsPage owns the actual
// mutations (patchFile/deleteFile calls + refresh); this component only
// decides what's enabled via selectionPolicy and confirms before delete.
import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Download, FilePlus2, Merge, Share2, Tag, Trash2, X } from 'lucide-react';
import { DocumentRow } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { CustomDocType, retypeOptions } from './docTypes';
import { selectionPolicy } from './documentsPolicy';

type Busy = 'download' | 'merge' | 'archive' | 'retype' | 'delete' | null;

export const DocumentsBulkBar: React.FC<{
  selected: DocumentRow[];
  customTypes: CustomDocType[];
  archivedView: boolean;
  onClear: () => void;
  onDownload: (rows: DocumentRow[]) => Promise<void>;
  onArchive: (rows: DocumentRow[], archived: boolean) => Promise<void>;
  // Only ever handed the re-typeable subset (selectionPolicy.retypeable) —
  // a row locked to a system kind is never sent.
  onChangeKind: (rows: DocumentRow[], kind: string) => Promise<void>;
  onDelete: (rows: DocumentRow[]) => Promise<void>;
  /** One public link to all of them (ONLYOFFICE Phase 7). */
  onShare?: (rows: DocumentRow[]) => void;
  /** Joins the selected PDFs (in list order) into one new document. */
  onMergePdfs?: (rows: DocumentRow[]) => Promise<void>;
  /** With exactly one PDF selected: opens Append pages for it. */
  onAppendPages?: (row: DocumentRow) => void;
}> = ({ selected, customTypes, archivedView, onClear, onDownload, onArchive, onChangeKind, onDelete, onShare, onMergePdfs, onAppendPages }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<Busy>(null);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement>(null);

  // Outside-click / Escape close the type popover. Same idiom as
  // MultiSelectDropdown's mousedown-outside listener.
  useEffect(() => {
    if (!typeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (typeMenuRef.current && !typeMenuRef.current.contains(e.target as Node)) setTypeMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTypeMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [typeMenuOpen]);

  if (selected.length === 0) return null;

  const { downloadable, archivable, deletable, retypeable } = selectionPolicy(selected);
  const typeOptions = retypeOptions(customTypes);
  const pdfs = selected.filter(r => r.mime === 'application/pdf');

  const handleMerge = async () => {
    if (!onMergePdfs) return;
    setBusy('merge');
    try { await onMergePdfs(pdfs); }
    catch { toast('Failed to merge PDFs', { type: 'error' }); }
    finally { setBusy(null); }
  };

  const handleChangeKind = async (kind: string) => {
    setTypeMenuOpen(false);
    setBusy('retype');
    try { await onChangeKind(retypeable, kind); }
    catch { toast('Failed to change type', { type: 'error' }); }
    finally { setBusy(null); }
  };

  const handleDownload = async () => {
    setBusy('download');
    try { await onDownload(downloadable); }
    catch { toast('Some downloads failed', { type: 'error' }); }
    finally { setBusy(null); }
  };

  const handleArchive = async () => {
    setBusy('archive');
    try { await onArchive(archivable, !archivedView); }
    catch { toast(archivedView ? 'Failed to restore' : 'Failed to archive', { type: 'error' }); }
    finally { setBusy(null); }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete documents',
      message: `Delete ${deletable.length} document${deletable.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('delete');
    try { await onDelete(deletable); }
    catch { toast('Failed to delete', { type: 'error' }); }
    finally { setBusy(null); }
  };

  return (
    <div
      data-testid="documents-bulkbar"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg dark:bg-slate-950"
    >
      <button
        onClick={onClear}
        aria-label="Clear selection"
        className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X size={16} />
      </button>
      <span className="font-medium">{selected.length} selected</span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <button
          onClick={handleDownload}
          disabled={busy !== null || downloadable.length === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download size={14} />{busy === 'download' ? 'Downloading…' : 'Download'}
        </button>
        {onShare && (
          <button
            data-testid="documents-bulk-share"
            onClick={() => onShare(selected)}
            disabled={busy !== null || selected.length > 50}
            title={selected.length > 50 ? 'Share up to 50 documents in one link' : 'One link to all of them'}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Share2 size={14} />Share
          </button>
        )}
        {onMergePdfs && (
          <button
            data-testid="documents-bulk-merge"
            onClick={handleMerge}
            disabled={busy !== null || pdfs.length < 2 || pdfs.length > 50}
            title={pdfs.length < 2 ? 'Select two or more PDFs' : 'Join the selected PDFs into one new document'}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Merge size={14} />{busy === 'merge' ? 'Merging…' : `Merge PDFs (${pdfs.length})`}
          </button>
        )}
        {onAppendPages && (
          <button
            data-testid="documents-bulk-append"
            onClick={() => onAppendPages(pdfs[0])}
            disabled={busy !== null || selected.length !== 1 || pdfs.length !== 1}
            title={selected.length === 1 && pdfs.length === 1 ? 'Add pages from other PDFs into this one' : 'Select one PDF'}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FilePlus2 size={14} />Append pages
          </button>
        )}
        <button
          onClick={handleArchive}
          disabled={busy !== null || archivable.length === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {archivedView ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {busy === 'archive' ? (archivedView ? 'Restoring…' : 'Archiving…') : (archivedView ? 'Restore' : 'Archive')}
        </button>
        <div ref={typeMenuRef} className="relative">
          <button
            data-testid="documents-bulk-change-type"
            aria-haspopup="menu"
            aria-expanded={typeMenuOpen}
            onClick={() => setTypeMenuOpen(o => !o)}
            disabled={busy !== null || retypeable.length === 0}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Tag size={14} />
            {busy === 'retype' ? 'Changing type…' : `Change type (${retypeable.length} of ${selected.length})`}
          </button>
          {typeMenuOpen && retypeable.length > 0 && (
            <div
              role="menu"
              aria-label="Change type"
              className="absolute right-0 top-full z-50 mt-1 max-h-64 w-52 overflow-y-auto rounded-lg border border-edge bg-raised py-1 text-ink shadow-lg"
            >
              {typeOptions.map(o => (
                <button
                  key={o.id}
                  role="menuitem"
                  onClick={() => handleChangeKind(o.id)}
                  className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-hover"
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={handleDelete}
          disabled={busy !== null || deletable.length === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 size={14} />{busy === 'delete' ? 'Deleting…' : `Delete (${deletable.length} of ${selected.length})`}
        </button>
      </div>
    </div>
  );
};
