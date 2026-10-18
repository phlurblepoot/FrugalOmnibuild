// server/backup/drive.ts — Google Drive as a backup target/source (spec §Drive specifics).
// Raw fetch + the mail subsystem's TokenSource, exactly like the Gmail provider.
import fs from 'fs';
import { Readable } from 'stream';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { TokenSource } from '../mail/providers/tokenSource';
import { googleRefresh } from '../mail/providers/google';
import { AuthExpiredError } from '../mail/providers/types';
import type { MailCrypto } from '../mail/crypto';
import { readDrive, writeDrive, type DriveConnection } from './settings';
import type { BackupSource, BackupTarget, Manifest, SnapshotSummary } from './types';
import { isSnapshotId } from './types';
import { summarize, countBytes } from './store';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_STATE_TYP = 'backup_drive_state';
export const ROOT_FOLDER_NAME = 'FrugalOmnibuild Backups';
/** Installs made before the rename already have this folder; it keeps being used so their backup chain survives. */
export const LEGACY_ROOT_FOLDER_NAME = 'Frugal Takeoff Backups';
const API = 'https://www.googleapis.com/drive/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
// Google accepts a non-final resumable chunk only if its length is a multiple
// of 256 KiB, so every chunk we send is a whole number of these.
const ALIGN = 256 * 1024;
const CHUNK = 32 * ALIGN; // 8 MiB
const TIMEOUT_MS = 60_000;
// A throttled upload gets exactly one retry; Google says how long to hold off
// via Retry-After, and a backup run must not sit on a huge value for ever.
const RETRY_CAP_MS = 60_000;
const DEFAULT_RETRY_MS = 1000;

/** Retry-After as milliseconds: a count of seconds, or an HTTP date. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  const h = header?.trim();
  if (!h) return null;
  if (/^\d+$/.test(h)) return Math.min(Number(h) * 1000, RETRY_CAP_MS);
  const at = Date.parse(h);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), RETRY_CAP_MS);
}
/** Object names are content hashes and are interpolated into Drive `q`
 *  strings, so nothing but a sha256 may reach one. */
const isSha = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);
type Mode = 'admin' | 'setup';

export const driveRedirectUri = (publicUrl: string, mode: Mode): string =>
  `${publicUrl.replace(/\/+$/, '')}${mode === 'admin' ? '/api/backup/drive/callback' : '/api/setup/restore/drive/callback'}`;

export function driveAuthUrl(env: NodeJS.ProcessEnv, publicUrl: string, mode: Mode, state: string, codeChallenge: string): string {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set');
  const q = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID, redirect_uri: driveRedirectUri(publicUrl, mode), response_type: 'code',
    scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}
export function signDriveState(jwtSecret: string, p: { mode: Mode; verifier: string }): string {
  return jwt.sign({ ...p, nonce: randomBytes(8).toString('hex'), typ: DRIVE_STATE_TYP }, jwtSecret, { algorithm: 'HS256', expiresIn: 600 });
}
export function verifyDriveState(jwtSecret: string, state: string): { mode: Mode; verifier: string } {
  const c = jwt.verify(state, jwtSecret, { algorithms: ['HS256'] }) as any;
  if (c?.typ !== DRIVE_STATE_TYP || (c.mode !== 'admin' && c.mode !== 'setup') || typeof c.verifier !== 'string') throw new Error('not a Drive connect state');
  return { mode: c.mode, verifier: c.verifier };
}
export async function driveExchange(env: NodeJS.ProcessEnv, publicUrl: string, mode: Mode, code: string, verifier: string, fetchFn: typeof fetch): Promise<{ refreshToken: string; email: string }> {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: driveRedirectUri(publicUrl, mode) }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !body.access_token) throw new Error(`${body.error || res.status}: Google rejected the Drive sign-in`);
  if (!body.refresh_token) throw new Error("No refresh token returned — remove the app from your Google account's third-party access and try again");
  const info = await fetchFn('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const about = (await info.json().catch(() => ({}))) as any;
  return { refreshToken: String(body.refresh_token), email: String(about?.user?.emailAddress ?? '') };
}

