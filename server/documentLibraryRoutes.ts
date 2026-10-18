// server/documentLibraryRoutes.ts — routes for server/documentLibrary.ts
// (ONLYOFFICE Phase 3):
//
//   POST   /api/documents/new                 anyone: a new document from a blank or a template
//   GET    /api/document-templates            anyone: the list, for "New document"
//   POST   /api/document-templates?name=      admin: upload a template (raw body)
//   POST   /api/document-templates/letterhead admin: add the company letterhead as a template
//   PATCH  /api/document-templates/:id        admin: rename
//   DELETE /api/document-templates/:id        admin
//   GET    /api/company-stamps                anyone
//   POST   /api/company-stamps?name=          admin: upload a stamp (raw PNG/JPEG)
//   PATCH  /api/company-stamps/:id            admin: rename
//   DELETE /api/company-stamps/:id            admin
//   GET    /api/signatures                    your own signatures
//   POST   /api/signatures?name=              add one (raw PNG/JPEG)
//   PATCH  /api/signatures/:id                rename, or { isDefault: true }
//   DELETE /api/signatures/:id
import express from 'express';
import type Database from 'better-sqlite3';
import { requestMeta, type BroadcastChange } from './realtime/changeFeed';
import {
  LibraryError, STAMP_KIND, TEMPLATE_KIND, addLetterheadTemplate, addSignature, addStamp, addTemplate, createNewDocument,
  libraryFile, listSignatures, listStamps, listTemplates, ownSignature, removeLibraryFile, renameLibraryFile, setDefaultSignature,
} from './documentLibrary';

export interface DocumentLibraryRouteDeps {
  db: Database.Database;
  dataDir: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  broadcastChange: BroadcastChange;
}

const rawUpload = express.raw({ limit: '50mb', type: () => true });
const mimeOf = (req: express.Request) => (req.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();

export function registerDocumentLibraryRoutes(app: express.Express, deps: DocumentLibraryRouteDeps): void {
  const { db, dataDir, authenticateToken, requireAdmin } = deps;
  const admin = [authenticateToken, requireAdmin];
  const userId = (req: express.Request) => String((req as any).user?.id ?? '');
  const bodyOf = (req: express.Request) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

  /** Runs a handler, turning a LibraryError into its answer. */
  const handle = (label: string, fn: (req: express.Request, res: express.Response) => void) =>
    (req: express.Request, res: express.Response) => {
      try {
        fn(req, res);
      } catch (e) {
        if (e instanceof LibraryError) return res.status(e.status).json({ error: e.message, code: e.code });
        console.error(`${label} failed:`, e);
        res.status(500).json({ error: `${label} failed` });
      }
    };
  const changed = (req: express.Request, id: string, action: 'created' | 'updated' | 'deleted') =>
    deps.broadcastChange({ type: 'file', id, action, ...requestMeta(req as any) });

  // ── New document ─────────────────────────────────────────────────────────
  app.post('/api/documents/new', authenticateToken, handle('Creating the document', (req, res) => {
    const b = req.body ?? {};
    const meta = createNewDocument(db, dataDir, {
      type: b.type, templateId: b.templateId, name: b.name, projectId: b.projectId, kind: b.kind, userId: userId(req),
    });
    deps.broadcastChange({ type: 'file', id: meta.id, projectId: meta.projectId ?? undefined, action: 'created', ...requestMeta(req as any) });
    res.json({ fileId: meta.id, name: meta.name });
  }));

  // ── Templates ────────────────────────────────────────────────────────────
  app.get('/api/document-templates', authenticateToken, handle('Listing templates', (_req, res) => {
    res.json(listTemplates(db));
  }));

  // Before the /:id routes, which would otherwise read "letterhead" as an id.
  app.post('/api/document-templates/letterhead', ...admin, handle('Adding the letterhead', (req, res) => {
    const t = addLetterheadTemplate(db, dataDir, userId(req));
    changed(req, t.id, 'created');
    res.json(t);
  }));

  app.post('/api/document-templates', rawUpload, ...admin, handle('Uploading the template', (req, res) => {
    const t = addTemplate(db, dataDir, bodyOf(req), { name: req.query.name, mime: mimeOf(req), userId: userId(req) });
    changed(req, t.id, 'created');
    res.json(t);
  }));

  app.patch('/api/document-templates/:id', ...admin, handle('Renaming the template', (req, res) => {
    const meta = libraryFile(db, req.params.id, TEMPLATE_KIND);
    if (!meta) throw new LibraryError(404, 'Template not found', 'not-found');
    renameLibraryFile(db, meta, req.body?.name);
    changed(req, meta.id, 'updated');
    res.json(listTemplates(db).find(t => t.id === meta.id));
  }));

  app.delete('/api/document-templates/:id', ...admin, handle('Deleting the template', (req, res) => {
    const meta = libraryFile(db, req.params.id, TEMPLATE_KIND);
    if (!meta) throw new LibraryError(404, 'Template not found', 'not-found');
    removeLibraryFile(db, dataDir, meta);
    changed(req, meta.id, 'deleted');
    res.json({ success: true });
  }));

  // ── Company stamps ───────────────────────────────────────────────────────
  app.get('/api/company-stamps', authenticateToken, handle('Listing stamps', (_req, res) => {
    res.json(listStamps(db));
  }));

  app.post('/api/company-stamps', rawUpload, ...admin, handle('Uploading the stamp', (req, res) => {
    const s = addStamp(db, dataDir, bodyOf(req), { name: req.query.name, mime: mimeOf(req), userId: userId(req) });
    changed(req, s.id, 'created');
    res.json(s);
  }));

  app.patch('/api/company-stamps/:id', ...admin, handle('Renaming the stamp', (req, res) => {
    const meta = libraryFile(db, req.params.id, STAMP_KIND);
    if (!meta) throw new LibraryError(404, 'Stamp not found', 'not-found');
    renameLibraryFile(db, meta, req.body?.name);
    changed(req, meta.id, 'updated');
    res.json(listStamps(db).find(s => s.id === meta.id));
  }));

  app.delete('/api/company-stamps/:id', ...admin, handle('Deleting the stamp', (req, res) => {
    const meta = libraryFile(db, req.params.id, STAMP_KIND);
    if (!meta) throw new LibraryError(404, 'Stamp not found', 'not-found');
    removeLibraryFile(db, dataDir, meta);
    changed(req, meta.id, 'deleted');
    res.json({ success: true });
  }));

  // ── Signatures (each person's own; never broadcast) ──────────────────────
  app.get('/api/signatures', authenticateToken, handle('Listing signatures', (req, res) => {
    res.json(listSignatures(db, userId(req)));
  }));

  app.post('/api/signatures', rawUpload, authenticateToken, handle('Saving the signature', (req, res) => {
    res.json(addSignature(db, dataDir, bodyOf(req), { name: req.query.name, mime: mimeOf(req), userId: userId(req) }));
  }));

  app.patch('/api/signatures/:id', authenticateToken, handle('Updating the signature', (req, res) => {
    const meta = ownSignature(db, req.params.id, userId(req));
    if (req.body?.name !== undefined) renameLibraryFile(db, meta, req.body.name);
    if (req.body?.isDefault === true) setDefaultSignature(db, meta.id, userId(req));
    res.json(listSignatures(db, userId(req)).find(s => s.id === meta.id));
  }));

  app.delete('/api/signatures/:id', authenticateToken, handle('Deleting the signature', (req, res) => {
    const meta = ownSignature(db, req.params.id, userId(req));
    removeLibraryFile(db, dataDir, meta);
    res.json({ success: true });
  }));
}
