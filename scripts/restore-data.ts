/**
 * Full data/ restore CLI for production cutover.
 *
 * Copies the contents of a backup dir (produced by backup-data.ts) into a
 * target data dir.
 *
 * GUARD: if the target dir exists AND is non-empty, the restore REFUSES unless
 * `--force` is passed — restoring over a live data dir would overwrite real data.
 *
 * Usage:
 *   tsx scripts/restore-data.ts --from <backup-dir> [--data <target>] [--force]
 *   STORAGE_PATH=/app/data tsx scripts/restore-data.ts --from ./ft-backups/full-... --force
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RestoreResult {
  target: string;
  from: string;
  dbBytes: number;
  fileCount: number;
  totalBytes: number;
}

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

function isNonEmptyDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  if (!fs.statSync(dir).isDirectory()) return true; // exists as a file -> treat as occupied
  return fs.readdirSync(dir).length > 0;
}

/**
 * Restore the contents of `fromDir` into `targetDir`.
 * Guarded: refuses to overwrite a non-empty target unless `force` is true.
 */
export function restoreData(fromDir: string, targetDir: string, force: boolean): RestoreResult {
  const fromAbs = path.resolve(fromDir);
  const targetAbs = path.resolve(targetDir);

  if (!fs.existsSync(fromAbs)) {
    throw new Error(`Backup source dir does not exist: ${fromAbs}`);
  }
  if (!fs.statSync(fromAbs).isDirectory()) {
    throw new Error(`Backup source is not a directory: ${fromAbs}`);
  }
  if (targetAbs === fromAbs) {
    throw new Error(`Target must differ from backup source: ${targetAbs}`);
  }

  if (isNonEmptyDir(targetAbs) && !force) {
    throw new Error(
      `Target data dir is non-empty: ${targetAbs}\n` +
        `Refusing to restore — this would OVERWRITE live data.\n` +
        `Re-run with --force if you are certain you want to overwrite it.`,
    );
  }

  fs.mkdirSync(targetAbs, { recursive: true });
  // Copy backup contents into the target. force:true on cpSync allows overwrite
  // of existing files (already gated above by our own --force guard).
  fs.cpSync(fromAbs, targetAbs, { recursive: true, force: true });

  const dbPath = path.join(targetAbs, 'app.db');
  const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const filesTree = countTree(path.join(targetAbs, 'files'));
  const totalTree = countTree(targetAbs);

  return {
    target: targetAbs,
    from: fromAbs,
    dbBytes,
    fileCount: filesTree.fileCount,
    totalBytes: totalTree.totalBytes,
  };
}

function parseArgs(argv: string[]): { from?: string; data?: string; force: boolean } {
  const out: { from?: string; data?: string; force: boolean } = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--force') out.force = true;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from) {
    throw new Error('Missing required --from <backup-dir>');
  }
  const target = args.data || process.env.STORAGE_PATH || './data';

  const result = restoreData(args.from, target, args.force);

  console.log('✅ Data restore complete');
  console.log(`   from:    ${result.from}`);
  console.log(`   target:  ${result.target}`);
  console.log(`   app.db:  ${result.dbBytes.toLocaleString()} bytes`);
  console.log(`   files/:  ${result.fileCount} files`);
  console.log(`   total:   ${result.totalBytes.toLocaleString()} bytes restored`);
}

// CLI entry point (skipped when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    process.exitCode = 1;
    console.error('❌ Restore failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}
