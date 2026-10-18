// server/proposalStore.ts — proposals as first-class rows
// (spec docs/superpowers/specs/2026-08-28-proposal-rework-design.md §3–§4).
// Pure SQL functions; no HTTP concerns. Pattern: dailyReportStore.ts.
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class LockedError extends Error {}

export const PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'declined'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
const FONTS = ['helvetica', 'times', 'courier'];

export interface ProposalLineInput {
  id?: string; kind: 'manual' | 'takeoff'; takeoffId?: string | null; description?: string;
  amountCents: number; derivedAmountCents?: number | null; measurementSummary?: string | null; isAlternate?: boolean;
}
export interface PaymentScheduleRow { description: string; percent?: number | null; amountCents?: number | null; }
export interface ProposalInput {
  title?: string | null; validUntil?: string | null; fontFamily?: string | null;
  coverNotes?: string | null; terms?: string | null;
  inclusions?: string[]; exclusions?: string[];
  paymentSchedule?: PaymentScheduleRow[] | null;
  showGrandTotal?: boolean; includeCostDetail?: boolean; includeSignature?: boolean;
  highlightQuality?: 'best' | 'email';
  lines?: ProposalLineInput[];
}
export interface CreateProposalInput extends ProposalInput {
  takeoffIds?: string[]; revisedFromId?: string; carryPhotos?: boolean; carryAttachments?: boolean;
}

const parseJson = <T>(s: string | null, fallback: T): T => { try { return s == null ? fallback : (JSON.parse(s) as T); } catch { return fallback; } };
const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : [];

function requireProject(db: Database.Database, projectId: string): { name: string | null } {
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string | null } | undefined;
  if (!row) throw new NotFoundError('Project not found');
  return row;
}
function rowOf(db: Database.Database, id: string): any {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as any;
  if (!row) throw new NotFoundError('Proposal not found');
  return row;
}
// Every write except status transitions goes through here.
function requireDraft(db: Database.Database, id: string): any {
  const row = rowOf(db, id);
  if (row.legacy || row.status !== 'draft') throw new LockedError('Proposal is locked — revise it to make changes');
  return row;
}
const bump = (db: Database.Database, id: string) =>
  db.prepare('UPDATE proposals SET version = version + 1, updatedAt = ? WHERE id = ?').run(Date.now(), id);

function normalizeSchedule(v: unknown): PaymentScheduleRow[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new ValidationError('paymentSchedule must be an array or null');
  return v.map((r: any) => {
    if (!r || typeof r !== 'object' || typeof r.description !== 'string') throw new ValidationError('paymentSchedule rows need a description');
    const percent = r.percent == null ? null : Number(r.percent);
    const amountCents = r.amountCents == null ? null : r.amountCents;
    if (percent !== null && !Number.isFinite(percent)) throw new ValidationError('paymentSchedule percent must be a number');
    if (amountCents !== null && !Number.isInteger(amountCents)) throw new ValidationError('paymentSchedule amountCents must be an integer');
    return { description: r.description, percent, amountCents };
  });
}

function validateLines(lines: unknown): Required<Omit<ProposalLineInput, 'id'>>[] {
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  return lines.map((l: any) => {
    if (!l || typeof l !== 'object') throw new ValidationError('bad line');
    if (l.kind !== 'manual' && l.kind !== 'takeoff') throw new ValidationError('line kind must be manual|takeoff');
    if (!Number.isInteger(l.amountCents)) throw new ValidationError('amountCents must be an integer');
    if (l.derivedAmountCents != null && !Number.isInteger(l.derivedAmountCents)) throw new ValidationError('derivedAmountCents must be an integer');
    if (l.kind === 'takeoff' && (typeof l.takeoffId !== 'string' || !l.takeoffId)) throw new ValidationError('takeoff lines need a takeoffId');
    return {
      kind: l.kind, takeoffId: l.kind === 'takeoff' ? l.takeoffId : null,
      description: typeof l.description === 'string' ? l.description : '',
      amountCents: l.amountCents, derivedAmountCents: l.derivedAmountCents ?? null,
      measurementSummary: typeof l.measurementSummary === 'string' ? l.measurementSummary : null,
      isAlternate: !!l.isAlternate,
    };
  });
}

