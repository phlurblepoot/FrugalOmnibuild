import { describe, it, expect, vi } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { getDataUrlString } from './files';
import { readFileContent } from './fileStore';
import { loadMailCrypto } from './mail/crypto';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-ml-'));

const tableNames = (db: any): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name);

const columnNames = (db: any, table: string): string[] =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => r.name);

describe('migrations 1-3 on a fresh database', () => {
  it('creates legacy and new tables', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 3));
    const tables = tableNames(db);
    for (const t of ['projects', 'images', 'templates', 'bids', 'users', 'notes',
                     'settings', 'user_preferences', 'shares', 'checklists',
                     'email_accounts', 'time_entries',
                     'files', 'plan_sets', 'pages', 'takeoffs', 'measurements', 'activity']) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
    db.close();
  });

  it('adds the new project columns', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 3));
    const cols = columnNames(db, 'projects');
    for (const c of ['id', 'data', 'createdAt', 'name', 'status', 'contractor',
                     'address', 'bidDueDate', 'contractValue', 'version', 'updatedAt', 'meta']) {
      expect(cols, `missing column ${c}`).toContain(c);
    }
    db.close();
  });

  it('is a no-op on a database that already has the legacy tables', () => {
    const db = openDb(':memory:');
    // simulate a live db created by the old initDb()
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
             CREATE TABLE images (id TEXT PRIMARY KEY, data TEXT);`);
    db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)')
      .run('p1', '{"id":"p1"}', 123);
    expect(() => runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 3))).not.toThrow();
    const row = db.prepare('SELECT data FROM projects WHERE id = ?').get('p1') as { data: string };
    expect(row.data).toBe('{"id":"p1"}');
    db.close();
  });
});

describe('migration 4: images-to-disk', () => {
  it('moves dataURL rows to disk, creates files rows, drops images table', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 3));
    const png = 'data:image/png;base64,' + Buffer.from('imgbytes').toString('base64');
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('imgA', png);
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('imgB', 'bm90LWEtZGF0YXVybA==');

    runMigrations(db, dir, migrations.filter(m => m.version <= 4));

    expect(tableNames(db)).not.toContain('images');
    expect(getDataUrlString(db, dir, 'imgA')).toBe(png);
    expect(readFileContent(dir, 'imgA')!.toString()).toBe('imgbytes');
    // non-dataURL row round-trips as the same bare-base64 string
    expect(getDataUrlString(db, dir, 'imgB')).toBe('bm90LWEtZGF0YXVybA==');
    const metaA = db.prepare('SELECT mime, kind, legacyFormat FROM files WHERE id = ?').get('imgA') as any;
    expect(metaA.mime).toBe('image/png');
    expect(metaA.kind).toBe('other');
    expect(metaA.legacyFormat).toBe('dataurl');
    db.close();
  });

  it('skips empty rows without failing', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 3));
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('empty1', null);
    expect(() => runMigrations(db, dir, migrations.filter(m => m.version <= 4))).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c).toBe(0);
    db.close();
  });

  it('preserves non-canonical dataURL prefixes through migration', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 3));
    const url = 'data:text/plain;charset=utf-8;base64,' + Buffer.from('hello').toString('base64');
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('txt1', url);
    runMigrations(db, dir, migrations.filter(m => m.version <= 4));
    expect(getDataUrlString(db, dir, 'txt1')).toBe(url);
    db.close();
  });
});

describe('migration 6: remove-bid-inbox', () => {
  it('drops the bids and email_accounts tables', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).not.toContain('bids');
    expect(tables).not.toContain('email_accounts');
    db.close();
  });

  it('preserves bid attachment files rows', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 5));
    db.prepare(`INSERT INTO files (id, mime, size, sha256, kind, createdAt) VALUES ('att1','application/pdf',1,'x','document',1)`).run();
    runMigrations(db, dir, migrations);
    expect((db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c).toBe(1);
    db.close();
  });
});

describe('migration 7: drafts', () => {
  it('creates the drafts table keyed by user+file', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    expect(tableNames(db)).toContain('drafts');
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1','f1','pdf','{}',1)`).run();
    // same key replaces, different user coexists
    db.prepare(`INSERT OR REPLACE INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1','f1','pdf','{"a":1}',2)`).run();
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u2','f1','pdf','{}',1)`).run();
    expect((db.prepare('SELECT COUNT(*) AS c FROM drafts').get() as any).c).toBe(2);
    db.close();
  });
});

describe('migration 8: billing', () => {
  it('creates invoices, invoice_lines, payments, change_orders', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    for (const t of ['invoices', 'invoice_lines', 'payments', 'change_orders']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    // shape spot-checks
    const invCols = (db.prepare(`PRAGMA table_info(invoices)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'date', 'status', 'terms', 'version', 'createdAt']) {
      expect(invCols, `invoices missing ${c}`).toContain(c);
    }
    const coCols = (db.prepare(`PRAGMA table_info(change_orders)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'description', 'amount', 'status', 'createdAt']) {
      expect(coCols, `change_orders missing ${c}`).toContain(c);
    }
    db.close();
  });

  it('migration 14 adds CO columns + change_order_lines/photos (additive)', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    for (const t of ['change_order_lines', 'change_order_photos']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    const coCols = (db.prepare(`PRAGMA table_info(change_orders)`).all() as any[]).map(r => r.name);
    for (const c of ['version', 'lumpSumAmount', 'scheduleImpactDays', 'date']) {
      expect(coCols, `change_orders missing ${c}`).toContain(c);
    }
    const lineCols = (db.prepare(`PRAGMA table_info(change_order_lines)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'changeOrderId', 'description', 'qty', 'unitPrice', 'sortOrder']) {
      expect(lineCols, `change_order_lines missing ${c}`).toContain(c);
    }
    const photoCols = (db.prepare(`PRAGMA table_info(change_order_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'changeOrderId', 'fileId', 'sortOrder', 'createdAt']) {
      expect(photoCols, `change_order_photos missing ${c}`).toContain(c);
    }
    db.close();
  });
});

describe('migration 9: issues', () => {
  it('creates issues and issue_photos', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).toContain('issues');
    expect(tables).toContain('issue_photos');
    const issCols = (db.prepare(`PRAGMA table_info(issues)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'title', 'description', 'status', 'version', 'sentAt', 'createdAt']) {
      expect(issCols, `issues missing ${c}`).toContain(c);
    }
    const phCols = (db.prepare(`PRAGMA table_info(issue_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'issueId', 'fileId', 'sortOrder', 'createdAt']) {
      expect(phCols, `issue_photos missing ${c}`).toContain(c);
    }
    db.close();
  });
});

describe('migration 10: punch', () => {
  it('creates punch_items and punch_photos', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).toContain('punch_items');
    expect(tables).toContain('punch_photos');
    const itemCols = (db.prepare(`PRAGMA table_info(punch_items)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'area', 'description', 'done', 'sortOrder', 'version', 'createdAt']) {
      expect(itemCols, `punch_items missing ${c}`).toContain(c);
    }
    const phCols = (db.prepare(`PRAGMA table_info(punch_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'punchItemId', 'fileId', 'stage', 'sortOrder', 'createdAt']) {
      expect(phCols, `punch_photos missing ${c}`).toContain(c);
    }
    db.close();
  });
});

describe('migration 11: tasks', () => {
  it('creates tasks and task_photos', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).toContain('tasks');
    expect(tables).toContain('task_photos');
    const taskCols = (db.prepare(`PRAGMA table_info(tasks)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'category', 'title', 'notes', 'assigneeUserId', 'status',
                     'dueDate', 'sortOrder', 'version', 'createdAt', 'createdBy']) {
      expect(taskCols, `tasks missing ${c}`).toContain(c);
    }
    const phCols = (db.prepare(`PRAGMA table_info(task_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'taskId', 'fileId', 'stage', 'sortOrder', 'createdAt']) {
      expect(phCols, `task_photos missing ${c}`).toContain(c);
    }
    db.close();
  });

  it('imports legacy checklists into tasks', () => {
    const db = openDb(':memory:');
    // migrate through v10 so the legacy `checklists` table exists but v11 hasn't run
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 10));
    db.prepare('INSERT INTO checklists (id, data, createdAt) VALUES (?, ?, ?)').run(
      'cl1',
      JSON.stringify({
        id: 'cl1', name: 'Shop Punchout', createdAt: 1000,
        items: [
          { id: 'it1', description: 'Fix door', location: 'Bay 2', done: true, order: 0, comments: 'use shims',
            beforePhotoIds: ['pa'], inProgressPhotoIds: [], afterPhotoIds: ['pb'], createdAt: 1001 },
          { id: 'it2', description: 'Sweep', location: '', done: false, order: 1, createdAt: 1002 },
        ],
        printouts: [],
      }),
      1000,
    );

    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 11));

    const tasks = db.prepare('SELECT * FROM tasks ORDER BY sortOrder').all() as any[];
    expect(tasks.length).toBe(2);
    expect(tasks[0].title).toBe('Fix door');
    expect(tasks[0].category).toBe('Shop Punchout');
    expect(tasks[0].status).toBe('done');
    expect(tasks[0].notes).toBe('use shims');
    expect(tasks[1].title).toBe('Sweep');
    expect(tasks[1].category).toBe('Shop Punchout');
    expect(tasks[1].status).toBe('todo');
    expect(tasks[1].notes).toBe('');

    const photos = db.prepare('SELECT * FROM task_photos WHERE taskId = ? ORDER BY stage').all('it1') as any[];
    expect(photos.map(p => `${p.stage}:${p.fileId}`)).toEqual(['after:pb', 'before:pa']);

    // legacy table is retained (backup)
    expect(db.prepare('SELECT COUNT(*) c FROM checklists').get()).toEqual({ c: 1 });
    db.close();
  });

  it('survives a malformed legacy blob', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 10));
    db.prepare('INSERT INTO checklists (id, data, createdAt) VALUES (?, ?, ?)').run('bad', '{not json', 1);
    expect(() => runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 11))).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 0 });
    db.close();
  });
});

