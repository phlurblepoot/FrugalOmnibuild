// server/backup/restore.ts — rebuild a data dir from one snapshot (spec §Setup mode and restore).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import type Database from 'better-sqlite3';
import { pathFor } from '../fileStore';
import { latestSchemaVersion } from './snapshot';
import type { BackupSource, Manifest } from './types';

export class RestoreRefusedError extends Error {}
export const DEFAULT_ADMIN_ID = 'admin-id-123';

export function isFreshInstall(db: Database.Database): boolean {
  const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
  if (users.length !== 1 || users[0].id !== DEFAULT_ADMIN_ID) return false;
  const projects = (db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c;
  const files = (db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c;
  return projects === 0 && files === 0;
}

export interface RestoreDeps { dataDir: string; closeDb: () => void; exit: (code: number) => void; log?: (m: string) => void }

/** Copies `src` to `dest` (tmp + rename) while hashing; throws if the hash differs from `expected`. */
async function copyVerified(src: NodeJS.ReadableStream, dest: string, expected: string): Promise<number> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.restore.tmp`;
  const h = crypto.createHash('sha256'); let size = 0;
  const tap = new Transform({ transform(chunk, _e, cb) { h.update(chunk); size += chunk.length; cb(null, chunk); } });
  try {
    await pipeline(src, tap, fs.createWriteStream(tmp));
    const got = h.digest('hex');
    if (got !== expected) throw new RestoreRefusedError(`object ${expected} failed its hash check (got ${got})`);
    fs.renameSync(tmp, dest);
    return size;
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* none */ } throw e; }
}

export async function restoreSnapshot(source: BackupSource, snapshotId: string, deps: RestoreDeps): Promise<{ finish: () => void; files: number; bytes: number }> {
  const log = deps.log ?? ((m: string) => console.log(`[backup] ${m}`));
  const manifest: Manifest = await source.readManifest(snapshotId);
  if (manifest.format !== 1) throw new RestoreRefusedError(`Unknown snapshot format ${String((manifest as any).format)}`);
  const latest = latestSchemaVersion();
  if (manifest.schemaVersion > latest) {
    throw new RestoreRefusedError(`This snapshot was made by a newer app (schema ${manifest.schemaVersion}); this server is at schema ${latest}. Update the app first.`);
  }
  // 1. every object, verified, before the database is touched
  let bytes = 0;
  for (const f of manifest.files) {
    bytes += await copyVerified(await source.openObject(f.sha256), pathFor(deps.dataDir, f.id), f.sha256);
  }
  log(`restore ${snapshotId}: ${manifest.files.length} file(s) verified`);
  // 2. mail key (the sealed credentials in the restored db need the original)
  if ('sha256' in manifest.mailKey) {
    const keyPath = path.join(deps.dataDir, 'mail.key');
    await copyVerified(await source.openSnapshotFile(snapshotId, 'mail.key'), keyPath, manifest.mailKey.sha256);
    // loadMailCrypto creates this 0600; a restored copy inherits the umask
    // instead, so put the original mode back on the one file that unseals
    // every stored mail credential.
    fs.chmodSync(keyPath, 0o600);
  }
  // 3. database, staged beside the live one
  const staged = path.join(deps.dataDir, 'app.db.restored');
  await copyVerified(await source.openSnapshotFile(snapshotId, 'app.db'), staged, manifest.db.sha256);
  const finish = () => {
    deps.closeDb();
    fs.renameSync(staged, path.join(deps.dataDir, 'app.db'));
    log(`restore ${snapshotId}: database in place — exiting for restart`);
    deps.exit(0);
  };
  return { finish, files: manifest.files.length, bytes };
}
