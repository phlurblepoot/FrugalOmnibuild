// server/aiaStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  getSovLine, listSovLines, createSovLine, saveSovLine, deleteSovLine,
  seedSovLines, syncChangeOrders, reorderSovLines, splitSovLine,
  createPayApp, listPayApps, getPayApp, savePayAppLines, setPayApp, deletePayApp,
  computeG703, computeG702, remainingReleasablePoints, retainageReleasedCents,
  getSovLock, lockSov, unlockSov, assertSovEditable,
  ValidationError, ConflictError, NotFoundError, SovLockedError,
} from './aiaStore';
import { recordPayment, listBilledDocuments } from './billingStore';

let db: Database.Database;

function insertChangeOrder(id: string, projectId: string, number: string, description: string, amount: number, status: string, title: string | null = null) {
  db.prepare('INSERT INTO change_orders (id, projectId, number, title, description, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, number, title, description, amount, status, Date.now());
}

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-aia-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('createSovLine / getSovLine', () => {
  it('creates and reads a line with defaults', () => {
    const { id } = createSovLine(db, 'p1', { itemNo: '1', description: 'Framing', scheduledValueCents: 150000 });
    const line = getSovLine(db, id)!;
    expect(line.itemNo).toBe('1');
    expect(line.description).toBe('Framing');
    expect(line.scheduledValueCents).toBe(150000);
    expect(line.retainagePercent).toBeNull();
    expect(line.isChangeOrder).toBe(0);
    expect(line.changeOrderId).toBeNull();
    expect(line.sortOrder).toBe(0);
    expect(line.version).toBe(1);
  });

  it('stores retainagePercent when provided', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100, retainagePercent: 10 });
    expect(getSovLine(db, id)!.retainagePercent).toBe(10);
  });

  it('rejects unknown project (NotFoundError)', () => {
    expect(() => createSovLine(db, 'nope', { description: 'X', scheduledValueCents: 0 })).toThrow(NotFoundError);
  });

  it('getSovLine returns null for unknown id', () => {
    expect(getSovLine(db, 'no-such-id')).toBeNull();
  });
});

describe('listSovLines ordering', () => {
  it('orders by sortOrder ASC', () => {
    createSovLine(db, 'p1', { description: 'a', scheduledValueCents: 1 });
    createSovLine(db, 'p1', { description: 'b', scheduledValueCents: 1 });
    createSovLine(db, 'p1', { description: 'c', scheduledValueCents: 1 });
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['a', 'b', 'c']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1, 2]);
  });

  it('scopes to the project', () => {
    createSovLine(db, 'p1', { description: 'a', scheduledValueCents: 1 });
    createSovLine(db, 'p2', { description: 'z', scheduledValueCents: 1 });
    expect(listSovLines(db, 'p1').map(l => l.description)).toEqual(['a']);
  });
});

describe('saveSovLine', () => {
  it('bumps version and updates fields with correct version', () => {
    const { id } = createSovLine(db, 'p1', { itemNo: '1', description: 'Old', scheduledValueCents: 100 });
    const line = getSovLine(db, id)!;
    const r = saveSovLine(db, id, { ...line, description: 'New', scheduledValueCents: 200, retainagePercent: 5 });
    expect(r.version).toBe(2);
    const reloaded = getSovLine(db, id)!;
    expect(reloaded.description).toBe('New');
    expect(reloaded.scheduledValueCents).toBe(200);
    expect(reloaded.retainagePercent).toBe(5);
    expect(reloaded.version).toBe(2);
  });

  it('throws ConflictError on stale version', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Old', scheduledValueCents: 100 });
    const line = getSovLine(db, id)!;
    saveSovLine(db, id, { ...line, description: 'Updated' }); // -> v2
    expect(() => saveSovLine(db, id, { ...line, description: 'Stale' })).toThrow(ConflictError); // still v1
  });

  it('throws NotFoundError for missing id', () => {
    expect(() => saveSovLine(db, 'no-such-id', { description: 'X', scheduledValueCents: 0, version: 1 })).toThrow(NotFoundError);
  });
});

describe('validation', () => {
  it('rejects non-integer scheduledValueCents', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 10.5 })).toThrow(ValidationError);
  });

  it('rejects negative scheduledValueCents', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: -1 })).toThrow(ValidationError);
  });

  it('rejects non-finite scheduledValueCents', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: Infinity })).toThrow(ValidationError);
  });

  it('rejects out-of-range retainagePercent', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 0, retainagePercent: -1 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 0, retainagePercent: 101 })).toThrow(ValidationError);
  });

  it('saveSovLine enforces the same validation', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100 });
    const line = getSovLine(db, id)!;
    expect(() => saveSovLine(db, id, { ...line, scheduledValueCents: 1.5 })).toThrow(ValidationError);
  });
});

describe('deleteSovLine', () => {
  it('deletes the line', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 0 });
    deleteSovLine(db, id);
    expect(getSovLine(db, id)).toBeNull();
  });
});

describe('seedSovLines', () => {
  it('inserts lines with sequential sortOrder and itemNo, returns count', () => {
    const r = seedSovLines(db, 'p1', [
      { description: 'Demo', scheduledValueCents: 1000 },
      { description: 'Framing', scheduledValueCents: 2000 },
      { description: 'Finish', scheduledValueCents: 3000, itemNo: 'F-1' },
    ]);
    expect(r.count).toBe(3);
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['Demo', 'Framing', 'Finish']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1, 2]);
    expect(list.map(l => l.itemNo)).toEqual(['1', '2', 'F-1']);
    expect(list.every(l => l.isChangeOrder === 0 && l.version === 1)).toBe(true);
  });

  it('replaces existing estimate lines but keeps change-order lines, re-sorting them after', () => {
    // initial estimate
    seedSovLines(db, 'p1', [
      { description: 'Old1', scheduledValueCents: 100 },
      { description: 'Old2', scheduledValueCents: 200 },
    ]);
    // a change-order line (kept across reseed)
    createSovLine(db, 'p1', { description: 'CO line', scheduledValueCents: 500, isChangeOrder: 1, changeOrderId: 'co1' });
    // reseed with a different estimate
    const r = seedSovLines(db, 'p1', [
      { description: 'New1', scheduledValueCents: 111 },
    ]);
    expect(r.count).toBe(1);
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['New1', 'CO line']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1]);
    expect(list.map(l => l.isChangeOrder)).toEqual([0, 1]);
  });

  it('validates each scheduledValueCents and aborts without writing', () => {
    expect(() => seedSovLines(db, 'p1', [
      { description: 'Good', scheduledValueCents: 100 },
      { description: 'Bad', scheduledValueCents: -5 },
    ])).toThrow(ValidationError);
    expect(listSovLines(db, 'p1')).toEqual([]);
  });
});

