import type Database from 'better-sqlite3';
import type { Customer, CustomerRoleEmails } from '../src/types';
import { billingSummary, listBilledDocuments, projectOutstandingCents } from './billingStore';
import { normalizeProjectStatus } from './projectStore';
import { billedDocDateMs } from './dashboardStore';

export function createCustomerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      contactName TEXT,
      notes TEXT,
      generalEmail TEXT,
      accountingEmail TEXT,
      estimatingEmail TEXT,
      pmEmail TEXT,
      emails TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      attrs TEXT
    );
  `);
}

function buildEmailsFromLegacy(r: any): CustomerRoleEmails {
  const emails: CustomerRoleEmails = {};
  if (r.generalEmail) emails.general = { to: r.generalEmail };
  if (r.accountingEmail) emails.accounting = { to: r.accountingEmail };
  if (r.estimatingEmail) emails.estimating = { to: r.estimatingEmail };
  if (r.pmEmail) emails.pm = { to: r.pmEmail };
  return emails;
}

const rowToCustomer = (r: any): Customer => ({
  id: r.id, name: r.name, phone: r.phone ?? undefined, address: r.address ?? undefined,
  contactName: r.contactName ?? undefined, notes: r.notes ?? undefined,
  emails: r.emails ? (JSON.parse(r.emails) as CustomerRoleEmails) : buildEmailsFromLegacy(r),
  createdAt: r.createdAt ?? undefined, updatedAt: r.updatedAt ?? undefined,
  ...(r.attrs ? JSON.parse(r.attrs) : {}),
});

export function listCustomers(db: Database.Database): Customer[] {
  return (db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all() as any[]).map(rowToCustomer);
}
export function getCustomer(db: Database.Database, id: string): Customer | null {
  const r = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  return r ? rowToCustomer(r) : null;
}
export function listProjectsForCustomer(db: Database.Database, id: string): any[] {
  return db.prepare('SELECT * FROM projects WHERE customerId = ? ORDER BY createdAt DESC').all(id) as any[];
}

export function saveCustomer(db: Database.Database, c: Customer): Customer {
  const now = Date.now();
  const emailsJson = JSON.stringify(c.emails || {});
  const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(c.id);
  if (exists) {
    db.prepare(`UPDATE customers SET name=?, phone=?, address=?, contactName=?, notes=?,
      emails=?, updatedAt=? WHERE id=?`)
      .run(c.name, c.phone ?? null, c.address ?? null, c.contactName ?? null, c.notes ?? null,
           emailsJson, now, c.id);
  } else {
    db.prepare(`INSERT INTO customers (id,name,phone,address,contactName,notes,
      emails,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(c.id, c.name, c.phone ?? null, c.address ?? null, c.contactName ?? null, c.notes ?? null,
           emailsJson, now, now);
  }
  return getCustomer(db, c.id)!;
}

export function deleteCustomer(db: Database.Database, id: string): void {
  if (id === 'customer-unassigned') throw new Error('The Unassigned customer cannot be deleted');
  const n = db.prepare('SELECT COUNT(*) n FROM projects WHERE customerId = ?').get(id) as { n: number };
  if (n.n > 0) throw new Error(`Customer still owns ${n.n} project(s); reassign or merge first`);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
}

// YYYY-MM-DD for today in local time — comparable lexicographically against
// tasks.dueDate / project bidDueDate-derived strings without a Date parse.
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 86400000));
}

interface ProjectRollupRow {
  id: string; name: string | null; status: string | null; contractor: string | null;
  bidDueDate: number | null; updatedAt: number | null; archived: number; lostBid: number;
}

function projectRowsForCustomer(db: Database.Database, customerId: string): ProjectRollupRow[] {
  return db.prepare(`
    SELECT id, name, status, contractor, bidDueDate, updatedAt,
           COALESCE(json_extract(meta, '$.archived'), 0) AS archived,
           COALESCE(json_extract(meta, '$.lostBid'), 0) AS lostBid
    FROM projects WHERE customerId = ?
  `).all(customerId) as ProjectRollupRow[];
}

