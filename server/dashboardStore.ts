// server/dashboardStore.ts
//
// Wave 2 dashboard aggregates: an "attention" feed (things needing action,
// role-gated) and admin-only money rollups. Both are read-only aggregations
// over existing stores — no new tables, no migration.
import type Database from 'better-sqlite3';
import { listBilledDocuments, billingSummary, toCents } from './billingStore';
import { computeG702 } from './aiaStore';
import { listActivity } from './activity';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AttentionItem {
  type: 'overdue_task' | 'bid_due' | 'aging_receivable' | 'stale_rfi' | 'draft_payapp';
  label: string;
  sub: string;
  projectId: string | null;
  projectName: string | null;
  itemId: string;
  date: number;
  severity: 'red' | 'amber';
  balanceCents?: number;
}

export interface DashboardMoney {
  outstandingCents: number;
  contractTotalCents: number;
  billedCents: number;
  paidCents: number;
  draftPayAppCount: number;
  recentPayments: { id: string; amount: number; date: number; method: string | null; projectId: string; projectName: string }[];
  trend: { month: string; paidCents: number }[];
  // Aging buckets over EVERY outstanding (balanceCents > 0) billed document
  // across non-archived projects — not just the ≥14-day-old, top-20-capped
  // subset that feeds the attention feed's aging_receivable items. Bucketed
  // the same way as customerStore's per-customer aging (current ≤30d), via
  // the shared billedDocDateMs normalization.
  aging: { current: number; days31to60: number; days61plus: number };
}

// YYYY-MM-DD for today in local time — comparable lexicographically against
// tasks.dueDate (mirrors customerStore's todayStr()).
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Whole days since fromMs (never negative). Exported, with agingBucket below,
// for the Reports page's open-invoices report, so its days outstanding and
// buckets are the dashboard's exactly.
export function ageDays(fromMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - fromMs) / DAY_MS));
}

// The receivables aging buckets — 0–30 days (current), 31–60, 61+ — keyed
// like DashboardMoney.aging.
export type AgingBucket = keyof DashboardMoney['aging'];
export function agingBucket(age: number): AgingBucket {
  if (age <= 30) return 'current';
  if (age <= 60) return 'days31to60';
  return 'days61plus';
}

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

interface ProjectRow {
  id: string;
  name: string | null;
  status: string | null;
  bidDueDate: number | null;
  archived: number;
}

function loadProjectRows(db: Database.Database): ProjectRow[] {
  return db.prepare(`
    SELECT id, name, status, bidDueDate, COALESCE(json_extract(meta, '$.archived'), 0) AS archived
    FROM projects
  `).all() as ProjectRow[];
}

