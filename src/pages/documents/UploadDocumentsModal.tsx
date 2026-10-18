// src/pages/documents/UploadDocumentsModal.tsx
import { v4 as uuidv4 } from 'uuid';
// Upload labeling popup (spec §Decisions "Direct uploads open a labeling
// popup"): multi-file batch with removable chips, a shared Type/Customer/
// Project picker (selecting a project locks the customer to the project's
// customer — same rule TaskEditor.tsx uses for tasks), and an optional
// per-file type disclosure. Opened either by the page's Upload button (empty)
// or by a page-level drag-drop (pre-seeded via `initialFiles`).
import React, { useEffect, useRef, useState } from 'react';
import { File as FileIcon, Upload, X } from 'lucide-react';
import { Customer } from '../../types';
import {
  CustomDocType, ProjectSummary, formatBytes, saveBinaryFile,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, Checkbox, Field, Modal, Select } from '../../components/ui';
import { DIRECT_UPLOAD_KINDS, kindLabel } from './docTypes';
import { reportConversions } from '../../utils/uploadConversion';
import { kindFromMime } from './openTarget';

/** A remote (mail-attachment) source item, before it becomes an Entry. */
export interface RemoteItem {
  id: string;
  name: string;
  size: number;
  mime: string;
}

/** An item as handed to `onUploadRemote` once picked in the batch. */
export interface RemoteUploadItem {
  id: string;
  name: string;
  kind: string;
  projectId?: string;
  customerId?: string;
}

// A batch entry is either a local File (dropzone/browse) or a RemoteItem
// (seeded from `remoteItems` — mail attachments not yet fetched). Both carry
// the same `id`/`kind` so the shared chip-list, remove, and per-file-type
// logic below don't need to know which kind of batch this is.
type Entry =
  | { id: string; kind: string; file: File }
  | { id: string; kind: string; remote: RemoteItem };

const isRemoteEntry = (e: Entry): e is Extract<Entry, { remote: RemoteItem }> => 'remote' in e;
const entryName = (e: Entry): string => (isRemoteEntry(e) ? e.remote.name : e.file.name);
const entrySize = (e: Entry): number => (isRemoteEntry(e) ? e.remote.size : e.file.size);

// The Type select opens on this, so a fresh batch must be seeded with it —
// guessing from the MIME type instead would make the visible Type lie about
// what gets uploaded.
const DEFAULT_KIND = 'document';

const toEntry = (file: File, kind: string): Entry => ({ id: uuidv4(), file, kind });
const toRemoteEntry = (remote: RemoteItem, kind: string): Entry => ({ id: uuidv4(), remote, kind });

