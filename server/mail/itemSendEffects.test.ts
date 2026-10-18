import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { createRfi, getRfi } from '../rfiStore';
import { createProposal, getProposal, setProposalFile } from '../proposalStore';
import { createChangeOrder, getChangeOrder } from '../billingStore';
import { createPayApp } from '../aiaStore';
import { applySendEffects } from './itemSendEffects';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ise-')), migrations);
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
});
describe('applySendEffects', () => {
  it('marks an open RFI sent and logs activity', () => {
    const { id } = createRfi(db, 'p1', { title: 'x' });
    const r = applySendEffects(db, { itemType: 'rfi', itemId: id, userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(r.applied).toBe(true); expect(getRfi(db, id).status).toBe('sent');
    expect(r.broadcast).toMatchObject({ type: 'rfi', id, projectId: 'p1' });
    expect((db.prepare(`SELECT type FROM activity WHERE projectId='p1'`).all() as any[]).map(a => a.type)).toContain('rfi_sent');
  });
  it('is idempotent: an answered RFI is left alone (noop) but activity still logs', () => {
    const { id } = createRfi(db, 'p1', { title: 'x', status: 'answered' });
    const r = applySendEffects(db, { itemType: 'rfi', itemId: id, userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(getRfi(db, id).status).toBe('answered'); expect(r.applied).toBe(true);
  });
  it('skips admin-gated item types for non-admins', () => {
    const r = applySendEffects(db, { itemType: 'invoice', itemId: 'inv-missing', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(r).toEqual({ applied: false, skipped: 'role' });
  });
  it('reports missing items', () => {
    expect(applySendEffects(db, { itemType: 'issue', itemId: 'nope', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' })).toEqual({ applied: false, skipped: 'missing' });
  });
  it('link-only types are a noop', () => {
    expect(applySendEffects(db, { itemType: 'project', itemId: 'p1', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' })).toEqual({ applied: false, skipped: 'noop' });
  });
  it('marks a draft proposal sent (with a PDF already generated) and broadcasts the bumped version', () => {
    const { id } = createProposal(db, 'p1', {});
    setProposalFile(db, id, 'file-1');
    const r = applySendEffects(db, { itemType: 'proposal', itemId: id, userId: 'u1', role: 'admin', to: 'a@b', threadKey: 'k', subject: 'Hi' });
    expect(r.applied).toBe(true);
    expect(getProposal(db, id).status).toBe('sent');
    expect(r.broadcast).toMatchObject({ type: 'proposal', id, projectId: 'p1', version: 2 });
  });
  it('leaves an already-sent proposal untouched but still logs activity', () => {
    const { id } = createProposal(db, 'p1', {});
    setProposalFile(db, id, 'file-1');
    applySendEffects(db, { itemType: 'proposal', itemId: id, userId: 'u1', role: 'admin', to: 'a@b', threadKey: 'k' });
    const r = applySendEffects(db, { itemType: 'proposal', itemId: id, userId: 'u1', role: 'admin', to: 'a@b', threadKey: 'k' });
    expect(getProposal(db, id).status).toBe('sent');
    expect(r.applied).toBe(true);
    expect((db.prepare(`SELECT type FROM activity WHERE projectId='p1'`).all() as any[]).filter(a => a.type === 'proposal_sent').length).toBe(2);
  });
  it('leaves an approved change order approved (guard holds) but still logs activity', () => {
    const { id } = createChangeOrder(db, 'p1', { status: 'approved' });
    const r = applySendEffects(db, { itemType: 'changeOrder', itemId: id, userId: 'u1', role: 'admin', to: 'a@b', threadKey: 'k' });
    expect(getChangeOrder(db, id).status).toBe('approved');
    expect(r.applied).toBe(true);
    expect((db.prepare(`SELECT type FROM activity WHERE projectId='p1'`).all() as any[]).map(a => a.type)).toContain('change_order_sent');
  });
  it('logs a pay_app_sent activity for an admin sending an existing pay app', () => {
    const { id } = createPayApp(db, 'p1', {});
    const r = applySendEffects(db, { itemType: 'payApp', itemId: id, userId: 'u1', role: 'admin', to: 'a@b', threadKey: 'k' });
    expect(r).toEqual({ applied: true });
    expect((db.prepare(`SELECT type FROM activity WHERE projectId='p1'`).all() as any[]).map(a => a.type)).toContain('pay_app_sent');
  });
  it('reports missing pay apps', () => {
    expect(applySendEffects(db, { itemType: 'payApp', itemId: 'nope', userId: 'u1', role: 'admin', to: 'a@b', threadKey: 'k' })).toEqual({ applied: false, skipped: 'missing' });
  });
  it('logs a punch_sent activity keyed by the project id', () => {
    const r = applySendEffects(db, { itemType: 'punch', itemId: 'p1', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(r).toEqual({ applied: true });
    expect((db.prepare(`SELECT type, projectId FROM activity WHERE projectId='p1'`).all() as any[])).toContainEqual(expect.objectContaining({ type: 'punch_sent', projectId: 'p1' }));
  });
});
