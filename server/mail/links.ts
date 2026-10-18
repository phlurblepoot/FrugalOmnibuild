// server/mail/links.ts  (spec §3 mail_thread_links)
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Addr } from './providers/types';

export type ItemType = 'proposal' | 'invoice' | 'changeOrder' | 'lienRelease' | 'payApp' | 'issue' | 'rfi' | 'dailyReport' | 'punch' | 'task' | 'project' | 'customer';
export interface LinkRow { id: string; threadKey: string; subjectSnapshot: string | null; firstDate: string | null; participantsJson: string; itemType: ItemType; itemId: string; projectId: string | null; customerId: string | null; linkedByUserId: string; createdAt: string }

const ITEM_TABLE: Partial<Record<ItemType, string>> = { proposal: 'proposals', invoice: 'invoices', changeOrder: 'change_orders', lienRelease: 'lien_releases', payApp: 'aia_pay_apps', issue: 'issues', rfi: 'rfis', dailyReport: 'daily_reports', task: 'tasks' };
const UNASSIGNED = 'customer-unassigned';

export function resolveChain(db: Database.Database, itemType: ItemType, itemId: string): { projectId: string | null; customerId: string | null } {
  let projectId: string | null = null; let customerId: string | null = null;
  if (itemType === 'customer') return { projectId: null, customerId: itemId };
  if (itemType === 'project' || itemType === 'punch') projectId = itemId;
  else if (itemType === 'task') {
    const t = db.prepare('SELECT projectId, customerId FROM tasks WHERE id = ?').get(itemId) as { projectId: string | null; customerId: string | null } | undefined;
    projectId = t?.projectId ?? null; customerId = t?.customerId ?? null;
  } else {
    // An itemType outside the map (a client typo that slipped past validation, or a
    // future type added to the union but not the map) must not interpolate `undefined`
    // into the SQL — it resolves to no chain at all.
    const table = ITEM_TABLE[itemType];
    if (!table) return { projectId: null, customerId: null };
    const r = db.prepare(`SELECT projectId FROM ${table} WHERE id = ?`).get(itemId) as { projectId: string } | undefined;
    projectId = r?.projectId ?? null;
  }
  if (projectId) {
    const p = db.prepare('SELECT customerId FROM projects WHERE id = ?').get(projectId) as { customerId: string | null } | undefined;
    if (!p) projectId = null; else if (p.customerId && p.customerId !== UNASSIGNED) customerId = customerId ?? p.customerId;
  }
  return { projectId, customerId };
}