type Access = () => Promise<string>;
async function api<T>(access: Access, fetchFn: typeof fetch, path: string, init: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<T> {
  const { query, ...rest } = init;
  const url = new URL(path.startsWith('http') ? path : API + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetchFn(url.toString(), { ...rest, headers: { ...(rest.headers as any), Authorization: `Bearer ${await access()}`, ...(rest.body && !(rest.body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) throw new AuthExpiredError('Google rejected the Drive token');
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  if (res.status === 204) return undefined as T;
  const text = await res.text(); return (text ? JSON.parse(text) : undefined) as T;
}
const listAll = async (access: Access, fetchFn: typeof fetch, q: string, fields = 'files(id,name,mimeType)'): Promise<{ id: string; name: string; mimeType: string }[]> => {
  const out: any[] = []; let pageToken: string | undefined;
  do {
    const r = await api<{ files: any[]; nextPageToken?: string }>(access, fetchFn, 'files', { query: { q, fields: `nextPageToken,${fields}`, pageSize: '1000', pageToken, spaces: 'drive' } });
    out.push(...(r.files ?? [])); pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
};
const findOrCreateFolder = async (access: Access, fetchFn: typeof fetch, name: string, parent: string | null, alsoFind?: string): Promise<string> => {
  const q = `name = '${name}' and mimeType = '${FOLDER}' and trashed = false` + (parent ? ` and '${parent}' in parents` : '');
  const found = await listAll(access, fetchFn, q);
  if (found[0]) return found[0].id;
  if (alsoFind) { const old = await listAll(access, fetchFn, q.replace(`name = '${name}'`, `name = '${alsoFind}'`)); if (old[0]) return old[0].id; }
  const r = await api<{ id: string }>(access, fetchFn, 'files', { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined }) });
  return r.id;
};
export async function ensureDriveFolders(access: Access, fetchFn: typeof fetch): Promise<{ folderId: string; objectsFolderId: string; snapshotsFolderId: string }> {
  const folderId = await findOrCreateFolder(access, fetchFn, ROOT_FOLDER_NAME, null, LEGACY_ROOT_FOLDER_NAME);
  return { folderId, objectsFolderId: await findOrCreateFolder(access, fetchFn, 'objects', folderId), snapshotsFolderId: await findOrCreateFolder(access, fetchFn, 'snapshots', folderId) };
}

export class DriveStore implements BackupTarget, BackupSource {
  readonly kind = 'drive' as const;
  private tokens: TokenSource;
  private access: Access;
  private sleep: (ms: number) => Promise<void>;
  constructor(private conn: DriveConnection, private opts: { env: NodeJS.ProcessEnv; fetch: typeof fetch; onRotate?: (t: string) => void; onAuthExpired?: () => void; sleep?: (ms: number) => Promise<void> }) {
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.tokens = new TokenSource({ refreshToken: conn.refreshToken, refresh: t => googleRefresh(opts.env, t, opts.fetch), onRotate: opts.onRotate });
    this.access = async () => { try { return await this.tokens.get(); } catch (e) { if (e instanceof AuthExpiredError) opts.onAuthExpired?.(); throw e; } };
  }
  private call<T>(path: string, init?: RequestInit & { query?: Record<string, string | undefined> }): Promise<T> { return api<T>(this.access, this.opts.fetch, path, init); }

  async listObjects(): Promise<Set<string>> {
    return new Set((await listAll(this.access, this.opts.fetch, `'${this.conn.objectsFolderId}' in parents and trashed = false and mimeType != '${FOLDER}'`, 'files(name)')).map(f => f.name));
  }
  private async upload(name: string, parent: string, source: () => NodeJS.ReadableStream, size: number): Promise<void> {
    const attempt = async (): Promise<void> => {
      const init = await this.opts.fetch(`${UPLOAD}?uploadType=resumable`, {
        method: 'POST', headers: { Authorization: `Bearer ${await this.access()}`, 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(size) },
        body: JSON.stringify({ name, parents: [parent] }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (init.status === 401) throw new AuthExpiredError('Google rejected the Drive token');
      const session = init.headers.get('Location'); if (!init.ok || !session) throw new Error(`Drive upload init ${init.status}`);
      let offset = 0; let buf = Buffer.alloc(0); let complete = false;
      // A 2xx is Drive saying the whole object landed; a 308 only means "still
      // listening". Tracking which one came back is what stops a source that
      // runs short of `size` from being recorded as a stored object.
      const send = async (body: Buffer) => {
        const range = body.length ? `bytes ${offset}-${offset + body.length - 1}/${size}` : `bytes */${size}`;
        const r = await this.opts.fetch(session, { method: 'PUT', headers: { 'Content-Length': String(body.length), 'Content-Range': range }, body: body as any, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Drive upload ${r.status}`), { retryable: true, retryAfter: retryAfterMs(r.headers.get('Retry-After')) });
        if (!r.ok && r.status !== 308) throw new Error(`Drive upload ${r.status}`);
        offset += body.length; complete = r.ok;
      };
      // Send only whole CHUNKs while the stream runs — whatever a source hands
      // us in one read is almost never a multiple of ALIGN — and keep the
      // remainder buffered for the final, unaligned call.
      for await (const chunk of source() as AsyncIterable<Buffer>) {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= CHUNK) { await send(buf.subarray(0, CHUNK)); buf = buf.subarray(CHUNK); }
      }
      // A size that is an exact multiple of CHUNK is already finished, so it
      // needs no final call; a zero-byte file is finalised with `bytes */0`.
      if (buf.length || !complete) await send(buf);
      if (!complete) throw new Error(`Drive upload of ${name} did not complete — the source gave ${offset} of the ${size} bytes expected`);
    };
    try { await attempt(); }
    catch (e: any) {
      if (!e?.retryable) throw e;
      await this.sleep(typeof e.retryAfter === 'number' ? e.retryAfter : DEFAULT_RETRY_MS);
      await attempt();
    }
  }
  async putObject(sha256: string, source: () => NodeJS.ReadableStream, size: number): Promise<void> { if (!isSha(sha256)) throw new Error('bad object id'); await this.upload(sha256, this.conn.objectsFolderId, source, size); }
  async writeSnapshot(id: string, files: { dbPath: string; mailKeyPath: string | null; manifest: Manifest; onDbBytes?: (sent: number) => void }): Promise<void> {
    const folder = await findOrCreateFolder(this.access, this.opts.fetch, id, this.conn.snapshotsFolderId);
    const up = (name: string, p: string, onBytes?: (sent: number) => void) =>
      this.upload(name, folder, () => (onBytes ? countBytes(fs.createReadStream(p), onBytes) : fs.createReadStream(p)), fs.statSync(p).size);
    await up('app.db', files.dbPath, files.onDbBytes);
    if (files.mailKeyPath) await up('mail.key', files.mailKeyPath);
    const m = Buffer.from(JSON.stringify(files.manifest, null, 2));
    await this.upload('manifest.json', folder, () => Readable.from([m]), m.length); // LAST
  }
  private async snapshotFolder(id: string): Promise<string | null> {
    if (!isSnapshotId(id)) throw new Error('bad snapshot id');
    return (await listAll(this.access, this.opts.fetch, `name = '${id}' and '${this.conn.snapshotsFolderId}' in parents and trashed = false`))[0]?.id ?? null;
  }
  private async fileIn(folderId: string, name: string): Promise<string | null> {
    return (await listAll(this.access, this.opts.fetch, `name = '${name}' and '${folderId}' in parents and trashed = false`))[0]?.id ?? null;
  }
  private async download(fileId: string): Promise<NodeJS.ReadableStream> {
    const r = await this.opts.fetch(`${API}files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${await this.access()}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`Drive download ${r.status}`);
    return Readable.fromWeb(r.body as any);
  }
  async readManifest(id: string): Promise<Manifest> {
    const folder = await this.snapshotFolder(id); const fid = folder && await this.fileIn(folder, 'manifest.json');
    if (!fid) throw new Error('Snapshot not found on Drive');
    const chunks: Buffer[] = []; for await (const c of (await this.download(fid)) as AsyncIterable<Buffer>) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Manifest;
  }
  async listSnapshots(): Promise<SnapshotSummary[]> {
    const folders = await listAll(this.access, this.opts.fetch, `'${this.conn.snapshotsFolderId}' in parents and mimeType = '${FOLDER}' and trashed = false`);
    const out: SnapshotSummary[] = [];
    for (const f of folders) { if (!isSnapshotId(f.name)) continue; try { out.push(summarize(f.name, await this.readManifest(f.name))); } catch { /* incomplete snapshot: no manifest */ } }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }
  async listIncompleteSnapshots(): Promise<string[]> {
    const folders = await listAll(this.access, this.opts.fetch, `'${this.conn.snapshotsFolderId}' in parents and mimeType = '${FOLDER}' and trashed = false`);
    const out: string[] = [];
    for (const f of folders) { if (isSnapshotId(f.name) && !(await this.fileIn(f.id, 'manifest.json'))) out.push(f.name); }
    return out.sort();
  }
  async deleteSnapshot(id: string): Promise<void> { const f = await this.snapshotFolder(id); if (f) await this.call(`files/${f}`, { method: 'DELETE' }); }
  async deleteObject(sha256: string): Promise<void> { if (!isSha(sha256)) throw new Error('bad object id'); const f = await this.fileIn(this.conn.objectsFolderId, sha256); if (f) await this.call(`files/${f}`, { method: 'DELETE' }); }
  async openObject(sha256: string): Promise<NodeJS.ReadableStream> { if (!isSha(sha256)) throw new Error('bad object id'); const f = await this.fileIn(this.conn.objectsFolderId, sha256); if (!f) throw new Error(`object ${sha256} missing on Drive`); return this.download(f); }
  async openSnapshotFile(id: string, name: 'app.db' | 'mail.key'): Promise<NodeJS.ReadableStream> { const folder = await this.snapshotFolder(id); const f = folder && await this.fileIn(folder, name); if (!f) throw new Error(`${name} missing on Drive`); return this.download(f); }
}

export function createDriveStore(conn: DriveConnection, o: { db: Database.Database; env: NodeJS.ProcessEnv; mailCrypto: MailCrypto; fetch: typeof fetch }): DriveStore {
  return new DriveStore(conn, {
    env: o.env, fetch: o.fetch,
    onRotate: t => { const c = readDrive(o.db, o.mailCrypto); if (c) writeDrive(o.db, o.mailCrypto, { ...c, refreshToken: t }); },
    onAuthExpired: () => { const c = readDrive(o.db, o.mailCrypto); if (c) writeDrive(o.db, o.mailCrypto, { ...c, needsReconnect: true }); },
  });
}
