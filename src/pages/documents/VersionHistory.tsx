// src/pages/documents/VersionHistory.tsx — a document's earlier versions,
// under its row on the Documents page: who made each one and when, with
// download, restore and delete (ONLYOFFICE Phase 2).
//
// Restoring puts the old bytes back as a NEW version on top, so nothing is
// lost. Deleting is for clearing out versions nobody wants (regenerating
// always adds one): admins, or whoever made that version.
import React, { useCallback, useEffect, useState } from 'react';
import { Download, RotateCcw, Trash2 } from 'lucide-react';
import {
  ProjectFile, RestoreError, deleteFileVersion, fetchFileBlob, getAssignableUsers, listFileVersions, restoreFileVersion,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { Skeleton } from '../../components/ui';
import { downloadBlob } from '../../utils/download';

const currentUser = (): { id?: string; role?: string } => {
  try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
};

/** "Scope.docx" → "Scope (v2).docx", so the download keeps its extension. */
export const versionFileName = (name: string, version: number): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (v${version})${name.slice(dot)}` : `${name} (v${version})`;
};

const ORIGIN_LABEL: Record<string, string> = { editor: 'edited', restore: 'restored', convert: 'converted' };

const actionCls = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-600 hover:bg-hover hover:underline disabled:opacity-50 dark:text-accent-400';

export const VersionHistory: React.FC<{ fileId: string; fileName: string | null }> = ({ fileId, fileName }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [versions, setVersions] = useState<ProjectFile[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const me = currentUser();
  const isAdmin = me.role === 'admin';

  const load = useCallback(async () => {
    try { setVersions(await listFileVersions(fileId)); }
    catch { setVersions([]); }
  }, [fileId]);

  useEffect(() => {
    void load();
    // Names are a nicety: without them a version just shows no author.
    getAssignableUsers()
      .then(users => setNames(new Map(users.map(u => [String(u.id), u.username]))))
      .catch(() => {});
  }, [load]);

  if (versions === null) return <Skeleton className="h-6 w-48" />;
  if (versions.length <= 1) return <span className="text-xs text-ink-faint">No earlier versions.</span>;
  const current = versions[0];
  const label = fileName ?? fileId;

  const author = (v: ProjectFile) =>
    v.createdBy ? (names.get(String(v.createdBy)) ?? (names.size ? 'former user' : null)) : null;

  const handleRestore = async (v: ProjectFile) => {
    const ok = await confirm({
      title: `Restore version ${v.versionNumber}?`,
      message: `Its content becomes the current version of "${label}" (version ${current.versionNumber + 1}). `
        + `The current version ${current.versionNumber} stays in the history.`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await restoreFileVersion(fileId, { versionId: v.id }, 'documents');
      toast(`Version ${v.versionNumber} restored as version ${r.versionNumber}`, { type: 'success' });
      await load();
    } catch (e) {
      toast(e instanceof RestoreError ? e.message : "Couldn't restore that version", { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (v: ProjectFile) => {
    const ok = await confirm({
      title: `Delete version ${v.versionNumber}?`,
      message: `Version ${v.versionNumber} of "${label}" will be removed for good. The current version isn't affected.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteFileVersion(fileId, v.id);
      toast(`Version ${v.versionNumber} deleted`, { type: 'success' });
      await load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't delete that version", { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ul className="space-y-1" data-testid="version-history">
      {versions.slice(1).map(v => {
        const by = author(v);
        const canDelete = isAdmin || (!!v.createdBy && String(v.createdBy) === String(me.id));
        return (
          <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft" data-testid="version-row">
            <span className="font-medium text-ink">v{v.versionNumber}</span>
            <span>{new Date(v.createdAt).toLocaleString()}</span>
            {by && <span>by {by}</span>}
            {v.versionOrigin && ORIGIN_LABEL[v.versionOrigin] && (
              <span className="rounded bg-sunken px-1.5 py-px text-ink-faint">{ORIGIN_LABEL[v.versionOrigin]}</span>
            )}
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className={actionCls}
                disabled={busy}
                onClick={async () => {
                  try { downloadBlob(await fetchFileBlob(v.id), versionFileName(label, v.versionNumber)); }
                  catch { toast('Download failed', { type: 'error' }); }
                }}
              >
                <Download size={12} />download
              </button>
              <button type="button" className={actionCls} disabled={busy} onClick={() => { void handleRestore(v); }}>
                <RotateCcw size={12} />restore
              </button>
              {canDelete && (
                <button
                  type="button"
                  className={`${actionCls} !text-red-600 dark:!text-red-400`}
                  disabled={busy}
                  aria-label={`Delete version ${v.versionNumber}`}
                  title="Delete this version"
                  onClick={() => { void handleDelete(v); }}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
};
