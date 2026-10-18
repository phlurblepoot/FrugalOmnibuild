// server/aiaStore.ts
//
// AIA progress billing (G702/G703) — Schedule of Values.
// All money is INTEGER CENTS (scheduledValueCents is an INTEGER column).
// Every numeric input is guarded with Number.isFinite / Number.isInteger
// because Phase 4a had float-corruption bugs from missing guards.
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

// Thrown by every SOV mutator once the schedule of values is finalized.
// Routes map it to 409 { code: 'sov_locked' }.
export class SovLockedError extends Error {
  constructor() { super('Schedule of values is finalized — reopen it to make changes'); }
}

export type SovLockReason = 'manual' | 'pay-app';
export interface SovLock { projectId: string; lockedAt: number; lockedByUserId: string | null; reason: SovLockReason }

export function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

export const SOV_LINE_TYPES = ['item', 'header', 'blank'] as const;
export type SovLineType = typeof SOV_LINE_TYPES[number];

interface SovLineInput {
  lineType?: SovLineType;
  itemNo?: string | null;
  description?: string;
  scheduledValueCents?: number;
  retainagePercent?: number | null;
  isChangeOrder?: boolean | number;
  changeOrderId?: string | null;
  // Contract-line id to insert in front of (Task 5). Ignored on save.
  insertBeforeId?: string | null;
}

// Validate the money + retainage fields shared by create/save. Returns the
// normalised retainagePercent (null when absent).
function validateScheduledValueCents(cents: any): number {
  if (!Number.isInteger(cents) || !Number.isFinite(cents) || cents < 0) {
    throw new ValidationError('scheduledValueCents must be a non-negative integer (cents)');
  }
  return cents;
}

function validateRetainagePercent(pct: any): number | null {
  if (pct === undefined || pct === null) return null;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError('retainagePercent must be a number between 0 and 100');
  }
  return pct;
}

// One place decides what each line type may carry. Headers/blanks are
// rejected — not silently zeroed — when money or retainage is sent, so a
// client bug cannot smuggle value into a row every total ignores.
function normalizeLineInput(input: SovLineInput, lineType: SovLineType): {
  lineType: SovLineType; itemNo: string | null; description: string; cents: number; retainage: number | null;
} {
  if (!(SOV_LINE_TYPES as readonly string[]).includes(lineType)) throw new ValidationError('lineType must be item, header or blank');
  if (lineType === 'item') {
    if (typeof input.description !== 'string') throw new ValidationError('description is required');
    return {
      lineType, itemNo: input.itemNo ?? null, description: input.description,
      cents: validateScheduledValueCents(input.scheduledValueCents),
      retainage: validateRetainagePercent(input.retainagePercent),
    };
  }
  if (input.scheduledValueCents !== undefined && input.scheduledValueCents !== 0) throw new ValidationError(`a ${lineType} line cannot carry a scheduled value`);
  if (input.retainagePercent !== undefined && input.retainagePercent !== null) throw new ValidationError(`a ${lineType} line cannot carry retainage`);
  if (input.isChangeOrder) throw new ValidationError(`a ${lineType} line cannot be a change order`);
  if (lineType === 'header') {
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new ValidationError('a header line needs a description');
    return { lineType, itemNo: input.itemNo ?? null, description, cents: 0, retainage: null };
  }
  return { lineType, itemNo: null, description: '', cents: 0, retainage: null };
}

export function getSovLine(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM aia_sov_lines WHERE id = ?').get(id) as any;
  return row ?? null;
}

export function listSovLines(db: Database.Database, projectId: string): any[] {
  return db.prepare(
    'SELECT * FROM aia_sov_lines WHERE projectId = ? ORDER BY sortOrder ASC, createdAt ASC, rowid ASC'
  ).all(projectId) as any[];
}

// Every pay application's G702/G703 is computed live from the project's schedule
// of values, so ANY SOV edit changes what a stored pay-app Excel should say even
// though no aia_pay_apps row moved. updatedAt is the clock the generated-document
// "up to date" chip compares the stored file's createdAt against, so stamping the
// apps here is what makes an out-of-date export announce itself (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout).
function touchProjectPayApps(db: Database.Database, projectId: string, now: number): void {
  db.prepare('UPDATE aia_pay_apps SET updatedAt = ? WHERE projectId = ?').run(now, projectId);
}

// ---------------------------------------------------------------------------
// SOV lock (spec 2026-09-11 §Lock). A row in aia_sov_locks = finalized. Every
// mutator below calls assertSovEditable first; syncChangeOrders deliberately
// does NOT (an approved change order appends a CO line — that is how a G703
// grows — and it never touches existing lines).
// ---------------------------------------------------------------------------
export function getSovLock(db: Database.Database, projectId: string): SovLock | null {
  const row = db.prepare('SELECT projectId, lockedAt, lockedByUserId, reason FROM aia_sov_locks WHERE projectId = ?').get(projectId) as SovLock | undefined;
  return row ?? null;
}

// Idempotent: an existing lock is returned untouched so the FIRST cause
// (manual vs pay-app) is what the UI reports.
export function lockSov(db: Database.Database, projectId: string, opts: { userId: string | null; reason: SovLockReason }): SovLock {
  requireProject(db, projectId);
  const existing = getSovLock(db, projectId);
  if (existing) return existing;
  const lock: SovLock = { projectId, lockedAt: Date.now(), lockedByUserId: opts.userId ?? null, reason: opts.reason };
  db.prepare('INSERT INTO aia_sov_locks (projectId, lockedAt, lockedByUserId, reason) VALUES (?, ?, ?, ?)')
    .run(lock.projectId, lock.lockedAt, lock.lockedByUserId, lock.reason);
  return lock;
}

