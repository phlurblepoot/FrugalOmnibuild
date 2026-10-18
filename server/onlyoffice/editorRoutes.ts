// server/onlyoffice/editorRoutes.ts — opening files in ONLYOFFICE and saving
// them back (ONLYOFFICE Phase 1, docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).
//
//   POST /api/onlyoffice/config/:fileId    signed-in user → signed editor config
//   GET  /api/onlyoffice/file/:fileId?t=   ONLYOFFICE downloads the file (link token)
//   POST /api/onlyoffice/callback/:fileId  ONLYOFFICE reports status and sends saves
//
// Saving follows the one-version-per-session rule (decision 2026-09-25): the
// first save of an editing session keeps the pre-session bytes as a version;
// later saves in the same session overwrite in place, but only while the live
// file is still exactly what this session last wrote. If anything else changed
// it meanwhile (a regenerate, an upload, a restore), the save becomes a new
// version on top, so nothing is ever overwritten.
import crypto from 'crypto';
import fsSync from 'fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { getMeta, replaceLiveContent, saveNewVersion, type FileMeta } from '../files';
import { pathFor, statFile } from '../fileStore';
import { NON_ADMIN_EXCLUDED_KINDS } from '../documents';
import { TEMPLATE_KIND } from '../documentLibrary';
import type { BroadcastChange } from '../realtime/changeFeed';
import { extensionOf, officeFormatByExt, officeFormatOf } from '../../src/utils/officeFormats';
import { readOnlyofficeConfig, type OnlyofficeConfig } from './config';
import { LinkTokens } from './tokens';
import { EditorSessions, FileQueue, ForcesaveWaiters, type SupersededSession } from './sessions';
import { fileLink, fileSubject } from './links';
import { buildEditorConfig, documentKeyFor, documentKeyPrefix } from './editorConfig';
import { normalizeActionLink } from '../../src/utils/editorLinks';
import { OnlyofficeError, downloadFromOnlyoffice, isSessionOpen } from './client';

export interface OnlyofficeEditorDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
  dataDir: string;
  tokens: LinkTokens;
  authenticateToken: express.RequestHandler;
  broadcastChange: BroadcastChange;
  fetch: typeof fetch;
  /** Shared with the history routes (restore). */
  sessions: EditorSessions;
  /** Told after a save lands (e.g. to refresh the thumbnail). */
  onSaved?: (fileId: string) => void;
  queue: FileQueue;
  waiters: ForcesaveWaiters;
}

// Callback bodies carry change history for long sessions; a generous cap, but
// nothing like the app's 50 MB JSON limit, since this route needs no login.
export const CALLBACK_PATH_PREFIX = '/api/onlyoffice/callback/';
const callbackParser = express.json({ limit: '10mb' });

export const NOT_CONFIGURED = "The document editor isn't set up yet. An admin can check Settings → Document Editor.";

// Billing documents, and the templates admins manage in Settings (anyone can
// start a document from a template; only admins change the template itself).
export const isAdminOnlyKind = (kind: string) =>
  (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(kind) || kind === TEMPLATE_KIND;

const callbackUsers = (payload: Record<string, any>): string[] =>
  Array.isArray(payload.users) ? payload.users.filter((u: unknown): u is string => typeof u === 'string' && u.length <= 128) : [];

/** When each change in a closing session's history was made, in ms. ONLYOFFICE
 *  writes UTC as "YYYY-MM-DD HH:mm:ss". Null if any entry can't be read. */
export function changeTimes(history: unknown): number[] | null {
  const changes = (history as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const times: number[] = [];
  for (const c of changes) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String((c as { created?: unknown })?.created ?? ''));
    if (!m) return null;
    times.push(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
  }
  return times;
}

/** The callback's parameters, from whichever signed form ONLYOFFICE used: the
 *  body's `token` (when set to sign in the body) or a Bearer header whose
 *  payload wraps them (the default). Unsigned fields are never trusted. */
function verifiedCallback(req: express.Request, secret: string): Record<string, any> | null {
  const verify = (token: string) => {
    try { return jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, any>; } catch { return null; }
  };
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token : '';
  if (bodyToken) {
    const p = verify(bodyToken);
    if (p) return p;
  }
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) {
    const p = verify(m[1]);
    if (p && typeof p.payload === 'object' && p.payload) return p.payload;
  }
  return null;
}

