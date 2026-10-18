/**
 * Post-migration verification tool — the core data-loss guard for the
 * production cutover.
 *
 * After the new app boots on the old DB, the versioned migrations transform it
 * in place.
 * This tool runs against the MIGRATED data dir and proves the migration did not
 * lose or corrupt data: schema fully applied, projects normalized, every file's
 * bytes intact on disk (size + sha256), structural foreign keys resolve, and
 * (optionally) the pre-migration manifest counts still reconcile.
 *
 * STRICTLY READ-ONLY: the database is opened readonly:true; the only disk access
 * is READING file blobs to recompute their hashes. Nothing is ever written.
 *
 * Exit code is NON-ZERO on any hard FAIL so CI / the cutover runbook can gate on
 * it. WARN-only findings (legacy photo gaps, orphan files) do NOT fail the run.
 *
 * Usage:
 *   tsx scripts/verify-migration.ts [--data <dir>] [--sample <N>] [--manifest <file>]
 *   STORAGE_PATH=/app/data npm run migrate:verify
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { migrations } from '../server/migrationList';
import {
  openReadOnly,
  tableExists,
  count,
  newCounts,
  listFiles,
} from './lib/dataStats';

// The latest schema version is the max `version:` in the real migration list.
// Computed (not hard-coded) so adding a migration keeps this tool honest.
export const LATEST_SCHEMA_VERSION = Math.max(...migrations.map((m) => m.version));

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface VerifyOptions {
  /** Hash only this many files (size + existence still checked for ALL). */
  sample?: number;
  /** Explicit manifest path; otherwise <dataDir>/migration-manifest.json is used if present. */
  manifestPath?: string;
}

export interface VerifyReport {
  checks: CheckResult[];
  passed: boolean;
}

/** Max items to print in a failure list before truncating (full count is always reported). */
const LIST_CAP = 25;

function readSchemaVersion(db: Database.Database): number | null {
  if (!tableExists(db, 'schema_version')) return null;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row?.v ?? null;
}

// ---------------------------------------------------------------------------
// 1. schemaVersion
// ---------------------------------------------------------------------------
function checkSchemaVersion(db: Database.Database): CheckResult {
  const v = readSchemaVersion(db);
  if (v === LATEST_SCHEMA_VERSION) {
    return {
      name: 'schemaVersion',
      status: 'pass',
      detail: `schema at latest version ${LATEST_SCHEMA_VERSION}`,
    };
  }
  return {
    name: 'schemaVersion',
    status: 'fail',
    detail: `schema_version is ${v ?? '(none)'}, expected ${LATEST_SCHEMA_VERSION} — migration not fully applied`,
  };
}

// ---------------------------------------------------------------------------
// 2. normalizationComplete
//    - every project blob decomposed (projects.data IS NULL for all rows)
//    - the legacy `images` table is gone (migration 4 drops it)
// ---------------------------------------------------------------------------
function checkNormalizationComplete(db: Database.Database): CheckResult {
  const problems: string[] = [];

  if (tableExists(db, 'projects')) {
    const hasData = (
      db.prepare(`PRAGMA table_info("projects")`).all() as { name: string }[]
    ).some((c) => c.name === 'data');
    if (hasData) {
      const undecomposed = (
        db.prepare(`SELECT COUNT(*) AS c FROM projects WHERE data IS NOT NULL`).get() as { c: number }
      ).c;
      if (undecomposed > 0) {
        problems.push(`${undecomposed} project(s) still carry a non-null data blob (not decomposed)`);
      }
    }
  }

  if (tableExists(db, 'images')) {
    problems.push('legacy `images` table still exists (migration 4 should have dropped it)');
  }

  if (problems.length === 0) {
    return {
      name: 'normalizationComplete',
      status: 'pass',
      detail: 'all projects decomposed; legacy images table removed',
    };
  }
  return { name: 'normalizationComplete', status: 'fail', detail: problems.join('; ') };
}