// Reopening makes every stored export potentially stale — the admin was warned.
export function unlockSov(db: Database.Database, projectId: string): void {
  requireProject(db, projectId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM aia_sov_locks WHERE projectId = ?').run(projectId);
    touchProjectPayApps(db, projectId, Date.now());
  });
  tx();
}

export function assertSovEditable(db: Database.Database, projectId: string): void {
  if (getSovLock(db, projectId)) throw new SovLockedError();
}

export function createSovLine(db: Database.Database, projectId: string, input: SovLineInput): { id: string } {
  requireProject(db, projectId);
  assertSovEditable(db, projectId);
  const n = normalizeLineInput(input, input.lineType ?? 'item');
  const isCO = input.isChangeOrder ? 1 : 0;
  const id = crypto.randomUUID();
  const now = Date.now();
  const tx = db.transaction(() => {
    const before = input.insertBeforeId ?? null;
    if (before) {
      const target = db.prepare('SELECT projectId, isChangeOrder FROM aia_sov_lines WHERE id = ?').get(before) as { projectId: string; isChangeOrder: number } | undefined;
      if (!target || target.projectId !== projectId || target.isChangeOrder) throw new ValidationError('insertBeforeId must be a contract line of this project');
    }
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM aia_sov_lines WHERE projectId = ?').get(projectId) as any).m;
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt, lineType) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, projectId, n.itemNo, n.description, n.cents, n.retainage, isCO, input.changeOrderId ?? null, max + 1, now, n.lineType);
    if (before) {
      // Renumber from the canonical order with the new id moved in front of
      // the target — robust to existing sortOrder ties.
      const ids = contractIdsInOrder(db, projectId).filter(x => x !== id);
      ids.splice(ids.indexOf(before), 0, id);
      renumberContract(db, projectId, ids);
    }
    touchProjectPayApps(db, projectId, now);
  });
  tx();
  return { id };
}

export function saveSovLine(db: Database.Database, id: string, input: SovLineInput & { version?: number }): { version: number } {
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new ValidationError('Missing or invalid version — reload the line');
  }
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version, projectId, lineType FROM aia_sov_lines WHERE id = ?').get(id) as { version: number; projectId: string; lineType: SovLineType } | undefined;
    if (!row) throw new NotFoundError('SOV line not found');
    assertSovEditable(db, row.projectId);
    if (row.version !== input.version) throw new ConflictError(`SOV line changed since it was loaded (server v${row.version}, payload v${input.version})`);
    const n = normalizeLineInput(input, input.lineType ?? row.lineType ?? 'item');
    newVersion = row.version + 1;
    db.prepare('UPDATE aia_sov_lines SET itemNo = ?, description = ?, scheduledValueCents = ?, retainagePercent = ?, lineType = ?, version = ? WHERE id = ?')
      .run(n.itemNo, n.description, n.cents, n.retainage, n.lineType, newVersion, id);
    touchProjectPayApps(db, row.projectId, Date.now());
  });
  tx();
  return { version: newVersion };
}

export function deleteSovLine(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    // Read the owning project before the row goes: the delete reshapes every
    // pay app's G703 just as much as an edit does.
    const row = db.prepare('SELECT projectId FROM aia_sov_lines WHERE id = ?').get(id) as { projectId: string } | undefined;
    if (row) assertSovEditable(db, row.projectId);
    db.prepare('DELETE FROM aia_sov_lines WHERE id = ?').run(id);
    if (row) touchProjectPayApps(db, row.projectId, Date.now());
  });
  tx();
}

interface SeedLine { description?: string; scheduledValueCents?: number; itemNo?: string | null; }

// Replace the project's estimate-derived (non-change-order) SOV lines with a
// fresh set from the client estimate computation. Existing change-order lines
// (isChangeOrder=1) are KEPT and re-sorted to follow the new estimate lines.
export function seedSovLines(db: Database.Database, projectId: string, lines: SeedLine[]): { count: number } {
  requireProject(db, projectId);
  assertSovEditable(db, projectId);
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  // Validate up front so a bad line aborts before any write.
  const prepared = lines.map((l, i) => {
    const cents = validateScheduledValueCents(l.scheduledValueCents);
    return {
      itemNo: l.itemNo ?? String(i + 1),
      description: typeof l.description === 'string' ? l.description : '',
      scheduledValueCents: cents,
      sortOrder: i,
    };
  });
  const now = Date.now();
  const tx = db.transaction(() => {
    // Drop old estimate lines; keep change-order lines.
    db.prepare('DELETE FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0').run(projectId);
    const ins = db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, 1, ?)'
    );
    for (const p of prepared) {
      ins.run(crypto.randomUUID(), projectId, p.itemNo, p.description, p.scheduledValueCents, p.sortOrder, now);
    }
    // Re-sort the kept change-order lines to follow the new estimate block.
    let next = prepared.length;
    const cos = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 1 ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as { id: string }[];
    const upd = db.prepare('UPDATE aia_sov_lines SET sortOrder = ? WHERE id = ?');
    for (const co of cos) upd.run(next++, co.id);
    touchProjectPayApps(db, projectId, now);
  });
  tx();
  return { count: prepared.length };
}