function writeLines(db: Database.Database, proposalId: string, lines: ReturnType<typeof validateLines>): void {
  db.prepare('DELETE FROM proposal_lines WHERE proposalId = ?').run(proposalId);
  const ins = db.prepare(`INSERT INTO proposal_lines (id, proposalId, sortOrder, kind, takeoffId, description, amountCents, derivedAmountCents, measurementSummary, isAlternate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  lines.forEach((l, i) => ins.run(crypto.randomUUID(), proposalId, i, l.kind, l.takeoffId, l.description, l.amountCents, l.derivedAmountCents, l.measurementSummary, l.isAlternate ? 1 : 0));
}

const SUMMARY_SQL = `
  SELECT p.*,
    (SELECT number FROM proposals r WHERE r.id = p.revisedFromId) AS revisedFromNumber,
    (SELECT COALESCE(SUM(amountCents), 0) FROM proposal_lines l WHERE l.proposalId = p.id AND l.isAlternate = 0) AS totalCents,
    (SELECT COUNT(*) FROM proposal_lines l WHERE l.proposalId = p.id AND l.isAlternate = 1) AS alternateCount,
    (SELECT COUNT(*) FROM proposal_lines l WHERE l.proposalId = p.id AND l.kind = 'takeoff' AND l.derivedAmountCents IS NOT NULL AND l.amountCents != l.derivedAmountCents) AS overrideCount,
    (SELECT COUNT(*) FROM proposal_photos ph WHERE ph.proposalId = p.id) AS photoCount,
    (SELECT COUNT(*) FROM proposal_attachments a WHERE a.proposalId = p.id) AS attachmentCount
  FROM proposals p`;

function shapeSummary(r: any) {
  const { overrideCount, ...rest } = r;
  return {
    ...rest,
    legacy: !!r.legacy, showGrandTotal: !!r.showGrandTotal, includeCostDetail: !!r.includeCostDetail, includeSignature: !!r.includeSignature,
    inclusions: strArr(parseJson(r.inclusions, [])), exclusions: strArr(parseJson(r.exclusions, [])),
    paymentSchedule: parseJson<PaymentScheduleRow[] | null>(r.paymentSchedule, null),
    sentTo: parseJson<{ to: string; cc?: string; subject: string } | null>(r.sentTo, null),
    hasOverride: overrideCount > 0,
  };
}

export function listProposals(db: Database.Database, projectId: string): any[] {
  return (db.prepare(`${SUMMARY_SQL} WHERE p.projectId = ? ORDER BY p.number DESC`).all(projectId) as any[]).map(shapeSummary);
}

export function listOutstanding(db: Database.Database): any[] {
  return (db.prepare(`${SUMMARY_SQL} WHERE p.status = 'sent'
      ORDER BY CASE WHEN p.validUntil IS NULL THEN 1 ELSE 0 END, p.validUntil, p.sentAt`).all() as any[])
    .map(r => ({ ...shapeSummary(r), projectName: (db.prepare('SELECT name FROM projects WHERE id = ?').get(r.projectId) as any)?.name ?? null }));
}

export function getProposal(db: Database.Database, id: string): any | null {
  const r = db.prepare(`${SUMMARY_SQL} WHERE p.id = ?`).get(id) as any;
  if (!r) return null;
  const lines = (db.prepare('SELECT * FROM proposal_lines WHERE proposalId = ? ORDER BY sortOrder').all(id) as any[])
    .map(l => ({ ...l, isAlternate: !!l.isAlternate }));
  const photos = db.prepare('SELECT id, fileId, sortOrder, caption FROM proposal_photos WHERE proposalId = ? ORDER BY sortOrder, createdAt').all(id);
  const attachments = db.prepare(`SELECT a.id, a.fileId, a.sortOrder, f.name, f.mime, f.size
    FROM proposal_attachments a LEFT JOIN files f ON f.id = a.fileId WHERE a.proposalId = ? ORDER BY a.sortOrder, a.createdAt`).all(id);
  return { ...shapeSummary(r), lines, photos, attachments };
}

function applyInput(db: Database.Database, id: string, input: ProposalInput, existing: any): void {
  if (input.fontFamily != null && !FONTS.includes(input.fontFamily)) throw new ValidationError('bad fontFamily');
  if (input.highlightQuality != null && input.highlightQuality !== 'best' && input.highlightQuality !== 'email') throw new ValidationError('bad highlightQuality');
  if (input.validUntil != null && input.validUntil !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) throw new ValidationError('validUntil must be YYYY-MM-DD');
  const schedule = input.paymentSchedule === undefined ? undefined : normalizeSchedule(input.paymentSchedule);
  db.prepare(`UPDATE proposals SET title = ?, validUntil = ?, fontFamily = ?, coverNotes = ?, terms = ?, inclusions = ?, exclusions = ?,
      paymentSchedule = ?, showGrandTotal = ?, includeCostDetail = ?, includeSignature = ?, highlightQuality = ? WHERE id = ?`)
    .run(
      input.title === undefined ? existing.title : input.title,
      input.validUntil === undefined ? existing.validUntil : (input.validUntil || null),
      input.fontFamily === undefined ? existing.fontFamily : input.fontFamily,
      input.coverNotes === undefined ? existing.coverNotes : input.coverNotes,
      input.terms === undefined ? existing.terms : input.terms,
      input.inclusions === undefined ? existing.inclusions : JSON.stringify(strArr(input.inclusions)),
      input.exclusions === undefined ? existing.exclusions : JSON.stringify(strArr(input.exclusions)),
      schedule === undefined ? existing.paymentSchedule : (schedule === null ? null : JSON.stringify(schedule)),
      input.showGrandTotal === undefined ? existing.showGrandTotal : (input.showGrandTotal ? 1 : 0),
      input.includeCostDetail === undefined ? existing.includeCostDetail : (input.includeCostDetail ? 1 : 0),
      input.includeSignature === undefined ? existing.includeSignature : (input.includeSignature ? 1 : 0),
      input.highlightQuality === undefined ? existing.highlightQuality : input.highlightQuality,
      id,
    );
  if (input.lines !== undefined) writeLines(db, id, validateLines(input.lines));
}

export function createProposal(db: Database.Database, projectId: string, input: CreateProposalInput, createdBy?: string): { id: string; number: number; version: number } {
  requireProject(db, projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  let number = 0;
  const tx = db.transaction(() => {
    // Never reuse an issued number: the high-water counter survives deletes.
    // MAX(number) is a guard so numbering can't collide even if the counter
    // were ever behind (e.g. legacy proposals from migration 28). Mirrors
    // rfiStore.ts's createRfi.
    const counter = (db.prepare('SELECT proposalCounter c FROM projects WHERE id = ?').get(projectId) as any).c;
    const max = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM proposals WHERE projectId = ?').get(projectId) as any).m;
    number = Math.max(counter, max) + 1;
    let source: any = null;
    if (input.revisedFromId) {
      source = db.prepare('SELECT * FROM proposals WHERE id = ?').get(input.revisedFromId) as any;
      if (!source) throw new NotFoundError('Source proposal not found');
      if (source.projectId !== projectId) throw new ValidationError('Cannot revise a proposal from another project');
    }
    db.prepare(`INSERT INTO proposals (id, projectId, number, revisedFromId, status, legacy, title, validUntil, fontFamily, coverNotes, terms,
        inclusions, exclusions, paymentSchedule, showGrandTotal, includeCostDetail, includeSignature, highlightQuality,
        version, createdBy, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(id, projectId, number, source?.id ?? null,
        source?.title ?? null, source?.validUntil ?? null, source?.fontFamily ?? null, source?.coverNotes ?? null, source?.terms ?? null,
        source?.inclusions ?? '[]', source?.exclusions ?? '[]', source?.paymentSchedule ?? null,
        source ? source.showGrandTotal : 1, source ? source.includeCostDetail : 0, source ? source.includeSignature : 1, source?.highlightQuality ?? 'best',
        createdBy ?? null, now, now);
    db.prepare('UPDATE projects SET proposalCounter = ? WHERE id = ?').run(number, projectId);
    if (source) {
      const srcLines = db.prepare('SELECT * FROM proposal_lines WHERE proposalId = ? ORDER BY sortOrder').all(source.id) as any[];
      writeLines(db, id, validateLines(srcLines.map(l => ({ ...l, isAlternate: !!l.isAlternate }))));
      if (input.carryPhotos !== false) {
        const ins = db.prepare('INSERT INTO proposal_photos (id, proposalId, fileId, sortOrder, caption, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
        for (const ph of db.prepare('SELECT fileId, sortOrder, caption FROM proposal_photos WHERE proposalId = ? ORDER BY sortOrder').all(source.id) as any[]) {
          ins.run(crypto.randomUUID(), id, ph.fileId, ph.sortOrder, ph.caption, now);
        }
      }
      if (input.carryAttachments !== false) {
        const ins = db.prepare('INSERT INTO proposal_attachments (id, proposalId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)');
        for (const a of db.prepare('SELECT fileId, sortOrder FROM proposal_attachments WHERE proposalId = ? ORDER BY sortOrder').all(source.id) as any[]) {
          ins.run(crypto.randomUUID(), id, a.fileId, a.sortOrder, now);
        }
      }
    } else if (input.takeoffIds?.length) {
      const ids = input.takeoffIds.filter(x => typeof x === 'string' && x);
      const rows = ids.length
        ? db.prepare(`SELECT id, name FROM takeoffs WHERE projectId = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY sortOrder`).all(projectId, ...ids) as any[]
        : [];
      // preserve the caller's order
      const byId = new Map(rows.map(r => [r.id, r]));
      writeLines(db, id, validateLines(ids.filter(x => byId.has(x)).map(x => ({ kind: 'takeoff', takeoffId: x, description: byId.get(x).name ?? '', amountCents: 0, derivedAmountCents: null }))));
    }
    // explicit fields on create (e.g. validUntil from tests / defaults from user prefs)
    const { takeoffIds, revisedFromId, carryPhotos, carryAttachments, ...rest } = input;
    if (Object.keys(rest).length) applyInput(db, id, rest, db.prepare('SELECT * FROM proposals WHERE id = ?').get(id));
  });
  tx();
  return { id, number, version: 1 };
}

// Returns updatedAt alongside version because the client adopts BOTH: updatedAt
// is what "is the generated PDF still current?" compares a document's createdAt
// against (useGeneratedDocument.isUpToDate), so an editor left holding the
// pre-save timestamp would keep calling a now-stale PDF up to date and email it.
export function saveProposal(db: Database.Database, id: string, input: ProposalInput & { version: number }): { version: number; updatedAt: number } {
  const row = requireDraft(db, id);
  if (!Number.isInteger(input.version)) throw new ValidationError('version required');
  if (row.version !== input.version) throw new ConflictError('proposal was modified');
  const tx = db.transaction(() => { applyInput(db, id, input, row); bump(db, id); });
  tx();
  const { updatedAt } = db.prepare('SELECT updatedAt FROM proposals WHERE id = ?').get(id) as { updatedAt: number };
  return { version: row.version + 1, updatedAt };
}

export function deleteProposal(db: Database.Database, id: string): void {
  requireDraft(db, id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM proposal_lines WHERE proposalId = ?').run(id);
    db.prepare('DELETE FROM proposal_photos WHERE proposalId = ?').run(id);
    db.prepare('DELETE FROM proposal_attachments WHERE proposalId = ?').run(id);
    db.prepare('DELETE FROM proposals WHERE id = ?').run(id);
  });
  tx();
}

