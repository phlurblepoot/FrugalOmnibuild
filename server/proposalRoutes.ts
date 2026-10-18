// server/proposalRoutes.ts — admin-only proposal API
// (spec docs/superpowers/specs/2026-08-28-proposal-rework-design.md §4).
import express from 'express';
import type Database from 'better-sqlite3';
import { logActivity } from './activity';
import { listVersions, removeFile } from './files';
import { requestMeta, type BroadcastChange } from './realtime/changeFeed';
import {
  listProposals, listOutstanding, getProposal, createProposal, saveProposal, deleteProposal, setProposalFile,
  addPhoto, updatePhoto, removePhoto, addAttachment, updateAttachment, removeAttachment, setStatus,
  ValidationError, ConflictError, NotFoundError, LockedError,
} from './proposalStore';

export interface ProposalRouteDeps {
  db: Database.Database;
  dataDir: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  broadcastChange: BroadcastChange;
}

export const proposalErr = (e: unknown, res: express.Response) => {
  if (e instanceof NotFoundError) return res.status(404).json({ error: e.message });
  if (e instanceof LockedError) return res.status(409).json({ error: e.message, code: 'locked' });
  if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
  if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
  console.error('Proposal route error:', e);
  return res.status(500).json({ error: 'Proposal operation failed' });
};

export function registerProposalRoutes(app: express.Express, deps: ProposalRouteDeps): void {
  const { db, dataDir, authenticateToken, requireAdmin } = deps;
  const gate = [authenticateToken, requireAdmin];
  const broadcast = (req: express.Request, id: string, projectId: string, action: 'created' | 'updated' | 'deleted', version?: number) =>
    deps.broadcastChange({ type: 'proposal', id, projectId, version, action, ...requestMeta(req) });
  const user = (req: express.Request) => (req as any).user ?? {};

  // Must precede /api/proposals/:id or Express reads "outstanding" as an id.
  app.get('/api/proposals/outstanding', ...gate, (_req, res) => {
    try { res.json(listOutstanding(db)); } catch (e) { proposalErr(e, res); }
  });

  app.get('/api/projects/:id/proposals', ...gate, (req, res) => {
    try { res.json(listProposals(db, req.params.id)); } catch (e) { proposalErr(e, res); }
  });

  app.post('/api/projects/:id/proposals', ...gate, (req, res) => {
    try {
      const r = createProposal(db, req.params.id, req.body ?? {}, user(req).username);
      logActivity(db, { projectId: req.params.id, userId: user(req).id, type: 'proposal_created', message: `Proposal #${r.number} created` });
      broadcast(req, r.id, req.params.id, 'created', r.version);
      res.json(r);
    } catch (e) { proposalErr(e, res); }
  });

  app.get('/api/proposals/:id', ...gate, (req, res) => {
    try {
      const p = getProposal(db, req.params.id);
      if (!p) return res.status(404).json({ error: 'Proposal not found' });
      res.json(p);
    } catch (e) { proposalErr(e, res); }
  });

  app.put('/api/proposals/:id', ...gate, (req, res) => {
    try {
      const r = saveProposal(db, req.params.id, req.body ?? {});
      const row = getProposal(db, req.params.id);
      if (row) broadcast(req, req.params.id, row.projectId, 'updated', r.version);
      res.json({ success: true, ...r });
    } catch (e) { proposalErr(e, res); }
  });

  app.delete('/api/proposals/:id', ...gate, (req, res) => {
    try {
      const before = getProposal(db, req.params.id);
      if (!before) return res.status(404).json({ error: 'Proposal not found' });
      deleteProposal(db, req.params.id);
      if (before.fileId) {
        try { for (const v of listVersions(db, before.fileId)) removeFile(db, dataDir, v.id); }
        catch (e) { console.warn('[proposals] could not remove generated file', e); }
      }
      broadcast(req, req.params.id, before.projectId, 'deleted');
      res.json({ success: true });
    } catch (e) { proposalErr(e, res); }
  });

  app.post('/api/proposals/:id/file', ...gate, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      setProposalFile(db, req.params.id, req.body.fileId);
      const row = getProposal(db, req.params.id);
      if (row) broadcast(req, req.params.id, row.projectId, 'updated');
      res.json({ success: true });
    } catch (e) { proposalErr(e, res); }
  });

  // photos / attachments — same shape, different store fns
  const subResource = (name: 'photos' | 'attachments', fns: {
    add: (db: Database.Database, id: string, fileId: string) => void;
    update: (db: Database.Database, id: string, fileId: string, patch: any) => void;
    remove: (db: Database.Database, id: string, fileId: string) => void;
  }) => {
    const after = (req: express.Request, res: express.Response) => {
      const row = getProposal(db, req.params.id);
      if (row) broadcast(req, req.params.id, row.projectId, 'updated');
      res.json({ success: true });
    };
    app.post(`/api/proposals/:id/${name}`, ...gate, (req, res) => {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      try { fns.add(db, req.params.id, req.body.fileId); after(req, res); } catch (e) { proposalErr(e, res); }
    });
    app.patch(`/api/proposals/:id/${name}/:fileId`, ...gate, (req, res) => {
      try { fns.update(db, req.params.id, req.params.fileId, req.body ?? {}); after(req, res); } catch (e) { proposalErr(e, res); }
    });
    app.delete(`/api/proposals/:id/${name}/:fileId`, ...gate, (req, res) => {
      try { fns.remove(db, req.params.id, req.params.fileId); after(req, res); } catch (e) { proposalErr(e, res); }
    });
  };
  subResource('photos', { add: addPhoto, update: updatePhoto, remove: removePhoto });
  subResource('attachments', { add: addAttachment, update: updateAttachment, remove: removeAttachment });

  app.post('/api/proposals/:id/status', ...gate, (req, res) => {
    try {
      const status = req.body?.status;
      const r = setStatus(db, req.params.id, status, req.body?.signedFileId ?? null);
      const row = getProposal(db, req.params.id);
      if (row) {
        logActivity(db, { projectId: row.projectId, userId: user(req).id, type: `proposal_${status}`, message: `Proposal #${row.number} ${status}` });
        broadcast(req, req.params.id, row.projectId, 'updated', r.version);
      }
      res.json({ success: true, ...r });
    } catch (e) { proposalErr(e, res); }
  });
}