// The complete order of the project's CONTRACT lines (every non-CO line
// exactly once). CO lines always follow the contract block, in their existing
// order — the editor and export partition on isChangeOrder anyway, this just
// keeps sortOrder honest.
export function reorderSovLines(db: Database.Database, projectId: string, ids: unknown): void {
  requireProject(db, projectId);
  assertSovEditable(db, projectId);
  if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) throw new ValidationError('ids must be an array of line ids');
  const ordered = ids as string[];
  const tx = db.transaction(() => {
    const contract = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0').all(projectId) as { id: string }[];
    const expected = new Set(contract.map(c => c.id));
    if (ordered.length !== expected.size || new Set(ordered).size !== ordered.length || ordered.some(id => !expected.has(id))) {
      throw new ValidationError('ids must list every contract line exactly once');
    }
    renumberContract(db, projectId, ordered);
    touchProjectPayApps(db, projectId, Date.now());
  });
  tx();
}

// Assign sortOrder 0..n-1 to the given contract ids, then the CO lines after
// them in their existing order. Callers hold the transaction.
function renumberContract(db: Database.Database, projectId: string, orderedContractIds: string[]): void {
  const upd = db.prepare('UPDATE aia_sov_lines SET sortOrder = ? WHERE id = ?');
  orderedContractIds.forEach((id, i) => upd.run(i, id));
  let next = orderedContractIds.length;
  const cos = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 1 ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as { id: string }[];
  for (const co of cos) upd.run(next++, co.id);
}

// Contract line ids in canonical order (same ORDER BY as listSovLines).
function contractIdsInOrder(db: Database.Database, projectId: string): string[] {
  return (db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0 ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as { id: string }[]).map(r => r.id);
}

export interface SovSplitPart { description: string; percent: number }

// Turn one item line into a header with N item children whose values are
// percentages of the original. Percents are compared in basis points (2 dp)
// and must total exactly 100.00; cents are rounded per child with the LAST
// child taking the remainder so the children always sum to the original.
export function splitSovLine(db: Database.Database, id: string, input: { version?: number; parts?: unknown }): { headerId: string; childIds: string[] } {
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the line');
  if (!Array.isArray(input.parts) || input.parts.length < 2 || input.parts.length > 50) throw new ValidationError('Provide between 2 and 50 parts');
  const parts = (input.parts as any[]).map((p, i) => {
    const description = typeof p?.description === 'string' ? p.description.trim() : '';
    if (!description) throw new ValidationError(`Part ${i + 1} needs a description`);
    const percent = Number(p?.percent);
    if (!Number.isFinite(percent) || percent <= 0) throw new ValidationError(`Part ${i + 1} needs a percentage above 0`);
    return { description, bp: Math.round(percent * 100) };
  });
  const totalBp = parts.reduce((a, p) => a + p.bp, 0);
  if (totalBp !== 10000) throw new ValidationError('Percentages must add up to exactly 100');

  const childIds: string[] = [];
  const now = Date.now();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM aia_sov_lines WHERE id = ?').get(id) as any;
    if (!row) throw new NotFoundError('SOV line not found');
    assertSovEditable(db, row.projectId);
    if (row.version !== input.version) throw new ConflictError(`SOV line changed since it was loaded (server v${row.version}, payload v${input.version})`);
    if (row.isChangeOrder) throw new ValidationError('Change-order lines cannot be split');
    if ((row.lineType ?? 'item') !== 'item') throw new ValidationError('Only item lines can be split');

    const original: number = row.scheduledValueCents;
    let allocated = 0;
    const ins = db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt, lineType) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, 1, ?, ?)'
    );
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const cents = last ? original - allocated : Math.round(original * p.bp / 10000);
      allocated += cents;
      const childId = crypto.randomUUID();
      childIds.push(childId);
      ins.run(childId, row.projectId, row.itemNo ? `${row.itemNo}.${i + 1}` : null, p.description, cents, row.retainagePercent, now + i, 'item');
    });
    db.prepare("UPDATE aia_sov_lines SET lineType = 'header', scheduledValueCents = 0, retainagePercent = NULL, version = ? WHERE id = ?")
      .run(row.version + 1, id);

    // Children directly after the parent; everything else keeps its order.
    const ids = contractIdsInOrder(db, row.projectId).filter(x => !childIds.includes(x));
    ids.splice(ids.indexOf(id) + 1, 0, ...childIds);
    renumberContract(db, row.projectId, ids);
    touchProjectPayApps(db, row.projectId, now);
  });
  tx();
  return { headerId: id, childIds };
}

// Append a SOV line for every approved change_order that isn't already mirrored
// in the schedule of values. Idempotent — re-running adds 0.
export function syncChangeOrders(db: Database.Database, projectId: string): { added: number } {
  requireProject(db, projectId);
  let added = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    const cos = db.prepare(
      `SELECT id, number, title, description, amount FROM change_orders WHERE projectId = ? AND status = 'approved'`
    ).all(projectId) as { id: string; number: string | null; title: string | null; description: string | null; amount: number | null }[];
    const ins = db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, 1, ?)'
    );
    for (const co of cos) {
      const exists = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND changeOrderId = ?').get(projectId, co.id);
      if (exists) continue;
      const amount = Number.isFinite(co.amount) ? (co.amount as number) : 0;
      const cents = Math.round(amount * 100);
      const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM aia_sov_lines WHERE projectId = ?').get(projectId) as any).m;
      ins.run(
        crypto.randomUUID(),
        projectId,
        'CO-' + (co.number ?? ''),
        co.title?.trim() || co.description || '',
        cents,
        co.id,
        max + 1,
        now,
      );
      added++;
    }
    // Idempotent by design (re-running adds 0), so only a real insert counts as
    // a change — an unconditional stamp would re-stale every export each time
    // the billing screen resyncs.
    if (added > 0) touchProjectPayApps(db, projectId, now);
  });
  tx();
  return { added };
}

