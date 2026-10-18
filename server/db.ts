import Database from 'better-sqlite3';

// Opens the SQLite database and applies connection pragmas. Schema creation
// happens exclusively through migrations (see server/migrationList.ts).
export function openDb(file: string): Database.Database {
  const db = new Database(file);
  // DELETE journal mode (not WAL): WAL requires mmap, which fails on Unraid
  // FUSE mounts (/mnt/user) where this app is commonly deployed.
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  return db;
}
