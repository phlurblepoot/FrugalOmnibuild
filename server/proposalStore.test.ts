import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putBuffer } from './files';
import {
  createProposal, getProposal, listProposals, listOutstanding, saveProposal, deleteProposal,
  addPhoto, updatePhoto, removePhoto, addAttachment, removeAttachment, markSent, setStatus, setProposalFile,
  LockedError, ConflictError, ValidationError, NotFoundError,
} from './proposalStore';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-prop-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Job A', 1, 1, 1, '{}')`).run();
  db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p2', 'Job B', 1, 1, 1, '{}')`).run();
  db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t1', 'p1', 'Stucco', 'area', '#fff', 0, '{}')`).run();
  db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t2', 'p1', 'Trim', 'length', '#fff', 1, '{}')`).run();
});

const pdf = (id: string) => putBuffer(db, dir, id, Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'document', name: `${id}.pdf` });
const jpg = (id: string) => putBuffer(db, dir, id, Buffer.from('x'), 'image/jpeg', { projectId: 'p1', kind: 'proposal-photo', name: `${id}.jpg` });

describe('numbering + seeding', () => {
  it('numbers per project starting at 1 and seeds takeoff lines by name', () => {
    const a = createProposal(db, 'p1', { takeoffIds: ['t1', 't2'] });
    const b = createProposal(db, 'p1', {});
    const c = createProposal(db, 'p2', {});
    expect([a.number, b.number, c.number]).toEqual([1, 2, 1]);
    const full = getProposal(db, a.id)!;
    expect(full.lines.map(l => [l.kind, l.takeoffId, l.description, l.amountCents, l.derivedAmountCents])).toEqual([
      ['takeoff', 't1', 'Stucco', 0, null], ['takeoff', 't2', 'Trim', 0, null],
    ]);
    expect(full.status).toBe('draft');
    expect(full.showGrandTotal).toBe(true);
  });

  it('ignores takeoff ids that belong to another project', () => {
    db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t9', 'p2', 'Other', 'area', '#fff', 0, '{}')`).run();
    const a = createProposal(db, 'p1', { takeoffIds: ['t1', 't9'] });
    expect(getProposal(db, a.id)!.lines).toHaveLength(1);
  });

  it('numbers never reuse after a delete', () => {
    const a = createProposal(db, 'p1', {});
    const b = createProposal(db, 'p1', {});
    deleteProposal(db, b.id);
    expect(createProposal(db, 'p1', {}).number).toBe(3);
    void a;
  });
});

