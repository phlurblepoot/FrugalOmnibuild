// src/pages/DocumentEditor.tsx — /tools/edit: the ONLYOFFICE document editor
// (replaces the old /tools/pdf and /tools/sheets editors; ONLYOFFICE Phase 1,
// docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).
//
// With ?fileId= it asks the server for a signed editor config, loads
// ONLYOFFICE's api.js from its public address and mounts the editor. The
// server decides everything that matters (edit or view, who the user is,
// where saves go); this page only hosts the iframe and handles the ways
// opening can fail. Without a fileId it is the landing page: recent files,
// open from Documents, or upload a file from the computer into a project.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useIsPresent } from 'motion/react';
import { AlertTriangle, ArrowLeft, Download, FileEdit, Upload, X } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, EmptyState } from '../components/ui';
import { AddFilesButton } from '../components/documents/AddFilesButton';
import { useToast } from '../components/Toast';
import { useTheme } from '../context/ThemeContext';
import {
  EditorOpenError, RestoreError, fetchFileBlob, forgetRecentDocument, getEditorHistory, getEditorHistoryData,
  getFileMeta, getInsertImageData, getRecentDocuments, openInEditor, recordRecentDocument, restoreFileVersion,
  saveEditorCopy, getMentionUsers, sendMentionNotifications, type RecentDocument,
} from '../utils/store';
import { editorPath, parseActionLinkParam } from '../utils/editorLinks';
import { downloadBlob } from '../utils/download';
import { loadDocsApi, type DocsEditorInstance } from '../utils/onlyofficeApi';
import { officeFormatByExt } from '../utils/officeFormats';
import { MimeIcon } from './documents/MimeIcon';
import { OpenFromComputerModal } from './documentEditor/OpenFromComputerModal';
import { InsertImagePicker } from './documentEditor/InsertImagePicker';

const editorUrl = (fileId: string) => `/tools/edit?fileId=${encodeURIComponent(fileId)}`;
const isAdmin = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; }
};
// One-time "type on a form" tip for PDFs, remembered per signed-in user in
// this browser.
const PDF_TIP_KEY = 'pdfTextTipDismissed';
const pdfTipKey = () => {
  try { return `${PDF_TIP_KEY}:${JSON.parse(localStorage.getItem('user') || '{}').id ?? 'anon'}`; } catch { return `${PDF_TIP_KEY}:anon`; }
};
const pdfTipSeen = () => { try { return localStorage.getItem(pdfTipKey()) === '1'; } catch { return false; } };
// The mobile top bar sits above every page on phones (AppShell); the editor
// fills whatever is left.
const FULL_HEIGHT = 'h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:h-dvh';

export const DocumentEditor: React.FC = () => {
  const [params] = useSearchParams();
  const present = useIsPresent();
  const fileId = params.get('fileId');
  // ?comment=: open at a comment (a notification's link, or a comment's "Get link").
  const comment = params.get('comment');
  // Nothing in a page that is on its way out: PageTransition used to mount a
  // newly entered route in the outgoing wrapper first, which started
  // ONLYOFFICE twice on every in-app "Open". It renders nothing there now
  // (see PageTransition.tsx); this keeps the editor safe either way.
  if (!present) return null;
  // Keyed: switching files (or following a link to a comment in the same
  // file) tears the old editor down and builds a new one.
  return fileId
    ? <EditorView key={`${fileId}|${comment ?? ''}`} fileId={fileId} actionLink={parseActionLinkParam(comment)} />
    : <EditorLanding />;
};

// ── The editor ───────────────────────────────────────────────────────────────

type ViewState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string; code?: string; status?: number };

let placeholderSeq = 0;

