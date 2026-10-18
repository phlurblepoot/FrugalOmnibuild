// server/backup/routes.ts — admin backup routes + fresh-install restore routes
// (spec §Backup routes, §Setup mode and restore).
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { MailCrypto } from '../mail/crypto';
import type { EntityChangedEvent } from '../realtime/changeFeed';
import { LocalStore } from './store';
import { takeSnapshot, listRuns, isRunActive, BackupRunningError, type BackupProgress, type SnapshotResult } from './snapshot';
import { streamSnapshotZip, unpackSnapshotZip } from './zip';
import { isFreshInstall, restoreSnapshot, RestoreRefusedError, DEFAULT_ADMIN_ID } from './restore';
import { readSchedule, writeSchedule, readKeep, writeKeep, readDrive, writeDrive, type DriveConnection } from './settings';
import { driveAuthUrl, driveRedirectUri, signDriveState, verifyDriveState, driveExchange, ensureDriveFolders } from './drive';
import { createVerifier, challengeOf } from '../mail/oauth';
import { TokenSource } from '../mail/providers/tokenSource';
import { googleRefresh } from '../mail/providers/google';
import type { BackupSource, BackupTarget } from './types';
import { isSnapshotId } from './types';

export interface BackupRouteDeps {
  db: Database.Database; dataDir: string; backupRoot: string; backupRootIsDefault: boolean;
  appVersion: string; env: NodeJS.ProcessEnv; publicUrl: string | null; jwtSecret: string;
  mailCrypto: MailCrypto;
  authenticateToken: express.RequestHandler; requireAdmin: express.RequestHandler;
  verifyToken: (token: string) => any;
  broadcastChange: (e: EntityChangedEvent) => void;
  closeDb: () => void; exit: (code: number) => void;
  fetch?: typeof fetch;
  driveStore?: (conn: DriveConnection) => BackupTarget & BackupSource;
}

export interface BackupRoutesHandle {
  startRun: (t: Target, trigger: 'manual' | 'schedule') => Promise<string>;
  runAndWait: (t: Target, trigger: 'manual' | 'schedule') => Promise<SnapshotResult>;
  setScheduler: (s: { nextRunAt(t: Target): number | null }) => void;
}

const TARGETS = ['local', 'drive'] as const;
type Target = typeof TARGETS[number];
/** A run in flight, as GET /api/backup/progress reports it. */
export interface LiveBackupProgress extends BackupProgress { target: Target; trigger: 'manual' | 'schedule' }
const isTarget = (v: unknown): v is Target => typeof v === 'string' && (TARGETS as readonly string[]).includes(v);

