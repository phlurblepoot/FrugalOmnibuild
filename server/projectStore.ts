import type Database from 'better-sqlite3';
import { deleteFileContent } from './fileStore';
import { billingSummary, listBilledDocuments } from './billingStore';
import { countOpenIssues } from './issueStore';
import { punchProgress } from './punchStore';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

/** How much of each kind of data a project holds — only the kinds it has any
 *  of, e.g. { documents: 12, invoices: 2 }. */
export type ProjectDataSummary = Record<string, number>;

export const PROJECT_HAS_DATA_MESSAGE = 'This project has documents or records. Archive it instead.';

/** deleteProject's refusal: the project holds data, so it can only be archived. */
export class ProjectHasDataError extends Error {
  constructor(public summary: ProjectDataSummary) { super(PROJECT_HAS_DATA_MESSAGE); }
}

// Project lifecycle stages (spec 2026-08-16: two-stage collapse). Archiving
// and lost-bid tracking are independent meta flags, not stages.
export const PROJECT_STATUSES = ['bidding', 'in_progress'] as const;

// Collapse table for the two-stage lifecycle (spec 2026-08-16). Legacy values
// arrive from old full-document saves and pre-migration rows; anything
// unrecognized is treated as a bid so nothing vanishes.
const LEGACY_STATUS_MAP: Record<string, 'bidding' | 'in_progress'> = {
  estimating: 'bidding', proposal_sent: 'bidding', lost: 'bidding',
  awarded: 'in_progress', in_progress: 'in_progress',
  punch_list: 'in_progress', complete: 'in_progress', archived: 'in_progress',
};
export function normalizeProjectStatus(s: unknown): 'bidding' | 'in_progress' {
  if (s === 'bidding' || s === 'in_progress') return s;
  return LEGACY_STATUS_MAP[String(s)] ?? 'bidding';
}

const parse = (s: string | null): any => (s == null ? undefined : JSON.parse(s));

// Adds key: value only when value is not null/undefined — assembly must omit
// keys the legacy JSON never had, but keep '' and 0 and false.
const put = (obj: any, key: string, value: any) => {
  if (value !== null && value !== undefined) obj[key] = value;
};

export function loadProject(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!row) return null;
  // Pre-normalization fallback (should not occur after migration 5, but a
  // legacy-dir import racing ahead of a re-run must not crash the API).
  if (row.data) {
    try { return { ...JSON.parse(row.data), version: row.version ?? 1, status: row.status ?? 'bidding' }; }
    catch {
      console.warn(`[projectStore] project ${id} has an unparseable legacy blob`);
      return null;
    }
  }

  const meta = parse(row.meta) ?? {};
  const project: any = { id: row.id };
  put(project, 'name', row.name);
  put(project, 'createdAt', row.createdAt);
  put(project, 'contractor', row.contractor);
  put(project, 'address', row.address);
  put(project, 'bidDueDate', row.bidDueDate);
  put(project, 'customerId', row.customerId);
  Object.assign(project, meta);

  const planSetRows = db.prepare('SELECT * FROM plan_sets WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  if (planSetRows.length > 0) {
    project.planSets = planSetRows.map(ps => {
      const obj: any = { id: ps.id };
      put(obj, 'name', ps.name);
      Object.assign(obj, parse(ps.attrs) ?? {});
      return obj;
    });
  }

  const measByPage = new Map<string, any[]>();
  const measRows = db.prepare('SELECT * FROM measurements WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  for (const m of measRows) {
    const obj: any = { id: m.id };
    put(obj, 'takeoffId', m.takeoffId);
    put(obj, 'type', m.type);
    put(obj, 'name', m.name);
    put(obj, 'color', m.color);
    obj.points = parse(m.points) ?? [];
    Object.assign(obj, parse(m.attrs) ?? {});
    if (!measByPage.has(m.pageId)) measByPage.set(m.pageId, []);
    measByPage.get(m.pageId)!.push(obj);
  }

  const pageRows = db.prepare('SELECT * FROM pages WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  project.pages = pageRows.map(pg => {
    const obj: any = { id: pg.id };
    put(obj, 'name', pg.name);
    put(obj, 'pageNumber', pg.pageNumber);
    put(obj, 'planSetId', pg.planSetId);
    put(obj, 'imageId', pg.imageId);
    put(obj, 'thumbnailId', pg.thumbnailId);
    put(obj, 'sourcePdfFileId', pg.sourcePdfFileId);
    put(obj, 'sourcePdfPageNum', pg.sourcePdfPageNum);
    Object.assign(obj, parse(pg.attrs) ?? {});
    obj.measurements = measByPage.get(pg.id) ?? [];
    return obj;
  });

  const takeoffRows = db.prepare('SELECT * FROM takeoffs WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  project.takeoffs = takeoffRows.map(t => {
    const obj: any = { id: t.id };
    put(obj, 'name', t.name);
    put(obj, 'color', t.color);
    put(obj, 'type', t.type);
    Object.assign(obj, parse(t.attrs) ?? {});
    return obj;
  });

  project.version = row.version;
  project.status = row.status;
  return project;
}

