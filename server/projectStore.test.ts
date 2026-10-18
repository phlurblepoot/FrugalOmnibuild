import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listProjects, loadProject, createProject, saveProject, deleteProject,
  patchProject, normalizeProjectStatus, listProjectSummaries,
  projectDataSummary, visibleDataSummary,
  ValidationError, ConflictError, ProjectHasDataError,
} from './projectStore';
import { putBuffer, saveNewVersion, setFileFlags } from './files';
import { listCrews } from './dailyReportStore';
import { readFileContent } from './fileStore';
import { createInvoice, setInvoiceStatus, recordPayment } from './billingStore';
import { createSovLine, listSovLines, createPayApp, savePayAppLines, setPayApp } from './aiaStore';

let db: Database.Database;
let dir: string;

// A realistic legacy project blob exercising every normalization path.
const LEGACY_PROJECT = {
  id: 'proj1',
  name: 'Maple St Office',
  createdAt: 1700000000000,
  contractor: 'Hensel Phelps',
  address: '1 Maple St',
  bidDueDate: 1710000000000,
  planSets: [{ id: 'ps1', name: 'Rev A', date: '2024-01-01', createdAt: 1700000000001 }],
  pages: [
    {
      id: 'page1', name: 'A1.0', pageNumber: 'A1.0', description: 'Floor plan',
      imageId: '', thumbnailId: 'thumb1', imageWidth: 3000, imageHeight: 2000,
      sourcePdfFileId: 'pdf1', sourcePdfPageNum: 1, searchTextIndexed: true,
      extractedText: 'lobby corridor', planSetId: 'ps1',
      scaleConfig: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' },
      showLegend: true, legendPosition: { x: 5, y: 5 },
      measurements: [
        {
          id: 'm1', type: 'area', name: 'Lobby', color: '#ff0000', takeoffId: 't1',
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
          heights: [9], isTwoSided: false, regionId: 'r1', planSetId: 'ps1',
        },
        { id: 'm2', type: 'count', name: 'Outlets', color: '#00ff00', points: [{ x: 5, y: 5 }] },
      ],
    },
    {
      id: 'page2', name: 'A2.0', imageId: 'raster1', imageWidth: 1500, imageHeight: 1000,
      measurements: [], scaleConfig: null,
    },
  ],
  takeoffs: [
    {
      id: 't1', name: 'Drywall', color: '#ff0000', type: 'area', unit: 'sqft',
      isAdvancedCost: true,
      customCosts: [{ id: 'c1', name: 'Board', type: 'yield', cost: 12, yield: 32 }],
    },
  ],
  printouts: [{ id: 'po1', name: 'Bid set', fileId: 'pofile1', createdAt: 1705000000000 }],
  submitted: true,
  legendOnAllPages: true,
  proposalFileId: 'prop1',
  emails: [{ from: 'gc@example.com', subject: 'plans', body: 'see attached', receivedAt: 1, attachmentIds: ['att1'] }],
};

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-ps-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations.filter(m => m.version <= 4));
});

// migrationCap: leave undefined to run the full (latest) migrations array —
// the default for round-trip/saveProject tests. Pass 27 only for the
// "saveProject source-side file cascade" block below, which still exercises
// the pre-proposals p.printouts/proposalPhotoIds cascade in
// saveProject/loadProject (that logic — and these tests — are superseded
// once proposals become first-class rows, in a later task).
const seedLegacyAndNormalize = (blob: any, migrationCap?: number) => {
  db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)')
    .run(blob.id, JSON.stringify(blob), blob.createdAt);
  // also seed referenced files so labeling has rows to update
  for (const fid of ['thumb1', 'pdf1', 'raster1', 'pofile1', 'prop1', 'att1']) {
    db.prepare(`INSERT INTO files (id, mime, size, sha256, kind, createdAt) VALUES (?, 'application/octet-stream', 1, 'x', 'other', 1)`).run(fid);
  }
  const set = migrationCap == null ? migrations : migrations.filter(m => m.version <= migrationCap);
  runMigrations(db, dir, set); // applies migration 5 (and, by default, everything after it)
};

