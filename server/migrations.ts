import type Database from 'better-sqlite3';
import fsSync from 'fs';
import path from 'path';
import type { MailCrypto } from './mail/crypto';

export interface MigrationCtx {
  db: Database.Database;
  dataDir: string;
  mailCrypto?: MailCrypto;
}

export interface Migration {
  version: number;
  name: string;
  up: (ctx: MigrationCtx) => void;
}

export function currentVersion(db: Database.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      name TEXT,
      appliedAt INTEGER NOT NULL
    )
  `);
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  return row?.v ?? 0;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

// Applies all migrations with version > current, each in its own transaction.
// If opts.dbFile points at an existing database file, a copy is made into
// <dataDir>/backups/ before anything is touched. Disk side-effects inside a
// migration (e.g. writing extracted files) are NOT transactional — migrations
// must be written so that re-running them after a mid-way crash is safe.
// opts.vacuum compacts the database after migrations were applied — SQLite
// never shrinks the file on its own, and blob-removing migrations (e.g.
// images-to-disk) leave most of the file as free pages otherwise.
export function runMigrations(
  db: Database.Database,
  dataDir: string,
  migrations: Migration[],
  opts: { dbFile?: string; vacuum?: boolean; mailCrypto?: MailCrypto } = {}
): MigrationResult {
  const from = currentVersion(db);
  const pending = migrations
    .filter(mig => mig.version > from)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { from, to: from, applied: [] };

  if (opts.dbFile && fsSync.existsSync(opts.dbFile)) {
    const backupDir = path.join(dataDir, 'backups');
    fsSync.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, `app-v${from}-${Date.now()}.db`);
    // Safe at startup: journal_mode=DELETE and no concurrent writers yet.
    fsSync.copyFileSync(opts.dbFile, dest);
    console.log(`[migrations] backed up database to ${dest}`);
  }

  const applied: string[] = [];
  for (const mig of pending) {
    const tx = db.transaction(() => {
      mig.up({ db, dataDir, mailCrypto: opts.mailCrypto });
      db.prepare('INSERT INTO schema_version (version, name, appliedAt) VALUES (?, ?, ?)')
        .run(mig.version, mig.name, Date.now());
    });
    tx();
    applied.push(mig.name);
    console.log(`[migrations] applied ${mig.version}: ${mig.name}`);
  }

  if (opts.vacuum && applied.length > 0) {
    // VACUUM cannot run inside a transaction; safe here — startup, no
    // concurrent connections, and the pre-migration backup already exists.
    console.log('[migrations] compacting database (VACUUM)...');
    db.exec('VACUUM');
    console.log('[migrations] database compacted');
  }

  return { from, to: pending[pending.length - 1].version, applied };
}