// Capitalized fallback shown when the linked row is gone (deleted item) or the
// itemType has no resolver below — mirrors src/pages/mail/mailFormat.ts'
// ITEM_TYPE_LABELS, kept separate so server code doesn't reach into a client page.
const TYPE_FALLBACK: Record<ItemType, string> = {
  proposal: 'Proposal', invoice: 'Invoice', changeOrder: 'Change Order', lienRelease: 'Lien Release', payApp: 'Pay App',
  issue: 'Issue', rfi: 'RFI', dailyReport: 'Daily Report', punch: 'Punch', task: 'Task',
  project: 'Project', customer: 'Customer',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Mirrors src/pages/project/daily/dailyReportForm.ts' formatReportDate ('2026-08-26'
// → 'Aug 26, 2026') — every human-facing surface (list row, editor title, email
// subject, PDF) formats the date this way, so the mail label must match. Built from
// the y/m/d parts directly (no Date parse) so it can't drift a day across timezones,
// and reimplemented locally rather than imported since it lives in a client page.
function formatReportDate(d: string): string {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// One row-fetch + one format function per item type, matching ITEM_TABLE's
// module-level pattern above: the SQL and formatting are declared once here,
// not rebuilt per call. `format` returning null means "treat as missing" (e.g.
// an invoice whose free-text number was never set) so resolveLinkLabel falls
// back to the capitalized type name same as a deleted row would.
interface LabelResolver { sql: string; format: (row: any) => string | null } // eslint-disable-line @typescript-eslint/no-explicit-any
const LABEL_RESOLVERS: Partial<Record<ItemType, LabelResolver>> = {
  proposal: { sql: 'SELECT number FROM proposals WHERE id = ?', format: r => `Proposal #${r.number}` },
  // InvoiceEditor's own modal title is `Invoice ${number}` (no #) — the number
  // is a free-text field the user sets, not an auto sequence.
  invoice: { sql: 'SELECT number FROM invoices WHERE id = ?', format: r => (r.number && String(r.number).trim()) ? `Invoice ${String(r.number).trim()}` : null },
  changeOrder: {
    sql: 'SELECT number, title FROM change_orders WHERE id = ?',
    format: r => { const base = `CO-${r.number ?? '?'}`; return r.title && String(r.title).trim() ? `${base} — ${String(r.title).trim()}` : base; },
  },
  lienRelease: { sql: 'SELECT number FROM lien_releases WHERE id = ?', format: r => `LR-${(r.number && String(r.number).trim()) || '?'}` },
  payApp: { sql: 'SELECT number FROM aia_pay_apps WHERE id = ?', format: r => `Pay App #${r.number}` },
  issue: {
    sql: 'SELECT number, title FROM issues WHERE id = ?',
    format: r => { const base = `ISS-${String(r.number).padStart(3, '0')}`; return r.title && String(r.title).trim() ? `${base} — ${String(r.title).trim()}` : base; },
  },
  rfi: {
    sql: 'SELECT number, title FROM rfis WHERE id = ?',
    format: r => { const base = `RFI-${String(r.number).padStart(3, '0')}`; return r.title && String(r.title).trim() ? `${base} — ${String(r.title).trim()}` : base; },
  },
  // One date can hold a report per crew (migration 45), so the crew names it too.
  dailyReport: {
    sql: 'SELECT r.reportDate, c.name AS crewName FROM daily_reports r LEFT JOIN daily_report_crews c ON c.id = r.crewId WHERE r.id = ?',
    format: r => `Daily Report — ${formatReportDate(r.reportDate)}${r.crewName ? ` — ${r.crewName}` : ''}`,
  },
  project: { sql: 'SELECT name FROM projects WHERE id = ?', format: r => (r.name && String(r.name).trim()) ? String(r.name).trim() : null },
  task: { sql: 'SELECT title FROM tasks WHERE id = ?', format: r => (r.title && String(r.title).trim()) ? String(r.title).trim() : null },
  customer: { sql: 'SELECT name FROM customers WHERE id = ?', format: r => (r.name && String(r.name).trim()) ? String(r.name).trim() : null },
};

/** Human label for a linked item, in the app's own display conventions per
 *  type (RFI-012, ISS-004, CO-3, Invoice 104, Proposal #2, Pay App #1,
 *  project/customer name, task title, Daily Report — <date> — <crew>). A missing row
 *  (deleted item) or unmapped itemType falls back to the capitalized type name. */
export function resolveLinkLabel(db: Database.Database, itemType: ItemType, itemId: string): string {
  const fallback = TYPE_FALLBACK[itemType] ?? itemType;
  // punch has no table of its own — the itemId IS the projectId (see resolveChain).
  const cfg = LABEL_RESOLVERS[itemType === 'punch' ? 'project' : itemType];
  if (!cfg) return fallback;
  const row = db.prepare(cfg.sql).get(itemId) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!row) return fallback;
  return cfg.format(row) ?? fallback;
}

export function createLink(db: Database.Database, input: { threadKey: string; itemType: ItemType; itemId: string; linkedByUserId: string; subjectSnapshot?: string | null; firstDate?: string | null; participants?: Addr[] }): LinkRow {
  const existing = db.prepare('SELECT * FROM mail_thread_links WHERE threadKey = ? AND itemType = ? AND itemId = ?').get(input.threadKey, input.itemType, input.itemId) as LinkRow | undefined;
  if (existing) return existing;
  const chain = resolveChain(db, input.itemType, input.itemId);
  const id = uuidv4();
  db.prepare(`INSERT INTO mail_thread_links (id, threadKey, subjectSnapshot, firstDate, participantsJson, itemType, itemId, projectId, customerId, linkedByUserId, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.threadKey, input.subjectSnapshot ?? null, input.firstDate ?? null, JSON.stringify(input.participants ?? []), input.itemType, input.itemId, chain.projectId, chain.customerId, input.linkedByUserId, new Date().toISOString());
  return db.prepare('SELECT * FROM mail_thread_links WHERE id = ?').get(id) as LinkRow;
}
export function listLinksForItem(db: Database.Database, itemType: ItemType, itemId: string): LinkRow[] {
  return db.prepare('SELECT * FROM mail_thread_links WHERE itemType = ? AND itemId = ? ORDER BY createdAt').all(itemType, itemId) as LinkRow[];
}
export function listLinksForThread(db: Database.Database, threadKey: string): LinkRow[] {
  return db.prepare('SELECT * FROM mail_thread_links WHERE threadKey = ? ORDER BY createdAt').all(threadKey) as LinkRow[];
}
export function deleteLink(db: Database.Database, id: string): void { db.prepare('DELETE FROM mail_thread_links WHERE id = ?').run(id); }