// A project with nothing in it, on the full (latest) schema.
const seedEmpty = (id: string) => {
  runMigrations(db, dir, migrations);
  createProject(db, { id, name: 'Empty', pages: [], takeoffs: [] });
};

describe('migration 5 + loadProject round-trip', () => {
  it('reassembles the legacy JSON shape exactly (plus version/status)', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const loaded = loadProject(db, 'proj1');
    // Migration 15 (plan-set sheet identity) backfills a durable sheetId onto
    // every page; assert it was assigned, then strip it for the exact-shape
    // comparison against the original legacy blob.
    for (const pg of loaded.pages) {
      expect(typeof pg.sheetId).toBe('string');
      expect(pg.sheetId).toBeTruthy();
      delete pg.sheetId;
    }
    // Migration 16 backfills customerId from contractor; strip it for the
    // legacy-shape comparison (it was never in the original blob).
    expect(typeof loaded.customerId).toBe('string');
    expect(loaded.customerId).toBeTruthy();
    delete loaded.customerId;
    // Two-stage lifecycle (spec 2026-08-16): full-document saves normalize to
    // bidding|in_progress; meta.accepted drives in_progress, everything else
    // (including this fixture's submitted:true) is a bid.
    // Migration 28 converts the legacy printouts/proposalFileId into
    // first-class proposal rows and strips both keys from meta — they were
    // never re-surfaced onto the loaded project shape (that's a later task),
    // so exclude them from the exact-shape comparison too.
    const { printouts: _printouts, proposalFileId: _proposalFileId, ...expectedRest } = LEGACY_PROJECT;
    expect(loaded).toEqual({ ...expectedRest, version: 1, status: 'bidding' });
  });

  it('nulls out the legacy data blob', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const row = db.prepare('SELECT data FROM projects WHERE id = ?').get('proj1') as { data: string | null };
    expect(row.data).toBeNull();
  });

  it('labels referenced files with projectId and kind', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const kind = (id: string) => (db.prepare('SELECT projectId, kind FROM files WHERE id = ?').get(id) as any);
    // Migration 23 requalifies the uploaded PDF behind a page as `plan-source`
    // (the page raster + thumbnail stay `plan`) and gives it a plan-set source.
    expect(kind('pdf1')).toEqual({ projectId: 'proj1', kind: 'plan-source' });
    expect(db.prepare('SELECT sourceType, sourceId FROM files WHERE id = ?').get('pdf1'))
      .toEqual({ sourceType: 'plan-set', sourceId: 'ps1' });
    expect(kind('thumb1')).toEqual({ projectId: 'proj1', kind: 'plan' });
    expect(kind('raster1')).toEqual({ projectId: 'proj1', kind: 'plan' });
    // Migration 23 first labels pofile1 `printout`; migration 28 then relabels
    // this non-proposal-named printout as a `takeoff-print` document (prop1's
    // `proposal` kind is unaffected — 28 only repoints its sourceId, which
    // this assertion doesn't check).
    expect(kind('pofile1')).toEqual({ projectId: 'proj1', kind: 'takeoff-print' });
    expect(kind('prop1')).toEqual({ projectId: 'proj1', kind: 'proposal' });
    expect(kind('att1')).toEqual({ projectId: 'proj1', kind: 'document' });
  });

  it('derives status from legacy flags (archived no longer drives status — it is orthogonal)', () => {
    seedLegacyAndNormalize({ ...LEGACY_PROJECT, id: 'p2', submitted: false, archived: true });
    const loaded = loadProject(db, 'p2')!;
    expect(loaded.status).toBe('bidding');
    expect(loaded.archived).toBe(true);
  });

  it('derives in_progress status from meta.accepted', () => {
    seedLegacyAndNormalize({ ...LEGACY_PROJECT, id: 'p3', submitted: false, accepted: true });
    expect(loadProject(db, 'p3')!.status).toBe('in_progress');
  });

  it('skips non-object blobs without failing the migration (data preserved)', () => {
    const ins = db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
    ins.run('badNull', 'null', 1);
    ins.run('badArr', '[1,2]', 2);
    ins.run(LEGACY_PROJECT.id, JSON.stringify(LEGACY_PROJECT), LEGACY_PROJECT.createdAt);
    expect(() => runMigrations(db, dir, migrations)).not.toThrow();
    // the valid project normalized
    expect(loadProject(db, 'proj1')!.name).toBe('Maple St Office');
    expect((db.prepare('SELECT data FROM projects WHERE id = ?').get('proj1') as any).data).toBeNull();
    // the bad rows' data preserved, not nulled
    expect((db.prepare('SELECT data FROM projects WHERE id = ?').get('badNull') as any).data).toBe('null');
    expect((db.prepare('SELECT data FROM projects WHERE id = ?').get('badArr') as any).data).toBe('[1,2]');
  });
});

