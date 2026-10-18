import type Database from 'better-sqlite3';
import { isPageSuperseded } from './revisionModel';

export type MeasurementOpAction = 'add' | 'update' | 'delete';

export interface MeasurementOp {
  projectId: string;
  pageId: string;
  action: MeasurementOpAction;
  // For delete, only measurement.id is required. For add/update, the full client
  // Measurement object (id, type, points required; everything else optional).
  measurement: Record<string, unknown> & { id: string };
}

export class OpRejectedError extends Error {
  constructor(public reason: 'page_not_found' | 'page_superseded' | 'invalid_measurement') {
    super(reason);
  }
}

const isValidForWrite = (m: Record<string, unknown>): boolean =>
  typeof m.id === 'string' && !!m.id &&
  typeof m.type === 'string' && !!m.type &&
  Array.isArray(m.points);

// Same attrs-split as decomposeProject's measurement destructuring
// (server/projectStore.ts): every field except {id, takeoffId, type, name,
// color, points} rides along in attrs JSON, so loadProject reassembles the
// client Measurement shape exactly (round-trip fidelity, contract case 8).
const upsertMeasurement = (
  db: Database.Database,
  projectId: string,
  pageId: string,
  measurement: Record<string, unknown> & { id: string }
): void => {
  const { id, takeoffId, type, name, color, points, ...rest } = measurement;
  // id-keyed (not pageId-scoped): applyMeasurementOp's cross-page collision
  // check already guarantees that if a row with this id exists, it's on this
  // same page — see the pageId/projectId check before this is called.
  const existing = db.prepare('SELECT sortOrder FROM measurements WHERE id = ?').get(id) as
    | { sortOrder: number }
    | undefined;
  let sortOrder: number;
  if (existing) {
    sortOrder = existing.sortOrder;
  } else {
    const maxRow = db.prepare('SELECT MAX(sortOrder) AS maxSort FROM measurements WHERE pageId = ?').get(pageId) as {
      maxSort: number | null;
    };
    sortOrder = maxRow.maxSort == null ? 0 : maxRow.maxSort + 1;
  }
  db.prepare(`
    INSERT OR REPLACE INTO measurements (id, pageId, projectId, takeoffId, type, name, color, points, sortOrder, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    pageId,
    projectId,
    (takeoffId as string | undefined) ?? null,
    (type as string | undefined) ?? null,
    (name as string | undefined) ?? null,
    (color as string | undefined) ?? null,
    JSON.stringify(points ?? []),
    sortOrder,
    JSON.stringify(rest)
  );
};

// Inverse of upsertMeasurement's attrs split — same shape loadProject
// reassembles a measurement row into (server/projectStore.ts): id/takeoffId/
// type/name/color as named columns, points parsed from JSON, everything else
// spread from the attrs JSON blob. Used by canvas-join to hydrate a page's
// measurements without loading the whole project.
export function hydrateMeasurementRow(row: {
  id: string;
  takeoffId: string | null;
  type: string | null;
  name: string | null;
  color: string | null;
  points: string | null;
  attrs: string | null;
}): Record<string, unknown> {
  const obj: Record<string, unknown> = { id: row.id };
  if (row.takeoffId != null) obj.takeoffId = row.takeoffId;
  if (row.type != null) obj.type = row.type;
  if (row.name != null) obj.name = row.name;
  if (row.color != null) obj.color = row.color;
  obj.points = row.points ? JSON.parse(row.points) : [];
  if (row.attrs) Object.assign(obj, JSON.parse(row.attrs));
  return obj;
}

// Applies the op to the measurements table and bumps projects.version, all in
// one transaction. Ordering = call order (better-sqlite3 is sync). Throws
// OpRejectedError on validation failure; never partially applies.
export function applyMeasurementOp(db: Database.Database, op: MeasurementOp): { version: number } {
  const { projectId, pageId, action, measurement } = op;

  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND projectId = ?').get(pageId, projectId);
  if (!page) throw new OpRejectedError('page_not_found');

  if (isPageSuperseded(db, projectId, pageId)) throw new OpRejectedError('page_superseded');

  if (action === 'delete') {
    if (typeof measurement.id !== 'string' || !measurement.id) throw new OpRejectedError('invalid_measurement');
  } else {
    if (!isValidForWrite(measurement)) throw new OpRejectedError('invalid_measurement');
    // Ops never legitimately move a measurement across pages/projects — an add
    // or update whose id collides with a row that lives elsewhere is rejected
    // rather than silently relocating that row onto op.pageId/op.projectId.
    const existing = db.prepare('SELECT pageId, projectId FROM measurements WHERE id = ?').get(measurement.id) as
      | { pageId: string; projectId: string }
      | undefined;
    if (existing && (existing.pageId !== pageId || existing.projectId !== projectId)) {
      throw new OpRejectedError('invalid_measurement');
    }
  }

  let version = 0;
  const tx = db.transaction(() => {
    if (action === 'add' || action === 'update') {
      upsertMeasurement(db, projectId, pageId, measurement);
    } else {
      db.prepare('DELETE FROM measurements WHERE id = ? AND pageId = ?').run(measurement.id, pageId);
    }
    db.prepare('UPDATE projects SET version = version + 1, updatedAt = ? WHERE id = ?').run(Date.now(), projectId);
    version = (db.prepare('SELECT version FROM projects WHERE id = ?').get(projectId) as { version: number }).version;
  });
  tx();

  return { version };
}