export function listProjects(db: Database.Database): any[] {
  const ids = db.prepare('SELECT id FROM projects ORDER BY createdAt DESC').all() as { id: string }[];
  return ids.map(r => loadProject(db, r.id)).filter(Boolean);
}

function validate(payload: any, id?: string): void {
  if (!payload || typeof payload !== 'object') throw new ValidationError('Payload must be an object');
  if (typeof payload.id !== 'string' || !payload.id) throw new ValidationError('Missing project id');
  if (id !== undefined && payload.id !== id) throw new ValidationError('Project id mismatch');
  if (payload.name !== undefined && typeof payload.name !== 'string') throw new ValidationError('name must be a string');
  if (!Array.isArray(payload.pages)) throw new ValidationError('pages must be an array');
  if (!Array.isArray(payload.takeoffs)) throw new ValidationError('takeoffs must be an array');
  if (payload.planSets !== undefined && !Array.isArray(payload.planSets)) throw new ValidationError('planSets must be an array');
  for (const pg of payload.pages) {
    if (!pg || typeof pg.id !== 'string' || !pg.id) throw new ValidationError('Every page needs an id');
    if (pg.measurements !== undefined && !Array.isArray(pg.measurements)) throw new ValidationError('measurements must be an array');
    for (const m of pg.measurements ?? []) {
      if (!m || typeof m.id !== 'string' || !m.id) throw new ValidationError('Every measurement needs an id');
      if (!Array.isArray(m.points)) throw new ValidationError('measurement points must be an array');
    }
  }
  for (const t of payload.takeoffs) {
    if (!t || typeof t.id !== 'string' || !t.id) throw new ValidationError('Every takeoff needs an id');
  }
}

// deriveStatus: full-document saves carry the client's status; normalize it.
// The archived flag no longer influences status (it is orthogonal).
export function deriveStatus(meta: any, existing?: string): string {
  if (existing) return normalizeProjectStatus(existing);
  if (meta.accepted) return 'in_progress';
  return 'bidding';
}

