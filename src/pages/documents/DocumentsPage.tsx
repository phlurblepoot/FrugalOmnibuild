// src/pages/documents/DocumentsPage.tsx
// Global Documents page (spec docs/superpowers/specs/2026-08-17-unified-documents-design.md
// §Client). URL params `?projectIds=&customerIds=&kinds=&q=&archived=` (comma
// lists) drive every filter so the page is deep-linkable both ways: this page
// writes them on every filter change, and any other page (e.g. the retired
// per-project Documents nav entry) can land here pre-filtered by composing
// the same query string.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ChevronDown, FilePlus2, FileSignature, FolderOpen, Upload } from 'lucide-react';
import { Customer } from '../../types';
import {
  DocumentRow, ProjectSummary, deleteFile, fetchFileBlob, getCustomers, getDocumentTypes,
  getDocuments, getProjectsSummary, patchFile,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { DocumentsBulkBar } from './DocumentsBulkBar';
import { AppendPagesModal } from './AppendPagesModal';
import { MergePdfsModal } from './MergePdfsModal';
import { useShare } from '../../components/ShareLinkModal';
import { DocumentsFilterBar } from './DocumentsFilterBar';
import { downloadBlob, DocumentsTable } from './DocumentsTable';
import { MultiSelectOption } from './MultiSelectDropdown';
import { UploadDocumentsModal } from './UploadDocumentsModal';
import { NewDocumentModal } from './NewDocumentModal';
import { NewLienReleaseModal } from './NewLienReleaseModal';
import { isNewDocumentType, type NewDocumentType } from '../../utils/officeFormats';
import { CustomDocType, KIND_OPTIONS } from './docTypes';

const PAGE_SIZE = 100;

// Reads a comma-list URL param back into an array — the inverse of the
// `.join(',')` calls in applyFilterPatch below. Exported for the round-trip
// unit tests (DocumentsPage.test.ts).
export const csvParam = (sp: URLSearchParams, key: string): string[] => {
  const v = sp.get(key);
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
};

export type FilterPatch = Partial<{
  projectIds: string[];
  customerIds: string[];
  kinds: string[];
  q: string;
  archived: boolean;
  unassigned: boolean;
}>;

// Pure: applies a filter patch onto a URLSearchParams, returning a new one.
// Empty arrays/strings/false delete the key rather than writing an empty
// value, so `csvParam` always round-trips to `[]`/''/false on read. Exported
// for the round-trip unit tests.
export const applyFilterPatch = (prev: URLSearchParams, patch: FilterPatch): URLSearchParams => {
  const p = new URLSearchParams(prev);
  if ('projectIds' in patch) { patch.projectIds!.length ? p.set('projectIds', patch.projectIds!.join(',')) : p.delete('projectIds'); }
  if ('customerIds' in patch) { patch.customerIds!.length ? p.set('customerIds', patch.customerIds!.join(',')) : p.delete('customerIds'); }
  if ('kinds' in patch) { patch.kinds!.length ? p.set('kinds', patch.kinds!.join(',')) : p.delete('kinds'); }
  if ('q' in patch) { patch.q ? p.set('q', patch.q) : p.delete('q'); }
  if ('archived' in patch) { patch.archived ? p.set('archived', '1') : p.delete('archived'); }
  if ('unassigned' in patch) { patch.unassigned ? p.set('unassigned', '1') : p.delete('unassigned'); }
  return p;
};

// Same pattern as the local isAdmin() in ProjectBilling.tsx/CustomerPane.tsx
// etc. — no shared helper exists in this codebase, so this mirrors it rather
// than introducing a new cross-cutting import.
const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

// `projectId` set = the project's own Documents tab (rendered inside
// ProjectLayout): the list is pinned to that project, ignores any projectIds in
// the URL, and hides the Project filter and the admin Unassigned view.
export const DocumentsPage: React.FC<{ projectId?: string }> = ({ projectId: lockedProjectId }) => {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const projectIds = useMemo(
    () => (lockedProjectId ? [lockedProjectId] : csvParam(searchParams, 'projectIds')),
    [searchParams, lockedProjectId],
  );
  const customerIds = useMemo(() => csvParam(searchParams, 'customerIds'), [searchParams]);
  const kinds = useMemo(() => csvParam(searchParams, 'kinds'), [searchParams]);
  const q = searchParams.get('q') ?? '';
  const archived = searchParams.get('archived') === '1';
  const admin = useMemo(() => isAdmin(), []);
  // Ignored server-side for a non-admin regardless of what's in the URL, but
  // also gated client-side so a non-admin who hand-edits the URL never even
  // sends the param or sees the (unrendered) toggle reflect it.
  const unassigned = !lockedProjectId && admin && searchParams.get('unassigned') === '1';

  const setFilter = (patch: FilterPatch) => {
    setSearchParams(prev => applyFilterPatch(prev, patch), { replace: true });
  };

  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [appendTarget, setAppendTarget] = useState<DocumentRow | null>(null);
  const [mergeRows, setMergeRows] = useState<DocumentRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadInitialFiles, setUploadInitialFiles] = useState<File[] | undefined>(undefined);

  // "New document" (ONLYOFFICE Phase 3). `?new=docx|xlsx|pdf` opens it on that
  // type (the command palette's "New Word document" etc.); the param is
  // dropped once read so Back and a reload don't reopen it.
  const [newDocType, setNewDocType] = useState<NewDocumentType | null>(null);
  // "New" is a menu for admins (the second entry is billing, admin-only).
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [lienOpen, setLienOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newMenuOpen) return;
    const away = (e: MouseEvent) => { if (!newMenuRef.current?.contains(e.target as Node)) setNewMenuOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [newMenuOpen]);
  const newParam = searchParams.get('new');
  useEffect(() => {
    if (!newParam) return;
    setNewDocType(isNewDocumentType(newParam) ? newParam : 'docx');
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('new'); return next; }, { replace: true });
  }, [newParam, setSearchParams]);

  // Filter option sources / upload-modal pickers — loaded once. Every
  // project/customer is offered (not just those with a visible document) so
  // a filter (or an upload) chosen ahead of any document existing still
  // makes sense.
  useEffect(() => {
    getProjectsSummary().then(setProjects).catch(() => setProjects([]));
    getCustomers().then(setCustomers).catch(() => setCustomers([]));
    getDocumentTypes().then(setCustomTypes).catch(() => setCustomTypes([]));
  }, []);

  const projectOptions = useMemo<MultiSelectOption[]>(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ id: p.id, label: p.name })),
    [projects]
  );
  const customerOptions = useMemo<MultiSelectOption[]>(
    () => [...customers].sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ id: c.id, label: c.name })),
    [customers]
  );
  const kindOptions = useMemo<MultiSelectOption[]>(() => [
    ...KIND_OPTIONS,
    ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label })),
  ], [customTypes]);

  // A single string key so the fetch effect only re-runs when the filters
  // actually change (arrays/objects would otherwise be new references on
  // every render).
  const filterKey = `${projectIds.join(',')}|${customerIds.join(',')}|${kinds.join(',')}|${q}|${archived}|${unassigned}`;

  // Bumped every time the filters change (or a refresh is kicked off), so a
  // Load More / refresh that's still in-flight when something else changes
  // can tell its response is stale and drop it instead of clobbering newer
  // state. mountedRef guards the same races past unmount — it must be reset
  // to true on every (re)mount, not just seeded once via useRef(true): React
  // 18 StrictMode double-invokes effects in dev (mount -> cleanup -> mount)
  // on the SAME ref, so a cleanup-only effect leaves mountedRef stuck false
  // after the simulated unmount and every future refresh()'s response is
  // silently dropped forever — the page never leaves its loading skeleton.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Re-fetches page one of the current filters. Selection is cleared — every
  // caller (filter change, bulk/row mutation) invalidates whatever was
  // selected. `limit` defaults to a full page, but mutation handlers pass the
  // number of rows already loaded so a bulk action doesn't collapse a
  // "Load more"-expanded list back down to page one's size.
  const refresh = async (limit: number = PAGE_SIZE) => {
    const myId = ++requestIdRef.current;
    setLoading(true);
    try {
      const res = await getDocuments({ projectIds, customerIds, kinds, q: q || undefined, archived, unassigned, limit, offset: 0 });
      if (mountedRef.current && myId === requestIdRef.current) {
        setRows(res.rows);
        setTotal(res.total);
        setSelected(new Set());
      }
    } catch {
      if (mountedRef.current && myId === requestIdRef.current) {
        setRows([]);
        setTotal(0);
        setSelected(new Set());
        toast('Failed to load documents', { type: 'error' });
      }
    } finally {
      if (mountedRef.current && myId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Change-feed live refresh. Kept ALONGSIDE the filterKey effect above rather
  // than replacing it: the hook's filter identity can't carry this page's own
  // (much richer) filterKey, so this hook exists only to add the socket
  // subscription. Its own mount-time call to `refresh()` is a harmless
  // duplicate of the effect above's — the requestIdRef race guard in
  // `refresh` already makes the loser's response a no-op (last request wins).
  useLiveQuery(refresh, { types: ['file'] });

  const loadMore = async () => {
    const myId = requestIdRef.current;
    setLoadingMore(true);
    try {
      const res = await getDocuments({
        projectIds, customerIds, kinds, q: q || undefined, archived, unassigned,
        limit: PAGE_SIZE, offset: rows.length,
      });
      // The filters moved on while this page was in flight — its rows belong
      // to a query that's no longer showing, so drop them rather than append.
      if (myId !== requestIdRef.current) return;
      setRows(prev => [...prev, ...res.rows]);
      setTotal(res.total);
    } catch {
      if (myId === requestIdRef.current) toast('Failed to load more documents', { type: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Selection ──────────────────────────────────────────────────────────────
  const toggleRow = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(prev => {
    const allSelected = rows.length > 0 && rows.every(r => prev.has(r.id));
    return allSelected ? new Set() : new Set(rows.map(r => r.id));
  });
  const clearSelection = () => setSelected(new Set());
  const selectedRows = rows.filter(r => selected.has(r.id));

  // One public link to the ticked documents (ONLYOFFICE Phase 7). Named for
  // their project when they share one, so the page says whose they are.
  const share = useShare();
  const shareRows = (targets: DocumentRow[]) => {
    if (targets.length === 1) {
      const name = targets[0].name ?? 'Document';
      share({ title: `Share ${name}`, target: { type: 'file', resourceId: targets[0].id }, name });
      return;
    }
    const projects = new Set(targets.map(r => r.projectName ?? ''));
    const [project] = [...projects];
    const name = projects.size === 1 && project ? `${project}: ${targets.length} documents` : `${targets.length} documents`;
    share({
      title: `Share ${targets.length} documents`,
      target: { type: 'files', fileIds: targets.map(r => r.id) },
      name,
      fileNames: targets.map(r => r.name ?? 'Document'),
    });
  };

  // ── Mutations (shared by bulk bar + per-row actions) ─────────────────────────
  const archiveRows = async (targets: DocumentRow[], nextArchived: boolean) => {
    if (targets.length === 0) return;
    const results = await Promise.allSettled(targets.map(r => patchFile(r.id, { archived: nextArchived })));
    const failed = results.filter(r => r.status === 'rejected').length;
    const verb = nextArchived ? 'Archived' : 'Restored';
    if (failed === targets.length) toast(`Failed to ${verb.toLowerCase()}`, { type: 'error' });
    else if (failed) toast(`${verb} ${targets.length - failed} of ${targets.length}`, { type: 'warning' });
    else toast(`${verb} ${targets.length} document${targets.length === 1 ? '' : 's'}`, { type: 'success' });
    await refresh(Math.max(rows.length, PAGE_SIZE));
  };

  const deleteRows = async (targets: DocumentRow[]) => {
    if (targets.length === 0) return;
    const results = await Promise.allSettled(targets.map(r => deleteFile(r.id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed === targets.length) toast('Failed to delete', { type: 'error' });
    else if (failed) toast(`Deleted ${targets.length - failed} of ${targets.length}`, { type: 'warning' });
    else toast(`Deleted ${targets.length} document${targets.length === 1 ? '' : 's'}`, { type: 'success' });
    await refresh(Math.max(rows.length, PAGE_SIZE));
  };

  const changeKind = async (row: DocumentRow, kind: string) => {
    try {
      await patchFile(row.id, { kind });
      toast('Type updated', { type: 'success' });
      await refresh(Math.max(rows.length, PAGE_SIZE));
    } catch {
      toast('Failed to change type', { type: 'error' });
    }
  };

  // Bulk re-type: the bulk bar only ever hands over selectionPolicy.retypeable
  // rows, so a system-kind row is never sent (the server would 409 it). Same
  // allSettled + partial-failure toast shape as archiveRows/deleteRows.
  const changeKindBulk = async (targets: DocumentRow[], kind: string) => {
    if (targets.length === 0) return;
    const results = await Promise.allSettled(targets.map(r => patchFile(r.id, { kind })));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed === targets.length) toast('Failed to change type', { type: 'error' });
    else if (failed) toast(`Changed type of ${targets.length - failed} of ${targets.length}`, { type: 'warning' });
    else toast(`Changed type of ${targets.length} document${targets.length === 1 ? '' : 's'}`, { type: 'success' });
    await refresh(Math.max(rows.length, PAGE_SIZE));
  };

  // Merge the selected PDFs, in the order they are listed, into one new
  // document (server/pdfMerge.ts); the new row shows up after the refresh.
  // The Merge PDFs dialog (order, name, project) opens first; it does the merge.
  const mergePdfRows = async (targets: DocumentRow[]) => { setMergeRows(targets); };

  const bulkDownload = async (targets: DocumentRow[]) => {
    let ok = 0;
    for (const row of targets) {
      try {
        downloadBlob(await fetchFileBlob(row.id), row.name ?? row.id);
        ok++;
      } catch { /* keep going, report the count below */ }
    }
    if (ok < targets.length) toast(`Downloaded ${ok} of ${targets.length}`, { type: ok ? 'warning' : 'error' });
  };

  // ── Page-level drag-drop (spec: "Drag-drop + picker both open the labeling
  // popup") ──────────────────────────────────────────────────────────────────
  // A counter (not a boolean) because dragenter/dragleave fire for every
  // descendant the pointer crosses — a plain boolean would flicker off the
  // moment the cursor passes over a child element. Every handler bails out
  // (no preventDefault, no state touch) unless the drag actually carries
  // files, so ordinary text/element drags — and all normal scrolling, which
  // isn't part of the HTML5 drag API at all — are completely unaffected.
  const dragCounter = useRef(0);
  const [pageDragActive, setPageDragActive] = useState(false);
  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const onPageDragEnter = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragCounter.current++;
    setPageDragActive(true);
  };
  const onPageDragOver = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
  };
  const onPageDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setPageDragActive(false);
  };
  const onPageDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragCounter.current = 0;
    setPageDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      setUploadInitialFiles(files);
      setUploadOpen(true);
    }
  };

  const filtering = (!lockedProjectId && projectIds.length > 0) || customerIds.length > 0 || kinds.length > 0 || q.trim() !== '' || archived || unassigned;

  return (
    <div
      className="relative mx-auto max-w-6xl px-4 py-6 md:px-8"
      onDragEnter={onPageDragEnter}
      onDragOver={onPageDragOver}
      onDragLeave={onPageDragLeave}
      onDrop={onPageDrop}
    >
      {pageDragActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center border-4 border-dashed border-accent-500 bg-accent-500/10">
          <p className="rounded-lg bg-raised px-4 py-2 text-sm font-medium text-ink shadow-lg">Drop to upload</p>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FolderOpen size={22} className="text-accent-600 dark:text-accent-400" />
          <h1 className="text-xl font-bold text-ink">Documents</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative" ref={newMenuRef}>
            <Button
              variant="secondary" data-testid="documents-new"
              aria-haspopup={admin ? 'menu' : undefined} aria-expanded={admin ? newMenuOpen : undefined}
              onClick={() => (admin ? setNewMenuOpen(o => !o) : setNewDocType('docx'))}
            >
              <FilePlus2 size={15} />New document{admin && <ChevronDown size={13} />}
            </Button>
            {admin && newMenuOpen && (
              <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-edge bg-raised py-1 shadow-lg">
                <button role="menuitem" type="button" data-testid="documents-new-document"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-hover"
                  onClick={() => { setNewMenuOpen(false); setNewDocType('docx'); }}>
                  <FilePlus2 size={14} />Document, spreadsheet or PDF form
                </button>
                <button role="menuitem" type="button" data-testid="documents-new-lien-release"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-hover"
                  onClick={() => { setNewMenuOpen(false); setLienOpen(true); }}>
                  <FileSignature size={14} />Release of lien
                </button>
              </div>
            )}
          </div>
          <Button
            data-testid="documents-upload"
            onClick={() => { setUploadInitialFiles(undefined); setUploadOpen(true); }}
          >
            <Upload size={15} />Upload
          </Button>
        </div>
      </div>

      <DocumentsFilterBar
        q={q}
        onQChange={v => setFilter({ q: v })}
        projectOptions={projectOptions}
        projectIds={projectIds}
        onProjectIdsChange={ids => setFilter({ projectIds: ids })}
        customerOptions={customerOptions}
        customerIds={customerIds}
        onCustomerIdsChange={ids => setFilter({ customerIds: ids })}
        kindOptions={kindOptions}
        kinds={kinds}
        onKindsChange={ids => setFilter({ kinds: ids })}
        archived={archived}
        // Exclusive with Unassigned (spec): both fields land in ONE patch, so
        // this is a single setSearchParams call rather than two racing ones —
        // see applyFilterPatch's round-trip unit tests for why that matters.
        onArchivedChange={v => setFilter({ archived: v, ...(v ? { unassigned: false } : {}) })}
        hideProjectFilter={!!lockedProjectId}
        isAdmin={admin && !lockedProjectId}
        unassigned={unassigned}
        onUnassignedChange={v => setFilter({ unassigned: v, ...(v ? { archived: false } : {}) })}
      />

      <DocumentsBulkBar
        selected={selectedRows}
        customTypes={customTypes}
        archivedView={archived}
        onClear={clearSelection}
        onDownload={bulkDownload}
        onArchive={archiveRows}
        onChangeKind={changeKindBulk}
        onDelete={deleteRows}
        onShare={shareRows}
        onMergePdfs={mergePdfRows}
        onAppendPages={setAppendTarget}
      />
      <MergePdfsModal
        open={!!mergeRows}
        rows={mergeRows ?? []}
        onClose={() => setMergeRows(null)}
        onDone={async (count, name) => {
          toast(`Merged ${count} PDFs into ${name}`, { type: 'success' });
          clearSelection();
          await refresh(Math.max(rows.length, PAGE_SIZE));
        }}
      />
      <AppendPagesModal
        open={!!appendTarget}
        target={appendTarget}
        onClose={() => setAppendTarget(null)}
        onDone={async t => {
          toast(`Pages added to ${t.name ?? "the PDF"} as a new version`, { type: "success" });
          clearSelection();
          await refresh(Math.max(rows.length, PAGE_SIZE));
        }}
      />

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={22} />}
          title={filtering ? 'No matching documents' : 'No documents yet'}
          description={filtering
            ? 'Try widening your filters.'
            : 'Uploads, proposals, printouts, and generated PDFs will show up here as they land.'}
        />
      ) : (
        <>
          <DocumentsTable
            rows={rows}
            customTypes={customTypes}
            selected={selected}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
            onArchiveRows={archiveRows}
            onDeleteRows={deleteRows}
            onChangeKind={changeKind}
          />
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-faint">
            <span>Filtered: {rows.length} of {total}</span>
            {rows.length < total && (
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </>
      )}

      <UploadDocumentsModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => refresh(Math.max(rows.length, PAGE_SIZE))}
        projects={projects}
        customers={customers}
        customTypes={customTypes}
        initialFiles={uploadInitialFiles}
      />

      {admin && (
        <NewLienReleaseModal
          open={lienOpen}
          onClose={() => setLienOpen(false)}
          initialProjectId={projectIds.length === 1 ? projectIds[0] : undefined}
        />
      )}

      <NewDocumentModal
        open={newDocType !== null}
        onClose={() => setNewDocType(null)}
        initialType={newDocType ?? 'docx'}
        // Filtered to one project (the project's Documents tab): file it there.
        initialProjectId={projectIds.length === 1 ? projectIds[0] : undefined}
      />
    </div>
  );
};

// Route element for /project/:projectId/documents: the same list as the global
// page, scoped to the project and shown inside ProjectLayout so the top bar and
// tabs stay.
export const ProjectDocuments: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  return <DocumentsPage projectId={projectId} />;
};
