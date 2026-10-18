// src/components/FilePickerModal.tsx — pick files already on the server, or
// upload new ones without leaving the dialog.
// Reuses the Documents page's filter bar + row presentation
// (spec docs/superpowers/specs/2026-08-28-proposal-rework-design.md §5).
//
// Two things worth knowing before changing this:
//  - The Upload tab only exists when the caller passes an `upload` config,
//    because only the caller knows where a new file belongs (kind + project /
//    customer + source triple). No config, no tabs at all.
//  - `returnBlobs` exists for the callers that need bytes rather than rows
//    (mail composer attachments, the SOV importer, plan-set upload). Picking
//    from the Existing tab then fetches each file's content first; an upload
//    hands back the File the user just chose, which is the same bytes without
//    the round trip.
//  - `onPickFiles` is for a record that doesn't exist yet (a payment being
//    recorded): the Upload tab hands back the chosen files UNSTORED, and the
//    caller stores them once there is something to file them under.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Upload as UploadIcon } from 'lucide-react';
import { Customer } from '../types';
import {
  DocumentRow, ProjectFile, ProjectSummary, fetchFileBlob, getCustomers, getDocumentTypes,
  getDocuments, getFileMeta, getProjectsSummary, saveBinaryFile, uploadProjectFile,
} from '../utils/store';
import { useDropZone } from '../hooks/useDropZone';
import { useToast } from './Toast';
import { Button, Modal, Skeleton, StatusPill } from './ui';
import { DocumentsFilterBar } from '../pages/documents/DocumentsFilterBar';
import { DocumentHoverPreview } from '../pages/documents/DocumentHoverPreview';
import { MimeIcon } from '../pages/documents/MimeIcon';
import { CustomDocType, KIND_OPTIONS, kindLabel, kindTone } from '../pages/documents/docTypes';
import { MultiSelectOption } from '../pages/documents/MultiSelectDropdown';
import { OFFICE_FORMATS } from '../utils/officeFormats';
import { reportConversions } from '../utils/uploadConversion';

const PAGE_SIZE = 100;
const MIMES: Record<NonNullable<FilePickerModalProps['accept']>, string[] | undefined> = {
  pdf: ['application/pdf'],
  image: ['image/'],
  'image-pdf': ['image/', 'application/pdf'],
  spreadsheet: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
  ],
  office: OFFICE_FORMATS.map(f => f.mime),
  any: undefined,
};
// Default `accept` attribute for the file input when the upload config
// doesn't override it — keeps the OS file dialog in step with what the
// dropzone would accept.
const INPUT_ACCEPT: Record<NonNullable<FilePickerModalProps['accept']>, string | undefined> = {
  pdf: 'application/pdf,.pdf',
  image: 'image/*',
  'image-pdf': 'image/*,application/pdf,.pdf',
  spreadsheet: '.xlsx,.xls,.csv',
  office: OFFICE_FORMATS.map(f => `.${f.ext}`).join(','),
  any: undefined,
};
const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export interface FilePickerUploadConfig {
  kind: string;
  projectId?: string;
  customerId?: string;
  sourceType?: string;
  sourceId?: string;
  /** Overrides the input's `accept` attribute (defaults from the modal's accept). */
  accept?: string;
  /** Overrides the modal's `multi` for the upload input only. */
  multi?: boolean;
  /** Passed through to the input so a phone can open the camera directly. */
  capture?: 'user' | 'environment';
}

export type FilePickerTab = 'existing' | 'upload';

export interface FilePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional because a `returnBlobs` caller uses onPickBlobs instead. */
  onPick?: (rows: DocumentRow[]) => void | Promise<void>;
  accept?: 'pdf' | 'image' | 'image-pdf' | 'spreadsheet' | 'office' | 'any';
  multi?: boolean;
  excludeFileIds?: string[];
  initialProjectIds?: string[];
  title?: string;
  /** Presence of this enables the Upload tab. */
  upload?: FilePickerUploadConfig;
  defaultTab?: FilePickerTab;
  /** When true, onPickBlobs is called with the bytes instead of onPick. */
  returnBlobs?: boolean;
  onPickBlobs?: (picked: { row: DocumentRow; blob: Blob }[]) => void | Promise<void>;
  /** Upload tab only: hand the chosen files back without storing them (the
   *  `upload` config then only decides the tab's accept/multi/capture). For a
   *  record that doesn't exist yet; the Existing tab still uses onPick. */
  onPickFiles?: (files: File[]) => void | Promise<void>;
}

type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';
const STATUS_WORD: Record<UploadStatus, string> = {
  pending: 'Waiting', uploading: 'Uploading…', done: 'Uploaded', error: 'Failed',
};