describe('migration 12: aia-billing', () => {
  it('creates aia_sov_lines, aia_pay_apps, aia_pay_app_lines', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    for (const t of ['aia_sov_lines', 'aia_pay_apps', 'aia_pay_app_lines']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    const sovCols = columnNames(db, 'aia_sov_lines');
    for (const c of ['id', 'projectId', 'itemNo', 'description', 'scheduledValueCents',
                     'retainagePercent', 'isChangeOrder', 'changeOrderId', 'sortOrder',
                     'version', 'createdAt']) {
      expect(sovCols, `aia_sov_lines missing ${c}`).toContain(c);
    }
    const appCols = columnNames(db, 'aia_pay_apps');
    for (const c of ['id', 'projectId', 'number', 'periodTo', 'applicationDate',
                     'retainagePercent', 'storedRetainagePercent', 'status',
                     'version', 'createdAt']) {
      expect(appCols, `aia_pay_apps missing ${c}`).toContain(c);
    }
    const lineCols = columnNames(db, 'aia_pay_app_lines');
    for (const c of ['id', 'payAppId', 'sovLineId', 'percentComplete',
                     'storedMaterialsCents', 'createdAt']) {
      expect(lineCols, `aia_pay_app_lines missing ${c}`).toContain(c);
    }
    db.close();
  });
});

describe('migration 13: payments-polymorphic', () => {
  it('rebuilds payments to targetType/targetId and backfills existing rows to invoice targets', () => {
    const db = openDb(':memory:');
    // migrate through 12 so the old (invoiceId-keyed) payments table exists
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 12));
    const preCols = columnNames(db, 'payments');
    expect(preCols).toContain('invoiceId');
    db.prepare('INSERT INTO payments (id, invoiceId, date, amount, method, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('pay1', 'inv-A', 100, 40, 'check', 'deposit', 500);

    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 13));

    const cols = columnNames(db, 'payments');
    for (const c of ['id', 'targetType', 'targetId', 'date', 'amount', 'method', 'note', 'createdAt']) {
      expect(cols, `payments missing ${c}`).toContain(c);
    }
    expect(cols).not.toContain('invoiceId');

    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get('pay1') as any;
    expect(row.targetType).toBe('invoice');
    expect(row.targetId).toBe('inv-A');
    expect(row.amount).toBe(40);
    expect(row.method).toBe('check');
    expect(row.note).toBe('deposit');
    expect(row.date).toBe(100);
    expect(row.createdAt).toBe(500);
    db.close();
  });
});

describe('migration 18: task relations', () => {
  it('adds projectId and customerId columns to tasks', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 18));
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as any[]).map(c => c.name);
    expect(cols).toContain('projectId');
    expect(cols).toContain('customerId');
  });
});

describe('migration 21: two-stage project lifecycle', () => {
  const seedProject = (db: any, id: string, status: string, meta: any = {}) => {
    db.prepare('INSERT INTO projects (id, status, meta, createdAt) VALUES (?, ?, ?, ?)')
      .run(id, status, JSON.stringify(meta), Date.now());
  };

  const readRow = (db: any, id: string) => {
    const row = db.prepare('SELECT status, meta FROM projects WHERE id = ?').get(id) as any;
    const meta = row.meta ? JSON.parse(row.meta) : {};
    return { status: row.status, archived: meta.archived, lostBid: meta.lostBid };
  };

  it('collapses every legacy status per the collapse table and auto-archives complete/lost', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 20));

    seedProject(db, 'p-estimating', 'estimating');
    seedProject(db, 'p-proposal', 'proposal_sent');
    seedProject(db, 'p-awarded', 'awarded');
    seedProject(db, 'p-inprogress', 'in_progress');
    seedProject(db, 'p-punch', 'punch_list');
    seedProject(db, 'p-complete', 'complete');
    seedProject(db, 'p-archived', 'archived');
    seedProject(db, 'p-lost', 'lost');
    // a project already flagged archived under a legacy stage must keep archived:true
    seedProject(db, 'p-already-archived', 'punch_list', { archived: true });

    runMigrations(db, tmpDir(), migrations);

    expect(readRow(db, 'p-estimating')).toEqual({ status: 'bidding', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-proposal')).toEqual({ status: 'bidding', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-awarded')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-inprogress')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-punch')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-complete')).toEqual({ status: 'in_progress', archived: true, lostBid: undefined });
    expect(readRow(db, 'p-archived')).toEqual({ status: 'in_progress', archived: true, lostBid: undefined });
    expect(readRow(db, 'p-lost')).toEqual({ status: 'bidding', archived: true, lostBid: true });
    expect(readRow(db, 'p-already-archived')).toEqual({ status: 'in_progress', archived: true, lostBid: undefined });

    // re-running the migration's up() directly (simulating a replay) must be a no-op
    const mig21 = migrations.find(m => m.version === 21)!;
    const before = ['p-estimating', 'p-proposal', 'p-awarded', 'p-inprogress', 'p-punch',
      'p-complete', 'p-archived', 'p-lost', 'p-already-archived'].map(id => readRow(db, id));
    mig21.up({ db, dataDir: tmpDir() });
    const after = ['p-estimating', 'p-proposal', 'p-awarded', 'p-inprogress', 'p-punch',
      'p-complete', 'p-archived', 'p-lost', 'p-already-archived'].map(id => readRow(db, id));
    expect(after).toEqual(before);

    db.close();
  });

  it('a row with unparseable meta does not abort the migration: status is normalized, meta kept verbatim', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 20));

    db.prepare('INSERT INTO projects (id, status, meta, createdAt) VALUES (?, ?, ?, ?)')
      .run('p-corrupt', 'proposal_sent', '{not json', Date.now());
    seedProject(db, 'p-after-corrupt', 'awarded');

    runMigrations(db, tmpDir(), migrations);

    const corrupt = db.prepare('SELECT status, meta FROM projects WHERE id = ?').get('p-corrupt') as any;
    expect(corrupt.status).toBe('bidding');
    expect(corrupt.meta).toBe('{not json'); // untouched — nothing is lost
    // and the rest of the table still migrated
    expect(readRow(db, 'p-after-corrupt')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });

    db.close();
  });
});

describe('migration 22: payapp-released-retainage', () => {
  it('adds releasedRetainagePoints defaulting to 0 on existing pay apps, and re-runs as a no-op', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 21));
    expect(columnNames(db, 'aia_pay_apps')).not.toContain('releasedRetainagePoints');

    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
    db.prepare('INSERT INTO aia_pay_apps (id, projectId, number, createdAt) VALUES (?, ?, ?, ?)')
      .run('app1', 'p1', 1, 1);

    runMigrations(db, tmpDir(), migrations);

    expect(columnNames(db, 'aia_pay_apps')).toContain('releasedRetainagePoints');
    // ADDITIVE: every pre-existing app holds nothing released, so its numbers
    // are byte-identical to what they computed before the migration.
    const row = db.prepare('SELECT releasedRetainagePoints FROM aia_pay_apps WHERE id = ?').get('app1') as any;
    expect(row.releasedRetainagePoints).toBe(0);

    // Idempotent: replaying up() must not throw (duplicate column) or reset data.
    db.prepare('UPDATE aia_pay_apps SET releasedRetainagePoints = ? WHERE id = ?').run(5, 'app1');
    const mig22 = migrations.find(m => m.version === 22)!;
    expect(() => mig22.up({ db, dataDir: tmpDir() })).not.toThrow();
    const after = db.prepare('SELECT releasedRetainagePoints FROM aia_pay_apps WHERE id = ?').get('app1') as any;
    expect(after.releasedRetainagePoints).toBe(5);

    db.close();
  });
});