// ---------------------------------------------------------------------------
// 3. fileIntegrity (CRITICAL)
//    For every files row: disk file exists, size matches, and (for all or a
//    sampled subset) sha256 recomputed from disk bytes matches files.sha256.
// ---------------------------------------------------------------------------
function checkFileIntegrity(
  db: Database.Database,
  dataDir: string,
  sample?: number
): CheckResult {
  const files = listFiles(db, dataDir);
  if (files.length === 0) {
    return { name: 'fileIntegrity', status: 'pass', detail: 'no files to verify' };
  }

  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  const hashMismatch: string[] = [];

  // Decide which files to hash. Existence + size are ALWAYS checked for every
  // file; hashing is the expensive part and is what --sample limits.
  const hashCount =
    sample !== undefined && sample >= 0 && sample < files.length ? sample : files.length;
  const hashSet = new Set<string>();
  for (let i = 0; i < hashCount; i++) hashSet.add(files[i].id);

  for (const f of files) {
    if (!f.exists) {
      missing.push(f.id);
      continue; // can't size/hash a file that isn't there
    }
    let onDiskSize: number;
    try {
      onDiskSize = fs.statSync(f.diskPath).size;
    } catch {
      missing.push(f.id);
      continue;
    }
    if (onDiskSize !== f.size) {
      sizeMismatch.push(`${f.id} (db=${f.size}, disk=${onDiskSize})`);
      // still attempt the hash below — both signals are useful
    }
    if (hashSet.has(f.id)) {
      try {
        const buf = fs.readFileSync(f.diskPath);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (sha !== f.sha256) hashMismatch.push(f.id);
      } catch {
        missing.push(f.id);
      }
    }
  }

  const total = missing.length + sizeMismatch.length + hashMismatch.length;
  const hashedNote =
    hashCount < files.length
      ? ` (hashed ${hashCount}/${files.length} via --sample; size+existence checked for all)`
      : ` (hashed all ${files.length})`;

  if (total === 0) {
    return {
      name: 'fileIntegrity',
      status: 'pass',
      detail: `${files.length} file(s) intact${hashedNote}`,
    };
  }

  const parts: string[] = [];
  if (missing.length) parts.push(`MISSING ${missing.length}: ${capList(missing)}`);
  if (sizeMismatch.length) parts.push(`SIZE-MISMATCH ${sizeMismatch.length}: ${capList(sizeMismatch)}`);
  if (hashMismatch.length) parts.push(`HASH-MISMATCH ${hashMismatch.length}: ${capList(hashMismatch)}`);
  return {
    name: 'fileIntegrity',
    status: 'fail',
    detail: `${total} problem file(s)${hashedNote} — ${parts.join(' | ')}`,
  };
}

function capList(items: string[]): string {
  if (items.length <= LIST_CAP) return items.join(', ');
  return `${items.slice(0, LIST_CAP).join(', ')}, … (+${items.length - LIST_CAP} more)`;
}

// ---------------------------------------------------------------------------
// 4. fkIntegrity (structural foreign keys — any break is a FAIL)
//    Column names verified against the CREATE TABLE statements in
//    server/migrationList.ts. NOTE: `tasks` is company-level (no projectId),
//    so there is no tasks→projects relation.
// ---------------------------------------------------------------------------
interface Relation {
  child: string;
  childCol: string;
  parent: string;
  parentCol: string;
}

const FK_RELATIONS: Relation[] = [
  { child: 'measurements', childCol: 'pageId', parent: 'pages', parentCol: 'id' },
  { child: 'pages', childCol: 'projectId', parent: 'projects', parentCol: 'id' },
  { child: 'plan_sets', childCol: 'projectId', parent: 'projects', parentCol: 'id' },
  { child: 'takeoffs', childCol: 'projectId', parent: 'projects', parentCol: 'id' },
  { child: 'issues', childCol: 'projectId', parent: 'projects', parentCol: 'id' },
  { child: 'issue_photos', childCol: 'issueId', parent: 'issues', parentCol: 'id' },
  { child: 'invoices', childCol: 'projectId', parent: 'projects', parentCol: 'id' },
  { child: 'invoice_lines', childCol: 'invoiceId', parent: 'invoices', parentCol: 'id' },
  // payments are polymorphic (targetType/targetId) — checked separately, not as a simple FK.
  { child: 'change_orders', childCol: 'projectId', parent: 'projects', parentCol: 'id' },
  { child: 'change_order_lines', childCol: 'changeOrderId', parent: 'change_orders', parentCol: 'id' },
  { child: 'change_order_photos', childCol: 'changeOrderId', parent: 'change_orders', parentCol: 'id' },
  { child: 'punch_items', childCol: 'projectId', parent: 'projects', parentCol: 'id' },
  { child: 'punch_photos', childCol: 'punchItemId', parent: 'punch_items', parentCol: 'id' },
  { child: 'task_photos', childCol: 'taskId', parent: 'tasks', parentCol: 'id' },
];