// ---------------------------------------------------------------------------
// Pay applications (G702/G703)
// ---------------------------------------------------------------------------

interface PayAppInput {
  periodTo?: string | null;
  applicationDate?: string | null;
  retainagePercent?: number;
  storedRetainagePercent?: number;
}

interface PayAppPatch {
  status?: string;
  periodTo?: string | null;
  applicationDate?: string | null;
  retainagePercent?: number;
  storedRetainagePercent?: number;
  releasedRetainagePoints?: number;
}

interface PayAppLineInput {
  sovLineId: string;
  percentComplete: number;
  storedMaterialsCents: number;
}

const DEFAULT_RETAINAGE = 10;

// Validate a retainage percent that is REQUIRED (defaults applied by caller).
function requireRetainagePercent(pct: any, field: string): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError(`${field} must be a finite number between 0 and 100`);
  }
  return pct;
}

function validatePercentComplete(pct: any): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError('percentComplete must be a finite number between 0 and 100');
  }
  return pct;
}

function validateStoredMaterialsCents(cents: any): number {
  if (!Number.isInteger(cents) || !Number.isFinite(cents) || cents < 0) {
    throw new ValidationError('storedMaterialsCents must be a non-negative integer (cents)');
  }
  return cents;
}

// Create a pay application. number = MAX(number)+1 for the project (1 if none).
// Seeds a pay_app_line for every current SOV line, carrying forward the prior
// app's percentComplete + storedMaterialsCents (0/0 if no prior app / new line).
export function createPayApp(db: Database.Database, projectId: string, input: PayAppInput): { id: string; number: number } {
  requireProject(db, projectId);
  const retainagePercent = requireRetainagePercent(
    input.retainagePercent ?? DEFAULT_RETAINAGE, 'retainagePercent');
  // Single-rate world: one base rate covers work AND stored materials. The
  // stored rate is still snapshotted per app so legacy readers (and the G702's
  // separate 5a/5b lines) stay coherent, and so a caller that genuinely wants
  // a distinct historical stored rate can still send one.
  const storedRetainagePercent = requireRetainagePercent(
    input.storedRetainagePercent ?? retainagePercent, 'storedRetainagePercent');
  const id = crypto.randomUUID();
  let number = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    // Spec: the first application finalizes the SOV. Idempotent, so a manual
    // lock keeps its cause.
    lockSov(db, projectId, { userId: null, reason: 'pay-app' });
    number = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM aia_pay_apps WHERE projectId = ?').get(projectId) as any).m + 1;
    db.prepare(
      'INSERT INTO aia_pay_apps (id, projectId, number, periodTo, applicationDate, retainagePercent, storedRetainagePercent, status, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, projectId, number, input.periodTo ?? null, input.applicationDate ?? null, retainagePercent, storedRetainagePercent, 'draft', now, now);

    // Prior app (number-1) lines indexed by sovLineId for carry-forward.
    const prior = db.prepare('SELECT id FROM aia_pay_apps WHERE projectId = ? AND number = ?').get(projectId, number - 1) as { id: string } | undefined;
    const priorLines = new Map<string, { percentComplete: number; storedMaterialsCents: number }>();
    if (prior) {
      const rows = db.prepare('SELECT sovLineId, percentComplete, storedMaterialsCents FROM aia_pay_app_lines WHERE payAppId = ?').all(prior.id) as any[];
      for (const r of rows) priorLines.set(r.sovLineId, { percentComplete: r.percentComplete, storedMaterialsCents: r.storedMaterialsCents });
    }

    const sovLines = db.prepare("SELECT id FROM aia_sov_lines WHERE projectId = ? AND lineType = 'item' ORDER BY sortOrder ASC, createdAt ASC, rowid ASC").all(projectId) as { id: string }[];
    const ins = db.prepare('INSERT INTO aia_pay_app_lines (id, payAppId, sovLineId, percentComplete, storedMaterialsCents, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    for (const sov of sovLines) {
      const carry = priorLines.get(sov.id) ?? { percentComplete: 0, storedMaterialsCents: 0 };
      ins.run(crypto.randomUUID(), id, sov.id, carry.percentComplete, carry.storedMaterialsCents, now);
    }
  });
  tx();
  return { id, number };
}

// Raw pay-app rows for a project, no derived money fields.
export function listPayAppRows(db: Database.Database, projectId: string): any[] {
  return db.prepare('SELECT * FROM aia_pay_apps WHERE projectId = ? ORDER BY number ASC').all(projectId) as any[];
}

// Sum of payments recorded against a pay app, in cents. Mirrors
// billingStore.paidCentsFor(db, 'payapp', id) — duplicated locally (not
// imported) so aiaStore never depends on billingStore, which itself depends
// on aiaStore; keep the rounding in sync if it ever changes there.
function paidPayAppCents(db: Database.Database, payAppId: string): number {
  const rows = db.prepare('SELECT amount FROM payments WHERE targetType = ? AND targetId = ?').all('payapp', payAppId) as { amount: number }[];
  return rows.reduce((acc, p) => acc + Math.round((Number(p.amount) || 0) * 100), 0);
}