describe('migration 23: document source attribution', () => {
  // One seeded file per backfill class, plus the rows that attribute them.
  // Everything is inserted at schema v22 so migration 23 sees a realistic
  // pre-migration database.
  const seed = (db: any) => {
    const file = (id: string, kind = 'other', projectId: string | null = null) =>
      db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, versionNumber, createdAt)
                  VALUES (?, ?, ?, 'application/pdf', 1, 'sha', ?, 1, 1)`).run(id, projectId, id, kind);

    db.prepare('INSERT INTO projects (id, name, meta, createdAt) VALUES (?, ?, ?, ?)').run(
      'p1', 'Proj One',
      JSON.stringify({
        printouts: [{ id: 'po1', name: 'Bid set', fileId: 'f-printout' }],
        proposalFileId: 'f-proposal',
        proposalPhotoIds: ['f-proposal-photo'],
      }),
      1,
    );

    // 1. join-table photos (kinds as the live app writes them today)
    file('f-issue-photo', 'photo', 'p1');
    db.prepare(`INSERT INTO issue_photos (id, issueId, fileId, createdAt) VALUES ('ip1','issue-1','f-issue-photo',1)`).run();
    file('f-punch-photo', 'punch', 'p1');
    db.prepare(`INSERT INTO punch_photos (id, punchItemId, fileId, createdAt) VALUES ('pp1','punch-1','f-punch-photo',1)`).run();
    file('f-rfi-photo', 'photo', 'p1');
    db.prepare(`INSERT INTO rfi_photos (id, rfiId, fileId, createdAt) VALUES ('rp1','rfi-1','f-rfi-photo',1)`).run();
    file('f-co-photo', 'change-order', 'p1');
    db.prepare(`INSERT INTO change_order_photos (id, changeOrderId, fileId, createdAt) VALUES ('cp1','co-1','f-co-photo',1)`).run();
    // task photo: uploaded via POST /api/images, so projectId is NULL
    file('f-task-photo', 'other', null);
    db.prepare('INSERT INTO tasks (id, projectId, createdAt) VALUES (?, ?, ?)').run('task-1', 'p1', 1);
    db.prepare(`INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES ('tp1','task-1','f-task-photo',1)`).run();
    // task photo whose task has no project — stays unattributed
    file('f-task-photo-noproj', 'other', null);
    db.prepare('INSERT INTO tasks (id, projectId, createdAt) VALUES (?, ?, ?)').run('task-2', null, 1);
    db.prepare(`INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES ('tp2','task-2','f-task-photo-noproj',1)`).run();

    // the CO ambiguity: a generated CO PDF carries the same legacy kind but is
    // in no join table
    file('f-co-pdf', 'change-order', 'p1');

    // 2. page/plan assets (plan sources upload with no projectId)
    file('f-plan-source', 'plan', null);
    file('f-plan-image', 'other', 'p1');
    file('f-plan-thumb', 'other', 'p1');
    db.prepare(`INSERT INTO pages (id, projectId, planSetId, imageId, thumbnailId, sourcePdfFileId)
                VALUES ('pg1','p1','set1','f-plan-image','f-plan-thumb','f-plan-source')`).run();
    // a second page split out of the SAME upload shares its source PDF
    db.prepare(`INSERT INTO pages (id, projectId, planSetId, sourcePdfFileId)
                VALUES ('pg1b','p1','set1','f-plan-source')`).run();
    file('f-plan-source-noset', 'other', null);
    db.prepare(`INSERT INTO pages (id, projectId, planSetId, sourcePdfFileId)
                VALUES ('pg2','p1',NULL,'f-plan-source-noset')`).run();

    // 3. project JSON fields
    file('f-printout', 'printout', 'p1');
    file('f-proposal', 'proposal', 'p1');
    file('f-proposal-photo', 'proposal-photo', 'p1');

    // 4. rfi response
    file('f-rfi-response', 'rfi-response', 'p1');
    db.prepare('INSERT INTO rfis (id, projectId, number, responseFileId, createdAt) VALUES (?,?,?,?,?)')
      .run('rfi-1', 'p1', 1, 'f-rfi-response', 1);

    // 5. settings asset
    file('f-aia-template', 'other', null);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('aiaTemplateFileId','f-aia-template')`).run();

    // 6. rows migration 23 must leave alone
    file('f-upload', 'document', 'p1');
    file('f-loose-photo', 'photo', 'p1');   // in no join table — stays a plain photo
    file('f-invoice', 'invoice', 'p1');
    file('f-issue-pdf', 'issue', 'p1');   // legacy kind — renamed to issue-report
    file('f-email-att', 'email-attachment', 'p1');
  };

  const rowOf = (db: any, id: string) =>
    db.prepare('SELECT kind, sourceType, sourceId, projectId FROM files WHERE id = ?').get(id) as any;

  const migrated = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 22));
    seed(db);
    // Capped at 27 (pre-proposals): this suite exercises migration 23's own
    // document-source-attribution behavior, not migration 28's legacy
    // proposal/printout transform (which has its own describe block below
    // and would otherwise relabel/re-point this fixture's printout+proposal
    // files a second time).
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    return { db, dir };
  };

  it('adds the additive columns with archived defaulting to 0', () => {
    const { db } = migrated();
    const cols = columnNames(db, 'files');
    for (const c of ['customerId', 'sourceType', 'sourceId', 'archived']) {
      expect(cols, `files missing ${c}`).toContain(c);
    }
    expect((db.prepare('SELECT COUNT(*) c FROM files WHERE archived = 0').get() as any).c)
      .toBe((db.prepare('SELECT COUNT(*) c FROM files').get() as any).c);
    db.close();
  });

  it('requalifies join-table photos and attributes them to their entity', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-issue-photo')).toEqual({ kind: 'issue-photo', sourceType: 'issue', sourceId: 'issue-1', projectId: 'p1' });
    expect(rowOf(db, 'f-punch-photo')).toEqual({ kind: 'punch-photo', sourceType: 'punch', sourceId: 'punch-1', projectId: 'p1' });
    expect(rowOf(db, 'f-rfi-photo')).toEqual({ kind: 'rfi-photo', sourceType: 'rfi', sourceId: 'rfi-1', projectId: 'p1' });
    expect(rowOf(db, 'f-co-photo')).toEqual({ kind: 'change-order-photo', sourceType: 'change-order', sourceId: 'co-1', projectId: 'p1' });
    db.close();
  });

  it('backfills a task photo projectId from its task, leaving projectless tasks alone', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-task-photo')).toEqual({ kind: 'task-photo', sourceType: 'task', sourceId: 'task-1', projectId: 'p1' });
    expect(rowOf(db, 'f-task-photo-noproj')).toEqual({ kind: 'task-photo', sourceType: 'task', sourceId: 'task-2', projectId: null });
    db.close();
  });

  it('leaves generated change-order PDFs as change-order (join-table pass runs first)', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-co-pdf')).toEqual({ kind: 'change-order', sourceType: null, sourceId: null, projectId: 'p1' });
    db.close();
  });

  it('labels page assets: plan sources carry a plan-set source, rasters become plan', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-plan-source')).toEqual({ kind: 'plan-source', sourceType: 'plan-set', sourceId: 'set1', projectId: 'p1' });
    // a page with no plan set falls back to the project as its source id
    expect(rowOf(db, 'f-plan-source-noset')).toEqual({ kind: 'plan-source', sourceType: 'plan-set', sourceId: 'p1', projectId: 'p1' });
    expect(rowOf(db, 'f-plan-image')).toMatchObject({ kind: 'plan', sourceType: null });
    expect(rowOf(db, 'f-plan-thumb')).toMatchObject({ kind: 'plan', sourceType: null });
    db.close();
  });

  it('labels printouts, proposals and proposal photos from the project JSON', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-printout')).toEqual({ kind: 'printout', sourceType: 'printout', sourceId: 'po1', projectId: 'p1' });
    expect(rowOf(db, 'f-proposal')).toEqual({ kind: 'proposal', sourceType: 'proposal', sourceId: 'p1', projectId: 'p1' });
    expect(rowOf(db, 'f-proposal-photo')).toEqual({ kind: 'proposal-photo', sourceType: 'proposal', sourceId: 'p1', projectId: 'p1' });
    db.close();
  });

  it('labels the RFI response file and the AIA settings template', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-rfi-response')).toEqual({ kind: 'rfi-response', sourceType: 'rfi', sourceId: 'rfi-1', projectId: 'p1' });
    expect(rowOf(db, 'f-aia-template')).toEqual({ kind: 'settings-asset', sourceType: null, sourceId: null, projectId: null });
    db.close();
  });

  it('leaves direct uploads and already-canonical generated documents untouched', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-upload')).toEqual({ kind: 'document', sourceType: null, sourceId: null, projectId: 'p1' });
    expect(rowOf(db, 'f-loose-photo')).toEqual({ kind: 'photo', sourceType: null, sourceId: null, projectId: 'p1' });
    expect(rowOf(db, 'f-invoice')).toMatchObject({ kind: 'invoice', sourceType: null });
    expect(rowOf(db, 'f-email-att')).toMatchObject({ kind: 'email-attachment', sourceType: null });
    db.close();
  });

  it('renames the legacy issue kind to issue-report without touching issue photos', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-issue-pdf')).toMatchObject({ kind: 'issue-report', sourceType: null });
    // the photo pass ran first, so no issue photo is left carrying `issue`
    expect(rowOf(db, 'f-issue-photo')).toMatchObject({ kind: 'issue-photo' });
    expect((db.prepare(`SELECT COUNT(*) c FROM files WHERE kind = 'issue'`).get() as any).c).toBe(0);
    db.close();
  });

  it('re-running up() is byte-identical (idempotent by construction)', () => {
    const { db, dir } = migrated();
    const snapshot = () =>
      JSON.stringify(db.prepare('SELECT * FROM files ORDER BY id').all());
    const before = snapshot();
    migrations.find(m => m.version === 23)!.up({ db, dataDir: dir });
    expect(snapshot()).toBe(before);
    db.close();
  });

  it('a project with unparseable meta does not abort the migration', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 22));
    seed(db);
    db.prepare('INSERT INTO projects (id, name, meta, createdAt) VALUES (?, ?, ?, ?)')
      .run('p-bad', 'Broken', '{not json', 1);

    // Capped at 27 for the same reason as migrated() above.
    expect(() => runMigrations(db, dir, migrations.filter(m => m.version <= 27))).not.toThrow();
    // the rest of the portfolio still migrated
    expect(rowOf(db, 'f-printout')).toMatchObject({ kind: 'printout', sourceId: 'po1' });
    expect(db.prepare('SELECT meta FROM projects WHERE id = ?').get('p-bad')).toEqual({ meta: '{not json' });
    db.close();
  });
});

describe('migration 24: change-order-title', () => {
  it('adds title (nullable) to change_orders, and re-runs as a no-op', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 23));
    expect(columnNames(db, 'change_orders')).not.toContain('title');

    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
    db.prepare('INSERT INTO change_orders (id, projectId, number, description, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('co1', 'p1', '1', 'Extra electrical', 100, 'draft', 1);

    runMigrations(db, tmpDir(), migrations);

    expect(columnNames(db, 'change_orders')).toContain('title');
    const row = db.prepare('SELECT title FROM change_orders WHERE id = ?').get('co1') as any;
    expect(row.title).toBeNull();

    // Idempotent: replaying up() must not throw (duplicate column) or reset data.
    db.prepare('UPDATE change_orders SET title = ? WHERE id = ?').run('Kitchen electrical add', 'co1');
    const mig24 = migrations.find(m => m.version === 24)!;
    expect(() => mig24.up({ db, dataDir: tmpDir() })).not.toThrow();
    const after = db.prepare('SELECT title FROM change_orders WHERE id = ?').get('co1') as any;
    expect(after.title).toBe('Kitchen electrical add');

    db.close();
  });
});