// Billed-document date is either an invoice's epoch `date` column or a pay
// app's `applicationDate` ('YYYY-MM-DD' text). Both normalize to epoch ms.
// Exported for reuse by customerStore's aging-bucket rollup, which needs the
// same invoice/pay-app date normalization over the same ledger documents.
export function billedDocDateMs(date: string | number | null): number | null {
  if (date == null) return null;
  if (typeof date === 'number') return date;
  const parsed = new Date(`${date}T00:00:00`).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function dashboardAttention(db: Database.Database, isAdmin: boolean): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = Date.now();
  const today = todayStr();

  const projRows = loadProjectRows(db);
  const projById = new Map(projRows.map(p => [p.id, p]));
  const activeProjects = projRows.filter(p => !Number(p.archived));

  // overdue_task: tasks.status != 'done' AND dueDate < today (lexical ISO compare).
  const taskRows = db.prepare(`
    SELECT id, title, dueDate, projectId FROM tasks
    WHERE status != 'done' AND dueDate IS NOT NULL AND dueDate < ?
  `).all(today) as { id: string; title: string; dueDate: string; projectId: string | null }[];
  for (const t of taskRows) {
    const proj = t.projectId ? projById.get(t.projectId) : undefined;
    if (t.projectId && proj && Number(proj.archived)) continue;
    const dueMs = new Date(`${t.dueDate}T00:00:00`).getTime();
    items.push({
      type: 'overdue_task',
      label: t.title,
      sub: `${pluralDays(ageDays(dueMs, now))} overdue`,
      projectId: t.projectId ?? null,
      projectName: proj?.name ?? null,
      itemId: t.id,
      date: dueMs,
      severity: 'red',
    });
  }

  // bid_due: bidding, not archived, bidDueDate <= now + 14d. Red once past due.
  const in14Days = now + 14 * DAY_MS;
  for (const p of activeProjects) {
    if (p.status !== 'bidding') continue;
    if (p.bidDueDate == null) continue;
    if (p.bidDueDate > in14Days) continue;
    const overdue = p.bidDueDate < now;
    const days = Math.round(Math.abs(p.bidDueDate - now) / DAY_MS);
    items.push({
      type: 'bid_due',
      label: p.name ?? 'Untitled',
      sub: overdue ? `bid due ${pluralDays(days)} ago` : `bid due in ${pluralDays(days)}`,
      projectId: p.id,
      projectName: p.name ?? null,
      itemId: p.id,
      date: p.bidDueDate,
      severity: overdue ? 'red' : 'amber',
    });
  }

  // stale_rfi: open, sentAt set, sent more than 7 days ago.
  const staleThreshold = now - 7 * DAY_MS;
  const rfiRows = db.prepare(`
    SELECT id, projectId, number, title, sentAt FROM rfis
    WHERE status = 'open' AND sentAt IS NOT NULL AND sentAt < ?
  `).all(staleThreshold) as { id: string; projectId: string; number: number; title: string | null; sentAt: number }[];
  for (const r of rfiRows) {
    const proj = projById.get(r.projectId);
    if (proj && Number(proj.archived)) continue;
    items.push({
      type: 'stale_rfi',
      label: `RFI #${r.number}${r.title ? ` — ${r.title}` : ''}`,
      sub: `awaiting response ${pluralDays(ageDays(r.sentAt, now))}`,
      projectId: r.projectId,
      projectName: proj?.name ?? null,
      itemId: r.id,
      date: r.sentAt,
      severity: 'amber',
    });
  }

  // Admin-only money items: aging receivables + stale draft pay apps.
  if (isAdmin) {
    for (const p of activeProjects) {
      const docs = listBilledDocuments(db, p.id);
      for (const doc of docs) {
        if (doc.balanceCents <= 0) continue;
        const dateMs = billedDocDateMs(doc.date);
        if (dateMs == null) continue;
        const age = ageDays(dateMs, now);
        if (age < 14) continue;
        items.push({
          type: 'aging_receivable',
          label: doc.kind === 'payapp' ? `Pay app #${doc.number}` : `Invoice ${doc.number ?? ''}`,
          sub: `aging ${pluralDays(age)}`,
          projectId: p.id,
          projectName: p.name ?? null,
          itemId: doc.id,
          date: dateMs,
          severity: age >= 30 ? 'red' : 'amber',
          balanceCents: doc.balanceCents,
        });
      }

      const draftApps = db.prepare(`
        SELECT id, number, createdAt FROM aia_pay_apps WHERE projectId = ? AND status = 'draft' AND createdAt < ?
      `).all(p.id, now - 5 * DAY_MS) as { id: string; number: number; createdAt: number }[];
      for (const app of draftApps) {
        // A draft with no SOV lines yet (or otherwise unable to price) should
        // still surface in the feed — just without a dollar figure — rather
        // than crash the whole endpoint.
        let balanceCents: number | undefined;
        try {
          balanceCents = computeG702(db, app.id).L8currentPaymentDueCents;
        } catch {
          balanceCents = undefined;
        }
        items.push({
          type: 'draft_payapp',
          label: `Pay app #${app.number} in draft`,
          sub: `in draft ${pluralDays(ageDays(app.createdAt, now))}`,
          projectId: p.id,
          projectName: p.name ?? null,
          itemId: app.id,
          date: app.createdAt,
          severity: 'amber',
          ...(balanceCents !== undefined ? { balanceCents } : {}),
        });
      }
    }
  }

  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'red' ? -1 : 1;
    return a.date - b.date;
  });
  return items.slice(0, 20);
}

