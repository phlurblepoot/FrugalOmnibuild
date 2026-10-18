// server/onlyoffice/historyRoutes.ts — version history inside the editor, and
// restoring an older version (ONLYOFFICE Phase 2,
// docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).
//
//   GET  /api/onlyoffice/history/:fileId            versions for refreshHistory
//   GET  /api/onlyoffice/history/:fileId/:version   signed data for setHistoryData
//   GET  /api/onlyoffice/changes/:fileId/:version?t= a session's change log (the
//        editor frame downloads it, so it answers cross-origin; link token)
//   POST /api/files/:id/restore                     restore a version as a new one
//
// Restoring never overwrites: the chosen version's bytes become a new version
// on top, so the version being replaced stays in the history too. When the
// file is open in the editor, the restore first asks ONLYOFFICE to save what
// is open (so those edits are kept as a version), then retires that session:
// everyone reopens on the restored file, and a late save from the old session
// is only kept if it holds edits made after the restore (editorRoutes.ts).
import express from 'express';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { getMeta, listVersions, saveNewVersion, type FileMeta } from '../files';
import { readFileContent } from '../fileStore';
import type { BroadcastChange } from '../realtime/changeFeed';
import { requestMeta } from '../realtime/changeFeed';
import { extensionOf, officeFormatOf } from '../../src/utils/officeFormats';
import { readOnlyofficeConfig } from './config';
import type { LinkTokens } from './tokens';
import type { EditorSessions, FileQueue, ForcesaveWaiters } from './sessions';
import { FILE_LINK_TTL_SECONDS, changesSubject, fileLink } from './links';
import { documentKeyFor } from './editorConfig';
import { OnlyofficeError, isSessionOpen, requestForcesave } from './client';
import { NOT_CONFIGURED, isAdminOnlyKind } from './editorRoutes';

export interface OnlyofficeHistoryDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
  dataDir: string;
  tokens: LinkTokens;
  authenticateToken: express.RequestHandler;
  broadcastChange: BroadcastChange;
  fetch: typeof fetch;
  sessions: EditorSessions;
  queue: FileQueue;
  waiters: ForcesaveWaiters;
  /** How long a restore waits for ONLYOFFICE to save what is open. */
  forcesaveTimeoutMs?: number;
}

/** One entry of the editor's version list. The browser formats the date and
 *  builds refreshHistory's objects from these. */
export interface HistoryVersion {
  version: number;
  key: string;
  createdAt: number;
  user: { id: string; name: string } | null;
  origin: string | null;
  changes?: unknown;
  serverVersion?: unknown;
}