// Splits a validated legacy-shaped payload into rows. Caller wraps in a
// transaction. Never touches the files table (spec §3.3 rule 4).
export function decomposeProject(db: Database.Database, payload: any, version: number): void {
  const {
    id, name, createdAt, contractor, customerId, address, bidDueDate,
    planSets, pages, takeoffs, version: _v, status: _s, ...meta
  } = payload;

  db.prepare(`
    UPDATE projects SET name = ?, status = ?, contractor = ?, address = ?, bidDueDate = ?,
                        version = ?, updatedAt = ?, meta = ?, data = NULL
    WHERE id = ?
  `).run(
    name ?? 'Untitled',
    deriveStatus(meta, _s),
    contractor ?? null,
    address ?? null,
    typeof bidDueDate === 'number' ? bidDueDate : null,
    version,
    Date.now(),
    JSON.stringify(meta),
    id
  );

  // customerId is a dedicated column added in migration 16. Skip the write
  // when the column doesn't exist yet (e.g. when migration 5 calls us).
  const cols = (db.prepare('PRAGMA table_info(projects)').all() as any[]).map((c: any) => c.name);
  if (cols.includes('customerId')) {
    db.prepare('UPDATE projects SET customerId = ? WHERE id = ?').run(customerId ?? null, id);
  }

  for (const t of ['measurements', 'pages', 'takeoffs', 'plan_sets']) {
    db.prepare(`DELETE FROM ${t} WHERE projectId = ?`).run(id);
  }

  const insPlanSet = db.prepare('INSERT INTO plan_sets (id, projectId, name, sortOrder, attrs) VALUES (?, ?, ?, ?, ?)');
  (planSets ?? []).forEach((ps: any, i: number) => {
    const { id: psId, name: psName, ...rest } = ps;
    insPlanSet.run(psId, id, psName ?? null, i, JSON.stringify(rest));
  });

  const insTakeoff = db.prepare('INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)');
  (takeoffs ?? []).forEach((t: any, i: number) => {
    const { id: tId, name: tName, type, color, ...rest } = t;
    insTakeoff.run(tId, id, tName ?? null, type ?? null, color ?? null, i, JSON.stringify(rest));
  });

  const insPage = db.prepare(`
    INSERT INTO pages (id, projectId, planSetId, name, pageNumber, sortOrder, imageId, thumbnailId, sourcePdfFileId, sourcePdfPageNum, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insMeas = db.prepare(`
    INSERT INTO measurements (id, pageId, projectId, takeoffId, type, name, color, points, sortOrder, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (pages ?? []).forEach((pg: any, i: number) => {
    const {
      id: pgId, planSetId, name: pgName, pageNumber,
      imageId, thumbnailId, sourcePdfFileId, sourcePdfPageNum,
      measurements, ...rest
    } = pg;
    insPage.run(
      pgId, id, planSetId ?? null, pgName ?? null, pageNumber ?? null, i,
      imageId ?? null, thumbnailId ?? null, sourcePdfFileId ?? null, sourcePdfPageNum ?? null,
      JSON.stringify(rest)
    );
    (measurements ?? []).forEach((m: any, j: number) => {
      const { id: mId, takeoffId, type, name: mName, color, points, ...mrest } = m;
      insMeas.run(mId, pgId, id, takeoffId ?? null, type ?? null, mName ?? null, color ?? null,
        JSON.stringify(points ?? []), j, JSON.stringify(mrest));
    });
  });
}

export function createProject(db: Database.Database, payload: any): { version: number } {
  validate(payload);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO projects (id, createdAt) VALUES (?, ?)')
      .run(payload.id, payload.createdAt ?? Date.now());
    decomposeProject(db, payload, 1);
  });
  tx();
  return { version: 1 };
}

export function saveProject(
  db: Database.Database,
  id: string,
  payload: any,
  dataDir?: string
): { version: number } {
  validate(payload, id);
  if (!Number.isInteger(payload.version) || payload.version < 1) {
    throw new ValidationError('Missing or invalid version — reload the project and try again');
  }
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM projects WHERE id = ?').get(id) as
      | { version: number }
      | undefined;
    if (!row) throw new ValidationError('Project not found');
    if (row.version !== payload.version) {
      throw new ConflictError(`Project changed since it was loaded (server v${row.version}, payload v${payload.version})`);
    }
    newVersion = row.version + 1;
    decomposeProject(db, payload, newVersion);
  });
  tx();
  return { version: newVersion };
}

