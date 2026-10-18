/**
 * Pre-flight migration manifest CLI.
 *
 * Captures entity counts from a data dir BEFORE a migration so the
 * post-migration verify tool can compare old <-> new. Handles whatever it is
 * pointed at: pre-SQLite JSON dirs, an early (un-normalized) SQLite db, or a
 * fully-migrated normalized db.
 *
 * READ-ONLY: the database is opened readonly:true and the ONLY thing written is
 * the manifest json itself (into the inspected dataDir).
 *
 * Usage:
 *   tsx scripts/migrate-manifest.ts [--data <dir>] [--out <file>]
 *   STORAGE_PATH=/app/data tsx scripts/migrate-manifest.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openReadOnly,
  tableExists,
  legacyCounts,
  newCounts,
} from './lib/dataStats';

export interface Manifest {
  capturedAt: string;
  dataDir: string;
  /** Max schema_version (null when no schema_version table / pure JSON legacy). */
  schemaVersion: number | null;
  legacyCounts: Record<string, number>;
  newCounts: Record<string, number>;
}

/** Read MAX(version) from schema_version, or null if the table is absent. */
function readSchemaVersion(db: import('better-sqlite3').Database): number | null {
  if (!tableExists(db, 'schema_version')) return null;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return row?.v ?? null;
}

/**
 * Build the manifest for a data dir. Opens app.db read-only if present; if the
 * dir is a pure JSON-dir legacy with no app.db, only the JSON counts are taken.
 */
export function buildManifest(dataDir: string): Manifest {
  const dirAbs = path.resolve(dataDir);
  const dbFile = path.join(dirAbs, 'app.db');

  let db: import('better-sqlite3').Database | null = null;
  // Only open a real file (not a stray directory named app.db).
  if (fs.existsSync(dbFile) && fs.statSync(dbFile).isFile()) {
    db = openReadOnly(dbFile);
  }

  try {
    const manifest: Manifest = {
      capturedAt: new Date().toISOString(),
      dataDir: dirAbs,
      schemaVersion: db ? readSchemaVersion(db) : null,
      legacyCounts: legacyCounts(dirAbs, db),
      newCounts: db ? newCounts(db) : {},
    };
    return manifest;
  } finally {
    db?.close();
  }
}

function parseArgs(argv: string[]): { data?: string; out?: string } {
  const out: { data?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') out.data = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

/** Render a count map as an aligned `key  value` block (only non-zero shown). */
function summaryTable(title: string, counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  if (entries.length === 0) return `${title}: (none)`;
  const width = Math.max(...entries.map(([k]) => k.length));
  const lines = entries.map(([k, v]) => `  ${k.padEnd(width)}  ${v.toLocaleString()}`);
  return `${title}:\n${lines.join('\n')}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.data || process.env.STORAGE_PATH || './data';
  const dirAbs = path.resolve(dataDir);

  const manifest = buildManifest(dirAbs);
  const outFile = args.out ? path.resolve(args.out) : path.join(dirAbs, 'migration-manifest.json');

  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));

  console.log('📋 Migration manifest captured');
  console.log(`   dataDir:       ${manifest.dataDir}`);
  console.log(`   capturedAt:    ${manifest.capturedAt}`);
  console.log(`   schemaVersion: ${manifest.schemaVersion ?? '(none)'}`);
  console.log(`   written to:    ${outFile}`);
  console.log('');
  console.log(summaryTable('Legacy counts', manifest.legacyCounts));
  console.log('');
  console.log(summaryTable('New (normalized) counts', manifest.newCounts));
}

// CLI entry point (skipped when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    process.exitCode = 1;
    console.error('❌ Manifest failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}