export function registerOnlyofficeHistoryRoutes(app: express.Express, deps: OnlyofficeHistoryDeps): void {
  const { db, dataDir, tokens, authenticateToken, sessions, queue, waiters } = deps;
  const forcesaveTimeoutMs = deps.forcesaveTimeoutMs ?? 30_000;

  /** The live file, if this person may see it: admin-only kinds read as missing. */
  const visibleLive = (req: any, fileId: string): FileMeta | null => {
    const meta = getMeta(db, fileId);
    if (!meta || meta.parentFileId) return null;
    if (req.user?.role !== 'admin' && isAdminOnlyKind(meta.kind)) return null;
    return meta;
  };

  /** Each version number once, oldest first. A number can repeat in history
   *  written before Phase 2 (overwrite restarted at 1); the newest row wins. */
  const versionRows = (live: FileMeta): FileMeta[] => {
    const byNumber = new Map<number, FileMeta>();
    for (const row of listVersions(db, live.id)) {
      const seen = byNumber.get(row.versionNumber);
      // listVersions puts the live row first, so it always keeps its number.
      if (!seen || (seen.id !== live.id && row.createdAt > seen.createdAt)) byNumber.set(row.versionNumber, row);
    }
    return [...byNumber.values()].sort((a, b) => a.versionNumber - b.versionNumber);
  };

  /** The key a version is shown with. The current version uses the open
   *  session's key, so the history's "current" is the document on screen. */
  const keyFor = (live: FileMeta, row: FileMeta): string =>
    row.id === live.id ? (sessions.get(live.id)?.docKey ?? documentKeyFor(live)) : documentKeyFor(row);

  const changesRow = (fileId: string, version: number) =>
    db.prepare('SELECT changesJson, serverVersion, zip IS NOT NULL AS hasZip FROM editor_changes WHERE fileId = ? AND versionNumber = ?')
      .get(fileId, version) as { changesJson: string; serverVersion: string | null; hasZip: number } | undefined;

  app.get('/api/onlyoffice/history/:fileId', authenticateToken, (req: any, res) => {
    const live = visibleLive(req, req.params.fileId);
    if (!live) return res.status(404).json({ error: 'File not found' });
    const rows = versionRows(live);
    const names = usernames(db);
    const numbers = new Set(rows.map(r => r.versionNumber));
    const versions: HistoryVersion[] = rows.map(row => {
      const entry: HistoryVersion = {
        version: row.versionNumber,
        key: keyFor(live, row),
        createdAt: row.createdAt,
        user: row.createdBy ? { id: String(row.createdBy), name: names.get(String(row.createdBy)) ?? 'Former user' } : null,
        origin: row.versionOrigin,
      };
      // Highlighting compares against the version before; without it the
      // change log has nothing to be drawn on.
      const logged = numbers.has(row.versionNumber - 1) ? changesRow(live.id, row.versionNumber) : undefined;
      if (logged) {
        entry.changes = safeJson(logged.changesJson);
        if (logged.serverVersion != null) entry.serverVersion = safeJson(logged.serverVersion);
      }
      return entry;
    });
    res.json({ currentVersion: live.versionNumber, versions });
  });

  app.get('/api/onlyoffice/history/:fileId/:version', authenticateToken, (req: any, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: NOT_CONFIGURED, code: 'not-configured' });
    const live = visibleLive(req, req.params.fileId);
    if (!live) return res.status(404).json({ error: 'File not found' });
    const version = Number(req.params.version);
    const rows = versionRows(live);
    const row = rows.find(r => r.versionNumber === version);
    if (!row) return res.status(404).json({ error: 'That version no longer exists.', code: 'no-version' });
    const format = officeFormatOf(row);
    if (!format) return res.status(415).json({ error: "This version isn't a document the editor can show.", code: 'unsupported' });

    const data: Record<string, unknown> = {
      version,
      key: keyFor(live, row),
      url: fileLink(cfg, tokens, row.id),
      fileType: format.ext,
    };
    const previous = rows.find(r => r.versionNumber === version - 1);
    const previousFormat = previous ? officeFormatOf(previous) : null;
    const logged = previous && previousFormat ? changesRow(live.id, version) : undefined;
    if (previous && previousFormat && logged?.hasZip) {
      const t = tokens.sign(changesSubject(live.id, version), FILE_LINK_TTL_SECONDS);
      data.changesUrl = `${appOrigin(req)}/api/onlyoffice/changes/${encodeURIComponent(live.id)}/${version}?t=${encodeURIComponent(t)}`;
      data.previous = { key: keyFor(live, previous), url: fileLink(cfg, tokens, previous.id), fileType: previousFormat.ext };
    }
    data.token = jwt.sign(data, cfg.jwtSecret, { algorithm: 'HS256', expiresIn: '1h' });
    res.json(data);
  });

  // The editor frame (ONLYOFFICE's own origin) downloads this, so it answers
  // cross-origin; the link token opens this one change log only.
  app.get('/api/onlyoffice/changes/:fileId/:version', (req, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    const fileId = req.params.fileId;
    const version = Number(req.params.version);
    if (cfg) res.set('Access-Control-Allow-Origin', new URL(cfg.publicUrl).origin);
    res.set('Vary', 'Origin');
    if (!tokens.verify(String(req.query.t || ''), changesSubject(fileId, version))) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    const row = db.prepare('SELECT zip FROM editor_changes WHERE fileId = ? AND versionNumber = ?').get(fileId, version) as { zip: Buffer | null } | undefined;
    if (!row?.zip) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', 'application/zip');
    res.set('Cache-Control', 'no-store');
    res.send(row.zip);
  });

  app.post('/api/files/:id/restore', express.json(), authenticateToken, async (req: any, res) => {
    const fileId = req.params.id;
    const live = visibleLive(req, fileId);
    if (!live) return res.status(404).json({ error: 'File not found' });
    const me = String(req.user.id);
    const fromEditor = req.body?.from === 'editor';

    const target = findVersion(live, req.body ?? {});
    if (!target) return res.status(404).json({ error: 'That version no longer exists.', code: 'no-version' });
    if (target.id === live.id) return res.status(400).json({ error: 'That is already the current version.', code: 'current' });

    // Is the file open in the editor? A session ONLYOFFICE no longer knows is
    // left over from a restart or crash and doesn't count.
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    let session = sessions.get(fileId);
    if (session && cfg) {
      try {
        if (!(await isSessionOpen(cfg, deps.fetch, session.docKey))) {
          sessions.end(fileId, session.docKey);
          session = null;
        }
      } catch (e) {
        const message = e instanceof OnlyofficeError ? e.message : 'Unexpected error talking to ONLYOFFICE.';
        return res.status(503).json({ error: message, code: 'onlyoffice-unreachable' });
      }
    }

    if (session && cfg) {
      // Only the person restoring, from inside that very editor, may pull the
      // file out from under the open session; anyone else is asked to wait.
      const users = sessions.usersOf(session);
      const others = users.filter(u => u !== me);
      if (!fromEditor || others.length > 0 || users.length === 0) {
        const names = usernames(db);
        const who = [...new Set(others.map(u => names.get(u) ?? 'someone'))];
        const error = who.length
          ? `${listNames(who)} ${who.length === 1 ? 'is' : 'are'} editing this file. Restore once the editor is closed.`
          : users.includes(me)
            ? 'You have this file open in the Document Editor. Restore from its Version History there, or close it first.'
            : 'This file is open in the Document Editor. Restore once the editor is closed.';
        return res.status(409).json({ error, code: 'open-in-editor', users: who });
      }
      // Keep what is open as a version before replacing it.
      const saved = waiters.wait(session.docKey, forcesaveTimeoutMs);
      let code: number;
      try {
        code = await requestForcesave(cfg, deps.fetch, session.docKey);
      } catch (e) {
        saved.cancel();
        const message = e instanceof OnlyofficeError ? e.message : 'Unexpected error talking to ONLYOFFICE.';
        return res.status(503).json({ error: message, code: 'onlyoffice-unreachable' });
      }
      if (code === 0) {
        if (!(await saved.promise)) {
          return res.status(503).json({ error: "Couldn't save the open document before restoring. Try again.", code: 'save-timeout' });
        }
      } else {
        saved.cancel(); // 4 = nothing new to save, 1 = the session just closed
      }
    }

    try {
      const result = await queue.run(fileId, async () => {
        const current = getMeta(db, fileId);
        const bytes = readFileContent(dataDir, target.id);
        if (!current || !bytes) return null;
        // Retire the open session: the next open starts on the restored file.
        const open = sessions.get(fileId);
        if (open) sessions.supersede(fileId, open.docKey, current.sha256);
        saveNewVersion(db, dataDir, fileId, bytes, target.mime, me, 'restore');
        // The version may carry another extension (a .doc before it was
        // converted); the name follows the bytes.
        const targetExt = officeFormatOf(target)?.ext ?? extensionOf(target.name);
        const currentExt = extensionOf(current.name);
        if (targetExt && currentExt && currentExt !== targetExt) {
          db.prepare('UPDATE files SET name = ? WHERE id = ?').run(`${current.name!.slice(0, -currentExt.length)}${targetExt}`, fileId);
        }
        return getMeta(db, fileId)!;
      });
      if (!result) return res.status(404).json({ error: 'That version no longer exists.', code: 'no-version' });
      deps.broadcastChange({ type: 'file', id: fileId, projectId: result.projectId ?? undefined, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, versionNumber: result.versionNumber, restoredFrom: target.versionNumber });
    } catch (e) {
      console.error(`[onlyoffice] restoring ${fileId} failed:`, e instanceof Error ? e.message : e);
      res.status(500).json({ error: 'Restoring the version failed.' });
    }
  });

  /** The archived row the request names, by row id or by version number. */
  function findVersion(live: FileMeta, body: { versionId?: unknown; version?: unknown }): FileMeta | null {
    if (typeof body.versionId === 'string' && body.versionId) {
      if (body.versionId === live.id) return live;
      const row = getMeta(db, body.versionId);
      return row && row.parentFileId === live.id ? row : null;
    }
    const version = Number(body.version);
    if (!Number.isInteger(version)) return null;
    return versionRows(live).find(r => r.versionNumber === version) ?? null;
  }
}

/** user id → username, for showing who made each version. */
export function usernames(db: Database.Database): Map<string, string> {
  const rows = db.prepare('SELECT id, username FROM users').all() as { id: string; username: string | null }[];
  return new Map(rows.map(r => [String(r.id), r.username || String(r.id)]));
}

const listNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The address the browser reached this app on. The client says it (its
 *  window.location.origin) because behind Cloudflare and a proxy the request
 *  itself may not; the forwarded protocol and host are the fallback. */
function appOrigin(req: express.Request): string {
  const given = typeof req.query.origin === 'string' ? req.query.origin : '';
  try {
    const u = new URL(given);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch { /* fall through */ }
  return `${req.protocol}://${req.get('host')}`;
}