// Rollup counts + open/overdue task counts for every customer. outstandingCents
// (admin-only) sums projectOutstandingCents(...) — invoices AND AIA pay
// applications — over each customer's NON-archived projects.
export function customerSummaries(db: Database.Database, includeBilling: boolean): any[] {
  const customers = listCustomers(db);
  const today = todayStr();

  const projRows = db.prepare(`
    SELECT id, customerId, status, COALESCE(json_extract(meta, '$.archived'), 0) AS archived
    FROM projects WHERE customerId IS NOT NULL
  `).all() as { id: string; customerId: string; status: string | null; archived: number }[];
  const projectsByCustomer = new Map<string, typeof projRows>();
  for (const r of projRows) {
    if (!projectsByCustomer.has(r.customerId)) projectsByCustomer.set(r.customerId, []);
    projectsByCustomer.get(r.customerId)!.push(r);
  }

  const projectArchivedById = new Map<string, boolean>();
  for (const r of projRows) projectArchivedById.set(r.id, !!Number(r.archived));

  const taskRows = db.prepare(`
    SELECT customerId, status, dueDate, projectId FROM tasks WHERE customerId IS NOT NULL
  `).all() as { customerId: string; status: string; dueDate: string | null; projectId: string | null }[];
  const tasksByCustomer = new Map<string, typeof taskRows>();
  for (const t of taskRows) {
    if (!tasksByCustomer.has(t.customerId)) tasksByCustomer.set(t.customerId, []);
    tasksByCustomer.get(t.customerId)!.push(t);
  }

  return customers.map(c => {
    const projects = projectsByCustomer.get(c.id) ?? [];
    const projectCounts = { bidding: 0, inProgress: 0, archived: 0 };
    for (const p of projects) {
      if (Number(p.archived)) { projectCounts.archived++; continue; }
      if (normalizeProjectStatus(p.status) === 'bidding') projectCounts.bidding++;
      else projectCounts.inProgress++;
    }

    const tasks = tasksByCustomer.get(c.id) ?? [];
    let openTaskCount = 0;
    let overdueTaskCount = 0;
    for (const t of tasks) {
      if (t.status === 'done') continue;
      // A task tied to an archived project is excluded, same as that project's
      // own billing/attention already are; customer-level tasks (no projectId)
      // always count.
      if (t.projectId && projectArchivedById.get(t.projectId)) continue;
      openTaskCount++;
      if (t.dueDate && t.dueDate < today) overdueTaskCount++;
    }

    const row: any = {
      id: c.id, name: c.name, contactName: c.contactName ?? null, phone: c.phone ?? null,
      projectCounts, openTaskCount, overdueTaskCount,
    };
    if (includeBilling) {
      row.outstandingCents = projects
        .filter(p => !Number(p.archived))
        .reduce((sum, p) => sum + projectOutstandingCents(db, p.id), 0);
    }
    return row;
  });
}