describe('saveProject', () => {
  beforeEach(() => seedLegacyAndNormalize(LEGACY_PROJECT));

  it('persists changes and bumps version', () => {
    const p = loadProject(db, 'proj1')!;
    p.name = 'Renamed';
    p.pages[0].measurements.push({ id: 'm3', type: 'length', name: 'Wall', color: '#0000ff', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    const result = saveProject(db, 'proj1', p);
    expect(result.version).toBe(2);
    const reloaded = loadProject(db, 'proj1')!;
    expect(reloaded.name).toBe('Renamed');
    expect(reloaded.version).toBe(2);
    expect(reloaded.pages[0].measurements).toHaveLength(3);
  });

  it('round-trips a measurement multiplier through the attrs JSON (and clears it)', () => {
    const p = loadProject(db, 'proj1')!;
    p.pages[0].measurements[0].multiplier = 4;
    saveProject(db, 'proj1', p);
    const row = db.prepare('SELECT attrs FROM measurements WHERE id = ?').get('m1') as { attrs: string };
    expect(JSON.parse(row.attrs).multiplier).toBe(4);
    const reloaded = loadProject(db, 'proj1')!;
    expect(reloaded.pages[0].measurements[0].multiplier).toBe(4);

    // Back to ×1: the client drops the field, and so does the stored row.
    delete reloaded.pages[0].measurements[0].multiplier;
    saveProject(db, 'proj1', reloaded);
    expect(loadProject(db, 'proj1')!.pages[0].measurements[0]).not.toHaveProperty('multiplier');
  });

  it('rejects a stale version with ConflictError', () => {
    const stale = loadProject(db, 'proj1')!;
    const fresh = loadProject(db, 'proj1')!;
    saveProject(db, 'proj1', fresh); // bumps to 2
    expect(() => saveProject(db, 'proj1', stale)).toThrow(ConflictError);
    // and the stale payload changed nothing
    expect(loadProject(db, 'proj1')!.version).toBe(2);
  });

  it('rejects payloads with missing version', () => {
    const p = loadProject(db, 'proj1')!;
    delete p.version;
    expect(() => saveProject(db, 'proj1', p)).toThrow(ValidationError);
  });

  it('rejects structurally invalid payloads', () => {
    const p = loadProject(db, 'proj1')!;
    expect(() => saveProject(db, 'proj1', { ...p, pages: undefined })).toThrow(ValidationError);
    expect(() => saveProject(db, 'proj1', { ...p, pages: 'nope' })).toThrow(ValidationError);
    expect(() => saveProject(db, 'proj1', { ...p, id: 'other' })).toThrow(ValidationError);
    expect(() => saveProject(db, 'proj1', { ...p, name: 42 })).toThrow(ValidationError);
  });

  it('round-trips an aiaSettings object through the meta column', () => {
    const aiaSettings = {
      billingMode: 'aia',
      retainagePercent: 10,
      storedRetainagePercent: 10,
      ownerName: 'City of Springfield',
      ownerAddress: '100 Main St',
      architectName: 'Wright & Assoc',
      architectAddress: '200 Oak Ave',
      contractDate: '2024-03-01',
      ownerProjectNumber: 'OPN-42',
      architectProjectNumber: 'APN-7',
      contractFor: 'General Construction',
    };
    const p = loadProject(db, 'proj1')!;
    p.aiaSettings = aiaSettings;
    saveProject(db, 'proj1', p);
    const reloaded = loadProject(db, 'proj1')!;
    expect(reloaded.aiaSettings).toEqual(aiaSettings);
  });

  it('never touches the files table on save', () => {
    const before = db.prepare('SELECT COUNT(*) as c FROM files').get() as any;
    const p = loadProject(db, 'proj1')!;
    p.pages = [p.pages[1]]; // drop page1 and all its file references
    saveProject(db, 'proj1', p);
    const after = db.prepare('SELECT COUNT(*) as c FROM files').get() as any;
    expect(after.c).toBe(before.c); // orphaned, NOT deleted
  });

  it('round-trips customerId through the dedicated column (not the meta blob)', () => {
    const p = loadProject(db, 'proj1')!;
    p.customerId = 'c1';
    saveProject(db, 'proj1', p);
    // Verify the value is stored in the dedicated column, not the meta JSON blob
    const row = db.prepare('SELECT customerId, meta FROM projects WHERE id = ?').get('proj1') as any;
    expect(row.customerId).toBe('c1');
    const meta = JSON.parse(row.meta);
    expect(meta.customerId).toBeUndefined(); // must NOT be leaked into meta
    const reloaded = loadProject(db, 'proj1')!;
    expect(reloaded.customerId).toBe('c1');
  });
});

describe('createProject / listProjects / deleteProject', () => {
  it('creates with version 1 and round-trips', () => {
    const result = createProject(db, { ...LEGACY_PROJECT, id: 'new1' });
    expect(result.version).toBe(1);
    expect(loadProject(db, 'new1')!.name).toBe('Maple St Office');
  });

  it('lists newest-first', () => {
    const bare = (id: string, createdAt: number) =>
      ({ ...LEGACY_PROJECT, id, createdAt, planSets: undefined, pages: [], takeoffs: [] });
    createProject(db, bare('a', 1));
    createProject(db, bare('b', 2));
    expect(listProjects(db).map((p: any) => p.id)).toEqual(['b', 'a']);
  });

  it('fails loudly when two projects share child ids (collision = data bug, never silent theft)', () => {
    createProject(db, { ...LEGACY_PROJECT, id: 'a' });
    expect(() => createProject(db, { ...LEGACY_PROJECT, id: 'b' })).toThrow();
    // transaction rolled back: project b does not half-exist
    expect(loadProject(db, 'b')).toBeNull();
  });

  it('delete refuses a project with plan pages and measurements, and keeps all of it', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    expect(() => deleteProject(db, dir, 'proj1')).toThrow(ProjectHasDataError);
    expect(loadProject(db, 'proj1')).not.toBeNull();
    for (const t of ['pages', 'measurements', 'takeoffs', 'plan_sets', 'files']) {
      expect((db.prepare(`SELECT COUNT(*) as c FROM ${t} WHERE projectId = 'proj1'`).get() as any).c, t).toBeGreaterThan(0);
    }
  });

  it('delete clears an empty project and its scaffolding', () => {
    seedEmpty('proj1');
    // Scaffolding a project picks up before anything is in it.
    createProject(db, { id: 'scaf', name: 'S', pages: [], takeoffs: [] }); // not touched
    saveProject(db, 'proj1', {
      id: 'proj1', name: 'Empty', version: 1, pages: [],
      planSets: [{ id: 'ps1', name: 'Rev A' }], takeoffs: [{ id: 't1', name: 'Drywall', type: 'area' }],
    });
    listCrews(db, 'proj1'); // the Daily Reports page makes "Crew 1" just by opening
    db.prepare(`INSERT INTO aia_sov_locks (projectId, lockedAt, lockedByUserId, reason) VALUES ('proj1', 1, NULL, 'manual')`).run();

    deleteProject(db, dir, 'proj1');

    expect(loadProject(db, 'proj1')).toBeNull();
    for (const t of ['takeoffs', 'plan_sets', 'daily_report_crews', 'aia_sov_locks']) {
      expect((db.prepare(`SELECT COUNT(*) as c FROM ${t} WHERE projectId = 'proj1'`).get() as any).c, t).toBe(0);
    }
    expect(loadProject(db, 'scaf')).not.toBeNull();
  });

  it('delete spares task photos — a task outlives the project it merely refers to', () => {
    seedEmpty('proj1');
    db.prepare('INSERT INTO tasks (id, title, projectId, createdAt) VALUES (?, ?, ?, ?)')
      .run('task1', 'Order material', 'proj1', 1);
    // migration 23 attributes task photos to their task's project, which put
    // them in reach of the project-owned file sweep for the first time
    putBuffer(db, dir, 'tphoto1', Buffer.from('photobytes'), 'image/jpeg', { projectId: 'proj1', kind: 'task-photo' });
    db.prepare('INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES (?, ?, ?, ?)')
      .run('tp1', 'task1', 'tphoto1', 1);

    // A task (and its photo) isn't project data, so it doesn't stop the delete.
    deleteProject(db, dir, 'proj1');

    expect(loadProject(db, 'proj1')).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE id = 'task1'`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) as c FROM task_photos WHERE id = 'tp1'`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) as c FROM files WHERE id = 'tphoto1'`).get()).toEqual({ c: 1 });
    expect(readFileContent(dir, 'tphoto1')!.toString()).toBe('photobytes'); // bytes survive too
  });

  it('delete refuses a project with AIA billing, and keeps it', () => {
    seedEmpty('proj1');
    db.prepare(`INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, sortOrder, version, createdAt) VALUES ('sov1', 'proj1', 'Line', 100000, 0, 1, 1)`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'proj1', 1, 'draft', 1, 1)`).run();
    db.prepare(`INSERT INTO aia_pay_app_lines (id, payAppId, sovLineId, percentComplete, storedMaterialsCents, createdAt) VALUES ('pl1', 'app1', 'sov1', 50, 0, 1)`).run();
    let err: unknown;
    try { deleteProject(db, dir, 'proj1'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProjectHasDataError);
    expect((err as ProjectHasDataError).summary).toEqual({ payApps: 1, sovLines: 1 });
    expect((db.prepare(`SELECT COUNT(*) as c FROM aia_sov_lines WHERE projectId = 'proj1'`).get() as any).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) as c FROM aia_pay_apps WHERE projectId = 'proj1'`).get() as any).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) as c FROM aia_pay_app_lines WHERE id = 'pl1'`).get() as any).c).toBe(1);
  });

  it('delete refuses a project with payments on its invoices and pay apps, and keeps them', () => {
    seedEmpty('proj1');
    db.prepare(`INSERT INTO invoices (id, projectId, status, version, createdAt) VALUES ('inv1', 'proj1', 'draft', 1, 1)`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'proj1', 1, 'draft', 1, 1)`).run();
    db.prepare(`INSERT INTO payments (id, targetType, targetId, amount, createdAt) VALUES ('payi', 'invoice', 'inv1', 10, 1)`).run();
    db.prepare(`INSERT INTO payments (id, targetType, targetId, amount, createdAt) VALUES ('paya', 'payapp', 'app1', 20, 1)`).run();
    expect(() => deleteProject(db, dir, 'proj1')).toThrow(ProjectHasDataError);
    expect((db.prepare(`SELECT COUNT(*) as c FROM payments`).get() as any).c).toBe(2);
  });
});

// Only a project with nothing in it can be deleted (spec
// docs/superpowers/specs/2026-10-07-project-delete-guard-design.md).
describe('projectDataSummary', () => {
  // One seeder per kind of data; each makes just that kind (payments need the
  // invoice they pay).
  const SEED: Record<string, (id: string) => void> = {
    documents: id => { putBuffer(db, dir, `doc-${id}`, Buffer.from('%PDF'), 'application/pdf', { projectId: id, kind: 'document' }); },
    planPages: id => { db.prepare('INSERT INTO pages (id, projectId) VALUES (?, ?)').run(`pg-${id}`, id); },
    measurements: id => { db.prepare(`INSERT INTO measurements (id, pageId, projectId, type, points) VALUES (?, 'nopage', ?, 'count', '[]')`).run(`m-${id}`, id); },
    proposals: id => { db.prepare('INSERT INTO proposals (id, projectId, number, createdAt, updatedAt) VALUES (?, ?, 1, 1, 1)').run(`pr-${id}`, id); },
    invoices: id => { db.prepare(`INSERT INTO invoices (id, projectId, status, version, createdAt) VALUES (?, ?, 'draft', 1, 1)`).run(`inv-${id}`, id); },
    payments: id => {
      db.prepare(`INSERT INTO invoices (id, projectId, status, version, createdAt) VALUES (?, ?, 'sent', 1, 1)`).run(`inv-paid-${id}`, id);
      db.prepare(`INSERT INTO payments (id, targetType, targetId, amount, createdAt) VALUES (?, 'invoice', ?, 10, 1)`).run(`pay-${id}`, `inv-paid-${id}`);
    },
    changeOrders: id => { db.prepare(`INSERT INTO change_orders (id, projectId, createdAt) VALUES (?, ?, 1)`).run(`co-${id}`, id); },
    payApps: id => { db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, createdAt) VALUES (?, ?, 1, 1)`).run(`app-${id}`, id); },
    sovLines: id => { db.prepare('INSERT INTO aia_sov_lines (id, projectId, createdAt) VALUES (?, ?, 1)').run(`sov-${id}`, id); },
    rfis: id => { db.prepare('INSERT INTO rfis (id, projectId, number, createdAt) VALUES (?, ?, 1, 1)').run(`rfi-${id}`, id); },
    issues: id => { db.prepare('INSERT INTO issues (id, projectId, number, createdAt) VALUES (?, ?, 1, 1)').run(`iss-${id}`, id); },
    punchItems: id => { db.prepare('INSERT INTO punch_items (id, projectId, createdAt) VALUES (?, ?, 1)').run(`pi-${id}`, id); },
    dailyReports: id => {
      const crewId = listCrews(db, id)[0].id;
      db.prepare(`INSERT INTO daily_reports (id, projectId, crewId, reportDate, createdAt, updatedAt) VALUES (?, ?, ?, '2026-10-01', 1, 1)`).run(`dr-${id}`, id, crewId);
    },
    timeEntries: id => { db.prepare(`INSERT INTO time_entries (id, userId, projectId, clockIn, createdAt) VALUES (?, 'u1', ?, 1, 1)`).run(`te-${id}`, id); },
    notes: id => {
      const board = { id: `n-${id}`, projectId: id, elements: [{ id: 'e1', type: 'text', x: 0, y: 0, content: 'Call the GC' }], viewport: { x: 0, y: 0, zoom: 1 } };
      db.prepare('INSERT INTO notes (id, projectId, data, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1)').run(board.id, id, JSON.stringify(board));
    },
    linkedEmails: id => {
      db.prepare(`INSERT INTO mail_thread_links (id, threadKey, itemType, itemId, projectId, linkedByUserId, createdAt) VALUES (?, 'thread-1', 'project', ?, ?, 'u1', '2026-10-01')`)
        .run(`ml-${id}`, id, id);
    },
  };

  beforeEach(() => runMigrations(db, dir, migrations));

  it('an empty project has no data and deletes', () => {
    createProject(db, { id: 'p', name: 'Mistake', pages: [], takeoffs: [] });
    expect(projectDataSummary(db, 'p')).toEqual({ hasData: false, summary: {} });
    deleteProject(db, dir, 'p');
    expect(loadProject(db, 'p')).toBeNull();
  });

  it('counts every kind of data, and only the kinds the project has', () => {
    createProject(db, { id: 'p', name: 'Job', pages: [], takeoffs: [] });
    for (const seed of Object.values(SEED)) seed('p');
    SEED.issues('p2'); // another project's data stays out of it
    db.prepare(`INSERT INTO issues (id, projectId, number, createdAt) VALUES ('iss-second', 'p', 2, 1)`).run();
    const { hasData, summary } = projectDataSummary(db, 'p');
    expect(hasData).toBe(true);
    expect(summary).toEqual({
      documents: 1, planPages: 1, measurements: 1, proposals: 1, invoices: 2, payments: 1,
      changeOrders: 1, payApps: 1, sovLines: 1, rfis: 1, issues: 2, punchItems: 1,
      dailyReports: 1, timeEntries: 1, notes: 1, linkedEmails: 1,
    });
  });

  it.each(Object.keys(SEED))('%s alone stops the delete, and nothing is removed', kind => {
    createProject(db, { id: 'p', name: 'Job', pages: [], takeoffs: [{ id: 't1', name: 'Drywall' }] });
    SEED[kind]('p');
    let err: unknown;
    try { deleteProject(db, dir, 'p'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProjectHasDataError);
    expect((err as ProjectHasDataError).summary[kind]).toBeGreaterThan(0);
    expect(loadProject(db, 'p')).not.toBeNull();
    expect((db.prepare(`SELECT COUNT(*) as c FROM takeoffs WHERE projectId = 'p'`).get() as any).c).toBe(1);
  });

  it('scaffolding is not data: empty takeoffs and plan sets, the auto crew, an empty notes board, the SOV lock, activity, tasks', () => {
    createProject(db, {
      id: 'p', name: 'Job', pages: [], planSets: [{ id: 'ps1', name: 'Rev A' }],
      takeoffs: [{ id: 't1', name: 'Drywall', type: 'area', costPerUnit: 2 }, { id: 't2', name: 'Paint' }],
    });
    listCrews(db, 'p');
    db.prepare(`INSERT INTO notes (id, projectId, data, createdAt, updatedAt) VALUES ('n1', 'p', ?, 1, 1)`)
      .run(JSON.stringify({ id: 'n1', projectId: 'p', elements: [], viewport: { x: 40, y: 10, zoom: 2 } }));
    db.prepare(`INSERT INTO aia_sov_locks (projectId, lockedAt, lockedByUserId, reason) VALUES ('p', 1, NULL, 'manual')`).run();
    db.prepare(`INSERT INTO activity (id, projectId, type, message, createdAt) VALUES ('a1', 'p', 'project_created', 'Project "Job" created', 1)`).run();
    db.prepare(`INSERT INTO tasks (id, title, projectId, createdAt) VALUES ('task1', 'Order material', 'p', 1)`).run();
    putBuffer(db, dir, 'tphoto1', Buffer.from('jpg'), 'image/jpeg', { projectId: 'p', kind: 'task-photo' });
    expect(projectDataSummary(db, 'p')).toEqual({ hasData: false, summary: {} });
  });

  it('a crew with a report counts — through its report', () => {
    createProject(db, { id: 'p', name: 'Job', pages: [], takeoffs: [] });
    SEED.dailyReports('p');
    expect(projectDataSummary(db, 'p').summary).toEqual({ dailyReports: 1 });
  });

  it('documents: archived ones count, a document and its old versions count once, page images count as plan pages', () => {
    createProject(db, { id: 'p', name: 'Job', pages: [], takeoffs: [] });
    putBuffer(db, dir, 'spec', Buffer.from('v1'), 'application/pdf', { projectId: 'p', kind: 'document' });
    saveNewVersion(db, dir, 'spec', Buffer.from('v2'), 'application/pdf');
    putBuffer(db, dir, 'old', Buffer.from('x'), 'application/pdf', { projectId: 'p', kind: 'document' });
    setFileFlags(db, 'old', { archived: true });
    expect(projectDataSummary(db, 'p').summary).toEqual({ documents: 2 });

    // A plan page's image and thumbnail are the page, not two more documents;
    // its source PDF is a document.
    putBuffer(db, dir, 'img1', Buffer.from('png'), 'image/png', { projectId: 'p', kind: 'plan' });
    putBuffer(db, dir, 'th1', Buffer.from('png'), 'image/png', { projectId: 'p', kind: 'plan' });
    putBuffer(db, dir, 'plans', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p', kind: 'plan-source' });
    db.prepare(`INSERT INTO pages (id, projectId, imageId, thumbnailId, sourcePdfFileId) VALUES ('pg1', 'p', 'img1', 'th1', 'plans')`).run();
    expect(projectDataSummary(db, 'p').summary).toEqual({ documents: 3, planPages: 1 });

    // A page image whose page is gone still goes with a delete — it counts.
    db.prepare(`DELETE FROM pages WHERE id = 'pg1'`).run();
    expect(projectDataSummary(db, 'p').summary).toEqual({ documents: 5 });
  });

  it('only notes with something on the board count, one per item', () => {
    createProject(db, { id: 'p', name: 'Job', pages: [], takeoffs: [] });
    db.prepare(`INSERT INTO notes (id, projectId, data, createdAt, updatedAt) VALUES ('n1', 'p', ?, 1, 1)`)
      .run(JSON.stringify({ elements: [{ id: 'a' }, { id: 'b' }] }));
    db.prepare(`INSERT INTO notes (id, projectId, data, createdAt, updatedAt) VALUES ('n2', 'p', 'not json', 1, 1)`).run();
    expect(projectDataSummary(db, 'p').summary).toEqual({ notes: 2 });
  });

  it('shows others how much there is without naming admin-only kinds', () => {
    const summary = { documents: 3, invoices: 2, payments: 1, proposals: 1, changeOrders: 1, payApps: 1, sovLines: 4, timeEntries: 2, rfis: 1 };
    expect(visibleDataSummary(summary, true)).toBe(summary);
    expect(visibleDataSummary(summary, false)).toEqual({ documents: 3, rfis: 1, otherRecords: 12 });
    expect(visibleDataSummary({ documents: 1 }, false)).toEqual({ documents: 1 });
  });
});

