/**
 * Read-only entity-counting helpers for the migration manifest / verify tools.
 *
 * NOTHING in here mutates the data dir or the database. The database is always
 * opened with { readonly: true } so even a buggy caller cannot write. These
 * helpers are shared by scripts/migrate-manifest.ts (pre-flight) and the
 * post-migration verify tool, plus their tests.
 */
import Database from 'better-sqlite3';
import fsSync from 'fs';
import { pathFor } from '../../server/fileStore';

/** Open a SQLite db strictly read-only. Throws if the file does not exist. */
export function openReadOnly(dbFile: string): Database.Database {
  return new Database(dbFile, { readonly: true, fileMustExist: true });
}

/** True if a (non-virtual) table with this name exists. */
export function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return !!row;
}

/** COUNT(*) of a table, or 0 if the table is absent. */
export function count(db: Database.Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
  return row?.c ?? 0;
}

/** COUNT(*) of a table with an extra WHERE clause; 0 if the table is absent. */
function countWhere(db: Database.Database, table: string, where: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE ${where}`).get() as {
    c: number;
  };
  return row?.c ?? 0;
}

// Normalized (post-rebuild) tables — the REAL names from server/migrationList.ts.
export const NEW_TABLES = [
  'projects',
  'plan_sets',
  'pages',
  'measurements',
  'takeoffs',
  'files',
  'issues',
  'issue_photos',
  'invoices',
  'invoice_lines',
  'payments',
  'change_orders',
  'change_order_lines',
  'change_order_photos',
  'punch_items',
  'punch_photos',
  'tasks',
  'task_photos',
  'notes',
  'time_entries',
  'users',
  'shares',
  'drafts',
] as const;

// Legacy SQLite tables (migration 1 base schema + pre-rebuild shapes).
export const LEGACY_SQLITE_TABLES = [
  'images',
  'checklists',
  'bids',
  'email_accounts',
  'templates',
] as const;

/**
 * Detect + count whatever OLD shapes are present in the data dir / database.
 * Returns only keys that apply (a key is omitted when its source is absent),
 * so an empty/new install yields an empty (or near-empty) map.
 *
 * Two legacy shapes are handled:
 *   1. Pre-SQLite JSON dirs: data/projects/*.json, data/images/*.txt,
 *      data/templates.json (also the *_migrated variants migration 2 renames to).
 *   2. Early SQLite (migration 1 base schema) with un-normalized blob rows.
 */
export function legacyCounts(
  dataDir: string,
  db: Database.Database | null
): Record<string, number> {
  const out: Record<string, number> = {};

  // ---- 1. pre-SQLite JSON-dir legacy ---------------------------------------
  const jsonDirCount = (dir: string, ext: string): number | null => {
    if (!fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) return null;
    return fsSync.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
  };
  // migration 2 renames imported dirs to *_migrated; count either form.
  const jsonProjects =
    jsonDirCount(`${dataDir}/projects`, '.json') ??
    jsonDirCount(`${dataDir}/projects_migrated`, '.json');
  if (jsonProjects !== null) out.jsonProjects = jsonProjects;

  const jsonImages =
    jsonDirCount(`${dataDir}/images`, '.txt') ??
    jsonDirCount(`${dataDir}/images_migrated`, '.txt');
  if (jsonImages !== null) out.jsonImages = jsonImages;

  for (const f of [`${dataDir}/templates.json`, `${dataDir}/templates_migrated.json`]) {
    if (fsSync.existsSync(f)) {
      try {
        const parsed = JSON.parse(fsSync.readFileSync(f, 'utf-8'));
        out.jsonTemplates = Array.isArray(parsed) ? parsed.length : 1;
      } catch {
        out.jsonTemplates = 0;
      }
      break;
    }
  }

  if (!db) return out;

  // ---- 2. early-SQLite legacy (un-normalized blob rows) --------------------
  // Un-normalized projects: rows still carrying a JSON `data` blob. (The blob
  // column survives into the new schema, so non-null data marks "not yet split".)
  if (tableExists(db, 'projects')) {
    // Guard: the `data` column always exists from migration 1 onward.
    const hasData = (db.prepare(`PRAGMA table_info("projects")`).all() as { name: string }[]).some(
      (c) => c.name === 'data'
    );
    if (hasData) {
      const c = countWhere(db, 'projects', 'data IS NOT NULL');
      if (c > 0) out.projectsUnnormalized = c;
    }
  }

  for (const t of LEGACY_SQLITE_TABLES) {
    if (tableExists(db, t)) out[t] = count(db, t);
  }
  // notes/time_entries/users predate the rebuild and persist; report when present.
  for (const t of ['notes', 'time_entries', 'users'] as const) {
    if (tableExists(db, t)) out[t] = count(db, t);
  }

  // Total checklist ITEMS across all blobs — migration 11 maps items -> tasks,
  // so this is the count the verify tool compares against tasks created.
  if (tableExists(db, 'checklists')) {
    let items = 0;
    try {
      const rows = db.prepare('SELECT data FROM checklists').all() as { data: string | null }[];
      for (const r of rows) {
        if (!r.data) continue;
        try {
          const cl = JSON.parse(r.data);
          if (cl && Array.isArray(cl.items)) items += cl.items.length;
        } catch {
          /* malformed blob — skip */
        }
      }
    } catch {
      /* table vanished mid-read — leave at 0 */
    }
    out.checklistItems = items;
  }

  return out;
}

/** Counts of every normalized table (guarded — absent table -> 0). */
export function newCounts(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of NEW_TABLES) out[t] = count(db, t);
  return out;
}

export interface FileStat {
  id: string;
  sha256: string;
  size: number;
  diskPath: string;
  exists: boolean;
  projectId: string | null;
}

/**
 * Every row in the `files` table with its computed on-disk path + existence.
 * Used by the verify tool (T3) to confirm blobs landed on disk. Empty array if
 * the table is absent.
 */
export function listFiles(db: Database.Database, dataDir: string): FileStat[] {
  if (!tableExists(db, 'files')) return [];
  const rows = db
    .prepare('SELECT id, sha256, size, projectId FROM files')
    .all() as { id: string; sha256: string; size: number; projectId: string | null }[];
  return rows.map((r) => {
    const diskPath = pathFor(dataDir, r.id);
    return {
      id: r.id,
      sha256: r.sha256,
      size: r.size,
      diskPath,
      exists: fsSync.existsSync(diskPath),
      projectId: r.projectId ?? null,
    };
  });
}