export function listPayApps(db: Database.Database, projectId: string): any[] {
  const rows = listPayAppRows(db, projectId);
  return rows.map(r => {
    // Mirrors billingStore.listBilledDocuments' payapp computation: total is
    // G702 L8 (current payment due), paid is the payments sum, and a draft
    // app (not yet billed) reports balanceCents null instead of a number —
    // total/paid stay live so drafts are still useful to read while editing.
    const totalCents = computeG702(db, r.id).L8currentPaymentDueCents;
    const paidCents = paidPayAppCents(db, r.id);
    const balanceCents = r.status === 'draft' ? null : totalCents - paidCents;
    return { ...r, totalCents, paidCents, balanceCents };
  });
}

export function getPayApp(db: Database.Database, id: string): any | null {
  const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(id) as any;
  if (!app) return null;
  const lines = db.prepare('SELECT * FROM aia_pay_app_lines WHERE payAppId = ?').all(id) as any[];
  // Same shape getInvoice embeds (server/billingStore.ts) — same field names,
  // just the payapp target type.
  const payments = db.prepare(
    "SELECT id, date, amount, method, note FROM payments WHERE targetType = 'payapp' AND targetId = ? ORDER BY date"
  ).all(id);
  return { ...app, lines, payments };
}

// Version-checked (on the pay app) upsert of pay_app_lines. Validates each line,
// upserts by payAppId+sovLineId, bumps the app version.
export function savePayAppLines(db: Database.Database, payAppId: string, lines: PayAppLineInput[], version: number): { version: number } {
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError('Missing or invalid version — reload the pay application');
  }
  // Validate every line up front so a bad line aborts before any write.
  const prepared = lines.map((l) => {
    if (typeof l.sovLineId !== 'string' || !l.sovLineId) throw new ValidationError('sovLineId is required');
    return {
      sovLineId: l.sovLineId,
      percentComplete: validatePercentComplete(l.percentComplete),
      storedMaterialsCents: validateStoredMaterialsCents(l.storedMaterialsCents),
    };
  });
  let newVersion = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    const app = db.prepare('SELECT version, projectId, number FROM aia_pay_apps WHERE id = ?').get(payAppId) as
      { version: number; projectId: string; number: number } | undefined;
    if (!app) throw new NotFoundError('Pay application not found');
    if (app.version !== version) throw new ConflictError(`Pay application changed since it was loaded (server v${app.version}, payload v${version})`);
    const upd = db.prepare('UPDATE aia_pay_app_lines SET percentComplete = ?, storedMaterialsCents = ? WHERE payAppId = ? AND sovLineId = ?');
    const ins = db.prepare('INSERT INTO aia_pay_app_lines (id, payAppId, sovLineId, percentComplete, storedMaterialsCents, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    const typeOf = db.prepare('SELECT lineType FROM aia_sov_lines WHERE id = ?');
    for (const p of prepared) {
      // Header/blank rows have no inputs; a payload that names one is ignored.
      const sov = typeOf.get(p.sovLineId) as { lineType: SovLineType } | undefined;
      if (sov && sov.lineType !== 'item') continue;
      const r = upd.run(p.percentComplete, p.storedMaterialsCents, payAppId, p.sovLineId);
      if (r.changes === 0) {
        ins.run(crypto.randomUUID(), payAppId, p.sovLineId, p.percentComplete, p.storedMaterialsCents, now);
      }
    }
    newVersion = app.version + 1;
    db.prepare('UPDATE aia_pay_apps SET version = ?, updatedAt = ? WHERE id = ?').run(newVersion, now, payAppId);
    // "Less previous certificates" on every LATER application is the sum of the
    // work billed before it, so editing this app's lines changes their G702 too.
    db.prepare('UPDATE aia_pay_apps SET updatedAt = ? WHERE projectId = ? AND number > ?')
      .run(now, app.projectId, app.number);
  });
  tx();
  return { version: newVersion };
}

// Patch pay-app header fields; bump version. Validates retainage when supplied.
export function setPayApp(db: Database.Database, id: string, patch: PayAppPatch): { version: number } {
  if (patch.retainagePercent !== undefined) requireRetainagePercent(patch.retainagePercent, 'retainagePercent');
  if (patch.storedRetainagePercent !== undefined) requireRetainagePercent(patch.storedRetainagePercent, 'storedRetainagePercent');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(id) as any;
    if (!app) throw new NotFoundError('Pay application not found');
    // Released points are bounded by what earlier apps have not already
    // released — the check reads the current chain, so it runs in the tx.
    if (patch.releasedRetainagePoints !== undefined) {
      const pts = patch.releasedRetainagePoints as any;
      if (!Number.isFinite(pts) || pts < 0) {
        throw new ValidationError('releasedRetainagePoints must be a finite number of percentage points ≥ 0');
      }
      // Compare with an epsilon: `remaining` is a float subtraction (e.g.
      // 15 - 8.05 = 6.949999999999999), so an exact `>` would reject the very
      // value the UI reports as remaining.
      const remaining = remainingReleasablePoints(db, id);
      if (pts > remaining + 1e-9) {
        throw new ValidationError(`Cannot release ${pts} points — only ${+remaining.toFixed(4)} remain on this application`);
      }
    }
    const status = patch.status !== undefined ? patch.status : app.status;
    const periodTo = patch.periodTo !== undefined ? patch.periodTo : app.periodTo;
    const applicationDate = patch.applicationDate !== undefined ? patch.applicationDate : app.applicationDate;
    const retainagePercent = patch.retainagePercent !== undefined ? patch.retainagePercent : app.retainagePercent;
    const storedRetainagePercent = patch.storedRetainagePercent !== undefined ? patch.storedRetainagePercent : app.storedRetainagePercent;
    const releasedRetainagePoints = patch.releasedRetainagePoints !== undefined
      ? patch.releasedRetainagePoints : app.releasedRetainagePoints;
    newVersion = app.version + 1;
    db.prepare('UPDATE aia_pay_apps SET status = ?, periodTo = ?, applicationDate = ?, retainagePercent = ?, storedRetainagePercent = ?, releasedRetainagePoints = ?, version = ?, updatedAt = ? WHERE id = ?')
      .run(status, periodTo, applicationDate, retainagePercent, storedRetainagePercent, releasedRetainagePoints, newVersion, Date.now(), id);
  });
  tx();
  return { version: newVersion };
}