// Slim project rows for list/dashboard views — no page/measurement payloads.
// pageIds are included so the client can keep its "page is being edited"
// deletion guard without loading full aggregates.
export function listProjectSummaries(db: Database.Database, id?: string, includeBilling = true): any[] {
  // Include customerId when the column exists (added in migration 16).
  const hasCustCol = (db.prepare('PRAGMA table_info(projects)').all() as any[]).some((c: any) => c.name === 'customerId');
  const rows = db.prepare(`
    SELECT id, name, status, contractor, ${hasCustCol ? 'customerId,' : ''} address, bidDueDate, version, createdAt, updatedAt,
           COALESCE(json_extract(meta, '$.archived'), 0) AS archived,
           COALESCE(json_extract(meta, '$.lostBid'), 0) AS lostBid
    FROM projects ${id ? 'WHERE id = ?' : ''} ORDER BY createdAt DESC
  `).all(...(id ? [id] : [])) as any[];

  // These GROUP BY scans cover all projects even for a single-id call. Cheap
  // at current scale (index-backed); narrow to WHERE projectId = ? if tables grow.
  const countBy = (table: string): Map<string, number> =>
    new Map(
      (db.prepare(`SELECT projectId, COUNT(*) AS c FROM ${table} GROUP BY projectId`).all() as any[])
        .map(r => [r.projectId, r.c])
    );
  const takeoffCounts = countBy('takeoffs');

  const pageIdsByProject = new Map<string, string[]>();
  for (const r of db.prepare('SELECT id, projectId FROM pages ORDER BY sortOrder').all() as any[]) {
    if (!pageIdsByProject.has(r.projectId)) pageIdsByProject.set(r.projectId, []);
    pageIdsByProject.get(r.projectId)!.push(r.id);
  }

  return rows.map(r => {
    const pp = punchProgress(db, r.id);
    const base = {
      id: r.id,
      name: r.name ?? 'Untitled',
      status: r.status ?? 'bidding',
      contractor: r.contractor ?? null,
      customerId: r.customerId ?? null,
      address: r.address ?? null,
      bidDueDate: r.bidDueDate ?? null,
      version: r.version ?? 1,
      createdAt: r.createdAt ?? 0,
      updatedAt: r.updatedAt ?? null,
      archived: !!r.archived,
      lostBid: !!r.lostBid,
      pageCount: pageIdsByProject.get(r.id)?.length ?? 0,
      takeoffCount: takeoffCounts.get(r.id) ?? 0,
      pageIds: pageIdsByProject.get(r.id) ?? [],
      openIssueCount: countOpenIssues(db, r.id),
      punchDone: pp.done,
      punchTotal: pp.total,
    };
    if (!includeBilling) return base;
    // Fetched once and handed to billingSummary so it doesn't re-query the
    // same rows; outstandingCents spans invoices AND AIA pay applications —
    // an AIA-billed project would otherwise read $0 on the board (see
    // billingStore).
    const docs = listBilledDocuments(db, r.id);
    const bs = billingSummary(db, r.id, docs);
    return {
      ...base,
      contractValueCents: bs.contractValueCents,
      invoiceCount: bs.invoiceCount,
      outstandingCents: docs.reduce((a, d) => a + d.balanceCents, 0),
    };
  });
}

// A project's payments: polymorphic (invoice OR AIA pay app), so they hang off
// both. Takes the project id twice.
const PROJECT_PAYMENTS = "(targetType = 'invoice' AND targetId IN (SELECT id FROM invoices WHERE projectId = ?)) OR (targetType = 'payapp' AND targetId IN (SELECT id FROM aia_pay_apps WHERE projectId = ?))";