// The server is the source of truth for a stored file, but a picker row needs
// fields (/documents joins) that /files/:id/meta doesn't carry — those are
// filled from what the caller already told us, or left null.
const rowFromUpload = (
  fileId: string, meta: ProjectFile | null, file: File, cfg: FilePickerUploadConfig,
): DocumentRow => ({
  id: fileId,
  name: meta?.name ?? file.name,
  mime: meta?.mime ?? file.type ?? 'application/octet-stream',
  size: meta?.size ?? file.size,
  kind: meta?.kind ?? cfg.kind,
  createdAt: meta?.createdAt ?? Date.now(),
  versionNumber: meta?.versionNumber ?? 1,
  archived: false,
  projectId: meta?.projectId ?? cfg.projectId ?? null,
  projectName: null,
  customerId: cfg.customerId ?? null,
  customerName: null,
  source: null,
});

export const FilePickerModal: React.FC<FilePickerModalProps> = ({
  open, onClose, onPick, accept = 'any', multi = true, excludeFileIds = [], initialProjectIds = [],
  title = 'Choose files', upload, defaultTab = 'existing', returnBlobs = false, onPickBlobs, onPickFiles,
}) => {
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>(initialProjectIds);
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Map<string, DocumentRow>>(new Map());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);
  const [hover, setHover] = useState<{ row: DocumentRow; x: number; y: number } | null>(null);
  const [hoverCapable] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches);
  const [picking, setPicking] = useState(false);
  const [tab, setTab] = useState<FilePickerTab>(upload ? defaultTab : 'existing');
  const [progress, setProgress] = useState<{ name: string; status: UploadStatus }[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Map());
    setProjectIds(initialProjectIds);
    setTab(upload ? defaultTab : 'existing');
    setProgress([]);
    setUploading(false);
    getProjectsSummary().then(setProjects).catch(() => setProjects([]));
    getCustomers().then(setCustomers).catch(() => setCustomers([]));
    getDocumentTypes().then(setCustomTypes).catch(() => setCustomTypes([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bumped on every filter-driven fetch so an out-of-order response (two
  // rapid filter changes, or a filter change that lands while a page-one
  // fetch is still in flight) can tell it's stale and drop itself instead of
  // clobbering newer rows/total — mirrors DocumentsPage.tsx's requestIdRef
  // guard. mountedRef must be reset true on every (re)mount, not just seeded
  // via useRef(true): React 18 StrictMode double-invokes effects in dev
  // (mount -> cleanup -> mount) on the SAME ref, so a cleanup-only effect
  // would leave it stuck false after the simulated unmount.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // `tab` is part of the key so a picker that opens straight onto Upload
  // (defaultTab='upload') doesn't fire a documents query nobody asked for —
  // and so switching back to Existing after an upload re-queries, which is
  // what makes the file just added show up in the list.
  const filterKey = `${open}|${tab}|${q}|${projectIds.join(',')}|${customerIds.join(',')}|${kinds.join(',')}|${archived}|${accept}`;

  const refresh = async () => {
    const myId = ++requestIdRef.current;
    setLoading(true);
    try {
      const res = await getDocuments({ q: q || undefined, projectIds, customerIds, kinds, archived, mimes: MIMES[accept], limit: PAGE_SIZE, offset: 0 });
      if (!mountedRef.current || myId !== requestIdRef.current) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch {
      if (mountedRef.current && myId === requestIdRef.current) { setRows([]); setTotal(0); }
    } finally {
      if (mountedRef.current && myId === requestIdRef.current) setLoading(false);
    }
  };
  useEffect(() => { if (open && tab === 'existing') refresh(); }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Captures the CURRENT requestId (doesn't bump it) — if a filter change
  // bumps requestIdRef while this page is in flight, its rows belong to a
  // query that's no longer showing, so they're dropped rather than appended.
  // Guarded against re-entry (loading/loadingMore) separately, so a
  // double-click on "Load more" can't fetch — and duplicate-append — the
  // same offset twice.
  const loadMore = async () => {
    if (loading || loadingMore) return;
    const myId = requestIdRef.current;
    setLoadingMore(true);
    try {
      const res = await getDocuments({ q: q || undefined, projectIds, customerIds, kinds, archived, mimes: MIMES[accept], limit: PAGE_SIZE, offset: rows.length });
      if (!mountedRef.current || myId !== requestIdRef.current) return;
      setRows(prev => [...prev, ...res.rows]);
      setTotal(res.total);
    } catch {
      // best-effort — leave the already-loaded rows in place on failure
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  };

  const excluded = useMemo(() => new Set(excludeFileIds), [excludeFileIds]);
  const visible = rows.filter(r => !excluded.has(r.id));
  const projectOptions: MultiSelectOption[] = projects.map(p => ({ id: p.id, label: p.name }));
  const customerOptions: MultiSelectOption[] = customers.map(c => ({ id: c.id, label: c.name }));
  const kindOptions: MultiSelectOption[] = [...KIND_OPTIONS, ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label }))];

  // Stable identity (like DocumentsTable's hideHover): an inline arrow makes
  // DocumentHoverPreview tear down and re-register its window listeners on
  // every render, including the render its own mousemove handler causes.
  const hideHover = useCallback(() => setHover(null), []);

  const toggle = (row: DocumentRow) => setSelected(prev => {
    const next = multi ? new Map(prev) : new Map<string, DocumentRow>();
    if (prev.has(row.id) && multi) next.delete(row.id); else next.set(row.id, row);
    return next;
  });

  const confirm = async () => {
    setPicking(true);
    try {
      const picked = [...selected.values()];
      if (returnBlobs) {
        const withBlobs: { row: DocumentRow; blob: Blob }[] = [];
        for (const row of picked) withBlobs.push({ row, blob: await fetchFileBlob(row.id) });
        await onPickBlobs?.(withBlobs);
      } else {
        await onPick?.(picked);
      }
      onClose();
    } catch {
      // Leave the dialog open on a failed read/hand-off so the selection
      // isn't silently lost.
      toast('Could not add those files', { type: 'error' });
    } finally {
      setPicking(false);
    }
  };

  // Files chosen on the Upload tab are stored immediately — there's no second
  // confirm step, because the dialog's whole job is "give me these files".
  const runUpload = async (chosen: File[]) => {
    if (!upload || !chosen.length || uploading) return;
    // The single-file cap lives here rather than in useDropZone because this
    // is the one choke point every path funnels through: `multiple` on the
    // input only constrains the OS dialog, and a drag-drop bypasses it
    // entirely (useDropZone filters by type, never by count).
    const singleOnly = (upload.multi ?? multi) === false;
    if (singleOnly && chosen.length > 1) toast('Only one file can be added here', { type: 'warning' });
    const files = singleOnly ? chosen.slice(0, 1) : chosen;

    // Staged, not stored: the caller files them itself once its record exists.
    if (onPickFiles) {
      await onPickFiles(files);
      onClose();
      return;
    }

    setUploading(true);
    setProgress(files.map(f => ({ name: f.name, status: 'pending' as UploadStatus })));
    const mark = (i: number, status: UploadStatus) => {
      if (mountedRef.current) setProgress(prev => prev.map((p, j) => (j === i ? { ...p, status } : p)));
    };

    const done: { row: DocumentRow; blob: Blob }[] = [];
    const conversions: Parameters<typeof reportConversions>[1] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      mark(i, 'uploading');
      try {
        const res = upload.projectId
          ? await uploadProjectFile(upload.projectId, file, upload.kind, { sourceType: upload.sourceType, sourceId: upload.sourceId })
          : await saveBinaryFile(uuidv4(), file, {
              kind: upload.kind, name: file.name, customerId: upload.customerId,
              sourceType: upload.sourceType, sourceId: upload.sourceId,
            });
        // Best-effort enrichment: a meta read that fails still leaves a usable
        // row built from the File itself, so one flaky GET can't lose an
        // upload that actually succeeded.
        const meta = await getFileMeta(res.fileId).catch(() => null);
        done.push({ row: rowFromUpload(res.fileId, meta, file, upload), blob: file });
        conversions.push({ name: file.name, conversion: res.conversion });
        mark(i, 'done');
      } catch {
        mark(i, 'error');
      }
    }
    // Unmounted mid-flight (the owner tore the dialog down — a route change,
    // a card that went away): stop here rather than setting state on a dead
    // tree. Anything that did upload is stored server-side under the same
    // source triple, so it still surfaces on the record and on /documents —
    // whereas calling back into an owner that may itself be gone can't be
    // made safe from in here.
    if (!mountedRef.current) return;
    setUploading(false);

    if (done.length < files.length) {
      toast(`Uploaded ${done.length} of ${files.length} files`, { type: done.length ? 'warning' : 'error' });
    }
    reportConversions(toast, conversions);
    // Every upload failed: stay open on the failure list rather than handing
    // the caller an empty batch and closing.
    if (!done.length) return;
    if (returnBlobs) await onPickBlobs?.(done);
    else await onPick?.(done.map(d => d.row));
    onClose();
  };

  const { dragActive, dropProps } = useDropZone(
    files => { void runUpload(files); },
    { accept, disabled: !upload || uploading },
  );

  const uploadTab = tab === 'upload' && !!upload;

  // Modal fires onClose from Escape, the backdrop AND the X without asking.
  // Honouring that mid-upload would strand a file that is already on the
  // server but was never reported to the caller — the same reason Cancel is
  // disabled while uploading.
  const requestClose = useCallback(() => { if (!uploading) onClose(); }, [uploading, onClose]);

  return (
    <Modal open={open} onClose={requestClose} title={title} width="xl"
      footer={uploadTab ? (
        <Button variant="secondary" onClick={requestClose} disabled={uploading}>Cancel</Button>
      ) : (<>
        {/* requestClose, not onClose: the tabs stay live during an upload, so
            Cancel on the Existing tab is another way to strand one. */}
        <Button variant="secondary" onClick={requestClose}>Cancel</Button>
        <Button onClick={confirm} disabled={selected.size === 0 || picking}>Add {selected.size} file{selected.size === 1 ? '' : 's'}</Button>
      </>)}>
      {upload && (
        <div role="tablist" aria-label="File source" className="mb-3 inline-flex gap-1 rounded-lg border border-edge bg-sunken p-1">
          {(['existing', 'upload'] as const).map(t => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t ? 'bg-raised text-ink shadow-sm' : 'text-ink-faint hover:text-ink'
              }`}
            >
              {t === 'existing' ? 'Existing' : 'Upload'}
            </button>
          ))}
        </div>
      )}

      {uploadTab ? (
        <div data-testid="picker-upload-panel" className="space-y-3">
          <div
            data-testid="picker-dropzone"
            {...dropProps}
            onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
            className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
              dragActive ? 'border-accent-500 bg-accent-500/5' : 'border-edge'
            } ${uploading ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <input
              ref={fileInputRef}
              data-testid="picker-upload-input"
              type="file"
              className="hidden"
              accept={upload!.accept ?? INPUT_ACCEPT[accept]}
              multiple={upload!.multi ?? multi}
              capture={upload!.capture}
              disabled={uploading}
              onChange={e => {
                const files = Array.from(e.target.files ?? []);
                // Reset first: picking the same file twice in a row fires no
                // change event otherwise.
                e.target.value = '';
                void runUpload(files);
              }}
            />
            <UploadIcon size={22} className="mx-auto mb-2 text-ink-faint" />
            <p className="text-sm text-ink">Drag files here or click to browse</p>
          </div>

          {progress.length > 0 && (
            <ul className="divide-y divide-edge rounded-lg border border-edge" data-testid="picker-upload-progress">
              {progress.map((p, i) => (
                <li key={`${p.name}-${i}`} className="flex items-center gap-3 px-3 py-2">
                  <p className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</p>
                  <span className={`text-xs ${p.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-ink-faint'}`}>
                    {STATUS_WORD[p.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (<>
        <DocumentsFilterBar
          q={q} onQChange={setQ}
          projectOptions={projectOptions} projectIds={projectIds} onProjectIdsChange={setProjectIds}
          customerOptions={customerOptions} customerIds={customerIds} onCustomerIdsChange={setCustomerIds}
          kindOptions={kindOptions} kinds={kinds} onKindsChange={setKinds}
          archived={archived} onArchivedChange={setArchived}
          isAdmin={false} unassigned={false} onUnassignedChange={() => {}}
        />
        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-edge">
          {loading && rows.length === 0 ? (
            <div className="space-y-2 p-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
          ) : visible.length === 0 ? (
            <p className="p-4 text-sm text-ink-faint">No files match.</p>
          ) : (
            <ul className="divide-y divide-edge">
              {visible.map(row => (
                <li key={row.id} className="flex items-center gap-3 px-3 py-2 hover:bg-hover"
                    onMouseEnter={hoverCapable ? (e) => setHover({ row, x: e.clientX, y: e.clientY }) : undefined}
                    onMouseLeave={hoverCapable ? () => setHover(null) : undefined}>
                  <input type="checkbox" aria-label={row.name ?? row.id} checked={selected.has(row.id)} onChange={() => toggle(row)} className="h-4 w-4 accent-accent-600" />
                  <MimeIcon mime={row.mime} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{row.name ?? row.id}</p>
                    <p className="truncate text-xs text-ink-faint">{row.projectName ?? row.customerName ?? '—'} · {new Date(row.createdAt).toLocaleDateString()} · {fmtSize(row.size)}</p>
                  </div>
                  <StatusPill tone={kindTone(row.kind)}>{kindLabel(row.kind, customTypes)}</StatusPill>
                </li>
              ))}
            </ul>
          )}
          {rows.length < total && (
            <div className="p-2 text-center"><Button variant="ghost" onClick={loadMore} disabled={loading || loadingMore}>Load more</Button></div>
          )}
        </div>
      </>)}
      {/* z-[260]: above the Modal overlay's z-[250], below ConfirmDialog's z-[300]. */}
      {hover && !uploadTab && (
        <DocumentHoverPreview
          row={hover.row} startX={hover.x} startY={hover.y}
          customTypes={customTypes} onHide={hideHover} zIndexClass="z-[260]"
        />
      )}
    </Modal>
  );
};