describe('syncChangeOrders', () => {
  it('appends only approved change orders, converts dollars to cents, idempotent on re-run', () => {
    insertChangeOrder('co1', 'p1', '1', 'Extra electrical', 2500.00, 'approved');
    insertChangeOrder('co2', 'p1', '2', 'Pending work', 1000.00, 'pending');
    insertChangeOrder('co3', 'p1', '3', 'Rejected work', 999.00, 'rejected');

    const first = syncChangeOrders(db, 'p1');
    expect(first.added).toBe(1);
    const list = listSovLines(db, 'p1');
    expect(list.length).toBe(1);
    expect(list[0].isChangeOrder).toBe(1);
    expect(list[0].changeOrderId).toBe('co1');
    expect(list[0].itemNo).toBe('CO-1');
    expect(list[0].description).toBe('Extra electrical');
    expect(list[0].scheduledValueCents).toBe(250000); // 2500.00 -> 250000 cents

    // idempotent
    const second = syncChangeOrders(db, 'p1');
    expect(second.added).toBe(0);
    expect(listSovLines(db, 'p1').length).toBe(1);
  });

  it('appends a newly-approved change order on a later run', () => {
    insertChangeOrder('co1', 'p1', '1', 'First', 100.00, 'approved');
    expect(syncChangeOrders(db, 'p1').added).toBe(1);
    insertChangeOrder('co2', 'p1', '2', 'Second', 200.00, 'approved');
    expect(syncChangeOrders(db, 'p1').added).toBe(1);
    expect(listSovLines(db, 'p1').map(l => l.changeOrderId)).toEqual(['co1', 'co2']);
  });

  it('appends CO lines after seeded estimate lines', () => {
    seedSovLines(db, 'p1', [
      { description: 'E1', scheduledValueCents: 1 },
      { description: 'E2', scheduledValueCents: 2 },
    ]);
    insertChangeOrder('co1', 'p1', '1', 'CO', 50.00, 'approved');
    syncChangeOrders(db, 'p1');
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['E1', 'E2', 'CO']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1, 2]);
  });

  it('new SOV lines use title when present, falling back to description; existing lines are untouched on re-sync', () => {
    insertChangeOrder('co1', 'p1', '1', 'Extra electrical', 500.00, 'approved', 'Kitchen electrical add');
    insertChangeOrder('co2', 'p1', '2', 'Demo work', 200.00, 'approved', null);
    insertChangeOrder('co3', 'p1', '3', 'Untitled but blank', 50.00, 'approved', '   ');

    syncChangeOrders(db, 'p1');
    const list = listSovLines(db, 'p1');
    expect(list.find(l => l.changeOrderId === 'co1')!.description).toBe('Kitchen electrical add'); // titled
    expect(list.find(l => l.changeOrderId === 'co2')!.description).toBe('Demo work'); // falls back to description
    expect(list.find(l => l.changeOrderId === 'co3')!.description).toBe('Untitled but blank'); // whitespace-only title also falls back

    // Re-sync must not touch the already-mirrored line, even if the CO's
    // title changes afterward (the exists-check skips it — same as before).
    db.prepare('UPDATE change_orders SET title = ? WHERE id = ?').run('Renamed after sync', 'co1');
    syncChangeOrders(db, 'p1');
    expect(listSovLines(db, 'p1').find(l => l.changeOrderId === 'co1')!.description).toBe('Kitchen electrical add');
  });
});

// ---------------------------------------------------------------------------
// Pay applications + G702/G703 computation — CHARACTERIZATION (exact cents).
// ---------------------------------------------------------------------------

// Helper: a project with two SOV lines: $100k and $50k.
function setupTwoLines(): { line1: string; line2: string } {
  const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'Line 1', scheduledValueCents: 10000000 });
  const { id: line2 } = createSovLine(db, 'p1', { itemNo: '2', description: 'Line 2', scheduledValueCents: 5000000 });
  return { line1, line2 };
}

describe('createPayApp', () => {
  it('numbers sequentially per project, defaults retainage to 10, seeds lines for each SOV line', () => {
    const { line1, line2 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', {});
    expect(a1.number).toBe(1);
    const app = getPayApp(db, a1.id)!;
    expect(app.status).toBe('draft');
    expect(app.version).toBe(1);
    expect(app.retainagePercent).toBe(10);
    expect(app.storedRetainagePercent).toBe(10);
    expect(app.lines.length).toBe(2);
    const sovIds = app.lines.map((l: any) => l.sovLineId).sort();
    expect(sovIds).toEqual([line1, line2].sort());
    expect(app.lines.every((l: any) => l.percentComplete === 0 && l.storedMaterialsCents === 0)).toBe(true);

    const a2 = createPayApp(db, 'p1', {});
    expect(a2.number).toBe(2);
  });

  it('carries forward the prior app percentComplete + storedMaterialsCents', () => {
    const { line1 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', {});
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 12345 },
    ], 1);
    const a2 = createPayApp(db, 'p1', {});
    const app2 = getPayApp(db, a2.id)!;
    const l1 = app2.lines.find((l: any) => l.sovLineId === line1);
    expect(l1.percentComplete).toBe(50);
    expect(l1.storedMaterialsCents).toBe(12345);
  });

  it('uses input retainage percents and validates them', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', { retainagePercent: 5, storedRetainagePercent: 7.5 });
    const app = getPayApp(db, a.id)!;
    expect(app.retainagePercent).toBe(5);
    expect(app.storedRetainagePercent).toBe(7.5);
    expect(() => createPayApp(db, 'p1', { retainagePercent: 101 })).toThrow(ValidationError);
    expect(() => createPayApp(db, 'p1', { retainagePercent: Infinity })).toThrow(ValidationError);
    expect(() => createPayApp(db, 'p1', { storedRetainagePercent: -1 })).toThrow(ValidationError);
  });

  it('rejects unknown project', () => {
    expect(() => createPayApp(db, 'nope', {})).toThrow(NotFoundError);
  });
});

describe('listPayApps / getPayApp', () => {
  it('lists ordered by number ASC', () => {
    setupTwoLines();
    createPayApp(db, 'p1', {});
    createPayApp(db, 'p1', {});
    createPayApp(db, 'p1', {});
    expect(listPayApps(db, 'p1').map(a => a.number)).toEqual([1, 2, 3]);
  });

  it('getPayApp returns null for unknown id', () => {
    expect(getPayApp(db, 'no-such-id')).toBeNull();
  });

  it('list figures: finalized app totalCents/paidCents/balanceCents computed from computeG702 L8 + payments sum; draft app gets live total + null balance', () => {
    // p1 — finalized app: $1,000 SOV line, 100% complete, 10% retainage, no prior app.
    //   completedToDateCents = 100000; retainage = round(100000*10%) = 10000
    //   L8 = (100000 - 10000) - previous(0) = 90000c; a 25000c payment is recorded against it.
    const { id: sov1 } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    const finalized = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, finalized.id, [{ sovLineId: sov1, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    setPayApp(db, finalized.id, { status: 'finalized' });
    recordPayment(db, 'payapp', finalized.id, { amount: 250 }); // 25000c of the 90000c billed

    // p2 — draft app (first/only app in its project, so L7's "previous" is 0):
    // $1,000 SOV line, 50% complete, default 10% retainage.
    //   completedToDateCents = round(100000*50%) = 50000; retainage = round(50000*10%) = 5000
    //   L8 = (50000 - 5000) - previous(0) = 45000c; no payment recorded.
    const { id: sov2 } = createSovLine(db, 'p2', { description: 'Framing', scheduledValueCents: 100000 });
    const draft = createPayApp(db, 'p2', {});
    savePayAppLines(db, draft.id, [{ sovLineId: sov2, percentComplete: 50, storedMaterialsCents: 0 }], 1);

    const finalizedRow = listPayApps(db, 'p1').find(r => r.id === finalized.id);
    expect(finalizedRow).toMatchObject({ totalCents: 90000, paidCents: 25000, balanceCents: 65000 });

    const draftRow = listPayApps(db, 'p2').find(r => r.id === draft.id);
    expect(draftRow).toMatchObject({ totalCents: 45000, paidCents: 0, balanceCents: null });
  });

  // Tripwire: listPayApps computes totalCents/paidCents/balanceCents locally
  // (computeG702 L8 + payments sum) while listBilledDocuments computes the
  // same figures independently for the customer/billing ledger. Pins them
  // together so the two formulas can't silently drift apart.
  it('listPayApps figures equal listBilledDocuments figures for the same finalized app', () => {
    const { id: sov1 } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, app.id, [{ sovLineId: sov1, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    setPayApp(db, app.id, { status: 'finalized' });
    recordPayment(db, 'payapp', app.id, { amount: 250 });

    const row = listPayApps(db, 'p1').find(r => r.id === app.id)!;
    const doc = listBilledDocuments(db, 'p1').find(d => d.kind === 'payapp' && d.id === app.id)!;
    expect({ totalCents: row.totalCents, paidCents: row.paidCents, balanceCents: row.balanceCents })
      .toEqual({ totalCents: doc.totalCents, paidCents: doc.paidCents, balanceCents: doc.balanceCents });
  });

  it('getPayApp embeds payments in the same row shape getInvoice embeds', () => {
    const { id: sov1 } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, app.id, [{ sovLineId: sov1, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    setPayApp(db, app.id, { status: 'finalized' });
    const { id: paymentId } = recordPayment(db, 'payapp', app.id, { date: 5, amount: 250, method: 'wire', note: 'partial' });

    const result = getPayApp(db, app.id)!;
    // Field set matches getInvoice's payments rows exactly: id, date, amount, method, note.
    expect(result.payments).toEqual([
      { id: paymentId, date: 5, amount: 250, method: 'wire', note: 'partial' },
    ]);
  });

  it('getPayApp payments is an empty array when no payments are recorded', () => {
    setupTwoLines();
    const app = createPayApp(db, 'p1', {});
    expect(getPayApp(db, app.id)!.payments).toEqual([]);
  });
});

describe('savePayAppLines', () => {
  it('upserts lines, bumps app version', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    const r = savePayAppLines(db, a.id, [
      { sovLineId: line1, percentComplete: 25, storedMaterialsCents: 100 },
    ], 1);
    expect(r.version).toBe(2);
    const app = getPayApp(db, a.id)!;
    expect(app.version).toBe(2);
    const l1 = app.lines.find((l: any) => l.sovLineId === line1);
    expect(l1.percentComplete).toBe(25);
    expect(l1.storedMaterialsCents).toBe(100);
  });

  it('inserts a pay_app_line that did not exist yet', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    unlockSov(db, 'p1');
    // a SOV line added AFTER the app was created has no seeded pay_app_line
    const { id: line3 } = createSovLine(db, 'p1', { description: 'Late', scheduledValueCents: 1000 });
    savePayAppLines(db, a.id, [{ sovLineId: line3, percentComplete: 10, storedMaterialsCents: 0 }], 1);
    const app = getPayApp(db, a.id)!;
    const l3 = app.lines.find((l: any) => l.sovLineId === line3);
    expect(l3.percentComplete).toBe(10);
  });

  it('throws ConflictError on stale version', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 10, storedMaterialsCents: 0 }], 1); // -> v2
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 20, storedMaterialsCents: 0 }], 1))
      .toThrow(ConflictError);
  });

  it('rejects bad percentComplete (>100 / non-finite)', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 101, storedMaterialsCents: 0 }], 1)).toThrow(ValidationError);
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: Infinity, storedMaterialsCents: 0 }], 1)).toThrow(ValidationError);
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: -1, storedMaterialsCents: 0 }], 1)).toThrow(ValidationError);
  });

  it('rejects bad storedMaterialsCents (non-integer / negative)', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 0, storedMaterialsCents: 1.5 }], 1)).toThrow(ValidationError);
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 0, storedMaterialsCents: -1 }], 1)).toThrow(ValidationError);
  });
});

