import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import { createServer } from "http";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dotenv from "dotenv";
import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import { openDb } from './server/db';
import { runMigrations } from './server/migrations';
import { migrations } from './server/migrationList';
import { registerDataRoutes, registerEmailRoutes } from './server/routes';
import { registerAiRoutes } from './server/aiRoutes';
import { getAiRunner } from './server/ai';
import { NOTIFICATION_EVENT, registerRealtime, userRoom } from './server/realtime/registerRealtime';
import { Notifier } from './server/notifications';
import { registerNotificationRoutes } from './server/notificationRoutes';
import { PushService } from './server/push';
import { createAttachmentViewer } from './server/onlyoffice/viewers';
import { registerPushRoutes } from './server/pushRoutes';
import { registerShareRoutes } from './server/shareRoutes';
import { registerAuthRoutes, tokenAuth } from './server/auth';
import { createChangeFeed, requestMeta } from './server/realtime/changeFeed';
import { loadMailCrypto } from './server/mail/crypto';
import type { MailContext } from './server/mail/context';
import type { MailCrypto } from './server/mail/crypto';
import { createMailProvider, defaultProviderDeps } from './server/mail/providers';
import { registerMailRoutes } from './server/mail/routes';
import { MailScheduler } from './server/mail/sync/scheduler';
import { WEBHOOK_PATH, GOOGLE_WEBHOOK_PATH } from './server/mail/push';
import { BodyCache } from './server/mail/sync/bodyCache';
import { sweepUploads } from './server/mail/uploads';
import { installInboundHooks } from './server/mail/inboundHooks';
import { registerBackupRoutes } from './server/backup/routes';
import { createDriveStore } from './server/backup/drive';
import { readDrive } from './server/backup/settings';
import { BackupScheduler } from './server/backup/scheduler';
import { registerOnlyofficeRoutes } from './server/onlyoffice/routes';
import { removeUserSignatures } from './server/documentLibrary';
import { createOnlyofficeServices } from './server/onlyoffice/services';
import { CALLBACK_PATH_PREFIX as ONLYOFFICE_CALLBACK_PATH_PREFIX } from './server/onlyoffice/editorRoutes';

dotenv.config();

