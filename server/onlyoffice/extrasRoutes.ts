// server/onlyoffice/extrasRoutes.ts — two editor add-ons (ONLYOFFICE Phase 3):
//
//   POST /api/onlyoffice/insert-image/:fileId  { c, fileIds }  → signed insertImage data
//     Insert → Image → From storage: the person picks signatures, company
//     stamps or images from Documents; ONLYOFFICE downloads each through a
//     short-lived link, so the images never pass through the browser.
//   POST /api/onlyoffice/save-copy/:fileId  { url, title, fileType }  → { fileId, name }
//     File → Save Copy as: ONLYOFFICE converts (e.g. a Word letter to PDF) and
//     hands the browser a link to the result; the app downloads it and files
//     it in the same project's Documents.
import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { getMeta, isDirectUploadKind, putBuffer } from '../files';
import { requestMeta, type BroadcastChange } from '../realtime/changeFeed';
import { INSERTABLE_IMAGE_TYPES, mayReadLibraryFile } from '../documentLibrary';
import { officeFormatByExt } from '../../src/utils/officeFormats';
import { readOnlyofficeConfig, type OnlyofficeConfig } from './config';
import type { LinkTokens } from './tokens';
import { fileLink } from './links';
import { editorTitle } from './editorConfig';
import { OnlyofficeError, downloadFromOnlyoffice } from './client';
import { NOT_CONFIGURED, isAdminOnlyKind } from './editorRoutes';

export interface OnlyofficeExtrasDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
  dataDir: string;
  tokens: LinkTokens;
  authenticateToken: express.RequestHandler;
  broadcastChange: BroadcastChange;
  fetch: typeof fetch;
}

const INSERT_COMMANDS = new Set(['add', 'change', 'fill', 'watermark', 'slide']);
const MAX_IMAGES = 20;

// What a saved copy's extension means, for formats outside the editor's own list.
const OTHER_COPY_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', html: 'text/html', epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml', pdfa: 'application/pdf', docxf: 'application/octet-stream', oform: 'application/octet-stream',
};
const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'ods', 'csv', 'xltx', 'ots']);

/** Only links on ONLYOFFICE's own addresses: the app must never be talked
 *  into fetching some other URL on the browser's say-so. */
export function isOnlyofficeLink(cfg: OnlyofficeConfig, url: unknown): url is string {
  if (typeof url !== 'string') return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return [cfg.publicUrl, cfg.internalUrl].some(base => {
    try { return new URL(base).origin === u.origin; } catch { return false; }
  });
}

export function registerOnlyofficeExtrasRoutes(app: express.Express, deps: OnlyofficeExtrasDeps): void {
  const { db, dataDir, tokens, authenticateToken } = deps;
  const isAdmin = (req: any) => req.user?.role === 'admin';
  const visible = (req: any, id: string) => {
    const meta = getMeta(db, id);
    if (!meta || (!isAdmin(req) && isAdminOnlyKind(meta.kind))) return null;
    return meta;
  };

  app.post('/api/onlyoffice/insert-image/:fileId', authenticateToken, (req: any, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: NOT_CONFIGURED, code: 'not-configured' });
    if (!visible(req, req.params.fileId)) return res.status(404).json({ error: 'File not found' });
    const c = INSERT_COMMANDS.has(req.body?.c) ? req.body.c : 'add';
    const ids: unknown[] = Array.isArray(req.body?.fileIds) ? req.body.fileIds.slice(0, MAX_IMAGES) : [];

    const images: { fileType: string; url: string }[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const meta = typeof id === 'string' ? visible(req, id) : null;
      // Someone else's signature reads as missing, like anywhere else.
      if (!meta || !mayReadLibraryFile(meta, req.user)) return res.status(404).json({ error: 'Image not found' });
      const fileType = INSERTABLE_IMAGE_TYPES[meta.mime];
      if (!fileType) { skipped.push(meta.name || meta.id); continue; }
      images.push({ fileType, url: fileLink(cfg, tokens, meta.id) });
    }
    if (images.length === 0) {
      return res.status(415).json({
        error: skipped.length ? 'The editor can only insert PNG, JPEG, GIF, BMP or TIFF images.' : 'Pick an image first.',
        code: 'unsupported', skipped,
      });
    }
    const data = { c, images };
    res.json({ ...data, token: jwt.sign(data, cfg.jwtSecret, { algorithm: 'HS256', expiresIn: '1h' }), skipped });
  });

  app.post('/api/onlyoffice/save-copy/:fileId', authenticateToken, async (req: any, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: NOT_CONFIGURED, code: 'not-configured' });
    const source = visible(req, req.params.fileId);
    if (!source) return res.status(404).json({ error: 'File not found' });
    const live = source.parentFileId ? getMeta(db, source.parentFileId) ?? source : source;
    if (!isOnlyofficeLink(cfg, req.body?.url)) return res.status(400).json({ error: "That isn't a link from the document editor.", code: 'bad-url' });
    const ext = String(req.body?.fileType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const mime = officeFormatByExt(ext)?.mime ?? OTHER_COPY_MIMES[ext];
    if (!ext || !mime) return res.status(415).json({ error: `Can't save a .${ext || '?'} copy.`, code: 'unsupported' });

    let bytes: Buffer;
    try {
      bytes = await downloadFromOnlyoffice(cfg, deps.fetch, req.body.url);
    } catch (e) {
      return res.status(502).json({ error: e instanceof OnlyofficeError ? e.message : 'Downloading the copy failed.', code: 'download-failed' });
    }

    // Filed next to the original: the same project (company documents stay
    // company documents); a spreadsheet copy is a spreadsheet.
    const company = live.kind === 'company-document';
    const kind = SPREADSHEET_EXTS.has(ext) ? 'spreadsheet'
      : isDirectUploadKind(live.kind) && live.kind !== 'photo' && live.kind !== 'spreadsheet' ? live.kind : 'document';
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 200) : (live.name || 'Copy');
    const id = crypto.randomUUID();
    putBuffer(db, dataDir, id, bytes, mime, {
      ...(!company && live.projectId ? { projectId: live.projectId } : {}),
      ...(live.customerId ? { customerId: live.customerId } : {}),
      kind: company ? 'company-document' : kind,
      name: editorTitle(title, ext),
      createdBy: String(req.user.id),
    });
    const saved = getMeta(db, id)!;
    deps.broadcastChange({ type: 'file', id, projectId: saved.projectId ?? undefined, action: 'created', ...requestMeta(req) });
    res.json({ fileId: id, name: saved.name, projectId: saved.projectId });
  });
}
