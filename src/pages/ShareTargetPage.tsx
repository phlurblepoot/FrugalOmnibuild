// src/pages/ShareTargetPage.tsx — landing page for the Android "Share" sheet.
// The service worker (public/sw.js) parks shared files in the Cache API and
// redirects here; the user picks a project and the files go into its
// Documents tab.
import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { getProjectsSummary, uploadProjectFile, type ProjectSummary } from '../utils/store';
import { DIRECT_UPLOAD_KINDS, kindLabel } from './documents/docTypes';
import { kindFromMime } from './documents/openTarget';

// Where a signed-out person comes back to after signing in (the Login page
// reads it from ?next=). The shared files wait in the Cache API meanwhile.
export const SHARE_RETURN = '/share-target?shared=1';

// Sensible starting type for a shared file: by mime type, falling back to the
// extension because Android often shares files with a blank or generic type.
export function defaultKindFor(f: { name: string; type: string }): string {
  const byMime = kindFromMime(f.type);
  if (byMime !== 'other') return byMime;
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  if (['pdf', 'doc', 'docx', 'rtf', 'odt', 'ppt', 'pptx', 'odp'].includes(ext)) return 'document';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'spreadsheet';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(ext)) return 'photo';
  return 'other';
}

// Keep in step with SHARE_CACHE in public/sw.js.
export const SHARE_CACHE = 'share-target-v1';

export interface SharedNote { title: string; text: string; url: string }

export async function readSharedFiles(): Promise<{ files: File[]; note: SharedNote }> {
  const empty = { files: [] as File[], note: { title: '', text: '', url: '' } };
  if (typeof caches === 'undefined') return empty;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const files: File[] = [];
    for (const req of await cache.keys()) {
      if (!new URL(req.url).pathname.startsWith('/share-target/file/')) continue;
      const res = await cache.match(req);
      if (!res) continue;
      const blob = await res.blob();
      let name = 'shared-file';
      try { name = decodeURIComponent(res.headers.get('X-File-Name') || name); } catch { /* keep default */ }
      files.push(new File([blob], name, { type: res.headers.get('Content-Type') || blob.type }));
    }
    const metaRes = await cache.match('/share-target/meta');
    const note = metaRes ? { ...empty.note, ...(await metaRes.json()) } : empty.note;
    return { files, note };
  } catch {
    return empty;
  }
}

async function clearShared(): Promise<void> {
  try { if (typeof caches !== 'undefined') await caches.delete(SHARE_CACHE); } catch { /* nothing to clear */ }
}

const hasToken = (): boolean => { try { return !!localStorage.getItem('token'); } catch { return true; } };

export const ShareTargetPage: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState<SharedNote>({ title: '', text: '', url: '' });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [doneProject, setDoneProject] = useState<ProjectSummary | null>(null);

  useEffect(() => {
    // Signed out: the render below is already sending them to sign in. Asking
    // the server anything now would 401, and the store's 401 handler would
    // reload /login with the return address dropped (it runs after this page
    // has moved to /login). The files stay in the cache until they're back.
    if (!hasToken()) return;
    let live = true;
    (async () => {
      const [shared, list] = await Promise.all([readSharedFiles(), getProjectsSummary().catch(() => [] as ProjectSummary[])]);
      if (!live) return;
      setFiles(shared.files);
      setKinds(shared.files.map(defaultKindFor));
      setNote(shared.note);
      setProjects(list.filter(p => !p.archived));
      setLoaded(true);
    })();
    return () => { live = false; };
  }, []);

  const add = async () => {
    const project = projects.find(p => p.id === projectId);
    if (!project || busy) return;
    setBusy(true);
    setError('');
    try {
      for (let i = 0; i < files.length; i++) await uploadProjectFile(project.id, files[i], kinds[i] ?? 'document');
      await clearShared();
      setDoneProject(project);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the files");
    } finally {
      setBusy(false);
    }
  };

  if (!hasToken()) return <Navigate to={`/login?next=${encodeURIComponent(SHARE_RETURN)}`} replace />;

  const needle = query.trim().toLowerCase();
  const shown = projects.filter(p => p.id === projectId || !needle || p.name.toLowerCase().includes(needle));

  if (doneProject) {
    return (
      <div className="mx-auto max-w-md p-4 space-y-3">
        <h1 className="text-xl font-semibold">Added to {doneProject.name}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {files.length === 1 ? files[0].name : `${files.length} files`} now in the project's Documents.
        </p>
        <Link className="inline-block rounded bg-blue-600 px-4 py-2 text-white" to={`/project/${doneProject.id}/documents`}>Open Documents</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md p-4 space-y-4">
      <h1 className="text-xl font-semibold">Add to a project</h1>
      {!loaded ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : files.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm">Nothing to add. Share a file to this app from another app's Share menu.</p>
          {(note.text || note.url) && <p className="text-xs text-slate-500 break-words">{note.text || note.url}</p>}
          <Link className="text-blue-600 underline" to="/dashboard">Go to the dashboard</Link>
        </div>
      ) : (
        <>
          <ul className="text-sm divide-y divide-slate-200 dark:divide-slate-700 rounded border border-slate-200 dark:border-slate-700">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{f.name}</span>
                  <span className="text-xs text-slate-500">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                </span>
                <select
                  aria-label={`Type for ${f.name}`}
                  className="shrink-0 rounded border border-slate-300 bg-white p-1 text-xs dark:border-slate-600 dark:bg-slate-800"
                  value={kinds[i] ?? 'document'}
                  onChange={e => setKinds(prev => prev.map((k, j) => (j === i ? e.target.value : k)))}
                >
                  {DIRECT_UPLOAD_KINDS.map(k => <option key={k} value={k}>{kindLabel(k)}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <div className="space-y-1">
            <span className="block text-sm font-medium">Project</span>
            <input
              type="search"
              aria-label="Search projects"
              placeholder="Search projects…"
              className="block w-full rounded border border-slate-300 bg-white p-2 dark:border-slate-600 dark:bg-slate-800"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <select
              aria-label="Project"
              className="block w-full rounded border border-slate-300 bg-white p-2 dark:border-slate-600 dark:bg-slate-800"
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
            >
              <option value="">{shown.length ? 'Choose a project…' : 'No matching projects'}</option>
              {shown.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button
            type="button"
            className="w-full rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
            disabled={!projectId || busy}
            onClick={add}
          >
            {busy ? 'Adding…' : 'Add to Documents'}
          </button>
        </>
      )}
    </div>
  );
};

export default ShareTargetPage;