describe('two-stage lifecycle', () => {
  it('normalizes every legacy status per the collapse table', () => {
    const cases: [string, string][] = [
      ['estimating', 'bidding'], ['proposal_sent', 'bidding'],
      ['awarded', 'in_progress'], ['in_progress', 'in_progress'],
      ['punch_list', 'in_progress'], ['complete', 'in_progress'],
      ['lost', 'bidding'], ['archived', 'in_progress'],
      ['garbage', 'bidding'],
    ];
    for (const [oldS, newS] of cases) expect(normalizeProjectStatus(oldS)).toBe(newS);
  });

  it('patchProject rejects legacy statuses and accepts the two live ones', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const v1 = loadProject(db, 'proj1')!.version;
    const result = patchProject(db, 'proj1', { version: v1, status: 'bidding' });
    expect(result.status).toBe('bidding');
    expect(loadProject(db, 'proj1')!.status).toBe('bidding');
    const v2 = result.version;
    expect(() => patchProject(db, 'proj1', { version: v2, status: 'estimating' })).toThrow(ValidationError);
  });

  it('patchProject accepts lostBid boolean and stores it in meta', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const v1 = loadProject(db, 'proj1')!.version;
    patchProject(db, 'proj1', { version: v1, lostBid: true });
    expect(loadProject(db, 'proj1')!.lostBid).toBe(true);
    const v2 = loadProject(db, 'proj1')!.version;
    expect(() => patchProject(db, 'proj1', { version: v2, lostBid: 'yes' })).toThrow(ValidationError);
  });

  it('surfaces lostBid on summary rows so the Archive tab can badge it', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    expect(listProjectSummaries(db, 'proj1')[0].lostBid).toBe(false);

    const v = loadProject(db, 'proj1')!.version;
    patchProject(db, 'proj1', { version: v, archived: true, lostBid: true });
    const row = listProjectSummaries(db, 'proj1')[0];
    expect([row.archived, row.lostBid]).toEqual([true, true]);
  });

  it('summary outstandingCents spans invoices AND finalized pay applications', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);

    const inv = createInvoice(db, 'proj1', { number: 'INV-1', lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    setInvoiceStatus(db, inv.id, 'sent');
    expect(listProjectSummaries(db, 'proj1')[0].outstandingCents).toBe(10000);

    // An AIA pay app the board used to be blind to: $1,000 billed, $250 paid.
    createSovLine(db, 'proj1', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(db, 'proj1', { retainagePercent: 0, storedRetainagePercent: 0 });
    const sov = listSovLines(db, 'proj1');
    savePayAppLines(db, app.id, [{ sovLineId: sov[0].id, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    setPayApp(db, app.id, { status: 'finalized' });
    recordPayment(db, 'payapp', app.id, { amount: 250 });

    expect(listProjectSummaries(db, 'proj1')[0].outstandingCents).toBe(85000);
  });
});
