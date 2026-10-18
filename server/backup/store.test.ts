import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { LocalStore, sha256OfStream } from './store';
import type { Manifest } from './types';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bk-')); });

const manifest = (files: Manifest['files'], createdAt = 1): Manifest => ({
  format: 1, createdAt, appVersion: '3.2.0', schemaVersion: 36,
  db: { size: 3, sha256: 'db' }, mailKey: { source: 'env' }, files,
  counts: { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) }, warnings: [],
});
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const bytes = (s: string) => () => Readable.from([Buffer.from(s)]);

describe('LocalStore objects', () => {
  it('putObject writes atomically under objects/<sha> and listObjects reports it', async () => {
    const st = new LocalStore(root);
    await st.putObject('aa11'.repeat(16), bytes('hello'), 5);
    expect(fs.readFileSync(path.join(root, 'objects', 'aa11'.repeat(16)), 'utf8')).toBe('hello');
    expect(fs.readdirSync(path.join(root, 'objects')).filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(await st.listObjects()).toEqual(new Set(['aa11'.repeat(16)]));
    const s = await st.openObject('aa11'.repeat(16));
    expect((await sha256OfStream(s)).size).toBe(5);
  });

  it('putObject leaves no partial file when the source stream errors', async () => {
    const st = new LocalStore(root);
    const bad = () => { const r = new Readable({ read() { this.destroy(new Error('boom')); } }); return r; };
    await expect(st.putObject('bb22'.repeat(16), bad, 1)).rejects.toThrow('boom');
    expect(fs.existsSync(path.join(root, 'objects', 'bb22'.repeat(16)))).toBe(false);
    expect(fs.existsSync(path.join(root, 'objects'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'objects'))).toEqual([]);
  });
});

describe('LocalStore snapshots', () => {
  it('writeSnapshot lays out app.db, mail.key, manifest.json (manifest last) and listSnapshots reads them newest first', async () => {
    const st = new LocalStore(root);
    const dbPath = path.join(root, 'tmp.db'); write(dbPath, 'DB!');
    const keyPath = path.join(root, 'k'); write(keyPath, 'KEY');
    await st.writeSnapshot('20260912-010203', { dbPath, mailKeyPath: keyPath, manifest: manifest([], 5) });
    await st.writeSnapshot('20260913-010203', { dbPath, mailKeyPath: null, manifest: manifest([], 9) });
    const dir = path.join(root, 'snapshots', '20260912-010203');
    expect(fs.readFileSync(path.join(dir, 'app.db'), 'utf8')).toBe('DB!');
    expect(fs.readFileSync(path.join(dir, 'mail.key'), 'utf8')).toBe('KEY');
    expect(fs.existsSync(path.join(root, 'snapshots', '20260913-010203', 'mail.key'))).toBe(false);
    const list = await st.listSnapshots();
    expect(list.map(s => s.id)).toEqual(['20260913-010203', '20260912-010203']);
    expect(list[1].createdAt).toBe(5);
    expect((await st.readManifest('20260912-010203')).createdAt).toBe(5);
  });

  it('a snapshot folder without manifest.json is ignored', async () => {
    const st = new LocalStore(root);
    write(path.join(root, 'snapshots', '20260901-000000', 'app.db'), 'x');
    expect(await st.listSnapshots()).toEqual([]);
  });

  it('deleteSnapshot and deleteObject remove exactly their paths', async () => {
    const st = new LocalStore(root);
    const dbPath = path.join(root, 'tmp.db'); write(dbPath, 'DB!');
    await st.writeSnapshot('20260912-010203', { dbPath, mailKeyPath: null, manifest: manifest([]) });
    await st.putObject('cc33'.repeat(16), bytes('c'), 1);
    await st.deleteSnapshot('20260912-010203');
    await st.deleteObject('cc33'.repeat(16));
    expect(fs.existsSync(path.join(root, 'snapshots', '20260912-010203'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'objects', 'cc33'.repeat(16)))).toBe(false);
  });

  it('rejects ids that are not snapshot ids or hex hashes (no path traversal)', async () => {
    const st = new LocalStore(root);
    await expect(st.readManifest('../etc')).rejects.toThrow();
    await expect(st.openObject('../../x')).rejects.toThrow();
  });
});