export const UploadDocumentsModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  projects: ProjectSummary[];
  customers: Customer[];
  customTypes: CustomDocType[];
  initialFiles?: File[];
  /** Task 5 (mail client): when given, the batch is seeded from these
   *  mail-attachment stubs instead of local Files — the dropzone/browse is
   *  hidden and confirming calls `onUploadRemote` instead of saveBinaryFile.
   *  A caller can hand down a NARROWER array (same prop, new reference)
   *  while the modal stays open — e.g. after a partial-failure save — and
   *  the chip list re-seeds to just those, without resetting the Type/
   *  Project/Customer the person already picked. */
  remoteItems?: RemoteItem[];
  onUploadRemote?: (items: RemoteUploadItem[]) => Promise<{ ok: number; total: number }>;
  /** Preselects the Project (and its Customer) at open — used by the mail
   *  client's Save-to-Documents flow when a thread is already linked to a
   *  project. Only read at the open transition, like `initialFiles`. */
  initialProjectId?: string;
}> = ({
  open, onClose, onUploaded, projects, customers, customTypes, initialFiles,
  remoteItems, onUploadRemote, initialProjectId,
}) => {
  const { toast } = useToast();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sharedKind, setSharedKind] = useState(DEFAULT_KIND);
  const [perFileType, setPerFileType] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset to a fresh batch every time the popup opens — initialFiles/
  // remoteItems is only read at the open transition (a page-level drop that
  // happens while the modal is already open just falls through to the
  // dropzone's own onDrop).
  useEffect(() => {
    if (!open) return;
    if (remoteItems) {
      setEntries(remoteItems.map(r => toRemoteEntry(r, DEFAULT_KIND)));
    } else {
      setEntries((initialFiles ?? []).map(f => toEntry(f, DEFAULT_KIND)));
    }
    setSharedKind(DEFAULT_KIND);
    setPerFileType(false);
    const proj = initialProjectId ? projects.find(p => p.id === initialProjectId) : undefined;
    setProjectId(initialProjectId ?? '');
    setCustomerId(proj?.customerId ?? '');
    setDragActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A caller can narrow `remoteItems` (new array reference, e.g. down to just
  // the failed items after a partial save) while the modal stays open — the
  // chip list re-seeds to match, but Type/Project/Customer are left alone
  // since this isn't a fresh open. Guarded so it never fires for the initial
  // seed the effect above already handled, nor for reference-stable re-renders.
  // Each surviving id carries its OWN kind forward (a per-file override
  // included) rather than being recomputed from the guess — only a
  // genuinely new id (not in the prior batch) falls back to that guess.
  const remoteItemsRef = useRef(remoteItems);
  useEffect(() => {
    if (open && remoteItems && remoteItemsRef.current !== remoteItems) {
      setEntries(prev => remoteItems.map(r => {
        const existing = prev.find(e => isRemoteEntry(e) && e.remote.id === r.id);
        const kind = existing ? existing.kind : (perFileType ? kindFromMime(r.mime) : sharedKind);
        return toRemoteEntry(r, kind);
      }));
    }
    remoteItemsRef.current = remoteItems;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteItems]);

  const typeOptions: { id: string; label: string }[] = [
    ...DIRECT_UPLOAD_KINDS.map(k => ({ id: k, label: kindLabel(k) })),
    ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label })),
  ];

  const addFiles = (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    // Only the per-file disclosure guesses from the MIME type — with one shared
    // Type, every chip must carry what that select shows.
    setEntries(prev => [...prev, ...arr.map(f => toEntry(f, perFileType ? kindFromMime(f.type) : sharedKind))]);
  };

  const removeEntry = (id: string) => setEntries(prev => prev.filter(e => e.id !== id));

  // Company documents aren't tied to a project (spec §Decisions): a project
  // pick from a prior batch would silently carry over otherwise.
  const isCompanyDocOnly = perFileType
    ? entries.length > 0 && entries.every(e => e.kind === 'company-document')
    : sharedKind === 'company-document';

  const changeSharedKind = (kind: string) => {
    setSharedKind(kind);
    if (!perFileType) setEntries(prev => prev.map(e => ({ ...e, kind })));
  };

  // Clears whatever Project/Customer was picked (even from a prior batch) the
  // moment the batch becomes company-document-only, from any of the paths
  // that can get there: the shared Type select, toggling per-file typing, or
  // editing an individual chip's type.
  useEffect(() => {
    if (isCompanyDocOnly) { setProjectId(''); setCustomerId(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompanyDocOnly]);

  const togglePerFileType = (checked: boolean) => {
    setPerFileType(checked);
    if (!checked) setEntries(prev => prev.map(e => ({ ...e, kind: sharedKind })));
  };

  // Selecting a project locks the customer to that project's customer — same
  // rule as TaskEditor.tsx's onProjectChange.
  const onProjectChange = (next: string) => {
    setProjectId(next);
    if (next) {
      const p = projects.find(pr => pr.id === next);
      setCustomerId(p?.customerId ?? '');
    } else {
      setCustomerId('');
    }
  };

  // Remote-mode confirm: hand the whole picked batch to the caller in one
  // call (mirroring mailApi.saveAttachments's single-request/per-item-result
  // shape) and step back — the caller owns the resulting toast, whether the
  // modal closes, and (via a narrower `remoteItems`) which chips survive a
  // partial failure. Generic per-file looping/toasting below is local-only.
  const handleUploadRemote = async () => {
    if (entries.length === 0 || !onUploadRemote) return;
    setUploading(true);
    try {
      const items: RemoteUploadItem[] = entries.map(e => {
        const re = e as Extract<Entry, { remote: RemoteItem }>;
        const tagged = re.kind !== 'company-document';
        return {
          id: re.remote.id,
          name: re.remote.name,
          kind: re.kind,
          ...(tagged && projectId ? { projectId } : {}),
          ...(tagged && customerId ? { customerId } : {}),
        };
      });
      await onUploadRemote(items);
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = async () => {
    if (entries.length === 0) return;
    if (remoteItems) return handleUploadRemote();
    setUploading(true);
    const uploaded = new Set<string>();
    const results: Parameters<typeof reportConversions>[1] = [];
    for (const e of entries) {
      const local = e as Extract<Entry, { file: File }>;
      // A per-file company-document in an otherwise project/customer-tagged
      // batch must not inherit either — company documents aren't tied to a
      // project (or its customer), regardless of what the rest of the batch
      // picked.
      const tagged = local.kind !== 'company-document';
      try {
        const r = await saveBinaryFile(uuidv4(), local.file, {
          kind: local.kind,
          name: local.file.name,
          ...(tagged && projectId ? { projectId } : {}),
          ...(tagged && customerId ? { customerId } : {}),
        });
        uploaded.add(local.id);
        results.push({ name: local.file.name, conversion: r.conversion });
      } catch { /* keep going, report the count below */ }
    }
    setUploading(false);
    // The chips that made it are dropped so the modal stays open on exactly the
    // failures — pressing Upload again retries those instead of uploading the
    // successes a second time under new ids.
    if (uploaded.size) setEntries(prev => prev.filter(e => !uploaded.has(e.id)));
    const ok = uploaded.size;
    if (ok < entries.length) toast(`Uploaded ${ok} of ${entries.length} files`, { type: ok ? 'warning' : 'error' });
    else toast(`Uploaded ${ok} file${ok === 1 ? '' : 's'}`, { type: 'success' });
    reportConversions(toast, results);
    if (ok > 0) onUploaded();
    if (ok === entries.length) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={remoteItems ? 'Save attachments to Documents' : 'Upload documents'}
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>Cancel</Button>
          <Button onClick={handleUpload} disabled={uploading || entries.length === 0}>
            {remoteItems
              ? (uploading ? 'Saving…' : `Save ${entries.length} file${entries.length === 1 ? '' : 's'}`)
              : (uploading ? 'Uploading…' : `Upload${entries.length ? ` (${entries.length})` : ''}`)}
          </Button>
        </>
      }
    >
      <div data-testid="documents-upload-modal" className="space-y-4">
        {remoteItems ? (
          <div className="space-y-2">
            {entries.map(e => (
              <div key={e.id} className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2">
                <FileIcon size={16} className="shrink-0 text-ink-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{entryName(e)}</p>
                  <p className="text-xs text-ink-faint">{formatBytes(entrySize(e))}</p>
                </div>
                {perFileType && (
                  <Select
                    aria-label={`Type for ${entryName(e)}`}
                    value={e.kind}
                    onChange={ev => setEntries(prev => prev.map(x => x.id === e.id ? { ...x, kind: ev.target.value } : x))}
                    className="w-40 shrink-0"
                  >
                    {typeOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </Select>
                )}
                <button
                  onClick={() => removeEntry(e.id)}
                  aria-label={`Remove ${entryName(e)}`}
                  className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div
            className={`rounded-xl border-2 border-dashed p-4 transition-colors ${
              dragActive ? 'border-accent-500 bg-accent-500/5' : 'border-edge'
            }`}
            onClick={() => entries.length === 0 && fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
            onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
            onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragActive(false); }}
            onDrop={e => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
              if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
            />
            {entries.length === 0 ? (
              <div className="flex cursor-pointer flex-col items-center gap-2 py-6 text-center">
                <Upload size={22} className="text-ink-faint" />
                <p className="text-sm text-ink">Drag files here or click to browse</p>
              </div>
            ) : (
              <div className="space-y-2">
                {entries.map(e => (
                  <div key={e.id} className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2">
                    <FileIcon size={16} className="shrink-0 text-ink-faint" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">{entryName(e)}</p>
                      <p className="text-xs text-ink-faint">{formatBytes(entrySize(e))}</p>
                    </div>
                    {perFileType && (
                      <Select
                        aria-label={`Type for ${entryName(e)}`}
                        value={e.kind}
                        onChange={ev => setEntries(prev => prev.map(x => x.id === e.id ? { ...x, kind: ev.target.value } : x))}
                        className="w-40 shrink-0"
                        onClick={ev => ev.stopPropagation()}
                      >
                        {typeOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </Select>
                    )}
                    <button
                      onClick={ev => { ev.stopPropagation(); removeEntry(e.id); }}
                      aria-label={`Remove ${entryName(e)}`}
                      className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={ev => { ev.stopPropagation(); fileInputRef.current?.click(); }}
                  className="text-xs font-medium text-accent-600 hover:underline dark:text-accent-400"
                >
                  + Add more files
                </button>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Type" htmlFor="upload-type">
            <Select id="upload-type" value={sharedKind} onChange={e => changeSharedKind(e.target.value)}>
              {typeOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox
              label="Set type per file"
              checked={perFileType}
              onChange={e => togglePerFileType(e.target.checked)}
            />
          </div>
          <Field
            label="Project"
            htmlFor="upload-project"
            hint={isCompanyDocOnly ? "Company documents aren't tied to a project." : 'Optional.'}
          >
            <Select id="upload-project" value={projectId} disabled={isCompanyDocOnly} onChange={e => onProjectChange(e.target.value)}>
              <option value="">— none —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field
            label="Customer"
            htmlFor="upload-customer"
            hint={isCompanyDocOnly ? "Company documents aren't tied to a customer." : projectId ? 'Set by the selected project.' : undefined}
          >
            <Select id="upload-customer" value={customerId} disabled={isCompanyDocOnly || !!projectId} onChange={e => setCustomerId(e.target.value)}>
              <option value="">— none —</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>

        {remoteItems && (
          <p className="text-xs text-ink-faint">Files are fetched from your mailbox only when you confirm.</p>
        )}
      </div>
    </Modal>
  );
};
