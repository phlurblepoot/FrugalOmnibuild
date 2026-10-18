// server/backup/store.ts
//
// The on-disk backup layout (spec §Storage layout):
//   <root>/objects/<sha256>             one file per distinct content
//   <root>/snapshots/<id>/app.db|mail.key|manifest.json
// manifest.json is always written LAST, so a folder without one is an
// aborted run and every listing ignores it.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { pipeline as pipeStreams, Transform } from 'stream';
import type { BackupSource, BackupTarget, Manifest, SnapshotSummary } from './types';
import { isSnapshotId } from './types';

// Object names are sha256 hex and nothing else: the second alternative this
// used to carry made the 64-char branch dead and let shorter names through.
const isSha = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

export async function sha256OfStream(s: NodeJS.ReadableStream): Promise<{ sha256: string; size: number }> {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of s as AsyncIterable<Buffer>) { h.update(chunk); size += chunk.length; }
  return { sha256: h.digest('hex'), size };
}

/** `src` passed through unchanged, telling `onBytes` how many bytes have gone
 *  by so far. A read error surfaces on the returned stream, and a consumer
 *  that stops early closes `src` with it. */
export function countBytes(src: NodeJS.ReadableStream, onBytes: (sent: number) => void): NodeJS.ReadableStream {
  let sent = 0;
  const counter = new Transform({ transform(chunk: Buffer, _enc, cb) { sent += chunk.length; onBytes(sent); cb(null, chunk); } });
  pipeStreams(src, counter, () => { /* any error already reached `counter` */ });
  return counter;
}

export const summarize = (id: string, m: Manifest): SnapshotSummary => ({
  id, createdAt: m.createdAt, appVersion: m.appVersion, schemaVersion: m.schemaVersion,
  counts: m.counts, warnings: m.warnings.length,
});

export class LocalStore implements BackupTarget, BackupSource {
  readonly kind = 'local' as const;
  constructor(readonly root: string) {}

  objectPath(sha256: string): string {
    if (!isSha(sha256)) throw new Error('bad object id');
    return path.join(this.root, 'objects', sha256);
  }
  snapshotDir(id: string): string {
    if (!isSnapshotId(id)) throw new Error('bad snapshot id');
    return path.join(this.root, 'snapshots', id);
  }

  async listObjects(): Promise<Set<string>> {
    const dir = path.join(this.root, 'objects');
    if (!fs.existsSync(dir)) return new Set();
    return new Set(fs.readdirSync(dir).filter(f => !f.endsWith('.tmp')));
  }

  async putObject(sha256: string, source: () => NodeJS.ReadableStream, _size: number): Promise<void> {
    const dest = this.objectPath(sha256);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      await pipeline(source(), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      throw e;
    }
  }

  async writeSnapshot(id: string, files: { dbPath: string; mailKeyPath: string | null; manifest: Manifest }): Promise<void> {
    const dir = this.snapshotDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(files.dbPath, path.join(dir, 'app.db'));
    if (files.mailKeyPath) fs.copyFileSync(files.mailKeyPath, path.join(dir, 'mail.key'));
    const tmp = path.join(dir, 'manifest.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(files.manifest, null, 2));
    fs.renameSync(tmp, path.join(dir, 'manifest.json'));
  }

  async listSnapshots(): Promise<SnapshotSummary[]> {
    const dir = path.join(this.root, 'snapshots');
    if (!fs.existsSync(dir)) return [];
    const out: SnapshotSummary[] = [];
    for (const id of fs.readdirSync(dir)) {
      if (!isSnapshotId(id)) continue;
      const mp = path.join(dir, id, 'manifest.json');
      if (!fs.existsSync(mp)) continue;
      try { out.push(summarize(id, JSON.parse(fs.readFileSync(mp, 'utf8')) as Manifest)); }
      catch (e) { console.warn(`[backup] unreadable manifest in ${mp}:`, (e as Error).message); }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  async listIncompleteSnapshots(): Promise<string[]> {
    const dir = path.join(this.root, 'snapshots');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(id => isSnapshotId(id) && !fs.existsSync(path.join(dir, id, 'manifest.json')))
      .sort();
  }

  async readManifest(id: string): Promise<Manifest> {
    return JSON.parse(fs.readFileSync(path.join(this.snapshotDir(id), 'manifest.json'), 'utf8')) as Manifest;
  }

  async deleteSnapshot(id: string): Promise<void> {
    fs.rmSync(this.snapshotDir(id), { recursive: true, force: true });
  }

  async deleteObject(sha256: string): Promise<void> {
    fs.rmSync(this.objectPath(sha256), { force: true });
  }

  async openObject(sha256: string): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(this.objectPath(sha256));
  }

  async openSnapshotFile(id: string, name: 'app.db' | 'mail.key'): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(path.join(this.snapshotDir(id), name));
  }
}