export function registerBackupRoutes(app: express.Express, deps: BackupRouteDeps): BackupRoutesHandle {
  const { db, authenticateToken, requireAdmin } = deps;
  const local = new LocalStore(deps.backupRoot);
  const targetFor = (t: Target): (BackupTarget & BackupSource) | null => {
    if (t === 'local') return local;
    const conn = readDrive(db, deps.mailCrypto);
    if (!conn || !deps.driveStore) return null;
    return deps.driveStore(conn);
  };
  let scheduler: { nextRunAt(t: Target): number | null } | null = null;

  // A run lives only as long as the process that started it. A row still
  // marked running now was cut off by a restart or crash — left alone it
  // would read as in progress for ever and refuse every later run of that
  // target.
  db.prepare(`UPDATE backup_runs SET status = 'error', finishedAt = ?, error = ? WHERE status = 'running'`)
    .run(Date.now(), 'Interrupted: the server stopped before this backup finished');

  // Latest progress of each run in flight. Memory is enough: it is only
  // meaningful while the run is, and the run cannot outlive the process.
  const live = new Map<Target, LiveBackupProgress>();

  // Shared by startRun (fire-and-forget) and runAndWait (scheduler): resolve
  // the target, guard against a concurrent run, and take the snapshot.
  const runNow = (t: Target, trigger: 'manual' | 'schedule'): Promise<SnapshotResult> => {
    const target = targetFor(t);
    if (!target) throw new Error(t === 'drive' ? 'Google Drive is not connected' : 'no target');
    if (isRunActive(db, t)) throw new BackupRunningError();
    const keep = readKeep(db)[t];
    let runId: string | null = null;
    return takeSnapshot(db, deps.dataDir, target, {
      trigger, keep, appVersion: deps.appVersion, env: deps.env,
      onProgress: p => { runId = p.runId; live.set(t, { ...p, target: t, trigger }); },
    }).finally(() => {
      // Only this run's own entry: one that lost the claim to a run already
      // going never reported, and must not wipe that run's progress.
      if (runId && live.get(t)?.runId === runId) live.delete(t);
    });
  };

  // Run in the background; the response is the run id, progress arrives via
  // the backupRun change-feed event and GET /runs.
  const startRun = (t: Target, trigger: 'manual' | 'schedule'): Promise<string> => {
    const p = runNow(t, trigger);
    p.then(r => deps.broadcastChange({ type: 'backupRun', id: r.runId, action: 'updated' } as EntityChangedEvent))
     .catch(() => deps.broadcastChange({ type: 'backupRun', id: t, action: 'updated' } as EntityChangedEvent));
    // The run id is minted inside takeSnapshot; read it back from the newest running row.
    return new Promise((resolve) => setImmediate(() => {
      const row = db.prepare(`SELECT id FROM backup_runs WHERE target = ? ORDER BY startedAt DESC LIMIT 1`).get(t) as { id: string } | undefined;
      resolve(row?.id ?? '');
    }));
  };

  // Used by the scheduler: awaits completion (a scheduled run must finish
  // local before deciding whether to proceed to Drive).
  const runAndWait = async (t: Target, trigger: 'manual' | 'schedule'): Promise<SnapshotResult> => {
    const r = await runNow(t, trigger);
    deps.broadcastChange({ type: 'backupRun', id: r.runId, action: 'updated' } as EntityChangedEvent);
    return r;
  };

  const setScheduler = (s: { nextRunAt(): number | null }): void => { scheduler = s; };

  // Routes the browser navigates to itself — the snapshot download and the
  // Drive OAuth start — cannot carry an Authorization header, so they accept
  // the token as a query param (same trick as the mail attachment routes).
  // Declared here because the admin download route below is the first user.
  const authOrQueryToken: express.RequestHandler = (req, res, next) => {
    const t = typeof req.query.token === 'string' ? req.query.token : null;
    if (t) { const u = deps.verifyToken(t); if (!u) return res.status(401).json({ error: 'Invalid token' }); (req as any).user = u; return next(); }
    return authenticateToken(req, res, next);
  };

  app.get('/api/backup/status', authenticateToken, requireAdmin, async (_req, res) => {
    const lastRun = (t: Target) => db.prepare(`SELECT * FROM backup_runs WHERE target = ? AND status != 'running' ORDER BY startedAt DESC LIMIT 1`).get(t) ?? null;
    const running = db.prepare(`SELECT * FROM backup_runs WHERE status = 'running' ORDER BY startedAt DESC LIMIT 1`).get() ?? null;
    const snaps = await local.listSnapshots();
    const objects = await local.listObjects();
    const drive = readDrive(db, deps.mailCrypto);
    res.json({
      root: deps.backupRoot, rootIsDefault: deps.backupRootIsDefault,
      lastRun: { local: lastRun('local'), drive: lastRun('drive') }, running,
      totals: { snapshots: snaps.length, objects: objects.size, bytes: snaps[0]?.counts.bytes ?? 0 },
      nextRunAt: { local: scheduler?.nextRunAt('local') ?? null, drive: scheduler?.nextRunAt('drive') ?? null },
      schedule: readSchedule(db), keep: readKeep(db),
      progress: [...live.values()],
      // What the setup guide shows. The redirect URIs come from the same
      // function the OAuth flow uses, so what an admin pastes into Google is
      // byte-identical to what the server will send.
      setup: {
        publicUrl: deps.publicUrl,
        googleClientId: !!deps.env.GOOGLE_OAUTH_CLIENT_ID, googleClientSecret: !!deps.env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirectUris: deps.publicUrl ? { backup: driveRedirectUri(deps.publicUrl, 'admin'), restore: driveRedirectUri(deps.publicUrl, 'setup') } : null,
      },
      // `configurable` gates the Connect link, which 503s without a public URL
      // to send Google back to — so both halves have to be present.
      drive: drive ? { connected: true, email: drive.email, needsReconnect: !!drive.needsReconnect } : { connected: false, configurable: !!deps.env.GOOGLE_OAUTH_CLIENT_ID && !!deps.publicUrl },
    });
  });

  app.post('/api/backup/run', authenticateToken, requireAdmin, async (req, res) => {
    const t = req.body?.target;
    if (!isTarget(t)) return res.status(400).json({ error: 'target must be local or drive' });
    try { res.status(202).json({ runId: await startRun(t, 'manual') }); }
    catch (e) {
      if (e instanceof BackupRunningError) return res.status(409).json({ error: e.message, code: 'backup_running' });
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Polled by the Backup tab about once a second while a run is going, so it
  // reads memory only — no disk, no Drive.
  app.get('/api/backup/progress', authenticateToken, requireAdmin, (_req, res) => {
    res.json([...live.values()]);
  });

  app.get('/api/backup/runs', authenticateToken, requireAdmin, (_req, res) => {
    res.json(listRuns(db).map(r => ({ ...r, warnings: JSON.parse(r.warningsJson || '[]') })));
  });

  app.get('/api/backup/snapshots', authenticateToken, requireAdmin, async (req, res) => {
    const t = req.query.target;
    if (!isTarget(t)) return res.status(400).json({ error: 'target must be local or drive' });
    const target = targetFor(t);
    if (!target) return res.json([]);
    try { res.json(await target.listSnapshots()); }
    catch (e) { console.error('[backup] list snapshots failed', e); res.status(502).json({ error: (e as Error).message }); }
  });

  // The snapshot list carries only a count of warnings; the messages live in
  // that snapshot's manifest and are read when someone asks. A warning names a
  // file by id, so each is matched to the file's name and project while that
  // file still exists — an id alone tells an admin nothing.
  app.get('/api/backup/snapshots/:id/warnings', authenticateToken, requireAdmin, async (req, res) => {
    const t = req.query.target;
    if (!isTarget(t)) return res.status(400).json({ error: 'target must be local or drive' });
    if (!isSnapshotId(req.params.id)) return res.status(400).json({ error: 'bad snapshot id' });
    const target = targetFor(t);
    if (!target) return res.status(400).json({ error: 'Google Drive is not connected' });
    let warnings: string[];
    try { warnings = (await target.readManifest(req.params.id)).warnings ?? []; }
    catch (e) { console.error('[backup] read snapshot warnings failed', e); return res.status(502).json({ error: 'Could not read that snapshot' }); }
    const lookup = db.prepare(`SELECT f.name AS fileName, p.name AS projectName FROM files f LEFT JOIN projects p ON p.id = f.projectId WHERE f.id = ?`);
    res.json(warnings.map(message => {
      const fileId = /^file (\S+) skipped: /.exec(message)?.[1] ?? null;
      const row = fileId ? lookup.get(fileId) as { fileName: string | null; projectName: string | null } | undefined : undefined;
      return { message, fileId, fileName: row?.fileName ?? null, projectName: row?.projectName ?? null };
    }));
  });

  app.get('/api/backup/snapshots/:id/download', authOrQueryToken, requireAdmin, async (req, res) => {
    if (!isSnapshotId(req.params.id)) return res.status(400).json({ error: 'bad snapshot id' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="frugalomnibuild-backup-${req.params.id}.zip"`);
    try { await streamSnapshotZip(local, req.params.id, res); }
    catch (e) { console.error('[backup] download failed', e); if (!res.headersSent) res.status(404).json({ error: 'Snapshot not found' }); else res.destroy(); }
  });

  app.put('/api/backup/settings', authenticateToken, requireAdmin, (req, res) => {
    if (req.body?.schedule) writeSchedule(db, req.body.schedule);
    if (req.body?.keep) writeKeep(db, req.body.keep);
    res.json({ schedule: readSchedule(db), keep: readKeep(db) });
  });

  // ── Fresh-install restore (spec §Setup mode and restore) ─────────────────
  app.get('/api/setup/state', (_req, res) => res.json({ fresh: isFreshInstall(db) }));

  // Fresh + signed in as the bootstrap admin: the only identity a fresh
  // install can have, and it stops a LAN stranger restoring over an empty box.
  const setupOnly: express.RequestHandler[] = [authenticateToken, (req, res, next) => {
    if ((req as any).user?.id !== DEFAULT_ADMIN_ID) return res.status(403).json({ error: 'Only the initial admin account can restore' });
    if (!isFreshInstall(db)) return res.status(409).json({ error: 'This server already has data — restore is only offered on a fresh install', code: 'not_fresh' });
    next();
  }];

  const uploadsDir = path.join(os.tmpdir(), 'ft-restore-uploads');
  const uploadStore = (uploadId: string): LocalStore => {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new RestoreRefusedError('bad upload id');
    return new LocalStore(path.join(uploadsDir, uploadId));
  };
  // Setup-mode Drive grant lives here in memory only; the setup OAuth
  // callback below fills it and nothing outside this closure reads it.
  const setupDrive: { conn: DriveConnection | null } = { conn: null };

  app.get('/api/setup/restore/sources', ...setupOnly, async (_req, res) => {
    res.json({
      root: deps.backupRoot, local: await local.listSnapshots(),
      drive: { configurable: !!deps.env.GOOGLE_OAUTH_CLIENT_ID && !!deps.publicUrl, connected: !!setupDrive.conn, email: setupDrive.conn?.email ?? null },
    });
  });

  // Raw body streamed to disk (server.ts skips the JSON parser for this path).
  app.post('/api/setup/restore/upload', ...setupOnly, async (req, res) => {
    const uploadId = uuidv4();
    const dir = path.join(uploadsDir, uploadId); fs.mkdirSync(dir, { recursive: true });
    const zipPath = path.join(dir, 'upload.zip');
    try {
      await pipeline(req, fs.createWriteStream(zipPath));
      const { snapshotId } = await unpackSnapshotZip(zipPath, dir);
      fs.unlinkSync(zipPath);
      const summary = (await uploadStore(uploadId).listSnapshots())[0];
      res.json({ uploadId, snapshotId, summary });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      res.status(400).json({ error: `That file is not a snapshot zip: ${(e as Error).message}` });
    }
  });

  // One restore at a time. A real one copies every file and the whole
  // database back — minutes, not seconds — and they all stage onto the same
  // paths, so a second request (an impatient second click, a reload) would
  // race the first rather than queue behind it. Held for the life of the
  // process on success, because success ends in exit(0) and a restart.
  let restoreInFlight = false;

  app.post('/api/setup/restore', ...setupOnly, async (req, res) => {
    const { source, snapshotId, uploadId } = req.body ?? {};
    if (!isSnapshotId(String(snapshotId))) return res.status(400).json({ error: 'bad snapshot id' });
    if (source !== 'local' && source !== 'upload' && source !== 'drive') return res.status(400).json({ error: 'source must be local, upload or drive' });
    if (source === 'drive' && (!setupDrive.conn || !deps.driveStore)) return res.status(400).json({ error: 'Google Drive is not connected' });
    if (restoreInFlight) return res.status(409).json({ error: 'A restore is already running', code: 'restore_running' });
    restoreInFlight = true;
    try {
      const src: BackupSource = source === 'local' ? local
        : source === 'upload' ? uploadStore(String(uploadId))
        : deps.driveStore!(setupDrive.conn!);
      const r = await restoreSnapshot(src, snapshotId, { dataDir: deps.dataDir, closeDb: deps.closeDb, exit: deps.exit });
      res.json({ restarting: true, files: r.files, bytes: r.bytes });
      // After the response is flushed: swap the db and exit for the restart.
      res.on('finish', () => setImmediate(() => { try { r.finish(); } catch (e) { console.error('[backup] restore finish failed', e); } }));
    } catch (e) {
      // Nothing was changed, so a corrected retry must be allowed.
      restoreInFlight = false;
      if (e instanceof RestoreRefusedError) return res.status(400).json({ error: e.message });
      console.error('[backup] restore failed', e);
      res.status(500).json({ error: 'Restore failed — the server was left as it was. See the server log.' });
    }
  });

  // ── Google Drive connect (admin) and setup-mode connect ─────────────────
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const startDrive = (mode: 'admin' | 'setup'): express.RequestHandler => (_req, res) => {
    if (!deps.publicUrl) return res.status(503).json({ error: 'APP_PUBLIC_URL is not set — see Settings → Mail → Server setup guide' });
    const verifier = createVerifier();
    try {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.redirect(driveAuthUrl(deps.env, deps.publicUrl, mode, signDriveState(deps.jwtSecret, { mode, verifier }), challengeOf(verifier)));
    } catch (e: any) { res.status(503).json({ error: e?.message || 'Google Drive is not configured' }); }
  };
  const callbackDrive = (mode: 'admin' | 'setup'): express.RequestHandler => async (req, res) => {
    const back = (params: string) => res.redirect(mode === 'admin' ? `/settings?tab=backup&${params}` : `/restore?${params}`);
    const failed = (m: string) => back(`error=${encodeURIComponent(m.slice(0, 300))}`);
    if (!deps.publicUrl) return failed('APP_PUBLIC_URL is not set on this server');
    if (req.query.error) return failed('Google did not complete the sign-in — please try again');
    const code = typeof req.query.code === 'string' ? req.query.code : ''; const raw = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !raw) return failed('That sign-in did not come back with everything we need — please try again');
    let st: { mode: 'admin' | 'setup'; verifier: string };
    try { st = verifyDriveState(deps.jwtSecret, raw); } catch { return failed('That sign-in link expired or was not issued by this app'); }
    if (st.mode !== mode) return failed('That sign-in was started from a different screen');
    if (mode === 'setup' && !isFreshInstall(db)) return failed('This server already has data');
    try {
      const { refreshToken, email } = await driveExchange(deps.env, deps.publicUrl, mode, code, st.verifier, fetchFn);
      const tokens = new TokenSource({ refreshToken, refresh: t => googleRefresh(deps.env, t, fetchFn) });
      const folders = await ensureDriveFolders(() => tokens.get(), fetchFn);
      const conn: DriveConnection = { refreshToken, email, ...folders };
      if (mode === 'admin') writeDrive(db, deps.mailCrypto, conn); else setupDrive.conn = conn;
      back('drive=connected');
    } catch (e) { console.error('[backup] drive connect failed', e); failed((e as Error).message); }
  };
  app.get('/api/backup/drive/start', authOrQueryToken, requireAdmin, startDrive('admin'));
  app.get('/api/backup/drive/callback', callbackDrive('admin'));
  app.delete('/api/backup/drive', authenticateToken, requireAdmin, (_req, res) => { writeDrive(db, deps.mailCrypto, null); res.json({ ok: true }); });
  app.get('/api/setup/restore/drive/start', authOrQueryToken, ...setupOnly.slice(1), startDrive('setup'));
  app.get('/api/setup/restore/drive/callback', callbackDrive('setup'));
  app.get('/api/setup/restore/drive/snapshots', ...setupOnly, async (_req, res) => {
    if (!setupDrive.conn || !deps.driveStore) return res.status(400).json({ error: 'Google Drive is not connected' });
    try { res.json(await deps.driveStore(setupDrive.conn).listSnapshots()); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });

  return { startRun, runAndWait, setScheduler };
}