describe('migration 27: daily reports', () => {
  // As migration 27 made it: one report per project per date. Migration 45
  // makes that per crew (its own tests below).
  it('creates daily_reports with the unique date rule and the photos join table', () => {
    const db = openDb(':memory:');
    runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-m27-')), migrations.filter(m => m.version <= 27));
    db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, createdAt, updatedAt) VALUES ('d1','p1','2026-08-26',1,1)`).run();
    expect(() =>
      db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, createdAt, updatedAt) VALUES ('d2','p1','2026-08-26',1,1)`).run(),
    ).toThrow(/UNIQUE/);
    // same date on a DIFFERENT project is fine
    db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, createdAt, updatedAt) VALUES ('d3','p2','2026-08-26',1,1)`).run();
    db.prepare(`INSERT INTO daily_report_photos (id, dailyReportId, fileId, sortOrder, createdAt) VALUES ('ph1','d1','f1',0,1)`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_photos').get()).toEqual({ c: 1 });
  });

  it('creates idx_daily_report_photos_report', () => {
    const db = openDb(':memory:');
    runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-m27b-')), migrations);
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_daily_report_photos_report'`
    ).all() as { name: string }[]).map(r => r.name);
    expect(names).toContain('idx_daily_report_photos_report');
  });
});

describe('migration 28 — proposals', () => {
  // Seeds a project whose meta carries the legacy printouts/proposal shape,
  // runs everything up to 27, then 28 on top.
  const seedLegacy = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    const meta = {
      printouts: [
        { id: 'po-prop-1', name: 'Proposal – Old Job', fileId: 'f-prop-1', createdAt: 1000, type: 'pdf' },
        { id: 'po-print-1', name: 'Printout - 1/2/2026, 9:00:00 AM', fileId: 'f-print-1', createdAt: 2000, type: 'pdf' },
        { id: 'po-xls-1', name: 'Excel Export - 1/2/2026, 9:05:00 AM', fileId: 'f-xls-1', createdAt: 3000, type: 'excel' },
        { id: 'po-prop-2', name: 'Proposal – Old Job', fileId: 'f-prop-2', createdAt: 4000, type: 'pdf' },
      ],
      proposalFileId: 'f-prop-2',
      proposalSentAt: 4500,
      proposalPhotoIds: ['f-photo-1', 'f-photo-2'],
      proposalCoverNotes: 'notes here',
      proposalTerms: 'terms here',
      legendOnAllPages: true,
    };
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Old Job', 1, 1, 1, ?)`).run(JSON.stringify(meta));
    const ins = db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt, sourceType, sourceId, archived)
      VALUES (?, 'p1', ?, ?, 1, 'x', ?, NULL, 1, NULL, ?, ?, ?, 0)`);
    ins.run('f-prop-1', 'Proposal – Old Job', 'application/pdf', 'printout', 1000, 'printout', 'po-prop-1');
    ins.run('f-print-1', 'Printout - 1/2/2026, 9:00:00 AM', 'application/pdf', 'printout', 2000, 'printout', 'po-print-1');
    ins.run('f-xls-1', 'Excel Export - 1/2/2026, 9:05:00 AM', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'printout', 3000, 'printout', 'po-xls-1');
    ins.run('f-prop-2', 'Proposal – Old Job', 'application/pdf', 'proposal', 4000, 'proposal', 'p1');
    ins.run('f-photo-1', 'a.jpg', 'image/jpeg', 'proposal-photo', 100, 'proposal', 'p1');
    ins.run('f-photo-2', 'b.jpg', 'image/jpeg', 'proposal-photo', 101, 'proposal', 'p1');
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));
    return db;
  };

  it('creates the four tables', () => {
    const db = seedLegacy();
    const tables = tableNames(db);
    for (const t of ['proposals', 'proposal_lines', 'proposal_photos', 'proposal_attachments']) expect(tables).toContain(t);
    for (const c of ['number', 'revisedFromId', 'status', 'legacy', 'inclusions', 'exclusions', 'paymentSchedule', 'showGrandTotal', 'fileId', 'signedFileId', 'sentTo', 'version']) {
      expect(columnNames(db, 'proposals')).toContain(c);
    }
    for (const c of ['kind', 'takeoffId', 'amountCents', 'derivedAmountCents', 'measurementSummary', 'isAlternate']) {
      expect(columnNames(db, 'proposal_lines')).toContain(c);
    }
    expect(columnNames(db, 'proposal_photos')).toContain('caption');
    db.close();
  });

  it('converts legacy proposal printouts into numbered legacy proposals, sent = the one matching proposalFileId', () => {
    const db = seedLegacy();
    const rows = db.prepare('SELECT * FROM proposals WHERE projectId = ? ORDER BY number').all('p1') as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ number: 1, legacy: 1, status: 'draft', fileId: 'f-prop-1', coverNotes: 'notes here', terms: 'terms here' });
    expect(rows[1]).toMatchObject({ number: 2, legacy: 1, status: 'sent', fileId: 'f-prop-2', sentAt: 4500 });
    // file rows re-pointed at the proposal id under kind 'proposal'
    const f1 = db.prepare('SELECT kind, sourceType, sourceId FROM files WHERE id = ?').get('f-prop-1') as any;
    expect(f1).toEqual({ kind: 'proposal', sourceType: 'proposal', sourceId: rows[0].id });
    const f2 = db.prepare('SELECT kind, sourceType, sourceId FROM files WHERE id = ?').get('f-prop-2') as any;
    expect(f2).toEqual({ kind: 'proposal', sourceType: 'proposal', sourceId: rows[1].id });
    db.close();
  });

  it('a non-proposal-named printout whose fileId matches proposalFileId becomes the sent proposal, not a takeoff print', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    const meta = {
      printouts: [
        { id: 'po-1', name: 'Printout - 3/3/2026, 9:00:00 AM', fileId: 'f-1', createdAt: 1000, type: 'pdf' },
      ],
      proposalFileId: 'f-1',
      proposalSentAt: 1500,
    };
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p3', 'Edge Job', 1, 1, 1, ?)`).run(JSON.stringify(meta));
    db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt, sourceType, sourceId, archived)
      VALUES ('f-1', 'p3', 'Printout - 3/3/2026, 9:00:00 AM', 'application/pdf', 1, 'x', 'printout', NULL, 1, NULL, 1000, 'printout', 'po-1', 0)`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));

    const rows = db.prepare('SELECT * FROM proposals WHERE projectId = ?').all('p3') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 1, legacy: 1, status: 'sent', fileId: 'f-1', sentAt: 1500 });
    const f = db.prepare('SELECT kind, sourceType, sourceId FROM files WHERE id = ?').get('f-1') as any;
    expect(f).toEqual({ kind: 'proposal', sourceType: 'proposal', sourceId: rows[0].id });
    db.close();
  });

  it('attaches legacy proposal photos to the LATEST legacy proposal', () => {
    const db = seedLegacy();
    const latest = db.prepare('SELECT id FROM proposals WHERE projectId = ? ORDER BY number DESC LIMIT 1').get('p1') as any;
    const photos = db.prepare('SELECT fileId, sortOrder FROM proposal_photos WHERE proposalId = ? ORDER BY sortOrder').all(latest.id) as any[];
    expect(photos).toEqual([{ fileId: 'f-photo-1', sortOrder: 0 }, { fileId: 'f-photo-2', sortOrder: 1 }]);
    const ph = db.prepare('SELECT sourceType, sourceId FROM files WHERE id = ?').get('f-photo-1') as any;
    expect(ph).toEqual({ sourceType: 'proposal', sourceId: latest.id });
    db.close();
  });

  it('relabels takeoff printouts/exports with the new kinds + names', () => {
    const db = seedLegacy();
    const pr = db.prepare('SELECT kind, name, sourceType, sourceId FROM files WHERE id = ?').get('f-print-1') as any;
    expect(pr.kind).toBe('takeoff-print');
    expect(pr.sourceType).toBe('takeoff-print');
    expect(pr.sourceId).toBe('po-print-1');
    expect(pr.name).toMatch(/^Takeoff Print – Old Job – \d{4}-\d{2}-\d{2}$/);
    const xl = db.prepare('SELECT kind, name, sourceType FROM files WHERE id = ?').get('f-xls-1') as any;
    expect(xl.kind).toBe('takeoff-export');
    expect(xl.sourceType).toBe('takeoff-print');
    expect(xl.name).toMatch(/^Takeoff Export – Old Job – \d{4}-\d{2}-\d{2}$/);
    db.close();
  });

  it('strips the six legacy keys from project meta and leaves the rest', () => {
    const db = seedLegacy();
    const meta = JSON.parse((db.prepare('SELECT meta FROM projects WHERE id = ?').get('p1') as any).meta);
    for (const k of ['printouts', 'proposalFileId', 'proposalSentAt', 'proposalPhotoIds', 'proposalCoverNotes', 'proposalTerms']) {
      expect(meta).not.toHaveProperty(k);
    }
    expect(meta.legendOnAllPages).toBe(true);
    db.close();
  });

  it('is idempotent on a project with no legacy keys', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p2', 'Clean', 1, 1, 1, '{}')`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));
    expect(db.prepare('SELECT COUNT(*) c FROM proposals').get()).toEqual({ c: 0 });
    db.close();
  });

  // A printouts[] entry can outlive its file row (bytes reclaimed, a partial
  // delete), and the same fileId can appear twice in the list. Neither may
  // produce a proposal: the first would be a numbered row pointing at a
  // dangling fileId, the second two rows fighting over one file.
  it('skips a printout whose file row is gone, and dedupes repeats of one fileId', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    const meta = {
      printouts: [
        { id: 'po-a', name: 'Proposal – Ghost Job', fileId: 'f-missing', createdAt: 1000, type: 'pdf' },
        { id: 'po-b', name: 'Proposal – Ghost Job', fileId: 'f-real', createdAt: 2000, type: 'pdf' },
        { id: 'po-c', name: 'Proposal – Ghost Job', fileId: 'f-real', createdAt: 3000, type: 'pdf' },
        { id: 'po-d', name: 'Printout - 1/2/2026, 9:00:00 AM', fileId: 'f-print', createdAt: 4000, type: 'pdf' },
        { id: 'po-e', name: 'Printout - 1/2/2026, 9:00:00 AM', fileId: 'f-print', createdAt: 5000, type: 'pdf' },
        { id: 'po-f', name: 'Printout - 1/2/2026, 9:10:00 AM', fileId: 'f-gone-too', createdAt: 6000, type: 'pdf' },
      ],
    };
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('pg', 'Ghost Job', 1, 1, 1, ?)`).run(JSON.stringify(meta));
    const ins = db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt, sourceType, sourceId, archived)
      VALUES (?, 'pg', ?, 'application/pdf', 1, 'x', 'printout', NULL, 1, NULL, ?, 'printout', ?, 0)`);
    ins.run('f-real', 'Proposal – Ghost Job', 2000, 'po-b');
    ins.run('f-print', 'Printout - 1/2/2026, 9:00:00 AM', 4000, 'po-d');
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));

    // one proposal (from f-real, kept once), not three
    const props = db.prepare('SELECT number, fileId FROM proposals WHERE projectId = ? ORDER BY number').all('pg') as any[];
    expect(props).toEqual([{ number: 1, fileId: 'f-real' }]);
    // the takeoff print was relabeled exactly once, and the two dead ids made nothing
    const prints = db.prepare(`SELECT id FROM files WHERE kind = 'takeoff-print'`).all() as any[];
    expect(prints.map(r => r.id)).toEqual(['f-print']);
    expect(db.prepare('SELECT COUNT(*) c FROM files').get()).toEqual({ c: 2 });
    db.close();
  });

  it('names relabeled takeoff prints with the LOCAL date of the printout', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    // 11pm local: already the next day in UTC west of Greenwich.
    const late = new Date(2026, 0, 5, 23, 30, 0).getTime();
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('pl', 'Late Job', 1, 1, 1, ?)`)
      .run(JSON.stringify({ printouts: [{ id: 'po-l', name: 'Printout - x', fileId: 'f-late', createdAt: late, type: 'pdf' }] }));
    db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt, sourceType, sourceId, archived)
      VALUES ('f-late', 'pl', 'Printout - x', 'application/pdf', 1, 'x', 'printout', NULL, 1, NULL, ?, 'printout', 'po-l', 0)`).run(late);
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));

    const name = (db.prepare('SELECT name FROM files WHERE id = ?').get('f-late') as any).name;
    expect(name).toBe('Takeoff Print – Late Job – 2026-01-05');
    db.close();
  });
});

