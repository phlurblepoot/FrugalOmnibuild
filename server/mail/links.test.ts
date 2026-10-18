/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { saveCustomer } from '../customerStore';
import { createRfi } from '../rfiStore';
import { resolveChain, createLink, listLinksForItem, listLinksForThread, deleteLink, resolveLinkLabel } from './links';

let db: Database.Database; let projectId: string; let customerId: string; let rfiId: string;
beforeEach(() => {
  db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ln-')), migrations);
  customerId = 'c1'; saveCustomer(db, { id: 'c1', name: 'Tidewater' } as any);   // saveCustomer(db, c: Customer) — server/customerStore.ts:55; fill required fields if it throws
  projectId = 'p1'; createProject(db, { id: projectId, name: 'Dunmore', createdAt: 1, customerId, pages: [], takeoffs: [] } as any);
  rfiId = createRfi(db, projectId, { title: 'Ceilings' }).id;
});
describe('links', () => {
  it('resolves rfi → project → customer', () => {
    expect(resolveChain(db, 'rfi', rfiId)).toEqual({ projectId, customerId });
    expect(resolveChain(db, 'project', projectId)).toEqual({ projectId, customerId });
    expect(resolveChain(db, 'customer', customerId)).toEqual({ projectId: null, customerId });
    expect(resolveChain(db, 'rfi', 'missing')).toEqual({ projectId: null, customerId: null });
    // an itemType with no table mapping must not interpolate `undefined` into the SQL
    expect(resolveChain(db, 'nope' as any, 'x')).toEqual({ projectId: null, customerId: null });
  });
  it('createLink is idempotent and denormalizes the chain', () => {
    const a = createLink(db, { threadKey: 'k', itemType: 'rfi', itemId: rfiId, linkedByUserId: 'u1', subjectSnapshot: 'RFI-001' });
    const b = createLink(db, { threadKey: 'k', itemType: 'rfi', itemId: rfiId, linkedByUserId: 'u2' });
    expect(b.id).toBe(a.id); expect(a.projectId).toBe(projectId); expect(a.customerId).toBe(customerId);
    expect(listLinksForItem(db, 'rfi', rfiId).length).toBe(1);
    expect(listLinksForThread(db, 'k').map(l => l.itemType)).toEqual(['rfi']);
    deleteLink(db, a.id); expect(listLinksForThread(db, 'k')).toEqual([]);
  });
});

describe('resolveLinkLabel', () => {
  it('formats each item type in the app\'s own display convention', () => {
    db.prepare(`INSERT INTO proposals (id, projectId, number, status, createdAt, updatedAt) VALUES ('pr1', ?, 2, 'draft', 1, 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'proposal', 'pr1')).toBe('Proposal #2');

    db.prepare(`INSERT INTO invoices (id, projectId, number, status, createdAt) VALUES ('in1', ?, '104', 'draft', 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'invoice', 'in1')).toBe('Invoice 104');

    db.prepare(`INSERT INTO change_orders (id, projectId, number, title, description, amount, status, createdAt) VALUES ('co1', ?, '3', 'Kitchen electrical', '', 0, 'pending', 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'changeOrder', 'co1')).toBe('CO-3 — Kitchen electrical');

    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, createdAt) VALUES ('pa1', ?, 1, 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'payApp', 'pa1')).toBe('Pay App #1');

    db.prepare(`INSERT INTO issues (id, projectId, number, title, status, createdAt) VALUES ('is1', ?, 4, 'Cracked tile', 'open', 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'issue', 'is1')).toBe('ISS-004 — Cracked tile');

    expect(resolveLinkLabel(db, 'rfi', rfiId)).toBe('RFI-001 — Ceilings');

    // One date can hold a report per crew (migration 45), so the crew names it too.
    db.prepare(`INSERT INTO daily_report_crews (id, projectId, name, sortOrder, createdAt, updatedAt) VALUES ('crew1', ?, 'Smith Drywall', 0, 1, 1)`).run(projectId);
    db.prepare(`INSERT INTO daily_reports (id, projectId, crewId, reportDate, createdAt, updatedAt) VALUES ('dr1', ?, 'crew1', '2026-09-01', 1, 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'dailyReport', 'dr1')).toBe('Daily Report — Sep 1, 2026 — Smith Drywall');

    expect(resolveLinkLabel(db, 'punch', projectId)).toBe('Dunmore');
    expect(resolveLinkLabel(db, 'project', projectId)).toBe('Dunmore');
    expect(resolveLinkLabel(db, 'customer', customerId)).toBe('Tidewater');

    db.prepare(`INSERT INTO tasks (id, title, createdAt) VALUES ('t1', 'Order shingles', 1)`).run();
    expect(resolveLinkLabel(db, 'task', 't1')).toBe('Order shingles');
  });

  it('falls back to the capitalized type name when the row is missing', () => {
    expect(resolveLinkLabel(db, 'proposal', 'missing')).toBe('Proposal');
    expect(resolveLinkLabel(db, 'invoice', 'missing')).toBe('Invoice');
    expect(resolveLinkLabel(db, 'changeOrder', 'missing')).toBe('Change Order');
    expect(resolveLinkLabel(db, 'payApp', 'missing')).toBe('Pay App');
    expect(resolveLinkLabel(db, 'issue', 'missing')).toBe('Issue');
    expect(resolveLinkLabel(db, 'rfi', 'missing')).toBe('RFI');
    expect(resolveLinkLabel(db, 'dailyReport', 'missing')).toBe('Daily Report');
    expect(resolveLinkLabel(db, 'punch', 'missing')).toBe('Punch');
    expect(resolveLinkLabel(db, 'project', 'missing')).toBe('Project');
    expect(resolveLinkLabel(db, 'task', 'missing')).toBe('Task');
    expect(resolveLinkLabel(db, 'customer', 'missing')).toBe('Customer');
    // an itemType with no resolver at all still echoes a fallback, never throws
    expect(resolveLinkLabel(db, 'nope' as any, 'x')).toBe('nope');
  });

  it('formats the daily report date the same way as every other surface (Mon D, YYYY), not raw ISO', () => {
    // Regression: a first pass emitted the raw ISO string ('2026-08-26') instead of
    // matching formatReportDate ('Aug 26, 2026') used by the list row, editor title,
    // email subject, and PDF.
    db.prepare(`INSERT INTO daily_report_crews (id, projectId, name, sortOrder, createdAt, updatedAt) VALUES ('crew2', ?, 'Crew 1', 0, 1, 1)`).run(projectId);
    db.prepare(`INSERT INTO daily_reports (id, projectId, crewId, reportDate, createdAt, updatedAt) VALUES ('dr2', ?, 'crew2', '2026-08-26', 1, 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'dailyReport', 'dr2')).toBe('Daily Report — Aug 26, 2026 — Crew 1');
    // A malformed date (shouldn't happen, but the format falls back rather than throwing)
    db.prepare(`INSERT INTO daily_reports (id, projectId, crewId, reportDate, createdAt, updatedAt) VALUES ('dr3', ?, 'crew2', 'garbage', 1, 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'dailyReport', 'dr3')).toBe('Daily Report — garbage — Crew 1');
    // A report whose crew row is gone (a deleted project's) keeps its date label.
    db.prepare(`INSERT INTO daily_reports (id, projectId, crewId, reportDate, createdAt, updatedAt) VALUES ('dr4', ?, 'gone', '2026-08-27', 1, 1)`).run(projectId);
    expect(resolveLinkLabel(db, 'dailyReport', 'dr4')).toBe('Daily Report — Aug 27, 2026');
  });
});