describe('setPayApp', () => {
  it('patches status + retainage and bumps version', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    const r = setPayApp(db, a.id, { status: 'submitted', retainagePercent: 5 });
    expect(r.version).toBe(2);
    const app = getPayApp(db, a.id)!;
    expect(app.status).toBe('submitted');
    expect(app.retainagePercent).toBe(5);
    expect(app.storedRetainagePercent).toBe(10); // unchanged
  });

  it('validates retainage', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(() => setPayApp(db, a.id, { retainagePercent: 200 })).toThrow(ValidationError);
  });
});

describe('deletePayApp', () => {
  it('cascades its pay_app_lines', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(getPayApp(db, a.id)!.lines.length).toBe(2);
    deletePayApp(db, a.id);
    expect(getPayApp(db, a.id)).toBeNull();
    const remaining = db.prepare('SELECT COUNT(*) c FROM aia_pay_app_lines WHERE payAppId = ?').get(a.id) as any;
    expect(remaining.c).toBe(0);
  });

  it('cascades its payments', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    db.prepare('INSERT INTO payments (id, targetType, targetId, amount, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run('pay1', 'payapp', a.id, 500, 1);
    deletePayApp(db, a.id);
    const remaining = db.prepare("SELECT COUNT(*) c FROM payments WHERE targetType = 'payapp' AND targetId = ?").get(a.id) as any;
    expect(remaining.c).toBe(0);
  });
});

describe('computeG703 / computeG702 — exact cents', () => {
  it('app #1: 50% line1, 0% line2, retainage 10/10', () => {
    const { line1 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
      // line2 left at 0%
    ], 1);

    const g703 = computeG703(db, a1.id);
    const r1 = g703[0];
    expect(r1.scheduledValueCents).toBe(10000000);   // C
    expect(r1.previousCents).toBe(0);                 // D
    expect(r1.thisPeriodCents).toBe(5000000);         // E
    expect(r1.storedCents).toBe(0);                   // F
    expect(r1.totalToDateCents).toBe(5000000);        // G
    expect(r1.balanceToFinishCents).toBe(5000000);
    expect(r1.retainageCents).toBe(500000);

    const g702 = computeG702(db, a1.id);
    expect(g702.L1originalContractCents).toBe(15000000);
    expect(g702.L2changeOrdersCents).toBe(0);
    expect(g702.L3contractSumToDateCents).toBe(15000000);
    expect(g702.L4totalCompletedStoredCents).toBe(5000000);
    expect(g702.L5aRetainageWorkCents).toBe(500000);
    expect(g702.L5bRetainageStoredCents).toBe(0);
    expect(g702.L5retainageCents).toBe(500000);
    expect(g702.L6earnedLessRetainageCents).toBe(4500000);
    expect(g702.L7lessPreviousCents).toBe(0);
    expect(g702.L8currentPaymentDueCents).toBe(4500000);
    expect(g702.L9balanceToFinishCents).toBe(10500000);
  });

  it('app #2: carry-forward, 75%/200000 stored on line1, 40% on line2; L7 pulls prior L6', () => {
    const { line1, line2 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
    ], 1);

    const a2 = createPayApp(db, 'p1', {});
    savePayAppLines(db, a2.id, [
      { sovLineId: line1, percentComplete: 75, storedMaterialsCents: 200000 },
      { sovLineId: line2, percentComplete: 40, storedMaterialsCents: 0 },
    ], 1);

    const g703 = computeG703(db, a2.id);
    const r1 = g703[0];
    expect(r1.scheduledValueCents).toBe(10000000);  // C
    expect(r1.previousCents).toBe(5000000);         // D (prior 50%)
    expect(r1.thisPeriodCents).toBe(2500000);       // E (75% - 50%)
    expect(r1.storedCents).toBe(200000);            // F
    expect(r1.totalToDateCents).toBe(7700000);      // G
    expect(r1.retainageCents).toBe(770000);         // round(7500000*10%)=750000 + round(200000*10%)=20000

    const r2 = g703[1];
    expect(r2.scheduledValueCents).toBe(5000000);
    expect(r2.previousCents).toBe(0);
    expect(r2.thisPeriodCents).toBe(2000000);       // 40%
    expect(r2.totalToDateCents).toBe(2000000);
    expect(r2.retainageCents).toBe(200000);

    const g702 = computeG702(db, a2.id);
    expect(g702.L4totalCompletedStoredCents).toBe(9700000);  // 7700000 + 2000000
    expect(g702.L5aRetainageWorkCents).toBe(950000);         // 750000 + 200000
    expect(g702.L5bRetainageStoredCents).toBe(20000);        // round(200000*10%)
    expect(g702.L5retainageCents).toBe(970000);
    expect(g702.L6earnedLessRetainageCents).toBe(8730000);
    expect(g702.L7lessPreviousCents).toBe(4500000);          // app#1 L6
    expect(g702.L8currentPaymentDueCents).toBe(4230000);     // 8730000 - 4500000
  });

  it('per-line retainage override uses the line percent not the app percent', () => {
    const { line1, line2 } = setupTwoLines();
    // override line2 to 5% retainage
    const l2 = getSovLine(db, line2)!;
    saveSovLine(db, line2, { ...l2, retainagePercent: 5 });

    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
      { sovLineId: line2, percentComplete: 100, storedMaterialsCents: 0 },
    ], 1);

    const g703 = computeG703(db, a1.id);
    const r1 = g703[0]; // 10% app default
    expect(r1.retainageCents).toBe(500000); // round(5000000*10%)
    const r2 = g703[1]; // 5% override on a fully complete $50k line
    // completed = 5000000; retainage = round(5000000*5%) = 250000  (would be 500000 at 10%)
    expect(r2.retainageCents).toBe(250000);

    const g702 = computeG702(db, a1.id);
    // L5a = round(5000000*10%) + round(5000000*5%) = 500000 + 250000 = 750000
    expect(g702.L5aRetainageWorkCents).toBe(750000);
  });

  it('change-order line: L1 unchanged, L2 / L3 include it, changeOrders.additions set', () => {
    setupTwoLines();
    createSovLine(db, 'p1', { description: 'CO', scheduledValueCents: 1000000, isChangeOrder: 1 });
    const a1 = createPayApp(db, 'p1', {});
    const g702 = computeG702(db, a1.id);
    expect(g702.L1originalContractCents).toBe(15000000);  // unchanged
    expect(g702.L2changeOrdersCents).toBe(1000000);
    expect(g702.L3contractSumToDateCents).toBe(16000000);
    expect(g702.changeOrders.additionsCents).toBe(1000000);
    expect(g702.changeOrders.deductionsCents).toBe(0);
    expect(g702.changeOrders.netCents).toBe(1000000);
  });

  it('rounds per line (Math.round): 333 @ 33% => 110 cents', () => {
    const { id: line } = createSovLine(db, 'p1', { description: 'Tiny', scheduledValueCents: 333 });
    const a1 = createPayApp(db, 'p1', { retainagePercent: 0, storedRetainagePercent: 0 });
    savePayAppLines(db, a1.id, [{ sovLineId: line, percentComplete: 33, storedMaterialsCents: 0 }], 1);
    const g703 = computeG703(db, a1.id);
    // Math.round(333 * 33 / 100) = Math.round(109.89) = 110
    expect(g703[0].totalToDateCents).toBe(110);
    expect(g703[0].thisPeriodCents).toBe(110);
  });

  it('computeG702 throws NotFoundError for unknown pay app', () => {
    expect(() => computeG702(db, 'no-such-id')).toThrow(NotFoundError);
  });

  // Characterization: prior-application stored materials do NOT roll into column D.
  // AIA G703 col D = prior application's (D+E) = work only; stored (col F) is a
  // current snapshot, separate from D. D must be 5000000, NOT 5100000.
  it('col D excludes prior stored materials (AIA G703 correct: D = work only)', () => {
    const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'Work', scheduledValueCents: 10000000 });

    // App #1: 50% work complete, $1000 in stored materials.
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 100000 },
    ], 1);
    // (app#1 completedToDate = 5000000; stored = 100000)

    // App #2: same 50% work (no new work this period), more stored materials on hand.
    const a2 = createPayApp(db, 'p1', {});
    savePayAppLines(db, a2.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 200000 },
    ], 1);

    const g703 = computeG703(db, a2.id);
    const r = g703[0];

    // D = prior WORK only: round(10000000 * 50 / 100) = 5000000
    // If prior stored were included, D would be 5100000 — that is AIA-incorrect.
    expect(r.previousCents).toBe(5000000);    // D: prior work only, NOT 5100000
    expect(r.thisPeriodCents).toBe(0);        // E: no new work this period
    expect(r.storedCents).toBe(200000);       // F: current stored snapshot
    expect(r.totalToDateCents).toBe(5200000); // G: completedToDate(5000000) + storedCents(200000)

    // G702 internal consistency: L4 == sum of col G.
    const g702 = computeG702(db, a2.id);
    expect(g702.L4totalCompletedStoredCents).toBe(5200000); // matches col G sum
  });
});