describe('migration 29 — proposal counter', () => {
  it('backfills proposalCounter to each project\'s MAX(number), and createProposal continues from it', async () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('pc', 'Counter Job', 1, 1, 1, '{}')`).run();
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('pd', 'No Proposals', 1, 1, 1, '{}')`).run();
    const ins = db.prepare(`INSERT INTO proposals (id, projectId, number, status, legacy, createdAt, updatedAt) VALUES (?, 'pc', ?, 'sent', 1, 1, 1)`);
    ins.run('lp1', 1); ins.run('lp2', 2); ins.run('lp3', 3);
    runMigrations(db, dir, migrations.filter(m => m.version <= 29));

    expect((db.prepare('SELECT proposalCounter c FROM projects WHERE id = ?').get('pc') as any).c).toBe(3);
    // a project with no proposals backfills to 0, not NULL
    expect((db.prepare('SELECT proposalCounter c FROM projects WHERE id = ?').get('pd') as any).c).toBe(0);

    // The number is issued from the counter, so it continues past the legacy
    // rows — and never reuses one after a delete (the point of migration 29).
    const { createProposal, deleteProposal } = await import('./proposalStore');
    expect(createProposal(db, 'pc', {}).number).toBe(4);
    const fifth = createProposal(db, 'pc', {});
    expect(fifth.number).toBe(5);
    deleteProposal(db, fifth.id);
    expect(createProposal(db, 'pc', {}).number).toBe(6);
    expect(createProposal(db, 'pd', {}).number).toBe(1);
    db.close();
  });
});

describe('migration 30 — updatedAt columns', () => {
  it('adds updatedAt to the five tables and backfills from createdAt', () => {
    const dir = tmpDir(); const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 29));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1','P',1,1,1,'{}')`).run();
    db.prepare(`INSERT INTO invoices (id, projectId, number, status, createdAt, version) VALUES ('i1','p1','1','draft',12345,1)`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 30));
    for (const t of ['invoices', 'change_orders', 'issues', 'rfis', 'aia_pay_apps']) {
      expect(columnNames(db, t), `missing updatedAt on ${t}`).toContain('updatedAt');
    }
    expect((db.prepare('SELECT updatedAt FROM invoices WHERE id = ?').get('i1') as any).updatedAt).toBe(12345);
    db.close();
  });
});

describe('migration 31 mail-client', () => {
  const setup = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 30));
    return { db, dir };
  };
  it('creates the mail tables and rfis columns', () => {
    const { db, dir } = setup();
    runMigrations(db, dir, migrations, { mailCrypto: loadMailCrypto(dir, {} as any) });
    const tables = tableNames(db);
    for (const t of ['mail_accounts', 'mail_folders', 'mail_messages', 'mail_threads', 'mail_thread_links', 'mail_thread_reply_state']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    for (const c of ['pendingReplyJson', 'responseSource', 'responseMessageIdHeader']) {
      expect(columnNames(db, 'rfis')).toContain(c);
    }
    db.close();
  });
  it('migrates smtp.* prefs into a sealed imap account and deletes the prefs', () => {
    const { db, dir } = setup();
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u9','nick','x','admin')`).run();
    const ins = db.prepare('INSERT INTO user_preferences (userId, key, value) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries({ 'smtp.host': 'smtp.example.com', 'smtp.port': '465', 'smtp.secure': 'true',
      'smtp.username': 'nick@example.com', 'smtp.password': 'hunter2', 'smtp.fromName': 'Nick', 'smtp.fromAddress': 'Nick@EXAMPLE.com', 'theme': 'dark' })) ins.run('u9', k, v);
    const crypto = loadMailCrypto(dir, {} as any);
    runMigrations(db, dir, migrations, { mailCrypto: crypto });
    const acct = db.prepare('SELECT * FROM mail_accounts WHERE userId = ?').get('u9') as any;
    expect(acct.provider).toBe('imap');
    expect(acct.emailAddress).toBe('nick@example.com');
    expect(acct.displayName).toBe('Nick');
    expect(acct.status).toBe('needs_review');
    expect(acct.isDefault).toBe(1);
    expect(acct.authBlob).not.toContain('hunter2');
    expect(crypto.open<any>(acct.authBlob)).toMatchObject({ smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true, imapHost: 'smtp.example.com', imapPort: 993, imapSecure: true, username: 'nick@example.com', password: 'hunter2' });
    const left = db.prepare("SELECT key FROM user_preferences WHERE userId='u9'").all().map((r: any) => r.key);
    expect(left).toEqual(['theme']);
    db.close();
  });
  it('warns and keeps the prefs for a half-filled smtp config with no address to send as', () => {
    const { db, dir } = setup();
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u9','nick','x','admin')`).run();
    const ins = db.prepare('INSERT INTO user_preferences (userId, key, value) VALUES (?, ?, ?)');
    // host + password but no fromAddress and no username: nothing to use as the from-address.
    for (const [k, v] of Object.entries({ 'smtp.host': 'smtp.example.com', 'smtp.password': 'hunter2' })) ins.run('u9', k, v);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runMigrations(db, dir, migrations, { mailCrypto: loadMailCrypto(dir, {} as any) });
    expect(warn.mock.calls.flat().join(' ')).toContain('[migration 31] user u9: smtp.host set but no fromAddress/username — left untouched');
    warn.mockRestore();
    expect(db.prepare('SELECT COUNT(*) c FROM mail_accounts').get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT key FROM user_preferences WHERE userId='u9' ORDER BY key").all().map((r: any) => r.key))
      .toEqual(['smtp.host', 'smtp.password']);
    db.close();
  });
  it('ignores smtp prefs left behind by a deleted user', () => {
    const { db, dir } = setup();
    // No users row for 'ghost' — a stale preference must not create an orphan account.
    db.prepare('INSERT INTO user_preferences (userId, key, value) VALUES (?,?,?)').run('ghost', 'smtp.host', 'h');
    db.prepare('INSERT INTO user_preferences (userId, key, value) VALUES (?,?,?)').run('ghost', 'smtp.fromAddress', 'g@x.com');
    runMigrations(db, dir, migrations, { mailCrypto: loadMailCrypto(dir, {} as any) });
    expect(db.prepare('SELECT COUNT(*) c FROM mail_accounts').get()).toEqual({ c: 0 });
    db.close();
  });
  it('skips the transform (keeps prefs) when no crypto is supplied', () => {
    const { db, dir } = setup();
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u9','nick','x','admin')`).run();
    db.prepare('INSERT INTO user_preferences (userId, key, value) VALUES (?,?,?)').run('u9', 'smtp.host', 'h');
    runMigrations(db, dir, migrations);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_accounts').get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM user_preferences WHERE key LIKE 'smtp.%'").get()).toEqual({ c: 1 });
    db.close();
  });
});

describe('migration 33: invoice-notes', () => {
  it('adds notes (nullable) to invoices, and re-runs as a no-op', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 32));
    expect(columnNames(db, 'invoices')).not.toContain('notes');

    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
    db.prepare('INSERT INTO invoices (id, projectId, number, status, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run('i1', 'p1', '1', 'draft', 1);

    runMigrations(db, tmpDir(), migrations);

    expect(columnNames(db, 'invoices')).toContain('notes');
    const row = db.prepare('SELECT notes FROM invoices WHERE id = ?').get('i1') as any;
    expect(row.notes).toBeNull();

    // Idempotent: replaying up() must not throw (duplicate column) or reset data.
    db.prepare('UPDATE invoices SET notes = ? WHERE id = ?').run('Called re: change in scope', 'i1');
    const mig33 = migrations.find(m => m.version === 33)!;
    expect(() => mig33.up({ db, dataDir: tmpDir() })).not.toThrow();
    const after = db.prepare('SELECT notes FROM invoices WHERE id = ?').get('i1') as any;
    expect(after.notes).toBe('Called re: change in scope');

    db.close();
  });
});

