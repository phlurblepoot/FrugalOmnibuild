// server/lienReleaseStore.ts — Florida releases of lien (Fla. Stat. 713.20).
// Spec: docs/superpowers/specs/2026-10-15-florida-lien-release-design.md (§5).
//
// A release is a stored record holding a copy of every value printed on it, so
// the company keeps a history of what was waived and the shared document bar,
// document versions and mail thread links all have a record id to hang on.
// `sourceType`/`sourceId` only record where it was started from; a later change
// to the pay app or invoice never changes a release. Money is integer cents,
// days are 'YYYY-MM-DD' text, so no time zone can move a date.
import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { computeG702 } from './aiaStore';
import { toCents } from './billingStore';
import { billingDay, ymd } from '../src/utils/billingDates';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
/** A sent or voided release cannot be deleted (spec §5.4, §6.5). */
export class LockedError extends Error {}

export const LIEN_PAYMENT_TYPES = ['progress', 'final'] as const;
export const LIEN_STATUSES = ['draft', 'sent', 'void'] as const;
export const LIEN_CONDITION_KINDS = ['check', 'funds'] as const;
export const LIEN_SOURCE_TYPES = ['payapp', 'invoice'] as const;
export const LIEN_ENTITY_TYPES = ['llc', 'corporation', 'partnership', 'sole_proprietor', 'other'] as const;
export type LienEntityType = (typeof LIEN_ENTITY_TYPES)[number];
export type LienPaymentType = (typeof LIEN_PAYMENT_TYPES)[number];
export type LienSourceType = (typeof LIEN_SOURCE_TYPES)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LienReleaseInput {
  paymentType?: string;
  conditional?: boolean;
  sourceType?: string | null;
  sourceId?: string | null;
  supersedesId?: string | null;
  lienorName?: string;
  lienorEntityType?: string | null;
  lienorState?: string | null;
  customerName?: string;
  ownerName?: string;
  propertyDescription?: string;
  amountCents?: number;
  throughDate?: string | null;
  releaseDate?: string;
  signerName?: string;
  signerTitle?: string | null;
  conditionKind?: string | null;
  checkNumber?: string | null;
  checkMaker?: string | null;
  checkBank?: string | null;
  exceptions?: string | null;
  signatureFileId?: string | null;
  version?: number;
}