// ---------------------------------------------------------------------------
// Retainage release (effective-rate model). Each app stores the percentage
// POINTS it releases; the effective rate on app N is
//   base − Σ releasedRetainagePoints over apps with number ≤ N   (floored at 0)
// so released dollars fall out of L5, lift L6, and get paid via L8.
// ---------------------------------------------------------------------------

// Write aiaSettings into the project's meta column (the shape projectStore
// round-trips: meta = { aiaSettings: {...} }).
function setAiaSettings(projectId: string, settings: Record<string, unknown> | null) {
  db.prepare('UPDATE projects SET meta = ? WHERE id = ?')
    .run(settings ? JSON.stringify({ aiaSettings: settings }) : null, projectId);
}

// One $100,000 SOV line — keeps the release arithmetic readable.
function setupOneLine(cents = 10000000): string {
  return createSovLine(db, 'p1', { itemNo: '1', description: 'Line 1', scheduledValueCents: cents }).id;
}

describe('retainage release (effective-rate model)', () => {
  it('release on app 2 reduces its retainage to the effective rate and pays out the delta via L8', () => {
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 15 });
    const line = setupOneLine(); // $100,000

    // App #1 — 50% complete, no release. Base 15%.
    // completed = round(10000000 * 50/100) = 5000000
    // L5a = round(5000000 * 15/100) = 750000 ; L6 = 5000000 − 750000 = 4250000
    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    savePayAppLines(db, a1.id, [{ sovLineId: line, percentComplete: 50, storedMaterialsCents: 0 }], 1);
    expect(computeG702(db, a1.id).L5aRetainageWorkCents).toBe(750000);
    expect(computeG702(db, a1.id).L6earnedLessRetainageCents).toBe(4250000);

    // App #2 — SAME percentComplete, so with no release nothing is due.
    const a2 = createPayApp(db, 'p1', { retainagePercent: 15 });
    const beforeRelease = computeG702(db, a2.id).L8currentPaymentDueCents;
    expect(beforeRelease).toBe(0); // L6 == prior L6 → nothing earned this period

    // Release 5 points on app 2 → cumulative(≤2) = 5 → effective 10%.
    setPayApp(db, a2.id, { releasedRetainagePoints: 5 });

    // L5a = round(5000000 * 10/100) = 500000
    // L6  = 5000000 − 500000 = 4500000 ; L7 = app#1 L6 = 4250000
    // L8  = 4500000 − 4250000 = 250000  == 5 points of the 5000000 earned base
    const g703 = computeG703(db, a2.id);
    expect(g703[0].retainageCents).toBe(500000);
    const g702 = computeG702(db, a2.id);
    expect(g702.L5aRetainageWorkCents).toBe(500000);
    expect(g702.L5bRetainageStoredCents).toBe(0);
    expect(g702.L6earnedLessRetainageCents).toBe(4500000);
    expect(g702.L7lessPreviousCents).toBe(4250000);
    expect(g702.L8currentPaymentDueCents).toBe(250000);
    // The delta over the no-release run IS exactly the released dollars.
    expect(g702.L8currentPaymentDueCents - beforeRelease).toBe(250000);
    expect(g702.L8currentPaymentDueCents - beforeRelease).toBe(Math.round(5000000 * 5 / 100));

    expect(g702.retainage).toEqual({
      mode: 'uniform',
      baseWorkPercent: 15,
      cumulativeReleasedPoints: 5,
      releasedThisApp: 5,
      remainingPoints: 15, // budget BEFORE this app's own release
      effectiveWorkPercent: 10,
    });
    // App #1 is untouched by a release recorded on a LATER app.
    expect(computeG702(db, a1.id).retainage).toEqual({
      mode: 'uniform',
      baseWorkPercent: 15,
      cumulativeReleasedPoints: 0,
      releasedThisApp: 0,
      remainingPoints: 15,
      effectiveWorkPercent: 15,
    });
    expect(computeG702(db, a1.id).L5aRetainageWorkCents).toBe(750000); // unchanged
  });

  it('release-all drives retainage to zero and the chain pays out all held retainage', () => {
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 15 });
    const line = setupOneLine(); // $100,000

    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    savePayAppLines(db, a1.id, [{ sovLineId: line, percentComplete: 50, storedMaterialsCents: 0 }], 1);

    const a2 = createPayApp(db, 'p1', { retainagePercent: 15 }); // carries 50%
    setPayApp(db, a2.id, { releasedRetainagePoints: 5 });

    // Final app: 100% complete, release everything still held.
    const a3 = createPayApp(db, 'p1', { retainagePercent: 15 });
    savePayAppLines(db, a3.id, [{ sovLineId: line, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    expect(remainingReleasablePoints(db, a3.id)).toBe(10); // 15 − 5 already released
    setPayApp(db, a3.id, { releasedRetainagePoints: remainingReleasablePoints(db, a3.id) });

    // cumulative(≤3) = 15 → effective 0% → no retainage held at all.
    const g3 = computeG702(db, a3.id);
    expect(g3.L5aRetainageWorkCents).toBe(0);
    expect(g3.L5bRetainageStoredCents).toBe(0);
    expect(g3.L5retainageCents).toBe(0);
    expect(g3.L4totalCompletedStoredCents).toBe(10000000);
    expect(g3.L6earnedLessRetainageCents).toBe(10000000);
    expect(g3.L7lessPreviousCents).toBe(4500000);   // app#2 L6
    expect(g3.L8currentPaymentDueCents).toBe(5500000); // 10000000 − 4500000
    expect(g3.retainage.effectiveWorkPercent).toBe(0);
    expect(g3.retainage.cumulativeReleasedPoints).toBe(15);

    // Σ L8 over the chain == total earned (nothing left held back).
    // 4250000 + 250000 + 5500000 = 10000000
    const sumL8 = [a1, a2, a3]
      .map(a => computeG702(db, a.id).L8currentPaymentDueCents)
      .reduce((s, n) => s + n, 0);
    expect(sumL8).toBe(10000000);
    expect(sumL8).toBe(g3.L4totalCompletedStoredCents);
  });

  // The Reports page's retainage report shows releases in dollars: line 5 as
  // it would read with no release, less line 5 as it is.
  it('retainageReleasedCents: the dollars releases let go, 0 when nothing was released', () => {
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 15 });
    const line = setupOneLine(); // $100,000
    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    savePayAppLines(db, a1.id, [{ sovLineId: line, percentComplete: 50, storedMaterialsCents: 0 }], 1);
    expect(retainageReleasedCents(db, a1.id)).toBe(0);

    // 5 points released on app 2: held 15% → 10% of $50,000 completed.
    const a2 = createPayApp(db, 'p1', { retainagePercent: 15 });
    setPayApp(db, a2.id, { releasedRetainagePoints: 5 });
    expect(computeG702(db, a2.id).L5retainageCents).toBe(500000);
    expect(retainageReleasedCents(db, a2.id)).toBe(250000); // 750000 unreleased − 500000 held
    expect(retainageReleasedCents(db, a1.id)).toBe(0); // a later release doesn't reach back

    // Stored materials are released at the same single rate.
    const a3 = createPayApp(db, 'p1', { retainagePercent: 15 });
    savePayAppLines(db, a3.id, [{ sovLineId: line, percentComplete: 50, storedMaterialsCents: 100000 }], 1);
    expect(computeG702(db, a3.id).L5retainageCents).toBe(500000 + 10000);
    expect(retainageReleasedCents(db, a3.id)).toBe(250000 + 5000);
  });

  it('retainageReleasedCents follows per-line rates in perLine mode', () => {
    setAiaSettings('p1', { retainageMode: 'perLine', retainagePercent: 10 });
    const l1 = createSovLine(db, 'p1', { itemNo: '1', description: 'Framing', scheduledValueCents: 1000000, retainagePercent: 20 }).id;
    const l2 = createSovLine(db, 'p1', { itemNo: '2', description: 'Lath', scheduledValueCents: 1000000 }).id; // base 10%
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: l1, percentComplete: 100, storedMaterialsCents: 0 },
      { sovLineId: l2, percentComplete: 100, storedMaterialsCents: 0 },
    ], 1);
    setPayApp(db, a1.id, { releasedRetainagePoints: 5 });
    // Held: 15% + 5% of $10,000 each = $2,000; with no release 20% + 10% = $3,000.
    expect(computeG702(db, a1.id).L5retainageCents).toBe(200000);
    expect(retainageReleasedCents(db, a1.id)).toBe(100000);
  });

  it('remainingReleasablePoints subtracts prior releases and floors at 0', () => {
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 15 });
    setupOneLine();

    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    const a2 = createPayApp(db, 'p1', { retainagePercent: 15 });
    expect(remainingReleasablePoints(db, a1.id)).toBe(15);
    expect(remainingReleasablePoints(db, a2.id)).toBe(15);

    setPayApp(db, a1.id, { releasedRetainagePoints: 6 });
    // STRICTLY PRIOR apps only: app 1's own release does not shrink its own budget.
    expect(remainingReleasablePoints(db, a1.id)).toBe(15);
    expect(remainingReleasablePoints(db, a2.id)).toBe(9); // 15 − 6

    // A later app on a LOWER base is already over-released → floored at 0, never negative.
    const a3 = createPayApp(db, 'p1', { retainagePercent: 4 });
    expect(remainingReleasablePoints(db, a3.id)).toBe(0); // max(0, 4 − 6)

    expect(() => remainingReleasablePoints(db, 'no-such-id')).toThrow(NotFoundError);
  });

  it('over-release is rejected with ValidationError', () => {
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 15 });
    setupOneLine();

    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    const a2 = createPayApp(db, 'p1', { retainagePercent: 15 });
    setPayApp(db, a1.id, { releasedRetainagePoints: 6 }); // remaining on a2 → 9

    expect(() => setPayApp(db, a2.id, { releasedRetainagePoints: 9.5 })).toThrow(ValidationError);
    expect(() => setPayApp(db, a2.id, { releasedRetainagePoints: -1 })).toThrow(ValidationError);
    expect(() => setPayApp(db, a2.id, { releasedRetainagePoints: Infinity })).toThrow(ValidationError);
    expect(() => setPayApp(db, a2.id, { releasedRetainagePoints: 'lots' as any })).toThrow(ValidationError);
    // A rejected release writes nothing (and does not bump the version).
    expect(getPayApp(db, a2.id)!.releasedRetainagePoints).toBe(0);
    expect(getPayApp(db, a2.id)!.version).toBe(1);

    // Exactly the remaining budget is allowed.
    setPayApp(db, a2.id, { releasedRetainagePoints: 9 });
    expect(getPayApp(db, a2.id)!.releasedRetainagePoints).toBe(9);
    expect(getPayApp(db, a2.id)!.version).toBe(2);
  });

  it('fractional releases: the reported remainder is exact and releasing it is accepted', () => {
    // 15 − (3.05 + 5) is 6.949999999999999 in binary floating point. The UI
    // must show 6.95, and typing that 6.95 back must NOT be rejected as an
    // over-release by a hair.
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 15 });
    setupOneLine();

    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    const a2 = createPayApp(db, 'p1', { retainagePercent: 15 });
    const a3 = createPayApp(db, 'p1', { retainagePercent: 15 });
    setPayApp(db, a1.id, { releasedRetainagePoints: 3.05 });
    setPayApp(db, a2.id, { releasedRetainagePoints: 5 }); // prior sum = 8.05

    // Raw arithmetic really does carry the residue…
    expect(remainingReleasablePoints(db, a3.id)).not.toBe(6.95);
    // …but what a client is told is the clean number.
    expect(computeG702(db, a3.id).retainage.remainingPoints).toBe(6.95);
    expect(computeG702(db, a3.id).retainage.cumulativeReleasedPoints).toBe(8.05);

    // And releasing exactly that reported remainder is accepted (epsilon).
    setPayApp(db, a3.id, { releasedRetainagePoints: 6.95 });
    expect(getPayApp(db, a3.id)!.releasedRetainagePoints).toBe(6.95);
    // Everything is now released → effective rate reports a clean 0.
    expect(computeG702(db, a3.id).retainage.effectiveWorkPercent).toBe(0);

    // A release genuinely beyond the remainder is still rejected, and the
    // message quotes the rounded remainder rather than float residue.
    const a4 = createPayApp(db, 'p1', { retainagePercent: 15 });
    setPayApp(db, a4.id, { releasedRetainagePoints: 0 });
    const a5 = createPayApp(db, 'p1', { retainagePercent: 15 });
    expect(() => setPayApp(db, a5.id, { releasedRetainagePoints: 0.01 }))
      .toThrow(/only 0 remain/);
  });

  it('perLine mode: effective per-line rate = (line ?? base) − cumulative, clamped at 0', () => {
    setAiaSettings('p1', { retainageMode: 'perLine', retainagePercent: 15 });
    const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'A', scheduledValueCents: 10000000, retainagePercent: 15 });
    const { id: line2 } = createSovLine(db, 'p1', { itemNo: '2', description: 'B', scheduledValueCents: 5000000, retainagePercent: 4 });

    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
      { sovLineId: line2, percentComplete: 100, storedMaterialsCents: 0 },
    ], 1);

    // Remaining = MAX line rate − cumulative(prior) = max(15, 4) − 0 = 15.
    expect(remainingReleasablePoints(db, a1.id)).toBe(15);
    setPayApp(db, a1.id, { releasedRetainagePoints: 5 });

    const g703 = computeG703(db, a1.id);
    // line1: 15 − 5 = 10% of round(10000000*50/100)=5000000 → 500000
    expect(g703[0].retainageCents).toBe(500000);
    // line2: max(0, 4 − 5) = 0% of 5000000 → 0 (clamped, never negative retainage)
    expect(g703[1].retainageCents).toBe(0);

    const g702 = computeG702(db, a1.id);
    expect(g702.L5aRetainageWorkCents).toBe(500000);
    expect(g702.L4totalCompletedStoredCents).toBe(10000000); // 5000000 + 5000000
    expect(g702.L6earnedLessRetainageCents).toBe(9500000);
    expect(g702.retainage).toEqual({
      mode: 'perLine',
      baseWorkPercent: 15,
      cumulativeReleasedPoints: 5,
      releasedThisApp: 5,
      remainingPoints: 15,
      effectiveWorkPercent: null, // mixed rates — no single number to report
    });
  });

  it('uniform mode ignores stray per-line retainage values', () => {
    // The SOV toggle is authoritative, not leftover data in the column.
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 10 });
    const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'A', scheduledValueCents: 10000000, retainagePercent: 20 });

    const a1 = createPayApp(db, 'p1', { retainagePercent: 10 });
    savePayAppLines(db, a1.id, [{ sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 }], 1);

    // App base 10% on 5000000 → 500000. The stray 20% would give 1000000.
    expect(computeG703(db, a1.id)[0].retainageCents).toBe(500000);
    expect(computeG702(db, a1.id).L5aRetainageWorkCents).toBe(500000);
    expect(computeG702(db, a1.id).retainage.mode).toBe('uniform');
  });

  // The 3-state rule for aiaSettings.retainageMode (spec addendum): explicit
  // 'uniform' / explicit 'perLine' / ABSENT. Absent keeps today's math so no
  // historical app silently recomputes, and reports the mode its data implies.
  it('absent retainageMode + per-line data: legacy math, reported mode perLine', () => {
    setAiaSettings('p1', null); // no aiaSettings at all
    const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'A', scheduledValueCents: 10000000, retainagePercent: 20 });

    const a1 = createPayApp(db, 'p1', { retainagePercent: 10 });
    savePayAppLines(db, a1.id, [{ sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 }], 1);

    // Legacy math: the line rate wins → round(5000000 * 20/100) = 1000000.
    // Strict uniform would give 500000 and rewrite finalized history.
    expect(computeG703(db, a1.id)[0].retainageCents).toBe(1000000);
    const r = computeG702(db, a1.id).retainage;
    expect(r.mode).toBe('perLine');          // the data IS per-line
    expect(r.effectiveWorkPercent).toBeNull();
  });

  it('absent retainageMode + no per-line data: reported mode uniform, base rate applies', () => {
    setAiaSettings('p1', null);
    const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'A', scheduledValueCents: 10000000 });

    const a1 = createPayApp(db, 'p1', { retainagePercent: 10 });
    savePayAppLines(db, a1.id, [{ sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 }], 1);

    const r = computeG702(db, a1.id).retainage;
    expect(r.mode).toBe('uniform');
    expect(r.effectiveWorkPercent).toBe(10);
    expect(computeG703(db, a1.id)[0].retainageCents).toBe(500000); // app base 10%
  });

  it('perLine mode: blank lines fall back to the base rate', () => {
    setAiaSettings('p1', { retainageMode: 'perLine', retainagePercent: 10 });
    const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'A', scheduledValueCents: 10000000, retainagePercent: 20 });
    const { id: line2 } = createSovLine(db, 'p1', { itemNo: '2', description: 'B', scheduledValueCents: 10000000 }); // blank

    const a1 = createPayApp(db, 'p1', { retainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
      { sovLineId: line2, percentComplete: 50, storedMaterialsCents: 0 },
    ], 1);

    const g703 = computeG703(db, a1.id);
    expect(g703[0].retainageCents).toBe(1000000); // 20% of 5000000 — its own rate
    expect(g703[1].retainageCents).toBe(500000);  // 10% of 5000000 — base fallback
    // Remaining is bounded by the LARGEST relevant rate, not the base.
    expect(remainingReleasablePoints(db, a1.id)).toBe(20);
  });

  it('legacy two-rate app with zero releases computes exactly as before', () => {
    const line = setupOneLine(); // $100,000, no aiaSettings, no per-line rate
    // Distinct work/stored rates, the pre-rework shape.
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 5 });
    savePayAppLines(db, a1.id, [{ sovLineId: line, percentComplete: 50, storedMaterialsCents: 200000 }], 1);

    // completed = 5000000 ; L5a = round(5000000*10/100) = 500000
    // stored    =  200000 ; L5b = round( 200000* 5/100) =  10000
    const g703 = computeG703(db, a1.id);
    expect(g703[0].retainageCents).toBe(510000);
    const g702 = computeG702(db, a1.id);
    expect(g702.L4totalCompletedStoredCents).toBe(5200000);
    expect(g702.L5aRetainageWorkCents).toBe(500000);
    expect(g702.L5bRetainageStoredCents).toBe(10000);
    expect(g702.L5retainageCents).toBe(510000);
    expect(g702.L6earnedLessRetainageCents).toBe(4690000);
    expect(g702.L8currentPaymentDueCents).toBe(4690000);
    expect(g702.retainage).toEqual({
      mode: 'uniform',
      baseWorkPercent: 10,
      cumulativeReleasedPoints: 0,
      releasedThisApp: 0,
      remainingPoints: 10,
      effectiveWorkPercent: 10,
    });
  });

  it('releases apply to stored-materials retainage at the same single rate on new apps', () => {
    setAiaSettings('p1', { retainageMode: 'uniform', retainagePercent: 15 });
    const line = setupOneLine();
    // Single-rate world: stored rate is written equal to the work rate.
    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 });
    savePayAppLines(db, a1.id, [{ sovLineId: line, percentComplete: 50, storedMaterialsCents: 200000 }], 1);
    setPayApp(db, a1.id, { releasedRetainagePoints: 5 });

    // Both rates drop to 10%: L5a = round(5000000*10/100) = 500000,
    //                        L5b = round( 200000*10/100) =  20000
    const g702 = computeG702(db, a1.id);
    expect(g702.L5aRetainageWorkCents).toBe(500000);
    expect(g702.L5bRetainageStoredCents).toBe(20000);
    expect(g702.L5retainageCents).toBe(520000);
    expect(computeG703(db, a1.id)[0].retainageCents).toBe(520000);
  });

  it('createPayApp with single-rate settings writes storedRetainagePercent = retainagePercent', () => {
    setupOneLine();
    const a1 = createPayApp(db, 'p1', { retainagePercent: 15 }); // no storedRetainagePercent sent
    const app1 = getPayApp(db, a1.id)!;
    expect(app1.retainagePercent).toBe(15);
    expect(app1.storedRetainagePercent).toBe(15);
    expect(app1.releasedRetainagePoints).toBe(0); // new apps hold nothing released

    // An explicit distinct stored rate is still honoured (legacy callers).
    const a2 = createPayApp(db, 'p1', { retainagePercent: 15, storedRetainagePercent: 5 });
    expect(getPayApp(db, a2.id)!.storedRetainagePercent).toBe(5);

    // Neither sent → both fall back to DEFAULT_RETAINAGE (10), as before.
    const a3 = createPayApp(db, 'p1', {});
    expect(getPayApp(db, a3.id)!.retainagePercent).toBe(10);
    expect(getPayApp(db, a3.id)!.storedRetainagePercent).toBe(10);
  });
});