// Everything a person made or uploaded under a project, by kind (spec
// docs/superpowers/specs/2026-10-07-project-delete-guard-design.md). A project
// with any of it can only be archived. Each query takes the project id as @id.
// Child rows (lines, photos, attachments) need no query of their own: they
// can't exist without the parent counted here. Scaffolding doesn't count —
// takeoff lists and plan sets with nothing measured or uploaded, a crew with
// no reports (the Daily Reports page makes "Crew 1" just by opening), a
// notes board with nothing on it, the SOV lock, activity rows. Tasks don't
// count either: they live on the company task list and outlive the project
// they merely refer to (deleteProject spares them and their photos).
const PROJECT_DATA_QUERIES: [string, string][] = [
  // Every file the delete would remove — uploads, generated documents,
  // photos, plan PDFs, archived documents — counting a document and its old
  // versions once. Page images are counted as plan pages instead.
  ['documents', `SELECT COUNT(DISTINCT COALESCE(parentFileId, id)) AS c FROM files
    WHERE projectId = @id AND kind != 'task-photo'
      AND id NOT IN (SELECT imageId FROM pages WHERE projectId = @id AND imageId IS NOT NULL
                     UNION SELECT thumbnailId FROM pages WHERE projectId = @id AND thumbnailId IS NOT NULL)`],
  ['planPages', 'SELECT COUNT(*) AS c FROM pages WHERE projectId = @id'],
  ['measurements', 'SELECT COUNT(*) AS c FROM measurements WHERE projectId = @id'],
  ['proposals', 'SELECT COUNT(*) AS c FROM proposals WHERE projectId = @id'],
  ['invoices', 'SELECT COUNT(*) AS c FROM invoices WHERE projectId = @id'],
  ['payments', `SELECT COUNT(*) AS c FROM payments WHERE ${PROJECT_PAYMENTS.replace(/\?/g, '@id')}`],
  ['changeOrders', 'SELECT COUNT(*) AS c FROM change_orders WHERE projectId = @id'],
  ['lienReleases', 'SELECT COUNT(*) AS c FROM lien_releases WHERE projectId = @id'],
  ['payApps', 'SELECT COUNT(*) AS c FROM aia_pay_apps WHERE projectId = @id'],
  ['sovLines', 'SELECT COUNT(*) AS c FROM aia_sov_lines WHERE projectId = @id'],
  ['rfis', 'SELECT COUNT(*) AS c FROM rfis WHERE projectId = @id'],
  ['issues', 'SELECT COUNT(*) AS c FROM issues WHERE projectId = @id'],
  ['punchItems', 'SELECT COUNT(*) AS c FROM punch_items WHERE projectId = @id'],
  ['dailyReports', 'SELECT COUNT(*) AS c FROM daily_reports WHERE projectId = @id'],
  ['timeEntries', 'SELECT COUNT(*) AS c FROM time_entries WHERE projectId = @id'],
  // The notes board saves on every pan and zoom, so a row alone means nothing;
  // what's on the board does.
  ['notes', `SELECT COALESCE(SUM(json_array_length(data, '$.elements')), 0) AS c FROM notes
    WHERE projectId = @id AND json_valid(data)`],
  ['linkedEmails', 'SELECT COUNT(DISTINCT threadKey) AS c FROM mail_thread_links WHERE projectId = @id'],
];

export function projectDataSummary(db: Database.Database, id: string): { hasData: boolean; summary: ProjectDataSummary } {
  const summary: ProjectDataSummary = {};
  for (const [kind, sql] of PROJECT_DATA_QUERIES) {
    const c = (db.prepare(sql).get({ id }) as { c: number }).c;
    if (c > 0) summary[kind] = c;
  }
  return { hasData: Object.keys(summary).length > 0, summary };
}

// Kinds only admins see elsewhere (billing, proposals, everyone's time) —
// someone else is told they exist, not how many of each.
const ADMIN_ONLY_DATA_KINDS = ['proposals', 'invoices', 'payments', 'changeOrders', 'lienReleases', 'payApps', 'sovLines', 'timeEntries'];

export function visibleDataSummary(summary: ProjectDataSummary, isAdmin: boolean): ProjectDataSummary {
  if (isAdmin) return summary;
  const out: ProjectDataSummary = {};
  let otherRecords = 0;
  for (const [kind, c] of Object.entries(summary)) {
    if (ADMIN_ONLY_DATA_KINDS.includes(kind)) otherRecords += c;
    else out[kind] = c;
  }
  if (otherRecords > 0) out.otherRecords = otherRecords;
  return out;
}