export function registerOnlyofficeEditorRoutes(app: express.Express, deps: OnlyofficeEditorDeps): void {
  const { db, dataDir, tokens, authenticateToken, sessions, queue, waiters } = deps;

  app.post('/api/onlyoffice/config/:fileId', authenticateToken, async (req: any, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: NOT_CONFIGURED, code: 'not-configured' });
    const meta = getMeta(db, req.params.fileId);
    const isAdmin = req.user?.role === 'admin';
    if (!meta || (!isAdmin && isAdminOnlyKind(meta.kind))) return res.status(404).json({ error: 'File not found' });
    const format = officeFormatOf(meta);
    if (!format) return res.status(415).json({ error: "This kind of file can't be opened in the editor.", code: 'unsupported' });

    const device = req.body?.device === 'phone' ? 'phone' : 'desktop';
    const theme = req.body?.theme === 'dark' ? 'dark' : 'light';
    // Phones get the viewer: ONLYOFFICE Community Edition doesn't edit in
    // mobile browsers (decision 2026-09-25). A historical version is read-only.
    const mode: 'edit' | 'view' = format.editable && device === 'desktop' && !meta.parentFileId ? 'edit' : 'view';

    let docKey = documentKeyFor(meta);
    if (!meta.parentFileId) {
      try {
        docKey = await sessionKeyFor(cfg, meta, docKey, mode);
      } catch (e) {
        const message = e instanceof OnlyofficeError ? e.message : 'Unexpected error talking to ONLYOFFICE.';
        return res.status(503).json({ error: message, code: 'onlyoffice-unreachable' });
      }
    }

    const config = buildEditorConfig({
      cfg,
      file: meta,
      format,
      docKey,
      fileUrl: fileLink(cfg, tokens, meta.id),
      callbackUrl: mode === 'edit' ? `${cfg.appInternalUrl}${CALLBACK_PATH_PREFIX}${encodeURIComponent(meta.id)}` : null,
      mode,
      device,
      theme,
      user: { id: String(req.user.id), name: String(req.user.username || req.user.id) },
      actionLink: normalizeActionLink(req.body?.actionLink),
    });
    res.json({
      publicUrl: cfg.publicUrl,
      config,
      file: { id: meta.id, name: meta.name, projectId: meta.projectId, kind: meta.kind, ext: format.ext, mode, editable: format.editable },
    });
  });

  /** The document key this open should use: the open session's, so everyone
   *  lands in the same session; otherwise the key for the current bytes,
   *  starting a session when the file is opened for editing. */
  async function sessionKeyFor(cfg: OnlyofficeConfig, meta: FileMeta, currentKey: string, mode: 'edit' | 'view'): Promise<string> {
    let session = sessions.get(meta.id);
    // A session pinned to another key (it has saved since it began) must still
    // exist in ONLYOFFICE; one that vanished without a closing callback (a
    // restart, a crash) would otherwise strand everyone on a dead key.
    if (session && session.docKey !== currentKey && !(await isSessionOpen(cfg, deps.fetch, session.docKey))) {
      sessions.end(meta.id, session.docKey);
      session = null;
    }
    if (session) return session.docKey;
    if (mode === 'edit') return sessions.start(meta.id, currentKey, meta.versionNumber).docKey;
    return currentKey;
  }

  // For ONLYOFFICE only (it has no user session): the link token opens this
  // one file, read-only, for a few hours.
  app.get('/api/onlyoffice/file/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    if (!tokens.verify(String(req.query.t || ''), fileSubject(fileId))) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    const meta = getMeta(db, fileId);
    const st = statFile(dataDir, fileId);
    if (!meta || !st) return res.status(404).json({ error: 'File not found' });
    res.set('Content-Type', meta.mime);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', 'no-store');
    fsSync.createReadStream(pathFor(dataDir, fileId)).pipe(res);
  });

  app.post(`${CALLBACK_PATH_PREFIX}:fileId`, callbackParser, async (req, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: 1 });
    const payload = verifiedCallback(req, cfg.jwtSecret);
    if (!payload) return res.status(403).json({ error: 1 });
    const fileId = req.params.fileId;
    const key = typeof payload.key === 'string' ? payload.key : '';
    if (!key.startsWith(documentKeyPrefix(fileId))) return res.status(400).json({ error: 1 });

    const status = Number(payload.status);
    const carriesFile = [2, 3, 6, 7].includes(status) && typeof payload.url === 'string' && !!payload.url;
    try {
      await queue.run(fileId, async () => {
        // 1 = someone joined or left: remember who is in the session.
        if (status === 1) {
          if (sessions.get(fileId)?.docKey === key) sessions.setUsers(fileId, key, callbackUsers(payload));
          return;
        }
        const superseded = sessions.getSuperseded(key);
        if (superseded) {
          if (carriesFile) await saveFromSupersededSession(cfg, fileId, key, superseded, payload);
          if ([2, 3, 4].includes(status)) sessions.dropSuperseded(key);
          return;
        }
        // 2 = closed with changes, 3 = closed but assembling failed, 6/7 = a
        // save while still open. ONLYOFFICE's own reference handler saves the
        // link it sends with 3 and 7 too: it is the best state it has.
        if (carriesFile) {
          if (status === 3 || status === 7) console.warn(`[onlyoffice] ${fileId}: status ${status}, saving the state ONLYOFFICE could recover`);
          await saveFromCallback(cfg, fileId, key, payload);
        }
        // Closing brings the session's change log, for Version History.
        if (status === 2 || status === 3) await storeChanges(cfg, fileId, key, payload);
        // 2, 3 and 4 mean everyone has closed the file: the session is over.
        if ([2, 3, 4].includes(status)) sessions.end(fileId, key);
      });
      res.json({ error: 0 });
    } catch (e) {
      // ONLYOFFICE keeps the edits and reports the failure to the people
      // editing when it doesn't get {"error":0}.
      console.error(`[onlyoffice] saving ${fileId} failed:`, e instanceof Error ? e.message : e);
      res.json({ error: 1 });
    } finally {
      // A restore may be waiting for this save before it replaces the file.
      if (carriesFile) waiters.settle(key);
    }
  });

  async function saveFromCallback(cfg: OnlyofficeConfig, fileId: string, key: string, payload: Record<string, any>): Promise<void> {
    const live = getMeta(db, fileId);
    if (!live || live.parentFileId) {
      console.warn(`[onlyoffice] ${fileId} no longer exists; dropping a save for it`);
      return;
    }
    const bytes = await downloadFromOnlyoffice(cfg, deps.fetch, payload.url);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 === live.sha256) return; // e.g. Save pressed with nothing changed

    const format = officeFormatByExt(typeof payload.filetype === 'string' ? payload.filetype : '') ?? officeFormatOf(live);
    const mime = format?.mime ?? live.mime;
    const by = callbackUsers(payload)[0] ?? null;

    const session = sessions.get(fileId);
    const ours = !!session && session.docKey === key;
    const untouchedSinceOurSave = ours && session!.savedVersionNumber === live.versionNumber && session!.savedSha256 === live.sha256;
    if (untouchedSinceOurSave) replaceLiveContent(db, dataDir, fileId, bytes, mime, by, 'editor');
    else saveNewVersion(db, dataDir, fileId, bytes, mime, by, 'editor');

    // ONLYOFFICE may hand back another format than was opened (it saves a
    // legacy file as its modern equivalent); keep the name's extension honest.
    const currentExt = extensionOf(live.name);
    if (format && currentExt && currentExt !== format.ext) {
      db.prepare('UPDATE files SET name = ? WHERE id = ?').run(`${live.name!.slice(0, -currentExt.length)}${format.ext}`, fileId);
    }

    const after = getMeta(db, fileId)!;
    if (ours) sessions.recordSave(fileId, key, { versionNumber: after.versionNumber, sha256: after.sha256, by });
    deps.broadcastChange({ type: 'file', id: fileId, projectId: after.projectId ?? undefined, action: 'updated', byUserId: by ?? undefined });
    deps.onSaved?.(fileId);
  }

  /** A late save from a session a restore replaced: kept as a new version
   *  only if it holds edits made after the restore — never over the top of
   *  the restored file just for repeating what was saved before it. A closing
   *  save says when each change was made, which settles it; other saves are
   *  judged by their bytes (ONLYOFFICE doesn't promise the same bytes twice
   *  for the same content, which is why the dates come first). */
  async function saveFromSupersededSession(
    cfg: OnlyofficeConfig, fileId: string, key: string, superseded: SupersededSession, payload: Record<string, any>,
  ): Promise<void> {
    const live = getMeta(db, fileId);
    if (!live || live.parentFileId) return;
    const times = changeTimes(payload.history);
    if (times && !times.some(t => t > superseded.closedAt)) return;
    const bytes = await downloadFromOnlyoffice(cfg, deps.fetch, payload.url);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 === superseded.lastSha256 || sha256 === live.sha256) return;
    const format = officeFormatByExt(typeof payload.filetype === 'string' ? payload.filetype : '') ?? officeFormatOf(live);
    const by = callbackUsers(payload)[0] ?? null;
    saveNewVersion(db, dataDir, fileId, bytes, format?.mime ?? live.mime, by, 'editor');
    sessions.updateSuperseded(key, sha256);
    deps.broadcastChange({ type: 'file', id: fileId, projectId: live.projectId ?? undefined, action: 'updated', byUserId: by ?? undefined });
  }

  /** Keeps the change log ONLYOFFICE sends when a session closes, so Version
   *  History can highlight what changed. Only when the session's saves made
   *  exactly one version on top of what it opened: otherwise the log would be
   *  highlighted against the wrong earlier version. Never fails the save. */
  async function storeChanges(cfg: OnlyofficeConfig, fileId: string, key: string, payload: Record<string, any>): Promise<void> {
    const session = sessions.get(fileId);
    const live = getMeta(db, fileId);
    const history = payload.history;
    if (!session || session.docKey !== key || !live || !history || !Array.isArray(history.changes)) return;
    if (session.savedVersionNumber !== live.versionNumber || live.versionNumber !== session.baseVersionNumber + 1) return;
    let zip: Buffer | null = null;
    if (typeof payload.changesurl === 'string' && payload.changesurl) {
      try { zip = await downloadFromOnlyoffice(cfg, deps.fetch, payload.changesurl); }
      catch (e) { console.warn(`[onlyoffice] ${fileId}: couldn't download the change log:`, e instanceof Error ? e.message : e); }
    }
    db.prepare(`INSERT OR REPLACE INTO editor_changes (fileId, versionNumber, changesJson, serverVersion, zip, createdAt)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(fileId, live.versionNumber, JSON.stringify(history.changes),
        history.serverVersion != null ? JSON.stringify(history.serverVersion) : null, zip, Date.now());
  }
}
