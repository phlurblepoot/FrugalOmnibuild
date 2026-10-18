// server/backup/zip.ts — a snapshot as one portable archive (spec §Storage layout).
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import type { BackupSource } from './types';
import { isSnapshotId } from './types';
import { LocalStore } from './store';

/**
 * Streams one snapshot out as a zip.
 *
 * Every source file is opened LAZILY. Appending an already-open stream per
 * object means one file descriptor per object is held from the moment the
 * archive is described until archiver gets round to reading it — a snapshot
 * with a few thousand files hit EMFILE, and the resulting ReadStream 'error'
 * had no listener, so it took the process down. A LocalStore (the only source
 * the download route uses) therefore goes through `ar.file()`, which opens
 * each path on demand; any other source appends one stream at a time, waiting
 * for archiver to take the previous entry first.
 */
export async function streamSnapshotZip(source: BackupSource, snapshotId: string, out: NodeJS.WritableStream): Promise<void> {
  const manifest = await source.readManifest(snapshotId);
  const ar = archiver('zip', { zlib: { level: 1 } }); // blobs are mostly already-compressed; favor speed
  let fail: (e: unknown) => void = () => {};
  let failed: unknown = null;
  const done = new Promise<void>((resolve, reject) => {
    fail = (e: unknown) => { failed ??= e; reject(e); };
    const settle = () => { if (failed) reject(failed); else resolve(); };
    out.on('finish', settle); out.on('close', settle);
    ar.on('error', fail); out.on('error', fail);
  });
  // Nothing below may reject before `done` is awaited without a handler attached.
  done.catch(() => { /* surfaced by the awaits below */ });
  ar.pipe(out);
  ar.append(JSON.stringify(manifest, null, 2), { name: `snapshots/${snapshotId}/manifest.json` });

  const wantsMailKey = 'sha256' in manifest.mailKey;
  if (source instanceof LocalStore) {
    const dir = source.snapshotDir(snapshotId);
    ar.file(path.join(dir, 'app.db'), { name: `snapshots/${snapshotId}/app.db` });
    if (wantsMailKey) ar.file(path.join(dir, 'mail.key'), { name: `snapshots/${snapshotId}/mail.key` });
    for (const f of manifest.files) ar.file(source.objectPath(f.sha256), { name: `objects/${f.sha256}` });
  } else {
    // One at a time: open, append, wait for archiver to consume it, repeat.
    const appendOne = async (open: () => Promise<NodeJS.ReadableStream>, name: string): Promise<void> => {
      const rs = await open();
      const taken = new Promise<void>(resolve => ar.once('entry', () => resolve()));
      rs.on('error', fail); // otherwise an 'error' with no listener kills the process
      ar.append(rs as Readable, { name });
      await Promise.race([taken, done]);
    };
    await appendOne(() => source.openSnapshotFile(snapshotId, 'app.db'), `snapshots/${snapshotId}/app.db`);
    if (wantsMailKey) await appendOne(() => source.openSnapshotFile(snapshotId, 'mail.key'), `snapshots/${snapshotId}/mail.key`);
    for (const f of manifest.files) await appendOne(() => source.openObject(f.sha256), `objects/${f.sha256}`);
  }
  ar.finalize().catch(fail);
  await done;
}

const ENTRY = /^(objects\/[0-9a-f]{64}|snapshots\/(\d{8}-\d{6})\/(app\.db|mail\.key|manifest\.json))$/;

/** Unpacks a snapshot zip into a LocalStore rooted at `intoRoot`; returns the snapshot id found. Rejects a zip with no manifest or with entries outside objects/ + snapshots/<id>/. */
export function unpackSnapshotZip(zipPath: string, intoRoot: string): Promise<{ snapshotId: string }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open zip'));
      let snapshotId: string | null = null; let sawManifest = false; let settled = false;
      // Every failure path closes the handle: yauzl holds the zip's own file
      // descriptor open until it is told otherwise.
      const fail = (e: unknown): void => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closing */ }
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      zip.on('error', fail);
      zip.on('entry', entry => {
        // A synchronous throw in here (mkdirSync on an unwritable target, say)
        // escapes the promise entirely unless it is caught and turned into a
        // rejection.
        try {
          if (entry.fileName.endsWith('/')) return zip.readEntry();
          const m = ENTRY.exec(entry.fileName);
          if (!m) return fail(new Error(`unexpected entry in snapshot zip: ${entry.fileName}`));
          if (m[2]) { if (snapshotId && snapshotId !== m[2]) return fail(new Error('zip holds more than one snapshot')); snapshotId = m[2]; }
          if (m[3] === 'manifest.json') sawManifest = true;
          const dest = path.join(intoRoot, entry.fileName);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          zip.openReadStream(entry, (e, rs) => {
            if (e || !rs) return fail(e ?? new Error('bad entry'));
            pipeline(rs, fs.createWriteStream(dest)).then(() => zip.readEntry(), fail);
          });
        } catch (e) { fail(e); }
      });
      zip.on('end', () => {
        if (settled) return;
        if (!snapshotId || !sawManifest || !isSnapshotId(snapshotId)) return fail(new Error('zip is missing snapshots/<id>/manifest.json'));
        settled = true;
        resolve({ snapshotId });
      });
      zip.readEntry();
    });
  });
}