export interface LienReleaseRow {
  id: string;
  projectId: string;
  number: string | null;
  paymentType: LienPaymentType;
  conditional: boolean;
  sourceType: LienSourceType | null;
  sourceId: string | null;
  supersedesId: string | null;
  lienorName: string;
  lienorEntityType: LienEntityType | null;
  lienorState: string | null;
  customerName: string;
  ownerName: string;
  propertyDescription: string;
  amountCents: number;
  throughDate: string | null;
  releaseDate: string;
  signerName: string;
  signerTitle: string | null;
  conditionKind: 'check' | 'funds' | null;
  checkNumber: string | null;
  checkMaker: string | null;
  checkBank: string | null;
  exceptions: string | null;
  signatureFileId: string | null;
  status: 'draft' | 'sent' | 'void';
  createdByUserId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const textOrNull = (v: unknown): string | null => text(v) || null;

function readRow(row: any): LienReleaseRow {
  return { ...row, conditional: !!row.conditional };
}

export function getLienRelease(db: Database.Database, id: string): LienReleaseRow | null {
  const row = db.prepare('SELECT * FROM lien_releases WHERE id = ?').get(id);
  return row ? readRow(row) : null;
}

export function listLienReleases(db: Database.Database, projectId: string): LienReleaseRow[] {
  return (db.prepare('SELECT * FROM lien_releases WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[]).map(readRow);
}

// Next per-project number, as for change orders: the highest integer in use + 1.
// Printed `LR-{number}`; not zero-padded (spec §5.2).
function nextNumber(db: Database.Database, projectId: string): string {
  const rows = db.prepare('SELECT number FROM lien_releases WHERE projectId = ?').all(projectId) as { number: string | null }[];
  let max = 0;
  for (const r of rows) {
    const m = String(r.number ?? '').match(/\d+/);
    if (m) max = Math.max(max, parseInt(m[0], 10));
  }
  return String(max + 1);
}

type Cleaned = Omit<LienReleaseRow, 'id' | 'projectId' | 'number' | 'status' | 'createdByUserId' | 'version' | 'createdAt' | 'updatedAt'>;

// Spec §5.4. Returns the values to store, with the condition and check fields
// cleared where they do not apply.
function clean(input: LienReleaseInput): Cleaned {
  if (!(LIEN_PAYMENT_TYPES as readonly string[]).includes(input.paymentType as string)) {
    throw new ValidationError('paymentType must be progress or final');
  }
  const paymentType = input.paymentType as LienPaymentType;
  if (typeof input.conditional !== 'boolean') throw new ValidationError('conditional must be true or false');
  const conditional = input.conditional;

  const sourceType = input.sourceType ?? null;
  const sourceId = input.sourceId ?? null;
  if (sourceType !== null && !(LIEN_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    throw new ValidationError('sourceType must be payapp or invoice');
  }
  if ((sourceType === null) !== (sourceId === null)) throw new ValidationError('sourceType and sourceId go together');

  const lienorName = text(input.lienorName);
  const customerName = text(input.customerName);
  const ownerName = text(input.ownerName);
  const propertyDescription = text(input.propertyDescription);
  const signerName = text(input.signerName);
  if (!lienorName) throw new ValidationError('Lienor name is required');
  const lienorEntityType = textOrNull(input.lienorEntityType) as LienEntityType | null;
  if (lienorEntityType !== null && !(LIEN_ENTITY_TYPES as readonly string[]).includes(lienorEntityType)) {
    throw new ValidationError('Entity type must be llc, corporation, partnership, sole_proprietor or other');
  }
  const lienorState = textOrNull(input.lienorState);
  if (!customerName) throw new ValidationError('Customer name is required');
  if (!ownerName) throw new ValidationError('Owner name is required');
  if (!propertyDescription) throw new ValidationError('Property description is required');
  if (!signerName) throw new ValidationError('Signer name is required');

  const amountCents = input.amountCents;
  if (!Number.isInteger(amountCents) || (amountCents as number) < 1) throw new ValidationError('Amount must be greater than $0');

  const releaseDate = text(input.releaseDate);
  if (!DAY_RE.test(releaseDate)) throw new ValidationError('Release date is required');
  let throughDate: string | null = null;
  if (paymentType === 'progress') {
    throughDate = text(input.throughDate);
    if (!DAY_RE.test(throughDate)) throw new ValidationError('Through date is required for a progress release');
    // No advance waivers: 713.20(2) lets a lien be waived only for work already done.
    if (throughDate > releaseDate) throw new ValidationError('Through date cannot be after the release date');
  }

  let conditionKind: 'check' | 'funds' | null = null;
  let checkNumber: string | null = null, checkMaker: string | null = null, checkBank: string | null = null;
  if (conditional) {
    const given = input.conditionKind ?? null;
    if (given !== null && !(LIEN_CONDITION_KINDS as readonly string[]).includes(given)) {
      throw new ValidationError('conditionKind must be check or funds');
    }
    // A check number turns the condition into the check wording (spec §5.3).
    conditionKind = (given as 'check' | 'funds' | null) ?? (text(input.checkNumber) ? 'check' : 'funds');
    if (conditionKind === 'check') {
      checkNumber = textOrNull(input.checkNumber);
      checkMaker = textOrNull(input.checkMaker);
      checkBank = textOrNull(input.checkBank);
      if (!checkNumber) throw new ValidationError('Check number is required for a check condition');
      if (!checkMaker) throw new ValidationError('Check drawn-by name is required for a check condition');
    }
  }

  return {
    paymentType, conditional, sourceType: sourceType as LienSourceType | null, sourceId,
    supersedesId: input.supersedesId ?? null,
    lienorName, lienorEntityType, lienorState, customerName, ownerName, propertyDescription,
    amountCents: amountCents as number, throughDate, releaseDate,
    signerName, signerTitle: textOrNull(input.signerTitle),
    conditionKind, checkNumber, checkMaker, checkBank,
    exceptions: textOrNull(input.exceptions),
    signatureFileId: textOrNull(input.signatureFileId),
  };
}

function checkSource(db: Database.Database, projectId: string, v: Cleaned): void {
  if (v.sourceType && v.sourceId) {
    const table = v.sourceType === 'payapp' ? 'aia_pay_apps' : 'invoices';
    const row = db.prepare(`SELECT projectId FROM ${table} WHERE id = ?`).get(v.sourceId) as { projectId: string } | undefined;
    if (!row || row.projectId !== projectId) throw new ValidationError('The pay app or invoice is not on this project');
  }
  if (v.supersedesId) {
    const row = db.prepare('SELECT projectId FROM lien_releases WHERE id = ?').get(v.supersedesId) as { projectId: string } | undefined;
    if (!row || row.projectId !== projectId) throw new ValidationError('The superseded release is not on this project');
  }
}

const COLUMNS = [
  'paymentType', 'conditional', 'sourceType', 'sourceId', 'supersedesId',
  'lienorName', 'lienorEntityType', 'lienorState', 'customerName', 'ownerName', 'propertyDescription',
  'amountCents', 'throughDate', 'releaseDate', 'signerName', 'signerTitle',
  'conditionKind', 'checkNumber', 'checkMaker', 'checkBank', 'exceptions', 'signatureFileId',
] as const;

const columnValues = (v: Cleaned): unknown[] => COLUMNS.map(c => (c === 'conditional' ? (v.conditional ? 1 : 0) : (v as any)[c]));

export function createLienRelease(
  db: Database.Database, projectId: string, input: LienReleaseInput, userId?: string | null,
): { id: string; number: string; version: number } {
  requireProject(db, projectId);
  const v = clean(input);
  checkSource(db, projectId, v);
  const id = crypto.randomUUID();
  const now = Date.now();
  let number = '';
  db.transaction(() => {
    number = nextNumber(db, projectId);
    db.prepare(`INSERT INTO lien_releases (id, projectId, number, ${COLUMNS.join(', ')}, status, createdByUserId, version, createdAt, updatedAt)
      VALUES (?, ?, ?, ${COLUMNS.map(() => '?').join(', ')}, 'draft', ?, 1, ?, ?)`)
      .run(id, projectId, number, ...columnValues(v), userId ?? null, now, now);
  })();
  return { id, number, version: 1 };
}

export function saveLienRelease(db: Database.Database, id: string, input: LienReleaseInput): { version: number } {
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new ValidationError('Missing or invalid version — reload the release');
  }
  const v = clean(input);
  let newVersion = 0;
  db.transaction(() => {
    const row = db.prepare('SELECT projectId, version FROM lien_releases WHERE id = ?').get(id) as { projectId: string; version: number } | undefined;
    if (!row) throw new NotFoundError('Lien release not found');
    if (row.version !== input.version) throw new ConflictError(`Lien release changed since it was loaded (server v${row.version}, payload v${input.version})`);
    checkSource(db, row.projectId, v);
    newVersion = row.version + 1;
    db.prepare(`UPDATE lien_releases SET ${COLUMNS.map(c => `${c} = ?`).join(', ')}, version = ?, updatedAt = ? WHERE id = ?`)
      .run(...columnValues(v), newVersion, Date.now(), id);
  })();
  return { version: newVersion };
}

/** 'void' keeps the record and its document; 'draft' un-voids; 'sent' is what the item send sets. */
export function setLienReleaseStatus(db: Database.Database, id: string, status: string): { status: string; version: number } {
  if (!(LIEN_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid lien release status: ${status}`);
  const row = db.prepare('SELECT version, status FROM lien_releases WHERE id = ?').get(id) as { version: number; status: string } | undefined;
  if (!row) throw new NotFoundError('Lien release not found');
  // A re-send of a sent release must not touch updatedAt, or the document's
  // up-to-date chip goes stale on every send.
  if (row.status === status) return { status, version: row.version };
  const version = row.version + 1;
  db.prepare('UPDATE lien_releases SET status = ?, version = ?, updatedAt = ? WHERE id = ?').run(status, version, Date.now(), id);
  return { status, version };
}

/** Drafts only: a sent release is voided, never deleted, so the record of what was waived survives. */
export function deleteLienRelease(db: Database.Database, id: string): void {
  const row = db.prepare('SELECT status FROM lien_releases WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new NotFoundError('Lien release not found');
  if (row.status !== 'draft') throw new LockedError('A sent release cannot be deleted. Void it instead.');
  // A release it superseded keeps its own record; only the link is dropped.
  db.prepare('UPDATE lien_releases SET supersedesId = NULL WHERE supersedesId = ?').run(id);
  db.prepare('DELETE FROM lien_releases WHERE id = ?').run(id);
}

// ── Payments and defaults (spec §5.3) ────────────────────────────────────────

interface PaymentRow { id: string; targetType: string; targetId: string; date: number | null; amount: number }

function paymentsFor(db: Database.Database, sourceType: LienSourceType, sourceId: string): PaymentRow[] {
  return db.prepare('SELECT id, targetType, targetId, date, amount FROM payments WHERE targetType = ? AND targetId = ? ORDER BY date')
    .all(sourceType === 'payapp' ? 'payapp' : 'invoice', sourceId) as PaymentRow[];
}

export interface PrefillSourceSummary {
  /** "Pay App #3" or "Invoice 1005". */
  label: string;
  /** What is billed on it: G702 line 8 for a pay app, the total for an invoice. */
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  /** G702 line 3, pay apps only. */
  contractSumToDateCents?: number;
}

export interface LienReleasePrefill extends Required<Pick<LienReleaseInput,
  'paymentType' | 'conditional' | 'sourceType' | 'sourceId' | 'lienorName' | 'lienorEntityType' | 'lienorState' | 'customerName' | 'ownerName' | 'propertyDescription'
  | 'amountCents' | 'throughDate' | 'releaseDate' | 'signerName' | 'signerTitle' | 'conditionKind' | 'checkMaker' | 'exceptions'>> {
  source: PrefillSourceSummary | null;
  /** Shown above the editor; an unconditional release with no payment recorded gets one (spec §6.3). */
  warnings: string[];
}

export interface PrefillQuery {
  sourceType?: string | null;
  sourceId?: string | null;
  /** Start from a recorded payment (Billing -> Payments -> "Unconditional release for this payment"). */
  paymentId?: string | null;
  paymentType?: string;
  conditional?: boolean;
}

function settingValue(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return text(row?.value);
}

export function prefillLienRelease(
  db: Database.Database, projectId: string, q: PrefillQuery, user?: { id?: string | null; username?: string | null },
): LienReleasePrefill {
  const project = db.prepare('SELECT name, contractor, address, customerId, meta FROM projects WHERE id = ?').get(projectId) as
    { name: string | null; contractor: string | null; address: string | null; customerId: string | null; meta: string | null } | undefined;
  if (!project) throw new NotFoundError('Project not found');
  const paymentType = q.paymentType ?? 'progress';
  if (!(LIEN_PAYMENT_TYPES as readonly string[]).includes(paymentType)) throw new ValidationError('paymentType must be progress or final');
  const conditional = q.conditional ?? true;
  const today = ymd(new Date());
  const warnings: string[] = [];

  // Where it starts from: a recorded payment names its pay app or invoice and
  // its own date and amount; otherwise a pay app or invoice; otherwise by hand.
  let payment: PaymentRow | null = null;
  let sourceType = (q.sourceType ?? null) as LienSourceType | null;
  let sourceId = q.sourceId ?? null;
  if (q.paymentId) {
    payment = (db.prepare('SELECT id, targetType, targetId, date, amount FROM payments WHERE id = ?').get(q.paymentId) as PaymentRow | undefined) ?? null;
    if (!payment) throw new NotFoundError('Payment not found');
    sourceType = payment.targetType === 'payapp' ? 'payapp' : 'invoice';
    sourceId = payment.targetId;
  }
  if (sourceType !== null && !(LIEN_SOURCE_TYPES as readonly string[]).includes(sourceType)) throw new ValidationError('sourceType must be payapp or invoice');
  if ((sourceType === null) !== (sourceId === null)) throw new ValidationError('sourceType and sourceId go together');

  let source: PrefillSourceSummary | null = null;
  let sourceDay: string | null = null; // the end of the billed period
  if (sourceType && sourceId) {
    if (sourceType === 'payapp') {
      const app = db.prepare('SELECT id, projectId, number, periodTo FROM aia_pay_apps WHERE id = ?').get(sourceId) as
        { id: string; projectId: string; number: number; periodTo: string | null } | undefined;
      if (!app || app.projectId !== projectId) throw new NotFoundError('Pay app not found on this project');
      const g702 = computeG702(db, app.id);
      const paidCents = paymentsFor(db, 'payapp', app.id).reduce((a, p) => a + toCents(p.amount), 0);
      source = {
        label: `Pay App #${app.number}`, totalCents: g702.L8currentPaymentDueCents, paidCents,
        balanceCents: g702.L8currentPaymentDueCents - paidCents, contractSumToDateCents: g702.L3contractSumToDateCents,
      };
      sourceDay = app.periodTo && DAY_RE.test(app.periodTo) ? app.periodTo : null;
    } else {
      const inv = db.prepare('SELECT id, projectId, number, date FROM invoices WHERE id = ?').get(sourceId) as
        { id: string; projectId: string; number: string | null; date: number | null } | undefined;
      if (!inv || inv.projectId !== projectId) throw new NotFoundError('Invoice not found on this project');
      const lines = db.prepare('SELECT qty, unitPrice FROM invoice_lines WHERE invoiceId = ?').all(inv.id) as { qty: number; unitPrice: number }[];
      const totalCents = lines.reduce((a, l) => a + toCents((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)), 0);
      const paidCents = paymentsFor(db, 'invoice', inv.id).reduce((a, p) => a + toCents(p.amount), 0);
      source = { label: `Invoice ${text(inv.number) || '?'}`, totalCents, paidCents, balanceCents: totalCents - paidCents };
      sourceDay = billingDay(inv.date);
    }
  }

  // Amount: what is still due for a conditional release (it goes out with the
  // bill), what was received for an unconditional one (it goes out after).
  let amountCents = 0;
  if (payment) amountCents = toCents(payment.amount);
  else if (source) {
    if (conditional) amountCents = Math.max(source.balanceCents, 0);
    else if (source.paidCents > 0) amountCents = source.paidCents;
    else {
      amountCents = Math.max(source.totalCents, 0);
      warnings.push(`No payment is recorded for ${source.label}. An unconditional release takes effect when you sign and deliver it, paid or not.`);
    }
  }
  if (!conditional && !payment && !source) {
    warnings.push('No payment is recorded for this release. An unconditional release takes effect when you sign and deliver it, paid or not.');
  }

  // Through date: end of the billed period; a payment without a billed period falls back to its own date.
  let throughDate: string | null = null;
  if (paymentType === 'progress') {
    throughDate = sourceDay ?? (payment ? billingDay(payment.date) : null) ?? today;
    if (throughDate > today) throughDate = today; // never an advance waiver
  }

  // Names. The last release on this project is the best guess for the owner and the property.
  const last = db.prepare('SELECT ownerName, propertyDescription FROM lien_releases WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1').get(projectId) as
    { ownerName: string; propertyDescription: string } | undefined;
  let meta: any = {};
  try { meta = project.meta ? JSON.parse(project.meta) : {}; } catch { /* unreadable meta: no AIA settings */ }
  const customerRow = project.customerId
    ? db.prepare('SELECT name FROM customers WHERE id = ?').get(project.customerId) as { name: string | null } | undefined
    : undefined;
  const customerName = text(project.contractor) || text(customerRow?.name);
  const ownerName = text(project.name); // the owner asked for the project name on every release
  const propertyDescription = text(last?.propertyDescription)
    || [text(project.name), text(project.address)].filter(Boolean).join('\n');

  const lastTitle = user?.id
    ? (db.prepare("SELECT signerTitle FROM lien_releases WHERE createdByUserId = ? AND signerTitle IS NOT NULL AND signerTitle != '' ORDER BY createdAt DESC, rowid DESC LIMIT 1").get(user.id) as { signerTitle: string } | undefined)
    : undefined;

  return {
    paymentType: paymentType as LienPaymentType, conditional,
    sourceType, sourceId,
    lienorName: settingValue(db, 'companyLegalName') || settingValue(db, 'companyName') || settingValue(db, 'appName'),
    lienorEntityType: (LIEN_ENTITY_TYPES as readonly string[]).includes(settingValue(db, 'companyEntityType'))
      ? settingValue(db, 'companyEntityType') as LienEntityType : null,
    lienorState: settingValue(db, 'companyStateOfFormation') || null,
    customerName, ownerName, propertyDescription,
    amountCents, throughDate, releaseDate: today,
    signerName: text(user?.username), signerTitle: lastTitle?.signerTitle ?? '',
    conditionKind: conditional ? 'funds' : null,
    checkMaker: conditional ? customerName : '',
    exceptions: '',
    source, warnings,
  } as LienReleasePrefill;
}

/**
 * Spec §6.4: a new release with the same values, unconditional, pointing back at
 * the conditional one. Linked to a pay app or invoice, the amount is refreshed to
 * the payments received. The conditional release is left as it is.
 */
export function makeUnconditional(
  db: Database.Database, id: string, userId?: string | null,
): { id: string; number: string; version: number } {
  const from = getLienRelease(db, id);
  if (!from) throw new NotFoundError('Lien release not found');
  if (!from.conditional) throw new ValidationError('This release is already unconditional');
  let amountCents = from.amountCents;
  if (from.sourceType && from.sourceId) {
    const received = paymentsFor(db, from.sourceType, from.sourceId).reduce((a, p) => a + toCents(p.amount), 0);
    if (received > 0) amountCents = received;
  }
  const today = ymd(new Date());
  return createLienRelease(db, from.projectId, {
    paymentType: from.paymentType, conditional: false,
    sourceType: from.sourceType, sourceId: from.sourceId, supersedesId: from.id,
    lienorName: from.lienorName, lienorEntityType: from.lienorEntityType, lienorState: from.lienorState, customerName: from.customerName, ownerName: from.ownerName,
    propertyDescription: from.propertyDescription, amountCents,
    // Today can be earlier than a through date typed ahead of time; keep the rule.
    throughDate: from.throughDate && from.throughDate > today ? today : from.throughDate,
    releaseDate: today,
    signerName: from.signerName, signerTitle: from.signerTitle,
    exceptions: from.exceptions,
    // Signing gives up lien rights: the signature stamp is a deliberate choice on each release.
    signatureFileId: null,
  }, userId);
}

/** Subject and body for the item send (spec §6.6); the client composer uses the same text. */
export function lienReleaseSendDefaults(r: Pick<LienReleaseRow, 'paymentType' | 'conditional'>, projectName: string): { subject: string; body: string } {
  const type = r.paymentType === 'final' ? 'Final' : 'Progress';
  return {
    subject: `${r.conditional ? 'Conditional ' : ''}Waiver and Release of Lien upon ${type} Payment — ${projectName}`,
    body: `Please find attached our ${r.conditional ? 'conditional ' : ''}waiver and release of lien for ${projectName}.`,
  };
}