// Attaching the document the client just generated is NOT an edit to the
// proposal: `updatedAt` is what "is this PDF still current?" compares the
// file's createdAt against (useGeneratedDocument.isUpToDate), so touching it
// here would stamp every freshly generated PDF as already out of date and make
// the editor rebuild one on every send. Same reasoning as addPhoto/
// addAttachment, which also skip bump().
export function setProposalFile(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  db.prepare('UPDATE proposals SET fileId = ? WHERE id = ?').run(fileId, id);
}

const requireFile = (db: Database.Database, fileId: unknown) => {
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const f = db.prepare('SELECT id, mime FROM files WHERE id = ?').get(fileId) as { id: string; mime: string } | undefined;
  if (!f) throw new NotFoundError('File not found');
  return f;
};

export function addPhoto(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id); requireFile(db, fileId);
  if (db.prepare('SELECT 1 FROM proposal_photos WHERE proposalId = ? AND fileId = ?').get(id, fileId)) return;
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM proposal_photos WHERE proposalId = ?').get(id) as any).m;
  db.prepare('INSERT INTO proposal_photos (id, proposalId, fileId, sortOrder, caption, createdAt) VALUES (?, ?, ?, ?, NULL, ?)').run(crypto.randomUUID(), id, fileId, max + 1, Date.now());
}
export function updatePhoto(db: Database.Database, id: string, fileId: string, patch: { caption?: string | null; sortOrder?: number }): void {
  requireDraft(db, id);
  const row = db.prepare('SELECT caption, sortOrder FROM proposal_photos WHERE proposalId = ? AND fileId = ?').get(id, fileId) as any;
  if (!row) throw new NotFoundError('Photo not on this proposal');
  if (patch.sortOrder !== undefined && !Number.isInteger(patch.sortOrder)) throw new ValidationError('sortOrder must be an integer');
  db.prepare('UPDATE proposal_photos SET caption = ?, sortOrder = ? WHERE proposalId = ? AND fileId = ?')
    .run(patch.caption === undefined ? row.caption : (patch.caption || null), patch.sortOrder ?? row.sortOrder, id, fileId);
}
export function removePhoto(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  db.prepare('DELETE FROM proposal_photos WHERE proposalId = ? AND fileId = ?').run(id, fileId);
}

