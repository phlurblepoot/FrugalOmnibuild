// server/backup/settings.ts — typed access to the private backup.* settings keys.
import type Database from 'better-sqlite3';
import type { MailCrypto } from '../mail/crypto';

export interface BackupSchedule { enabled: boolean; hour: number; minute: number }
/** Local and Drive backups each run on their own daily schedule. */
export interface BackupSchedules { local: BackupSchedule; drive: BackupSchedule }
export interface DriveConnection { refreshToken: string; email: string; folderId: string; objectsFolderId: string; snapshotsFolderId: string; needsReconnect?: boolean }

const get = (db: Database.Database, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const set = (db: Database.Database, key: string, value: string | null): void => {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};
const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

const OFF: BackupSchedule = { enabled: false, hour: 2, minute: 0 };
const normalize = (s: any): BackupSchedule => ({ enabled: !!s?.enabled, hour: clamp(s?.hour, 0, 23, 2), minute: clamp(s?.minute, 0, 59, 0) });
const parseSchedule = (raw: string | null): BackupSchedule | null => {
  if (raw === null) return null;
  try { const s = JSON.parse(raw); return s && typeof s === 'object' ? normalize(s) : null; } catch { return null; }
};

// Local keeps the key the single shared schedule always used. Drive has its
// own key, and until one is saved it follows the local schedule — which is
// what the shared schedule meant (local, then Drive straight after).
export function readSchedule(db: Database.Database): BackupSchedules {
  const local = parseSchedule(get(db, 'backup.schedule')) ?? OFF;
  return { local, drive: parseSchedule(get(db, 'backup.scheduleDrive')) ?? local };
}
/** Either half may be left out; both keys are written, so a Drive schedule
 *  that was only ever inherited is pinned before local moves away from it. */
export function writeSchedule(db: Database.Database, s: { local?: unknown; drive?: unknown }): void {
  const cur = readSchedule(db);
  set(db, 'backup.schedule', JSON.stringify(s.local ? normalize(s.local) : cur.local));
  set(db, 'backup.scheduleDrive', JSON.stringify(s.drive ? normalize(s.drive) : cur.drive));
}
export function readKeep(db: Database.Database): { local: number; drive: number } {
  const local = get(db, 'backup.keepLocal');
  const drive = get(db, 'backup.keepDrive');
  return {
    local: local === null ? 14 : clamp(local, 1, 365, 14),
    drive: drive === null ? 14 : clamp(drive, 1, 365, 14),
  };
}
export function writeKeep(db: Database.Database, k: { local?: unknown; drive?: unknown }): void {
  const cur = readKeep(db);
  set(db, 'backup.keepLocal', String(clamp(k.local ?? cur.local, 1, 365, 14)));
  set(db, 'backup.keepDrive', String(clamp(k.drive ?? cur.drive, 1, 365, 14)));
}
export function readDrive(db: Database.Database, crypto: MailCrypto): DriveConnection | null {
  const sealed = get(db, 'backup.drive'); if (!sealed) return null;
  try { return crypto.open<DriveConnection>(sealed); } catch { return null; }
}
export function writeDrive(db: Database.Database, crypto: MailCrypto, c: DriveConnection | null): void {
  set(db, 'backup.drive', c ? crypto.seal(c) : null);
}