describe('save + lock', () => {
  it('replaces lines wholesale, bumps version, 409s stale saves', () => {
    const { id, version } = createProposal(db, 'p1', {});
    const r = saveProposal(db, id, {
      version, title: 'Bid', inclusions: ['a'], exclusions: ['b'], showGrandTotal: false,
      paymentSchedule: [{ description: '50% on start', percent: 50 }],
      lines: [
        { kind: 'takeoff', takeoffId: 't1', description: 'Stucco', amountCents: 420000, derivedAmountCents: 418700, measurementSummary: '4,120 sq ft', isAlternate: false },
        { kind: 'manual', description: 'Scaffold', amountCents: 350000 },
        { kind: 'manual', description: 'Color coat', amountCents: 220000, isAlternate: true },
      ],
    });
    expect(r.version).toBe(2);
    const p = getProposal(db, id)!;
    expect(p.title).toBe('Bid');
    expect(p.inclusions).toEqual(['a']);
    expect(p.paymentSchedule).toEqual([{ description: '50% on start', percent: 50, amountCents: null }]);
    expect(p.showGrandTotal).toBe(false);
    expect(p.lines.map(l => l.sortOrder)).toEqual([0, 1, 2]);
    expect(() => saveProposal(db, id, { version: 1, title: 'stale' })).toThrow(ConflictError);
    const s = listProposals(db, 'p1')[0];
    expect(s.totalCents).toBe(770000);
    expect(s.alternateCount).toBe(1);
    expect(s.hasOverride).toBe(true);
  });

  it('rejects non-integer cents and unknown kinds', () => {
    const { id, version } = createProposal(db, 'p1', {});
    expect(() => saveProposal(db, id, { version, lines: [{ kind: 'manual', description: 'x', amountCents: 1.5 }] })).toThrow(ValidationError);
    expect(() => saveProposal(db, id, { version, lines: [{ kind: 'weird' as any, description: 'x', amountCents: 1 }] })).toThrow(ValidationError);
  });

  it('locks after markSent: save/delete/photo/attachment all throw LockedError', () => {
    const { id, version } = createProposal(db, 'p1', {});
    pdf('gen'); setProposalFile(db, id, 'gen');
    markSent(db, id, { to: 'a@b.c', subject: 'Proposal' });
    const p = getProposal(db, id)!;
    expect(p.status).toBe('sent');
    expect(p.sentTo).toEqual({ to: 'a@b.c', cc: undefined, subject: 'Proposal' });
    expect(p.sentAt).toBeGreaterThan(0);
    expect(() => saveProposal(db, id, { version: p.version, title: 'x' })).toThrow(LockedError);
    expect(() => deleteProposal(db, id)).toThrow(LockedError);
    jpg('ph1');
    expect(() => addPhoto(db, id, 'ph1')).toThrow(LockedError);
    pdf('att1');
    expect(() => addAttachment(db, id, 'att1')).toThrow(LockedError);
    void version;
  });

  it('a save returns the new updatedAt with the new version', () => {
    // The editor adopts both: updatedAt is what the document bar compares a
    // generated PDF's createdAt against, so a client left on the pre-save
    // timestamp would keep calling a now-stale PDF current.
    const { id, version } = createProposal(db, 'p1', {});
    const before = getProposal(db, id)!;
    const r = saveProposal(db, id, { version, title: 'Priced' });
    const after = getProposal(db, id)!;
    expect(r.version).toBe(after.version);
    expect(r.updatedAt).toBe(after.updatedAt);
    expect(r.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('attaching the generated document leaves updatedAt alone', () => {
    // The editor's "is this PDF still current?" check compares the file's
    // createdAt against the proposal's updatedAt. Bumping updatedAt here would
    // mark every freshly generated PDF stale the instant it is attached.
    const { id } = createProposal(db, 'p1', {});
    const before = getProposal(db, id)!;
    pdf('gen');
    setProposalFile(db, id, 'gen');
    const after = getProposal(db, id)!;
    expect(after.fileId).toBe('gen');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.version).toBe(before.version);
  });

  it('legacy proposals are locked even while draft', () => {
    const { id } = createProposal(db, 'p1', {});
    db.prepare('UPDATE proposals SET legacy = 1 WHERE id = ?').run(id);
    const p = getProposal(db, id)!;
    expect(() => saveProposal(db, id, { version: p.version, title: 'x' })).toThrow(LockedError);
  });
});

describe('status transitions', () => {
  it('draft → sent → accepted with signed file; declined from sent; nothing else', () => {
    const { id } = createProposal(db, 'p1', {});
    expect(() => setStatus(db, id, 'accepted')).toThrow(ValidationError); // not sent yet
    pdf('gen'); setProposalFile(db, id, 'gen');
    markSent(db, id, { to: 'a@b.c', subject: 's' });
    expect(() => markSent(db, id, { to: 'a@b.c', subject: 's' })).toThrow(LockedError); // already sent
    pdf('signed');
    setStatus(db, id, 'accepted', 'signed');
    const p = getProposal(db, id)!;
    expect(p.status).toBe('accepted');
    expect(p.signedFileId).toBe('signed');
    expect(p.acceptedAt).toBeGreaterThan(0);
    expect(() => setStatus(db, id, 'declined')).toThrow(ValidationError); // accepted is terminal
  });

  // Sending doesn't change what the proposal SAYS, and a sent proposal is
  // locked — it can never regenerate its PDF. Stamping updatedAt here would
  // leave every sent proposal showing "PDF out of date" forever, so markSent
  // deliberately leaves that clock alone (same rule as setProposalFile).
  it('markSent records the send without stamping updatedAt', async () => {
    const { id } = createProposal(db, 'p1', {});
    pdf('gen-u'); setProposalFile(db, id, 'gen-u');
    const before = getProposal(db, id)! as any;
    await new Promise(r => setTimeout(r, 2));

    markSent(db, id, { to: 'a@b.c', subject: 's' });

    const after = getProposal(db, id)! as any;
    expect(after.status).toBe('sent');
    expect(after.sentAt).toBeGreaterThan(0);
    expect(after.version).toBe(before.version + 1); // collaborators still reload
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  // A legacy row (migration 28) is read-only history: Open PDF and Revise
  // only (spec §5). It can carry status 'sent', so the 'sent' check alone
  // wouldn't stop it.
  it('a legacy proposal cannot be accepted or declined even when its status is sent', () => {
    const { id } = createProposal(db, 'p1', {});
    pdf('gen-l'); setProposalFile(db, id, 'gen-l');
    markSent(db, id, { to: 'a@b.c', subject: 's' });
    db.prepare('UPDATE proposals SET legacy = 1 WHERE id = ?').run(id);

    expect(() => setStatus(db, id, 'accepted')).toThrow(LockedError);
    expect(() => setStatus(db, id, 'declined')).toThrow(LockedError);
    expect(getProposal(db, id)!.status).toBe('sent');
  });

  it('listOutstanding returns sent proposals across projects sorted by validUntil', () => {
    const a = createProposal(db, 'p1', { validUntil: '2026-09-30' });
    const b = createProposal(db, 'p2', { validUntil: '2026-09-01' });
    const c = createProposal(db, 'p1', {});
    for (const x of [a, b, c]) { pdf(`g-${x.id}`); setProposalFile(db, x.id, `g-${x.id}`); markSent(db, x.id, { to: 'x@y.z', subject: 's' }); }
    setStatus(db, c.id, 'declined');
    const out = listOutstanding(db);
    expect(out.map(o => o.id)).toEqual([b.id, a.id]);
    expect(out[0].projectName).toBe('Job B');
  });
});

describe('photos + attachments', () => {
  it('adds idempotently with sortOrder, updates caption, removes', () => {
    const { id } = createProposal(db, 'p1', {});
    jpg('ph1'); jpg('ph2');
    addPhoto(db, id, 'ph1'); addPhoto(db, id, 'ph1'); addPhoto(db, id, 'ph2');
    updatePhoto(db, id, 'ph1', { caption: 'North wall' });
    let p = getProposal(db, id)!;
    expect(p.photos.map(x => [x.fileId, x.sortOrder, x.caption])).toEqual([['ph1', 0, 'North wall'], ['ph2', 1, null]]);
    removePhoto(db, id, 'ph1');
    p = getProposal(db, id)!;
    expect(p.photos.map(x => x.fileId)).toEqual(['ph2']);
  });

  it('attachments must be PDFs and existing files', () => {
    const { id } = createProposal(db, 'p1', {});
    jpg('notpdf');
    expect(() => addAttachment(db, id, 'notpdf')).toThrow(ValidationError);
    expect(() => addAttachment(db, id, 'missing')).toThrow(NotFoundError);
    pdf('a1');
    addAttachment(db, id, 'a1');
    const p = getProposal(db, id)!;
    expect(p.attachments).toEqual([expect.objectContaining({ fileId: 'a1', sortOrder: 0, name: 'a1.pdf', mime: 'application/pdf' })]);
    removeAttachment(db, id, 'a1');
    expect(getProposal(db, id)!.attachments).toEqual([]);
  });
});

describe('revise', () => {
  it('copies lines/text/options, links lineage, carries photos+attachments by default, can skip them', () => {
    const src = createProposal(db, 'p1', {});
    saveProposal(db, src.id, {
      version: src.version, title: 'Original', coverNotes: 'n', terms: 't', inclusions: ['i'], exclusions: ['e'],
      showGrandTotal: false, includeCostDetail: true,
      lines: [{ kind: 'takeoff', takeoffId: 't1', description: 'Stucco', amountCents: 100, derivedAmountCents: 90, isAlternate: false },
              { kind: 'manual', description: 'M', amountCents: 5, isAlternate: true }],
    });
    jpg('ph1'); addPhoto(db, src.id, 'ph1'); updatePhoto(db, src.id, 'ph1', { caption: 'c' });
    pdf('a1'); addAttachment(db, src.id, 'a1');
    pdf('gen'); setProposalFile(db, src.id, 'gen');
    markSent(db, src.id, { to: 'a@b.c', subject: 's' });

    const rev = createProposal(db, 'p1', { revisedFromId: src.id });
    const r = getProposal(db, rev.id)!;
    expect(r.number).toBe(2);
    expect(r.revisedFromId).toBe(src.id);
    expect(r.revisedFromNumber).toBe(1);
    expect(r.status).toBe('draft');
    expect(r.fileId).toBeNull();          // generated PDF is NOT carried
    expect(r.title).toBe('Original');
    expect(r.showGrandTotal).toBe(false);
    expect(r.includeCostDetail).toBe(true);
    expect(r.lines.map(l => [l.kind, l.description, l.amountCents, l.derivedAmountCents, l.isAlternate])).toEqual([
      ['takeoff', 'Stucco', 100, 90, false], ['manual', 'M', 5, null, true],
    ]);
    expect(r.lines[0].id).not.toBe(getProposal(db, src.id)!.lines[0].id);
    expect(r.photos.map(p => [p.fileId, p.caption])).toEqual([['ph1', 'c']]);
    expect(r.attachments.map(a => a.fileId)).toEqual(['a1']);

    const bare = createProposal(db, 'p1', { revisedFromId: src.id, carryPhotos: false, carryAttachments: false });
    const b = getProposal(db, bare.id)!;
    expect(b.photos).toEqual([]);
    expect(b.attachments).toEqual([]);
    expect(b.lines).toHaveLength(2);
  });

  it('refuses to revise across projects or from a missing proposal', () => {
    const src = createProposal(db, 'p1', {});
    expect(() => createProposal(db, 'p2', { revisedFromId: src.id })).toThrow(ValidationError);
    expect(() => createProposal(db, 'p1', { revisedFromId: 'nope' })).toThrow(NotFoundError);
  });
});
