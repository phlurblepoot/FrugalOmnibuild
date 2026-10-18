// server/lienReleaseRoutes.ts — admin-only lien release API
// (spec docs/superpowers/specs/2026-10-15-florida-lien-release-design.md §6.7).
// The item send (POST /api/lien-releases/:id/send) lives with the other item
// sends in routes.ts (registerEmailRoutes).
import express from 'express';
import type Database from 'better-sqlite3';
import { logActivity } from './activity';
import { requestMeta, type BroadcastChange } from './realtime/changeFeed';
import {
  listLienReleases, getLienRelease, createLienRelease, saveLienRelease, setLienReleaseStatus,
  deleteLienRelease, makeUnconditional, prefillLienRelease,
  ValidationError, ConflictError, NotFoundError, LockedError,
} from './lienReleaseStore';

export interface LienReleaseRouteDeps {
  db: Database.Database;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  broadcastChange: BroadcastChange;
}

export const lienReleaseErr = (e: unknown, res: express.Response) => {
  if (e instanceof NotFoundError) return res.status(404).json({ error: e.message });
  if (e instanceof LockedError) return res.status(409).json({ error: e.message, code: 'locked' });
  if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
  if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
  console.error('Lien release route error:', e);
  return res.status(500).json({ error: 'Lien release operation failed' });
};

const flag = (v: unknown): boolean | undefined => {
  if (v === undefined) return undefined;
  return v === '1' || v === 'true';
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function registerLienReleaseRoutes(app: express.Express, deps: LienReleaseRouteDeps): void {
  const { db, authenticateToken, requireAdmin } = deps;
  const gate = [authenticateToken, requireAdmin];
  const broadcast = (req: express.Request, id: string, projectId: string, action: 'created' | 'updated' | 'deleted', version?: number) =>
    deps.broadcastChange({ type: 'lienRelease', id, projectId, version, action, ...requestMeta(req) });
  const user = (req: express.Request) => (req as any).user ?? {};

  app.get('/api/projects/:id/lien-releases', ...gate, (req, res) => {
    try { res.json(listLienReleases(db, req.params.id)); } catch (e) { lienReleaseErr(e, res); }
  });

  app.get('/api/projects/:id/lien-releases/prefill', ...gate, (req, res) => {
    try {
      const q = req.query;
      res.json(prefillLienRelease(db, req.params.id, {
        sourceType: str(q.sourceType) ?? null, sourceId: str(q.sourceId) ?? null, paymentId: str(q.paymentId) ?? null,
        paymentType: str(q.paymentType), conditional: flag(q.conditional),
      }, user(req)));
    } catch (e) { lienReleaseErr(e, res); }
  });

  app.post('/api/projects/:id/lien-releases', ...gate, (req, res) => {
    try {
      const r = createLienRelease(db, req.params.id, req.body ?? {}, user(req).id);
      logActivity(db, { projectId: req.params.id, userId: user(req).id, type: 'lien_release_created', message: `Lien release LR-${r.number} created` });
      broadcast(req, r.id, req.params.id, 'created', r.version);
      res.json(r);
    } catch (e) { lienReleaseErr(e, res); }
  });

  app.get('/api/lien-releases/:id', ...gate, (req, res) => {
    try {
      const r = getLienRelease(db, req.params.id);
      if (!r) return res.status(404).json({ error: 'Lien release not found' });
      res.json(r);
    } catch (e) { lienReleaseErr(e, res); }
  });

  app.put('/api/lien-releases/:id', ...gate, (req, res) => {
    try {
      const r = saveLienRelease(db, req.params.id, req.body ?? {});
      const row = getLienRelease(db, req.params.id);
      if (row) broadcast(req, row.id, row.projectId, 'updated', r.version);
      res.json({ success: true, ...r });
    } catch (e) { lienReleaseErr(e, res); }
  });

  // Void a release, or bring a voided one back to draft. 'sent' is set only by
  // the item send, never by hand.
  app.patch('/api/lien-releases/:id/status', ...gate, (req, res) => {
    try {
      const status = req.body?.status;
      if (status !== 'void' && status !== 'draft') return res.status(400).json({ error: 'status must be void or draft' });
      const before = getLienRelease(db, req.params.id);
      if (!before) return res.status(404).json({ error: 'Lien release not found' });
      if (status === 'draft' && before.status !== 'void') return res.status(400).json({ error: 'Only a voided release can go back to draft' });
      const r = setLienReleaseStatus(db, req.params.id, status);
      if (status === 'void' && before.status !== 'void') {
        logActivity(db, { projectId: before.projectId, userId: user(req).id, type: 'lien_release_voided', message: `Lien release LR-${before.number ?? ''} voided` });
      }
      broadcast(req, before.id, before.projectId, 'updated', r.version);
      res.json({ success: true, ...r });
    } catch (e) { lienReleaseErr(e, res); }
  });

  app.post('/api/lien-releases/:id/unconditional', ...gate, (req, res) => {
    try {
      const from = getLienRelease(db, req.params.id);
      if (!from) return res.status(404).json({ error: 'Lien release not found' });
      const r = makeUnconditional(db, req.params.id, user(req).id);
      logActivity(db, { projectId: from.projectId, userId: user(req).id, type: 'lien_release_created', message: `Unconditional lien release LR-${r.number} made from LR-${from.number ?? ''}` });
      broadcast(req, r.id, from.projectId, 'created', r.version);
      res.json(r);
    } catch (e) { lienReleaseErr(e, res); }
  });

  app.delete('/api/lien-releases/:id', ...gate, (req, res) => {
    try {
      const before = getLienRelease(db, req.params.id);
      if (!before) return res.status(404).json({ error: 'Lien release not found' });
      deleteLienRelease(db, req.params.id);
      broadcast(req, before.id, before.projectId, 'deleted');
      res.json({ success: true });
    } catch (e) { lienReleaseErr(e, res); }
  });
}
