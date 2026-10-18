// server/shareRoutes.ts — share links (ONLYOFFICE Phase 7). All of them live
// here, so every public route turns an expired or stopped link away the same
// way (410 with the reason; 404 when there never was one). The embedded
// viewer for shared files is in server/onlyoffice/viewers.ts.
//
// Public (no sign-in), for whoever has the link:
//   GET /api/share/:id/info             what it is, and how to show it
//   GET /api/share/:id                  a single shared file
//   GET /api/share/:id/file/:index      one file of a several-files link
//   GET /api/share/:id/page-info/:index, /image/:index   a page gallery
// Signed in (only links to files this person can see):
//   POST   /api/shares                  a new link (never reuses an old one)
//   GET    /api/shares?fileId=          a file's working links
//   PATCH  /api/shares/:id              { expiresInDays }: a new expiry
//   DELETE /api/shares/:id              stop sharing
import express from 'express';
import fsSync from 'fs';
import type Database from 'better-sqlite3';
import { getMeta, type FileMeta } from './files';
import { pathFor, statFile } from './fileStore';
import { officeFormatOf } from '../src/utils/officeFormats';
import { readOnlyofficeConfig } from './onlyoffice/config';
import { setUntrustedContentHeaders } from './untrustedContent';
import {
  SHARE_PROBLEM_TEXT, ShareError, activeShare, activeSharesForFile, createShare, getShare, mayShareFile, revokeShare,
  setShareExpiry, shareProblemStatus, sharedFileIds, type ShareRow,
} from './shares';

export interface ShareRouteDeps {
  db: Database.Database;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  authenticateToken: express.RequestHandler;
}

interface PageEntry { imageId: string; name: string; pageNumber?: string }
const pagesOf = (share: ShareRow): PageEntry[] => {
  try { const p = JSON.parse(share.resourceId); return Array.isArray(p) ? p : []; } catch { return []; }
};

