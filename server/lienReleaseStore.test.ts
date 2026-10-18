// server/lienReleaseStore.test.ts — spec docs/superpowers/specs/2026-10-15-florida-lien-release-design.md §5, §9
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { createSovLine, createPayApp, savePayAppLines, setPayApp } from './aiaStore';
import { createInvoice, recordPayment } from './billingStore';
import { projectDataSummary } from './projectStore';
import { applySendEffects } from './mail/itemSendEffects';
import { resolveChain, resolveLinkLabel } from './mail/links';
import {
  createLienRelease, getLienRelease, listLienReleases, saveLienRelease, setLienReleaseStatus, deleteLienRelease,
  makeUnconditional, prefillLienRelease, lienReleaseSendDefaults,
  ValidationError, ConflictError, NotFoundError, LockedError,
  type LienReleaseInput,
} from './lienReleaseStore';

let db: Database.Database;

const valid = (over: LienReleaseInput = {}): LienReleaseInput => ({
  paymentType: 'progress', conditional: false,
  lienorName: 'Birchwood Plaster', customerName: 'Acme Builders', ownerName: 'Jane Owner',
  propertyDescription: 'Lot 4, 12 Palm Way\nTampa, FL', amountCents: 1234567,
  throughDate: '2026-09-30', releaseDate: '2026-10-15', signerName: 'Noah', signerTitle: 'Owner',
  ...over,
});

const dollars = (cents: number) => cents / 100;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-lien-')), migrations);
  db.prepare('INSERT INTO projects (id, name, address, contractor, meta, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('p1', 'Palm Way Stucco', '12 Palm Way, Tampa', 'Acme Builders', JSON.stringify({ aiaSettings: { ownerName: 'Jane Owner' } }), 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Other', 1);
  db.prepare("INSERT INTO settings (key, value) VALUES ('companyName', 'Birchwood Plaster LLC')").run();
});

describe('create / numbering', () => {
  it('numbers per project from 1 and reads back the stored values', () => {
    const a = createLienRelease(db, 'p1', valid());
    const b = createLienRelease(db, 'p1', valid());
    const other = createLienRelease(db, 'p2', valid());
    expect([a.number, b.number, other.number]).toEqual(['1', '2', '1']);
    const row = getLienRelease(db, a.id)!;
    expect(row).toMatchObject({
      projectId: 'p1', paymentType: 'progress', conditional: false, status: 'draft', version: 1,
      amountCents: 1234567, throughDate: '2026-09-30', releaseDate: '2026-10-15', conditionKind: null,
    });
    expect(listLienReleases(db, 'p1').map(r => r.number)).toEqual(['2', '1']);
  });

  it('keeps counting past a deleted release, using the highest number in use', () => {
    createLienRelease(db, 'p1', valid());
    const b = createLienRelease(db, 'p1', valid());
    deleteLienRelease(db, b.id);
    expect(createLienRelease(db, 'p1', valid()).number).toBe('2');
  });

  it('refuses an unknown project', () => {
    expect(() => createLienRelease(db, 'nope', valid())).toThrow(NotFoundError);
  });
});