describe('migration 34: invoice-photos-attachments', () => {
  it('creates invoice_photos and invoice_attachments (additive, IF NOT EXISTS)', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
    db.prepare('INSERT INTO invoices (id, projectId, number, status, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run('i1', 'p1', '1001', 'draft', 1, 1);

    db.prepare('INSERT INTO invoice_photos (id, invoiceId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run('ph1', 'i1', 'f1', 0, 1);
    expect(() =>
      db.prepare('INSERT INTO invoice_photos (id, invoiceId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)').run('ph2', 'i1', 'f1', 1, 1),
    ).toThrow(/UNIQUE/);

    db.prepare('INSERT INTO invoice_attachments (id, invoiceId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run('at1', 'i1', 'a1', 0, 1);
    expect(() =>
      db.prepare('INSERT INTO invoice_attachments (id, invoiceId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)').run('at2', 'i1', 'a1', 1, 1),
    ).toThrow(/UNIQUE/);

    expect(db.prepare('SELECT COUNT(*) c FROM invoice_photos WHERE invoiceId = ?').get('i1')).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM invoice_attachments WHERE invoiceId = ?').get('i1')).toEqual({ c: 1 });

    // Idempotent: replaying up() must not throw.
    const mig34 = migrations.find(m => m.version === 34)!;
    expect(() => mig34.up({ db, dataDir: tmpDir() })).not.toThrow();

    db.close();
  });

  it('creates idx_invoice_photos_invoice and idx_invoice_attachments_invoice', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_invoice_photos_invoice', 'idx_invoice_attachments_invoice')`
    ).all() as { name: string }[]).map(r => r.name);
    expect(names.sort()).toEqual(['idx_invoice_attachments_invoice', 'idx_invoice_photos_invoice']);
    db.close();
  });
});

describe('migration 35: sov-line-types-and-locks', () => {
  it('adds lineType (default item) and creates aia_sov_locks; re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 34));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Job', 1, 1, 1, '{}')`).run();
    db.prepare(`INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt)
                VALUES ('s1', 'p1', '1', 'Framing', 1000, NULL, 0, NULL, 0, 1, 1)`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 35));
    expect(columnNames(db, 'aia_sov_lines')).toContain('lineType');
    expect((db.prepare('SELECT lineType FROM aia_sov_lines WHERE id = ?').get('s1') as any).lineType).toBe('item');
    expect(tableNames(db)).toContain('aia_sov_locks');
    // replay is a no-op
    const m35 = migrations.find(m => m.version === 35)!;
    expect(() => m35.up({ db, dataDir: dir } as any)).not.toThrow();
    expect(columnNames(db, 'aia_sov_lines').filter(c => c === 'lineType').length).toBe(1);
    db.close();
  });

  it('locks every project that already has a pay application, and leaves the rest unlocked', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 34));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('billed', 'Billed', 1, 1, 1, '{}')`).run();
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('fresh', 'Fresh', 1, 1, 1, '{}')`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, periodTo, applicationDate, retainagePercent, storedRetainagePercent, status, version, createdAt, updatedAt)
                VALUES ('pa2', 'billed', 2, NULL, NULL, 10, 10, 'draft', 1, 5000, 5000)`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, periodTo, applicationDate, retainagePercent, storedRetainagePercent, status, version, createdAt, updatedAt)
                VALUES ('pa1', 'billed', 1, NULL, NULL, 10, 10, 'finalized', 1, 4000, 4000)`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 35));
    const lock = db.prepare('SELECT * FROM aia_sov_locks WHERE projectId = ?').get('billed') as any;
    expect(lock).toBeTruthy();
    expect(lock.reason).toBe('pay-app');
    expect(lock.lockedByUserId).toBeNull();
    expect(lock.lockedAt).toBe(4000); // earliest pay app's createdAt
    expect(db.prepare('SELECT * FROM aia_sov_locks WHERE projectId = ?').get('fresh')).toBeUndefined();
    db.close();
  });
});

describe('migration 36: backup-runs', () => {
  it('creates backup_runs with the expected columns and re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 36));
    expect(tableNames(db)).toContain('backup_runs');
    for (const c of ['id', 'target', 'trigger', 'startedAt', 'finishedAt', 'status', 'snapshotId', 'objectsAdded', 'bytesWritten', 'warningsJson', 'error']) {
      expect(columnNames(db, 'backup_runs'), `missing ${c}`).toContain(c);
    }
    const m36 = migrations.find(m => m.version === 36)!;
    expect(() => m36.up({ db, dataDir: dir } as any)).not.toThrow();
    db.close();
  });
});

describe('migration 37: onlyoffice-editor', () => {
  it('adds files.createdBy (NULL on existing rows) and editor_sessions, and re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 36));
    db.prepare(`INSERT INTO files (id, mime, size, sha256, kind, versionNumber, createdAt) VALUES ('old', 'application/pdf', 1, 'x', 'document', 1, 1)`).run();
    runMigrations(db, dir, migrations);
    expect(columnNames(db, 'files')).toContain('createdBy');
    expect((db.prepare('SELECT createdBy FROM files WHERE id = ?').get('old') as any).createdBy).toBeNull();
    expect(tableNames(db)).toContain('editor_sessions');
    for (const c of ['fileId', 'docKey', 'baseVersionNumber', 'savedVersionNumber', 'savedSha256', 'startedAt', 'lastSavedAt', 'lastSavedBy']) {
      expect(columnNames(db, 'editor_sessions'), `missing ${c}`).toContain(c);
    }
    const m37 = migrations.find(m => m.version === 37)!;
    expect(() => m37.up({ db, dataDir: dir } as any)).not.toThrow();
    db.close();
  });
});

describe('migration 38: onlyoffice-history', () => {
  it('adds files.versionOrigin, editor_sessions.users, editor_changes and editor_superseded_sessions, and re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations);
    expect(columnNames(db, 'files')).toContain('versionOrigin');
    expect(columnNames(db, 'editor_sessions')).toContain('users');
    for (const c of ['fileId', 'versionNumber', 'changesJson', 'serverVersion', 'zip', 'createdAt']) {
      expect(columnNames(db, 'editor_changes'), `missing ${c}`).toContain(c);
    }
    for (const c of ['docKey', 'fileId', 'lastSha256', 'closedAt']) {
      expect(columnNames(db, 'editor_superseded_sessions'), `missing ${c}`).toContain(c);
    }
    const m38 = migrations.find(m => m.version === 38)!;
    expect(() => m38.up({ db, dataDir: dir } as any)).not.toThrow();
    db.close();
  });
});

describe('migration 42: pdf-attachments', () => {
  // [table, owner column (the same one that record's photo table uses), index]
  const TABLES = [
    ['change_order_attachments', 'changeOrderId', 'idx_change_order_attachments_change_order'],
    ['rfi_attachments', 'rfiId', 'idx_rfi_attachments_rfi'],
    ['issue_attachments', 'issueId', 'idx_issue_attachments_issue'],
    ['daily_report_attachments', 'dailyReportId', 'idx_daily_report_attachments_report'],
  ] as const;

  it('adds the four tables to a v41 database, shaped like invoice_attachments, and re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 41));
    for (const [t] of TABLES) expect(tableNames(db)).not.toContain(t);

    runMigrations(db, dir, migrations);
    for (const [t, owner] of TABLES) {
      expect(columnNames(db, t), t).toEqual(['id', owner, 'fileId', 'sortOrder', 'createdAt']);
      const ins = db.prepare(`INSERT INTO ${t} (id, ${owner}, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)`);
      ins.run(`${t}-1`, 'r1', 'f1', 0, 1);
      expect(() => ins.run(`${t}-2`, 'r1', 'f1', 1, 1), t).toThrow(/UNIQUE/);
      ins.run(`${t}-3`, 'r2', 'f1', 0, 1); // the same PDF on another record is fine
    }

    // Idempotent: replaying up() must not throw or touch the rows.
    const m42 = migrations.find(m => m.version === 42)!;
    expect(() => m42.up({ db, dataDir: dir })).not.toThrow();
    for (const [t] of TABLES) expect(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get(), t).toEqual({ c: 2 });
    db.close();
  });

  it('indexes each table on its owner column', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    for (const [, owner, idx] of TABLES) {
      const cols = (db.prepare(`PRAGMA index_info(${idx})`).all() as { name: string }[]).map(r => r.name);
      expect(cols, idx).toEqual([owner]);
    }
    db.close();
  });
});

describe('migration 43: payment-attachments', () => {
  it('adds payment_attachments to a v42 database, shaped like the other attachment tables, and re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 42));
    expect(tableNames(db)).not.toContain('payment_attachments');

    runMigrations(db, dir, migrations);
    expect(columnNames(db, 'payment_attachments')).toEqual(['id', 'paymentId', 'fileId', 'sortOrder', 'createdAt']);
    const ins = db.prepare('INSERT INTO payment_attachments (id, paymentId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)');
    ins.run('pa-1', 'pay1', 'check.jpg', 0, 1);
    ins.run('pa-2', 'pay1', 'remit.pdf', 1, 1); // a photo and a PDF on one payment
    expect(() => ins.run('pa-3', 'pay1', 'check.jpg', 2, 1)).toThrow(/UNIQUE/);
    ins.run('pa-4', 'pay2', 'check.jpg', 0, 1); // the same file on another payment is fine

    // Idempotent: replaying up() must not throw or touch the rows.
    const m43 = migrations.find(m => m.version === 43)!;
    expect(() => m43.up({ db, dataDir: dir })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM payment_attachments').get()).toEqual({ c: 3 });
    db.close();
  });

  it('indexes the table on paymentId and leaves existing payments untouched', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 42));
    db.prepare(`INSERT INTO payments (id, targetType, targetId, date, amount, method, note, createdAt)
                VALUES ('pay1', 'invoice', 'inv1', 5, 120.5, 'check', 'deposit', 6)`).run();
    runMigrations(db, dir, migrations);
    const cols = (db.prepare('PRAGMA index_info(idx_payment_attachments_payment)').all() as { name: string }[]).map(r => r.name);
    expect(cols).toEqual(['paymentId']);
    expect(db.prepare('SELECT * FROM payments').all()).toEqual([
      { id: 'pay1', targetType: 'invoice', targetId: 'inv1', date: 5, amount: 120.5, method: 'check', note: 'deposit', createdAt: 6 },
    ]);
    db.close();
  });
});

describe('migration 44: daily-report-start-time', () => {
  it('adds startTime (nullable) to daily_reports, leaves existing reports and their weather alone, and re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 43));
    expect(columnNames(db, 'daily_reports')).not.toContain('startTime');

    const hourly = JSON.stringify([{ hour: '6 AM', tempF: 71, condition: 'Clear' }]);
    db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, weatherSummary, temperature, weatherHourly, createdAt, updatedAt)
                VALUES ('d1', 'p1', '2026-08-26', 'Clear', '71–80°F', ?, 1, 1)`).run(hourly);

    runMigrations(db, dir, migrations);

    expect(columnNames(db, 'daily_reports')).toContain('startTime');
    expect(db.prepare('SELECT startTime, weatherSummary, temperature, weatherHourly, version FROM daily_reports WHERE id = ?').get('d1'))
      .toEqual({ startTime: null, weatherSummary: 'Clear', temperature: '71–80°F', weatherHourly: hourly, version: 1 });

    // Idempotent: replaying up() must not throw (duplicate column) or reset data.
    db.prepare('UPDATE daily_reports SET startTime = ? WHERE id = ?').run('07:00', 'd1');
    const m44 = migrations.find(m => m.version === 44)!;
    expect(() => m44.up({ db, dataDir: dir })).not.toThrow();
    expect(db.prepare('SELECT startTime FROM daily_reports WHERE id = ?').get('d1')).toEqual({ startTime: '07:00' });
    db.close();
  });
});

