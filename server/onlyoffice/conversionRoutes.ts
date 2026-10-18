// server/onlyoffice/conversionRoutes.ts — conversion-backed routes (ONLYOFFICE
// Phase 4):
//
//   GET  /api/onlyoffice/thumbnail/:fileId      200 PNG | 202 { pending } | 404
//   POST /api/onlyoffice/pay-app-pdf/:payAppId  admin: the pay app's workbook as a PDF
import express from 'express';
import type Database from 'better-sqlite3';
import { getMeta } from '../files';
import { findDocumentBySource } from '../documents';
import { requestMeta, type BroadcastChange } from '../realtime/changeFeed';
import type { OnlyofficeServices } from './services';
import { OnlyofficeError } from './client';
import { isAdminOnlyKind } from './editorRoutes';

export interface OnlyofficeConversionRouteDeps {
  db: Database.Database;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  broadcastChange: BroadcastChange;
  services: OnlyofficeServices;
}

export function registerOnlyofficeConversionRoutes(app: express.Express, deps: OnlyofficeConversionRouteDeps): void {
  const { db, authenticateToken, requireAdmin, services } = deps;

  // A thumbnail that isn't made yet is queued, and the list asks again shortly.
  app.get('/api/onlyoffice/thumbnail/:fileId', authenticateToken, (req: any, res) => {
    const meta = getMeta(db, req.params.fileId);
    if (!meta || (req.user?.role !== 'admin' && isAdminOnlyKind(meta.kind))) return res.status(404).json({ error: 'File not found' });
    const t = services.thumbnails.state(meta.id);
    if (t.state === 'pending') return res.status(202).json({ pending: true });
    if (t.state !== 'ready' || !t.path) return res.status(404).json({ error: 'No thumbnail' });
    res.set('Content-Type', 'image/png');
    // The list asks with the file's version in the URL, so a day's caching
    // never shows an old page one.
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(t.path);
  });

  app.post('/api/onlyoffice/pay-app-pdf/:payAppId', authenticateToken, requireAdmin, async (req: any, res) => {
    const payAppId = req.params.payAppId;
    const workbook = findDocumentBySource(db, { sourceType: 'payapp', sourceId: payAppId, kind: 'payapp-export' }, true);
    const meta = workbook ? getMeta(db, workbook.id) : null;
    if (!meta) return res.status(404).json({ error: 'Generate the Excel workbook first.', code: 'no-workbook' });
    try {
      const { file: pdf, changed } = await services.conversions.workbookToPdf(meta, {
        kind: 'payapp-pdf', sourceType: 'payapp', sourceId: payAppId, userId: req.user?.id ? String(req.user.id) : null,
      });
      if (changed) {
        deps.broadcastChange({
          type: 'file', id: pdf.id, projectId: pdf.projectId ?? undefined,
          action: pdf.versionNumber > 1 ? 'updated' : 'created', ...requestMeta(req),
        });
      }
      res.json({ fileId: pdf.id, name: pdf.name, versionNumber: pdf.versionNumber, changed });
    } catch (e) {
      const message = e instanceof OnlyofficeError ? e.message : 'Making the PDF failed.';
      if (!(e instanceof OnlyofficeError)) console.error(`[onlyoffice] pay app ${payAppId} PDF failed:`, e);
      res.status(502).json({ error: message, code: 'conversion-failed' });
    }
  });
}