export function registerShareRoutes(app: express.Express, deps: ShareRouteDeps): void {
  const { db, dataDir, authenticateToken } = deps;

  /** The share behind a public request, or the answer to send instead. */
  const publicShare = (req: express.Request, res: express.Response, as: 'json' | 'text'): ShareRow | null => {
    const found = activeShare(db, req.params.shareId);
    if ('share' in found) return found.share;
    const status = shareProblemStatus(found.problem);
    if (as === 'json') res.status(status).json({ error: SHARE_PROBLEM_TEXT[found.problem], code: found.problem });
    else res.status(status).type('text/plain').send(SHARE_PROBLEM_TEXT[found.problem]);
    return null;
  };

  /** Streams a stored file. Private caching: a stopped link should stop
   *  working, not linger in a shared cache. */
  const sendFile = (res: express.Response, meta: FileMeta | null, download: boolean) => {
    const st = meta ? statFile(dataDir, meta.id) : null;
    if (!meta || !st) return res.status(404).type('text/plain').send('File not found');
    // Encodes any name (an en dash would make a hand-built header throw).
    if (download) res.attachment(meta.name || 'file');
    res.set('Content-Type', meta.mime);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', 'private, max-age=3600');
    setUntrustedContentHeaders(res, meta.mime);
    fsSync.createReadStream(pathFor(dataDir, meta.id)).pipe(res);
  };

  const viewerReady = () => !!readOnlyofficeConfig(deps.env).config;
  const describe = (meta: FileMeta | null) => meta && ({
    name: meta.name || 'Document', mime: meta.mime, size: meta.size,
    viewer: !!officeFormatOf(meta) && viewerReady(),
  });

  // ── Public ─────────────────────────────────────────────────────────────────

  app.get('/api/share/:shareId/info', (req, res) => {
    const share = publicShare(req, res, 'json');
    if (!share) return;
    const base = { type: share.type, name: share.name ?? '', expiresAt: share.expiresAt };
    if (share.type === 'pages') return res.json({ ...base, count: pagesOf(share).length });
    if (share.type === 'files') {
      const files = sharedFileIds(share).map(id => describe(getMeta(db, id)) ?? { name: 'No longer available', mime: '', size: 0, viewer: false, missing: true });
      return res.json({ ...base, count: files.length, files });
    }
    const file = describe(getMeta(db, share.resourceId));
    // viewer: opens in the ONLYOFFICE embedded viewer (Phase 6), phones too.
    res.json({ ...base, viewer: file?.viewer ?? false, mime: file?.mime ?? null });
  });

  app.get('/api/share/:shareId/page-info/:index', (req, res) => {
    const share = publicShare(req, res, 'json');
    if (!share) return;
    if (share.type !== 'pages') return res.status(404).json({ error: 'Share not found' });
    const page = pagesOf(share)[Number(req.params.index)];
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json({ name: page.name, pageNumber: page.pageNumber });
  });

  app.get('/api/share/:shareId/image/:index', (req, res) => {
    const share = publicShare(req, res, 'text');
    if (!share) return;
    if (share.type !== 'pages') return res.status(404).send('Share not found');
    const page = pagesOf(share)[Number(req.params.index)];
    if (!page) return res.status(404).send('Page not found');
    sendFile(res, getMeta(db, page.imageId), false);
  });

  app.get('/api/share/:shareId/file/:index', (req, res) => {
    const share = publicShare(req, res, 'text');
    if (!share) return;
    if (share.type !== 'files') return res.status(404).send('Share not found');
    const id = sharedFileIds(share)[Number(req.params.index)];
    if (!id) return res.status(404).send('File not found');
    sendFile(res, getMeta(db, id), req.query.download === '1');
  });

  app.get('/api/share/:shareId', (req, res) => {
    const share = publicShare(req, res, 'text');
    if (!share) return;
    const [id] = sharedFileIds(share);
    if (!id || share.type === 'files') return res.status(404).send('Share not found');
    sendFile(res, getMeta(db, id), req.query.download === '1');
  });

  // ── Signed in ──────────────────────────────────────────────────────────────

  type User = { id?: unknown; role?: string } | undefined;
  const userOf = (req: express.Request) => (req as any).user as User;
  /** Seeing or changing a link takes being able to see every file it opens
   *  (a link is the file: whoever has it can open it). */
  const mayManage = (share: ShareRow, user: User) =>
    sharedFileIds(share).every(id => { const meta = getMeta(db, id); return !meta || mayShareFile(meta, user); });

  const shareErr = (res: express.Response, e: unknown) => {
    if (e instanceof ShareError) return res.status(e.status).json({ error: e.message });
    console.error('[shares]', e);
    return res.status(500).json({ error: 'Server error' });
  };

  app.post('/api/shares', authenticateToken, (req, res) => {
    try {
      const b = req.body ?? {};
      const user = userOf(req);
      const share = createShare(db, {
        type: b.type, resourceId: b.resourceId, fileIds: Array.isArray(b.fileIds) ? b.fileIds : undefined,
        name: b.name, expiresInDays: b.expiresInDays, createdBy: user?.id != null ? String(user.id) : null, user,
      });
      res.json({ id: share.id, expiresAt: share.expiresAt });
    } catch (e) { shareErr(res, e); }
  });

  app.get('/api/shares', authenticateToken, (req, res) => {
    const fileId = typeof req.query.fileId === 'string' ? req.query.fileId : '';
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });
    const user = userOf(req);
    if (!mayShareFile(getMeta(db, fileId), user)) return res.status(404).json({ error: 'File not found' });
    res.json({ shares: activeSharesForFile(db, fileId, share => mayManage(share, user)) });
  });

  /** A link this person may change, or null (404: no hint it exists). */
  const manageable = (req: express.Request) => {
    const share = getShare(db, req.params.id);
    return share && mayManage(share, userOf(req)) ? share : null;
  };

  app.patch('/api/shares/:id', authenticateToken, (req, res) => {
    try {
      if (!req.body || !('expiresInDays' in req.body)) return res.status(400).json({ error: 'expiresInDays is required (7, 30, 90 or null)' });
      if (!manageable(req)) return res.status(404).json({ error: 'Link not found' });
      const share = setShareExpiry(db, req.params.id, req.body.expiresInDays);
      res.json({ id: share.id, expiresAt: share.expiresAt });
    } catch (e) { shareErr(res, e); }
  });

  app.delete('/api/shares/:id', authenticateToken, (req, res) => {
    if (!manageable(req)) return res.status(404).json({ error: 'Link not found' });
    revokeShare(db, req.params.id);
    res.json({ success: true });
  });
}