describe('pay app updatedAt stamping', () => {
  it('savePayAppLines and setPayApp bump updatedAt', async () => {
    const { id: sov1 } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(db, 'p1', {});
    const before = (getPayApp(db, app.id) as any).updatedAt;
    expect(typeof before).toBe('number');
    await new Promise(r => setTimeout(r, 2));
    savePayAppLines(db, app.id, [{ sovLineId: sov1, percentComplete: 10, storedMaterialsCents: 0 }], 1);
    const afterLines = (getPayApp(db, app.id) as any).updatedAt;
    expect(afterLines).toBeGreaterThan(before);
    await new Promise(r => setTimeout(r, 2));
    setPayApp(db, app.id, { status: 'finalized' });
    expect((getPayApp(db, app.id) as any).updatedAt).toBeGreaterThan(afterLines);
  });
});

// ---------------------------------------------------------------------------
// updatedAt stamping — every pay app's G702/G703 is computed from the project's
// SOV, so a SOV edit makes each stored pay-app Excel stale even though no
// aia_pay_apps row was touched. updatedAt is what the "up to date" chip on the
// generated document compares against.
// ---------------------------------------------------------------------------
describe('SOV edits stamp the project pay apps', () => {
  const stampOf = (id: string) => (db.prepare('SELECT updatedAt FROM aia_pay_apps WHERE id = ?').get(id) as any).updatedAt;
  const reset = (id: string) => db.prepare('UPDATE aia_pay_apps SET updatedAt = 1 WHERE id = ?').run(id);

  it('createSovLine, saveSovLine, deleteSovLine and seedSovLines each stamp them', () => {
    const app = createPayApp(db, 'p1', {});
    const other = createPayApp(db, 'p2', {});
    unlockSov(db, 'p1');

    reset(app.id); reset(other.id);
    const { id: lineId } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    expect(stampOf(app.id)).toBeGreaterThan(1);
    // Another project's applications are untouched.
    expect(stampOf(other.id)).toBe(1);

    reset(app.id);
    saveSovLine(db, lineId, { description: 'Framing', scheduledValueCents: 200000, version: 1 });
    expect(stampOf(app.id)).toBeGreaterThan(1);

    reset(app.id);
    seedSovLines(db, 'p1', [{ description: 'Seeded', scheduledValueCents: 5000 }]);
    expect(stampOf(app.id)).toBeGreaterThan(1);

    reset(app.id);
    deleteSovLine(db, listSovLines(db, 'p1')[0].id);
    expect(stampOf(app.id)).toBeGreaterThan(1);
  });

  it('syncChangeOrders stamps only when it actually adds a line', () => {
    const app = createPayApp(db, 'p1', {});
    insertChangeOrder('co1', 'p1', '1', 'Extra work', 1000, 'approved');

    reset(app.id);
    expect(syncChangeOrders(db, 'p1').added).toBe(1);
    expect(stampOf(app.id)).toBeGreaterThan(1);

    // Idempotent re-run adds nothing, so nothing goes stale.
    reset(app.id);
    expect(syncChangeOrders(db, 'p1').added).toBe(0);
    expect(stampOf(app.id)).toBe(1);
  });

  it('savePayAppLines stamps the later applications too — their "less previous certificates" moved', () => {
    const { id: sov } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    const a1 = createPayApp(db, 'p1', {});
    const a2 = createPayApp(db, 'p1', {});
    const a3 = createPayApp(db, 'p1', {});
    reset(a1.id); reset(a2.id); reset(a3.id);

    savePayAppLines(db, a2.id, [{ sovLineId: sov, percentComplete: 50, storedMaterialsCents: 0 }], 1);

    expect(stampOf(a2.id)).toBeGreaterThan(1);
    expect(stampOf(a3.id)).toBeGreaterThan(1);
    // Earlier applications are already certified against their own period —
    // nothing about #1 changed.
    expect(stampOf(a1.id)).toBe(1);
  });
});

