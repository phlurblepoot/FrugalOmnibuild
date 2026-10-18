// server/onlyoffice/thumbnails.ts — small pictures of stored files, for the
// Documents list and photo tiles (ONLYOFFICE Phase 4):
//
//   * Documents: the Document Server's conversion service renders page one as
//     a PNG (`thumbnail.first`). Made in the background, one at a time: after
//     an upload or an editor save, and whenever the list asks for one that
//     isn't there yet.
//   * Photos: shrunk here with sharp to a WebP, turned upright by its EXIF
//     orientation. Quick, so made while the request waits (a couple at a time)
//     as well as after an upload. Needs no Document Server.
//
// Cached on disk by content hash (<dataDir>/thumbnails/<sha256>.png|.webp), so
// a file's thumbnail follows its current version automatically and identical
// files share one. They are only a picture of the file, rebuilt on demand, so
// backups skip them.
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type Database from 'better-sqlite3';
import { getMeta, type FileMeta } from '../files';
import { pathFor as storedPathFor } from '../fileStore';
import { officeFormatOf } from '../../src/utils/officeFormats';
import { hasPhotoThumbnail } from '../../src/utils/photoFormats';
import { readOnlyofficeConfig } from './config';
import type { LinkTokens } from './tokens';
import { fileLink } from './links';
import { OnlyofficeError, convert, downloadFromOnlyoffice } from './client';

/** The longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 320;
/** Photos also fill tiles a couple of hundred pixels wide on a sharp
 *  screen, so they get a bigger one. */
export const PHOTO_THUMBNAIL_SIZE = 480;
/** After a failure, how long before the same bytes are tried again. */
const RETRY_AFTER_MS = 60 * 60_000;
/** Photos shrunk at once: each can take a few hundred MB decoding. */
const PHOTO_JOBS = 2;

// Each photo is read once; nothing to gain from libvips holding on to it (and
// a held file would keep a deleted one's disk space).
sharp.cache(false);

export interface ThumbnailDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
  dataDir: string;
  tokens: LinkTokens;
  fetch: typeof fetch;
  now?: () => number;
}

export type ThumbnailState = 'ready' | 'pending' | 'none';

export class Thumbnails {
  private readonly dir: string;
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private running: Promise<void> | null = null;
  private readonly photoJobs = new Map<string, Promise<string | null>>();
  private photoSlots = PHOTO_JOBS;
  private readonly photoWaiting: (() => void)[] = [];

  constructor(private readonly deps: ThumbnailDeps) {
    // Absolute, for res.sendFile (STORAGE_PATH may be relative).
    this.dir = path.resolve(deps.dataDir, 'thumbnails');
  }

  private now = () => (this.deps.now ?? Date.now)();
  pathFor = (sha256: string) => path.join(this.dir, `${sha256}.png`);
  photoPathFor = (sha256: string) => path.join(this.dir, `${sha256}.webp`);

  /** Whether a document can have a thumbnail: something ONLYOFFICE opens.
   *  (Photos have their own, from photo().) */
  eligible(meta: { mime: string; name: string | null; parentFileId?: string | null }): boolean {
    return !!officeFormatOf(meta);
  }

  private recentlyFailed(sha256: string): boolean {
    const failed = this.failedAt.get(sha256);
    return !!failed && this.now() - failed < RETRY_AFTER_MS;
  }

  /** Where a file's thumbnail stands, queueing it when it's missing. */
  state(fileId: string): { state: ThumbnailState; path?: string } {
    const meta = getMeta(this.deps.db, fileId);
    if (!meta || !this.eligible(meta) || !meta.sha256) return { state: 'none' };
    const p = this.pathFor(meta.sha256);
    if (fs.existsSync(p)) return { state: 'ready', path: p };
    if (!readOnlyofficeConfig(this.deps.env).config) return { state: 'none' };
    if (this.recentlyFailed(meta.sha256)) return { state: 'none' };
    this.enqueue(fileId);
    return { state: 'pending' };
  }

  /** Queues a file (by id: the bytes are whatever it holds when its turn comes). */
  enqueue(fileId: string): void {
    if (this.queued.has(fileId)) return;
    this.queued.add(fileId);
    this.queue.push(fileId);
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
  }

