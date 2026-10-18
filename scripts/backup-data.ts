/**
 * Full data/ backup CLI for production cutover.
 *
 * Copies the ENTIRE data dir (app.db + files/ + any other top-level files)
 * to a destination directory, EXCLUDING the `backups/` subdir (those are
 * redundant db-only snapshots the migration framework auto-creates).
 *
 * SAFE: copy-only. Never deletes or mutates the source.
 *
 * Usage:
 *   tsx scripts/backup-data.ts [--data <dir>] [--dest <dir>]
 *   STORAGE_PATH=/app/data tsx scripts/backup-data.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BackupResult {
  dest: string;
  dbBytes: number;
  fileCount: number;
  totalBytes: number;
}

/** Count files (recursively) and sum their bytes under `dir`. Missing dir -> zeros. */
function countTree(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  if (!fs.existsSync(dir)) return { fileCount, totalBytes };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countTree(full);
      fileCount += sub.fileCount;
      totalBytes += sub.totalBytes;
    } else if (entry.isFile()) {
      fileCount += 1;
      totalBytes += fs.statSync(full).size;
    }
  }
  return { fileCount, totalBytes };
}

/**
 * Recursively copy `dataDir` -> `destDir`, skipping the top-level `backups/` subdir.
 * Returns a summary of what was copied.
 */
export function backupData(dataDir: string, destDir: string): BackupResult {
  const srcAbs = path.resolve(dataDir);
  const destAbs = path.resolve(destDir);

  if (!fs.existsSync(srcAbs)) {
    throw new Error(`Source data dir does not exist: ${srcAbs}`);
  }
  if (!fs.statSync(srcAbs).isDirectory()) {
    throw new Error(`Source data dir is not a directory: ${srcAbs}`);
  }
  if (destAbs === srcAbs) {
    throw new Error(`Destination must differ from source: ${destAbs}`);
  }
  if (destAbs.startsWith(srcAbs + path.sep)) {
    throw new Error(`Destination must not be inside the source dir: ${destAbs}`);
  }

  const backupsDir = path.join(srcAbs, 'backups');

  fs.cpSync(srcAbs, destAbs, {
    recursive: true,
    // Skip the top-level backups/ subdir (and anything under it).
    filter: (src) => {
      const r = path.resolve(src);
      return r !== backupsDir && !r.startsWith(backupsDir + path.sep);
    },
  });

  // Summary metrics computed from the DESTINATION (what was actually written).
  const dbPath = path.join(destAbs, 'app.db');
  const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const filesTree = countTree(path.join(destAbs, 'files'));
  const totalTree = countTree(destAbs);

  return {
    dest: destAbs,
    dbBytes,
    fileCount: filesTree.fileCount,
    totalBytes: totalTree.totalBytes,
  };
}

function parseArgs(argv: string[]): { data?: string; dest?: string } {
  const out: { data?: string; dest?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') out.data = argv[++i];
    else if (a === '--dest') out.dest = argv[++i];
  }
  return out;
}

function defaultDest(dataDir: string): string {
  // ISO timestamp, ':' replaced for filesystem safety.
  const stamp = new Date().toISOString().replace(/:/g, '-');
  return path.join(path.resolve(dataDir), '..', 'ft-backups', `full-${stamp}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.data || process.env.STORAGE_PATH || './data';
  const dest = args.dest || defaultDest(dataDir);

  const result = backupData(dataDir, dest);

  console.log('✅ Full data backup complete');
  console.log(`   source:      ${path.resolve(dataDir)}`);
  console.log(`   destination: ${result.dest}`);
  console.log(`   app.db:      ${result.dbBytes.toLocaleString()} bytes`);
  console.log(`   files/:      ${result.fileCount} files`);
  console.log(`   total:       ${result.totalBytes.toLocaleString()} bytes copied`);
}

// CLI entry point (skipped when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    process.exitCode = 1;
    console.error('❌ Backup failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}