describe('migration 45: daily-report-crews', () => {
  // Every column daily_reports had at v44, in its v44 order.
  const V44_COLS = ['id', 'projectId', 'reportDate', 'jobName', 'contractorName', 'weatherSummary', 'temperature',
    'weatherHourly', 'manCounts', 'fieldNotes', 'issues', 'createdBy', 'createdAt', 'updatedAt', 'version', 'startTime'];

  // A v44 database with reports on two projects (one since deleted — project
  // delete never removed its reports), a project with none, and the photo and
  // PDF-attachment rows that hang off the reports by id.
  const seedV44 = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 44));
    expect(columnNames(db, 'daily_reports')).toEqual(V44_COLS);
    db.prepare(`INSERT INTO projects (id, name, createdAt) VALUES ('p1', 'Dunmore', 1), ('p2', 'Hartwell', 1), ('p3', 'No reports', 1)`).run();
    const ins = db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, startTime, jobName, contractorName, weatherSummary,
        temperature, weatherHourly, manCounts, fieldNotes, issues, createdBy, createdAt, updatedAt, version)
      VALUES (?, ?, ?, ?, 'Job', 'GC', 'Clear', '71–80°F', '[{"hour":"6 AM","tempF":71,"condition":"Clear"}]',
        '[{"type":"Plasterer","count":4}]', 'notes', 'none', 'noah', 5, 6, 3)`);
    ins.run('d1', 'p1', '2026-08-25', '07:00');
    ins.run('d2', 'p1', '2026-08-26', null);
    ins.run('d3', 'p2', '2026-08-26', '06:00');
    ins.run('d4', 'gone', '2026-08-20', null); // its project was deleted
    db.prepare(`INSERT INTO daily_report_photos (id, dailyReportId, fileId, sortOrder, createdAt) VALUES ('ph1', 'd1', 'f1', 0, 1)`).run();
    db.prepare(`INSERT INTO daily_report_attachments (id, dailyReportId, fileId, sortOrder, createdAt) VALUES ('at1', 'd3', 'f2', 0, 1)`).run();
    return { db, dir, before: db.prepare('SELECT * FROM daily_reports ORDER BY id').all() as any[] };
  };

  it('rebuilds daily_reports with crewId, keeping every row, id, column value and its photos/attachments', () => {
    const { db, dir, before } = seedV44();
    runMigrations(db, dir, migrations);

    expect(columnNames(db, 'daily_reports').sort()).toEqual([...V44_COLS, 'crewId'].sort());
    const after = db.prepare('SELECT * FROM daily_reports ORDER BY id').all() as any[];
    expect(after.map(({ crewId, ...rest }) => rest)).toEqual(before);
    expect(after.every(r => typeof r.crewId === 'string' && r.crewId)).toBe(true);
    // Children still find their report by id.
    expect(db.prepare(`SELECT r.reportDate FROM daily_report_photos p JOIN daily_reports r ON r.id = p.dailyReportId`).all())
      .toEqual([{ reportDate: '2026-08-25' }]);
    expect(db.prepare(`SELECT r.projectId FROM daily_report_attachments a JOIN daily_reports r ON r.id = a.dailyReportId`).all())
      .toEqual([{ projectId: 'p2' }]);
    // Defaults survive the rebuild.
    db.prepare(`INSERT INTO daily_reports (id, projectId, crewId, reportDate, createdAt, updatedAt) VALUES ('d9', 'p3', 'c9', '2026-08-26', 1, 1)`).run();
    expect(db.prepare('SELECT jobName, weatherHourly, manCounts, startTime, version FROM daily_reports WHERE id = ?').get('d9'))
      .toEqual({ jobName: '', weatherHourly: '[]', manCounts: '[]', startTime: null, version: 1 });
    db.close();
  });

  it('gives every project with reports one "Crew 1" holding all of them, and a project with none no crew', () => {
    const { db, dir } = seedV44();
    runMigrations(db, dir, migrations);

    expect(columnNames(db, 'daily_report_crews')).toEqual(['id', 'projectId', 'name', 'sortOrder', 'createdAt', 'updatedAt']);
    const crews = db.prepare('SELECT id, projectId, name, sortOrder FROM daily_report_crews ORDER BY projectId').all() as any[];
    expect(crews.map(c => [c.projectId, c.name, c.sortOrder])).toEqual([['gone', 'Crew 1', 0], ['p1', 'Crew 1', 0], ['p2', 'Crew 1', 0]]);
    const crewOf = Object.fromEntries(crews.map(c => [c.projectId, c.id]));
    expect(db.prepare('SELECT id, crewId FROM daily_reports ORDER BY id').all()).toEqual([
      { id: 'd1', crewId: crewOf.p1 }, { id: 'd2', crewId: crewOf.p1 }, { id: 'd3', crewId: crewOf.p2 }, { id: 'd4', crewId: crewOf.gone },
    ]);
    db.close();
  });

  it('makes the date rule one report per date PER CREW, and keeps the indexes', () => {
    const { db, dir } = seedV44();
    runMigrations(db, dir, migrations);
    const crew1 = (db.prepare(`SELECT id FROM daily_report_crews WHERE projectId = 'p1'`).get() as any).id;
    const ins = db.prepare(`INSERT INTO daily_reports (id, projectId, crewId, reportDate, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 1)`);
    expect(() => ins.run('dup', 'p1', crew1, '2026-08-26')).toThrow(/UNIQUE/);
    ins.run('other-crew', 'p1', 'crew-2', '2026-08-26'); // same date, another crew: fine
    expect(() => ins.run('no-crew', 'p1', null, '2026-08-27')).toThrow(/NOT NULL/);

    const indexCols = (idx: string) => (db.prepare(`PRAGMA index_info(${idx})`).all() as { name: string }[]).map(r => r.name);
    expect(indexCols('idx_daily_reports_project')).toEqual(['projectId']);
    expect(indexCols('idx_daily_report_crews_project')).toEqual(['projectId']);
    const unique = (db.prepare(`PRAGMA index_list(daily_reports)`).all() as any[]).filter(i => i.unique && i.origin === 'u');
    expect(unique.map(i => indexCols(i.name))).toEqual([['projectId', 'crewId', 'reportDate']]);
    expect(tableNames(db)).not.toContain('daily_reports_new');
    db.close();
  });

  it('replaying up() is a no-op: no second crew, no second rebuild', () => {
    const { db, dir } = seedV44();
    runMigrations(db, dir, migrations);
    const crews = db.prepare('SELECT * FROM daily_report_crews ORDER BY id').all();
    const reports = db.prepare('SELECT * FROM daily_reports ORDER BY id').all();

    const m45 = migrations.find(m => m.version === 45)!;
    expect(() => m45.up({ db, dataDir: dir })).not.toThrow();
    expect(db.prepare('SELECT * FROM daily_report_crews ORDER BY id').all()).toEqual(crews);
    expect(db.prepare('SELECT * FROM daily_reports ORDER BY id').all()).toEqual(reports);
    db.close();
  });

  it('on a fresh install, makes the crews table and an empty per-crew daily_reports', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_crews').get()).toEqual({ c: 0 });
    expect(columnNames(db, 'daily_reports')).toContain('crewId');
    db.close();
  });

  it('a column the rebuild does not know stops the migration, leaving the v44 table and its rows as they were', () => {
    const { db, dir, before } = seedV44();
    db.exec(`ALTER TABLE daily_reports ADD COLUMN somethingElse TEXT`);
    expect(() => runMigrations(db, dir, migrations)).toThrow(/columns the rebuild would drop: somethingElse/);
    expect(db.prepare('SELECT MAX(version) v FROM schema_version').get()).toEqual({ v: 44 });
    expect(columnNames(db, 'daily_reports')).toEqual([...V44_COLS, 'somethingElse']);
    expect((db.prepare('SELECT * FROM daily_reports ORDER BY id').all() as any[]).map(({ somethingElse, ...r }) => r)).toEqual(before);
    expect(tableNames(db)).not.toContain('daily_report_crews');
    db.close();
  });
});

describe('migration 46: invoices-auto-paid', () => {
  // A v45 database with invoices in every state the rule distinguishes.
  const seedV45 = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 45));
    db.prepare(`INSERT INTO projects (id, name, createdAt) VALUES ('p1', 'Dunmore', 1)`).run();
    const inv = db.prepare(`INSERT INTO invoices (id, projectId, number, status, version, createdAt, updatedAt) VALUES (?, 'p1', ?, ?, 3, 5, 6)`);
    const line = db.prepare(`INSERT INTO invoice_lines (id, invoiceId, description, qty, unitPrice, sortOrder) VALUES (?, ?, 'x', ?, ?, 0)`);
    const pay = db.prepare(`INSERT INTO payments (id, targetType, targetId, date, amount, createdAt) VALUES (?, ?, ?, 1, ?, 1)`);
    // Paid in full, still 'sent' → marked paid. Three 0.1 lines = 30¢ exactly.
    inv.run('full', '1001', 'sent');
    ['a', 'b', 'c'].forEach(l => line.run(`full-${l}`, 'full', 1, 0.1));
    pay.run('pf1', 'invoice', 'full', 0.1); pay.run('pf2', 'invoice', 'full', 0.2);
    // Overpaid → paid.
    inv.run('over', '1002', 'sent'); line.run('over-a', 'over', 2, 50); pay.run('po', 'invoice', 'over', 150);
    // Partly paid by one cent → stays sent.
    inv.run('part', '1003', 'sent'); line.run('part-a', 'part', 1, 100); pay.run('pp', 'invoice', 'part', 99.99);
    // $0 invoice with a payment → stays sent (nothing to cover).
    inv.run('zero', '1004', 'sent'); pay.run('pz', 'invoice', 'zero', 10);
    // A fully paid draft is not touched by the backfill.
    inv.run('draft', '1005', 'draft'); line.run('draft-a', 'draft', 1, 40); pay.run('pd', 'invoice', 'draft', 40);
    // Already paid → untouched.
    inv.run('paid', '1006', 'paid'); line.run('paid-a', 'paid', 1, 40);
    // A pay application payment with the same id as an invoice never counts for it.
    inv.run('payapp', '1007', 'sent'); line.run('payapp-a', 'payapp', 1, 40); pay.run('pa', 'payapp', 'payapp', 40);
    return { db, dir };
  };
  const statuses = (db: any) => Object.fromEntries(
    (db.prepare('SELECT id, status FROM invoices ORDER BY id').all() as { id: string; status: string }[]).map(r => [r.id, r.status]));

  it('marks sent invoices whose payments cover a total over $0 paid, and nothing else', () => {
    const { db, dir } = seedV45();
    runMigrations(db, dir, migrations);
    expect(statuses(db)).toEqual({
      full: 'paid', over: 'paid', part: 'sent', zero: 'sent', draft: 'draft', paid: 'paid', payapp: 'sent',
    });
    db.close();
  });

  it('changes only the status: version, updatedAt, lines and payments are as they were', () => {
    const { db, dir } = seedV45();
    const others = (d: any) => ({
      invoices: d.prepare('SELECT id, number, version, createdAt, updatedAt FROM invoices ORDER BY id').all(),
      lines: d.prepare('SELECT * FROM invoice_lines ORDER BY id').all(),
      payments: d.prepare('SELECT * FROM payments ORDER BY id').all(),
    });
    const before = others(db);
    runMigrations(db, dir, migrations);
    expect(others(db)).toEqual(before);
    db.close();
  });

  it('replaying up() is a no-op, and a fresh install runs it cleanly', () => {
    const { db, dir } = seedV45();
    runMigrations(db, dir, migrations);
    const after = statuses(db);
    const m46 = migrations.find(m => m.version === 46)!;
    expect(() => m46.up({ db, dataDir: dir })).not.toThrow();
    expect(statuses(db)).toEqual(after);
    db.close();

    const fresh = openDb(':memory:');
    expect(() => runMigrations(fresh, tmpDir(), migrations.filter(m => m.version <= 46))).not.toThrow();
    expect(fresh.prepare('SELECT MAX(version) v FROM schema_version').get()).toEqual({ v: 46 });
    fresh.close();
  });
});

describe('migration 47: change-order-legacy-lump-sum', () => {
  // Change orders written before migration 14 (value only in amount, no lines;
  // 14 gives them lumpSumAmount 0), carried up to v46, next to change orders
  // the store wrote since.
  const seedV46 = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 13));
    const legacy = db.prepare(`INSERT INTO change_orders (id, projectId, number, description, amount, status, createdAt) VALUES (?, 'p1', ?, 'Extra', ?, ?, 5)`);
    legacy.run('legacy', '1', 1234.56, 'approved');
    legacy.run('credit', '2', -250, 'pending'); // a deduction moves the same way
    legacy.run('legacy-zero', '3', 0, 'pending'); // worth $0 → nothing to move
    runMigrations(db, dir, migrations.filter(m => m.version <= 46));
    const co = db.prepare(`INSERT INTO change_orders (id, projectId, number, description, amount, status, version, lumpSumAmount, createdAt, updatedAt)
      VALUES (?, 'p1', ?, 'x', ?, 'approved', 3, ?, 5, 6)`);
    const line = db.prepare(`INSERT INTO change_order_lines (id, changeOrderId, description, qty, unitPrice, sortOrder) VALUES (?, ?, 'x', ?, ?, 0)`);
    // Lines and no lump sum → untouched. Three 0.1 lines = 30¢ exactly.
    co.run('lined', '4', 0.3, 0);
    ['a', 'b', 'c'].forEach(l => line.run(`lined-${l}`, 'lined', 1, 0.1));
    co.run('lump', '5', 75, 75); // a lump sum already → untouched
    co.run('both', '6', 175, 75); line.run('both-a', 'both', 2, 50); // lines + lump sum → untouched
    co.run('zero', '7', 0, 0); // $0 throughout → untouched
    return { db, dir };
  };
  const lumpSums = (db: any) => Object.fromEntries(
    (db.prepare('SELECT id, lumpSumAmount FROM change_orders ORDER BY id').all() as { id: string; lumpSumAmount: number }[])
      .map(r => [r.id, r.lumpSumAmount]));

  it('gives a change order with no lines, no lump sum and a non-zero amount that amount as its lump sum, and nothing else', () => {
    const { db, dir } = seedV46();
    expect(lumpSums(db)).toEqual({ legacy: 0, credit: 0, 'legacy-zero': 0, lined: 0, lump: 75, both: 75, zero: 0 });
    runMigrations(db, dir, migrations);
    expect(lumpSums(db)).toEqual({ legacy: 1234.56, credit: -250, 'legacy-zero': 0, lined: 0, lump: 75, both: 75, zero: 0 });
    db.close();
  });

  it('makes Σ line cents + lump-sum cents equal amount for every change order', () => {
    const { db, dir } = seedV46();
    runMigrations(db, dir, migrations);
    const cents = (d: number) => Math.round(d * 100);
    const lineCents = (id: string) => (db.prepare('SELECT qty, unitPrice FROM change_order_lines WHERE changeOrderId = ?').all(id) as any[])
      .reduce((a, l) => a + cents(l.qty * l.unitPrice), 0);
    for (const r of db.prepare('SELECT id, amount, lumpSumAmount FROM change_orders').all() as any[]) {
      expect(lineCents(r.id) + cents(r.lumpSumAmount), r.id).toBe(cents(r.amount));
    }
    db.close();
  });

  it('changes only lumpSumAmount (and a fixed row\'s updatedAt): amount, status, version and lines are as they were', () => {
    const { db, dir } = seedV46();
    const others = (d: any) => ({
      changeOrders: d.prepare('SELECT id, number, amount, status, version, createdAt FROM change_orders ORDER BY id').all(),
      lines: d.prepare('SELECT * FROM change_order_lines ORDER BY id').all(),
    });
    const stamps = (d: any) => Object.fromEntries(
      (d.prepare('SELECT id, updatedAt FROM change_orders ORDER BY id').all() as { id: string; updatedAt: number | null }[])
        .map(r => [r.id, r.updatedAt]));
    const before = others(db);
    const stampsBefore = stamps(db);
    const t0 = Date.now();
    runMigrations(db, dir, migrations);
    expect(others(db)).toEqual(before);
    // A fixed row's stored PDF (which printed $0) now reads out of date; the
    // rest keep their stamp.
    const after = stamps(db);
    for (const id of ['legacy', 'credit']) expect(after[id]).toBeGreaterThanOrEqual(t0);
    for (const id of ['legacy-zero', 'lined', 'lump', 'both', 'zero']) expect(after[id]).toBe(stampsBefore[id]);
    db.close();
  });

  it('replaying up() is a no-op, and a fresh install runs it cleanly', () => {
    const { db, dir } = seedV46();
    runMigrations(db, dir, migrations);
    const after = db.prepare('SELECT * FROM change_orders ORDER BY id').all();
    const m47 = migrations.find(m => m.version === 47)!;
    expect(() => m47.up({ db, dataDir: dir })).not.toThrow();
    expect(db.prepare('SELECT * FROM change_orders ORDER BY id').all()).toEqual(after);
    db.close();

    const fresh = openDb(':memory:');
    expect(() => runMigrations(fresh, tmpDir(), migrations)).not.toThrow();
    expect(fresh.prepare('SELECT name FROM schema_version WHERE version = 47').get()).toEqual({ name: 'change-order-legacy-lump-sum' });
    fresh.close();
  });
});
