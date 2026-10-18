// server/documents.ts — global Documents API (spec 2026-08-17-unified-documents-design.md, §Server).
// Query/aggregation for GET /api/documents plus source-label resolution, and
// the guard logic for PATCH/DELETE on /api/files/:id. Deliberately separate
// from files.ts: files.ts owns storage primitives (policy-free), this module
// owns the Documents-page-specific policy (visibility, labels, guards).
import type Database from 'better-sqlite3';
import { getMeta, setFileFlags, removeFile, listVersions, isDirectUploadKind, isContainerSourceType, FileMeta } from './files';

// Always hidden regardless of role: per-page plan assets, the AIA template,
// and the document library (templates, company stamps and signatures live in
// Settings, not in Documents; ONLYOFFICE Phase 3).
const ALWAYS_EXCLUDED_KINDS = ['plan', 'settings-asset', 'document-template', 'company-stamp', 'signature'] as const;

// Billing-priced kinds — hidden from non-admins (spec §Decisions "Role
// visibility"). change-order-photo and printout are deliberately NOT here:
// they carry no dollar figures. payment-attachment is: a check image carries
// the customer's bank details as well as the amount (migration 43).
export const NON_ADMIN_EXCLUDED_KINDS = ['invoice', 'payapp-export', 'payapp-pdf', 'change-order', 'lien-release', 'proposal', 'proposal-signed', 'payment-attachment'] as const;

// Generated documents that are nonetheless deletable. Everything else with a
// sourceType is owned by a record you delete it at (an invoice, an issue, a
// proposal); a takeoff print/export has no owning record — its sourceId is a
// bare printout id that exists only on the file row — so refusing to delete it
// would strand it in the Documents list forever. Historical VERSIONS of one
// are still refused (parentFileId check), same as any other file.
export const DELETABLE_GENERATED_KINDS = ['takeoff-print', 'takeoff-export'] as const;
const isDeletableGeneratedKind = (kind: string) =>
  (DELETABLE_GENERATED_KINDS as readonly string[]).includes(kind);

// Fallback label when the referenced entity no longer exists (spec: "Missing
// referent (deleted entity) -> label from kind, href null").
const KIND_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  'invoice-photo': 'Invoice Photo',
  'change-order': 'Change Order',
  'change-order-photo': 'Change Order Photo',
  'lien-release': 'Lien Release',
  'issue-report': 'Issue',
  'issue-photo': 'Issue Photo',
  'punch-report': 'Punch Report',
  'punch-photo': 'Punch Photo',
  rfi: 'RFI',
  'rfi-photo': 'RFI Photo',
  'rfi-response': 'RFI Response',
  'task-photo': 'Task Photo',
  'payapp-export': 'Pay App Export',
  'payapp-pdf': 'Pay App PDF',
  proposal: 'Proposal',
  'proposal-photo': 'Proposal Photo',
  'proposal-signed': 'Signed Proposal',
  printout: 'Printout',
  'takeoff-print': 'Takeoff Print',
  'takeoff-export': 'Takeoff Export',
  'company-document': 'Company Document',
  'plan-source': 'Plan Set',
  'daily-report': 'Daily Report',
  'daily-report-photo': 'Daily Report Photo',
  'email-attachment': 'Email Attachment',
  'payment-attachment': 'Payment Attachment',
};
const genericLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

export interface DocumentFilters {
  projectIds?: string[];
  customerIds?: string[];
  kinds?: string[];
  q?: string;
  archived?: boolean; // true = ONLY archived rows; false/undefined = exclude archived
  // Admin-only exclusive view (spec docs/superpowers/specs/2026-08-17-documents-clutter-design.md):
  // shows ONLY the hidden "unassigned" class (projectId+name both null). Gated
  // on isAdmin inside listDocuments itself, not just at the route, so a
  // non-admin request can never see it even if a caller forgets the check.
  // Takes precedence over `archived` when both are set — it's a distinct view,
  // not a narrowing of the default one, so no archived clause is applied
  // within it (both archived and non-archived unassigned rows show).
  unassigned?: boolean;
  // Mime prefix filter (e.g. ['application/pdf'] or ['image/']) — used by the
  // FilePickerModal's `accept` option. OR'd together.
  mimes?: string[];
  limit?: number;
  offset?: number;
}