  /** Resolves once everything queued so far is done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
      this.queued.delete(id);
      try { await this.make(id); } catch (e) {
        console.warn(`[onlyoffice] thumbnail for ${id} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  /** A photo's thumbnail, made now if it isn't there yet. Null when the file
   *  isn't a photo this can read (or reading it failed): show the original. */
  async photo(fileId: string): Promise<string | null> {
    const meta = getMeta(this.deps.db, fileId);
    if (!meta || !meta.sha256 || !hasPhotoThumbnail(meta)) return null;
    const out = this.photoPathFor(meta.sha256);
    if (fs.existsSync(out)) return out;
    if (this.recentlyFailed(meta.sha256)) return null;
    // Asked for twice at once (the list and a tile): made once.
    let job = this.photoJobs.get(meta.sha256);
    if (!job) {
      job = this.withPhotoSlot(() => this.makePhoto(meta, out)).finally(() => this.photoJobs.delete(meta.sha256));
      this.photoJobs.set(meta.sha256, job);
    }
    return job;
  }

  private async withPhotoSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.photoSlots > 0) this.photoSlots--;
    else await new Promise<void>(resolve => this.photoWaiting.push(resolve));
    try { return await fn(); } finally {
      // Hand the slot straight to the next in line, or give it back.
      const next = this.photoWaiting.shift();
      if (next) next(); else this.photoSlots++;
    }
  }

  private async makePhoto(meta: FileMeta, out: string): Promise<string | null> {
    if (fs.existsSync(out)) return out;
    try {
      // failOn 'none': a phone photo cut short in transfer still gets a picture.
      const webp = await sharp(storedPathFor(this.deps.dataDir, meta.id), { failOn: 'none' })
        .rotate()
        .resize(PHOTO_THUMBNAIL_SIZE, PHOTO_THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      this.write(out, webp);
      this.failedAt.delete(meta.sha256);
      return out;
    } catch (e) {
      this.failedAt.set(meta.sha256, this.now());
      console.warn(`[thumbnails] photo ${meta.id} failed:`, e instanceof Error ? e.message : e);
      return null;
    }
  }

  private write(out: string, bytes: Buffer): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, out);
  }

  private async make(fileId: string): Promise<void> {
    const meta = getMeta(this.deps.db, fileId);
    if (meta && hasPhotoThumbnail(meta)) { await this.photo(fileId); return; }
    const { config: cfg } = readOnlyofficeConfig(this.deps.env);
    const format = meta ? officeFormatOf(meta) : null;
    if (!cfg || !meta || !format || !meta.sha256) return;
    const out = this.pathFor(meta.sha256);
    if (fs.existsSync(out)) return;
    try {
      const result = await convert(cfg, this.deps.fetch, {
        filetype: format.ext, outputtype: 'png',
        key: `thumb-${meta.sha256.slice(0, 40)}-${THUMBNAIL_SIZE}`,
        title: meta.name ?? `file.${format.ext}`,
        url: fileLink(cfg, this.deps.tokens, meta.id),
        thumbnail: { aspect: 1, first: true, width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE },
      }, 60_000);
      const png = await downloadFromOnlyoffice(cfg, this.deps.fetch, result.fileUrl, 60_000);
      this.write(out, png);
      this.failedAt.delete(meta.sha256);
    } catch (e) {
      this.failedAt.set(meta.sha256, this.now());
      throw e instanceof OnlyofficeError ? e : new Error(String(e));
    }
  }

  /** Deletes thumbnails no stored file has the bytes of any more (deleted
   *  files, replaced versions). Returns how many went. */
  sweep(): number {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return 0; }
    // Only live files are ever shown; an archived version's picture is waste.
    const live = new Set((this.deps.db.prepare('SELECT DISTINCT sha256 FROM files WHERE parentFileId IS NULL').all() as { sha256: string }[]).map(r => r.sha256));
    let removed = 0;
    for (const n of names) {
      const m = /^([0-9a-f]{64})\.(?:png|webp)$/.exec(n);
      if (m && live.has(m[1])) continue;
      try { fs.unlinkSync(path.join(this.dir, n)); removed++; } catch { /* already gone */ }
    }
    return removed;
  }
}