const DATA_DIR = process.env.STORAGE_PATH || path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const APP_VERSION = JSON.parse(fsSync.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version as string;

let db: Database.Database;
// Loaded (or generated) once in initDb, then shared by migration 31 and the
// mail subsystem — two MailCrypto instances over one key file would be pure
// duplication.
let mailCrypto: MailCrypto;

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function initDb() {
  try {
    // Check if the path is a directory (common Docker volume mount mistake)
    if (fsSync.existsSync(DB_FILE) && fsSync.statSync(DB_FILE).isDirectory()) {
      console.error(`\n================================================================`);
      console.error(`❌ FATAL ERROR: Database path ${DB_FILE} is a directory!`);
      console.error(`This usually happens if you mapped a Docker volume directly to the database file`);
      console.error(`instead of the directory. Please check your Unraid/Docker volume settings.`);
      console.error(`Make sure you map to '/app/data' and NOT '/app/data/app.db'.`);
      console.error(`================================================================\n`);
      process.exit(1);
    }

    // Ensure the directory exists and is writable
    if (!fsSync.existsSync(DATA_DIR)) {
      fsSync.mkdirSync(DATA_DIR, { recursive: true });
    }
    
    // Test write permissions to the directory
    try {
      const testFile = path.join(DATA_DIR, '.write-test');
      fsSync.writeFileSync(testFile, 'test');
      fsSync.unlinkSync(testFile);
    } catch (err) {
      console.error(`\n================================================================`);
      console.error(`❌ FATAL ERROR: No write permission to ${DATA_DIR}!`);
      console.error(`Please check the permissions of your Unraid appdata folder.`);
      console.error(`Error details: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`================================================================\n`);
      process.exit(1);
    }

    db = openDb(DB_FILE);
    // mailCrypto is what lets migration 31 re-seal each user's smtp.* config as
    // a mail account; without it that transform skips with a warning.
    mailCrypto = loadMailCrypto(DATA_DIR);
    runMigrations(db, DATA_DIR, migrations, { dbFile: DB_FILE, vacuum: true, mailCrypto });

    // Initialize default settings
    const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get() as { count: number };
    if (settingsCount.count === 0) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('appName', 'FrugalOmnibuild');
    }

    // Create default admin user if no users exist
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (userCount.count === 0) {
      const hash = bcrypt.hashSync('admin', 10);
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
        'admin-id-123', 'admin', hash, 'admin'
      );
    }
  } catch (error) {
    console.error(`\n================================================================`);
    console.error(`❌ FATAL ERROR: Failed to initialize SQLite database at ${DB_FILE}`);
    console.error(`Error details:`, error);
    console.error(`================================================================\n`);
    process.exit(1);
  }
}

async function startServer() {
  await ensureDirs();
  initDb();

  const app = express();
  // Trust the first reverse proxy hop (e.g. Cloudflare) so req.ip reflects the
  // real client IP from X-Forwarded-For. Without this, rate limiting buckets
  // all traffic under the proxy's IP and becomes effectively shared across users.
  app.set('trust proxy', 1);
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  // Two mail paths bring their own body parser, and this one runs first, so it
  // steps aside for exactly those:
  //   * POST /api/mail/uploads streams a raw attachment body (its own
  //     express.raw parser lives in registerMailRoutes);
  //   * the Graph and Pub/Sub webhooks are unauthenticated and open to the
  //     internet, so each takes a 256 KB express.json() of its own instead of
  //     this 50 MB one;
  //   * the ONLYOFFICE save callback needs no login either (the Document
  //     Server signs it), so it has its own smaller parser too.
  const jsonParser = express.json({ limit: "50mb" });
  const ownParser = (p: string) => p.startsWith('/api/mail/uploads') || p === '/api/setup/restore/upload' || p === WEBHOOK_PATH || p === GOOGLE_WEBHOOK_PATH
    || p.startsWith(ONLYOFFICE_CALLBACK_PATH_PREFIX);
  app.use((req, res, next) => (ownParser(req.path) ? next() : jsonParser(req, res, next)));

  // JWT secret resolution order:
  //   1. JWT_SECRET environment variable (admin override)
  //   2. Persisted secret in the settings table
  //   3. Generate a fresh 64-byte random secret and persist it
  // This means fresh installs work out of the box — no manual setup required.
  let JWT_SECRET = process.env.JWT_SECRET || '';
  if (!JWT_SECRET) {
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'jwt.secret'").get() as { value: string } | undefined;
    if (existing?.value) {
      JWT_SECRET = existing.value;
    } else {
      JWT_SECRET = crypto.randomBytes(64).toString('hex');
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jwt.secret', JWT_SECRET);
      console.log('Generated a new JWT signing secret and saved it to the database.');
    }
  }

  const broadcastChange = createChangeFeed(io);

  // verifyToken: one token verifier, shared by realtime, the data, mail and
  // media routes. authenticateToken: every other signed-in route (the
  // Authorization header only). Both in server/auth.ts.
  const { verifyToken, authenticateToken } = tokenAuth(JWT_SECRET);

  const realtime = registerRealtime(io, {
    verifyToken,
    db,
    broadcastChange,
  });

  // The notification bell (ONLYOFFICE Phase 5): stored per user, pushed live to
  // every tab they have open. Old ones are pruned after start and daily.
  const notifier = new Notifier(db, (userId, ev) => { io.to(userRoom(userId)).emit(NOTIFICATION_EVENT, ev); });
  setTimeout(() => notifier.prune(), 5 * 60_000).unref();
  setInterval(() => notifier.prune(), 24 * 3600_000).unref();
  // …and to the phones (and computers) they turned push notifications on for.
  const push = new PushService({ db, contact: process.env.PUSH_CONTACT || process.env.APP_PUBLIC_URL || null });
  notifier.onNew(n => {
    void push.send(n.userId, { id: n.id, title: n.title, body: n.body, link: n.link, unread: notifier.unreadCount(n.userId) });
  });

  // Clean shutdown: a container stop (SIGTERM) or Ctrl-C (SIGINT) stops the
  // mail sync workers before exiting. Guarded against double-registration
  // (each signal only ever fires this handler once per process) and skipped
  // entirely in tests, which construct their own harness instead of calling
  // startServer(). Document edits need nothing here: ONLYOFFICE holds them
  // and retries its save callback.
  let shuttingDown = false;
  // Assigned further down (the mail subsystem needs routes/auth in place first);
  // hoisted so the shutdown handler can stop its sync workers.
  let mailScheduler: MailScheduler | undefined;
  const flushAndExit = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, stopping mail sync before exit...`);
    Promise.allSettled([mailScheduler?.stop()]).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => flushAndExit('SIGTERM'));
  process.once('SIGINT', () => flushAndExit('SIGINT'));

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const requireAdmin = (req: any, res: any, next: any) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  // ONLYOFFICE conversions and thumbnails, shared by the upload route and the
  // editor routes (docs/onlyoffice-setup.md). Idle until ONLYOFFICE is set up.
  const onlyofficeServices = createOnlyofficeServices({ env: process.env, appJwtSecret: JWT_SECRET, db, dataDir: DATA_DIR });
  // Thumbnails of files that are gone or replaced: tidy once after start, then daily.
  setTimeout(() => onlyofficeServices.thumbnails.sweep(), 5 * 60_000).unref();
  setInterval(() => onlyofficeServices.thumbnails.sweep(), 24 * 3600_000).unref();

  registerDataRoutes(app, {
    db,
    dataDir: DATA_DIR,
    dbFile: DB_FILE,
    authenticateToken,
    requireAdmin,
    verifyToken,
    broadcastChange,
    onlyoffice: onlyofficeServices,
    notifier,
  });
  registerNotificationRoutes(app, { authenticateToken, notifier });
  registerPushRoutes(app, { db, authenticateToken, push });
  registerShareRoutes(app, { db, dataDir: DATA_DIR, env: process.env, authenticateToken });

  // The Playwright e2e harness logs in many times per run (per-worker session +
  // a few explicit logins per spec), which would trip a 10/min cap. Detect the
  // e2e store (set via STORAGE_PATH=.e2e-data in playwright.config.ts) and lift
  // the cap there. Production behavior is unchanged.
  const isE2E = (process.env.STORAGE_PATH ?? '').includes('.e2e-data');
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: isE2E ? 100000 : 10,
    message: { error: 'Too many login attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Auth Routes: sign-in, sign-out and the media cookie (server/auth.ts).
  registerAuthRoutes(app, { db, jwtSecret: JWT_SECRET, verifyToken, loginLimiter });

  app.get('/api/auth/me', authenticateToken, (req: any, res: any) => {
    res.json({ user: req.user });
  });

  app.post('/api/auth/change-password', authenticateToken, (req: any, res: any) => {
    const { currentPassword, newPassword } = req.body;
    try {
      const user = db.prepare('SELECT id, password FROM users WHERE id = ?').get(req.user.id) as any;
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const validPassword = bcrypt.compareSync(currentPassword || '', user.password);
      if (!validPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
      }
      const hash = bcrypt.hashSync(newPassword, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  // User Management Routes
  app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
    try {
      const users = db.prepare('SELECT id, username, role FROM users').all();
      res.json(users);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  app.post('/api/users', authenticateToken, requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const assignedRole = role || 'user';
    if (!['admin', 'user'].includes(assignedRole)) {
      return res.status(400).json({ error: 'Role must be admin or user' });
    }
    try {
      const hash = bcrypt.hashSync(password, 10);
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
        id, username.trim(), hash, assignedRole
      );
      broadcastChange({ type: 'user', id, action: 'created', ...requestMeta(req as any) });
      res.json({ success: true, user: { id, username: username.trim(), role: assignedRole } });
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(400).json({ error: 'Username already exists' });
      } else {
        res.status(500).json({ error: 'Failed to create user' });
      }
    }
  });

  app.patch('/api/users/:id/role', authenticateToken, requireAdmin, (req: any, res: any) => {
    const { role } = req.body;
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    try {
      const targetUser = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id) as any;
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      // Prevent changing your own role (avoids self-lockout / stale-token confusion)
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }
      // Prevent demoting the last admin
      if (targetUser.role === 'admin' && role === 'user') {
        const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as any;
        if (adminCount.count <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last admin' });
        }
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
      broadcastChange({ type: 'user', id: req.params.id, action: 'updated', ...requestMeta(req) });
      res.json({ id: targetUser.id, username: targetUser.username, role });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update user role' });
    }
  });

  app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      // Prevent deleting the last admin
      const userToDelete = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id) as any;
      if (userToDelete?.role === 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as any;
        if (adminCount.count <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last admin user' });
        }
      }
      
      db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
      db.prepare('DELETE FROM user_preferences WHERE userId = ?').run(req.params.id);
      removeUserSignatures(db, DATA_DIR, req.params.id);
      notifier.removeUser(req.params.id);
      push.removeUser(req.params.id);
      db.prepare('UPDATE rfis SET assigneeUserId = NULL WHERE assigneeUserId = ?').run(req.params.id);
      broadcastChange({ type: 'user', id: req.params.id, action: 'deleted', ...requestMeta(req as any) });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  app.get("/api/templates", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM templates');
      const rows = stmt.all() as { data: string }[];
      const templates = rows.map(row => JSON.parse(row.data));
      res.json(templates);
    } catch (error) {
      res.json([]);
    }
  });

  app.post("/api/templates", authenticateToken, (req, res) => {
    try {
      const t = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO templates (id, data) VALUES (?, ?)');
      stmt.run(t.id, JSON.stringify(t));
      broadcastChange({ type: 'template', id: t.id, action: 'updated', ...requestMeta(req as any) });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving template:", error);
      res.status(500).json({ error: "Failed to save template" });
    }
  });

  app.delete("/api/templates/:id", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('DELETE FROM templates WHERE id = ?');
      stmt.run(req.params.id);
      broadcastChange({ type: 'template', id: req.params.id, action: 'deleted', ...requestMeta(req as any) });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting template:", error);
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  // Notes API
  app.get("/api/projects/:projectId/notes", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM notes WHERE projectId = ? ORDER BY updatedAt DESC');
      const row = stmt.get(req.params.projectId) as { data: string } | undefined;
      if (!row) {
        return res.json(null);
      }
      res.json(JSON.parse(row.data));
    } catch (error) {
      console.error("Error fetching notes:", error);
      res.status(500).json({ error: "Failed to fetch notes" });
    }
  });

  app.post("/api/projects/:projectId/notes", authenticateToken, (req, res) => {
    try {
      const note = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO notes (id, projectId, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)');
      stmt.run(note.id, req.params.projectId, JSON.stringify(note), note.createdAt || Date.now(), Date.now());
      broadcastChange({ type: 'note', id: note.id, projectId: req.params.projectId, action: 'updated', ...requestMeta(req as any) });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving notes:", error);
      res.status(500).json({ error: "Failed to save notes" });
    }
  });

  // Settings API — public endpoint, excludes any key that could contain secrets
  // (jwt.secret, retired smtp.* rows, mail.webhookSecret). Those are fetched via their own
  // authenticated endpoints.
  // 'invoiceNumber' is the universal invoice-number counter (billingStore's
  // nextInvoiceNumber) — internal bookkeeping, not a user setting. Withholding
  // it from GET keeps it out of the client's settings object, so the Settings
  // page can never round-trip a stale copy back and roll the counter backwards.
  // push.: the VAPID key pair phone notifications are signed with (server/push.ts).
  const SETTINGS_PRIVATE_PREFIXES = ['jwt.', 'smtp.', 'mail.', 'invoiceNumber', 'backup.', 'push.'];
  const isPrivateSettingKey = (key: string) => SETTINGS_PRIVATE_PREFIXES.some(p => key.startsWith(p));
  app.get("/api/settings", (req, res) => {
    try {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string, value: string }[];
      const settings: Record<string, string> = {};
      rows.forEach(row => { if (!isPrivateSettingKey(row.key)) settings[row.key] = row.value; });
      res.json(settings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.post("/api/settings", authenticateToken, requireAdmin, (req, res) => {
    try {
      const settings = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      Object.entries(settings).forEach(([key, value]) => {
        // Private keys never appear in GET, so nothing legitimate posts them
        // back; dropping them here protects internal bookkeeping (the invoice
        // counter, jwt secret) from a crafted or stale client payload.
        if (isPrivateSettingKey(key)) return;
        stmt.run(key, value as string);
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving settings:", error);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // Share links (info, create, list, expiry, stop): server/shareRoutes.ts.

  // Checklists API removed — feature moved to /api/tasks (collaborative Tasks page).
  // The `checklists` table is retained as a data backup (see migration 11); do not drop it.

  // User Preferences API (per-user, cross-browser)
  app.get("/api/user-preferences", authenticateToken, (req, res) => {
    try {
      const rows = db.prepare('SELECT key, value FROM user_preferences WHERE userId = ?').all((req as any).user.id) as { key: string; value: string }[];
      const prefs: Record<string, string> = {};
      // Exclude smtp.* keys. Migration 31 deletes them for every user it could
      // convert into a mail account, but a half-filled block (blank smtp.host,
      // or neither fromAddress nor username) is left behind untouched — and it
      // can still hold a password, so it must never leak out here.
      rows.forEach(row => { if (!row.key.startsWith('smtp.')) prefs[row.key] = row.value; });
      res.json(prefs);
    } catch (error) {
      console.error("Error fetching user preferences:", error);
      res.status(500).json({ error: "Failed to fetch preferences" });
    }
  });

  app.put("/api/user-preferences", authenticateToken, (req, res) => {
    try {
      const prefs = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO user_preferences (userId, key, value) VALUES (?, ?, ?)');
      const userId = (req as any).user.id;
      Object.entries(prefs).forEach(([key, value]) => {
        // The smtp.* namespace is retired (migration 31 converted it to mail
        // accounts and deleted the rows it converted). Refuse writes so nothing
        // can resurrect a credential there.
        if (key.startsWith('smtp.')) return;
        stmt.run(userId, key, value as string);
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving user preferences:", error);
      res.status(500).json({ error: "Failed to save preferences" });
    }
  });

  // ── Mail subsystem (spec 2026-08-29) ───────────────────────────────────────
  // One outbound path for the whole app: the /api/mail client routes and the
  // per-item send routes both go through sendService against the sending user's
  // connected mail account. The old per-user SMTP config is gone — migration 31
  // converted each saved smtp.* block into an account in 'needs_review'.
  const mailCtx: MailContext = {
    db,
    dataDir: DATA_DIR,
    crypto: mailCrypto,
    providerFactory: (a, auth) => createMailProvider(a, auth, defaultProviderDeps(db, mailCrypto)),
    broadcastChange,
    notifier,
  };
  // publicUrl is what lets Graph accounts use change notifications instead of
  // polling alone: the scheduler both points Microsoft at our webhook and keeps
  // the subscription renewed. Unset → poll only (spec §4.2).
  // GOOGLE_PUBSUB_TOPIC does the same for Gmail: with a topic configured the
  // scheduler keeps each Gmail watch renewed and Pub/Sub posts to
  // /api/mail/google/webhook. Both are optional — polling never stops either way.
  mailScheduler = new MailScheduler(mailCtx, {
    publicUrl: process.env.APP_PUBLIC_URL || null,
    googlePubsubTopic: process.env.GOOGLE_PUBSUB_TOPIC || null,
  });
  mailCtx.scheduler = mailScheduler;

  registerMailRoutes(app, {
    ctx: mailCtx,
    authenticateToken,
    requireAdmin,
    verifyToken,
    bodyCache: new BodyCache({ maxBytes: 50 * 1024 * 1024, ttlMs: 10 * 60_000 }),
    publicUrl: process.env.APP_PUBLIC_URL || null,
    env: process.env,
    jwtSecret: JWT_SECRET,
    // Word/Excel/PowerPoint attachments open in the ONLYOFFICE viewer (Phase 6).
    attachmentViewer: createAttachmentViewer(process.env, onlyofficeServices.tokens),
  });

  registerEmailRoutes(app, {
    db,
    authenticateToken,
    requireAdmin,
    broadcastChange,
    mailCtx,
  });

  const BACKUP_PATH = process.env.BACKUP_PATH || path.join(DATA_DIR, 'backup-store');
  const backupRoutes = registerBackupRoutes(app, {
    db, dataDir: DATA_DIR, backupRoot: BACKUP_PATH, backupRootIsDefault: !process.env.BACKUP_PATH,
    appVersion: APP_VERSION, env: process.env, publicUrl: process.env.APP_PUBLIC_URL || null, jwtSecret: JWT_SECRET,
    mailCrypto, authenticateToken, requireAdmin, verifyToken, broadcastChange,
    closeDb: () => db.close(), exit: code => process.exit(code),
    driveStore: conn => createDriveStore(conn, { db, env: process.env, mailCrypto, fetch: globalThis.fetch }),
  });
  const backupScheduler = new BackupScheduler({ db, run: (t, trigger) => backupRoutes.runAndWait(t, trigger), hasDrive: () => !!readDrive(db, mailCrypto) });
  backupRoutes.setScheduler(backupScheduler);
  backupScheduler.start();

  // ONLYOFFICE document editor (docs/onlyoffice-setup.md).
  registerOnlyofficeRoutes(app, {
    env: process.env, appJwtSecret: JWT_SECRET, authenticateToken, requireAdmin,
    db, dataDir: DATA_DIR, broadcastChange, services: onlyofficeServices, notifier,
  });

  // Before the first sync tick: a reply that lands in that tick must still be
  // captured against its RFI.
  installInboundHooks();
  mailScheduler.start();
  // Staged compose attachments are written to disk before the message exists;
  // reap the ones no send ever claimed.
  sweepUploads(DATA_DIR);
  setInterval(() => sweepUploads(DATA_DIR), 15 * 60_000).unref();

  registerAiRoutes(app, {
    dataDir: DATA_DIR,
    authenticateToken,
    runner: getAiRunner(),
  });

  // Time Entry Routes
  app.get("/api/time-entries", authenticateToken, (req: any, res: any) => {
    try {
      const { projectId } = req.query;
      let rows;
      if (projectId) {
        rows = db.prepare('SELECT * FROM time_entries WHERE userId = ? AND projectId = ? ORDER BY clockIn DESC').all(req.user.id, projectId);
      } else {
        rows = db.prepare('SELECT * FROM time_entries WHERE userId = ? ORDER BY clockIn DESC').all(req.user.id);
      }
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch time entries' });
    }
  });

  // Admin-only: every user's entries, joined with username for display.
  app.get("/api/time-entries/all", authenticateToken, requireAdmin, (req: any, res: any) => {
    try {
      const { userId } = req.query;
      const rows = userId
        ? db.prepare(`
            SELECT te.*, u.username
            FROM time_entries te
            JOIN users u ON te.userId = u.id
            WHERE te.userId = ?
            ORDER BY te.clockIn DESC
          `).all(userId)
        : db.prepare(`
            SELECT te.*, u.username
            FROM time_entries te
            JOIN users u ON te.userId = u.id
            ORDER BY te.clockIn DESC
          `).all();
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch all time entries' });
    }
  });

  app.post("/api/time-entries/clock-in", authenticateToken, (req: any, res: any) => {
    try {
      const { projectId } = req.body;
      const existing = db.prepare('SELECT * FROM time_entries WHERE userId = ? AND clockOut IS NULL').get(req.user.id) as any;
      if (existing) {
        return res.status(400).json({ error: 'Already clocked in', entry: existing });
      }
      const entry = {
        id: uuidv4(),
        userId: req.user.id,
        projectId: projectId || null,
        clockIn: Date.now(),
        clockOut: null,
        description: '',
        createdAt: Date.now(),
      };
      db.prepare('INSERT INTO time_entries (id, userId, projectId, clockIn, clockOut, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        entry.id, entry.userId, entry.projectId, entry.clockIn, entry.clockOut, entry.description, entry.createdAt
      );
      broadcastChange({ type: 'timeEntry', id: entry.id, action: 'created', ...requestMeta(req) });
      res.json(entry);
    } catch (error) {
      res.status(500).json({ error: 'Failed to clock in' });
    }
  });

  app.put("/api/time-entries/clock-out", authenticateToken, (req: any, res: any) => {
    try {
      const { description } = req.body;
      const existing = db.prepare('SELECT * FROM time_entries WHERE userId = ? AND clockOut IS NULL').get(req.user.id) as any;
      if (!existing) {
        return res.status(400).json({ error: 'Not clocked in' });
      }
      const clockOut = Date.now();
      db.prepare('UPDATE time_entries SET clockOut = ?, description = ? WHERE id = ?').run(clockOut, description ?? existing.description, existing.id);
      broadcastChange({ type: 'timeEntry', id: existing.id, action: 'updated', ...requestMeta(req) });
      res.json({ ...existing, clockOut, description: description ?? existing.description });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clock out' });
    }
  });

  app.post("/api/time-entries", authenticateToken, (req: any, res: any) => {
    try {
      const { projectId, clockIn, clockOut, description } = req.body;
      if (!clockIn || !clockOut) {
        return res.status(400).json({ error: 'clockIn and clockOut are required for manual entries' });
      }
      const entry = {
        id: uuidv4(),
        userId: req.user.id,
        projectId: projectId || null,
        clockIn: Number(clockIn),
        clockOut: Number(clockOut),
        description: description || '',
        createdAt: Date.now(),
      };
      db.prepare('INSERT INTO time_entries (id, userId, projectId, clockIn, clockOut, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        entry.id, entry.userId, entry.projectId, entry.clockIn, entry.clockOut, entry.description, entry.createdAt
      );
      broadcastChange({ type: 'timeEntry', id: entry.id, action: 'created', ...requestMeta(req) });
      res.json(entry);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create time entry' });
    }
  });

  app.put("/api/time-entries/:id", authenticateToken, (req: any, res: any) => {
    try {
      const existing = db.prepare('SELECT * FROM time_entries WHERE id = ? AND userId = ?').get(req.params.id, req.user.id) as any;
      if (!existing) {
        return res.status(404).json({ error: 'Entry not found' });
      }
      const { clockIn, clockOut, description } = req.body;
      db.prepare('UPDATE time_entries SET clockIn = ?, clockOut = ?, description = ? WHERE id = ?').run(
        clockIn ?? existing.clockIn, clockOut ?? existing.clockOut, description ?? existing.description, existing.id
      );
      broadcastChange({ type: 'timeEntry', id: existing.id, action: 'updated', ...requestMeta(req) });
      res.json({ ...existing, clockIn: clockIn ?? existing.clockIn, clockOut: clockOut ?? existing.clockOut, description: description ?? existing.description });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update time entry' });
    }
  });

  app.delete("/api/time-entries/:id", authenticateToken, (req: any, res: any) => {
    try {
      const existing = db.prepare('SELECT id FROM time_entries WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
      if (!existing) {
        return res.status(404).json({ error: 'Entry not found' });
      }
      db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.id);
      broadcastChange({ type: 'timeEntry', id: req.params.id, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete time entry' });
    }
  });

  // Unknown API routes must 404 as JSON — without this they fall through to
  // the SPA shell and return index.html with HTTP 200.
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  const PORT = Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