/** The date as ONLYOFFICE's version list shows it (it displays the string as given). */
const historyDate = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** refreshHistory's argument, from the server's version list. */
async function loadHistory(fileId: string): Promise<Record<string, unknown>> {
  try {
    const { currentVersion, versions } = await getEditorHistory(fileId);
    return {
      currentVersion,
      history: versions.map(v => ({
        version: v.version,
        key: v.key,
        created: historyDate(v.createdAt),
        ...(v.user ? { user: v.user } : {}),
        ...(v.changes !== undefined ? { changes: v.changes } : {}),
        ...(v.serverVersion !== undefined ? { serverVersion: v.serverVersion } : {}),
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't load the version history" };
  }
}

const EditorView: React.FC<{ fileId: string; actionLink: Record<string, unknown> | null }> = ({ fileId, actionLink }) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { mode: themeMode } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ViewState>({ phase: 'loading' });
  // Bumped to start the editor again: ONLYOFFICE has to be re-created when
  // its version history closes. After a restore that also opens the restored
  // file, in a fresh session.
  const [generation, setGeneration] = useState(0);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // The running editor, for the add-ons below that answer it later.
  const editorRef = useRef<DocsEditorInstance | null>(null);
  // Insert → Image → From storage: which insertion ONLYOFFICE asked for, while
  // the picker is open; and the project the document is filed in.
  const [inserting, setInserting] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  // One-time tip for a PDF opened for editing.
  const [pdfTip, setPdfTip] = useState(false);
  const dismissPdfTip = () => {
    setPdfTip(false);
    try { localStorage.setItem(pdfTipKey(), '1'); } catch { /* not remembered */ }
  };

  const insertImages = async (fileIds: string[]) => {
    const c = inserting ?? 'add';
    setInserting(null);
    try {
      const data = await getInsertImageData(fileId, c, fileIds);
      editorRef.current?.insertImage?.({ c: data.c, images: data.images, token: data.token });
      if (data.skipped.length) {
        toast(`Not inserted (the editor takes PNG, JPEG, GIF, BMP or TIFF): ${data.skipped.join(', ')}`, { type: 'warning' });
      }
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't insert the image", { type: 'error' });
    }
  };

  // Read once at open: ONLYOFFICE takes its theme when it starts, and
  // rebuilding the editor on a theme toggle would interrupt the person typing.
  const themeAtOpen = useRef(themeMode);
  // Only the first start goes to the linked comment; a restart after the
  // version history opens the document as usual.
  const actionLinkAtOpen = useRef(actionLink);
  const close = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/documents');
  }, [navigate]);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    let cancelled = false;
    let editor: DocsEditorInstance | null = null;
    const host = hostRef.current;
    setState({ phase: 'loading' });

    (async () => {
      try {
        const phone = window.matchMedia('(max-width: 767px)').matches;
        const opening = await openInEditor(fileId, {
          device: phone ? 'phone' : 'desktop',
          theme: themeAtOpen.current === 'dark' ? 'dark' : 'light',
          actionLink: actionLinkAtOpen.current,
        });
        actionLinkAtOpen.current = null;
        if (cancelled) return;
        try {
          await loadDocsApi(opening.publicUrl);
        } catch (e) {
          throw new EditorOpenError(
            `Couldn't load the editor from ${opening.publicUrl} (${e instanceof Error ? e.message : 'unknown error'}).`,
            0, 'script',
          );
        }
        if (cancelled || !host || !window.DocsAPI) return;
        // ONLYOFFICE swaps its placeholder for an iframe, so the placeholder is
        // a plain DOM node React never renders or reconciles.
        const placeholder = document.createElement('div');
        placeholder.id = `oo-editor-${++placeholderSeq}`;
        host.appendChild(placeholder);
        const canRestore = opening.file.mode === 'edit';
        const editing = opening.file.mode === 'edit';
        setProjectId(opening.file.projectId ?? null);
        setPdfTip(opening.file.ext?.toLowerCase() === 'pdf' && editing && !pdfTipSeen());
        const restart = () => { if (!cancelled) setGeneration(g => g + 1); };
        editor = new window.DocsAPI.DocEditor(placeholder.id, {
          ...opening.config,
          events: {
            // The editor's own Close button (customization.close).
            onRequestClose: () => closeRef.current(),
            // File → Version History (ONLYOFFICE Phase 2).
            onRequestHistory: async () => {
              const history = await loadHistory(fileId);
              if (!cancelled) editor?.refreshHistory?.(history);
            },
            onRequestHistoryData: async (event: { data: number }) => {
              const version = event.data;
              let data: Record<string, unknown>;
              try {
                data = await getEditorHistoryData(fileId, version);
              } catch (e) {
                data = { version, error: e instanceof Error ? e.message : "Couldn't open that version" };
              }
              if (!cancelled) editor?.setHistoryData?.(data);
            },
            // Leaving the history view needs a fresh editor (ONLYOFFICE docs).
            onRequestHistoryClose: restart,
            // Declaring this is what shows Restore; only where editing is allowed.
            ...(canRestore ? {
              onRequestRestore: async (event: { data: { version: number } }) => {
                const version = event.data.version;
                try {
                  const r = await restoreFileVersion(fileId, { version }, 'editor');
                  toastRef.current(`Version ${version} restored as version ${r.versionNumber}`, { type: 'success' });
                } catch (e) {
                  toastRef.current(e instanceof RestoreError ? e.message : "Couldn't restore that version", { type: 'error' });
                }
                // ONLYOFFICE waits for a fresh list either way.
                const history = await loadHistory(fileId);
                if (!cancelled) editor?.refreshHistory?.(history);
              },
            } : {}),
            // Insert → Image → From storage (declaring it shows the button).
            ...(editing ? {
              onRequestInsertImage: (event: { data?: { c?: string } }) => {
                if (!cancelled) setInserting(event.data?.c || 'add');
              },
            } : {}),
            // @mentions in comments (ONLYOFFICE Phase 5): who can be mentioned,
            // and telling them. Comments exist only where editing is allowed.
            ...(editing ? {
              onRequestUsers: async (event: { data?: { c?: string; id?: string[] } }) => {
                const c = event.data?.c ?? 'mention';
                let users: { id: string; name: string; email: string }[] = [];
                try { users = await getMentionUsers(fileId); } catch { /* an empty list */ }
                // 'info' asks about specific people (for avatars); the rest want the list.
                const wanted = c === 'info' && Array.isArray(event.data?.id) ? new Set(event.data!.id) : null;
                if (!cancelled) editor?.setUsers?.({ c, users: wanted ? users.filter(u => wanted.has(u.id)) : users });
              },
              onRequestSendNotify: (event: { data?: { emails?: string[]; message?: string; actionLink?: unknown } }) => {
                const data = event.data ?? {};
                if (!data.emails?.length) return;
                sendMentionNotifications(fileId, { emails: data.emails, message: data.message, actionLink: data.actionLink })
                  .catch(() => toastRef.current("Couldn't notify the people you mentioned", { type: 'error' }));
              },
              // A comment's "Get link": a link into the app that opens this file at it.
              onMakeActionLink: (event: { data?: unknown }) => {
                editor?.setActionLink?.(`${window.location.origin}${editorPath(fileId, event.data)}`);
              },
            } : {}),
            // File → Save Copy as: file the converted copy in the project.
            onRequestSaveAs: async (event: { data: { url: string; title: string; fileType: string } }) => {
              try {
                const saved = await saveEditorCopy(fileId, event.data);
                toastRef.current(`Saved "${saved.name}" to ${saved.projectId ? "the project's" : 'company'} Documents`, { type: 'success' });
              } catch (e) {
                toastRef.current(e instanceof Error && e.message ? e.message : "Couldn't save the copy", { type: 'error' });
              }
            },
          },
        });
        editorRef.current = editor;
        recordRecentDocument({
          id: opening.file.id,
          name: opening.file.name || 'Document',
          mime: officeFormatByExt(opening.file.ext)?.mime ?? '',
        });
        setState({ phase: 'ready' });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof EditorOpenError) {
          if (e.status === 404) forgetRecentDocument(fileId);
          setState({ phase: 'error', message: e.message, code: e.code, status: e.status });
        } else {
          setState({ phase: 'error', message: e instanceof Error ? e.message : "Couldn't open the file" });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (editorRef.current === editor) editorRef.current = null;
      try { editor?.destroyEditor?.(); } catch { /* already gone */ }
      if (host) host.replaceChildren();
    };
  }, [fileId, generation]);

  return (
    <div className={`relative ${FULL_HEIGHT} bg-sunken`} data-testid="document-editor">
      <div ref={hostRef} className="absolute inset-0" data-testid="document-editor-host" />
      {state.phase === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-soft" data-testid="document-editor-loading">
          Opening the editor…
        </div>
      )}
      {state.phase === 'error' && <OpenError fileId={fileId} state={state} onBack={close} />}
      {state.phase === 'ready' && pdfTip && (
        <div
          role="status"
          data-testid="pdf-text-tip"
          className="absolute bottom-4 left-1/2 z-10 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 items-start gap-3 rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-ink shadow-lg"
        >
          <p className="min-w-0 flex-1">
            <span className="font-semibold">Tip:</span> To type on a form without a box: click <b>Edit PDF</b>, then <b>Insert → Text Box</b>.
          </p>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-ink-faint hover:bg-hover hover:text-ink"
            aria-label="Dismiss tip"
            onClick={dismissPdfTip}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <InsertImagePicker
        open={inserting !== null}
        onClose={() => setInserting(null)}
        projectId={projectId}
        onPick={ids => { void insertImages(ids); }}
      />
    </div>
  );
};

const OpenError: React.FC<{
  fileId: string;
  state: Extract<ViewState, { phase: 'error' }>;
  onBack: () => void;
}> = ({ fileId, state, onBack }) => {
  const { toast } = useToast();
  const setupProblem = state.code === 'not-configured' || state.code === 'onlyoffice-unreachable' || state.code === 'script';
  const missing = state.status === 404;

  const download = async () => {
    try {
      const meta = await getFileMeta(fileId);
      downloadBlob(await fetchFileBlob(fileId), meta?.name || 'document');
    } catch {
      toast('Download failed', { type: 'error' });
    }
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center p-4" data-testid="document-editor-error">
      <Card className="w-full max-w-lg">
        <CardBody className="space-y-3">
          <div className="flex items-center gap-2 text-base font-semibold text-ink">
            <AlertTriangle size={18} className="text-amber-500" />
            {missing ? 'File not found' : "Couldn't open this file"}
          </div>
          <p className="text-sm text-ink-soft">{missing ? 'It may have been deleted or moved.' : state.message}</p>
          {setupProblem && (isAdmin()
            ? <p className="text-sm text-ink-soft">Check <Link className="text-accent-600 underline" to="/settings?tab=document-editor">Settings → Document Editor</Link> to see what's wrong.</p>
            : <p className="text-sm text-ink-soft">Ask an admin to check Settings → Document Editor.</p>)}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="secondary" onClick={onBack}><ArrowLeft size={15} /> Back</Button>
            {!missing && state.status !== 403 && (
              <Button variant="secondary" onClick={() => void download()}><Download size={15} /> Download instead</Button>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
};

// ── Landing: no file chosen yet ─────────────────────────────────────────────

const EditorLanding: React.FC = () => {
  const navigate = useNavigate();
  const [recent, setRecent] = useState<RecentDocument[]>(() => getRecentDocuments());
  const [uploadOpen, setUploadOpen] = useState(false);

  const forget = (id: string) => {
    forgetRecentDocument(id);
    setRecent(getRecentDocuments());
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8" data-testid="document-editor-landing">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-ink"><FileEdit size={22} className="text-accent-600" /> Document editor</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Open a PDF, Word, Excel or PowerPoint file. Several people can edit the same file at once, and saves go into the file's version history.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <AddFilesButton
          label="Open from Documents"
          accept="office"
          multi={false}
          variant="primary"
          onPick={rows => { const r = rows[0]; if (r) navigate(editorUrl(r.id)); }}
        />
        <Button variant="secondary" onClick={() => setUploadOpen(true)}><Upload size={15} /> Open from computer</Button>
      </div>
      <Card>
        <CardHeader title="Recently opened" />
        <CardBody className={recent.length ? 'p-0' : undefined}>
          {recent.length === 0 ? (
            <EmptyState title="Nothing opened yet" description="Files you open here are listed for quick access." />
          ) : (
            <ul className="divide-y divide-edge" data-testid="recent-documents">
              {recent.map(r => (
                <li key={r.id} className="flex items-center gap-3 px-5 py-3">
                  <MimeIcon mime={r.mime} />
                  <button className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-accent-600" onClick={() => navigate(editorUrl(r.id))}>
                    {r.name}
                  </button>
                  <span className="hidden text-xs text-ink-faint sm:inline">{new Date(r.at).toLocaleDateString()}</span>
                  <button className="rounded p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Remove from this list" aria-label={`Remove ${r.name} from recent`} onClick={() => forget(r.id)}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <OpenFromComputerModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={id => { setUploadOpen(false); navigate(editorUrl(id)); }}
      />
    </div>
  );
};