/** Count child rows whose (non-null) FK does not resolve to a parent row. */
function countBrokenFk(db: Database.Database, rel: Relation): number {
  if (!tableExists(db, rel.child) || !tableExists(db, rel.parent)) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM "${rel.child}" c
        WHERE c."${rel.childCol}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "${rel.parent}" p WHERE p."${rel.parentCol}" = c."${rel.childCol}"
          )`
    )
    .get() as { c: number };
  return row?.c ?? 0;
}

// Payments are polymorphic: targetType 'invoice' → invoices.id, 'payapp' → aia_pay_apps.id.
// Count rows whose (targetType,targetId) doesn't resolve to the right parent table.
function countBrokenPaymentTargets(db: Database.Database): number {
  if (!tableExists(db, 'payments')) return 0;
  let broken = 0;
  if (tableExists(db, 'invoices')) {
    broken += (db.prepare(
      `SELECT COUNT(*) AS c FROM payments WHERE targetType='invoice'
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = payments.targetId)`
    ).get() as { c: number }).c;
  }
  if (tableExists(db, 'aia_pay_apps')) {
    broken += (db.prepare(
      `SELECT COUNT(*) AS c FROM payments WHERE targetType='payapp'
         AND NOT EXISTS (SELECT 1 FROM aia_pay_apps a WHERE a.id = payments.targetId)`
    ).get() as { c: number }).c;
  }
  return broken;
}

function checkFkIntegrity(db: Database.Database): CheckResult {
  const broken: string[] = [];
  for (const rel of FK_RELATIONS) {
    const n = countBrokenFk(db, rel);
    if (n > 0) broken.push(`${rel.child}.${rel.childCol}→${rel.parent}.${rel.parentCol}: ${n}`);
  }
  const brokenPayments = countBrokenPaymentTargets(db);
  if (brokenPayments > 0) broken.push(`payments.targetId (polymorphic): ${brokenPayments}`);
  if (broken.length === 0) {
    return {
      name: 'fkIntegrity',
      status: 'pass',
      detail: `all ${FK_RELATIONS.length} structural relations + payment targets resolve`,
    };
  }
  return {
    name: 'fkIntegrity',
    status: 'fail',
    detail: `broken FK rows — ${broken.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// 5. photoFilesExist (WARN only)
//    Photo link rows whose fileId doesn't resolve to a files row, OR whose
//    files row's blob is missing on disk. Legacy photos may predate the files
//    table, so this is surfaced but never hard-fails the migration.
// ---------------------------------------------------------------------------
const PHOTO_TABLES: { table: string }[] = [
  { table: 'issue_photos' },
  { table: 'punch_photos' },
  { table: 'task_photos' },
  { table: 'change_order_photos' },
];

function checkPhotoFilesExist(db: Database.Database, dataDir: string): CheckResult {
  if (!tableExists(db, 'files')) {
    return {
      name: 'photoFilesExist',
      status: 'warn',
      detail: 'files table absent — cannot resolve any photo fileId',
    };
  }

  // Build a quick lookup of files row id -> on-disk existence.
  const fileRows = listFiles(db, dataDir);
  const existsById = new Map<string, boolean>(fileRows.map((f) => [f.id, f.exists]));

  const parts: string[] = [];
  let totalUnresolved = 0;
  let totalMissingBlob = 0;

  for (const { table } of PHOTO_TABLES) {
    if (!tableExists(db, table)) continue;
    const rows = db
      .prepare(`SELECT fileId FROM "${table}" WHERE fileId IS NOT NULL`)
      .all() as { fileId: string }[];
    let unresolved = 0;
    let missingBlob = 0;
    for (const r of rows) {
      if (!existsById.has(r.fileId)) unresolved++;
      else if (!existsById.get(r.fileId)) missingBlob++;
    }
    if (unresolved || missingBlob) {
      parts.push(`${table}: ${unresolved} no files-row, ${missingBlob} blob-missing`);
      totalUnresolved += unresolved;
      totalMissingBlob += missingBlob;
    }
  }

  if (totalUnresolved + totalMissingBlob === 0) {
    return {
      name: 'photoFilesExist',
      status: 'pass',
      detail: 'all photo fileIds resolve to existing file blobs',
    };
  }
  return {
    name: 'photoFilesExist',
    status: 'warn',
    detail: `photo file gaps (legacy photos may predate the files table) — ${parts.join('; ')}`,
  };
}

// ---------------------------------------------------------------------------
// 6. orphanFiles (WARN only)
//    files rows with a non-null projectId that points at a missing project.
// ---------------------------------------------------------------------------
function checkOrphanFiles(db: Database.Database): CheckResult {
  if (!tableExists(db, 'files') || !tableExists(db, 'projects')) {
    return { name: 'orphanFiles', status: 'pass', detail: 'no files/projects to cross-check' };
  }
  const n = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM files f
          WHERE f.projectId IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = f.projectId)`
      )
      .get() as { c: number }
  ).c;
  if (n === 0) {
    return { name: 'orphanFiles', status: 'pass', detail: 'no files point at a missing project' };
  }
  return {
    name: 'orphanFiles',
    status: 'warn',
    detail: `${n} file(s) reference a missing project (orphaned — reclaimable via cleanup)`,
  };
}

// ---------------------------------------------------------------------------
// 7. counts (informational — always pass)
// ---------------------------------------------------------------------------
function checkCounts(db: Database.Database): CheckResult {
  const nc = newCounts(db);
  const entries = Object.entries(nc).filter(([, v]) => v > 0);
  const detail =
    entries.length === 0
      ? 'all normalized tables empty'
      : entries.map(([k, v]) => `${k}=${v}`).join(', ');
  return { name: 'counts', status: 'pass', detail };
}

// ---------------------------------------------------------------------------
// 8. manifestCompare (only when a pre-migration manifest is available)
//    Mappings:
//      SOLID (FAIL on mismatch):
//        - legacy project source (jsonProjects OR projectsUnnormalized) == new
//          projects count. Solid because every legacy project row/file becomes
//          exactly one normalized projects row (migration 2 import + migration 5
//          decompose are 1:1; decompose never drops the row).
//        - legacy checklistItems == new tasks count. Solid because migration 11
//          maps each legacy checklist ITEM to exactly one task row, 1:1.
//      FUZZY (WARN on mismatch):
//        - legacy images count vs new files count. Fuzzy because files also hold
//          non-image kinds (plans, proposals, attachments) and versioned copies,
//          so new files >= legacy images by design — a difference is expected.
// ---------------------------------------------------------------------------
interface Manifest {
  legacyCounts?: Record<string, number>;
  newCounts?: Record<string, number>;
}

function checkManifestCompare(
  db: Database.Database,
  dataDir: string,
  manifestPath?: string
): CheckResult {
  const candidate =
    manifestPath ?? path.join(dataDir, 'migration-manifest.json');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return {
      name: 'manifestCompare',
      status: 'pass',
      detail: manifestPath
        ? `manifest not found at ${candidate} — skipped`
        : 'no pre-migration manifest present — skipped',
    };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Manifest;
  } catch (e) {
    return {
      name: 'manifestCompare',
      status: 'fail',
      detail: `manifest at ${candidate} is unreadable: ${e instanceof Error ? e.message : e}`,
    };
  }

  const legacy = manifest.legacyCounts ?? {};
  const nc = newCounts(db);

  const fails: string[] = [];
  const warns: string[] = [];
  const oks: string[] = [];

  // SOLID #1: legacy projects -> new projects (1:1).
  // Legacy source is whichever capture form was present pre-migration.
  const legacyProjects =
    legacy.jsonProjects ?? legacy.projectsUnnormalized ?? null;
  if (legacyProjects !== null) {
    if (legacyProjects === nc.projects) oks.push(`projects ${legacyProjects}==${nc.projects}`);
    else fails.push(`projects: legacy ${legacyProjects} != new ${nc.projects}`);
  }

  // SOLID #2: legacy checklist items -> new tasks (1:1).
  if (legacy.checklistItems !== undefined) {
    if (legacy.checklistItems === nc.tasks) oks.push(`tasks ${legacy.checklistItems}==${nc.tasks}`);
    else fails.push(`tasks: legacy checklistItems ${legacy.checklistItems} != new tasks ${nc.tasks}`);
  }

  // FUZZY: legacy images vs new files (new files >= images by design).
  if (legacy.images !== undefined) {
    if (legacy.images === nc.files) oks.push(`files ${legacy.images}==${nc.files}`);
    else
      warns.push(
        `files: legacy images ${legacy.images} vs new files ${nc.files} (expected to differ — files include non-image kinds + versions)`
      );
  }

  if (fails.length === 0 && warns.length === 0) {
    return {
      name: 'manifestCompare',
      status: 'pass',
      detail: oks.length ? `reconciled: ${oks.join(', ')}` : 'no comparable mappings in manifest',
    };
  }
  const status: CheckStatus = fails.length > 0 ? 'fail' : 'warn';
  const segs: string[] = [];
  if (fails.length) segs.push(`FAIL ${fails.join('; ')}`);
  if (warns.length) segs.push(`WARN ${warns.join('; ')}`);
  if (oks.length) segs.push(`ok ${oks.join(', ')}`);
  return { name: 'manifestCompare', status, detail: segs.join(' | ') };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export function verifyMigration(dataDir: string, opts: VerifyOptions = {}): VerifyReport {
  const dirAbs = path.resolve(dataDir);
  const dbFile = path.join(dirAbs, 'app.db');
  const db = openReadOnly(dbFile);
  try {
    const checks: CheckResult[] = [
      checkSchemaVersion(db),
      checkNormalizationComplete(db),
      checkFileIntegrity(db, dirAbs, opts.sample),
      checkFkIntegrity(db),
      checkPhotoFilesExist(db, dirAbs),
      checkOrphanFiles(db),
      checkCounts(db),
      checkManifestCompare(db, dirAbs, opts.manifestPath),
    ];
    const passed = !checks.some((c) => c.status === 'fail');
    return { checks, passed };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): { data?: string; sample?: number; manifest?: string } {
  const out: { data?: string; sample?: number; manifest?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') out.data = argv[++i];
    else if (a === '--sample') out.sample = Number(argv[++i]);
    else if (a === '--manifest') out.manifest = argv[++i];
  }
  return out;
}

const ICON: Record<CheckStatus, string> = { pass: '✅', fail: '❌', warn: '⚠️ ' };

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.data || process.env.STORAGE_PATH || './data';
  const dirAbs = path.resolve(dataDir);

  console.log('🔎 Migration verification');
  console.log(`   dataDir:        ${dirAbs}`);
  console.log(`   expected schema: ${LATEST_SCHEMA_VERSION}`);
  if (args.sample !== undefined) console.log(`   hash sample:    ${args.sample}`);
  console.log('');

  const { checks, passed } = verifyMigration(dirAbs, {
    sample: args.sample,
    manifestPath: args.manifest,
  });

  for (const c of checks) {
    console.log(`${ICON[c.status]} ${c.name}: ${c.detail}`);
  }

  const failures = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  console.log('');
  if (passed) {
    console.log(`VERIFICATION PASSED${warnings ? ` — ${warnings} warning(s)` : ''}`);
  } else {
    console.log(`VERIFICATION FAILED — ${failures} failure(s), ${warnings} warning(s)`);
    process.exitCode = 1;
  }
}

// CLI entry point (skipped when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    process.exitCode = 1;
    console.error('❌ Verification crashed:', err instanceof Error ? err.message : err);
    throw err;
  }
}