describe('validation (spec §5.4)', () => {
  const bad = (over: LienReleaseInput, msg: RegExp) =>
    expect(() => createLienRelease(db, 'p1', valid(over))).toThrow(msg);

  it('rejects a through date after the release date (no advance waivers, 713.20(2))', () => {
    bad({ throughDate: '2026-10-16' }, /Through date cannot be after the release date/);
  });
  it('accepts a through date equal to the release date', () => {
    expect(() => createLienRelease(db, 'p1', valid({ throughDate: '2026-10-15' }))).not.toThrow();
  });
  it('requires a through date on a progress release', () => {
    bad({ throughDate: null }, /Through date is required/);
  });
  it('stores a final release with no through date', () => {
    const { id } = createLienRelease(db, 'p1', valid({ paymentType: 'final', throughDate: '2026-09-01' }));
    expect(getLienRelease(db, id)!.throughDate).toBeNull();
  });
  it('rejects a bad payment type, a zero or fractional amount, and missing required text', () => {
    bad({ paymentType: 'partial' }, /paymentType/);
    bad({ amountCents: 0 }, /Amount/);
    bad({ amountCents: 10.5 }, /Amount/);
    bad({ lienorName: '  ' }, /Lienor/);
    bad({ customerName: '' }, /Customer/);
    bad({ ownerName: '' }, /Owner/);
    bad({ propertyDescription: '' }, /Property/);
    bad({ signerName: '' }, /Signer/);
    bad({ releaseDate: '10/15/2026' }, /Release date/);
  });
  it('needs a check number and maker for a check condition', () => {
    bad({ conditional: true, conditionKind: 'check', checkNumber: '' }, /Check number/);
    bad({ conditional: true, conditionKind: 'check', checkNumber: '1042', checkMaker: '' }, /drawn-by/);
  });
  it('turns a check number into the check condition, and funds otherwise', () => {
    const a = createLienRelease(db, 'p1', valid({ conditional: true, checkNumber: '1042', checkMaker: 'Acme Builders', checkBank: 'First Bank' }));
    expect(getLienRelease(db, a.id)).toMatchObject({ conditional: true, conditionKind: 'check', checkNumber: '1042', checkBank: 'First Bank' });
    const b = createLienRelease(db, 'p1', valid({ conditional: true }));
    expect(getLienRelease(db, b.id)).toMatchObject({ conditionKind: 'funds', checkNumber: null });
  });
  it('clears the condition and check fields on an unconditional release and on a funds condition', () => {
    const a = createLienRelease(db, 'p1', valid({ conditional: false, conditionKind: 'check', checkNumber: '9', checkMaker: 'X' }));
    expect(getLienRelease(db, a.id)).toMatchObject({ conditionKind: null, checkNumber: null, checkMaker: null, checkBank: null });
    const b = createLienRelease(db, 'p1', valid({ conditional: true, conditionKind: 'funds', checkNumber: '9', checkMaker: 'X' }));
    expect(getLienRelease(db, b.id)).toMatchObject({ conditionKind: 'funds', checkNumber: null, checkMaker: null });
  });
  it('treats blank exceptions as none', () => {
    const { id } = createLienRelease(db, 'p1', valid({ exceptions: '   ' }));
    expect(getLienRelease(db, id)!.exceptions).toBeNull();
  });
  it('refuses a source that is on another project', () => {
    db.prepare("INSERT INTO invoices (id, projectId, number, status, version, createdAt) VALUES ('i2', 'p2', '1', 'draft', 1, 1)").run();
    bad({ sourceType: 'invoice', sourceId: 'i2' }, /not on this project/);
    bad({ sourceType: 'invoice', sourceId: null }, /go together/);
  });
});

describe('save / concurrency', () => {
  it('saves with the current version and bumps it; a stale version is a conflict', () => {
    const { id } = createLienRelease(db, 'p1', valid());
    expect(saveLienRelease(db, id, { ...valid({ amountCents: 5000 }), version: 1 })).toEqual({ version: 2 });
    expect(getLienRelease(db, id)).toMatchObject({ amountCents: 5000, version: 2 });
    expect(() => saveLienRelease(db, id, { ...valid(), version: 1 })).toThrow(ConflictError);
  });
  it('needs a version, and validates on save too', () => {
    const { id } = createLienRelease(db, 'p1', valid());
    expect(() => saveLienRelease(db, id, valid())).toThrow(ValidationError);
    expect(() => saveLienRelease(db, id, { ...valid({ throughDate: '2027-01-01' }), version: 1 })).toThrow(/Through date/);
    expect(() => saveLienRelease(db, 'nope', { ...valid(), version: 1 })).toThrow(NotFoundError);
  });
});

describe('status, void and delete (spec §6.5)', () => {
  it('deletes a draft', () => {
    const { id } = createLienRelease(db, 'p1', valid());
    deleteLienRelease(db, id);
    expect(getLienRelease(db, id)).toBeNull();
  });
  it('refuses to delete a sent or voided release', () => {
    const a = createLienRelease(db, 'p1', valid());
    setLienReleaseStatus(db, a.id, 'sent');
    expect(() => deleteLienRelease(db, a.id)).toThrow(LockedError);
    setLienReleaseStatus(db, a.id, 'void');
    expect(() => deleteLienRelease(db, a.id)).toThrow(LockedError);
    expect(getLienRelease(db, a.id)!.status).toBe('void');
  });
  it('does not touch updatedAt or version when the status is unchanged', () => {
    const { id } = createLienRelease(db, 'p1', valid());
    setLienReleaseStatus(db, id, 'sent');
    const before = getLienRelease(db, id)!;
    expect(setLienReleaseStatus(db, id, 'sent')).toEqual({ status: 'sent', version: before.version });
    expect(getLienRelease(db, id)!.updatedAt).toBe(before.updatedAt);
  });
  it('rejects an unknown status', () => {
    const { id } = createLienRelease(db, 'p1', valid());
    expect(() => setLienReleaseStatus(db, id, 'paid')).toThrow(ValidationError);
  });
});