export function addAttachment(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  const f = requireFile(db, fileId);
  if (f.mime !== 'application/pdf') throw new ValidationError('Only PDF files can be attached');
  if (db.prepare('SELECT 1 FROM proposal_attachments WHERE proposalId = ? AND fileId = ?').get(id, fileId)) return;
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM proposal_attachments WHERE proposalId = ?').get(id) as any).m;
  db.prepare('INSERT INTO proposal_attachments (id, proposalId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), id, fileId, max + 1, Date.now());
}
export function updateAttachment(db: Database.Database, id: string, fileId: string, patch: { sortOrder: number }): void {
  requireDraft(db, id);
  if (!Number.isInteger(patch.sortOrder)) throw new ValidationError('sortOrder must be an integer');
  const r = db.prepare('UPDATE proposal_attachments SET sortOrder = ? WHERE proposalId = ? AND fileId = ?').run(patch.sortOrder, id, fileId);
  if (r.changes === 0) throw new NotFoundError('Attachment not on this proposal');
}
export function removeAttachment(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  db.prepare('DELETE FROM proposal_attachments WHERE proposalId = ? AND fileId = ?').run(id, fileId);
}

// Recording that the proposal went out does not change what the proposal SAYS —
// the PDF carries no status/sentAt — so this deliberately leaves `updatedAt`
// alone, for the same reason setProposalFile does (see the comment there):
// updatedAt is the "is this PDF still current?" clock. Bumping it here would
// leave every sent proposal — permanently locked, so its PDF can never be
// regenerated — showing "PDF out of date" forever. version still bumps so
// collaborators reload the new status.
export function markSent(db: Database.Database, id: string, sentTo: { to: string; cc?: string; subject: string }): { version: number } {
  const row = requireDraft(db, id);
  if (!row.fileId) throw new ValidationError('Generate the proposal PDF before sending');
  db.prepare(`UPDATE proposals SET status = 'sent', sentAt = ?, sentTo = ?, version = version + 1 WHERE id = ?`)
    .run(Date.now(), JSON.stringify({ to: sentTo.to, cc: sentTo.cc, subject: sentTo.subject }), id);
  return { version: row.version + 1 };
}

export function setStatus(db: Database.Database, id: string, status: 'accepted' | 'declined', signedFileId?: string | null): { version: number } {
  const row = rowOf(db, id);
  if (status !== 'accepted' && status !== 'declined') throw new ValidationError('status must be accepted|declined');
  // Legacy rows (migration 28) are read-only history: the only things offered
  // on one are Open PDF and Revise (spec §5). They carry status 'sent' when
  // they matched the old proposalFileId, so without this they'd otherwise slip
  // through the 'sent' check below.
  if (row.legacy) throw new LockedError('Proposal is locked — revise it to make changes');
  if (row.status !== 'sent') throw new ValidationError('Only a sent proposal can be accepted or declined');
  if (signedFileId) requireFile(db, signedFileId);
  const now = Date.now();
  db.prepare(`UPDATE proposals SET status = ?, acceptedAt = ?, declinedAt = ?, signedFileId = COALESCE(?, signedFileId), version = version + 1, updatedAt = ? WHERE id = ?`)
    .run(status, status === 'accepted' ? now : null, status === 'declined' ? now : null, signedFileId ?? null, now, id);
  return { version: row.version + 1 };
}

export function setSignedFile(db: Database.Database, id: string, fileId: string | null): void {
  const row = rowOf(db, id);
  if (row.status !== 'sent' && row.status !== 'accepted') throw new ValidationError('Signed copy only applies to sent or accepted proposals');
  if (fileId) requireFile(db, fileId);
  db.prepare('UPDATE proposals SET signedFileId = ?, updatedAt = ? WHERE id = ?').run(fileId, Date.now(), id);
}