describe('SOV lock', () => {
  it('lockSov / getSovLock / unlockSov round-trip; lock is idempotent and keeps the first cause', () => {
    expect(getSovLock(db, 'p1')).toBeNull();
    const first = lockSov(db, 'p1', { userId: 'u1', reason: 'manual' });
    expect(first.reason).toBe('manual');
    expect(first.lockedByUserId).toBe('u1');
    const again = lockSov(db, 'p1', { userId: null, reason: 'pay-app' });
    expect(again.reason).toBe('manual'); // untouched
    expect(getSovLock(db, 'p1')!.lockedAt).toBe(first.lockedAt);
    unlockSov(db, 'p1');
    expect(getSovLock(db, 'p1')).toBeNull();
  });

  it('lockSov rejects an unknown project', () => {
    expect(() => lockSov(db, 'nope', { userId: null, reason: 'manual' })).toThrow(NotFoundError);
  });

  it('every SOV mutator throws SovLockedError while locked; sync of approved COs still appends', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    lockSov(db, 'p1', { userId: 'u1', reason: 'manual' });
    expect(() => assertSovEditable(db, 'p1')).toThrow(SovLockedError);
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 1 })).toThrow(SovLockedError);
    expect(() => saveSovLine(db, id, { description: 'Y', scheduledValueCents: 2, version: 1 })).toThrow(SovLockedError);
    expect(() => deleteSovLine(db, id)).toThrow(SovLockedError);
    expect(() => seedSovLines(db, 'p1', [{ description: 'Z', scheduledValueCents: 3 }])).toThrow(SovLockedError);
    // nothing changed
    expect(listSovLines(db, 'p1').map(l => l.description)).toEqual(['Framing']);
    insertChangeOrder('co1', 'p1', '1', 'Extra', 250, 'approved');
    expect(syncChangeOrders(db, 'p1').added).toBe(1);
    expect(listSovLines(db, 'p1').length).toBe(2);
  });

  it('unlock stamps the project pay apps so exports read out of date', () => {
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    const { id: appId } = createPayApp(db, 'p1', {});
    const before = (db.prepare('SELECT updatedAt FROM aia_pay_apps WHERE id = ?').get(appId) as any).updatedAt;
    db.prepare('UPDATE aia_pay_apps SET updatedAt = ? WHERE id = ?').run(before - 10_000, appId);
    unlockSov(db, 'p1');
    const after = (db.prepare('SELECT updatedAt FROM aia_pay_apps WHERE id = ?').get(appId) as any).updatedAt;
    expect(after).toBeGreaterThan(before - 10_000);
  });

  it('creating the first pay application locks the SOV with reason pay-app, and does not overwrite a manual lock', () => {
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    expect(getSovLock(db, 'p1')).toBeNull();
    createPayApp(db, 'p1', {});
    expect(getSovLock(db, 'p1')!.reason).toBe('pay-app');
    expect(getSovLock(db, 'p1')!.lockedByUserId).toBeNull();

    createSovLine(db, 'p2', { description: 'Roof', scheduledValueCents: 500 });
    lockSov(db, 'p2', { userId: 'u9', reason: 'manual' });
    createPayApp(db, 'p2', {});
    expect(getSovLock(db, 'p2')!.reason).toBe('manual');
    expect(getSovLock(db, 'p2')!.lockedByUserId).toBe('u9');
  });
});