export interface DocumentSource {
  type: string;
  id: string;
  label: string;
  href: string | null;
}

export interface DocumentRow {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  createdAt: number;
  versionNumber: number;
  archived: boolean;
  projectId: string | null;
  projectName: string | null;
  customerId: string | null;
  customerName: string | null;
  source: DocumentSource | null;
}

interface RawRow {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  createdAt: number;
  versionNumber: number;
  archived: number;
  projectId: string | null;
  projectName: string | null;
  customerId: string | null;
  customerName: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

const inClause = (n: number) => Array(n).fill('?').join(',');

// Page assets can never appear (spec §Decisions "Page assets can never
// appear"): live EXISTS against pages.imageId/thumbnailId, so it's
// label-independent and self-healing — it hides a row even if it was uploaded
// before `kind='plan'` attribution existed, or under some other kind entirely.
const PAGE_ASSET_SQL = 'EXISTS (SELECT 1 FROM pages pg WHERE pg.imageId = f.id OR pg.thumbnailId = f.id)';
// The hidden "unassigned" class (spec 2026-08-17-documents-clutter-design.md):
// no project and no name, so nothing labels it.
const UNASSIGNED_SQL = 'f.projectId IS NULL AND f.name IS NULL';

/** Every live file the Documents page lists to an admin, archived ones
 *  included (not the unassigned class). Each is someone's document, which
 *  they can see and delete there, so storage cleanup never takes one as an
 *  orphan: company and customer documents and loose uploads belong to no
 *  project and nothing else points at them. */
export function listedDocumentIds(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT f.id FROM files f
    WHERE f.parentFileId IS NULL AND f.kind NOT IN (${inClause(ALWAYS_EXCLUDED_KINDS.length)})
      AND NOT ${PAGE_ASSET_SQL} AND NOT (${UNASSIGNED_SQL})
  `).all(...ALWAYS_EXCLUDED_KINDS) as { id: string }[];
  return rows.map(r => r.id);
}

export function listDocuments(
  db: Database.Database,
  filters: DocumentFilters,
  isAdmin: boolean
): { rows: DocumentRow[]; total: number } {
  const excluded: string[] = [...ALWAYS_EXCLUDED_KINDS, ...(isAdmin ? [] : NON_ADMIN_EXCLUDED_KINDS)];
  const where: string[] = [
    'f.parentFileId IS NULL',
    `f.kind NOT IN (${inClause(excluded.length)})`,
    `NOT ${PAGE_ASSET_SQL}`,
  ];
  const params: unknown[] = [...excluded];

  // Unassigned view (admin-only, exclusive with archived — see DocumentFilters
  // doc comment). isAdmin is re-checked here, not trusted from the caller, so
  // this can never leak to a non-admin regardless of what the route passes.
  const unassignedView = isAdmin && !!filters.unassigned;
  if (unassignedView) {
    where.push(UNASSIGNED_SQL);
  } else {
    where.push(`NOT (${UNASSIGNED_SQL})`);
    where.push(filters.archived ? 'f.archived = 1' : 'f.archived = 0');
  }

  if (filters.projectIds?.length) {
    where.push(`f.projectId IN (${inClause(filters.projectIds.length)})`);
    params.push(...filters.projectIds);
  }
  if (filters.customerIds?.length) {
    const ph = inClause(filters.customerIds.length);
    // Matches either a directly customer-scoped upload OR a file attributed
    // to a project that belongs to the customer (spec §Server).
    where.push(`(f.customerId IN (${ph}) OR p.customerId IN (${ph}))`);
    params.push(...filters.customerIds, ...filters.customerIds);
  }
  if (filters.kinds?.length) {
    where.push(`f.kind IN (${inClause(filters.kinds.length)})`);
    params.push(...filters.kinds);
  }
  if (filters.q) {
    where.push('LOWER(f.name) LIKE ?');
    params.push(`%${filters.q.toLowerCase()}%`);
  }
  if (filters.mimes?.length) {
    where.push(`(${filters.mimes.map(() => 'f.mime LIKE ?').join(' OR ')})`);
    params.push(...filters.mimes.map(m => `${m}%`));
  }

  const whereSql = where.join(' AND ');
  // customers joined via COALESCE so a customer-only upload (no project) and
  // a project-attributed file both resolve a customerName the same way.
  const fromSql = `
    FROM files f
    LEFT JOIN projects p ON f.projectId = p.id
    LEFT JOIN customers c ON COALESCE(f.customerId, p.customerId) = c.id
  `;

  const total = (
    db.prepare(`SELECT COUNT(*) as c ${fromSql} WHERE ${whereSql}`).get(...params) as { c: number }
  ).c;

  // Clamped rather than trusted: the page size comes straight off the query
  // string, where a huge (or negative, which SQLite reads as "no limit") value
  // would turn one request into a full-table scan.
  const clamp = (n: number | undefined, min: number, max: number, dflt: number) =>
    (typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt);
  const limit = clamp(filters.limit, 1, 500, 100);
  const offset = clamp(filters.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const rawRows = db.prepare(`
    SELECT f.id, f.name, f.mime, f.size, f.kind, f.createdAt, f.versionNumber, f.archived,
           f.projectId, p.name as projectName,
           COALESCE(f.customerId, p.customerId) as customerId, c.name as customerName,
           f.sourceType, f.sourceId
    ${fromSql}
    WHERE ${whereSql}
    ORDER BY f.createdAt DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as RawRow[];

  const sources = resolveSources(db, rawRows);

  const rows: DocumentRow[] = rawRows.map(r => ({
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    createdAt: r.createdAt,
    versionNumber: r.versionNumber,
    archived: !!r.archived,
    projectId: r.projectId,
    projectName: r.projectName,
    customerId: r.customerId,
    customerName: r.customerName,
    source: sources.get(r.id) ?? null,
  }));

  return { rows, total };
}

// Single-document lookup keyed by the owning entity, for callers that already
// know exactly which (sourceType, sourceId, kind) they want (e.g. "does this
// invoice already have a generated PDF?") rather than browsing the full
// Documents list. Honors the same role-visibility rules as listDocuments.
// versionOrigin: 'editor' once someone has edited the generated document in
// ONLYOFFICE since it was last generated (null right after a generate).
export interface SourceDoc { id: string; name: string | null; mime: string; size: number; createdAt: number; versionNumber: number; versionOrigin: string | null }
const SOURCE_COLS = 'id, name, mime, size, createdAt, versionNumber, versionOrigin, kind';

export function findDocumentsBySource(
  db: Database.Database,
  q: { sourceType: string; sourceIds: string[]; kind: string },
  isAdmin: boolean
): Record<string, SourceDoc | null> {
  const out: Record<string, SourceDoc | null> = {};
  const ids = [...new Set(q.sourceIds.filter(Boolean))].slice(0, 200);
  for (const id of ids) out[id] = null;
  if (!ids.length) return out;
  if (!isAdmin && (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(q.kind)) return out;
  if ((ALWAYS_EXCLUDED_KINDS as readonly string[]).includes(q.kind)) return out;
  const rows = db.prepare(`SELECT ${SOURCE_COLS}, sourceId FROM files
    WHERE parentFileId IS NULL AND sourceType = ? AND kind = ? AND sourceId IN (${ids.map(() => '?').join(',')})
    ORDER BY createdAt ASC, id ASC`).all(q.sourceType, q.kind, ...ids) as any[];
  for (const r of rows) if (!out[r.sourceId]) { const { sourceId, kind, ...doc } = r; out[sourceId] = doc; }
  return out;
}

export function findDocumentBySource(
  db: Database.Database,
  q: { sourceType: string; sourceId: string; kind: string },
  isAdmin: boolean
): SourceDoc | null {
  return findDocumentsBySource(db, { sourceType: q.sourceType, sourceIds: [q.sourceId], kind: q.kind }, isAdmin)[q.sourceId] ?? null;
}

// Source types resolvable by a plain "SELECT ... WHERE id IN (...)" against a
// single table, with a fixed href template keyed off the file's own
// projectId. `proposal` and `printout` don't fit this shape (see below) and
// are resolved separately.
interface SimpleResolver {
  sql: (placeholders: string) => string;
  label: (row: any) => string;
  // sourceId is only needed by resolvers whose href is per-entity (e.g.
  // proposal), and the matched row by those whose href needs one of its
  // columns (dailyReport's crew); every other resolver's href depends on
  // projectId alone and simply ignores the rest.
  href: (projectId: string | null, sourceId: string, row: any) => string | null;
}
const SIMPLE_RESOLVERS: Record<string, SimpleResolver> = {
  invoice: {
    sql: ph => `SELECT id, number FROM invoices WHERE id IN (${ph})`,
    label: row => `Invoice #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/billing?tab=invoices` : null,
  },
  payapp: {
    sql: ph => `SELECT id, number FROM aia_pay_apps WHERE id IN (${ph})`,
    label: row => `Pay App #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/billing?tab=pay-apps` : null,
  },
  // A payment's photos and PDFs (migration 43). Named after what it paid —
  // a payment has no number of its own — and the link opens that payment on
  // the Payments tab (PaymentsSection's ?open=).
  payment: {
    sql: ph => `SELECT p.id, p.targetType, i.number AS invoiceNumber, a.number AS payAppNumber
      FROM payments p
      LEFT JOIN invoices i ON p.targetType = 'invoice' AND i.id = p.targetId
      LEFT JOIN aia_pay_apps a ON p.targetType = 'payapp' AND a.id = p.targetId
      WHERE p.id IN (${ph})`,
    label: row => row.targetType === 'payapp'
      ? `Payment — Pay App #${row.payAppNumber ?? '?'}`
      : `Payment — Invoice #${row.invoiceNumber || '?'}`,
    href: (pid, id) => pid ? `/project/${pid}/billing?tab=payments&open=${encodeURIComponent(id)}` : null,
  },
  'change-order': {
    sql: ph => `SELECT id, number FROM change_orders WHERE id IN (${ph})`,
    label: row => `CO #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/billing?tab=change-orders` : null,
  },
  'lien-release': {
    sql: ph => `SELECT id, number FROM lien_releases WHERE id IN (${ph})`,
    label: row => `LR-${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/billing?tab=lien-releases` : null,
  },
  issue: {
    sql: ph => `SELECT id, number FROM issues WHERE id IN (${ph})`,
    label: row => `Issue #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/issues` : null,
  },
  rfi: {
    sql: ph => `SELECT id, number FROM rfis WHERE id IN (${ph})`,
    label: row => `RFI #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/rfis` : null,
  },
  task: {
    sql: ph => `SELECT id, title FROM tasks WHERE id IN (${ph})`,
    label: row => (typeof row.title === 'string' && row.title.trim()) ? row.title.trim() : 'Task',
    href: pid => pid ? `/tasks?projectId=${pid}` : '/tasks',
  },
  'plan-set': {
    sql: ph => `SELECT id, name FROM plan_sets WHERE id IN (${ph})`,
    label: row => (typeof row.name === 'string' && row.name.trim()) ? row.name.trim() : 'Plan set',
    href: pid => pid ? `/project/${pid}/takeoff` : null,
  },
  // sourceId is the proposal's own id in the `proposals` table (migration 28
  // — proposals are first-class rows, one project may have several).
  proposal: {
    sql: ph => `SELECT id, number FROM proposals WHERE id IN (${ph})`,
    label: row => `Proposal #${row.number ?? '?'}`,
    href: (pid, id) => pid ? `/project/${pid}/proposal/${id}` : null,
  },
  // Daily reports have no per-id route — the project's Daily Reports page,
  // on the report's crew tab, is the click-through destination for both the
  // report PDF and its photos. A date names a report only together with its
  // crew (one report per date per crew, migration 45).
  dailyReport: {
    sql: ph => `SELECT r.id, r.reportDate, r.crewId, c.name AS crewName FROM daily_reports r
      LEFT JOIN daily_report_crews c ON c.id = r.crewId WHERE r.id IN (${ph})`,
    label: row => `Daily Report — ${row.reportDate ?? '?'}${row.crewName ? ` — ${row.crewName}` : ''}`,
    href: (pid, _id, row) => pid
      ? `/project/${pid}/daily-reports${row?.crewName ? `?crew=${encodeURIComponent(row.crewId)}` : ''}`
      : null,
  },
};

// takeoff-print / takeoff-export files (and the legacy `printout` kind that
// migration 28 relabels) carry no table row: the file's own name is the
// label; click-through is the project's Takeoffs tab.
function resolveTakeoffPrints(rows: RawRow[], out: Map<string, DocumentSource>): void {
  for (const r of rows) {
    if (r.sourceType !== 'takeoff-print' || !r.sourceId) continue;
    out.set(r.id, {
      type: 'takeoff-print', id: r.sourceId,
      label: (r.name && r.name.trim()) || genericLabel(r.kind),
      href: r.projectId ? `/project/${r.projectId}/takeoff` : null,
    });
  }
}

// Files saved out of an email's attachments (POST /api/mail/messages/:id/save
// — server/mail/routes.ts writes sourceType 'mailMessage', sourceId = the
// mail_messages row id). Not a SIMPLE_RESOLVER because its href is per-ROW,
// not per-project: the mail page routes by account and thread key, both of
// which live on the message, and the file's own projectId says nothing about
// where the mail sits. `_` is the mail page's "no folder filter" segment.
//
// Resolving this at all matters beyond the label: `source` is what the client
// keys `deletable` off (src/pages/documents/documentsPolicy.ts), while the
// server's deleteDocument() refuses anything with a raw sourceType. With no
// resolver these rows read as source-less, so the Documents page offered a
// Delete the server could only ever 409.
//
// The mailbox belongs to ONE user; another user following the link gets the
// mail page's own not-your-account handling, the same trade the RFI
// pending-reply banner makes for its deep link.
function resolveMailMessages(db: Database.Database, rows: RawRow[], out: Map<string, DocumentSource>): void {
  const list = rows.filter(r => r.sourceType === 'mailMessage' && r.sourceId);
  if (!list.length) return;
  const ids = [...new Set(list.map(r => r.sourceId as string))];
  const found = new Map(
    (db.prepare(`SELECT id, subject, threadKey, accountId FROM mail_messages WHERE id IN (${inClause(ids.length)})`)
      .all(...ids) as any[]).map((m: any) => [m.id, m])
  );
  for (const r of list) {
    const m = found.get(r.sourceId as string);
    const subject = typeof m?.subject === 'string' ? m.subject.trim() : '';
    // A message row that is gone (its account was disconnected —
    // mail_messages cascades on mail_accounts) still keeps a source, with a
    // generic label and no href, exactly like every other resolver's miss
    // branch. Dropping to source:null instead would make the row look
    // deletable to the client while deleteDocument still refused it on the
    // raw sourceType column — the very mismatch this resolver exists to fix.
    out.set(r.id, {
      type: 'mailMessage',
      id: r.sourceId as string,
      label: subject || 'Email message',
      href: m ? `/mail/${encodeURIComponent(m.accountId)}/_/${encodeURIComponent(m.threadKey)}` : null,
    });
  }
}

// sourceType 'punch' covers two different referents by kind: a punch-photo's
// sourceId is a punch_items row (one of many items on a punch list), but a
// punch-report's sourceId is the owning project id — the report is the
// WHOLE list, generated per project (ProjectPunch.tsx), not per item. Feeding
// a punch-report's projectId sourceId through the punch_items lookup can
// never match, so it always fell back to a dead generic label/href.
function resolvePunch(db: Database.Database, rows: RawRow[], out: Map<string, DocumentSource>): void {
  const list = rows.filter(r => r.sourceType === 'punch' && r.sourceId);
  if (!list.length) return;

  const reportRows = list.filter(r => r.kind === 'punch-report');
  for (const r of reportRows) {
    const pid = r.projectId ?? r.sourceId; // sourceId IS the projectId by construction; projectId preferred for consistency with the other resolvers
    out.set(r.id, { type: 'punch', id: r.sourceId as string, label: 'Punch list', href: pid ? `/project/${pid}/punch` : null });
  }

  const itemRows = list.filter(r => r.kind !== 'punch-report');
  if (itemRows.length) {
    const ids = [...new Set(itemRows.map(r => r.sourceId as string))];
    const found = new Map(
      (db.prepare(`SELECT id, description FROM punch_items WHERE id IN (${inClause(ids.length)})`).all(...ids) as any[])
        .map((x: any) => [x.id, x])
    );
    for (const r of itemRows) {
      const match = found.get(r.sourceId as string);
      out.set(r.id, match
        ? {
            type: 'punch',
            id: r.sourceId as string,
            label: (typeof match.description === 'string' && match.description.trim()) ? match.description.trim() : 'Punch item',
            href: r.projectId ? `/project/${r.projectId}/punch` : null,
          }
        : { type: 'punch', id: r.sourceId as string, label: genericLabel(r.kind), href: null });
    }
  }
}

function resolveSources(db: Database.Database, rows: RawRow[]): Map<string, DocumentSource> {
  const out = new Map<string, DocumentSource>();
  for (const [type, resolver] of Object.entries(SIMPLE_RESOLVERS)) {
    const list = rows.filter(r => r.sourceType === type && r.sourceId);
    if (!list.length) continue;
    const ids = [...new Set(list.map(r => r.sourceId as string))];
    const found = new Map(
      (db.prepare(resolver.sql(inClause(ids.length))).all(...ids) as any[]).map((x: any) => [x.id, x])
    );
    for (const r of list) {
      const match = found.get(r.sourceId as string);
      out.set(r.id, match
        ? { type, id: r.sourceId as string, label: resolver.label(match), href: resolver.href(r.projectId, r.sourceId as string, match) }
        : { type, id: r.sourceId as string, label: genericLabel(r.kind), href: null });
    }
  }
  resolveTakeoffPrints(rows, out);
  resolvePunch(db, rows, out);
  resolveMailMessages(db, rows, out);
  return out;
}

// ── PATCH /api/files/:id guard ──────────────────────────────────────────────

export type GuardResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function isValidCustomKind(db: Database.Database, kind: string): boolean {
  const id = kind.slice('custom:'.length);
  if (!id) return false;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'documentTypes'`).get() as { value: string } | undefined;
  if (!row) return false;
  try {
    const list = JSON.parse(row.value);
    return Array.isArray(list) && list.some((t: any) => t && typeof t === 'object' && t.id === id);
  } catch {
    return false;
  }
}

// archived may be toggled on any row; kind may only move between
// direct-upload kinds (never onto/off a system-generated kind), and a
// custom:<id> target must be a live entry in settings.documentTypes.
// A non-admin gets 404 (not 409) for a billing-kind row — same set the
// listing hides for them — so a PATCH can't be used to confirm a row
// exists, or read back its metadata, when they couldn't see it via GET.
export function patchDocument(
  db: Database.Database,
  id: string,
  patch: { archived?: boolean; kind?: string },
  isAdmin: boolean
): GuardResult<FileMeta> {
  const current = getMeta(db, id);
  if (!current) return { ok: false, status: 404, error: 'File not found' };
  if (!isAdmin && (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(current.kind)) {
    return { ok: false, status: 404, error: 'File not found' };
  }
  if (patch.kind !== undefined && patch.kind !== current.kind) {
    if (!isDirectUploadKind(current.kind) || !isDirectUploadKind(patch.kind)) {
      return { ok: false, status: 409, error: 'kind can only be changed between direct-upload types' };
    }
    if (patch.kind.startsWith('custom:') && !isValidCustomKind(db, patch.kind)) {
      return { ok: false, status: 400, error: 'Unknown custom document type' };
    }
  }
  const meta = setFileFlags(db, id, patch);
  return { ok: true, value: meta as FileMeta };
}

// ── DELETE /api/files/:id guard ─────────────────────────────────────────────

// Loose, never-sourced direct uploads are deletable (spec §Safe deletion
// tiers), and so are takeoff prints/exports, which are generated but have no
// owning record to delete them at (DELETABLE_GENERATED_KINDS). A row under a
// CONTAINER source (files.ts CONTAINER_SOURCE_TYPES — an email message) is a
// copy of an attachment the message still holds, so it's deletable too as
// long as its kind is one a person could have picked when saving it
// (direct-upload kinds + the 'email-attachment' default); a system kind
// under that source keeps the generated-document rule. Everything else with
// a source is archived here and deleted at its source entity instead.
// Wipes the live row AND every version row's bytes (listVersions returns
// [live, ...history]). Deletable rows are never a billing kind, so the role
// gate below is vacuously true today — kept for uniformity with patchDocument
// and as a guard against a future kind ever landing in both sets.
const isContainerCopy = (meta: FileMeta) =>
  isContainerSourceType(meta.sourceType) && (isDirectUploadKind(meta.kind) || meta.kind === 'email-attachment');

export function deleteDocument(
  db: Database.Database,
  dataDir: string,
  id: string,
  isAdmin: boolean
): GuardResult<null> {
  const current = getMeta(db, id);
  if (!current) return { ok: false, status: 404, error: 'File not found' };
  if (!isAdmin && (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(current.kind)) {
    return { ok: false, status: 404, error: 'File not found' };
  }
  if (current.parentFileId) return { ok: false, status: 409, error: 'Cannot delete a historical file version directly' };
  const proposalRef = db.prepare(`
    SELECT 1 FROM proposal_photos WHERE fileId = ?
    UNION SELECT 1 FROM proposal_attachments WHERE fileId = ?
    UNION SELECT 1 FROM proposals WHERE fileId = ? OR signedFileId = ?
    LIMIT 1`).get(id, id, id, id);
  if (proposalRef) return { ok: false, status: 409, error: 'This file is attached to a proposal — remove it from the proposal first' };
  const containerCopy = isContainerCopy(current);
  if (current.sourceType && !isDeletableGeneratedKind(current.kind) && !containerCopy) {
    return { ok: false, status: 409, error: 'This file is generated from another record — archive it here, or delete it at the source' };
  }
  if (!isDirectUploadKind(current.kind) && !isDeletableGeneratedKind(current.kind) && !containerCopy) {
    return { ok: false, status: 409, error: 'This file type cannot be deleted directly' };
  }
  for (const v of listVersions(db, id)) removeFile(db, dataDir, v.id);
  return { ok: true, value: null };
}