export function deletePayApp(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    // Its payments go with it, and their attachment rows (migration 43) first.
    db.prepare("DELETE FROM payment_attachments WHERE paymentId IN (SELECT id FROM payments WHERE targetType = 'payapp' AND targetId = ?)").run(id);
    db.prepare("DELETE FROM payments WHERE targetType = 'payapp' AND targetId = ?").run(id);
    db.prepare('DELETE FROM aia_pay_app_lines WHERE payAppId = ?').run(id);
    db.prepare('DELETE FROM aia_pay_apps WHERE id = ?').run(id);
  });
  tx();
}

// ---------------------------------------------------------------------------
// G703 (continuation sheet) / G702 (application summary) computation.
// ALL money returned as INTEGER CENTS. Rounding happens PER LINE with
// Math.round — never sum-then-round in a way that drifts.
// ---------------------------------------------------------------------------

export interface G703Row {
  sovLineId: string;
  itemNo: string | null;
  description: string;
  isChangeOrder: number;
  lineType: SovLineType;
  scheduledValueCents: number;     // C
  previousCents: number;           // D
  thisPeriodCents: number;         // E
  storedCents: number;             // F
  totalToDateCents: number;        // G
  percentComplete: number;
  balanceToFinishCents: number;
  retainageCents: number;
}

// ---------------------------------------------------------------------------
// Retainage mode + releases.
//
// A release is recorded as percentage POINTS on the app that releases them.
// The effective rate on app N is base − Σ points over apps with number ≤ N,
// floored at 0, so released dollars fall out of L5, lift L6 and get paid via
// L8 — the L6/L7 chaining itself never had to change.
// ---------------------------------------------------------------------------

export type RetainageMode = 'uniform' | 'perLine';

// Percentage POINTS are floats (15 - 8.05 = 6.949999999999999), so the figures
// REPORTED to clients are rounded to 4 decimals — enough for any real retainage
// rate, and it keeps the UI from printing float residue. The internal math is
// never rounded; only this reported block is.
const round4 = (n: number): number => +n.toFixed(4);

// Read project.meta.aiaSettings.retainageMode.
//   'perLine' → per-line rates, base as the fallback for blank lines
//   'uniform' → base rate only; stray values left in the per-line column are
//               ignored, because the toggle is authoritative, not the data
//   absent    → LEGACY. Keeps today's `line ?? base` math so no historical pay
//               app silently recomputes on projects that used the per-line
//               column (it was the primary input before this rework). The
//               reported mode then follows the data: 'perLine' if any line
//               carries a rate, else 'uniform'. Saving AIA settings once
//               writes an explicit mode and pins the behavior.
function resolveRetainageMode(
  db: Database.Database, projectId: string, sovLines: any[]
): { mode: RetainageMode; legacyFallback: boolean } {
  const row = db.prepare('SELECT meta FROM projects WHERE id = ?').get(projectId) as { meta: string | null } | undefined;
  let stored: unknown;
  try { stored = row?.meta ? JSON.parse(row.meta)?.aiaSettings?.retainageMode : undefined; }
  catch { stored = undefined; } // unparseable meta must not break billing math
  if (stored === 'perLine') return { mode: 'perLine', legacyFallback: false };
  if (stored === 'uniform') return { mode: 'uniform', legacyFallback: false };
  const hasLineRates = sovLines.some(l => l.retainagePercent !== null && l.retainagePercent !== undefined);
  return { mode: hasLineRates ? 'perLine' : 'uniform', legacyFallback: true };
}

type ComputeContext = ReturnType<typeof loadComputeContext>;

// Effective retainage rate for one SOV line after cumulative releases. Uniform
// mode ignores any stray per-line value so the SOV toggle is authoritative.
function effectiveWorkPct(ctx: ComputeContext, sovLine: any): number {
  const usePerLine = ctx.mode === 'perLine' || ctx.legacyFallback;
  const base = usePerLine ? (sovLine.retainagePercent ?? ctx.app.retainagePercent) : ctx.app.retainagePercent;
  return Math.max(0, base - ctx.cumulativeReleasedPoints);
}

// New apps write storedRetainagePercent = retainagePercent, so this one rule
// covers both worlds: legacy two-rate apps (cumulative 0) compute exactly as
// before, and new apps release stored retainage at the same single rate.
function effectiveStoredPct(ctx: ComputeContext): number {
  return Math.max(0, ctx.app.storedRetainagePercent - ctx.cumulativeReleasedPoints);
}