describe('SOV ordering', () => {
  const descs = () => listSovLines(db, 'p1').map(l => l.description);

  it('reorderSovLines assigns 0..n-1 in the given order and keeps CO lines after the contract block', () => {
    const a = createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 }).id;
    const b = createSovLine(db, 'p1', { description: 'B', scheduledValueCents: 1 }).id;
    insertChangeOrder('co1', 'p1', '1', 'Extra', 10, 'approved');
    syncChangeOrders(db, 'p1');
    const c = createSovLine(db, 'p1', { description: 'C', scheduledValueCents: 1 }).id;
    reorderSovLines(db, 'p1', [c, a, b]);
    expect(descs()).toEqual(['C', 'A', 'B', 'Extra']);
    expect(listSovLines(db, 'p1').map(l => l.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('reorderSovLines rejects a partial, duplicate, or foreign id list', () => {
    const a = createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 }).id;
    const b = createSovLine(db, 'p1', { description: 'B', scheduledValueCents: 1 }).id;
    const other = createSovLine(db, 'p2', { description: 'Z', scheduledValueCents: 1 }).id;
    expect(() => reorderSovLines(db, 'p1', [a])).toThrow(ValidationError);
    expect(() => reorderSovLines(db, 'p1', [a, a, b])).toThrow(ValidationError);
    expect(() => reorderSovLines(db, 'p1', [a, other])).toThrow(ValidationError);
    expect(descs()).toEqual(['A', 'B']);
  });

  it('reorderSovLines is refused while locked', () => {
    const a = createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 }).id;
    lockSov(db, 'p1', { userId: null, reason: 'manual' });
    expect(() => reorderSovLines(db, 'p1', [a])).toThrow(SovLockedError);
  });

  it('createSovLine with insertBeforeId places the new line in front of the target and shifts the rest', () => {
    createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 });
    const b = createSovLine(db, 'p1', { description: 'B', scheduledValueCents: 1 }).id;
    createSovLine(db, 'p1', { description: 'C', scheduledValueCents: 1 });
    createSovLine(db, 'p1', { lineType: 'header', description: 'Section', insertBeforeId: b });
    expect(descs()).toEqual(['A', 'Section', 'B', 'C']);
  });

  it('createSovLine rejects insertBeforeId that is a CO line or belongs to another project', () => {
    insertChangeOrder('co1', 'p1', '1', 'Extra', 10, 'approved');
    syncChangeOrders(db, 'p1');
    const co = listSovLines(db, 'p1')[0].id;
    const other = createSovLine(db, 'p2', { description: 'Z', scheduledValueCents: 1 }).id;
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 1, insertBeforeId: co })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 1, insertBeforeId: other })).toThrow(ValidationError);
  });
});

