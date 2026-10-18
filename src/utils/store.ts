import { Project, TakeoffTemplate, ProjectNote, Customer } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { computeTakeoffTotals } from '../pages/project/proposal/proposalGenerator';
import { calculateTakeoffTotalCost } from './math';
import { CLIENT_SESSION_ID } from './clientSession';
import type { ItemSendPayload } from './itemSend';
import type { SendResult, ProjectThreadRow } from '../pages/mail/types';
import { dedupeInFlight } from './dedupeFetch';

export const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'X-Session-Id': CLIENT_SESSION_ID,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
};

// Photo and file links (<img src>, pdf.js) can't send the Authorization header,
// so the server signs them in by an HttpOnly media cookie carrying the same
// token (server/auth.ts). Signing in sets it; a session from before it
// existed (only the token in localStorage) trades the token for it as the app
// starts. Resolves once that is done, refused or offline, or after `waitMs`
// whatever the server is doing — never rejects.
const MEDIA_SESSION_WAIT_MS = 3000;
export const startMediaSession = (waitMs = MEDIA_SESSION_WAIT_MS): Promise<void> => {
  const token = localStorage.getItem('token');
  if (!token) return Promise.resolve();
  const traded = fetch('/api/auth/media-session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).then(() => {}, () => {});
  return Promise.race([traded, new Promise<void>(resolve => setTimeout(resolve, waitMs))]);
};

/** Signing out: the server clears the media cookie (keepalive, so it survives
 *  the page navigating away). The caller forgets the token itself. */
export const endMediaSession = (): void => {
  try {
    void fetch('/api/auth/logout', { method: 'POST', keepalive: true }).catch(() => {});
  } catch { /* nothing to clear without a network */ }
};

export const getImageUrl = (id: string) => {
  return `/api/images/${id}/raw`;
};

/** A photo shrunk for tiles and lists (a few tens of KB); the server sends
 *  anything it can't shrink as the original. `version` busts the browser's
 *  cache when a file gets new content under the same id. */
export const getImageThumbUrl = (id: string, version?: string | number) =>
  `/api/images/${id}/thumb${version !== undefined ? `?v=${encodeURIComponent(String(version))}` : ''}`;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// HTTP statuses that indicate the server is willing to retry the same request.
// 401/4xx (other than 408/429) are caller errors — retrying won't help.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Wraps fetch with a per-attempt timeout (via AbortController) and exponential-
// backoff retries for network failures and transient server responses. Designed
// for slow/flaky connections where a single transient drop should not lose
// pages mid-PDF-upload.
const fetchWithRetry = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<Response> => {
  // Writes are never auto-retried: a retried PUT can carry a stale body and
  // the version handshake would reject it confusingly (and POSTs aren't
  // idempotent). Reads stay retried for flaky connections.
  const method = (init.method || 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const { timeoutMs = 60_000, retries: requestedRetries = 3 } = opts;
  const retries = isWrite ? 0 : requestedRetries;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        // Drain the body so the connection can be reused for the retry.
        try { await res.body?.cancel(); } catch { /* ignore */ }
        await sleep(Math.min(1000 * Math.pow(2, attempt), 8000));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 8000));
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network error');
};

/** What handleResponse throws for a non-OK response. Carries the status so a
 *  caller can tell a definitive answer (404: no such thing) from a transient
 *  one (502, offline) — the message alone cannot. */
export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export const handleResponse = async (res: Response) => {
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    // Already on the sign-in page (another request's 401 got here first, or
    // this page moved there itself): leave its address alone, or a reload to
    // plain /login would drop the ?next= return target.
    if (window.location.pathname !== '/login') {
      // Shared files are waiting on the share page; sign in and come straight back.
      window.location.href = window.location.pathname === '/share-target'
        ? `/login?next=${encodeURIComponent('/share-target?shared=1')}`
        : '/login';
    }
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new HttpError(err.error || 'Request failed', res.status);
  }
  return res;
};

export class ConflictError extends Error {
  constructor(public projectId: string) {
    super('Project was changed elsewhere');
    this.name = 'ConflictError';
  }
}

export const getSettings = async (): Promise<Record<string, string>> => {
  const res = await fetch('/api/settings');
  await handleResponse(res);
  return await res.json();
};

export const saveSettings = async (settings: Record<string, string>): Promise<void> => {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(settings)
  });
  await handleResponse(res);
};

export const getUserPreferences = async (): Promise<Record<string, string>> => {
  const res = await fetch('/api/user-preferences', {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return await res.json();
};

export const saveUserPreferences = async (prefs: Record<string, string>): Promise<void> => {
  const res = await fetch('/api/user-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(prefs),
  });
  await handleResponse(res);
};

// Saves are serialized per project: a save that fires while another is in
// flight waits for it, then sends with the freshest version we know. This
// keeps rapid fire-and-forget call sites (measurement edits) from racing
// themselves into spurious 409s.
const saveQueues = new Map<string, Promise<void>>();
// Highest version this tab has confirmed with the server, per project.
// Heals call sites that pass stale/throwaway objects: a genuinely stale
// TAB still 409s (the other tab's bumps are never in this map).
const latestVersions = new Map<string, number>();

// Lets non-saveProject callers (the realtime layer) feed the same
// only-raise-ever guard: e.g. a measurement-op ack or a canvas-join backfill
// bumping the known version without going through a save.
export function noteProjectVersion(projectId: string, version: number): void {
  if (version > (latestVersions.get(projectId) ?? 0)) {
    latestVersions.set(projectId, version);
  }
}

export const saveProject = (project: Project): Promise<void> => {
  const prev = saveQueues.get(project.id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => doSaveProject(project));
  saveQueues.set(project.id, run);
  return run;
};

async function doSaveProject(project: Project): Promise<void> {
  const known = latestVersions.get(project.id) ?? 0;
  const version = Math.max(project.version ?? 0, known) || undefined;
  const payload = version !== undefined && version !== project.version
    ? { ...project, version }
    : project;
  const res = await fetchWithRetry('/api/projects/' + project.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(payload)
  });
  if (res.status === 409) {
    window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId: project.id } }));
    throw new ConflictError(project.id);
  }
  await handleResponse(res);
  const body = await res.json().catch(() => null);
  if (body && typeof body.version === 'number') {
    project.version = body.version;
    latestVersions.set(project.id, body.version);
  }
}