// Points still releasable on this app BEFORE its own release — i.e. the base
// (the largest relevant base in perLine mode) less everything released on
// STRICTLY PRIOR apps. Floored at 0. "Release all remaining" sends this value.
//
// In perLine mode the ceiling is max(app base, line rates) — deliberately more
// permissive than a strict max-over-lines when every line sits below the app
// base. Harmless: per-line clamping (effectiveWorkPct floors at 0) holds those
// lines' retainage dollars at 0 regardless, and keeping the app base in the
// ceiling means a line ADDED LATER at the base rate can still be released
// against instead of being permanently locked out by an earlier low ceiling.
export function remainingReleasablePoints(db: Database.Database, payAppId: string): number {
  const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(payAppId) as any;
  if (!app) throw new NotFoundError('Pay application not found');
  const before = (db.prepare(
    'SELECT COALESCE(SUM(releasedRetainagePoints), 0) s FROM aia_pay_apps WHERE projectId = ? AND number < ?'
  ).get(app.projectId, app.number) as any).s as number;

  const sovLines = db.prepare('SELECT * FROM aia_sov_lines WHERE projectId = ?').all(app.projectId) as any[];
  const { mode, legacyFallback } = resolveRetainageMode(db, app.projectId, sovLines);
  let base = app.retainagePercent;
  if (mode === 'perLine' || legacyFallback) {
    for (const l of sovLines) {
      const rate = l.retainagePercent ?? app.retainagePercent;
      if (rate > base) base = rate;
    }
  }
  return Math.max(0, base - before);
}