describe('SOV line types (header / blank)', () => {
  it('creates a header with zero value and null retainage; rejects money on a header or blank', () => {
    const { id } = createSovLine(db, 'p1', { lineType: 'header', description: 'Drywall', itemNo: '5' });
    const h = getSovLine(db, id)!;
    expect(h.lineType).toBe('header');
    expect(h.scheduledValueCents).toBe(0);
    expect(h.retainagePercent).toBeNull();
    expect(h.itemNo).toBe('5');
    expect(() => createSovLine(db, 'p1', { lineType: 'header', description: 'H', scheduledValueCents: 100 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'header', description: 'H', retainagePercent: 5 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'header', description: '   ' })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'blank', scheduledValueCents: 1 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'bogus' as any, description: 'x', scheduledValueCents: 0 })).toThrow(ValidationError);
  });

  it('creates a blank with empty fields; default lineType is item', () => {
    const { id } = createSovLine(db, 'p1', { lineType: 'blank' });
    const b = getSovLine(db, id)!;
    expect(b.lineType).toBe('blank');
    expect(b.description).toBe('');
    expect(b.itemNo).toBeNull();
    expect(b.scheduledValueCents).toBe(0);
    const { id: itemId } = createSovLine(db, 'p1', { description: 'Item', scheduledValueCents: 10 });
    expect(getSovLine(db, itemId)!.lineType).toBe('item');
  });

  it('saveSovLine keeps the type when omitted, can convert item → header (value dropped to 0 only if sent as 0)', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    saveSovLine(db, id, { description: 'Framing', scheduledValueCents: 2000, version: 1 });
    expect(getSovLine(db, id)!.lineType).toBe('item');
    expect(() => saveSovLine(db, id, { lineType: 'header', description: 'Framing', scheduledValueCents: 2000, version: 2 })).toThrow(ValidationError);
    saveSovLine(db, id, { lineType: 'header', description: 'Framing', scheduledValueCents: 0, version: 2 });
    const h = getSovLine(db, id)!;
    expect(h.lineType).toBe('header');
    expect(h.scheduledValueCents).toBe(0);
  });

  it('header and blank rows stay in position in G703 with zero money, and every G702 line is unchanged by them', () => {
    createSovLine(db, 'p1', { itemNo: '1', description: 'Mobilization', scheduledValueCents: 100000 });
    createSovLine(db, 'p1', { lineType: 'header', description: 'Interior' });
    createSovLine(db, 'p1', { itemNo: '2', description: 'Framing', scheduledValueCents: 500000 });
    createSovLine(db, 'p1', { lineType: 'blank' });
    const { id: appId } = createPayApp(db, 'p1', { retainagePercent: 10 });
    const app = getPayApp(db, appId)!;
    // pay-app lines are seeded for items only
    expect(app.lines.length).toBe(2);
    const items = listSovLines(db, 'p1').filter(l => l.lineType === 'item');
    savePayAppLines(db, appId, [
      { sovLineId: items[0].id, percentComplete: 100, storedMaterialsCents: 0 },
      { sovLineId: items[1].id, percentComplete: 50, storedMaterialsCents: 20000 },
    ], 1);
    const g703 = computeG703(db, appId);
    expect(g703.map(r => r.lineType)).toEqual(['item', 'header', 'item', 'blank']);
    expect(g703[1].description).toBe('Interior');
    expect(g703[1].scheduledValueCents).toBe(0);
    expect(g703[1].totalToDateCents).toBe(0);
    expect(g703[1].retainageCents).toBe(0);
    const g702 = computeG702(db, appId);
    expect(g702.L1originalContractCents).toBe(600000);
    expect(g702.L4totalCompletedStoredCents).toBe(100000 + 250000 + 20000);
    expect(g702.L5aRetainageWorkCents).toBe(10000 + 25000);
    expect(g702.L5bRetainageStoredCents).toBe(2000);
  });

  it('savePayAppLines ignores input for non-item lines', () => {
    createSovLine(db, 'p1', { itemNo: '1', description: 'Work', scheduledValueCents: 100000 });
    const { id: headerId } = createSovLine(db, 'p1', { lineType: 'header', description: 'H' });
    const { id: appId } = createPayApp(db, 'p1', {});
    savePayAppLines(db, appId, [{ sovLineId: headerId, percentComplete: 100, storedMaterialsCents: 5 }], 1);
    expect(db.prepare('SELECT COUNT(*) c FROM aia_pay_app_lines WHERE payAppId = ? AND sovLineId = ?').get(appId, headerId)).toEqual({ c: 0 });
    expect(computeG702(db, appId).L4totalCompletedStoredCents).toBe(0);
  });
});

describe('splitSovLine', () => {
  it('60/40 of $10,000.00 → header + $6,000.00 + $4,000.00, item numbers 5.1/5.2, retainage copied, later lines shifted', () => {
    const { id } = createSovLine(db, 'p1', { itemNo: '5', description: 'Drywall', scheduledValueCents: 1000000, retainagePercent: 5 });
    createSovLine(db, 'p1', { itemNo: '6', description: 'Paint', scheduledValueCents: 100 });
    const r = splitSovLine(db, id, { version: 1, parts: [{ description: 'Level 1', percent: 60 }, { description: 'Level 2', percent: 40 }] });
    expect(r.headerId).toBe(id);
    expect(r.childIds.length).toBe(2);
    const lines = listSovLines(db, 'p1');
    expect(lines.map(l => [l.description, l.lineType, l.scheduledValueCents, l.itemNo])).toEqual([
      ['Drywall', 'header', 0, '5'],
      ['Level 1', 'item', 600000, '5.1'],
      ['Level 2', 'item', 400000, '5.2'],
      ['Paint', 'item', 100, '6'],
    ]);
    expect(lines.map(l => l.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(lines[0].retainagePercent).toBeNull();
    expect(lines[1].retainagePercent).toBe(5);
    expect(lines[2].retainagePercent).toBe(5);
    expect(lines[0].version).toBe(2);
  });

  it('three-way split of $100.01 gives 33.34 / 33.33 / 33.34 — the last child absorbs the remainder', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Odd', scheduledValueCents: 10001 });
    splitSovLine(db, id, { version: 1, parts: [
      { description: 'a', percent: 33.34 }, { description: 'b', percent: 33.33 }, { description: 'c', percent: 33.33 },
    ] });
    const cents = listSovLines(db, 'p1').filter(l => l.lineType === 'item').map(l => l.scheduledValueCents);
    expect(cents).toEqual([3334, 3333, 3334]);
    expect(cents.reduce((a, b) => a + b, 0)).toBe(10001);
  });

  it('no item number on the parent → children have none', () => {
    const { id } = createSovLine(db, 'p1', { description: 'NoNo', scheduledValueCents: 100 });
    splitSovLine(db, id, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] });
    expect(listSovLines(db, 'p1').map(l => l.itemNo)).toEqual([null, null, null]);
  });

  it('rejects: percents not 100, one part, empty description, non-positive percent', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100 });
    const bad = (parts: any[]) => expect(() => splitSovLine(db, id, { version: 1, parts })).toThrow(ValidationError);
    bad([{ description: 'a', percent: 60 }, { description: 'b', percent: 39.99 }]);
    bad([{ description: 'a', percent: 60 }, { description: 'b', percent: 40.01 }]);
    bad([{ description: 'a', percent: 100 }]);
    bad([{ description: '', percent: 50 }, { description: 'b', percent: 50 }]);
    bad([{ description: 'a', percent: 0 }, { description: 'b', percent: 100 }]);
    expect(listSovLines(db, 'p1').length).toBe(1);
  });

  it('rejects: header target, CO target, stale version, locked SOV', () => {
    const { id: h } = createSovLine(db, 'p1', { lineType: 'header', description: 'H' });
    expect(() => splitSovLine(db, h, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(ValidationError);
    insertChangeOrder('co1', 'p1', '1', 'Extra', 10, 'approved');
    syncChangeOrders(db, 'p1');
    const co = listSovLines(db, 'p1').find(l => l.isChangeOrder)!.id;
    expect(() => splitSovLine(db, co, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(ValidationError);
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100 });
    expect(() => splitSovLine(db, id, { version: 7, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(ConflictError);
    lockSov(db, 'p1', { userId: null, reason: 'manual' });
    expect(() => splitSovLine(db, id, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(SovLockedError);
    expect(() => splitSovLine(db, 'missing', { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(NotFoundError);
  });
});