// Single-customer detail: project list (with per-project outstandingCents when
// admin), a billing ledger (admin-only, every billed invoice + AIA pay app),
// and an "attention" feed (overdue tasks always; upcoming bid-due dates and
// outstanding invoices/pay-apps admin-only for the money bits).
export function customerOverview(db: Database.Database, customerId: string, includeBilling: boolean): any | null {
  const customer = getCustomer(db, customerId);
  if (!customer) return null;

  const now = Date.now();
  const today = todayStr();
  const projRows = projectRowsForCustomer(db, customerId);
  const projNameById = new Map(projRows.map(p => [p.id, p.name ?? 'Untitled']));

  const projects = projRows.map(p => {
    const out: any = {
      id: p.id, name: p.name ?? 'Untitled', status: normalizeProjectStatus(p.status),
      archived: !!Number(p.archived), lostBid: !!Number(p.lostBid),
      bidDueDate: p.bidDueDate ?? null, updatedAt: p.updatedAt ?? null,
    };
    if (includeBilling) out.outstandingCents = projectOutstandingCents(db, p.id);
    return out;
  });

  const attention: any[] = [];
  const projectArchivedById = new Map(projRows.map(p => [p.id, !!Number(p.archived)]));

  const taskRows = db.prepare(`
    SELECT id, title, status, dueDate, projectId FROM tasks WHERE customerId = ?
  `).all(customerId) as { id: string; title: string; status: string; dueDate: string | null; projectId: string | null }[];
  let openTaskCount = 0;
  let overdueTaskCount = 0;
  for (const t of taskRows) {
    if (t.status === 'done') continue;
    // A task tied to an archived project is excluded from both the count and
    // attention, same as that project's own billing/attention already are;
    // customer-level tasks (no projectId) always count.
    if (t.projectId && projectArchivedById.get(t.projectId)) continue;
    openTaskCount++;
    if (t.dueDate && t.dueDate < today) {
      overdueTaskCount++;
      attention.push({
        type: 'overdue_task',
        label: t.title,
        projectId: t.projectId ?? undefined,
        taskId: t.id,
        date: t.dueDate,
      });
    }
  }

  // Bidding projects with a bidDueDate within the next 14 days OR already past
  // due (archived excluded) — a bid whose due date has already passed is more
  // urgent than an upcoming one, so it stays in attention flagged `overdue`.
  const in14Days = now + 14 * 86400000;
  for (const p of projRows) {
    if (Number(p.archived)) continue;
    if (normalizeProjectStatus(p.status) !== 'bidding') continue;
    if (p.bidDueDate == null) continue;
    if (p.bidDueDate <= in14Days) {
      const item: any = { type: 'bid_due', label: p.name ?? 'Untitled', projectId: p.id, date: p.bidDueDate };
      if (p.bidDueDate < now) item.overdue = true;
      attention.push(item);
    }
  }

  let billing: any = undefined;
  if (includeBilling) {
    let contractTotalCents = 0, invoicedCents = 0, paidCents = 0, outstandingCents = 0;
    // Split legs — contract (payapp docs) vs invoices — summed in the SAME
    // loop below so they can never drift from the combined figures above.
    let contractBilledCents = 0, contractPaidCents = 0, contractOutstandingCents = 0;
    let invoicesInvoicedCents = 0, invoicesPaidCents = 0, invoicesOutstandingCents = 0;
    // Aging buckets: every outstanding (balanceCents > 0) ledger doc, bucketed
    // by age of its billed date — invoice epoch `date` or pay-app
    // `applicationDate` ('YYYY-MM-DD'), both normalized via billedDocDateMs
    // (shared with dashboardStore's aging_receivable attention item so the
    // two never disagree on what counts as "aging").
    let agingCurrentCents = 0, agingDays31to60Cents = 0, agingDays61PlusCents = 0;
    const ledger: any[] = [];
    const activeProjects = projRows.filter(p => !Number(p.archived));

    for (const p of activeProjects) {
      // ONE population drives both the ledger and the rollup above it: every
      // billed document on the project, invoices and AIA pay applications
      // alike (drafts excluded — not billed yet). Fetched once here and
      // handed to billingSummary too, so this loop and billingSummary's own
      // pay-app/invoice leg computation never re-query the same rows.
      const docs = listBilledDocuments(db, p.id);
      contractTotalCents += billingSummary(db, p.id, docs).contractTotalCents;
      const projectName = projNameById.get(p.id) ?? 'Untitled';

      // Because the three rollup legs are summed from the same rows,
      // Invoiced/Paid/Outstanding always reconcile with the ledger the
      // client renders underneath them.
      for (const doc of docs) {
        invoicedCents += doc.totalCents;
        paidCents += doc.paidCents;
        outstandingCents += doc.balanceCents;
        if (doc.kind === 'payapp') {
          contractBilledCents += doc.totalCents;
          contractPaidCents += doc.paidCents;
          contractOutstandingCents += doc.balanceCents;
        } else {
          invoicesInvoicedCents += doc.totalCents;
          invoicesPaidCents += doc.paidCents;
          invoicesOutstandingCents += doc.balanceCents;
        }
        ledger.push({
          projectId: p.id, projectName, kind: doc.kind,
          number: doc.number, date: doc.date, status: doc.status,
          totalCents: doc.totalCents, paidCents: doc.paidCents, balanceCents: doc.balanceCents,
        });
        if (doc.balanceCents > 0) {
          const item: any = {
            type: 'outstanding_invoice',
            label: doc.kind === 'invoice'
              ? `Invoice #${doc.number ?? ''} — ${projectName}`
              : `Application #${doc.number} — ${projectName}`,
            projectId: p.id,
            date: doc.date ?? undefined,
            balanceCents: doc.balanceCents,
          };
          if (doc.kind === 'invoice' && typeof doc.date === 'number') item.ageDays = daysBetween(doc.date, now);
          attention.push(item);

          const docDateMs = billedDocDateMs(doc.date);
          if (docDateMs != null) {
            const age = daysBetween(docDateMs, now);
            if (age <= 30) agingCurrentCents += doc.balanceCents;
            else if (age <= 60) agingDays31to60Cents += doc.balanceCents;
            else agingDays61PlusCents += doc.balanceCents;
          }
        }
      }
    }

    billing = {
      contractTotalCents, invoicedCents, paidCents, outstandingCents, ledger,
      aging: { current: agingCurrentCents, days31to60: agingDays31to60Cents, days61plus: agingDays61PlusCents },
      contract: {
        billedCents: contractBilledCents, paidCents: contractPaidCents,
        outstandingCents: contractOutstandingCents,
      },
      invoices: {
        invoicedCents: invoicesInvoicedCents, paidCents: invoicesPaidCents,
        outstandingCents: invoicesOutstandingCents,
      },
    };
  }

  return {
    customer, projects, billing, attention,
    taskCounts: { open: openTaskCount, overdue: overdueTaskCount },
  };
}

export function mergeCustomers(db: Database.Database, targetId: string, sourceIds: string[]): void {
  const target = getCustomer(db, targetId);
  if (!target) throw new Error('Target customer not found');
  const tx = db.transaction(() => {
    for (const sid of sourceIds) {
      if (sid === targetId) continue;
      const src = getCustomer(db, sid);
      if (!src) continue;
      const merged: Customer = { ...target };
      for (const k of ['phone', 'address', 'contactName', 'notes'] as const)
        if (!merged[k] && src[k]) (merged as any)[k] = src[k];
      merged.emails = { ...target.emails };
      for (const k of ['general', 'accounting', 'estimating', 'pm'] as const)
        if (!merged.emails[k] && src.emails[k]) merged.emails[k] = src.emails[k];
      saveCustomer(db, merged);
      Object.assign(target, merged);
      db.prepare('UPDATE projects SET customerId = ? WHERE customerId = ?').run(targetId, sid);
      db.prepare('DELETE FROM customers WHERE id = ?').run(sid);
    }
  });
  tx();
}
