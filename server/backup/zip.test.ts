import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { LocalStore } from './store';
import { streamSnapshotZip, unpackSnapshotZip } from './zip';
import type { BackupSource, Manifest } from './types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-zip-'));

describe('snapshot zip', () => {
  it('round-trips a snapshot (db, key, manifest, referenced objects only)', async () => {
    const a = new LocalStore(tmp());
    await a.putObject('a'.repeat(64), () => Readable.from([Buffer.from('one')]), 3);
    await a.putObject('b'.repeat(64), () => Readable.from([Buffer.from('unreferenced')]), 12);
    const dbPath = path.join(a.root, 'db'); fs.writeFileSync(dbPath, 'DB');
    const keyPath = path.join(a.root, 'k'); fs.writeFileSync(keyPath, 'KEY');
    const manifest: Manifest = { format: 1, createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, db: { size: 2, sha256: 'x' }, mailKey: { sha256: 'y' },
      files: [{ id: 'f1', sha256: 'a'.repeat(64), size: 3 }], counts: { files: 1, bytes: 3 }, warnings: [] };
    await a.writeSnapshot('20260912-000000', { dbPath, mailKeyPath: keyPath, manifest });

    const zipPath = path.join(tmp(), 's.zip');
    await streamSnapshotZip(a, '20260912-000000', fs.createWriteStream(zipPath));

    const bRoot = tmp();
    const { snapshotId } = await unpackSnapshotZip(zipPath, bRoot);
    const b = new LocalStore(bRoot);
    expect(snapshotId).toBe('20260912-000000');
    expect((await b.readManifest(snapshotId)).files[0].id).toBe('f1');
    expect(fs.readFileSync(b.objectPath('a'.repeat(64)), 'utf8')).toBe('one');
    expect(fs.existsSync(b.objectPath('b'.repeat(64)))).toBe(false);
    expect(fs.readFileSync(path.join(b.snapshotDir(snapshotId), 'app.db'), 'utf8')).toBe('DB');
    expect(fs.readFileSync(path.join(b.snapshotDir(snapshotId), 'mail.key'), 'utf8')).toBe('KEY');
  });

  it('holds only a couple of file descriptors open while zipping a snapshot with many objects', async () => {
    // Regression: the archive used to open every object's read stream before
    // archiver consumed any of them, so a real snapshot (thousands of files)
    // hit EMFILE and took the server down with an unhandled stream error.
    const a = new LocalStore(tmp());
    const files: Manifest['files'] = [];
    for (let i = 0; i < 300; i++) {
      const sha = i.toString(16).padStart(64, '0');
      await a.putObject(sha, () => Readable.from([Buffer.from(`o${i}`)]), 2);
      files.push({ id: `f${i}`, sha256: sha, size: 2 });
    }
    const dbPath = path.join(a.root, 'db'); fs.writeFileSync(dbPath, 'DB');
    const manifest: Manifest = { format: 1, createdAt: 1, appVersion: '3.3.0', schemaVersion: 36, db: { size: 2, sha256: 'x' }, mailKey: { source: 'env' },
      files, counts: { files: files.length, bytes: 600 }, warnings: [] };
    await a.writeSnapshot('20260912-000000', { dbPath, mailKeyPath: null, manifest });

    // Sampled every event-loop turn for the whole zip: the eager version spikes
    // to one descriptor per object, the lazy one stays flat.
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, fs.readdirSync('/proc/self/fd').length); }, 1);
    const zipPath = path.join(tmp(), 'many.zip');
    try { await streamSnapshotZip(a, '20260912-000000', fs.createWriteStream(zipPath)); }
    finally { clearInterval(sampler); }

    expect(peak).toBeLessThan(50);
    const bRoot = tmp();
    await unpackSnapshotZip(zipPath, bRoot);
    const b = new LocalStore(bRoot);
    expect(fs.readdirSync(path.join(b.root, 'objects')).length).toBe(300);
  });

  it('rejects instead of crashing when an object stream errors mid-archive', async () => {
    // A non-local BackupSource (Drive) hands back network streams; one that
    // dies must reject this promise, not surface as an unhandled 'error'.
    const local = new LocalStore(tmp());
    const dbPath = path.join(local.root, 'db'); fs.writeFileSync(dbPath, 'DB');
    const manifest: Manifest = { format: 1, createdAt: 1, appVersion: '3.3.0', schemaVersion: 36, db: { size: 2, sha256: 'x' }, mailKey: { source: 'env' },
      files: [{ id: 'f1', sha256: 'a'.repeat(64), size: 3 }], counts: { files: 1, bytes: 3 }, warnings: [] };
    await local.writeSnapshot('20260912-000000', { dbPath, mailKeyPath: null, manifest });
    const remote: BackupSource = {
      listSnapshots: async () => [],
      readManifest: async () => manifest,
      openSnapshotFile: async () => Readable.from([Buffer.from('DB')]),
      openObject: async () => new Readable({ read() { this.destroy(new Error('connection reset')); } }),
    };
    const out = fs.createWriteStream(path.join(tmp(), 'broken.zip'));
    await expect(streamSnapshotZip(remote, '20260912-000000', out)).rejects.toThrow(/connection reset/);
  });

  it('rejects a zip without a manifest', async () => {
    const zipPath = path.join(tmp(), 'bad.zip');
    const archiver = (await import('archiver')).default;
    const out = fs.createWriteStream(zipPath);
    const ar = archiver('zip'); ar.pipe(out); ar.append('x', { name: 'objects/' + 'c'.repeat(64) }); await ar.finalize();
    await new Promise<void>(r => out.on('close', r));
    await expect(unpackSnapshotZip(zipPath, tmp())).rejects.toThrow(/manifest/);
  });

  it('rejects (rather than throwing out of the entry handler) when an entry cannot be written', async () => {
    // A plain FILE where objects/ must be a directory makes the mkdirSync in
    // the yauzl entry handler throw synchronously; that used to escape the
    // promise instead of rejecting it.
    const srcRoot = tmp();
    const a = new LocalStore(srcRoot);
    await a.putObject('a'.repeat(64), () => Readable.from([Buffer.from('one')]), 3);
    const dbPath = path.join(srcRoot, 'db'); fs.writeFileSync(dbPath, 'DB');
    const manifest: Manifest = { format: 1, createdAt: 1, appVersion: '3.3.0', schemaVersion: 36, db: { size: 2, sha256: 'x' }, mailKey: { source: 'env' },
      files: [{ id: 'f1', sha256: 'a'.repeat(64), size: 3 }], counts: { files: 1, bytes: 3 }, warnings: [] };
    await a.writeSnapshot('20260912-000000', { dbPath, mailKeyPath: null, manifest });
    const zipPath = path.join(tmp(), 'ok.zip');
    await streamSnapshotZip(a, '20260912-000000', fs.createWriteStream(zipPath));

    const into = tmp();
    fs.writeFileSync(path.join(into, 'objects'), 'not a directory');
    await expect(unpackSnapshotZip(zipPath, into)).rejects.toThrow();
  });
});