// Internal: load an app + its SOV lines (in SOV sort order) joined to this app's
// pay_app_lines and the prior app's pay_app_lines, ready for column math.
function loadComputeContext(db: Database.Database, payAppId: string) {
  const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(payAppId) as any;
  if (!app) throw new NotFoundError('Pay application not found');

  const sovLines = db.prepare('SELECT * FROM aia_sov_lines WHERE projectId = ? ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(app.projectId) as any[];

  const thisLines = new Map<string, any>();
  for (const l of db.prepare('SELECT * FROM aia_pay_app_lines WHERE payAppId = ?').all(payAppId) as any[]) {
    thisLines.set(l.sovLineId, l);
  }

  // Prior app (number-1) — for column D (previous) per line.
  const prior = db.prepare('SELECT id FROM aia_pay_apps WHERE projectId = ? AND number = ?').get(app.projectId, app.number - 1) as { id: string } | undefined;
  const priorLines = new Map<string, any>();
  if (prior) {
    for (const l of db.prepare('SELECT * FROM aia_pay_app_lines WHERE payAppId = ?').all(prior.id) as any[]) {
      priorLines.set(l.sovLineId, l);
    }
  }

  // Retainage releases: everything released on apps up to AND INCLUDING this
  // one is already off this app's rate (same number-chaining population the
  // L6/L7 recursion walks; draft vs finalized does not affect the sum).
  const cumulativeReleasedPoints = (db.prepare(
    'SELECT COALESCE(SUM(releasedRetainagePoints), 0) s FROM aia_pay_apps WHERE projectId = ? AND number <= ?'
  ).get(app.projectId, app.number) as any).s as number;
  const { mode, legacyFallback } = resolveRetainageMode(db, app.projectId, sovLines);

  return {
    app, sovLines, thisLines, priorLines, priorId: prior?.id ?? null,
    mode, legacyFallback,
    cumulativeReleasedPoints,
    releasedThisApp: app.releasedRetainagePoints ?? 0,
  };
}

export function computeG703(db: Database.Database, payAppId: string): G703Row[] {
  const ctx = loadComputeContext(db, payAppId);
  const { sovLines, thisLines, priorLines } = ctx;
  const storedPct = effectiveStoredPct(ctx);
  const rows: G703Row[] = [];
  for (const sov of sovLines) {
    if (sov.lineType && sov.lineType !== 'item') {
      rows.push({
        sovLineId: sov.id, itemNo: sov.itemNo, description: sov.description, isChangeOrder: sov.isChangeOrder,
        lineType: sov.lineType, scheduledValueCents: 0, previousCents: 0, thisPeriodCents: 0, storedCents: 0,
        totalToDateCents: 0, percentComplete: 0, balanceToFinishCents: 0, retainageCents: 0,
      });
      continue;
    }
    const scheduledValueCents = sov.scheduledValueCents;
    const thisLine = thisLines.get(sov.id);
    const percentComplete = thisLine ? thisLine.percentComplete : 0;
    const storedCents = thisLine ? thisLine.storedMaterialsCents : 0;

    const completedToDateCents = Math.round(scheduledValueCents * percentComplete / 100);

    const priorLine = priorLines.get(sov.id);
    const priorPercent = priorLine ? priorLine.percentComplete : 0;
    // AIA G703 col D = prior application's (D+E) = work completed only; stored materials (col F) are 'presently stored', NOT included in D. Intentional.
    const previousCents = priorLine ? Math.round(scheduledValueCents * priorPercent / 100) : 0;

    const thisPeriodCents = completedToDateCents - previousCents;
    const totalToDateCents = completedToDateCents + storedCents;
    const balanceToFinishCents = scheduledValueCents - totalToDateCents;

    const retainageCents =
      Math.round(completedToDateCents * effectiveWorkPct(ctx, sov) / 100) +
      Math.round(storedCents * storedPct / 100);

    rows.push({
      sovLineId: sov.id,
      itemNo: sov.itemNo,
      description: sov.description,
      isChangeOrder: sov.isChangeOrder,
      lineType: (sov.lineType ?? 'item') as SovLineType,
      scheduledValueCents,
      previousCents,
      thisPeriodCents,
      storedCents,
      totalToDateCents,
      percentComplete,
      balanceToFinishCents,
      retainageCents,
    });
  }
  return rows;
}

export interface G702 {
  L1originalContractCents: number;
  L2changeOrdersCents: number;
  L3contractSumToDateCents: number;
  L4totalCompletedStoredCents: number;
  L5aRetainageWorkCents: number;
  L5bRetainageStoredCents: number;
  L5retainageCents: number;
  L6earnedLessRetainageCents: number;
  L7lessPreviousCents: number;
  L8currentPaymentDueCents: number;
  L9balanceToFinishCents: number;
  changeOrders: { additionsCents: number; deductionsCents: number; netCents: number };
  retainage: {
    mode: RetainageMode;
    baseWorkPercent: number;
    cumulativeReleasedPoints: number;  // apps ≤ N, including this app
    releasedThisApp: number;
    remainingPoints: number;           // budget BEFORE this app's own release
    effectiveWorkPercent: number | null; // null in perLine — rates differ per line
  };
}

// G702 line 5 (retainage): 5a on work completed at each line's effective rate,
// 5b on stored materials at the stored rate, rounded per line. computeG702 and
// retainageReleasedCents both sum it here so the two can never disagree.
function retainageTotals(ctx: ComputeContext): { workCents: number; storedCents: number } {
  const storedPct = effectiveStoredPct(ctx);
  let workCents = 0, storedCents = 0;
  for (const sov of ctx.sovLines) {
    if (sov.lineType && sov.lineType !== 'item') continue;
    const thisLine = ctx.thisLines.get(sov.id);
    const percentComplete = thisLine ? thisLine.percentComplete : 0;
    const stored = thisLine ? thisLine.storedMaterialsCents : 0;
    const completedToDateCents = Math.round(sov.scheduledValueCents * percentComplete / 100);
    workCents += Math.round(completedToDateCents * effectiveWorkPct(ctx, sov) / 100);
    storedCents += Math.round(stored * storedPct / 100);
  }
  return { workCents, storedCents };
}

// The retainage releases recorded up to and including this application, in
// dollars: line 5 as the same lines would hold it with no release, less line 5
// as it is. Releases are entered as percentage points (setPayApp), so this is
// where their dollar effect is read off (the Reports page's retainage report).
// 0 on a project that has released nothing.
export function retainageReleasedCents(db: Database.Database, payAppId: string): number {
  const ctx = loadComputeContext(db, payAppId);
  if (!(ctx.cumulativeReleasedPoints > 0)) return 0;
  const held = retainageTotals(ctx);
  const unreleased = retainageTotals({ ...ctx, cumulativeReleasedPoints: 0 });
  return (unreleased.workCents + unreleased.storedCents) - (held.workCents + held.storedCents);
}

// Compute L6 (earned less retainage) for a given pay app — used for the recursive
// L7 (less previous certificates). Returns 0 if app is missing (guard).
function computeL6(db: Database.Database, payAppId: string | null): number {
  if (!payAppId) return 0;
  const app = db.prepare('SELECT id FROM aia_pay_apps WHERE id = ?').get(payAppId) as { id: string } | undefined;
  if (!app) return 0;
  return computeG702(db, payAppId).L6earnedLessRetainageCents;
}

export function computeG702(db: Database.Database, payAppId: string): G702 {
  const ctx = loadComputeContext(db, payAppId);
  const { app, sovLines, thisLines, priorId } = ctx;

  let L1 = 0, L2 = 0;
  let L4 = 0;
  let additions = 0, deductions = 0;

  for (const sov of sovLines) {
    if (sov.lineType && sov.lineType !== 'item') continue;
    const scheduledValueCents = sov.scheduledValueCents;
    if (sov.isChangeOrder) {
      L2 += scheduledValueCents;
      if (scheduledValueCents > 0) additions += scheduledValueCents;
      else if (scheduledValueCents < 0) deductions += scheduledValueCents;
    } else {
      L1 += scheduledValueCents;
    }

    const thisLine = thisLines.get(sov.id);
    const percentComplete = thisLine ? thisLine.percentComplete : 0;
    const storedCents = thisLine ? thisLine.storedMaterialsCents : 0;
    const completedToDateCents = Math.round(scheduledValueCents * percentComplete / 100);
    const totalToDateCents = completedToDateCents + storedCents;
    L4 += totalToDateCents;
  }

  const { workCents: L5a, storedCents: L5b } = retainageTotals(ctx);
  const L3 = L1 + L2;
  const L5 = L5a + L5b;
  const L6 = L4 - L5;
  const L7 = computeL6(db, priorId);
  const L8 = L6 - L7;
  const L9 = L3 - L6;

  return {
    L1originalContractCents: L1,
    L2changeOrdersCents: L2,
    L3contractSumToDateCents: L3,
    L4totalCompletedStoredCents: L4,
    L5aRetainageWorkCents: L5a,
    L5bRetainageStoredCents: L5b,
    L5retainageCents: L5,
    L6earnedLessRetainageCents: L6,
    L7lessPreviousCents: L7,
    L8currentPaymentDueCents: L8,
    L9balanceToFinishCents: L9,
    changeOrders: { additionsCents: additions, deductionsCents: deductions, netCents: L2 },
    retainage: {
      // Report the mode the math actually used, so a legacy project holding
      // per-line rates under an absent toggle still reveals its per-line column.
      mode: ctx.mode,
      baseWorkPercent: app.retainagePercent,
      cumulativeReleasedPoints: round4(ctx.cumulativeReleasedPoints),
      releasedThisApp: ctx.releasedThisApp,
      remainingPoints: round4(remainingReleasablePoints(db, payAppId)),
      effectiveWorkPercent: ctx.mode === 'perLine'
        ? null
        : round4(Math.max(0, app.retainagePercent - ctx.cumulativeReleasedPoints)),
    },
  };
}