// Explicit user action — the one place project-owned files are deleted. Only
// a project with nothing in it may go (ProjectHasDataError otherwise; archive
// it instead), so in practice this clears scaffolding; the sweep below stays
// whole so nothing is ever left behind.
export function deleteProject(db: Database.Database, dataDir: string, id: string): void {
  // Task photos are the one exception to the project-owned sweep: tasks (and
  // their photos) outlive the project they merely REFER to, and they always
  // have — before migration 23 gave them a projectId they were invisible to
  // this query. Keeping them excluded preserves that behavior exactly.
  const OWNED = `projectId = ? AND kind != 'task-photo'`;
  let fileIds: string[] = [];
  const tx = db.transaction(() => {
    // Checked inside the transaction, so nothing can land between the check
    // and the delete.
    const { hasData, summary } = projectDataSummary(db, id);
    if (hasData) throw new ProjectHasDataError(summary);
    fileIds = (db.prepare(`SELECT id FROM files WHERE ${OWNED}`).all(id) as { id: string }[]).map(r => r.id);
    for (const t of ['measurements', 'pages', 'takeoffs', 'plan_sets']) {
      db.prepare(`DELETE FROM ${t} WHERE projectId = ?`).run(id);
    }
    // Billing rows (Phase 4a/7b) — payments are polymorphic (invoice OR payapp),
    // so remove them up front for BOTH targets before invoices/pay-apps vanish,
    // and their attachment rows (migration 43) before the payments.
    db.prepare(`DELETE FROM payment_attachments WHERE paymentId IN (SELECT id FROM payments WHERE ${PROJECT_PAYMENTS})`).run(id, id);
    db.prepare(`DELETE FROM payments WHERE ${PROJECT_PAYMENTS}`).run(id, id);
    db.prepare('DELETE FROM invoice_lines WHERE invoiceId IN (SELECT id FROM invoices WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM invoices WHERE projectId = ?').run(id);
    // A record's PDF attachments (migration 42) go before the record itself.
    db.prepare('DELETE FROM change_order_attachments WHERE changeOrderId IN (SELECT id FROM change_orders WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM change_orders WHERE projectId = ?').run(id);
    db.prepare('DELETE FROM lien_releases WHERE projectId = ?').run(id);
    // Issue rows (Phase 4b) — photos and attachments link to issues, delete them first.
    db.prepare('DELETE FROM issue_photos WHERE issueId IN (SELECT id FROM issues WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM issue_attachments WHERE issueId IN (SELECT id FROM issues WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM issues WHERE projectId = ?').run(id);
    // RFI rows — photos and attachments link to rfis, delete them first.
    db.prepare('DELETE FROM rfi_photos WHERE rfiId IN (SELECT id FROM rfis WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM rfi_attachments WHERE rfiId IN (SELECT id FROM rfis WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM rfis WHERE projectId = ?').run(id);
    // Daily reports' PDF attachments (migration 42).
    db.prepare('DELETE FROM daily_report_attachments WHERE dailyReportId IN (SELECT id FROM daily_reports WHERE projectId = ?)').run(id);
    // Daily report crews (migration 45).
    db.prepare('DELETE FROM daily_report_crews WHERE projectId = ?').run(id);
    // Punch rows (Phase 4c) — photos link to punch items, delete photos first.
    db.prepare('DELETE FROM punch_photos WHERE punchItemId IN (SELECT id FROM punch_items WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM punch_items WHERE projectId = ?').run(id);
    // AIA progress billing (Phase 7) — pay-app lines reference pay apps, delete first.
    db.prepare('DELETE FROM aia_pay_app_lines WHERE payAppId IN (SELECT id FROM aia_pay_apps WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM aia_pay_apps WHERE projectId = ?').run(id);
    db.prepare('DELETE FROM aia_sov_lines WHERE projectId = ?').run(id);
    db.prepare('DELETE FROM aia_sov_locks WHERE projectId = ?').run(id);
    // Drop editor drafts for this project's files before the files vanish, so
    // the subquery can still resolve their ids (prevents a slow drafts leak).
    db.prepare(`DELETE FROM drafts WHERE fileId IN (SELECT id FROM files WHERE ${OWNED})`).run(id);
    // Same for the document editor's change logs and sessions (migrations 37-38).
    db.prepare(`DELETE FROM editor_changes WHERE fileId IN (SELECT id FROM files WHERE ${OWNED})`).run(id);
    db.prepare(`DELETE FROM editor_sessions WHERE fileId IN (SELECT id FROM files WHERE ${OWNED})`).run(id);
    db.prepare(`DELETE FROM files WHERE ${OWNED}`).run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
  tx();
  for (const fid of fileIds) deleteFileContent(dataDir, fid);
}

// Granular, version-checked field updates — the first of the spec §3.3
// "granular writes". Touches only columns + the meta.archived flag; never
// touches child tables or files.
export function patchProject(
  db: Database.Database,
  id: string,
  patch: any
): { version: number; status: string } {
  if (!patch || typeof patch !== 'object') throw new ValidationError('Payload must be an object');
  if (!Number.isInteger(patch.version) || patch.version < 1) {
    throw new ValidationError('Missing or invalid version — reload the project and try again');
  }
  const ALLOWED = ['version', 'name', 'status', 'archived', 'lostBid', 'contractor', 'address', 'bidDueDate'];
  for (const k of Object.keys(patch)) {
    if (!ALLOWED.includes(k)) throw new ValidationError(`Unknown field: ${k}`);
  }
  if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) {
    throw new ValidationError('name must be a non-empty string');
  }
  if (patch.status !== undefined && !(PROJECT_STATUSES as readonly string[]).includes(patch.status)) {
    throw new ValidationError(`Invalid status: ${patch.status}`);
  }
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') {
    throw new ValidationError('archived must be a boolean');
  }
  if (patch.lostBid !== undefined && typeof patch.lostBid !== 'boolean') {
    throw new ValidationError('lostBid must be a boolean');
  }
  for (const k of ['contractor', 'address'] as const) {
    if (patch[k] !== undefined && patch[k] !== null && typeof patch[k] !== 'string') {
      throw new ValidationError(`${k} must be a string or null`);
    }
  }
  if (patch.bidDueDate !== undefined && patch.bidDueDate !== null && typeof patch.bidDueDate !== 'number') {
    throw new ValidationError('bidDueDate must be a number or null');
  }

  let out = { version: 0, status: '' };
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version, status, meta FROM projects WHERE id = ?').get(id) as
      | { version: number; status: string; meta: string | null }
      | undefined;
    if (!row) throw new NotFoundError('Project not found');
    if (row.version !== patch.version) {
      throw new ConflictError(`Project changed since it was loaded (server v${row.version}, payload v${patch.version})`);
    }
    const newVersion = row.version + 1;
    const sets: string[] = ['version = ?', 'updatedAt = ?'];
    const vals: any[] = [newVersion, Date.now()];
    for (const k of ['name', 'status', 'contractor', 'address', 'bidDueDate'] as const) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(patch[k]);
      }
    }
    if (patch.archived !== undefined || patch.lostBid !== undefined) {
      let meta: any = {};
      try { meta = JSON.parse(row.meta || '{}'); } catch { /* keep {} */ }
      if (patch.archived !== undefined) {
        if (patch.archived) meta.archived = true;
        else delete meta.archived; // legacy shape omits the key when not archived
      }
      if (patch.lostBid !== undefined) {
        if (patch.lostBid) meta.lostBid = true;
        else delete meta.lostBid; // same omit-when-falsy shape as archived
      }
      sets.push('meta = ?');
      vals.push(JSON.stringify(meta));
    }
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    out = { version: newVersion, status: patch.status ?? row.status ?? 'bidding' };
  });
  tx();
  return out;
}