export const createProject = async (project: Project): Promise<void> => {
  const res = await fetchWithRetry('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  await handleResponse(res);
  const body = await res.json().catch(() => null);
  project.version = body && typeof body.version === 'number' ? body.version : 1;
  latestVersions.set(project.id, project.version);
};

export const getProject = async (id: string): Promise<Project | null> => {
  const res = await fetchWithRetry('/api/projects/' + id, { headers: getAuthHeaders() });
  if (res.status === 404) return null;
  await handleResponse(res);
  const project = await res.json();
  if (project && typeof project.version === 'number') {
    latestVersions.set(project.id, project.version);
  }
  return project;
};

export const getAllProjects = async (): Promise<Project[]> => {
  const res = await fetch('/api/projects', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

/** What a project holds, by kind — only the kinds it has any of, e.g.
 *  { documents: 12, invoices: 2 } (server/projectStore.ts projectDataSummary).
 *  Someone who isn't an admin gets billing, proposals and time folded into
 *  `otherRecords`. */
export type ProjectDataSummary = Record<string, number>;

/** Thrown for the server's 409 `project_has_data`: the project has documents
 *  or records, so it can only be archived (spec 2026-10-07-project-delete-guard). */
export class ProjectHasDataError extends Error {
  constructor(public summary: ProjectDataSummary) {
    super('This project has documents or records. Archive it instead.');
    this.name = 'ProjectHasDataError';
  }
}

/** Whether a project may be deleted (only one with nothing in it may), and
 *  what's in it — so a page can offer Archive instead of a doomed Delete. */
export const getProjectDeleteCheck = async (id: string): Promise<{ canDelete: boolean; summary: ProjectDataSummary }> => {
  const res = await fetchWithRetry(`/api/projects/${encodeURIComponent(id)}/delete-check`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const deleteProject = async (id: string): Promise<void> => {
  const res = await fetch('/api/projects/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if (body?.error === 'project_has_data') throw new ProjectHasDataError(body.summary ?? {});
  }
  await handleResponse(res);
};

export const saveImage = async (
  id: string,
  dataUrl: string,
  opts?: { kind?: string; projectId?: string },
): Promise<void> => {
  // Per-page images can be several MB, so allow a longer timeout than the
  // default for callers on slow connections.
  const qs = new URLSearchParams();
  if (opts?.kind) qs.set('kind', opts.kind);
  if (opts?.projectId) qs.set('projectId', opts.projectId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetchWithRetry(`/api/images${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ id, data: dataUrl })
  }, { timeoutMs: 120_000 });
  await handleResponse(res);
};

export const getImage = async (id: string): Promise<string | null> => {
  const res = await fetchWithRetry('/api/images/' + id, { headers: getAuthHeaders() });
  if (res.status === 404) return null;
  await handleResponse(res);
  const { data } = await res.json();
  return data;
};

export const saveFile = saveImage;
export const getFile = getImage;

// Attribution carried on every upload. sourceType/sourceId name the owning
// entity; with a kind that is single-instance the server versions that
// entity's existing document instead of creating a new row, so the returned
// fileId can differ from the id that was posted.
export interface FileUploadOpts {
  projectId?: string;
  kind?: string;
  name?: string;
  customerId?: string;
  sourceType?: string;
  sourceId?: string;
}

/** What happened to an old-format upload (.doc, .xls, Pages…; ONLYOFFICE
 *  Phase 4): converted to the modern format with the upload kept as version
 *  1, or kept as it came, with the reason. */
export type UploadConversion =
  | { status: 'converted'; from: string; to: string; name: string }
  | { status: 'failed'; from: string; to: string; message: string };

export interface UploadResult {
  fileId: string;
  versioned: boolean;
  conversion?: UploadConversion;
}

const uploadQuery = (opts?: FileUploadOpts): URLSearchParams => {
  const q = new URLSearchParams();
  if (opts?.projectId) q.set('projectId', opts.projectId);
  if (opts?.kind) q.set('kind', opts.kind);
  if (opts?.name) q.set('name', opts.name);
  if (opts?.customerId) q.set('customerId', opts.customerId);
  if (opts?.sourceType) q.set('sourceType', opts.sourceType);
  if (opts?.sourceId) q.set('sourceId', opts.sourceId);
  return q;
};

// Older servers answered these uploads with a bare { success: true }; fall
// back to the posted id so a stale deployment keeps working.
const readUploadResult = async (res: Response, postedId: string): Promise<UploadResult> => {
  try {
    const body = await res.json() as { fileId?: string; versioned?: boolean; conversion?: UploadConversion };
    return { fileId: body?.fileId || postedId, versioned: !!body?.versioned, ...(body?.conversion ? { conversion: body.conversion } : {}) };
  } catch {
    return { fileId: postedId, versioned: false };
  }
};

// Streams a Blob/File to the server without going through a base64 dataUrl,
// avoiding the ~4× in-browser memory blowup that base64 + JSON.stringify
// produce for large PDFs (which can OOM Chrome on plan-set uploads). The
// server base64-encodes once before storing so the file appears in the same
// images table and the existing /api/images/:id/raw read path works unchanged.
export const saveBinaryFile = async (
  id: string,
  blob: Blob,
  opts?: FileUploadOpts,
): Promise<UploadResult> => {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
    ...getAuthHeaders(),
  };
  const qs = uploadQuery(opts).toString();
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers,
    body: blob,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await readUploadResult(res, id);
};
// Real delete (server/documents.ts's deleteDocument guard: 409s unless the
// row is an unsourced direct upload — see documentsPolicy.ts). Superseded the
// old no-op stub once the Documents page needed an actual delete affordance.
export const deleteFile = async (id: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
};

// Template functions
export const saveTemplate = async (template: TakeoffTemplate): Promise<void> => {
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(template)
  });
  await handleResponse(res);
};

export const getTemplates = async (): Promise<TakeoffTemplate[]> => {
  const res = await fetch('/api/templates', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const deleteTemplate = async (id: string): Promise<void> => {
  const res = await fetch('/api/templates/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
};

// ── Mail accounts ────────────────────────────────────────────────────────────
// Outbound email goes through the sending user's connected mail account
// (Settings → Mail). The old per-user SMTP settings are gone.
export interface MailAccountSummary {
  id: string;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  isDefault: number;
  status: string;
  unreadCount: number;
}

export const getMailAccounts = async (): Promise<MailAccountSummary[]> => {
  const res = await fetch('/api/mail/accounts', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

// The account a send would go out through. Mirrors the rule the server applies
// in server/mail/sendService (usable-first, default preferred) so the Send
// button and the send route never disagree about whether a send can happen.
export const pickSendableAccount = (list: MailAccountSummary[]): MailAccountSummary | null => {
  const usable = list.filter(a => a.status === 'ok' || a.status === 'syncing');
  return usable.find(a => a.isDefault) ?? usable[0] ?? null;
};

/** Everything an item send route accepts. `to` and `fileId` are the only
 *  required parts; subject/body fall back to the route's own defaults, and
 *  html (the composer's rich text) supersedes the legacy plain-text `body`. */
export interface ItemSendBody extends Partial<ItemSendPayload> {
  to: string;
  fileId: string;
  /** Legacy plain text, still accepted server-side for API callers. */
  body?: string;
  /** Legacy alias for `body` (the pre-composer proposal/invoice routes). */
  message?: string;
}

/** What every item send route returns once the provider has accepted the mail.
 *  `effectsSkipped` names the item statuses the server could NOT move, so the
 *  composer can warn instead of letting a half-applied send pass unnoticed. */
export type ItemSendResult = SendResult & { success: boolean };

export const NO_MAIL_ACCOUNT_REASON = 'Connect a mail account in Settings → Mail';

// The DocumentActionsBar `send.blockedReason` for a user with nowhere to send
// from; undefined once any account is usable.
export const mailSendBlockedReason = (list: MailAccountSummary[]): string | undefined =>
  pickSendableAccount(list) === null ? NO_MAIL_ACCOUNT_REASON : undefined;

export const getProjectNotes = async (projectId: string): Promise<ProjectNote | null> => {
  const res = await fetch(`/api/projects/${projectId}/notes`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const saveProjectNotes = async (projectId: string, note: ProjectNote): Promise<void> => {
  const res = await fetch(`/api/projects/${projectId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(note)
  });
  await handleResponse(res);
};

// ── Share links (ONLYOFFICE Phase 7: expiry, stopping, several files) ──────

/** How long a new link lasts: 7, 30 (the default) or 90 days, or never. */
export type ShareExpiry = 7 | 30 | 90 | null;
export const SHARE_EXPIRY_CHOICES: { days: ShareExpiry; label: string }[] = [
  { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: null, label: 'Never' },
];

/** What a new link opens (see server/shares.ts). */
export type ShareTarget =
  | { type: 'file'; resourceId: string }
  | { type: 'page'; resourceId: string }
  | { type: 'pages'; resourceId: string }
  | { type: 'files'; fileIds: string[] };

export interface ShareLink {
  id: string;
  type: string;
  name: string | null;
  createdAt: number;
  expiresAt: number | null;
  createdBy: string | null;
  createdByName: string | null;
  /** For a several-files link: how many files it opens. */
  fileCount: number;
}

async function shareJson<T>(res: Response, fallback: string): Promise<T> {
  if (res.status === 401) await handleResponse(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || fallback);
  }
  return res.json();
}

/** A new link; never reuses an old one. */
export const createShareLink = async (
  target: ShareTarget, name: string, expiresInDays: ShareExpiry = 30,
): Promise<{ id: string; expiresAt: number | null }> => shareJson(await fetch('/api/shares', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
  body: JSON.stringify({ ...target, name, expiresInDays }),
}), "Couldn't create the link");

/** A file's working links (its own, and several-files links it is in). */
export const listShareLinks = async (fileId: string): Promise<ShareLink[]> =>
  (await shareJson<{ shares: ShareLink[] }>(await fetch(`/api/shares?fileId=${encodeURIComponent(fileId)}`, { headers: { ...getAuthHeaders() } }), "Couldn't load the links")).shares;

export const setShareLinkExpiry = async (id: string, expiresInDays: ShareExpiry): Promise<{ expiresAt: number | null }> => shareJson(await fetch(`/api/shares/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
  body: JSON.stringify({ expiresInDays }),
}), "Couldn't change the expiry");

/** "Stop sharing": the link then says it was turned off. */
export const stopShareLink = async (id: string): Promise<void> => {
  await shareJson(await fetch(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { ...getAuthHeaders() } }), "Couldn't stop sharing");
};

/** The public address of a link: the Public Host URL from Settings, else this site. */
export const shareUrlFor = (id: string, publicHost?: string | null): string =>
  `${(publicHost || window.location.origin).replace(/\/$/, '')}/share/${id}`;

export interface SharedFileInfo { name: string; mime: string; size: number; viewer: boolean; missing?: boolean }
export interface ShareInfo {
  type: string;
  name: string;
  count?: number;
  viewer?: boolean;
  mime?: string | null;
  expiresAt?: number | null;
  /** A several-files link's documents, in order. */
  files?: SharedFileInfo[];
}

/** Why a link doesn't open: expired, turned off, or never existed. */
export class ShareLinkError extends Error {
  constructor(message: string, public code: 'expired' | 'revoked' | 'missing' | 'error') { super(message); }
}

export const getShareInfo = async (shareId: string): Promise<ShareInfo> => {
  const res = await fetch(`/api/share/${shareId}/info`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body.code === 'expired' || body.code === 'revoked' || body.code === 'missing' ? body.code : 'error';
    throw new ShareLinkError(body.error || 'This share link is invalid or has expired.', code);
  }
  return res.json();
};

// ── Recently opened projects (client-only, newest first) ─────────────────────

export interface RecentProject { id: string; name: string; at: number; }
const RECENTS_KEY = 'recentProjects';

export const getRecentProjects = (): RecentProject[] => {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; }
};

export const recordRecentProject = (id: string, name: string): void => {
  try {
    const list = getRecentProjects().filter(r => r.id !== id);
    list.unshift({ id, name, at: Date.now() });
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 8)));
  } catch { /* ignore */ }
};

// ── Global search (command palette) ──────────────────────────────────────────

export interface SearchResult {
  type: 'project' | 'page' | 'takeoff';
  id: string;
  title: string;
  subtitle?: string;
  projectId?: string;
  pageId?: string;
}

export const searchAll = async (q: string): Promise<SearchResult[]> => {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: getAuthHeaders() });
  await handleResponse(res);
  const { results } = await res.json();
  return results;
};

// ── Storage usage ───────────────────────────────────────────────────────────

export interface StorageStats {
  databaseBytes: number;
  breakdown: { images: number; projects: number; templates: number; notes: number; checklists: number };
  imageCount: number;
  projectCount: number;
  projects: { id: string; name: string; totalBytes: number }[];
}

export interface ProjectStorage {
  totalBytes: number;
  dataBytes: number;
  imageBytes: number;
  noteBytes: number;
  imageCount: number;
}

export const getStorageStats = async (): Promise<StorageStats> => {
  const res = await fetch('/api/storage/stats', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getProjectStorage = async (id: string): Promise<ProjectStorage> => {
  const res = await fetch(`/api/projects/${id}/storage`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getStorageOrphans = async (): Promise<{ count: number; bytes: number }> => {
  const res = await fetch('/api/storage/orphans', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const cleanupStorageOrphans = async (): Promise<{ deleted: number; bytesFreed: number }> => {
  const res = await fetch('/api/storage/orphans/cleanup', { method: 'POST', headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

// Human-readable byte size, e.g. 1536 -> "1.5 KB".
export const formatBytes = (bytes: number): string => {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// ── Backup & restore (spec docs/superpowers/specs/2026-09-12-backup-restore-design.md) ──
//
// Every read goes through fetchWithRetry so a backup page left open on a flaky
// LAN keeps refreshing; the writes (run / settings / disconnect) are POSTs and
// PUTs that fetchWithRetry deliberately never retries.
export interface BackupRun { id: string; target: 'local' | 'drive'; trigger: 'manual' | 'schedule'; startedAt: number; finishedAt: number | null; status: 'running' | 'ok' | 'error'; snapshotId: string | null; objectsAdded: number; bytesWritten: number; warnings: string[]; error: string | null }
export interface BackupSnapshot { id: string; createdAt: number; appVersion: string; schemaVersion: number; counts: { files: number; bytes: number }; warnings: number }
export interface BackupSchedule { enabled: boolean; hour: number; minute: number }
/** A run in flight. `percent` is 0–100 and only ever goes up. */
export interface BackupProgress {
  runId: string; target: 'local' | 'drive'; trigger: 'manual' | 'schedule';
  phase: 'database' | 'scanning' | 'files' | 'snapshot' | 'pruning';
  percent: number; filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number;
}
export interface BackupStatus {
  root: string; rootIsDefault: boolean;
  lastRun: { local: BackupRun | null; drive: BackupRun | null }; running: BackupRun | null;
  totals: { snapshots: number; objects: number; bytes: number };
  nextRunAt: { local: number | null; drive: number | null };
  schedule: { local: BackupSchedule; drive: BackupSchedule }; keep: { local: number; drive: number };
  progress: BackupProgress[];
  drive: { connected: true; email: string; needsReconnect: boolean } | { connected: false; configurable: boolean };
  /** What the setup guide shows; redirect URIs are null until APP_PUBLIC_URL is set. */
  setup: { publicUrl: string | null; googleClientId: boolean; googleClientSecret: boolean; redirectUris: { backup: string; restore: string } | null };
}
/** One warning from a snapshot's manifest, matched to the file it names while that file still exists. */
export interface BackupSnapshotWarning { message: string; fileId: string | null; fileName: string | null; projectName: string | null }

/** Thrown for the server's 409 `backup_running` so the UI can say "already
 *  running" instead of showing a generic failure for a harmless collision. */
export class BackupRunningError extends Error {
  constructor() { super('A backup is already running'); this.name = 'BackupRunningError'; }
}

const backupJson = (method: string, url: string, body?: unknown, opts?: { timeoutMs?: number }) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, opts);

// The download and OAuth-start routes are followed by the browser itself (a
// link or a redirect), which cannot carry an Authorization header — those
// routes accept the token as a query param, like the mail attachment routes.
const tokenParam = () => `token=${encodeURIComponent(localStorage.getItem('token') ?? '')}`;

export const getSetupState = async (): Promise<{ fresh: boolean }> => {
  // Unauthenticated on purpose: the login page asks before anyone can sign in.
  // An unreachable server is not a fresh install, so failures read as "not fresh".
  try {
    const res = await fetch('/api/setup/state');
    return res.ok ? await res.json() : { fresh: false };
  } catch {
    return { fresh: false };
  }
};

/** The same read, but honest about failure: it throws when the server cannot
 *  be reached or answers badly, instead of folding that into `fresh: false`.
 *  The restore screen needs that distinction — while the container restarts
 *  onto the restored database the server is simply gone, and a swallowed
 *  error would read as "the restore is finished". */
export const getSetupStateStrict = async (): Promise<{ fresh: boolean }> => {
  const r = await fetch('/api/setup/state');
  if (!r.ok) throw new Error(`setup state ${r.status}`);
  return r.json();
};

export const getBackupStatus = async (): Promise<BackupStatus> => {
  const res = await fetchWithRetry('/api/backup/status', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const runBackup = async (target: 'local' | 'drive'): Promise<{ runId: string }> => {
  const res = await backupJson('POST', '/api/backup/run', { target });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'backup_running') throw new BackupRunningError();
  }
  await handleResponse(res);
  return res.json();
};

export const getBackupRuns = async (): Promise<BackupRun[]> => {
  const res = await fetchWithRetry('/api/backup/runs', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getBackupSnapshots = async (target: 'local' | 'drive'): Promise<BackupSnapshot[]> => {
  const res = await fetchWithRetry(`/api/backup/snapshots?target=${target}`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getBackupProgress = async (): Promise<BackupProgress[]> => {
  const res = await fetchWithRetry('/api/backup/progress', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getBackupSnapshotWarnings = async (target: 'local' | 'drive', id: string): Promise<BackupSnapshotWarning[]> => {
  const res = await fetchWithRetry(`/api/backup/snapshots/${encodeURIComponent(id)}/warnings?target=${target}`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const backupDownloadUrl = (id: string): string =>
  `/api/backup/snapshots/${encodeURIComponent(id)}/download?${tokenParam()}`;

export const saveBackupSettings = async (s: { schedule?: Partial<BackupStatus['schedule']>; keep?: BackupStatus['keep'] }): Promise<void> => {
  await handleResponse(await backupJson('PUT', '/api/backup/settings', s));
};

export const disconnectBackupDrive = async (): Promise<void> => {
  await handleResponse(await backupJson('DELETE', '/api/backup/drive'));
};

export const backupDriveStartUrl = (): string => `/api/backup/drive/start?${tokenParam()}`;

// ── ONLYOFFICE document editor (docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md) ──

export type OnlyofficeCheckStatus = 'ok' | 'failed' | 'skipped';
export interface OnlyofficeCheck { status: OnlyofficeCheckStatus; message: string }
export interface OnlyofficeStatus {
  configured: boolean;
  problems: { variable: string; problem: string }[];
  publicUrl: string | null;
  internalUrl: string | null;
  appInternalUrl: string | null;
  version: string | null;
  checks: { appToOnlyoffice: OnlyofficeCheck; onlyofficeToApp: OnlyofficeCheck };
}

/** Admin connection check. Slow by nature (it runs a conversion round trip),
 *  so it is not retried: a retry would only repeat the same wait. */
export const getOnlyofficeStatus = async (): Promise<OnlyofficeStatus> => {
  const res = await fetchWithRetry('/api/onlyoffice/status', { headers: getAuthHeaders() }, { retries: 0 });
  await handleResponse(res);
  return res.json();
};

/** What POST /api/onlyoffice/config/:fileId answers: the signed config for
 *  `new DocsAPI.DocEditor(...)`, where to load api.js from, and the file. */
export interface EditorOpening {
  publicUrl: string;
  config: Record<string, unknown>;
  file: { id: string; name: string | null; projectId: string | null; kind: string; ext: string; mode: 'edit' | 'view'; editable: boolean };
}

/** Why the editor couldn't open a file, with the server's reason code
 *  ('not-configured' | 'unsupported' | 'onlyoffice-unreachable' | …). */
export class EditorOpenError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'EditorOpenError';
  }
}

/** ONLYOFFICE as a read-only viewer (Phase 6): a mail attachment or a shared file. */
export interface ViewerOpening {
  publicUrl: string;
  config: Record<string, unknown>;
  file: { name: string; ext: string };
}

async function viewerOpening(res: Response, fallback: string): Promise<ViewerOpening> {
  if (res.status === 401) await handleResponse(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new EditorOpenError(body.error || fallback, res.status, body.code);
  }
  return res.json();
}

/** The viewer for a Word, Excel or PowerPoint mail attachment. */
export const openAttachmentViewer = async (
  messageId: string, attId: string, opts: { device: 'desktop' | 'phone'; theme: 'light' | 'dark' },
): Promise<ViewerOpening> => viewerOpening(
  await fetchWithRetry(`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attId)}/viewer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(opts),
  }),
  "Couldn't open the attachment",
);

/** The embedded viewer for a share link (public: no sign-in); `index` picks
 *  one file of a several-files link. */
export const openShareViewer = async (
  shareId: string, opts: { device: 'desktop' | 'phone'; theme: 'light' | 'dark' }, index?: number,
): Promise<ViewerOpening> => {
  const which = index === undefined ? '' : `/${index}`;
  const res = await fetch(`/api/share/${encodeURIComponent(shareId)}/viewer${which}?device=${opts.device}&theme=${opts.theme}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new EditorOpenError(body.error || "Couldn't open the viewer", res.status, body.code);
  }
  return res.json();
};

export const openInEditor = async (
  fileId: string,
  // actionLink: open at a comment (from a notification or a comment's link).
  opts: { device: 'desktop' | 'phone'; theme: 'light' | 'dark'; actionLink?: Record<string, unknown> | null },
): Promise<EditorOpening> => {
  const res = await fetchWithRetry(`/api/onlyoffice/config/${encodeURIComponent(fileId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(opts),
  });
  if (res.status === 401) await handleResponse(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new EditorOpenError(body.error || "Couldn't open the file", res.status, body.code);
  }
  return res.json();
};

// ── Version history (ONLYOFFICE Phase 2) ──────────────────────────────────

/** Deletes one older version. Admins, or whoever made that version. */
export const deleteFileVersion = async (fileId: string, versionId: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`, {
    method: 'DELETE',
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
};

/** Why a restore didn't happen, with the server's reason code
 *  ('open-in-editor' | 'save-timeout' | 'current' | …) and, when the file is
 *  open, who has it open. */
export class RestoreError extends Error {
  constructor(message: string, public status: number, public code?: string, public users: string[] = []) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** Restores an older version as a NEW version on top; nothing is lost. `from`
 *  says where the person is: only someone inside the open editor may restore a
 *  file that is open there. */
export const restoreFileVersion = async (
  fileId: string,
  target: { versionId: string } | { version: number },
  from: 'documents' | 'editor',
): Promise<{ versionNumber: number; restoredFrom: number }> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(fileId)}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ ...target, from }),
  }, { timeoutMs: 60_000 });
  if (res.status === 401) await handleResponse(res);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new RestoreError(body.error || "Couldn't restore that version", res.status, body.code, body.users ?? []);
  return body;
};

/** One entry of the editor's version list (GET /api/onlyoffice/history/:id). */
export interface EditorHistoryVersion {
  version: number;
  key: string;
  createdAt: number;
  user: { id: string; name: string } | null;
  origin: string | null;
  changes?: unknown;
  serverVersion?: unknown;
}

export const getEditorHistory = async (fileId: string): Promise<{ currentVersion: number; versions: EditorHistoryVersion[] }> => {
  const res = await fetchWithRetry(`/api/onlyoffice/history/${encodeURIComponent(fileId)}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return res.json();
};

/** The signed object for the editor's setHistoryData. The change-log link in
 *  it is fetched by the browser, so the server builds it on this page's
 *  address. */
export const getEditorHistoryData = async (fileId: string, version: number): Promise<Record<string, unknown>> => {
  const q = new URLSearchParams({ origin: window.location.origin });
  const res = await fetchWithRetry(`/api/onlyoffice/history/${encodeURIComponent(fileId)}/${version}?${q.toString()}`, {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return res.json();
};

// ── Document library (ONLYOFFICE Phase 3) ─────────────────────────────────

export interface LibraryItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  createdBy: string | null;
}
export interface DocumentTemplate extends LibraryItem { ext: 'docx' | 'xlsx' | 'pdf' }
export interface Signature extends LibraryItem { isDefault: boolean }

const jsonRequest = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetchWithRetry(url, {
    ...init,
    headers: { ...(init.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...getAuthHeaders(), ...(init.headers || {}) },
  });
  await handleResponse(res);
  return res.json();
};
const uploadTo = <T>(url: string, blob: Blob, name: string): Promise<T> =>
  jsonRequest<T>(`${url}?name=${encodeURIComponent(name)}`, {
    method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  });

/** A new document from a blank file or a template; returns the stored file. */
export const createNewDocument = (input: {
  type: 'docx' | 'xlsx' | 'pdf'; templateId?: string; name: string; projectId?: string; kind: string;
}): Promise<{ fileId: string; name: string }> =>
  jsonRequest('/api/documents/new', { method: 'POST', body: JSON.stringify(input) });

export const listDocumentTemplates = (): Promise<DocumentTemplate[]> => jsonRequest('/api/document-templates');
export const uploadDocumentTemplate = (file: File): Promise<DocumentTemplate> => uploadTo('/api/document-templates', file, file.name);
export const addLetterheadTemplate = (): Promise<DocumentTemplate> => jsonRequest('/api/document-templates/letterhead', { method: 'POST' });
export const renameDocumentTemplate = (id: string, name: string): Promise<DocumentTemplate> =>
  jsonRequest(`/api/document-templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const deleteDocumentTemplate = (id: string): Promise<void> =>
  jsonRequest(`/api/document-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listCompanyStamps = (): Promise<LibraryItem[]> => jsonRequest('/api/company-stamps');
export const uploadCompanyStamp = (png: Blob, name: string): Promise<LibraryItem> => uploadTo('/api/company-stamps', png, name);
export const renameCompanyStamp = (id: string, name: string): Promise<LibraryItem> =>
  jsonRequest(`/api/company-stamps/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const deleteCompanyStamp = (id: string): Promise<void> =>
  jsonRequest(`/api/company-stamps/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Your own signatures, oldest first, the default flagged. */
export const listSignatures = (): Promise<Signature[]> => jsonRequest('/api/signatures');
export const addSignature = (png: Blob, name: string): Promise<Signature> => uploadTo('/api/signatures', png, name);
export const updateSignature = (id: string, patch: { name?: string; isDefault?: true }): Promise<Signature> =>
  jsonRequest(`/api/signatures/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteSignature = (id: string): Promise<void> =>
  jsonRequest(`/api/signatures/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Signed data for the editor's insertImage (Insert → Image → From storage).
 *  `skipped` names picked images the editor can't insert (e.g. WebP). */
export const getInsertImageData = async (
  fileId: string, c: string, fileIds: string[],
): Promise<{ c: string; images: { fileType: string; url: string }[]; token: string; skipped: string[] }> => {
  const res = await fetchWithRetry(`/api/onlyoffice/insert-image/${encodeURIComponent(fileId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ c, fileIds }),
  });
  await handleResponse(res);
  return res.json();
};

/** Files a copy ONLYOFFICE made (File → Save Copy as) in the document's project. */
export const saveEditorCopy = async (
  fileId: string, copy: { url: string; title: string; fileType: string },
): Promise<{ fileId: string; name: string; projectId: string | null }> => {
  const res = await fetchWithRetry(`/api/onlyoffice/save-copy/${encodeURIComponent(fileId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(copy),
  }, { timeoutMs: 120_000 });
  await handleResponse(res);
  return res.json();
};

// Recently opened documents (client-only, newest first) — the editor's
// landing list. Same shape and idiom as recent projects above.
export interface RecentDocument { id: string; name: string; mime: string; at: number }
const RECENT_DOCS_KEY = 'recentDocuments';

export const getRecentDocuments = (): RecentDocument[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_DOCS_KEY) || '[]'); } catch { return []; }
};

export const recordRecentDocument = (doc: { id: string; name: string; mime: string }): void => {
  try {
    const list = getRecentDocuments().filter(r => r.id !== doc.id);
    list.unshift({ ...doc, at: Date.now() });
    localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(list.slice(0, 8)));
  } catch { /* ignore */ }
};

export const forgetRecentDocument = (id: string): void => {
  try { localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(getRecentDocuments().filter(r => r.id !== id))); } catch { /* ignore */ }
};

// ── Fresh-install restore (the /restore screen, Task 11) ────────────────────

export const getRestoreSources = async (): Promise<{
  root: string;
  local: BackupSnapshot[];
  drive: { configurable: boolean; connected: boolean; email: string | null };
}> => {
  const res = await fetchWithRetry('/api/setup/restore/sources', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getRestoreDriveSnapshots = async (): Promise<BackupSnapshot[]> => {
  const res = await fetchWithRetry('/api/setup/restore/drive/snapshots', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const restoreDriveStartUrl = (): string => `/api/setup/restore/drive/start?${tokenParam()}`;

/** Thrown for the server's 409 `restore_running`. Not a failure: a restore is
 *  already under way on this server, so the screen keeps waiting for the
 *  restart instead of reporting an error. */
export class RestoreRunningError extends Error {
  constructor() { super('A restore is already running'); this.name = 'RestoreRunningError'; }
}

export const restoreSnapshot = async (p: { source: 'local' | 'upload' | 'drive'; snapshotId: string; uploadId?: string }): Promise<{ restarting: true; files: number; bytes: number }> => {
  // This one request does the whole restore before it answers: every file
  // copied and hash-checked, then the database staged. On a real data set
  // that is minutes. fetchWithRetry's one-minute default aborted it and the
  // screen claimed a failure while the server was still busy — so give it
  // hours, and let the server's own in-flight guard handle a second attempt.
  const res = await backupJson('POST', '/api/setup/restore', p, { timeoutMs: 6 * 60 * 60_000 });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'restore_running') throw new RestoreRunningError();
  }
  await handleResponse(res);
  return res.json();
};

/** XMLHttpRequest rather than fetch: a restore zip can be gigabytes and the
 *  upload progress bar is the only sign the browser is still working. */
export const uploadRestoreZip = (file: File, onProgress: (pct: number) => void): Promise<{ uploadId: string; snapshotId: string; summary: BackupSnapshot }> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/setup/restore/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const token = localStorage.getItem('token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((100 * e.loaded) / e.total)); };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error('Upload failed'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });

// ── Phase 3a: summaries, granular patches, activity, time ────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  contractor: string | null;
  customerId: string | null;
  address: string | null;
  bidDueDate: number | null;
  version: number;
  createdAt: number;
  updatedAt: number | null;
  archived: boolean;
  // Set only on archived projects whose bid was lost — drives the Archive
  // tab's "Lost" badge.
  lostBid?: boolean;
  pageCount: number;
  takeoffCount: number;
  pageIds: string[];
  openIssueCount: number;
  punchDone: number;
  punchTotal: number;
  contractValueCents?: number;
  invoiceCount?: number;
  // Admin-only (billing is gated server-side) — absent for non-admins.
  outstandingCents?: number;
}

export interface ProjectPatch {
  version: number;
  name?: string;
  status?: string;
  archived?: boolean;
  lostBid?: boolean;
  contractor?: string | null;
  address?: string | null;
  bidDueDate?: number | null;
}

export interface ActivityItem {
  id: string;
  projectId: string | null;
  userId: string | null;
  type: string;
  message: string;
  createdAt: number;
  projectName: string | null;
  username: string | null;
}

export interface TimeEntryLite {
  id: string;
  projectId: string | null;
  clockIn: number;
  clockOut: number | null;
  description: string;
}

export const getProjectsSummary = async (): Promise<ProjectSummary[]> => {
  const res = await fetchWithRetry('/api/projects/summary', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

// Granular field update with optimistic concurrency. Unlike saveProject, a
// 409 here does NOT dispatch the global project-conflict event — callers
// decide (list views refetch; ProjectView dispatches it themselves).
export const patchProject = async (
  id: string,
  patch: ProjectPatch
): Promise<{ version: number; status: string }> => {
  const res = await fetchWithRetry(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(patch),
  });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res);
  return await res.json();
};

export const getActivity = async (limit = 20, projectId?: string): Promise<ActivityItem[]> => {
  const qs = `limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`;
  const res = await fetchWithRetry(`/api/activity?${qs}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).items;
};

export const getMyTimeEntries = async (projectId?: string): Promise<TimeEntryLite[]> => {
  const url = projectId ? `/api/time-entries?projectId=${encodeURIComponent(projectId)}` : '/api/time-entries';
  const res = await fetchWithRetry(url, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

export const clockIn = async (projectId?: string): Promise<void> => {
  const res = await fetchWithRetry('/api/time-entries/clock-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ projectId: projectId ?? null }),
  });
  await handleResponse(res);
};

export const clockOut = async (): Promise<void> => {
  const res = await fetchWithRetry('/api/time-entries/clock-out', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({}),
  });
  await handleResponse(res);
};

// ── Phase 3b: project files, versions, drafts ────────────────────────────────

export interface ProjectFile {
  id: string;
  projectId: string | null;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  parentFileId: string | null;
  versionNumber: number;
  createdAt: number;
  /** User id of whoever made this version (null for older history). */
  createdBy?: string | null;
  /** 'editor' | 'restore' | null — see GeneratedDoc.versionOrigin. */
  versionOrigin?: string | null;
}

export const getProjectSummary = async (id: string): Promise<ProjectSummary | null> => {
  const res = await fetchWithRetry(`/api/projects/${encodeURIComponent(id)}/summary`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const getFileMeta = async (id: string): Promise<ProjectFile | null> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/meta`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const listFileVersions = async (id: string): Promise<ProjectFile[]> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/versions`, {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return await res.json();
};

// Upload a project document. Callers must record the RETURNED fileId, not the
// id this mints: for single-instance kinds the server may version the document
// the given source already owns and return that row's id instead.
export const uploadProjectFile = async (
  projectId: string,
  file: File,
  kind: string,
  opts?: Omit<FileUploadOpts, 'projectId' | 'kind' | 'name'>,
): Promise<UploadResult> => {
  const id = uuidv4();
  const qs = uploadQuery({ ...opts, projectId, kind, name: file.name }).toString();
  const res = await fetchWithRetry(`/api/files/${id}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...getAuthHeaders() },
    body: file,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await readUploadResult(res, id);
};

// Store a freshly generated document (PDF/XLSX) so Generate, Download and Send
// of the same entity converge on ONE living document: the source triple makes
// the server version the existing row rather than pile up duplicates.
export const persistGeneratedDocument = async (
  blob: Blob,
  opts: FileUploadOpts & { kind: string; name: string },
): Promise<UploadResult> => saveBinaryFile(uuidv4(), blob, opts);

// Authenticated binary fetch of a file's live content.
export const fetchFileBlob = async (id: string): Promise<Blob> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/content`, {
    headers: { ...getAuthHeaders() },
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await res.blob();
};

// ── Global Documents page (spec docs/superpowers/specs/2026-08-17-unified-documents-design.md) ──

export interface DocumentSource {
  type: string;
  id: string;
  label: string;
  href: string | null;
}

export interface DocumentRow {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  createdAt: number;
  versionNumber: number;
  archived: boolean;
  projectId: string | null;
  projectName: string | null;
  customerId: string | null;
  customerName: string | null;
  source: DocumentSource | null;
}

export interface DocumentFilters {
  projectIds?: string[];
  customerIds?: string[];
  kinds?: string[];
  mimes?: string[];
  q?: string;
  archived?: boolean;
  // Admin-only exclusive view — ignored by the server for non-admins. See
  // server/documents.ts DocumentFilters for the full semantics.
  unassigned?: boolean;
  limit?: number;
  offset?: number;
}

export const getDocuments = async (
  filters: DocumentFilters = {}
): Promise<{ rows: DocumentRow[]; total: number }> => {
  const p = new URLSearchParams();
  if (filters.projectIds?.length) p.set('projectIds', filters.projectIds.join(','));
  if (filters.customerIds?.length) p.set('customerIds', filters.customerIds.join(','));
  if (filters.kinds?.length) p.set('kinds', filters.kinds.join(','));
  if (filters.mimes?.length) p.set('mimes', filters.mimes.join(','));
  if (filters.q) p.set('q', filters.q);
  if (filters.archived) p.set('archived', '1');
  if (filters.unassigned) p.set('unassigned', '1');
  if (filters.limit != null) p.set('limit', String(filters.limit));
  if (filters.offset != null) p.set('offset', String(filters.offset));
  const res = await fetchWithRetry(`/api/documents?${p.toString()}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

// Single-entity lookup keyed by the owning entity (server/documents.ts's
// SourceDoc) — "does this invoice already have a generated PDF?" without
// browsing the full Documents list.
export interface GeneratedDoc {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  createdAt: number;
  versionNumber: number;
  /** 'editor' once edited in the Document Editor since it was generated,
   *  'restore' when an older version was restored; null straight after a
   *  generate (and from servers before ONLYOFFICE Phase 2). */
  versionOrigin?: string | null;
}

export const getDocumentBySource = async (
  q: { sourceType: string; sourceId: string; kind: string }
): Promise<GeneratedDoc | null> => {
  const p = new URLSearchParams({ sourceType: q.sourceType, sourceId: q.sourceId, kind: q.kind });
  const res = await fetchWithRetry(`/api/documents/by-source?${p.toString()}`, { headers: { ...getAuthHeaders() } });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const getDocumentsBySource = async (
  q: { sourceType: string; sourceIds: string[]; kind: string }
): Promise<Record<string, GeneratedDoc | null>> => {
  const p = new URLSearchParams({ sourceType: q.sourceType, kind: q.kind, sourceIds: q.sourceIds.join(',') });
  const res = await fetchWithRetry(`/api/documents/by-source?${p.toString()}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

// Archive/restore or re-type a file (server/documents.ts's patchDocument
// guard: kind may only move between direct-upload kinds; archived toggles
// freely). Returns the updated row's slim metadata.
export const patchFile = async (
  id: string,
  patch: { archived?: boolean; kind?: string },
): Promise<{ id: string; kind: string; archived: boolean }> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(patch),
  });
  await handleResponse(res);
  return await res.json();
};

// Merge PDFs: the chosen PDFs, in order, saved as one new document. Returns
// the new document's id and name.
export const mergePdfFiles = async (ids: string[], name?: string, projectId?: string): Promise<{ fileId: string; name: string }> => {
  const res = await fetchWithRetry('/api/files/merge-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ ids, ...(name ? { name } : {}), ...(projectId ? { projectId } : {}) }),
  });
  await handleResponse(res);
  return await res.json();
};

// Admin-managed custom document types (spec §Data model: settings.documentTypes
// JSON [{id,label}], files store the id). Saved through the general settings
// PUT path like every other admin setting — see Settings.tsx's other cards.
export interface CustomDocType {
  id: string;
  label: string;
}

export const getDocumentTypes = async (): Promise<CustomDocType[]> => {
  const s = await getSettings();
  try {
    const parsed = s.documentTypes ? JSON.parse(s.documentTypes) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const saveDocumentTypes = async (types: CustomDocType[]): Promise<void> => {
  await saveSettings({ documentTypes: JSON.stringify(types) });
};

// ── Phase 4a: billing ────────────────────────────────────────────────────────

export interface InvoiceLine {
  id?: string;
  description: string;
  qty: number;
  unitPrice: number;
}
export interface Payment {
  id: string;
  targetType: string;
  targetId: string;
  date: number | null;
  amount: number;
  method: string | null;
  note: string | null;
  createdAt: number;
  targetLabel?: string;
  /** Photos/PDFs on the payment (migration 43) — on the project payments list only. */
  attachmentCount?: number;
}
// A photo or PDF on a payment — a check image, a receipt, remittance advice
// (migration 43). Shown on the payment only. name/mime/size/kind/createdAt/
// versionNumber are the file's own, so a file deleted since reads as nulls.
export interface PaymentAttachment {
  id: string; fileId: string; sortOrder: number;
  name: string | null; mime: string | null; size: number | null;
  kind: string | null; createdAt: number | null; versionNumber: number | null;
}
// GET /api/payments/:id — the payment detail view.
export interface PaymentDetail extends Payment {
  targetLabel: string;
  projectId: string | null;
  attachments: PaymentAttachment[];
}
export interface InvoicePhoto {
  id: string;
  fileId: string;
  sortOrder: number;
}
// A stored PDF appended to the end of a record's generated PDF, after its
// photos, in sortOrder — invoices (migration 34); change orders, RFIs, issues
// and daily reports (migration 42). name/mime/size are the file's own, so a
// file deleted since reads as nulls.
export interface PdfAttachment { id: string; fileId: string; sortOrder: number; name: string | null; mime: string | null; size: number | null }
export interface Invoice {
  id: string;
  projectId: string;
  number: string | null;
  date: number | null;
  status: string; // draft | sent | paid
  terms: string | null;
  // Internal-only — never printed on the invoice PDF or included in invoice
  // emails (migration 33). A notes-only save does not bump `updatedAt` (see
  // below), so it can't affect the freshness chip.
  notes: string | null;
  version: number;
  createdAt: number;
  // Stamped server-side on every write (migration 30) — the "is the generated
  // PDF still current?" comparison in DocumentActionsBar reads it. notes-only
  // edits are exempt (server/billingStore.ts saveInvoice).
  updatedAt: number;
  lines: InvoiceLine[];
  payments: Payment[];
  // Appended to the generated invoice PDF (migration 34): photos as pages,
  // then attached PDFs, in sortOrder.
  photos: InvoicePhoto[];
  attachments: PdfAttachment[];
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}
export interface InvoiceListItem {
  id: string; projectId: string; number: string | null; date: number | null;
  status: string; terms: string | null; notes: string | null; version: number; createdAt: number;
  updatedAt: number;
  totalCents: number; paidCents: number; balanceCents: number;
}
export interface ChangeOrderLine {
  id?: string;
  description: string;
  qty: number;
  unitPrice: number;
}
export interface COPhoto {
  id: string;
  fileId: string;
  sortOrder: number;
}
export interface ChangeOrder {
  id: string;
  projectId: string;
  number: string | null;
  date: number | null;
  title: string | null;
  description: string | null;
  lumpSumAmount: number;
  scheduleImpactDays: number | null;
  status: string; // draft | sent | approved | rejected (legacy: pending)
  version: number;
  createdAt: number;
  updatedAt: number;
  amount: number; // canonical rolled-up dollar total (= (Σ line cents + lump-sum cents)/100)
  lines: ChangeOrderLine[];
  // Appended to the generated change order PDF: photos as pages, then the
  // attached PDFs (migration 42), in sortOrder.
  photos: COPhoto[];
  attachments: PdfAttachment[];
  totalCents: number;
  lumpSumCents: number;
}
export interface ChangeOrderListItem {
  id: string;
  projectId: string;
  number: string | null;
  date: number | null;
  title: string | null;
  description: string | null;
  lumpSumAmount: number;
  scheduleImpactDays: number | null;
  status: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  amount: number;
  totalCents: number;
}
export interface ChangeOrderInput {
  number?: string;
  date?: number | null;
  title?: string | null;
  description?: string;
  lumpSumAmount?: number;
  scheduleImpactDays?: number | null;
  lines?: { description: string; qty: number; unitPrice: number }[];
}
export interface BillingSummary {
  sovOriginalCents: number;
  hasSov: boolean;
  baseContractCents: number;
  approvedChangeCents: number;
  contractTotalCents: number;
  contractValueCents: number;
  invoiceTotalCents: number;
  invoicedCents: number;
  paid: { invoicesCents: number; payAppsCents: number };
  paidCents: number;
  invoiceOutstandingCents: number;
  outstandingCents: number;
  invoiceCount: number;
  changeOrderCount: number;
  payAppBilledCents: number;
  payAppOutstandingCents: number;
  payAppPaidCents: number;
  invoiceBilledCents: number;
  invoicePaidCents: number;
  invoiceOutstandingBilledCents: number;
}
export interface InvoiceInput {
  number?: string; date?: number | null; terms?: string; status?: string; notes?: string | null;
  lines: { description: string; qty: number; unitPrice: number }[];
}

const billingJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getInvoices = async (projectId: string): Promise<InvoiceListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/invoices`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getInvoice = async (id: string): Promise<Invoice> => {
  const res = await fetchWithRetry(`/api/invoices/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createInvoice = async (projectId: string, input: InvoiceInput): Promise<{ id: string; version: number }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/invoices`, input);
  await handleResponse(res); return res.json();
};
export const saveInvoice = async (id: string, invoice: Invoice): Promise<{ version: number }> => {
  const res = await billingJson('PUT', `/api/invoices/${id}`, invoice);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setInvoiceStatus = async (id: string, status: string): Promise<{ version: number }> => {
  const res = await billingJson('PATCH', `/api/invoices/${id}`, { status });
  await handleResponse(res); return res.json();
};
export const deleteInvoice = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/invoices/${id}`); await handleResponse(res);
};
export const addInvoicePhoto = async (invoiceId: string, fileId: string): Promise<void> => {
  const res = await billingJson('POST', `/api/invoices/${invoiceId}/photos`, { fileId }); await handleResponse(res);
};
export const removeInvoicePhoto = async (invoiceId: string, fileId: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/invoices/${invoiceId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const addInvoiceAttachment = async (invoiceId: string, fileId: string): Promise<void> => {
  const res = await billingJson('POST', `/api/invoices/${invoiceId}/attachments`, { fileId }); await handleResponse(res);
};
export const updateInvoiceAttachment = async (invoiceId: string, fileId: string, patch: { sortOrder: number }): Promise<void> => {
  const res = await billingJson('PATCH', `/api/invoices/${invoiceId}/attachments/${encodeURIComponent(fileId)}`, patch); await handleResponse(res);
};
export const removeInvoiceAttachment = async (invoiceId: string, fileId: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/invoices/${invoiceId}/attachments/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const getProjectPayments = async (projectId: string): Promise<Payment[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/payments`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const recordPayment = async (
  projectId: string,
  targetType: 'invoice' | 'payapp',
  targetId: string,
  input: { amount: number; date?: number | null; method?: string; note?: string }
): Promise<{ id: string }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/payments`, { targetType, targetId, ...input });
  await handleResponse(res); return res.json();
};
export const deletePayment = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/payments/${id}`); await handleResponse(res);
};
export const getPayment = async (id: string): Promise<PaymentDetail> => {
  const res = await fetchWithRetry(`/api/payments/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
// What it paid can't change — only these four.
export const updatePayment = async (
  id: string,
  input: { amount: number; date?: number | null; method?: string | null; note?: string | null },
): Promise<void> => {
  const res = await billingJson('PUT', `/api/payments/${id}`, input); await handleResponse(res);
};
export const addPaymentAttachment = async (paymentId: string, fileId: string): Promise<void> => {
  const res = await billingJson('POST', `/api/payments/${paymentId}/attachments`, { fileId }); await handleResponse(res);
};
export const removePaymentAttachment = async (paymentId: string, fileId: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/payments/${paymentId}/attachments/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const getChangeOrders = async (projectId: string): Promise<ChangeOrderListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/change-orders`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getChangeOrder = async (id: string): Promise<ChangeOrder> => {
  const res = await fetchWithRetry(`/api/change-orders/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
// The server ignores any passed `amount` — the total is rolled up server-side
// from lumpSumAmount + lines. (Legacy callers may still pass `amount`; harmless.)
export const createChangeOrder = async (
  projectId: string,
  input?: ChangeOrderInput & { amount?: number }
): Promise<{ id: string; version: number }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/change-orders`, input ?? {});
  await handleResponse(res); return res.json();
};
export const saveChangeOrder = async (id: string, changeOrder: ChangeOrder): Promise<{ version: number }> => {
  const res = await billingJson('PUT', `/api/change-orders/${id}`, changeOrder);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setChangeOrderStatus = async (id: string, status: string): Promise<void> => {
  const res = await billingJson('PATCH', `/api/change-orders/${id}`, { status }); await handleResponse(res);
};
export const deleteChangeOrder = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/change-orders/${id}`); await handleResponse(res);
};
export const addCOPhoto = async (coId: string, fileId: string): Promise<void> => {
  const res = await billingJson('POST', `/api/change-orders/${coId}/photos`, { fileId }); await handleResponse(res);
};
export const removeCOPhoto = async (coId: string, fileId: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/change-orders/${coId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const addCOAttachment = async (coId: string, fileId: string): Promise<void> => {
  const res = await billingJson('POST', `/api/change-orders/${coId}/attachments`, { fileId }); await handleResponse(res);
};
export const updateCOAttachment = async (coId: string, fileId: string, patch: { sortOrder: number }): Promise<void> => {
  const res = await billingJson('PATCH', `/api/change-orders/${coId}/attachments/${encodeURIComponent(fileId)}`, patch); await handleResponse(res);
};
export const removeCOAttachment = async (coId: string, fileId: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/change-orders/${coId}/attachments/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const sendChangeOrder = async (id: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await billingJson('POST', `/api/change-orders/${id}/send`, payload); await handleResponse(res); return res.json();
};
// ── Lien releases (Florida; server/lienReleaseRoutes.ts) ─────────────────────
export type LienRelease = import('../pages/project/billing/lienReleaseWording').LienRelease;
export interface LienReleasePrefill {
  paymentType: 'progress' | 'final';
  conditional: boolean;
  sourceType: 'payapp' | 'invoice' | null;
  sourceId: string | null;
  lienorName: string;
  lienorEntityType?: LienRelease['lienorEntityType'];
  lienorState?: string | null;
  customerName: string;
  ownerName: string;
  propertyDescription: string;
  amountCents: number;
  throughDate: string | null;
  releaseDate: string;
  signerName: string;
  signerTitle: string | null;
  conditionKind: 'check' | 'funds' | null;
  checkMaker: string | null;
  exceptions: string | null;
  /** The pay app or invoice it starts from: label, billed, paid, balance. */
  source: { label: string; totalCents: number; paidCents: number; balanceCents: number; contractSumToDateCents?: number } | null;
  warnings: string[];
}
export type LienReleaseInput = Partial<Omit<LienRelease, 'id' | 'projectId' | 'number' | 'status' | 'createdAt' | 'updatedAt'>>;
export interface LienReleasePrefillQuery {
  sourceType?: 'payapp' | 'invoice';
  sourceId?: string;
  paymentId?: string;
  paymentType?: 'progress' | 'final';
  conditional?: boolean;
}
export const getLienReleases = async (projectId: string): Promise<LienRelease[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/lien-releases`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getLienRelease = async (id: string): Promise<LienRelease> => {
  const res = await fetchWithRetry(`/api/lien-releases/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getLienReleasePrefill = async (projectId: string, q: LienReleasePrefillQuery): Promise<LienReleasePrefill> => {
  const params = new URLSearchParams();
  if (q.sourceType) params.set('sourceType', q.sourceType);
  if (q.sourceId) params.set('sourceId', q.sourceId);
  if (q.paymentId) params.set('paymentId', q.paymentId);
  if (q.paymentType) params.set('paymentType', q.paymentType);
  if (q.conditional !== undefined) params.set('conditional', q.conditional ? '1' : '0');
  const res = await fetchWithRetry(`/api/projects/${projectId}/lien-releases/prefill?${params}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createLienRelease = async (projectId: string, input: LienReleaseInput): Promise<{ id: string; number: string; version: number }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/lien-releases`, input);
  await handleResponse(res); return res.json();
};
export const saveLienRelease = async (id: string, input: LienReleaseInput): Promise<{ version: number }> => {
  const res = await billingJson('PUT', `/api/lien-releases/${id}`, input);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setLienReleaseStatus = async (id: string, status: 'void' | 'draft'): Promise<void> => {
  const res = await billingJson('PATCH', `/api/lien-releases/${id}/status`, { status }); await handleResponse(res);
};
export const makeLienReleaseUnconditional = async (id: string): Promise<{ id: string; number: string; version: number }> => {
  const res = await billingJson('POST', `/api/lien-releases/${id}/unconditional`, {});
  await handleResponse(res); return res.json();
};
export const deleteLienRelease = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/lien-releases/${id}`); await handleResponse(res);
};
export const sendLienRelease = async (id: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await billingJson('POST', `/api/lien-releases/${id}/send`, payload); await handleResponse(res); return res.json();
};
export const getBillingSummary = async (projectId: string): Promise<BillingSummary> =>
  dedupeInFlight(`billing-summary:${projectId}`, async () => {
    const res = await fetchWithRetry(`/api/projects/${projectId}/billing-summary`, { headers: { ...getAuthHeaders() } });
    await handleResponse(res); return res.json();
  });
/** Emails a pay application (its workbook first; ONLYOFFICE Phase 4). */
export const sendPayApp = async (id: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await billingJson('POST', `/api/aia/pay-apps/${id}/send`, payload);
  await handleResponse(res);
  return res.json();
};

/** Makes the pay app's workbook into its PDF (ONLYOFFICE converts it). */
export const makePayAppPdf = async (payAppId: string): Promise<{ fileId: string; name: string; versionNumber: number; changed: boolean }> => {
  const res = await fetchWithRetry(`/api/onlyoffice/pay-app-pdf/${encodeURIComponent(payAppId)}`, {
    method: 'POST', headers: { ...getAuthHeaders() },
  }, { timeoutMs: 150_000 });
  await handleResponse(res);
  return res.json();
};

export const sendInvoice = async (id: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await billingJson('POST', `/api/invoices/${id}/send`, payload);
  await handleResponse(res);
  return res.json();
};

// ── Phase 4b: issues ─────────────────────────────────────────────────────────

export interface IssuePhoto { id: string; fileId: string; sortOrder: number; }
export interface Issue {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  description: string | null;
  status: string; // open | sent | resolved
  version: number;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
  photos: IssuePhoto[];
  attachments: PdfAttachment[];        // appended to the issue report after the photos (migration 42)
}
export interface IssueListItem {
  id: string; projectId: string; number: number; title: string | null;
  description: string | null; status: string; version: number; sentAt: number | null;
  createdAt: number; updatedAt: number; photoCount: number;
}

const issueJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getIssues = async (projectId: string): Promise<IssueListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/issues`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getIssue = async (id: string): Promise<Issue> => {
  const res = await fetchWithRetry(`/api/issues/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createIssue = async (projectId: string, input: { title: string; description?: string }): Promise<{ id: string; number: number }> => {
  const res = await issueJson('POST', `/api/projects/${projectId}/issues`, input);
  await handleResponse(res); return res.json();
};
export const saveIssue = async (id: string, issue: Issue): Promise<{ version: number }> => {
  const res = await issueJson('PUT', `/api/issues/${id}`, issue);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setIssueStatus = async (id: string, status: string): Promise<void> => {
  const res = await issueJson('PATCH', `/api/issues/${id}`, { status }); await handleResponse(res);
};
export const deleteIssue = async (id: string): Promise<void> => {
  const res = await issueJson('DELETE', `/api/issues/${id}`); await handleResponse(res);
};
export const addIssuePhoto = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('POST', `/api/issues/${issueId}/photos`, { fileId }); await handleResponse(res);
};
export const removeIssuePhoto = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('DELETE', `/api/issues/${issueId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const addIssueAttachment = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('POST', `/api/issues/${issueId}/attachments`, { fileId }); await handleResponse(res);
};
export const updateIssueAttachment = async (issueId: string, fileId: string, patch: { sortOrder: number }): Promise<void> => {
  const res = await issueJson('PATCH', `/api/issues/${issueId}/attachments/${encodeURIComponent(fileId)}`, patch); await handleResponse(res);
};
export const removeIssueAttachment = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('DELETE', `/api/issues/${issueId}/attachments/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const sendIssue = async (id: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await issueJson('POST', `/api/issues/${id}/send`, payload); await handleResponse(res); return res.json();
};

// ── RFIs ─────────────────────────────────────────────────────────────────────

export interface RfiPhoto { id: string; fileId: string; sortOrder: number; }

// An emailed reply captured against a sent RFI, waiting for a human to accept
// or dismiss it. EVERY string here (the body text, the sender's display name,
// every attachment name) was typed by an outsider into an email: render it as
// text only — never as markup, never into a PDF/HTML template, and never build
// a path from an attachment name.
export interface RfiPendingReplyAttachment { attId: string; name: string; mime: string; size: number; }
export interface RfiPendingReply {
  threadKey: string;
  accountId: string;          // the RECEIVING user's mailbox — usually not the viewer's
  mailMessageId: string;
  messageIdHeader: string | null;
  from: { addr: string; name?: string };
  date: string;               // ISO
  text: string;
  attachments: RfiPendingReplyAttachment[];
  receivedAt: string;         // ISO
}

// pendingReply / responseSource / responseMessageIdHeader are optional on the
// client types purely so existing constructors of an Rfi (editors, fixtures)
// stay valid — the server always sends them.
export interface Rfi {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  question: string | null;
  specRef: string | null;
  drawingRef: string | null;
  attention: string | null;
  responseNeededBy: string | null; // ISO date (yyyy-mm-dd)
  responseText: string | null;
  responseFileId: string | null;
  status: string; // open | sent | answered | closed
  version: number;
  sentAt: number | null;
  answeredAt: number | null;
  createdAt: number;
  updatedAt: number;
  photos: RfiPhoto[];
  attachments: PdfAttachment[];              // appended to the RFI PDF after the photos (migration 42)
  pendingReply?: RfiPendingReply | null;
  responseSource?: string | null;            // 'email' once an emailed reply was accepted
  responseMessageIdHeader?: string | null;
  assigneeUserId?: string | null;            // internal "Assigned to" (ONLYOFFICE Phase 5)
  sentByUserId?: string | null;              // who last emailed it out
}
export interface RfiListItem {
  id: string; projectId: string; number: number; title: string | null;
  question: string | null; specRef: string | null; drawingRef: string | null;
  attention: string | null; responseNeededBy: string | null;
  responseText: string | null; responseFileId: string | null;
  status: string; version: number; sentAt: number | null; answeredAt: number | null;
  createdAt: number; updatedAt: number; photoCount: number;
  pendingReply?: RfiPendingReply | null;
  responseSource?: string | null;
  responseMessageIdHeader?: string | null;
}

const rfiJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getRfis = async (projectId: string): Promise<RfiListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/rfis`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getRfi = async (id: string): Promise<Rfi> => {
  const res = await fetchWithRetry(`/api/rfis/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createRfi = async (projectId: string, input: { title: string; question?: string }): Promise<{ id: string; number: number }> => {
  const res = await rfiJson('POST', `/api/projects/${projectId}/rfis`, input);
  await handleResponse(res); return res.json();
};
export const saveRfi = async (id: string, rfi: Rfi): Promise<{ version: number }> => {
  const res = await rfiJson('PUT', `/api/rfis/${id}`, rfi);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setRfiStatus = async (id: string, status: string): Promise<void> => {
  const res = await rfiJson('PATCH', `/api/rfis/${id}`, { status }); await handleResponse(res);
};
export const deleteRfi = async (id: string): Promise<void> => {
  const res = await rfiJson('DELETE', `/api/rfis/${id}`); await handleResponse(res);
};
export const addRfiPhoto = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${rfiId}/photos`, { fileId }); await handleResponse(res);
};
export const removeRfiPhoto = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('DELETE', `/api/rfis/${rfiId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const addRfiAttachment = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${rfiId}/attachments`, { fileId }); await handleResponse(res);
};
export const updateRfiAttachment = async (rfiId: string, fileId: string, patch: { sortOrder: number }): Promise<void> => {
  const res = await rfiJson('PATCH', `/api/rfis/${rfiId}/attachments/${encodeURIComponent(fileId)}`, patch); await handleResponse(res);
};
export const removeRfiAttachment = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('DELETE', `/api/rfis/${rfiId}/attachments/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const setRfiResponse = async (id: string, input: { fileId?: string; text?: string }): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${id}/response`, input); await handleResponse(res);
};
export const sendRfi = async (id: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await rfiJson('POST', `/api/rfis/${id}/send`, payload); await handleResponse(res); return res.json();
};

/** The pending reply was accepted or dismissed by someone else first. Distinct
 *  from a transport failure: the caller's move is to refresh, not to retry. */
export class NoPendingReplyError extends Error {
  constructor(message = 'No pending reply') { super(message); this.name = 'NoPendingReplyError'; }
}

// A 409 from either of these routes means one thing: the reply is no longer
// pending (someone else accepted or dismissed it). `code: 'no_pending_reply'`
// is the explicit marker, but the status alone is treated as sufficient —
// there is no other conflict these two routes can report, and depending on the
// marker made the client mis-handle a server that omitted it. Only an explicit
// version_conflict is passed through as an ordinary failure.
const rfiPendingReplyPost = async (id: string, action: 'accept' | 'dismiss', body: unknown): Promise<Response> => {
  const res = await rfiJson('POST', `/api/rfis/${id}/pending-reply/${action}`, body);
  if (res.status === 409) {
    const err = await res.json().catch(() => ({} as { error?: string; code?: string }));
    if (err.code === 'version_conflict') throw new HttpError(err.error || 'Request failed', 409);
    throw new NoPendingReplyError(err.error || 'No pending reply');
  }
  await handleResponse(res);
  return res;
};

/** Promotes the emailed reply into the recorded response. `text` overrides the
 *  reply's own body; `fileId` (NOT responseFileId) attaches a response document. */
export const acceptRfiPendingReply = async (
  id: string, input: { text?: string; fileId?: string } = {},
): Promise<{ status: string }> => {
  const res = await rfiPendingReplyPost(id, 'accept', input);
  return res.json();
};

export const dismissRfiPendingReply = async (id: string): Promise<void> => {
  await rfiPendingReplyPost(id, 'dismiss', {});
};

// ── Daily Reports ──────────────────────────────────────────────────────────

export interface DailyReportPhoto { id: string; fileId: string; sortOrder: number; }
export interface ManCountLine { type: string; count: number; }
export interface DailyWeatherHour { hour: string; tempF: number | null; condition: string; }
// A crew is a named tab on a project's Daily Reports page — the company's own
// crew or a sub's — and its own set of reports, one per date (migration 45).
export interface DailyReportCrew {
  id: string; projectId: string; name: string; sortOrder: number; createdAt: number; updatedAt: number;
  reportCount: number; // a crew with reports can be renamed, not deleted
}
export interface DailyReport {
  id: string; projectId: string; reportDate: string; jobName: string; contractorName: string;
  // The crew it was filed under. crewName is null only for a report whose
  // crew is gone (a deleted project's).
  crewId: string; crewName: string | null;
  // 'HH:MM' (24-hour); the weather covers it through 12 hours later. Null on
  // reports made before it existed (migration 44) — their weather is 6 AM–6 PM.
  startTime: string | null;
  weatherSummary: string; temperature: string; weatherHourly: DailyWeatherHour[];
  manCounts: ManCountLine[]; fieldNotes: string; issues: string;
  createdBy: string | null; createdAt: number; updatedAt: number; version: number;
  photos: DailyReportPhoto[];
  attachments: PdfAttachment[]; // appended to the daily report PDF after the photos (migration 42)
}
export interface DailyReportListItem {
  id: string; projectId: string; crewId: string; crewName: string | null;
  reportDate: string; jobName: string; contractorName: string; startTime: string | null;
  weatherSummary: string; temperature: string; manCounts: ManCountLine[];
  createdBy: string | null; createdAt: number; updatedAt: number; version: number; photoCount: number;
}
export class DateTakenError extends Error { constructor(public existingId: string) { super('date taken'); this.name = 'DateTakenError'; } }

const dailyJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getDailyReports = async (projectId: string): Promise<DailyReportListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/daily-reports`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getDailyReport = async (id: string): Promise<DailyReport> => {
  const res = await fetchWithRetry(`/api/daily-reports/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getDailyReportCrews = async (projectId: string): Promise<DailyReportCrew[]> => {
  // Listing makes the project's first crew ("Crew 1") when it has none yet.
  const res = await fetchWithRetry(`/api/projects/${projectId}/daily-report-crews`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
// A blank or duplicate name, or deleting a crew that has reports (or the
// last one), fails with the server's own explanation as the error message.
export const createDailyReportCrew = async (projectId: string, name: string): Promise<DailyReportCrew> => {
  const res = await dailyJson('POST', `/api/projects/${projectId}/daily-report-crews`, { name }); await handleResponse(res); return res.json();
};
export const renameDailyReportCrew = async (id: string, name: string): Promise<DailyReportCrew> => {
  const res = await dailyJson('PUT', `/api/daily-report-crews/${id}`, { name }); await handleResponse(res); return res.json();
};
export const deleteDailyReportCrew = async (id: string): Promise<void> => {
  const res = await dailyJson('DELETE', `/api/daily-report-crews/${id}`); await handleResponse(res);
};
export const createDailyReport = async (projectId: string, input: { crewId: string; reportDate: string; jobName?: string; contractorName?: string }): Promise<{ id: string }> => {
  const res = await dailyJson('POST', `/api/projects/${projectId}/daily-reports`, input);
  if (res.status === 409) {
    const b = await res.json().catch(() => ({} as any));
    if (b?.error === 'date_taken' && b.existingId) throw new DateTakenError(b.existingId);
    throw new ConflictError(projectId);
  }
  await handleResponse(res); return res.json();
};
export const saveDailyReport = async (id: string, report: Partial<DailyReport> & { version: number }): Promise<{ version: number }> => {
  const res = await dailyJson('PUT', `/api/daily-reports/${id}`, report);
  if (res.status === 409) {
    const b = await res.json().catch(() => ({} as any));
    if (b?.error === 'date_taken' && b.existingId) throw new DateTakenError(b.existingId);
    throw new ConflictError(id);
  }
  await handleResponse(res); return res.json();
};
export const deleteDailyReport = async (id: string): Promise<void> => {
  const res = await dailyJson('DELETE', `/api/daily-reports/${id}`); await handleResponse(res);
};
export const addDailyReportPhoto = async (id: string, fileId: string): Promise<void> => {
  const res = await dailyJson('POST', `/api/daily-reports/${id}/photos`, { fileId }); await handleResponse(res);
};
export const removeDailyReportPhoto = async (id: string, fileId: string): Promise<void> => {
  const res = await dailyJson('DELETE', `/api/daily-reports/${id}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const addDailyReportAttachment = async (id: string, fileId: string): Promise<void> => {
  const res = await dailyJson('POST', `/api/daily-reports/${id}/attachments`, { fileId }); await handleResponse(res);
};
export const updateDailyReportAttachment = async (id: string, fileId: string, patch: { sortOrder: number }): Promise<void> => {
  const res = await dailyJson('PATCH', `/api/daily-reports/${id}/attachments/${encodeURIComponent(fileId)}`, patch); await handleResponse(res);
};
export const removeDailyReportAttachment = async (id: string, fileId: string): Promise<void> => {
  const res = await dailyJson('DELETE', `/api/daily-reports/${id}/attachments/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const sendDailyReport = async (id: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await dailyJson('POST', `/api/daily-reports/${id}/send`, payload); await handleResponse(res); return res.json();
};
// `startTime` (HH:MM) starts the 12-hour window; without one the server uses
// 6 AM, the window reports had before start times existed.
export const getDailyWeather = async (projectId: string, date: string, startTime?: string | null): Promise<{ hourly: DailyWeatherHour[]; summary: string; temperature: string }> => {
  // No retries: a failing upstream (Open-Meteo/Nominatim) should fail fast
  // rather than the user waiting through ~4 retried upstream calls.
  const start = startTime ? `&start=${encodeURIComponent(startTime)}` : '';
  const res = await fetchWithRetry(`/api/projects/${projectId}/daily-weather?date=${encodeURIComponent(date)}${start}`, { headers: { ...getAuthHeaders() } }, { retries: 0 });
  if (res.status === 400) {
    const b = await res.json().catch(() => ({} as any));
    if (b?.error === 'no_address') throw new Error('no_address');
    throw new Error('weather_unavailable');
  }
  if (!res.ok) throw new Error('weather_unavailable');
  return res.json();
};

// ── Proposals (admin-only; spec 2026-08-28) ─────────────────────────────────

export type ProposalStatus = 'draft' | 'sent' | 'accepted' | 'declined';
export interface ProposalLine {
  id: string; sortOrder: number; kind: 'manual' | 'takeoff'; takeoffId: string | null;
  description: string; amountCents: number; derivedAmountCents: number | null;
  measurementSummary: string | null; isAlternate: boolean;
}
export interface ProposalLineInput extends Omit<ProposalLine, 'id' | 'sortOrder'> { id?: string }
export interface ProposalPhoto { id: string; fileId: string; sortOrder: number; caption: string | null }
export interface ProposalAttachment { id: string; fileId: string; sortOrder: number; name: string | null; mime: string | null; size: number | null }
export interface PaymentScheduleRow { description: string; percent: number | null; amountCents: number | null }
export interface ProposalSummary {
  id: string; projectId: string; number: number; revisedFromId: string | null; revisedFromNumber: number | null;
  status: ProposalStatus; legacy: boolean; title: string | null; validUntil: string | null;
  fontFamily: 'helvetica' | 'times' | 'courier' | null; coverNotes: string | null; terms: string | null;
  inclusions: string[]; exclusions: string[]; paymentSchedule: PaymentScheduleRow[] | null;
  showGrandTotal: boolean; includeCostDetail: boolean; includeSignature: boolean; highlightQuality: 'best' | 'email';
  fileId: string | null; signedFileId: string | null;
  sentAt: number | null; sentTo: { to: string; cc?: string; subject: string } | null;
  acceptedAt: number | null; declinedAt: number | null;
  version: number; createdBy: string | null; createdAt: number; updatedAt: number;
  totalCents: number; alternateCount: number; hasOverride: boolean; photoCount: number; attachmentCount: number;
}
export interface Proposal extends ProposalSummary { lines: ProposalLine[]; photos: ProposalPhoto[]; attachments: ProposalAttachment[] }
export interface OutstandingProposal extends ProposalSummary { projectName: string | null }
export interface ProposalSaveInput {
  version: number; title?: string | null; validUntil?: string | null; fontFamily?: string | null;
  coverNotes?: string | null; terms?: string | null; inclusions?: string[]; exclusions?: string[];
  paymentSchedule?: PaymentScheduleRow[] | null; showGrandTotal?: boolean; includeCostDetail?: boolean;
  includeSignature?: boolean; highlightQuality?: 'best' | 'email'; lines?: ProposalLineInput[];
}
export class ProposalLockedError extends Error { constructor() { super('Proposal is locked'); this.name = 'ProposalLockedError'; } }
const proposalJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, { method, headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
// 409s carry a `code`: locked (not a draft) vs version_conflict (stale save).
const handleProposalResponse = async (res: Response, id: string) => {
  if (res.status === 409) {
    // The body is consumed here rather than via res.clone() — every call
    // site either throws immediately after (this branch) or never reads
    // the body again, so there's nothing left to clone for.
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'locked') throw new ProposalLockedError();
    throw new ConflictError(id);
  }
  await handleResponse(res);
};
export const getProposals = async (projectId: string): Promise<ProposalSummary[]> => {
  const res = await proposalJson('GET', `/api/projects/${projectId}/proposals`); await handleResponse(res); return res.json();
};
export const getOutstandingProposals = async (): Promise<OutstandingProposal[]> => {
  const res = await proposalJson('GET', '/api/proposals/outstanding'); await handleResponse(res); return res.json();
};
export const getProposal = async (id: string): Promise<Proposal> => {
  const res = await proposalJson('GET', `/api/proposals/${id}`); await handleResponse(res); return res.json();
};
export const createProposal = async (projectId: string, input: { takeoffIds?: string[]; revisedFromId?: string; carryPhotos?: boolean; carryAttachments?: boolean } & Partial<Omit<ProposalSaveInput, 'version'>>) => {
  const res = await proposalJson('POST', `/api/projects/${projectId}/proposals`, input); await handleResponse(res);
  return res.json() as Promise<{ id: string; number: number; version: number }>;
};
// updatedAt comes back with version so the editor can adopt both — see the
// server-side note on saveProposal in server/proposalStore.ts.
export const saveProposal = async (id: string, input: ProposalSaveInput): Promise<{ version: number; updatedAt: number }> => {
  const res = await proposalJson('PUT', `/api/proposals/${id}`, input); await handleProposalResponse(res, id); return res.json();
};
export const deleteProposal = async (id: string): Promise<void> => {
  const res = await proposalJson('DELETE', `/api/proposals/${id}`); await handleProposalResponse(res, id);
};
export const setProposalFile = async (id: string, fileId: string): Promise<void> => {
  const res = await proposalJson('POST', `/api/proposals/${id}/file`, { fileId }); await handleProposalResponse(res, id);
};
const sub = (name: 'photos' | 'attachments') => ({
  add: async (id: string, fileId: string) => { const res = await proposalJson('POST', `/api/proposals/${id}/${name}`, { fileId }); await handleProposalResponse(res, id); },
  update: async (id: string, fileId: string, patch: Record<string, unknown>) => { const res = await proposalJson('PATCH', `/api/proposals/${id}/${name}/${encodeURIComponent(fileId)}`, patch); await handleProposalResponse(res, id); },
  remove: async (id: string, fileId: string) => { const res = await proposalJson('DELETE', `/api/proposals/${id}/${name}/${encodeURIComponent(fileId)}`); await handleProposalResponse(res, id); },
});
const photosApi = sub('photos'); const attachmentsApi = sub('attachments');
export const addProposalPhoto = photosApi.add;
export const updateProposalPhoto = (id: string, fileId: string, patch: { caption?: string | null; sortOrder?: number }) => photosApi.update(id, fileId, patch);
export const removeProposalPhoto = photosApi.remove;
export const addProposalAttachment = attachmentsApi.add;
export const updateProposalAttachment = (id: string, fileId: string, patch: { sortOrder: number }) => attachmentsApi.update(id, fileId, patch);
export const removeProposalAttachment = attachmentsApi.remove;
export const setProposalStatus = async (id: string, status: 'accepted' | 'declined', signedFileId?: string | null): Promise<{ version: number }> => {
  const res = await proposalJson('POST', `/api/proposals/${id}/status`, { status, signedFileId: signedFileId ?? null }); await handleResponse(res); return res.json();
};
export const sendProposal = async (id: string, payload: ItemSendBody): Promise<ItemSendResult & { version: number }> => {
  const res = await proposalJson('POST', `/api/proposals/${id}/send`, payload); await handleProposalResponse(res, id); return res.json();
};

export const sendPunchReport = async (projectId: string, payload: ItemSendBody): Promise<ItemSendResult> => {
  const res = await punchJson('POST', `/api/projects/${projectId}/send-punch`, payload); await handleResponse(res); return res.json();
};

// ── Phase 4c: punch list ──────────────────────────────────────────────────────

export interface PunchPhoto { id: string; fileId: string; stage: string; sortOrder: number; }
export interface PunchItem {
  id: string; projectId: string; area: string; description: string;
  done: number; sortOrder: number; version: number; createdAt: number;
  photos: PunchPhoto[];
}
export interface PunchListItem {
  id: string; projectId: string; area: string; description: string;
  done: number; sortOrder: number; version: number; createdAt: number;
  photoCount: number;
}

const punchJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getPunchItems = async (projectId: string): Promise<PunchListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/punch`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getPunchItem = async (id: string): Promise<PunchItem> => {
  const res = await fetchWithRetry(`/api/punch/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createPunchItem = async (projectId: string, input: { area: string; description: string }): Promise<{ id: string }> => {
  const res = await punchJson('POST', `/api/projects/${projectId}/punch`, input);
  await handleResponse(res); return res.json();
};
export const savePunchItem = async (id: string, item: PunchItem): Promise<{ version: number }> => {
  const res = await punchJson('PUT', `/api/punch/${id}`, { area: item.area, description: item.description, version: item.version });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setPunchDone = async (id: string, done: boolean): Promise<void> => {
  const res = await punchJson('PATCH', `/api/punch/${id}`, { done }); await handleResponse(res);
};
export const deletePunchItem = async (id: string): Promise<void> => {
  const res = await punchJson('DELETE', `/api/punch/${id}`); await handleResponse(res);
};
export const addPunchPhoto = async (itemId: string, fileId: string, stage: string): Promise<void> => {
  const res = await punchJson('POST', `/api/punch/${itemId}/photos`, { fileId, stage }); await handleResponse(res);
};
export const removePunchPhoto = async (itemId: string, fileId: string): Promise<void> => {
  const res = await punchJson('DELETE', `/api/punch/${itemId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};

// ── Phase 4c-2: task list ─────────────────────────────────────────────────────

export interface TaskPhoto { id: string; fileId: string; stage: string; sortOrder: number; }
export interface AssignableUser { id: string; username: string; role: string; }
export interface Task {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  projectId: string | null; customerId: string | null;
  projectName: string | null; customerName: string | null;
  version: number; createdAt: number; createdBy: string | null;
  photos: TaskPhoto[];
}
export interface TaskListItem {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  projectId: string | null; customerId: string | null;
  projectName: string | null; customerName: string | null;
  version: number; createdAt: number; createdBy: string | null;
  photoCount: number;
}

const taskJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getAssignableUsers = async (): Promise<AssignableUser[]> => {
  const res = await fetchWithRetry('/api/users/list', { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getTasks = async (params?: { projectId?: string; customerId?: string; assigneeUserId?: string }): Promise<TaskListItem[]> => {
  const qs = new URLSearchParams();
  if (params?.projectId) qs.set('projectId', params.projectId);
  if (params?.customerId) qs.set('customerId', params.customerId);
  if (params?.assigneeUserId) qs.set('assigneeUserId', params.assigneeUserId);
  const url = qs.toString() ? `/api/tasks?${qs.toString()}` : '/api/tasks';
  const res = await fetchWithRetry(url, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getTask = async (id: string): Promise<Task> => {
  const res = await fetchWithRetry(`/api/tasks/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createTask = async (input: { category?: string; title: string; assigneeUserId?: string | null; dueDate?: string | null; notes?: string; projectId?: string | null; customerId?: string | null }): Promise<{ id: string }> => {
  const res = await taskJson('POST', '/api/tasks', input);
  await handleResponse(res); return res.json();
};
export const saveTask = async (id: string, task: Task): Promise<{ version: number }> => {
  const res = await taskJson('PUT', `/api/tasks/${id}`, {
    category: task.category,
    title: task.title,
    notes: task.notes,
    assigneeUserId: task.assigneeUserId,
    dueDate: task.dueDate,
    projectId: task.projectId,
    customerId: task.customerId,
    version: task.version,
  });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setTaskStatus = async (id: string, status: string): Promise<void> => {
  const res = await taskJson('PATCH', `/api/tasks/${id}`, { status }); await handleResponse(res);
};
export const deleteTask = async (id: string): Promise<void> => {
  const res = await taskJson('DELETE', `/api/tasks/${id}`); await handleResponse(res);
};
export const addTaskPhoto = async (taskId: string, fileId: string, stage: string): Promise<void> => {
  const res = await taskJson('POST', `/api/tasks/${taskId}/photos`, { fileId, stage }); await handleResponse(res);
};
export const removeTaskPhoto = async (taskId: string, fileId: string): Promise<void> => {
  const res = await taskJson('DELETE', `/api/tasks/${taskId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};

// ── Phase 7: AIA progress billing (G702/G703 — Schedule of Values) ─────────────
// Money is INTEGER CENTS end-to-end; formatting/division happens in the UI.

export type SovLineType = 'item' | 'header' | 'blank';
// Absent = item: fixtures and payloads from before migration 35 carry no type.
export const lineTypeOf = (l: { lineType?: SovLineType | null }): SovLineType => l.lineType ?? 'item';

export interface AiaSovLine {
  id: string; projectId: string; itemNo: string | null; description: string;
  scheduledValueCents: number; retainagePercent: number | null;
  isChangeOrder: number; changeOrderId: string | null;
  sortOrder: number; version: number; createdAt: number;
  lineType?: SovLineType;
}
export interface AiaPayApp {
  id: string; projectId: string; number: number;
  periodTo: string | null; applicationDate: string | null;
  retainagePercent: number; storedRetainagePercent: number;
  releasedRetainagePoints: number;
  // updatedAt drives the document bar's "Excel out of date" chip; migration 30
  // added the column (backfilled from createdAt) and every pay-app read is a
  // SELECT *, so it comes back on both the list and detail payloads.
  status: string; version: number; createdAt: number; updatedAt: number;
}
// getPayApps list row: adds Amount = G702 L8 (live for drafts, as-billed for
// finalized apps); Balance = Amount − payments, null for drafts (not yet
// billed — the UI renders "—"). Mirrors the Invoice/InvoiceListItem split.
export interface AiaPayAppListItem extends AiaPayApp {
  totalCents: number; paidCents: number; balanceCents: number | null;
}
// getPayApp's `app` — carries the payments recorded against this app. Same
// row shape as Invoice['payments'] (id/date/amount/method/note).
export type AiaPayAppDetail = AiaPayApp & { payments: Payment[] };
export interface AiaPayAppLine {
  id: string; payAppId: string; sovLineId: string;
  percentComplete: number; storedMaterialsCents: number; createdAt: number;
}
// Mirrors server/aiaStore.ts G703Row.
export interface AiaG703Row {
  sovLineId: string; itemNo: string | null; description: string;
  isChangeOrder: number; lineType?: SovLineType; scheduledValueCents: number;
  previousCents: number; thisPeriodCents: number; storedCents: number;
  totalToDateCents: number; percentComplete: number;
  balanceToFinishCents: number; retainageCents: number;
}
// Mirrors server/aiaStore.ts G702.
export interface AiaG702 {
  L1originalContractCents: number;
  L2changeOrdersCents: number;
  L3contractSumToDateCents: number;
  L4totalCompletedStoredCents: number;
  L5aRetainageWorkCents: number;
  L5bRetainageStoredCents: number;
  L5retainageCents: number;
  L6earnedLessRetainageCents: number;
  L7lessPreviousCents: number;
  L8currentPaymentDueCents: number;
  L9balanceToFinishCents: number;
  changeOrders: { additionsCents: number; deductionsCents: number; netCents: number };
  // Mirrors server/aiaStore.ts G702['retainage'] — the effective-rate release
  // summary (Task 1). effectiveWorkPercent is null in perLine mode because a
  // single number can't represent per-line rates.
  retainage: {
    mode: 'uniform' | 'perLine';
    baseWorkPercent: number;
    cumulativeReleasedPoints: number;
    releasedThisApp: number;
    remainingPoints: number;
    effectiveWorkPercent: number | null;
  };
}
export interface AiaSettings {
  billingMode?: string; retainagePercent?: number; storedRetainagePercent?: number;
  retainageMode?: 'uniform' | 'perLine';
  ownerName?: string; ownerAddress?: string;
  architectName?: string; architectAddress?: string;
  contractDate?: string; ownerProjectNumber?: string; architectProjectNumber?: string;
  contractFor?: string;
}

// Legacy projects never wrote `retainageMode`. Mirrors the server-side
// inference: an explicit mode always wins; when absent, a stored per-line
// rate on any SOV line means the project was already using per-line
// retainage, so keep showing it that way until someone touches settings.
export const resolveRetainageMode = (
  mode: AiaSettings['retainageMode'] | undefined,
  lines: Pick<AiaSovLine, 'retainagePercent'>[],
): 'uniform' | 'perLine' =>
  mode ?? (lines.some(l => l.retainagePercent != null) ? 'perLine' : 'uniform');

export interface SovLockState {
  locked: boolean; payAppCount: number;
  lockedAt?: number; lockedByUserId?: string | null; lockedByName?: string | null;
  reason?: 'manual' | 'pay-app';
}
export class SovLockedError extends Error { constructor() { super('Schedule of values is finalized'); this.name = 'SovLockedError'; } }
// 409s on SOV routes carry a code: sov_locked (finalized) vs version_conflict.
const handleSovResponse = async (res: Response, id: string) => {
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'sov_locked') throw new SovLockedError();
    throw new ConflictError(id);
  }
  await handleResponse(res);
};

const aiaJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// Schedule of Values
export const getSov = async (projectId: string): Promise<AiaSovLine[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/sov`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getSovLock = async (projectId: string): Promise<SovLockState> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/sov/lock`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const lockSov = async (projectId: string): Promise<SovLockState> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/lock`, {});
  await handleResponse(res); return res.json();
};
export const unlockSov = async (projectId: string): Promise<SovLockState> => {
  const res = await aiaJson('DELETE', `/api/projects/${projectId}/aia/sov/lock`);
  await handleResponse(res); return res.json();
};
export interface SovLineCreateInput {
  lineType?: SovLineType; itemNo?: string | null; description?: string;
  scheduledValueCents?: number; retainagePercent?: number | null; insertBeforeId?: string | null;
}
export const createSovLine = async (projectId: string, input: SovLineCreateInput): Promise<{ id: string }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov`, input);
  await handleSovResponse(res, projectId); return res.json();
};
export const saveSovLine = async (id: string, line: AiaSovLine): Promise<{ version: number }> => {
  const res = await aiaJson('PUT', `/api/aia/sov/${id}`, {
    lineType: lineTypeOf(line), itemNo: line.itemNo, description: line.description,
    scheduledValueCents: line.scheduledValueCents, retainagePercent: line.retainagePercent,
    version: line.version,
  });
  await handleSovResponse(res, id); return res.json();
};
export const deleteSovLine = async (id: string): Promise<void> => {
  const res = await aiaJson('DELETE', `/api/aia/sov/${id}`); await handleSovResponse(res, id);
};
export const reorderSov = async (projectId: string, ids: string[]): Promise<void> => {
  const res = await aiaJson('PUT', `/api/projects/${projectId}/aia/sov/order`, { ids });
  await handleSovResponse(res, projectId);
};
export interface SovSplitPart { description: string; percent: number }
export const splitSovLine = async (lineId: string, version: number, parts: SovSplitPart[]): Promise<{ header: AiaSovLine; children: AiaSovLine[] }> => {
  const res = await aiaJson('POST', `/api/aia/sov/${lineId}/split`, { version, parts });
  await handleSovResponse(res, lineId); return res.json();
};
export const seedSov = async (projectId: string, lines: { description: string; scheduledValueCents: number; itemNo?: string }[]): Promise<{ count: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/seed`, { lines });
  await handleSovResponse(res, projectId); return res.json();
};
export const syncChangeOrders = async (projectId: string): Promise<{ added: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/sync-change-orders`);
  await handleResponse(res); return res.json();
};

// Pay applications
export const getPayApps = async (projectId: string): Promise<AiaPayAppListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/pay-apps`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createPayApp = async (projectId: string, input: { periodTo?: string; applicationDate?: string; retainagePercent?: number; storedRetainagePercent?: number }): Promise<{ id: string; number: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/pay-apps`, input);
  await handleResponse(res); return res.json();
};
export const getPayApp = async (id: string): Promise<{ app: AiaPayAppDetail; lines: AiaPayAppLine[]; g703: AiaG703Row[]; g702: AiaG702 }> => {
  const res = await fetchWithRetry(`/api/aia/pay-apps/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const savePayAppLines = async (payAppId: string, lines: { sovLineId: string; percentComplete: number; storedMaterialsCents: number }[], version: number): Promise<{ version: number }> => {
  const res = await aiaJson('PUT', `/api/aia/pay-apps/${payAppId}/lines`, { lines, version });
  if (res.status === 409) throw new ConflictError(payAppId);
  await handleResponse(res); return res.json();
};
export const setPayApp = async (id: string, patch: Partial<{ periodTo: string | null; applicationDate: string | null; status: string; retainagePercent: number; storedRetainagePercent: number; releasedRetainagePoints: number }>): Promise<{ version: number }> => {
  const res = await aiaJson('PATCH', `/api/aia/pay-apps/${id}`, patch);
  await handleResponse(res); return res.json();
};
export const deletePayApp = async (id: string): Promise<void> => {
  const res = await aiaJson('DELETE', `/api/aia/pay-apps/${id}`); await handleResponse(res);
};

// Settings
export const getAiaSettings = async (projectId: string): Promise<AiaSettings> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/settings`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const saveAiaSettings = async (projectId: string, settings: AiaSettings): Promise<void> => {
  const res = await aiaJson('PUT', `/api/projects/${projectId}/aia/settings`, settings);
  await handleResponse(res);
};

// ── Per-user always-CC helper ─────────────────────────────────────────────────
// Reads the `emailAlwaysCc` pref (a plain string, comma/semicolon-separated).
// Async because getUserPreferences() fetches from the server; there is no
// synchronous pref cache in this module.
export const getAlwaysCc = async (): Promise<string> => {
  try {
    const prefs = await getUserPreferences();
    return prefs['emailAlwaysCc'] ?? '';
  } catch {
    return '';
  }
};

// ── Default project tab ──────────────────────────────────────────────────────
// Per-user pref `defaultProjectTab` (a project section id, e.g. 'documents').
// Cached for the session so opening several projects reads the server once.
export const DEFAULT_PROJECT_TAB_PREF = 'defaultProjectTab';
let defaultProjectTabCache: string | null = null;
export const peekDefaultProjectTab = (): string | null => defaultProjectTabCache;
export const getDefaultProjectTab = async (): Promise<string> => {
  if (defaultProjectTabCache !== null) return defaultProjectTabCache;
  try {
    const prefs = await getUserPreferences();
    defaultProjectTabCache = prefs[DEFAULT_PROJECT_TAB_PREF] || 'overview';
  } catch {
    return 'overview';
  }
  return defaultProjectTabCache;
};
export const setDefaultProjectTab = async (tab: string): Promise<void> => {
  await saveUserPreferences({ [DEFAULT_PROJECT_TAB_PREF]: tab });
  defaultProjectTabCache = tab;
};

// ── Favorite projects ────────────────────────────────────────────────────────
// Per-user pref `favoriteProjects` (JSON array of project ids). Cached for the
// session; subscribers (stars on cards and in the project top bar) re-render
// when it changes.
export const FAVORITE_PROJECTS_PREF = 'favoriteProjects';
let favoriteProjectsCache: string[] | null = null;
let favoriteProjectsLoading: Promise<string[]> | null = null;
const favoriteListeners = new Set<() => void>();
const emitFavorites = () => favoriteListeners.forEach(l => l());
export const peekFavoriteProjects = (): string[] | null => favoriteProjectsCache;
export const subscribeFavoriteProjects = (fn: () => void): (() => void) => {
  favoriteListeners.add(fn);
  return () => { favoriteListeners.delete(fn); };
};
export const parseFavoriteProjects = (raw: string | undefined): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
};
export const getFavoriteProjects = async (): Promise<string[]> => {
  if (favoriteProjectsCache !== null) return favoriteProjectsCache;
  if (!favoriteProjectsLoading) {
    favoriteProjectsLoading = getUserPreferences()
      .then(prefs => {
        // A toggle that landed while loading wins over the fetched value.
        if (favoriteProjectsCache === null) favoriteProjectsCache = parseFavoriteProjects(prefs[FAVORITE_PROJECTS_PREF]);
        emitFavorites();
        return favoriteProjectsCache;
      })
      .catch(() => [] as string[])
      .finally(() => { favoriteProjectsLoading = null; });
  }
  return favoriteProjectsLoading;
};
export const toggleFavoriteProject = async (projectId: string): Promise<void> => {
  const prev = favoriteProjectsCache ?? await getFavoriteProjects();
  const next = prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId];
  favoriteProjectsCache = next;
  emitFavorites();
  try {
    await saveUserPreferences({ [FAVORITE_PROJECTS_PREF]: JSON.stringify(next) });
  } catch (e) {
    favoriteProjectsCache = prev;
    emitFavorites();
    throw e;
  }
};

// ── Customers ────────────────────────────────────────────────────────────────

export interface CustomerProjectCounts {
  bidding: number;
  inProgress: number;
  archived: number;
}

// Sidebar row shape for the customers split view. Server-derived (see
// server/customerStore.ts customerSummaries).
export interface CustomerSummary {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  projectCounts: CustomerProjectCounts;
  openTaskCount: number;
  overdueTaskCount: number;
  // Admin-only (billing is gated server-side) — absent (not zero/null) for
  // non-admins.
  outstandingCents?: number;
}

export interface CustomerOverviewProject {
  id: string;
  name: string;
  status: string; // already normalizeProjectStatus()'d server-side
  archived: boolean;
  lostBid: boolean;
  bidDueDate: number | null;
  updatedAt: number | null;
  // Admin-only — absent for non-admins.
  outstandingCents?: number;
}

export interface CustomerBillingLedgerEntry {
  projectId: string;
  projectName: string;
  kind: 'invoice' | 'payapp';
  number: string | number;
  date: string | number | null;
  status: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}

export interface CustomerBilling {
  contractTotalCents: number;
  invoicedCents: number;
  paidCents: number;
  outstandingCents: number;
  ledger: CustomerBillingLedgerEntry[];
  // Every outstanding (balanceCents > 0) ledger doc bucketed by age of its
  // billed date — see server/customerStore.ts's customerOverview. Present
  // whenever `billing` itself is (i.e. always, for admins).
  aging: { current: number; days31to60: number; days61plus: number };
  contract: { billedCents: number; paidCents: number; outstandingCents: number };
  invoices: { invoicedCents: number; paidCents: number; outstandingCents: number };
}

export type CustomerAttentionItem =
  | { type: 'overdue_task'; label: string; projectId?: string; taskId: string; date: string }
  | { type: 'bid_due'; label: string; projectId: string; date: number; overdue?: true }
  | { type: 'outstanding_invoice'; label: string; projectId: string; date?: string | number; ageDays?: number; balanceCents: number };

export interface CustomerOverview {
  customer: Customer;
  projects: CustomerOverviewProject[];
  // Admin-only — key is entirely absent (not null) for non-admins.
  billing?: CustomerBilling;
  attention: CustomerAttentionItem[];
  taskCounts: { open: number; overdue: number };
}

export const getCustomersSummary = async (): Promise<CustomerSummary[]> => {
  const res = await fetchWithRetry('/api/customers/summary', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

export const getCustomerOverview = async (id: string): Promise<CustomerOverview> =>
  dedupeInFlight(`customer-overview:${id}`, async () => {
    const res = await fetchWithRetry(`/api/customers/${id}/overview`, { headers: { ...getAuthHeaders() } });
    await handleResponse(res);
    return await res.json();
  });

export const getCustomers = async (): Promise<Customer[]> => (await fetch('/api/customers', { headers: getAuthHeaders() })).json();
export const getCustomer = async (id: string): Promise<Customer> => (await fetch('/api/customers/' + id, { headers: getAuthHeaders() })).json();
export const saveCustomer = async (c: any) => {
  const res = await fetch(c.id ? '/api/customers/' + c.id : '/api/customers', {
    method: c.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(c),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'save failed');
  return res.json();
};
export const deleteCustomer = async (id: string) => {
  const res = await fetch('/api/customers/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'delete failed');
};
export const mergeCustomers = async (targetId: string, sourceIds: string[]) => {
  const res = await fetch('/api/customers/merge', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ targetId, sourceIds }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'merge failed');
};

// Derive a Schedule of Values seed from the project's estimate (takeoffs grouped
// by price package). Cost is in DOLLARS from calculateTakeoffTotalCost; converted
// to integer cents here. Groups with zero total cost are skipped.
export const computeSovSeedFromEstimate = (project: Project): { description: string; scheduledValueCents: number }[] => {
  const currentPageIds = new Set(project.pages.map(p => p.id));
  const totals = computeTakeoffTotals(project, currentPageIds);

  const groups = new Map<string, number>(); // package -> dollars
  for (const takeoff of totals) {
    const pkg = takeoff.pricePackage && takeoff.pricePackage.trim() ? takeoff.pricePackage : 'Uncategorized';
    const cost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
    groups.set(pkg, (groups.get(pkg) ?? 0) + cost);
  }

  return Array.from(groups.entries())
    .map(([description, dollars]) => ({ description, scheduledValueCents: Math.round(dollars * 100) }))
    .filter(g => g.scheduledValueCents > 0)
    .sort((a, b) => a.description.localeCompare(b.description));
};

// ── Wave 2: card system fetchers ─────────────────────────────────────────────
// Types below mirror server/dashboardStore.ts's exported interfaces verbatim.

export interface AttentionItem {
  type: 'overdue_task' | 'bid_due' | 'aging_receivable' | 'stale_rfi' | 'draft_payapp';
  label: string;
  sub: string;
  projectId: string | null;
  projectName: string | null;
  itemId: string;
  date: number;
  severity: 'red' | 'amber';
  balanceCents?: number;
}

export interface DashboardMoney {
  outstandingCents: number;
  contractTotalCents: number;
  billedCents: number;
  paidCents: number;
  draftPayAppCount: number;
  recentPayments: { id: string; amount: number; date: number; method: string | null; projectId: string; projectName: string }[];
  trend: { month: string; paidCents: number }[];
  aging: { current: number; days31to60: number; days61plus: number };
}

export interface HappeningItem {
  kind: 'activity' | 'mail';
  id: string;
  type?: string;
  message: string;
  username?: string | null;
  createdAt: number;
}

export const getDashboardAttention = async (): Promise<AttentionItem[]> => {
  const res = await fetchWithRetry('/api/dashboard/attention', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).items;
};

export const getDashboardMoney = async (): Promise<DashboardMoney> => {
  const res = await fetchWithRetry('/api/dashboard/money', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

export const getProjectHappenings = async (projectId: string, limit = 12): Promise<HappeningItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/happenings?limit=${limit}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).items;
};

// Same response shape as the project-scoped mail thread fetcher
// (mailApi.projectThreads) — this is the customerId-filtered alternative of
// the same GET /api/mail/project-threads endpoint.
export const getCustomerThreads = async (customerId: string): Promise<ProjectThreadRow[]> => {
  const res = await fetchWithRetry(`/api/mail/project-threads?customerId=${encodeURIComponent(customerId)}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

// ── Notifications (ONLYOFFICE Phase 5: the bell) ───────────────────────────

export type NotificationType = 'mention' | 'comment-reply' | 'task-assigned' | 'rfi-assigned' | 'rfi-answered';
export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  /** An in-app path to open, e.g. "/tasks?open=…". */
  link: string | null;
  actorUserId: string | null;
  createdAt: number;
  readAt: number | null;
}
/** Pushed on the socket's `notification` event. */
export type NotificationEvent =
  | { kind: 'new'; notification: AppNotification }
  | { kind: 'read'; ids: string[] | 'all' };

export const getNotifications = async (): Promise<{ items: AppNotification[]; unread: number }> => {
  const res = await fetchWithRetry('/api/notifications', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return res.json();
};
export const markNotificationRead = async (id: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', headers: { ...getAuthHeaders() } });
  await handleResponse(res);
};
export const markAllNotificationsRead = async (): Promise<void> => {
  const res = await fetchWithRetry('/api/notifications/read-all', { method: 'POST', headers: { ...getAuthHeaders() } });
  await handleResponse(res);
};

/** People who can be @mentioned in a document's comments, each under the
 *  address ONLYOFFICE keys them by. */
export const getMentionUsers = async (fileId: string): Promise<{ id: string; name: string; email: string }[]> => {
  const res = await fetchWithRetry(`/api/onlyoffice/mention-users/${encodeURIComponent(fileId)}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).users;
};
/** Someone was @mentioned in a comment (ONLYOFFICE's onRequestSendNotify). */
export const sendMentionNotifications = async (
  fileId: string, data: { emails: string[]; message?: string; actionLink?: unknown },
): Promise<{ notified: number }> => {
  const res = await fetchWithRetry(`/api/onlyoffice/mention/${encodeURIComponent(fileId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  await handleResponse(res);
  return res.json();
};

// ── Phone push notifications (ONLYOFFICE Phase 5, added 2026-09-27) ─────────

export interface PushDevice { id: string; device: string | null; createdAt: number; lastUsedAt: number | null }

export const getPushConfig = async (): Promise<{ publicKey: string }> => {
  const res = await fetchWithRetry('/api/push/config', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return res.json();
};
export const getPushDevices = async (): Promise<PushDevice[]> => {
  const res = await fetchWithRetry('/api/push/devices', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).devices;
};
/** Turns push on for this device: the browser's subscription, as toJSON() gives it. */
export const savePushSubscription = async (subscription: unknown): Promise<PushDevice> => {
  const res = await fetchWithRetry('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ subscription }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Couldn't turn on notifications for this device");
  }
  return (await res.json()).device;
};
export const removePushSubscription = async (endpoint: string): Promise<void> => {
  const res = await fetchWithRetry('/api/push/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ endpoint }),
  });
  await handleResponse(res);
};
export const removePushDevice = async (id: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { ...getAuthHeaders() } });
  await handleResponse(res);
};
export const sendTestPush = async (): Promise<{ sent: number; removed: number; failed: number }> => {
  const res = await fetchWithRetry('/api/push/test', { method: 'POST', headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return res.json();
};

export type AppendPosition = 'start' | 'end' | { afterPage: number };

// Append pages: chosen pages of other PDFs go into this PDF, saved as a new
// version of it. `pages` is text like "1-3, 5"; blank means every page.
export const appendPdfPages = async (
  id: string,
  sources: { id: string; pages?: string }[],
  position: AppendPosition,
): Promise<{ fileId: string; versionNumber: number }> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/append-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ sources, position }),
  });
  await handleResponse(res);
  return await res.json();
};