// A $100,000 contract, 50% complete at 10% retainage: G702 line 8 is $45,000.
function seedPayApp(): string {
  createSovLine(db, 'p1', { itemNo: '1', description: 'Stucco', scheduledValueCents: 10000000 });
  const sov = (db.prepare("SELECT id FROM aia_sov_lines WHERE projectId = 'p1'").get() as { id: string }).id;
  const app = createPayApp(db, 'p1', { periodTo: '2026-09-30', applicationDate: '2026-10-01', retainagePercent: 10 });
  savePayAppLines(db, app.id, [{ sovLineId: sov, percentComplete: 50, storedMaterialsCents: 0 }], 1);
  setPayApp(db, app.id, { status: 'submitted' } as any);
  return app.id;
}

describe('prefill (spec §5.3)', () => {
  const user = { id: 'u1', username: 'Noah' };

  it('fills the names from settings, the project and the AIA settings', () => {
    const p = prefillLienRelease(db, 'p1', { paymentType: 'final', conditional: true }, user);
    expect(p).toMatchObject({
      lienorName: 'Birchwood Plaster LLC', customerName: 'Acme Builders', ownerName: 'Palm Way Stucco',
      propertyDescription: 'Palm Way Stucco\n12 Palm Way, Tampa', signerName: 'Noah',
      throughDate: null, conditionKind: 'funds', checkMaker: 'Acme Builders', source: null,
    });
    expect(p.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('prefills the lienor from the legal name, entity type and state in settings', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('companyLegalName', 'Birchwood Plaster, LLC')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('companyEntityType', 'llc')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('companyStateOfFormation', 'Florida')").run();
    expect(prefillLienRelease(db, 'p1', {}, user)).toMatchObject({
      lienorName: 'Birchwood Plaster, LLC', lienorEntityType: 'llc', lienorState: 'Florida',
    });
    db.prepare("UPDATE settings SET value = 'bogus' WHERE key = 'companyEntityType'").run();
    expect(prefillLienRelease(db, 'p1', {}, user).lienorEntityType).toBeNull();
  });

  it('stores its own copy of the entity type and state, and rejects an unknown entity type', () => {
    const { id } = createLienRelease(db, 'p1', valid({ lienorEntityType: 'corporation', lienorState: ' Florida ' }), 'u1');
    expect(getLienRelease(db, id)).toMatchObject({ lienorEntityType: 'corporation', lienorState: 'Florida' });
    const { id: id2 } = createLienRelease(db, 'p1', valid(), 'u1');
    expect(getLienRelease(db, id2)).toMatchObject({ lienorEntityType: null, lienorState: null });
    expect(() => createLienRelease(db, 'p1', valid({ lienorEntityType: 'club' }), 'u1')).toThrow(/Entity type/);
  });

  it('falls back to the app name, and to the customer record, when the settings are missing', () => {
    db.prepare("DELETE FROM settings WHERE key = 'companyName'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('appName', 'FrugalOmnibuild')").run();
    db.prepare("UPDATE projects SET contractor = NULL, customerId = 'c1' WHERE id = 'p1'").run();
    db.prepare("INSERT INTO customers (id, name, createdAt, updatedAt) VALUES ('c1', 'Customer Co', 1, 1)").run();
    const p = prefillLienRelease(db, 'p1', {}, user);
    expect(p).toMatchObject({ lienorName: 'FrugalOmnibuild', customerName: 'Customer Co' });
  });

  it('uses the project name as the owner, ahead of the AIA owner', () => {
    expect(prefillLienRelease(db, 'p1', {}, user).ownerName).toBe('Palm Way Stucco');
    db.prepare("UPDATE projects SET meta = '{}' WHERE id = 'p1'").run();
    expect(prefillLienRelease(db, 'p1', {}, user).ownerName).toBe('Palm Way Stucco');
  });

  it('reuses the owner, property and signer title of the last release on the project', () => {
    db.prepare("UPDATE projects SET meta = '{}' WHERE id = 'p1'").run();
    createLienRelease(db, 'p1', valid({ ownerName: 'Prior Owner', propertyDescription: 'Lot 9', signerTitle: 'President' }), 'u1');
    const p = prefillLienRelease(db, 'p1', {}, user);
    expect(p).toMatchObject({ ownerName: 'Palm Way Stucco', propertyDescription: 'Lot 9', signerTitle: 'President' });
  });

  it('conditional from a pay app: the amount still due, through the period end', () => {
    const id = seedPayApp();
    recordPayment(db, 'payapp', id, { amount: dollars(2000000), date: Date.UTC(2026, 9, 5) });
    const p = prefillLienRelease(db, 'p1', { sourceType: 'payapp', sourceId: id, conditional: true }, user);
    expect(p.amountCents).toBe(2500000);
    expect(p.throughDate).toBe('2026-09-30');
    expect(p.source).toMatchObject({ label: 'Pay App #1', totalCents: 4500000, paidCents: 2000000, balanceCents: 2500000, contractSumToDateCents: 10000000 });
    expect(p.warnings).toEqual([]);
  });

  it('unconditional from a pay app: the amount received', () => {
    const id = seedPayApp();
    recordPayment(db, 'payapp', id, { amount: dollars(1500000) });
    recordPayment(db, 'payapp', id, { amount: dollars(500000) });
    const p = prefillLienRelease(db, 'p1', { sourceType: 'payapp', sourceId: id, conditional: false }, user);
    expect(p.amountCents).toBe(2000000);
    expect(p.warnings).toEqual([]);
  });

  it('unconditional from a pay app with no payment: the billed amount and a warning', () => {
    const id = seedPayApp();
    const p = prefillLienRelease(db, 'p1', { sourceType: 'payapp', sourceId: id, conditional: false }, user);
    expect(p.amountCents).toBe(4500000);
    expect(p.warnings.join(' ')).toMatch(/No payment is recorded for Pay App #1/);
  });

  it('from an invoice: due or received, through the invoice date', () => {
    const inv = createInvoice(db, 'p1', { number: '1005', date: Date.UTC(2026, 8, 20), lines: [{ description: 'Work', qty: 2, unitPrice: 750 }] });
    recordPayment(db, 'invoice', inv.id, { amount: 500 });
    const due = prefillLienRelease(db, 'p1', { sourceType: 'invoice', sourceId: inv.id, conditional: true }, user);
    expect(due).toMatchObject({ amountCents: 100000, throughDate: '2026-09-20' });
    expect(due.source).toMatchObject({ label: 'Invoice 1005', totalCents: 150000, paidCents: 50000 });
    const got = prefillLienRelease(db, 'p1', { sourceType: 'invoice', sourceId: inv.id, conditional: false }, user);
    expect(got.amountCents).toBe(50000);
  });

  it('by hand: amount 0, through date today, and an unconditional warning', () => {
    const p = prefillLienRelease(db, 'p1', { conditional: false }, user);
    expect(p.amountCents).toBe(0);
    expect(p.throughDate).toBe(p.releaseDate);
    expect(p.warnings.length).toBe(1);
  });

  it('from a recorded payment: its amount, linked to its source, no warning', () => {
    const id = seedPayApp();
    const pay = recordPayment(db, 'payapp', id, { amount: dollars(1234567), date: Date.UTC(2026, 9, 6) });
    const p = prefillLienRelease(db, 'p1', { paymentId: pay.id, conditional: false }, user);
    expect(p).toMatchObject({ amountCents: 1234567, sourceType: 'payapp', sourceId: id, throughDate: '2026-09-30', warnings: [] });
  });

  it('from a payment with no pay app period: the payment date; never a future through date', () => {
    const inv = createInvoice(db, 'p1', { number: '7', lines: [{ description: 'x', qty: 1, unitPrice: 100 }] });
    const pay = recordPayment(db, 'invoice', inv.id, { amount: 100, date: Date.UTC(2020, 0, 2) });
    expect(prefillLienRelease(db, 'p1', { paymentId: pay.id, conditional: false }, user).throughDate).toBeTruthy();
    db.prepare('UPDATE invoices SET date = ? WHERE id = ?').run(Date.UTC(2099, 0, 1), inv.id);
    const p = prefillLienRelease(db, 'p1', { sourceType: 'invoice', sourceId: inv.id }, user);
    expect(p.throughDate).toBe(p.releaseDate);
  });

  it('refuses a pay app from another project, and an unknown payment', () => {
    const id = seedPayApp();
    expect(() => prefillLienRelease(db, 'p2', { sourceType: 'payapp', sourceId: id }, user)).toThrow(NotFoundError);
    expect(() => prefillLienRelease(db, 'p1', { paymentId: 'nope' }, user)).toThrow(NotFoundError);
    expect(() => prefillLienRelease(db, 'p1', { sourceType: 'payapp' }, user)).toThrow(ValidationError);
  });
});

describe('make unconditional (spec §6.4)', () => {
  it('copies the values into a new unconditional release that points back, leaving the original alone', () => {
    const a = createLienRelease(db, 'p1', valid({ conditional: true, checkNumber: '88', checkMaker: 'Acme', signatureFileId: 'sig1', exceptions: 'CO 3' }));
    const r = makeUnconditional(db, a.id);
    expect(r.number).toBe('2');
    const row = getLienRelease(db, r.id)!;
    expect(row).toMatchObject({
      conditional: false, supersedesId: a.id, conditionKind: null, checkNumber: null, status: 'draft',
      amountCents: 1234567, customerName: 'Acme Builders', exceptions: 'CO 3', signatureFileId: null,
    });
    expect(row.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getLienRelease(db, a.id)).toMatchObject({ conditional: true, status: 'draft', version: 1 });
  });

  it('refreshes the amount to the payments received when linked to a pay app', () => {
    const id = seedPayApp();
    const a = createLienRelease(db, 'p1', valid({ conditional: true, sourceType: 'payapp', sourceId: id, amountCents: 4500000 }));
    recordPayment(db, 'payapp', id, { amount: dollars(3000000) });
    expect(getLienRelease(db, makeUnconditional(db, a.id).id)!.amountCents).toBe(3000000);
  });

  it('keeps the amount when nothing was received, and refuses to make an unconditional one unconditional', () => {
    const a = createLienRelease(db, 'p1', valid({ conditional: true }));
    expect(getLienRelease(db, makeUnconditional(db, a.id).id)!.amountCents).toBe(1234567);
    expect(() => makeUnconditional(db, makeUnconditional(db, a.id).id)).toThrow(/already unconditional/);
    expect(() => makeUnconditional(db, 'nope')).toThrow(NotFoundError);
  });

  it('can be deleted as a draft without losing the conditional release', () => {
    const a = createLienRelease(db, 'p1', valid({ conditional: true }));
    const r = makeUnconditional(db, a.id);
    deleteLienRelease(db, r.id);
    expect(getLienRelease(db, a.id)).not.toBeNull();
  });
});

describe('around the store', () => {
  it('the project data guard counts releases', () => {
    createLienRelease(db, 'p1', valid());
    expect(projectDataSummary(db, 'p1').summary.lienReleases).toBe(1);
  });

  it('mail: resolveChain and the link label know lienRelease', () => {
    const { id } = createLienRelease(db, 'p1', valid());
    expect(resolveChain(db, 'lienRelease', id).projectId).toBe('p1');
    expect(resolveLinkLabel(db, 'lienRelease', id)).toBe('LR-1');
    expect(resolveLinkLabel(db, 'lienRelease', 'gone')).toBe('Lien Release');
  });

  it('a send marks a draft sent, leaves a voided one void, and is admin only', () => {
    const a = createLienRelease(db, 'p1', valid());
    const base = { itemType: 'lienRelease' as const, userId: 'u1', to: 'a@b.com', threadKey: 'k' };
    expect(applySendEffects(db, { ...base, itemId: a.id, role: 'user' })).toEqual({ applied: false, skipped: 'role' });
    const r = applySendEffects(db, { ...base, itemId: a.id, role: 'admin' });
    expect(r).toMatchObject({ applied: true, broadcast: { type: 'lienRelease', id: a.id, projectId: 'p1' } });
    expect(getLienRelease(db, a.id)!.status).toBe('sent');
    const b = createLienRelease(db, 'p1', valid());
    setLienReleaseStatus(db, b.id, 'void');
    applySendEffects(db, { ...base, itemId: b.id, role: 'admin' });
    expect(getLienRelease(db, b.id)!.status).toBe('void');
    expect(applySendEffects(db, { ...base, itemId: 'gone', role: 'admin' }).skipped).toBe('missing');
    expect((db.prepare("SELECT type FROM activity WHERE projectId = 'p1'").all() as any[]).map(x => x.type)).toContain('lien_release_sent');
  });

  it('send defaults follow the spec', () => {
    expect(lienReleaseSendDefaults({ paymentType: 'progress', conditional: true }, 'Job')).toEqual({
      subject: 'Conditional Waiver and Release of Lien upon Progress Payment — Job',
      body: 'Please find attached our conditional waiver and release of lien for Job.',
    });
    expect(lienReleaseSendDefaults({ paymentType: 'final', conditional: false }, 'Job').subject)
      .toBe('Waiver and Release of Lien upon Final Payment — Job');
  });

  it('migration 49 can run twice', () => {
    const m = migrations.find(x => x.version === 49)!;
    expect(() => m.up({ db, dataDir: os.tmpdir() })).not.toThrow();
  });
});