export function dashboardMoney(db: Database.Database): DashboardMoney {
  const projRows = (db.prepare(`
    SELECT id, name, COALESCE(json_extract(meta, '$.archived'), 0) AS archived FROM projects
  `).all() as { id: string; name: string | null; archived: number }[]).filter(p => !Number(p.archived));

  let outstandingCents = 0, contractTotalCents = 0, billedCents = 0, paidCents = 0;
  const aging: DashboardMoney['aging'] = { current: 0, days31to60: 0, days61plus: 0 };
  const nowMs = Date.now();
  for (const p of projRows) {
    // Fetch docs ONCE and hand the same array to billingSummary — avoids a
    // second listBilledDocuments pass (and its computeG702 calls) per project.
    const docs = listBilledDocuments(db, p.id);
    contractTotalCents += billingSummary(db, p.id, docs).contractTotalCents;
    for (const doc of docs) {
      billedCents += doc.totalCents;
      paidCents += doc.paidCents;
      outstandingCents += doc.balanceCents;
      if (doc.balanceCents > 0) {
        const docDateMs = billedDocDateMs(doc.date);
        if (docDateMs != null) aging[agingBucket(ageDays(docDateMs, nowMs))] += doc.balanceCents;
      }
    }
  }

  const draftPayAppCount = (db.prepare(
    `SELECT COUNT(*) c FROM aia_pay_apps WHERE status = 'draft'`
  ).get() as { c: number }).c;

  const recentRows = db.prepare(`
    SELECT id, targetType, targetId, date, amount, method FROM payments ORDER BY date DESC, createdAt DESC LIMIT 5
  `).all() as { id: string; targetType: string; targetId: string; date: number; amount: number; method: string | null }[];
  const recentPayments = recentRows.map(r => {
    let projectId: string | null = null;
    if (r.targetType === 'invoice') {
      const row = db.prepare('SELECT projectId FROM invoices WHERE id = ?').get(r.targetId) as { projectId: string } | undefined;
      projectId = row?.projectId ?? null;
    } else if (r.targetType === 'payapp') {
      const row = db.prepare('SELECT projectId FROM aia_pay_apps WHERE id = ?').get(r.targetId) as { projectId: string } | undefined;
      projectId = row?.projectId ?? null;
    }
    const proj = projectId ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string | null } | undefined) : undefined;
    return {
      // payments.amount is stored as real dollars in the DB — normalize to
      // integer cents here so the wire contract matches every other money
      // field (client cards format all of these via formatMoney(cents)).
      id: r.id, amount: toCents(r.amount), date: r.date, method: r.method ?? null,
      projectId: projectId ?? '', projectName: proj?.name ?? 'Untitled',
    };
  });

  // Last 6 calendar months incl. current, oldest first.
  const now = new Date();
  const months: Date[] = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const windowStart = months[0].getTime();
  const trendRows = db.prepare(`
    SELECT strftime('%Y-%m', date/1000, 'unixepoch') m, SUM(amount) a FROM payments WHERE date >= ? GROUP BY m
  `).all(windowStart) as { m: string; a: number }[];
  const trendByMonth = new Map(trendRows.map(r => [r.m, toCents(r.a)]));
  const trend = months.map(m => {
    const key = monthKey(m);
    return { month: key, paidCents: trendByMonth.get(key) ?? 0 };
  });

  return {
    outstandingCents, contractTotalCents, billedCents, paidCents, draftPayAppCount, recentPayments, trend, aging,
  };
}

export interface HappeningItem {
  kind: 'activity' | 'mail';
  id: string;
  type?: string;
  message: string;
  username?: string | null;
  createdAt: number;
}

// A project's recent-activity feed: the existing activity log, merged with
// mail threads on the project that have a reply newer than our last outbound
// (or newer than the thread's link, if we've never sent on it) — same
// "unanswered reply" rule as GET /api/mail/reply-flags (mail/routes.ts:1035),
// applied per-thread (grouped by threadKey, MIN(link.createdAt) standing in
// for reply-flags' single-link createdAt) rather than per-link, since a
// project can have several item links (invoice + RFI, etc.) on the same
// thread and each thread should surface at most once here.
export function projectHappenings(db: Database.Database, projectId: string, limit = 12): HappeningItem[] {
  const activityItems: HappeningItem[] = listActivity(db, limit, projectId).map(a => ({
    kind: 'activity',
    id: a.id,
    type: a.type,
    message: a.message,
    username: a.username ?? null,
    createdAt: a.createdAt,
  }));

  const threadRows = db.prepare(`
    SELECT l.threadKey, l.subjectSnapshot, MIN(l.createdAt) AS earliestCreatedAt,
           r.lastInboundDate, r.lastOutboundDate
    FROM mail_thread_links l LEFT JOIN mail_thread_reply_state r ON r.threadKey = l.threadKey
    WHERE l.projectId = ?
    GROUP BY l.threadKey
  `).all(projectId) as {
    threadKey: string; subjectSnapshot: string | null; earliestCreatedAt: string;
    lastInboundDate: string | null; lastOutboundDate: string | null;
  }[];

  const mailItems: HappeningItem[] = [];
  for (const t of threadRows) {
    if (!t.lastInboundDate) continue;
    const floor = t.lastOutboundDate && t.lastOutboundDate > t.earliestCreatedAt ? t.lastOutboundDate : t.earliestCreatedAt;
    if (!(t.lastInboundDate > floor)) continue;
    mailItems.push({
      kind: 'mail',
      id: t.threadKey,
      message: `Reply on "${t.subjectSnapshot ?? ''}"`,
      createdAt: Date.parse(t.lastInboundDate),
    });
  }

  return [...activityItems, ...mailItems]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
