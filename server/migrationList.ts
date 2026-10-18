import crypto from 'crypto';
import fsSync from 'fs';
import path from 'path';
import type { Migration } from './migrations';
import { parseDataUrl } from './files';
import { writeFileContent } from './fileStore';
import { decomposeProject } from './projectStore';

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'base-schema',
    up({ db }) {
      // Mirrors the legacy initDb() bootstrap so fresh installs and old
      // databases converge on the same starting point. IF NOT EXISTS makes
      // this a no-op for existing installs.
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE IF NOT EXISTS bids (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT);
        CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, projectId TEXT, data TEXT, createdAt INTEGER, updatedAt INTEGER);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS user_preferences (userId TEXT NOT NULL, key TEXT NOT NULL, value TEXT, UNIQUE(userId, key));
        CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, type TEXT NOT NULL, resourceId TEXT NOT NULL, name TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS checklists (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS email_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS time_entries (
          id TEXT PRIMARY KEY, userId TEXT NOT NULL, projectId TEXT,
          clockIn INTEGER NOT NULL, clockOut INTEGER, description TEXT, createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_time_entries_userId ON time_entries (userId);
        CREATE INDEX IF NOT EXISTS idx_notes_projectId ON notes (projectId);
        CREATE INDEX IF NOT EXISTS idx_projects_createdAt ON projects (createdAt);
        CREATE INDEX IF NOT EXISTS idx_bids_createdAt ON bids (createdAt);
      `);
    },
  },
  {
    version: 2,
    name: 'legacy-dir-import',
    up({ db, dataDir }) {
      // Absorbs the old migrateOldData() (server.ts:217-272): pre-SQLite
      // installs kept JSON files in data/projects + data/images. Runs once;
      // renames the dirs after import so they are never re-read.
      const PROJECTS_DIR = path.join(dataDir, 'projects');
      const IMAGES_DIR = path.join(dataDir, 'images');
      const TEMPLATES_FILE = path.join(dataDir, 'templates.json');
      try {
        if (fsSync.existsSync(PROJECTS_DIR)) {
          const insert = db.prepare('INSERT OR IGNORE INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
          for (const f of fsSync.readdirSync(PROJECTS_DIR)) {
            if (!f.endsWith('.json')) continue;
            const data = fsSync.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8');
            const p = JSON.parse(data);
            insert.run(p.id, data, p.createdAt || Date.now());
          }
          fsSync.renameSync(PROJECTS_DIR, path.join(dataDir, 'projects_migrated'));
        }
      } catch (e) {
        console.error('[migrations] legacy project import failed (continuing):', e);
      }
      try {
        if (fsSync.existsSync(IMAGES_DIR)) {
          const insert = db.prepare('INSERT OR IGNORE INTO images (id, data) VALUES (?, ?)');
          for (const f of fsSync.readdirSync(IMAGES_DIR)) {
            if (!f.endsWith('.txt')) continue;
            insert.run(f.replace('.txt', ''), fsSync.readFileSync(path.join(IMAGES_DIR, f), 'utf-8'));
          }
          fsSync.renameSync(IMAGES_DIR, path.join(dataDir, 'images_migrated'));
        }
      } catch (e) {
        console.error('[migrations] legacy image import failed (continuing):', e);
      }
      try {
        if (fsSync.existsSync(TEMPLATES_FILE)) {
          const insert = db.prepare('INSERT OR IGNORE INTO templates (id, data) VALUES (?, ?)');
          for (const t of JSON.parse(fsSync.readFileSync(TEMPLATES_FILE, 'utf-8'))) {
            insert.run(t.id, JSON.stringify(t));
          }
          fsSync.renameSync(TEMPLATES_FILE, path.join(dataDir, 'templates_migrated.json'));
        }
      } catch (e) {
        console.error('[migrations] legacy template import failed (continuing):', e);
      }
    },
  },
  {
    version: 3,
    name: 'core-tables',
    up({ db }) {
      db.exec(`
        ALTER TABLE projects ADD COLUMN name TEXT;
        ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'estimating';
        ALTER TABLE projects ADD COLUMN contractor TEXT;
        ALTER TABLE projects ADD COLUMN address TEXT;
        ALTER TABLE projects ADD COLUMN bidDueDate INTEGER;
        ALTER TABLE projects ADD COLUMN contractValue REAL;
        ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE projects ADD COLUMN updatedAt INTEGER;
        ALTER TABLE projects ADD COLUMN meta TEXT;

        CREATE TABLE files (
          id TEXT PRIMARY KEY,
          projectId TEXT,
          name TEXT,
          mime TEXT NOT NULL DEFAULT 'application/octet-stream',
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'other',
          parentFileId TEXT,
          versionNumber INTEGER NOT NULL DEFAULT 1,
          legacyFormat TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_files_projectId ON files (projectId);

        CREATE TABLE plan_sets (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          name TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_plan_sets_projectId ON plan_sets (projectId);

        CREATE TABLE pages (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          planSetId TEXT,
          name TEXT,
          pageNumber TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          imageId TEXT,
          thumbnailId TEXT,
          sourcePdfFileId TEXT,
          sourcePdfPageNum INTEGER,
          attrs TEXT
        );
        CREATE INDEX idx_pages_projectId ON pages (projectId);

        CREATE TABLE takeoffs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          name TEXT,
          type TEXT,
          color TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_takeoffs_projectId ON takeoffs (projectId);

        CREATE TABLE measurements (
          id TEXT PRIMARY KEY,
          pageId TEXT NOT NULL,
          projectId TEXT NOT NULL,
          takeoffId TEXT,
          type TEXT NOT NULL,
          name TEXT,
          color TEXT,
          points TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_measurements_pageId ON measurements (pageId);
        CREATE INDEX idx_measurements_projectId ON measurements (projectId);

        CREATE TABLE activity (
          id TEXT PRIMARY KEY,
          projectId TEXT,
          userId TEXT,
          type TEXT NOT NULL,
          message TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_activity_projectId ON activity (projectId);
      `);
    },
  },
  {
    version: 4,
    name: 'images-to-disk',
    up({ db, dataDir }) {
      // Walks every legacy base64 blob out of the images table onto disk.
      // Disk writes are idempotent (same id → same path, atomic overwrite),
      // so a crash mid-migration is safe: the DB transaction rolls back and
      // the next boot redoes the walk.
      //
      // Stream rows with iterate() so multi-GB images tables never sit in the
      // JS heap: each blob is written to disk and dropped before the next row
      // is fetched. better-sqlite3 forbids running INSERTs while a cursor is
      // open on the same connection ("connection is busy" error), so only the
      // tiny metadata tuples are collected during the walk and inserted after
      // the cursor closes.
      const insert = db.prepare(`
        INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, legacyFormat, createdAt)
        VALUES (?, NULL, NULL, ?, ?, ?, 'other', ?, ?)
      `);
      const now = Date.now();
      const metas: { id: string; mime: string; size: number; sha256: string; legacyFormat: string }[] = [];
      for (const row of db.prepare('SELECT id, data FROM images').iterate() as Iterable<{ id: string; data: string | null }>) {
        if (!row.data) continue;
        const { mime, legacyFormat, buf } = parseDataUrl(row.data);
        const { size, sha256 } = writeFileContent(dataDir, row.id, buf);
        metas.push({ id: row.id, mime, size, sha256, legacyFormat });
      }
      for (const m of metas) {
        insert.run(m.id, m.mime, m.size, m.sha256, m.legacyFormat, now);
      }
      db.exec('DROP TABLE images');
      console.log(`[migrations] moved ${metas.length} blobs from images table to disk`);
    },
  },
  {
    version: 5,
    name: 'normalize-projects',
    up({ db }) {
      const labelFile = db.prepare('UPDATE files SET projectId = ?, kind = ?, name = COALESCE(?, name) WHERE id = ?');
      const label = (projectId: string, kind: string, name: string | null, fileId: any) => {
        if (typeof fileId === 'string' && fileId) labelFile.run(projectId, kind, name, fileId);
      };
      const rows = db.prepare('SELECT id, data FROM projects').all() as { id: string; data: string | null }[];
      for (const row of rows) {
        if (!row.data) continue;
        let p: any;
        try { p = JSON.parse(row.data); } catch {
          console.warn(`[migrations] skipping unparseable project ${row.id} (data preserved)`);
          continue;
        }
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          console.warn(`[migrations] skipping non-object project ${row.id} (data preserved)`);
          continue;
        }
        p.id = row.id; // trust the row key over the blob
        decomposeProject(db, p, 1);

        // Label this project's files so Documents/storage views can attribute them.
        for (const pg of p.pages ?? []) {
          label(row.id, 'plan', pg.name ?? null, pg.imageId);
          label(row.id, 'plan', pg.name ?? null, pg.thumbnailId);
          label(row.id, 'plan', pg.name ?? null, pg.sourcePdfFileId);
        }
        for (const po of p.printouts ?? []) label(row.id, 'printout', po.name ?? null, po.fileId);
        label(row.id, 'proposal', 'Proposal', p.proposalFileId);
        const emails = [...(p.email ? [p.email] : []), ...(p.emails ?? [])];
        for (const e of emails) for (const aid of e?.attachmentIds ?? []) label(row.id, 'document', null, aid);
      }
      console.log(`[migrations] normalized ${rows.length} projects`);
    },
  },
  {
    version: 6,
    name: 'remove-bid-inbox',
    up({ db }) {
      // Bid inbox + IMAP receiving are removed in Phase 3 (spec §2). The
      // migration framework backs up the DB file before applying, so existing
      // bid data survives in backups/. Bid email attachments stay in files/
      // and become reclaimable via the explicit orphan-cleanup admin tool.
      db.exec('DROP TABLE IF EXISTS bids; DROP TABLE IF EXISTS email_accounts;');
    },
  },
  {
    version: 7,
    name: 'drafts',
    up({ db }) {
      // Server-side editor drafts (spec §6): crash/refresh-safe working state
      // for the PDF/spreadsheet editors, keyed per user per file. data is the
      // editor-specific JSON (annotations / FortuneSheet workbook) — the base
      // file content is re-fetched by fileId, never duplicated here.
      db.exec(`
        CREATE TABLE drafts (
          userId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          kind TEXT NOT NULL,
          data TEXT NOT NULL,
          updatedAt INTEGER NOT NULL,
          PRIMARY KEY (userId, fileId)
        );
      `);
    },
  },
  {
    version: 8,
    name: 'billing',
    up({ db }) {
      // Billing v1 (spec §2, §3.2). Money stored as REAL dollars; all totals
      // are computed in integer cents in billingStore to avoid float drift.
      // Line-item identity is preserved (no totals-only invoices) so a future
      // AIA schedule-of-values can reference these rows (spec §3.2).
      db.exec(`
        CREATE TABLE invoices (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number TEXT,
          date INTEGER,
          status TEXT NOT NULL DEFAULT 'draft',
          terms TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_invoices_projectId ON invoices (projectId);

        CREATE TABLE invoice_lines (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          description TEXT,
          qty REAL NOT NULL DEFAULT 1,
          unitPrice REAL NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_invoice_lines_invoiceId ON invoice_lines (invoiceId);

        CREATE TABLE payments (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          date INTEGER,
          amount REAL NOT NULL DEFAULT 0,
          method TEXT,
          note TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_payments_invoiceId ON payments (invoiceId);

        CREATE TABLE change_orders (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number TEXT,
          description TEXT,
          amount REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_change_orders_projectId ON change_orders (projectId);
      `);
    },
  },
  {
    version: 9,
    name: 'issues',
    up({ db }) {
      // Issue reports (spec §2 new facets, §3.2): numbered deficiency/observation
      // records with photos and an open→sent→resolved lifecycle. Field-created by
      // any user (not admin-gated). number is a per-project sequence (MAX+1).
      // Photos are existing files rows linked via issue_photos.
      db.exec(`
        CREATE TABLE issues (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          version INTEGER NOT NULL DEFAULT 1,
          sentAt INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_issues_projectId ON issues (projectId);

        CREATE TABLE issue_photos (
          id TEXT PRIMARY KEY,
          issueId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_issue_photos_issueId ON issue_photos (issueId);
      `);
    },
  },
  {
    version: 10,
    name: 'punch',
    up({ db }) {
      // Punch & Checklists (spec §4.2): project-scoped, area-grouped punch items
      // with per-area progress and before/during/after photos. Field-created by any
      // user (not admin-gated, like issues). No numbering, no email — printable only.
      // Photos are existing files rows linked via punch_photos with a stage.
      db.exec(`
        CREATE TABLE punch_items (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          area TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          done INTEGER NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_punch_items_projectId ON punch_items (projectId);

        CREATE TABLE punch_photos (
          id TEXT PRIMARY KEY,
          punchItemId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          stage TEXT NOT NULL DEFAULT 'before',
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_punch_photos_itemId ON punch_photos (punchItemId);
      `);
    },
  },
  {
    version: 11,
    name: 'tasks',
    up({ db }) {
      // Collaborative Task List (Phase 4c-2): company-level, category-grouped tasks
      // assignable to any user, with todo|in_progress|done status, due dates, staged
      // photos (before|in_progress|after), and notes. Field-created by any user
      // (not admin-gated). Mirrors punch but with assignee + dueDate + status.
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          assigneeUserId TEXT,
          status TEXT NOT NULL DEFAULT 'todo',
          dueDate TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL,
          createdBy TEXT
        );
        CREATE INDEX idx_tasks_assignee ON tasks (assigneeUserId);
        CREATE INDEX idx_tasks_status ON tasks (status);

        CREATE TABLE task_photos (
          id TEXT PRIMARY KEY,
          taskId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          stage TEXT NOT NULL DEFAULT 'before',
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_task_photos_taskId ON task_photos (taskId);
      `);

      // Non-destructive import of legacy standalone checklists. Each legacy item
      // becomes a task (category = checklist name). The legacy `checklists` table
      // is intentionally KEPT as a backup. One bad blob must not fail boot — the
      // framework wraps up() in a transaction, but every inner error is caught
      // before it can propagate, so the outer transaction is never aborted.
      let rows: { data: string }[] = [];
      try {
        rows = db.prepare('SELECT data FROM checklists ORDER BY createdAt ASC').all() as { data: string }[];
      } catch { rows = []; } // table may not exist on a brand-new db

      const insTask = db.prepare(`INSERT INTO tasks
        (id, category, title, notes, assigneeUserId, status, dueDate, sortOrder, version, createdAt, createdBy)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 1, ?, NULL)`);
      const insPhoto = db.prepare(`INSERT INTO task_photos
        (id, taskId, fileId, stage, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);

      let sort = 0;
      for (const r of rows) {
        let cl: any;
        try { cl = JSON.parse(r.data); } catch { continue; } // skip malformed blob
        if (!cl || !Array.isArray(cl.items)) continue;
        const category = typeof cl.name === 'string' ? cl.name : '';
        for (const it of cl.items) {
          if (!it || typeof it !== 'object') continue;
          const taskId = typeof it.id === 'string' && it.id ? it.id : crypto.randomUUID();
          const title = typeof it.description === 'string' ? it.description : '';
          const notes = typeof it.comments === 'string' ? it.comments : '';
          const status = it.done === true ? 'done' : 'todo';
          const createdAt = Number.isFinite(it.createdAt) ? it.createdAt : Date.now();
          try {
            insTask.run(taskId, category, title, notes, status, sort++, createdAt);
          } catch { continue; } // duplicate id etc. — skip, don't abort
          let pSort = 0;
          const stages: [string, any][] = [
            ['before', it.beforePhotoIds],
            ['in_progress', it.inProgressPhotoIds],
            ['after', it.afterPhotoIds],
          ];
          for (const [stage, ids] of stages) {
            if (!Array.isArray(ids)) continue;
            for (const fileId of ids) {
              if (typeof fileId !== 'string' || !fileId) continue;
              try { insPhoto.run(crypto.randomUUID(), taskId, fileId, stage, pSort++, createdAt); } catch { /* skip */ }
            }
          }
        }
      }
    },
  },
  {
    version: 12,
    name: 'aia-billing',
    up({ db }) {
      // AIA progress billing (G702/G703): per-project Schedule of Values, a monthly
      // sequence of pay applications, and per-line progress. Money in INTEGER CENTS.
      // Additive — no data transform. (Phase 7, building on spec §3.2's anticipated
      // schedule_of_values / pay_applications.)
      db.exec(`
        CREATE TABLE aia_sov_lines (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          itemNo TEXT,
          description TEXT NOT NULL DEFAULT '',
          scheduledValueCents INTEGER NOT NULL DEFAULT 0,
          retainagePercent REAL,
          isChangeOrder INTEGER NOT NULL DEFAULT 0,
          changeOrderId TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_aia_sov_projectId ON aia_sov_lines (projectId);

        CREATE TABLE aia_pay_apps (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          periodTo TEXT,
          applicationDate TEXT,
          retainagePercent REAL NOT NULL DEFAULT 10,
          storedRetainagePercent REAL NOT NULL DEFAULT 10,
          status TEXT NOT NULL DEFAULT 'draft',
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_aia_pay_apps_projectId ON aia_pay_apps (projectId);

        CREATE TABLE aia_pay_app_lines (
          id TEXT PRIMARY KEY,
          payAppId TEXT NOT NULL,
          sovLineId TEXT NOT NULL,
          percentComplete REAL NOT NULL DEFAULT 0,
          storedMaterialsCents INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_aia_pay_app_lines_payAppId ON aia_pay_app_lines (payAppId);
      `);
    },
  },
  {
    version: 13,
    name: 'payments-polymorphic',
    up({ db }) {
      // A payment now targets an invoice OR an AIA pay application (Phase 7b).
      // SQLite cannot drop the NOT NULL invoiceId in place, so the table is
      // rebuilt: every existing row is copied and backfilled to an 'invoice'
      // target (non-destructive). Money stays REAL dollars (billingStore
      // computes integer cents). Runs inside the framework transaction.
      const exists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='payments'`
      ).get();
      if (!exists) return;
      db.exec(`
        CREATE TABLE payments_new (
          id TEXT PRIMARY KEY,
          targetType TEXT NOT NULL,
          targetId TEXT NOT NULL,
          date INTEGER,
          amount REAL NOT NULL DEFAULT 0,
          method TEXT,
          note TEXT,
          createdAt INTEGER NOT NULL
        );
        INSERT INTO payments_new (id, targetType, targetId, date, amount, method, note, createdAt)
          SELECT id, 'invoice', invoiceId, date, amount, method, note, createdAt FROM payments;
        DROP TABLE payments;
        ALTER TABLE payments_new RENAME TO payments;
        CREATE INDEX idx_payments_target ON payments (targetType, targetId);
      `);
    },
  },
  {
    version: 14,
    name: 'change-order-line-items-photos',
    up({ db }) {
      // Change Orders gain invoice-like capability (Phase 9): line items, photos,
      // a version column (optimistic concurrency), and new fields (lumpSumAmount,
      // scheduleImpactDays, date). PURELY ADDITIVE — new columns get defaults and
      // two new tables are created; NO data rewrite. Existing change_orders rows
      // keep their `amount` (the canonical rolled-up total read by billingSummary
      // and aiaStore.syncChangeOrders), which now equals (Σ line cents + lump-sum
      // cents)/100, written server-side on save. Legacy status='pending' rows stay
      // valid (reads tolerate them; only new transitions use the new status set).
      db.exec(`
        ALTER TABLE change_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE change_orders ADD COLUMN lumpSumAmount REAL NOT NULL DEFAULT 0;
        ALTER TABLE change_orders ADD COLUMN scheduleImpactDays INTEGER;
        ALTER TABLE change_orders ADD COLUMN date INTEGER;

        CREATE TABLE change_order_lines (
          id TEXT PRIMARY KEY,
          changeOrderId TEXT NOT NULL,
          description TEXT,
          qty REAL NOT NULL DEFAULT 1,
          unitPrice REAL NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_change_order_lines_changeOrderId ON change_order_lines (changeOrderId);

        CREATE TABLE change_order_photos (
          id TEXT PRIMARY KEY,
          changeOrderId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_change_order_photos_changeOrderId ON change_order_photos (changeOrderId);
      `);
    },
  },
  {
    version: 15,
    name: 'plan-set-sheet-identity',
    up({ db }) {
      // Plan-set rework (spec docs/superpowers/specs/2026-06-28-plan-set-rework-design.md).
      //
      // ⚠️ DATA-TRANSFORMING + SUPERVISED. Per the migration protocol, this is
      // flagged to run on real data only under supervision. It is NON-DESTRUCTIVE:
      // no measurement row is ever deleted. The framework backs up the DB before
      // applying and VACUUMs after; the whole up() runs inside one transaction.
      //
      // Establishes the new "logical sheet" model, per project:
      //   (a) SUFFIX within-set duplicate page numbers ("A-101" -> "A-101 (2)")
      //       so each page in a set has a distinct number (mirrors the client-side
      //       suffixPageNumber in src/utils/sheetNaming.ts — kept behavior-identical).
      //   (b) ASSIGN a durable sheetId (uuid) to every page: pages sharing a
      //       normalized (trim+lowercase) page number across the whole project are
      //       revisions of one sheet and share one sheetId. Blank-numbered pages
      //       each become their own single-revision sheet. sheetId lands in the
      //       page row's attrs JSON (round-trips via decompose/loadProject).
      //   (c) CURRENT = LIVING: order each sheet's revisions oldest->newest by
      //       plan-set sortOrder (pages with no plan set sort last). The newest is
      //       the current/living revision. If the current page has ZERO measurement
      //       rows but an older revision has some, COPY the most-recent non-empty
      //       revision's measurements onto the current page (fresh uuids; source
      //       rows are RETAINED as frozen history — never deleted).

      const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

      // Next free "Base (n)" given a set of already-taken normalized numbers.
      // Identical behavior to src/utils/sheetNaming.ts suffixPageNumber.
      const suffixPageNumber = (base: string, takenNormalized: Set<string>): string => {
        let n = 2;
        while (takenNormalized.has(norm(`${base} (${n})`))) n++;
        return `${base} (${n})`;
      };

      // Plan-set order index per project (lower = older). plan_sets.sortOrder is
      // the persisted oldest->newest order written by decomposeProject.
      const planSetRows = db
        .prepare('SELECT id, projectId, sortOrder FROM plan_sets')
        .all() as { id: string; projectId: string; sortOrder: number }[];
      const setOrderById = new Map<string, number>();
      for (const ps of planSetRows) setOrderById.set(ps.id, ps.sortOrder);

      const updatePageNumber = db.prepare('UPDATE pages SET pageNumber = ? WHERE id = ?');
      const updatePageAttrs = db.prepare('UPDATE pages SET attrs = ? WHERE id = ?');
      const insMeas = db.prepare(`
        INSERT INTO measurements (id, pageId, projectId, takeoffId, type, name, color, points, sortOrder, attrs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const projectIds = (
        db.prepare('SELECT id FROM projects').all() as { id: string }[]
      ).map(r => r.id);

      for (const projectId of projectIds) {
        const pages = db
          .prepare('SELECT id, planSetId, pageNumber, sortOrder, attrs FROM pages WHERE projectId = ? ORDER BY sortOrder')
          .all(projectId) as {
            id: string;
            planSetId: string | null;
            pageNumber: string | null;
            sortOrder: number;
            attrs: string | null;
          }[];
        if (pages.length === 0) continue;

        // Working page numbers (mutated by the suffix pass below).
        const pageNumberById = new Map<string, string | null>();
        for (const p of pages) pageNumberById.set(p.id, p.pageNumber);

        // ---- (a) Suffix within-set duplicate page numbers --------------------
        // Per plan set (null planSet grouped together), the first occurrence of a
        // non-blank number keeps it; later occurrences get the next free suffix.
        const takenBySet = new Map<string, Set<string>>(); // setKey -> normalized numbers taken
        const seenBySet = new Map<string, Set<string>>();   // setKey -> normalized numbers already seen once
        for (const p of pages) {
          const num = pageNumberById.get(p.id);
          const normNum = norm(num);
          if (!normNum) continue; // blank exempt
          const setKey = p.planSetId ?? '';
          let taken = takenBySet.get(setKey);
          if (!taken) { taken = new Set(); takenBySet.set(setKey, taken); }
          let seen = seenBySet.get(setKey);
          if (!seen) { seen = new Set(); seenBySet.set(setKey, seen); }

          if (!seen.has(normNum)) {
            // first time this number appears in the set — keep it
            seen.add(normNum);
            taken.add(normNum);
          } else {
            // duplicate — suffix off the original (pre-normalized) base text
            const base = (num ?? '').trim();
            const suffixed = suffixPageNumber(base, taken);
            taken.add(norm(suffixed));
            pageNumberById.set(p.id, suffixed);
            updatePageNumber.run(suffixed, p.id);
          }
        }

        // ---- (b) Assign sheetId by normalized page number (project-wide) ------
        // Pages sharing a normalized number are revisions of one sheet. Blank
        // numbers never group (each blank page is its own sheet).
        const sheetIdByNormNumber = new Map<string, string>();
        const sheetIdByPageId = new Map<string, string>();
        for (const p of pages) {
          const normNum = norm(pageNumberById.get(p.id));
          let sheetId: string;
          if (!normNum) {
            sheetId = crypto.randomUUID(); // blank -> own sheet
          } else {
            sheetId = sheetIdByNormNumber.get(normNum) ?? crypto.randomUUID();
            sheetIdByNormNumber.set(normNum, sheetId);
          }
          sheetIdByPageId.set(p.id, sheetId);

          // Persist sheetId into the page's attrs JSON.
          let attrs: any = {};
          if (p.attrs) { try { attrs = JSON.parse(p.attrs); } catch { attrs = {}; } }
          if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) attrs = {};
          attrs.sheetId = sheetId;
          updatePageAttrs.run(JSON.stringify(attrs), p.id);
        }

        // ---- (c) current = newest revision = living set ----------------------
        // Group pages by sheetId, order oldest->newest by plan-set order (pages
        // with no plan set, or a set not in the order map, sort LAST/standalone).
        const SET_LAST = Number.MAX_SAFE_INTEGER;
        const setOrderForPage = (planSetId: string | null): number =>
          planSetId ? (setOrderById.get(planSetId) ?? SET_LAST) : SET_LAST;
        const pageById = new Map(pages.map(p => [p.id, p]));

        const sheetGroups = new Map<string, string[]>(); // sheetId -> pageIds
        for (const p of pages) {
          const sid = sheetIdByPageId.get(p.id)!;
          const g = sheetGroups.get(sid) ?? [];
          g.push(p.id);
          sheetGroups.set(sid, g);
        }

        for (const pageIds of sheetGroups.values()) {
          if (pageIds.length <= 1) continue; // single revision — nothing to carry
          // oldest -> newest; stable on original sortOrder for ties.
          const ordered = [...pageIds].sort((a, b) => {
            const pa = pageById.get(a)!, pb = pageById.get(b)!;
            const oa = setOrderForPage(pa.planSetId), ob = setOrderForPage(pb.planSetId);
            if (oa !== ob) return oa - ob;
            return pa.sortOrder - pb.sortOrder;
          });
          const currentPageId = ordered[ordered.length - 1];

          const measCount = (pageId: string): number =>
            (db.prepare('SELECT COUNT(*) AS c FROM measurements WHERE pageId = ?').get(pageId) as { c: number }).c;

          // Current already living? leave it.
          if (measCount(currentPageId) > 0) continue;

          // Find the most-recent OLDER revision that has measurements.
          let sourcePageId: string | null = null;
          for (let i = ordered.length - 2; i >= 0; i--) {
            if (measCount(ordered[i]) > 0) { sourcePageId = ordered[i]; break; }
          }
          if (!sourcePageId) continue; // nothing to copy forward

          // Copy source measurements onto the current page with fresh uuids.
          // Source rows are RETAINED (frozen history) — never deleted.
          const srcRows = db
            .prepare('SELECT takeoffId, type, name, color, points, sortOrder, attrs FROM measurements WHERE pageId = ? ORDER BY sortOrder')
            .all(sourcePageId) as {
              takeoffId: string | null; type: string; name: string | null; color: string | null;
              points: string; sortOrder: number; attrs: string | null;
            }[];
          for (const m of srcRows) {
            insMeas.run(
              crypto.randomUUID(), currentPageId, projectId,
              m.takeoffId, m.type, m.name, m.color, m.points, m.sortOrder, m.attrs
            );
          }
        }
      }
    },
  },
  {
    version: 16,
    name: 'customers-from-contractor',
    // SUPERVISED, data-transforming, NON-DESTRUCTIVE. Creates the customers table
    // + projects.customerId, then makes one Customer per distinct (trimmed,
    // lower-cased) contractor string and links its projects. Projects with a
    // blank/null contractor go to a single well-known "Unassigned" customer so
    // they remain reachable. `contractor` is left untouched.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as any[]).map(c => c.name);
      if (!cols.includes('customerId')) db.exec(`ALTER TABLE projects ADD COLUMN customerId TEXT;`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT,
          contactName TEXT, notes TEXT, generalEmail TEXT, accountingEmail TEXT,
          estimatingEmail TEXT, pmEmail TEXT, createdAt INTEGER, updatedAt INTEGER, attrs TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_projects_customerId ON projects (customerId);
      `);
      const now = Date.now();
      db.prepare(`INSERT OR IGNORE INTO customers (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`)
        .run('customer-unassigned', 'Unassigned', now, now);

      // Only touch not-yet-linked projects so a re-run is a no-op (idempotent).
      const rows = db.prepare(`SELECT id, contractor FROM projects WHERE customerId IS NULL OR customerId = ''`).all() as any[];
      const byNorm = new Map<string, string>();
      let seq = 0;
      const link = db.prepare(`UPDATE projects SET customerId = ? WHERE id = ?`);
      for (const r of rows) {
        const raw = (r.contractor ?? '').trim();
        if (!raw) { link.run('customer-unassigned', r.id); continue; }
        const norm = raw.toLowerCase();
        let cid = byNorm.get(norm);
        if (!cid) {
          cid = `customer-mig-${now}-${seq++}`;
          db.prepare(`INSERT INTO customers (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`).run(cid, raw, now, now);
          byNorm.set(norm, cid);
        }
        link.run(cid, r.id);
      }
    },
  },
  {
    version: 17,
    name: 'customer-emails-json',
    // ADDITIVE, NON-DESTRUCTIVE, IDEMPOTENT. Upgrades customer role emails from
    // 4 flat string columns (generalEmail etc.) to a single JSON column `emails`
    // whose shape is CustomerRoleEmails (each role holds {to?, cc?, bcc?}).
    // The old columns are left untouched so rollback is safe.
    up({ db }) {
      // Add the column idempotently.
      const cols = (db.prepare(`PRAGMA table_info(customers)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('emails')) {
        db.exec(`ALTER TABLE customers ADD COLUMN emails TEXT;`);
      }

      // Backfill: only touch rows where emails is still NULL (re-run safe).
      const rows = db.prepare(
        `SELECT id, generalEmail, accountingEmail, estimatingEmail, pmEmail
         FROM customers WHERE emails IS NULL`
      ).all() as { id: string; generalEmail: string | null; accountingEmail: string | null; estimatingEmail: string | null; pmEmail: string | null }[];

      const upd = db.prepare(`UPDATE customers SET emails = ? WHERE id = ?`);
      for (const r of rows) {
        const obj: Record<string, { to: string }> = {};
        if (r.generalEmail) obj.general = { to: r.generalEmail };
        if (r.accountingEmail) obj.accounting = { to: r.accountingEmail };
        if (r.estimatingEmail) obj.estimating = { to: r.estimatingEmail };
        if (r.pmEmail) obj.pm = { to: r.pmEmail };
        // Only write non-empty objects; rows with all-null columns stay NULL.
        if (Object.keys(obj).length > 0) {
          upd.run(JSON.stringify(obj), r.id);
        }
      }
    },
  },
  {
    version: 18,
    name: 'task-relations',
    // ADDITIVE. A task may relate to a project and/or customer as its SUBJECT
    // (not its doer). Setting a project derives+locks its customer; that
    // invariant is enforced in taskStore, not here. Existing tasks stay NULL.
    up({ db }) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN projectId TEXT;
        ALTER TABLE tasks ADD COLUMN customerId TEXT;
        CREATE INDEX idx_tasks_projectId ON tasks (projectId);
        CREATE INDEX idx_tasks_customerId ON tasks (customerId);
      `);
    },
  },
  {
    version: 19,
    name: 'rfis',
    // ADDITIVE. RFIs — numbered Requests For Information, like issues but with
    // header fields (spec/drawing ref, attention), a response-needed-by date,
    // and a tracked response (uploaded PDF and/or text). Photos mirror
    // issue_photos. No FKs (project convention); cascades are manual.
    up({ db }) {
      db.exec(`
        CREATE TABLE rfis (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT,
          question TEXT,
          specRef TEXT,
          drawingRef TEXT,
          attention TEXT,
          responseNeededBy TEXT,
          responseText TEXT,
          responseFileId TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          version INTEGER NOT NULL DEFAULT 1,
          sentAt INTEGER,
          answeredAt INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_rfis_projectId ON rfis (projectId);
        CREATE TABLE rfi_photos (
          id TEXT PRIMARY KEY,
          rfiId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_rfi_photos_rfiId ON rfi_photos (rfiId);
      `);
    },
  },
  {
    version: 20,
    name: 'rfi-counter',
    // ADDITIVE. RFI numbers are referenced in external correspondence, so an
    // issued number must never be reused after a delete. Numbering moves from
    // MAX(number)+1 to a per-project high-water counter, backfilled to each
    // project's current max.
    up({ db }) {
      db.exec('ALTER TABLE projects ADD COLUMN rfiCounter INTEGER NOT NULL DEFAULT 0;');
      db.exec(`UPDATE projects SET rfiCounter = COALESCE(
        (SELECT MAX(number) FROM rfis WHERE rfis.projectId = projects.id), 0)`);
    },
  },
  {
    version: 21,
    name: 'two-stage-lifecycle',
    // Collapses the 8 legacy stages to bidding|in_progress. complete/lost
    // auto-archive (lost also gets meta.lostBid for the Archive view's badge).
    // Only projects.status + meta.archived/meta.lostBid change — idempotent.
    up({ db }) {
      const rows = db.prepare('SELECT id, status, meta FROM projects').all() as any[];
      const upd = db.prepare('UPDATE projects SET status = ?, meta = ? WHERE id = ?');
      for (const r of rows) {
        const old = r.status ?? 'estimating';
        // A row with unparseable meta must not abort the whole migration: keep
        // its meta column verbatim (nothing is lost) and still normalize its
        // status. Mirrors patchProject's guard in projectStore.
        let meta: any = {};
        let metaParsed = true;
        try { meta = r.meta ? JSON.parse(r.meta) : {}; }
        catch { metaParsed = false; }
        let status: string;
        if (old === 'bidding' || old === 'in_progress') status = old; // re-run safe
        else if (['estimating', 'proposal_sent'].includes(old)) status = 'bidding';
        else if (['awarded', 'punch_list'].includes(old)) status = 'in_progress';
        else if (old === 'complete') { status = 'in_progress'; meta.archived = true; }
        else if (old === 'archived') { status = 'in_progress'; meta.archived = true; }
        else if (old === 'lost') { status = 'bidding'; meta.archived = true; meta.lostBid = true; }
        else status = 'bidding';
        upd.run(status, metaParsed ? JSON.stringify(meta) : r.meta, r.id);
      }
    },
  },
  {
    version: 22,
    name: 'payapp-released-retainage',
    // ADDITIVE, IDEMPOTENT, no data transform. Retainage releases are recorded
    // as percentage POINTS on the app that releases them; the effective rate on
    // app N is base − Σ points over apps with number ≤ N. Existing apps default
    // to 0, so every historical G702/G703 recomputes byte-identically.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(aia_pay_apps)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('releasedRetainagePoints')) {
        db.exec(`ALTER TABLE aia_pay_apps ADD COLUMN releasedRetainagePoints REAL NOT NULL DEFAULT 0;`);
      }
    },
  },
  {
    version: 23,
    name: 'document-source-attribution',
    // Unified Documents (spec docs/superpowers/specs/2026-08-17-unified-documents-design.md).
    //
    // ⚠️ DATA-TRANSFORMING but purely DERIVED and NON-DESTRUCTIVE: it adds four
    // nullable columns and rewrites `kind` labels / fills sourceType+sourceId
    // (and a missing projectId) from references that already exist elsewhere in
    // the database. No file row and no byte on disk is ever removed. Flag to
    // the operator on pull per the migration protocol.
    //
    // IDEMPOTENT BY CONSTRUCTION: every write is guarded by a WHERE clause that
    // matches only rows whose value actually differs, so a replay touches zero
    // rows (proven by the double-run diff in migrationList.test.ts).
    //
    // PASS ORDER MATTERS: the join-table pass runs FIRST because the legacy
    // `change-order` kind is ambiguous — it was written for both CO photos and
    // generated CO PDFs. Rows found in change_order_photos become
    // `change-order-photo`; whatever still carries `change-order` afterwards is
    // a PDF and keeps its kind.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(files)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('customerId')) db.exec(`ALTER TABLE files ADD COLUMN customerId TEXT;`);
      if (!cols.includes('sourceType')) db.exec(`ALTER TABLE files ADD COLUMN sourceType TEXT;`);
      if (!cols.includes('sourceId')) db.exec(`ALTER TABLE files ADD COLUMN sourceId TEXT;`);
      if (!cols.includes('archived')) db.exec(`ALTER TABLE files ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`);
      // Upload-time upsert-by-source looks a document up by this triple on
      // every generate, so it gets an index.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_files_source ON files (sourceType, sourceId);`);
      // The Documents listing always filters on archived and orders by
      // createdAt. Added after the first dev DBs had already reached v23, so a
      // database stamped 23 before this line existed needs it run by hand:
      //   CREATE INDEX IF NOT EXISTS idx_files_archived_createdAt ON files (archived, createdAt);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_files_archived_createdAt ON files (archived, createdAt);`);

      // Writes only when something actually changes (NULL-safe via IS NOT).
      const relabel = db.prepare(`
        UPDATE files SET kind = ?, sourceType = ?, sourceId = ?
        WHERE id = ? AND (kind IS NOT ? OR sourceType IS NOT ? OR sourceId IS NOT ?)
      `);
      const label = (fileId: unknown, kind: string, sourceType: string | null, sourceId: string | null) => {
        if (typeof fileId !== 'string' || !fileId) return;
        relabel.run(kind, sourceType, sourceId, fileId, kind, sourceType, sourceId);
      };
      // Files uploaded outside a project context (task photos via POST
      // /api/images, plan-set PDFs via saveBinaryFile) never got a projectId.
      // Their owner knows it, so the Documents page can attribute them.
      const attribute = db.prepare('UPDATE files SET projectId = ? WHERE id = ? AND projectId IS NULL');
      const attributeTo = (fileId: unknown, projectId: unknown) => {
        if (typeof fileId !== 'string' || !fileId) return;
        if (typeof projectId !== 'string' || !projectId) return;
        attribute.run(projectId, fileId);
      };
      // Nothing here may abort the migration: each pass is isolated, and the
      // helpers above ignore any row that lacks a usable id (mirrors 21's
      // per-row meta guard, which the project pass repeats for its JSON).
      const pass = (name: string, fn: () => void) => {
        try { fn(); } catch (e) { console.warn(`[migrations] 23: ${name} pass skipped:`, e); }
      };

      // ---- 1. Join-table photos (FIRST — see the ambiguity note above) ------
      const photoTables: { table: string; entityCol: string; kind: string; sourceType: string }[] = [
        { table: 'issue_photos', entityCol: 'issueId', kind: 'issue-photo', sourceType: 'issue' },
        { table: 'punch_photos', entityCol: 'punchItemId', kind: 'punch-photo', sourceType: 'punch' },
        { table: 'task_photos', entityCol: 'taskId', kind: 'task-photo', sourceType: 'task' },
        { table: 'change_order_photos', entityCol: 'changeOrderId', kind: 'change-order-photo', sourceType: 'change-order' },
        { table: 'rfi_photos', entityCol: 'rfiId', kind: 'rfi-photo', sourceType: 'rfi' },
      ];
      for (const p of photoTables) {
        pass(p.table, () => {
          // ORDER BY keeps the outcome identical on a replay in the (unusual)
          // case of one file being linked from two rows — last write wins, and
          // "last" must not depend on scan order.
          const rows = db.prepare(`SELECT ${p.entityCol} AS entityId, fileId FROM ${p.table} ORDER BY id`)
            .all() as { entityId: string | null; fileId: string | null }[];
          for (const r of rows) {
            if (!r.entityId) continue;
            label(r.fileId, p.kind, p.sourceType, r.entityId);
          }
        });
      }
      // Task photos are the one class uploaded with no project context.
      pass('task-photo projectId', () => {
        const rows = db.prepare(`
          SELECT tp.fileId AS fileId, t.projectId AS projectId
          FROM task_photos tp JOIN tasks t ON t.id = tp.taskId
          WHERE t.projectId IS NOT NULL
        `).all() as { fileId: string | null; projectId: string | null }[];
        for (const r of rows) attributeTo(r.fileId, r.projectId);
      });

      // ---- 2. Page / plan assets -------------------------------------------
      // The uploaded PDF behind a page is the document users care about; the
      // page raster + thumbnail are `plan` assets the Documents page hides.
      pass('pages', () => {
        // One uploaded PDF backs every page it was split into, so the same
        // sourcePdfFileId recurs; ORDER BY makes the winning row stable.
        const rows = db.prepare('SELECT projectId, planSetId, imageId, thumbnailId, sourcePdfFileId FROM pages ORDER BY id')
          .all() as { projectId: string | null; planSetId: string | null; imageId: string | null; thumbnailId: string | null; sourcePdfFileId: string | null }[];
        for (const r of rows) {
          if (r.sourcePdfFileId) {
            // Pre-plan-set pages have no set; the project stands in as the source.
            label(r.sourcePdfFileId, 'plan-source', 'plan-set', r.planSetId ?? r.projectId ?? null);
            attributeTo(r.sourcePdfFileId, r.projectId);
          }
          label(r.imageId, 'plan', null, null);
          label(r.thumbnailId, 'plan', null, null);
          attributeTo(r.imageId, r.projectId);
          attributeTo(r.thumbnailId, r.projectId);
        }
      });

      // ---- 3. Project JSON fields (printouts / proposal) --------------------
      // These live in projects.meta since migration 5 (data is NULL from then
      // on); the legacy blob is read as a fallback so a half-imported database
      // still migrates.
      pass('project documents', () => {
        const rows = db.prepare('SELECT id, meta, data FROM projects ORDER BY id').all() as { id: string; meta: string | null; data: string | null }[];
        for (const row of rows) {
          let p: any = null;
          try { p = row.meta ? JSON.parse(row.meta) : null; }
          catch { console.warn(`[migrations] 23: project ${row.id} has unparseable meta (left verbatim)`); }
          if (!p && row.data) {
            try { p = JSON.parse(row.data); } catch { /* legacy blob unreadable — nothing to derive */ }
          }
          if (!p || typeof p !== 'object' || Array.isArray(p)) continue;

          for (const po of Array.isArray(p.printouts) ? p.printouts : []) {
            if (!po || typeof po !== 'object') continue;
            const poId = typeof po.id === 'string' && po.id ? po.id : null;
            label(po.fileId, 'printout', poId ? 'printout' : null, poId);
            attributeTo(po.fileId, row.id);
          }
          // One proposal per project, so the project id is its source id.
          label(p.proposalFileId, 'proposal', 'proposal', row.id);
          attributeTo(p.proposalFileId, row.id);
          for (const photoId of Array.isArray(p.proposalPhotoIds) ? p.proposalPhotoIds : []) {
            label(photoId, 'proposal-photo', 'proposal', row.id);
            attributeTo(photoId, row.id);
          }
        }
      });

      // ---- 4. RFI responses -------------------------------------------------
      pass('rfi responses', () => {
        const rows = db.prepare('SELECT id, projectId, responseFileId FROM rfis WHERE responseFileId IS NOT NULL ORDER BY id')
          .all() as { id: string; projectId: string | null; responseFileId: string | null }[];
        for (const r of rows) {
          label(r.responseFileId, 'rfi-response', 'rfi', r.id);
          attributeTo(r.responseFileId, r.projectId);
        }
      });

      // ---- 5. Settings assets (AIA template — hidden from the page) ---------
      pass('settings assets', () => {
        const row = db.prepare(`SELECT value FROM settings WHERE key = 'aiaTemplateFileId'`).get() as { value: string | null } | undefined;
        label(row?.value, 'settings-asset', null, null);
      });

      // ---- 6. Legacy kind rename -------------------------------------------
      // Generated issue PDFs were written as `issue`; the canonical vocabulary
      // calls them `issue-report`. Safe after pass 1: issue PHOTOS were kind
      // `photo` and have already become `issue-photo`, so nothing else can
      // still be carrying `issue`. Idempotent — a replay matches no rows.
      pass('issue kind rename', () => {
        db.prepare(`UPDATE files SET kind = 'issue-report' WHERE kind = 'issue'`).run();
      });

      // ---- 7. Everything else keeps its kind --------------------------------
      // Direct uploads (document/spreadsheet/photo/other) and already-canonical
      // generated documents (invoice/rfi/punch-report/change-order/
      // email-attachment) are left alone. Their sourceId is not derivable for
      // historical rows — project attribution stays the link (spec §Data model).
    },
  },
  {
    version: 24,
    name: 'change-order-title',
    // Change Order Title (spec docs/superpowers/specs/2026-08-17-change-order-title-design.md).
    // ADDITIVE, IDEMPOTENT: one nullable column. Existing rows get NULL, so
    // every legacy CO display/PDF/SOV-sync path falls back to `description`
    // exactly as it did before this migration.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(change_orders)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('title')) {
        db.exec(`ALTER TABLE change_orders ADD COLUMN title TEXT;`);
      }
    },
  },
  {
    version: 25,
    name: 'pages-asset-indexes',
    // ADDITIVE, IDEMPOTENT: index-only. The Documents listing hides plan-page
    // assets with `NOT EXISTS (SELECT 1 FROM pages WHERE imageId = f.id OR
    // thumbnailId = f.id)` (server/documents.ts). Without these indexes that
    // correlated subquery full-scans `pages` once per candidate file, so the
    // COUNT(*) half of the listing is O(files × pages) — measured 2.7s at
    // 20k files / 6k pages, 6ms with the indexes (SQLite MULTI-INDEX OR).
    up({ db }) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pages_imageId ON pages (imageId);
        CREATE INDEX IF NOT EXISTS idx_pages_thumbnailId ON pages (thumbnailId);
      `);
    },
  },
  {
    version: 26,
    name: 'sheet-sessions',
    // ADDITIVE. Backs the shared spreadsheet session store (WS5): one row per
    // file holding the latest authoritative state plus a journal of op
    // batches appended since that state was folded. sheet_ops is the durable
    // journal — SQLite IS the crash-recovery log (see sheetSessions.ts).
    up({ db }) {
      db.exec(`
        CREATE TABLE sheet_sessions (
          fileId TEXT PRIMARY KEY,
          state TEXT,
          stateSeq INTEGER NOT NULL DEFAULT 0,
          dirty INTEGER NOT NULL DEFAULT 0,
          sessionOpen INTEGER NOT NULL DEFAULT 0,
          snapshotDone INTEGER NOT NULL DEFAULT 0,
          updatedAt INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE sheet_ops (
          fileId TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ops TEXT NOT NULL,
          PRIMARY KEY (fileId, seq)
        );
      `);
    },
  },
  {
    version: 27,
    name: 'daily-reports',
    // ADDITIVE. Daily field reports: one row per project per calendar date
    // (UNIQUE below is the identity rule), plus an RFI-style photo join table.
    // weatherHourly/manCounts are JSON text columns (display-only lists, never
    // queried by content).
    up({ db }) {
      db.exec(`
        CREATE TABLE daily_reports (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          reportDate TEXT NOT NULL,
          jobName TEXT NOT NULL DEFAULT '',
          contractorName TEXT NOT NULL DEFAULT '',
          weatherSummary TEXT NOT NULL DEFAULT '',
          temperature TEXT NOT NULL DEFAULT '',
          weatherHourly TEXT NOT NULL DEFAULT '[]',
          manCounts TEXT NOT NULL DEFAULT '[]',
          fieldNotes TEXT NOT NULL DEFAULT '',
          issues TEXT NOT NULL DEFAULT '',
          createdBy TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(projectId, reportDate)
        );
        CREATE INDEX idx_daily_reports_project ON daily_reports(projectId);
        CREATE TABLE daily_report_photos (
          id TEXT PRIMARY KEY,
          dailyReportId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_daily_report_photos_report ON daily_report_photos(dailyReportId);
      `);
    },
  },
  {
    version: 28,
    name: 'proposals',
    // DATA-TRANSFORMING (supervised). Proposals become first-class rows
    // (spec 2026-08-28 §3). Legacy project-meta proposals/printouts are
    // converted: proposal printouts → numbered `legacy=1` proposal rows;
    // remaining printouts → takeoff-print/takeoff-export documents; the six
    // legacy meta keys are stripped. File bytes are never touched.
    up({ db }) {
      db.exec(`
        CREATE TABLE proposals (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          revisedFromId TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          legacy INTEGER NOT NULL DEFAULT 0,
          title TEXT,
          validUntil TEXT,
          fontFamily TEXT,
          coverNotes TEXT,
          terms TEXT,
          inclusions TEXT NOT NULL DEFAULT '[]',
          exclusions TEXT NOT NULL DEFAULT '[]',
          paymentSchedule TEXT,
          showGrandTotal INTEGER NOT NULL DEFAULT 1,
          includeCostDetail INTEGER NOT NULL DEFAULT 0,
          includeSignature INTEGER NOT NULL DEFAULT 1,
          highlightQuality TEXT NOT NULL DEFAULT 'best',
          fileId TEXT,
          signedFileId TEXT,
          sentAt INTEGER,
          sentTo TEXT,
          acceptedAt INTEGER,
          declinedAt INTEGER,
          version INTEGER NOT NULL DEFAULT 1,
          createdBy TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          UNIQUE(projectId, number)
        );
        CREATE INDEX idx_proposals_project ON proposals(projectId);
        CREATE INDEX idx_proposals_status ON proposals(status);
        CREATE TABLE proposal_lines (
          id TEXT PRIMARY KEY,
          proposalId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL,
          takeoffId TEXT,
          description TEXT NOT NULL DEFAULT '',
          amountCents INTEGER NOT NULL DEFAULT 0,
          derivedAmountCents INTEGER,
          measurementSummary TEXT,
          isAlternate INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_proposal_lines_proposal ON proposal_lines(proposalId);
        CREATE TABLE proposal_photos (
          id TEXT PRIMARY KEY,
          proposalId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          caption TEXT,
          createdAt INTEGER NOT NULL,
          UNIQUE(proposalId, fileId)
        );
        CREATE INDEX idx_proposal_photos_proposal ON proposal_photos(proposalId);
        CREATE TABLE proposal_attachments (
          id TEXT PRIMARY KEY,
          proposalId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(proposalId, fileId)
        );
        CREATE INDEX idx_proposal_attachments_proposal ON proposal_attachments(proposalId);
      `);

      const LEGACY_KEYS = ['printouts', 'proposalFileId', 'proposalSentAt', 'proposalPhotoIds', 'proposalCoverNotes', 'proposalTerms'];
      // LOCAL y-m-d, matching src/utils/takeoffPrintNames.ts and
      // proposalFileName — an ISO slice shows tomorrow's (or yesterday's) date
      // either side of UTC midnight, so a print made at 8pm would be dated the
      // next day.
      const isoDate = (ts: number) => {
        const d = new Date(Number.isFinite(ts) ? ts : Date.now());
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      };
      const fileKind = db.prepare('SELECT kind, name FROM files WHERE id = ?');
      const setFile = db.prepare('UPDATE files SET kind = ?, name = ?, sourceType = ?, sourceId = ? WHERE id = ?');
      const setFileSource = db.prepare('UPDATE files SET sourceType = ?, sourceId = ? WHERE id = ?');
      const insProposal = db.prepare(`INSERT INTO proposals
        (id, projectId, number, status, legacy, coverNotes, terms, fileId, sentAt, version, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)`);
      const insPhoto = db.prepare('INSERT OR IGNORE INTO proposal_photos (id, proposalId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)');

      const rows = db.prepare('SELECT id, name, meta FROM projects ORDER BY createdAt, id').all() as { id: string; name: string | null; meta: string | null }[];
      let proposalsMade = 0, printsRelabeled = 0, photosMoved = 0;
      for (const row of rows) {
        let p: any = null;
        try { p = row.meta ? JSON.parse(row.meta) : null; } catch { console.warn(`[migrations] 28: project ${row.id} has unparseable meta (skipped)`); continue; }
        if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
        if (!LEGACY_KEYS.some(k => k in p)) continue; // already migrated / never had proposals

        const projectName = (row.name && row.name.trim()) || 'Untitled';
        // Two guards on the legacy list before anything is created from it:
        //  - a printout whose file row is gone (bytes reclaimed, project
        //    partially deleted) must NOT become a proposal — it would be a
        //    numbered row pointing at a dangling fileId, unopenable forever.
        //  - the same fileId can appear twice (an old re-save appended rather
        //    than replaced); keeping the first occurrence avoids two proposals
        //    (or two relabels) fighting over one file row.
        const seenFileIds = new Set<string>();
        const printouts: any[] = (Array.isArray(p.printouts) ? p.printouts : [])
          .filter((x: any) => x && typeof x === 'object' && typeof x.fileId === 'string')
          .filter((x: any) => {
            if (!fileKind.get(x.fileId)) return false;
            if (seenFileIds.has(x.fileId)) return false;
            seenFileIds.add(x.fileId);
            return true;
          });
        const isProposalPrintout = (po: any) => {
          // A printout whose fileId IS the sent proposal is always a proposal
          // printout, even if its own kind/name heuristics don't say so —
          // otherwise it gets classified as sent-proposal AND relabeled as a
          // takeoff print below, leaving proposals.fileId pointing at a
          // mislabeled file.
          if (typeof p.proposalFileId === 'string' && po.fileId === p.proposalFileId) return true;
          const f = fileKind.get(po.fileId) as { kind: string; name: string | null } | undefined;
          if (f?.kind === 'proposal') return true;
          const nm = String(po.name ?? f?.name ?? '');
          return /^Proposal\b/i.test(nm);
        };
        const proposalPrintouts = printouts.filter(isProposalPrintout).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        const otherPrintouts = printouts.filter(po => !isProposalPrintout(po));

        let lastProposalId: string | null = null;
        proposalPrintouts.forEach((po, i) => {
          const id = crypto.randomUUID();
          const createdAt = Number.isFinite(po.createdAt) ? po.createdAt : Date.now();
          const isSent = typeof p.proposalFileId === 'string' && p.proposalFileId === po.fileId;
          insProposal.run(id, row.id, i + 1, isSent ? 'sent' : 'draft',
            typeof p.proposalCoverNotes === 'string' ? p.proposalCoverNotes : null,
            typeof p.proposalTerms === 'string' ? p.proposalTerms : null,
            po.fileId, isSent && Number.isFinite(p.proposalSentAt) ? p.proposalSentAt : null,
            createdAt, createdAt);
          const f = fileKind.get(po.fileId) as { kind: string; name: string | null } | undefined;
          if (f) setFile.run('proposal', f.name ?? po.name ?? null, 'proposal', id, po.fileId);
          lastProposalId = id;
          proposalsMade++;
        });
        // proposalFileId not among the printouts (sent via regenerate path) —
        // still becomes its own sent proposal so the sent PDF isn't orphaned.
        if (typeof p.proposalFileId === 'string' && p.proposalFileId && !proposalPrintouts.some(po => po.fileId === p.proposalFileId) && fileKind.get(p.proposalFileId)) {
          const id = crypto.randomUUID();
          const ts = Number.isFinite(p.proposalSentAt) ? p.proposalSentAt : Date.now();
          insProposal.run(id, row.id, proposalPrintouts.length + 1, 'sent',
            typeof p.proposalCoverNotes === 'string' ? p.proposalCoverNotes : null,
            typeof p.proposalTerms === 'string' ? p.proposalTerms : null,
            p.proposalFileId, ts, ts, ts);
          const f = fileKind.get(p.proposalFileId) as { kind: string; name: string | null };
          setFile.run('proposal', f.name, 'proposal', id, p.proposalFileId);
          lastProposalId = id;
          proposalsMade++;
        }

        const photoIds: string[] = Array.isArray(p.proposalPhotoIds) ? p.proposalPhotoIds.filter((x: any) => typeof x === 'string' && x) : [];
        if (lastProposalId && photoIds.length) {
          photoIds.forEach((fid, i) => {
            if (!fileKind.get(fid)) return;
            insPhoto.run(crypto.randomUUID(), lastProposalId, fid, i, Date.now());
            setFileSource.run('proposal', lastProposalId, fid);
            photosMoved++;
          });
        }
        // No proposal to hang them on: photos stay as proposal-photo uploads
        // attributed to the project (sourceType cleared so they're loose).
        if (!lastProposalId && photoIds.length) {
          photoIds.forEach(fid => { if (fileKind.get(fid)) setFileSource.run(null, null, fid); });
        }

        for (const po of otherPrintouts) {
          const f = fileKind.get(po.fileId) as { kind: string; name: string | null } | undefined;
          if (!f) continue;
          const isExcel = po.type === 'excel' || /\.xlsx$/i.test(String(po.name ?? f.name ?? ''));
          const kind = isExcel ? 'takeoff-export' : 'takeoff-print';
          const name = `${isExcel ? 'Takeoff Export' : 'Takeoff Print'} – ${projectName} – ${isoDate(po.createdAt)}`;
          const srcId = typeof po.id === 'string' && po.id ? po.id : crypto.randomUUID();
          setFile.run(kind, name, 'takeoff-print', srcId, po.fileId);
          printsRelabeled++;
        }

        for (const k of LEGACY_KEYS) delete p[k];
        db.prepare('UPDATE projects SET meta = ? WHERE id = ?').run(JSON.stringify(p), row.id);
      }
      console.log(`[migrations] 28: ${proposalsMade} legacy proposals, ${photosMoved} photos moved, ${printsRelabeled} takeoff prints relabeled`);
    },
  },
  {
    version: 29,
    name: 'proposal-counter',
    // ADDITIVE. Same fix as migration 20 (rfi-counter): a proposal number is
    // referenced once sent, so it must never be reused after a delete.
    // Numbering moves from MAX(number)+1 to a per-project high-water counter,
    // backfilled to each project's current max (including legacy rows from
    // migration 28, which already occupy numbers).
    up({ db }) {
      db.exec('ALTER TABLE projects ADD COLUMN proposalCounter INTEGER NOT NULL DEFAULT 0;');
      db.exec(`UPDATE projects SET proposalCounter = COALESCE(
        (SELECT MAX(number) FROM proposals WHERE proposals.projectId = projects.id), 0)`);
    },
  },
  {
    version: 30,
    name: 'updated-at-columns',
    // ADDITIVE. The document-actions bar needs "record changed since the PDF
    // was generated"; only proposals/daily_reports/projects carried updatedAt.
    up({ db }) {
      const hasCol = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).some(x => x.name === c);
      for (const t of ['invoices', 'change_orders', 'issues', 'rfis', 'aia_pay_apps']) {
        if (hasCol(t, 'updatedAt')) continue;
        db.exec(`ALTER TABLE ${t} ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0`);
        if (hasCol(t, 'createdAt')) db.exec(`UPDATE ${t} SET updatedAt = COALESCE(createdAt, 0)`);
        db.prepare(`UPDATE ${t} SET updatedAt = ? WHERE updatedAt = 0`).run(Date.now());
      }
    },
  },
  {
    version: 31,
    name: 'mail-client',
    // ADDITIVE tables (spec 2026-08-29 mail client §3) + rfis columns, PLUS a
    // TRANSFORM: per-user smtp.* prefs become a sealed `imap` mail account in
    // status needs_review and the prefs are deleted. The transform runs only
    // when ctx.mailCrypto is supplied (server startup always supplies it;
    // bare test harnesses may not) so it is safe to re-run.
    up({ db, mailCrypto }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_accounts (
          id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL,
          emailAddress TEXT NOT NULL, displayName TEXT, signatureHtml TEXT,
          isDefault INTEGER NOT NULL DEFAULT 0, authBlob TEXT NOT NULL,
          syncState TEXT, indexedSince TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok',
          lastSyncAt TEXT, lastError TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(userId);
        CREATE TABLE IF NOT EXISTS mail_folders (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, name TEXT NOT NULL,
          role TEXT, unreadCount INTEGER NOT NULL DEFAULT 0, totalCount INTEGER NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (accountId) REFERENCES mail_accounts(id) ON DELETE CASCADE);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_folders_acct_pid ON mail_folders(accountId, providerId);
        CREATE TABLE IF NOT EXISTS mail_messages (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerMessageId TEXT NOT NULL, providerThreadId TEXT,
          messageIdHeader TEXT, inReplyTo TEXT, referencesJson TEXT NOT NULL DEFAULT '[]', threadKey TEXT NOT NULL,
          fromAddr TEXT, fromName TEXT, toJson TEXT NOT NULL DEFAULT '[]', ccJson TEXT NOT NULL DEFAULT '[]', bccJson TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
          isRead INTEGER NOT NULL DEFAULT 0, isStarred INTEGER NOT NULL DEFAULT 0, isDraft INTEGER NOT NULL DEFAULT 0,
          hasAttachments INTEGER NOT NULL DEFAULT 0, attachmentsJson TEXT NOT NULL DEFAULT '[]', sizeBytes INTEGER NOT NULL DEFAULT 0,
          folderIdsJson TEXT NOT NULL DEFAULT '[]', sentFromApp INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          FOREIGN KEY (accountId) REFERENCES mail_accounts(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_acct_date ON mail_messages(accountId, date DESC);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_acct_thread ON mail_messages(accountId, threadKey);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_mid ON mail_messages(messageIdHeader);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_acct_pmid ON mail_messages(accountId, providerMessageId);
        CREATE TABLE IF NOT EXISTS mail_threads (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL, threadKey TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
          firstDate TEXT NOT NULL, lastDate TEXT NOT NULL, messageCount INTEGER NOT NULL DEFAULT 0, unreadCount INTEGER NOT NULL DEFAULT 0,
          hasAttachments INTEGER NOT NULL DEFAULT 0, isStarred INTEGER NOT NULL DEFAULT 0,
          participantsJson TEXT NOT NULL DEFAULT '[]', folderIdsJson TEXT NOT NULL DEFAULT '[]', updatedAt TEXT NOT NULL,
          FOREIGN KEY (accountId) REFERENCES mail_accounts(id) ON DELETE CASCADE);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_threads_acct_key ON mail_threads(accountId, threadKey);
        CREATE INDEX IF NOT EXISTS idx_mail_threads_acct_last ON mail_threads(accountId, lastDate DESC);
        CREATE TABLE IF NOT EXISTS mail_thread_links (
          id TEXT PRIMARY KEY, threadKey TEXT NOT NULL, subjectSnapshot TEXT, firstDate TEXT, participantsJson TEXT NOT NULL DEFAULT '[]',
          itemType TEXT NOT NULL, itemId TEXT NOT NULL, projectId TEXT, customerId TEXT, linkedByUserId TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_links_unique ON mail_thread_links(threadKey, itemType, itemId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_item ON mail_thread_links(itemType, itemId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_project ON mail_thread_links(projectId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_customer ON mail_thread_links(customerId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_thread ON mail_thread_links(threadKey);
        CREATE TABLE IF NOT EXISTS mail_thread_reply_state (
          threadKey TEXT PRIMARY KEY, lastInboundDate TEXT, lastOutboundDate TEXT, updatedAt TEXT NOT NULL);
      `);
      const hasCol = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).some(x => x.name === c);
      if (!hasCol('rfis', 'pendingReplyJson')) db.exec('ALTER TABLE rfis ADD COLUMN pendingReplyJson TEXT');
      if (!hasCol('rfis', 'responseSource')) db.exec('ALTER TABLE rfis ADD COLUMN responseSource TEXT');
      if (!hasCol('rfis', 'responseMessageIdHeader')) db.exec('ALTER TABLE rfis ADD COLUMN responseMessageIdHeader TEXT');

      if (!mailCrypto) { console.warn('[migration 31] mailCrypto not supplied — smtp.* transform skipped'); return; }
      // Scoped to live users: user_preferences rows can outlive a deleted user, and a
      // mail_accounts insert for a missing userId would trip the FK (or orphan a row).
      const users = db.prepare("SELECT DISTINCT userId FROM user_preferences WHERE key = 'smtp.host' AND TRIM(value) <> '' AND userId IN (SELECT id FROM users)").all() as { userId: string }[];
      const now = new Date().toISOString();
      const since = new Date(Date.now() - 180 * 86400000).toISOString();
      for (const { userId } of users) {
        const rows = db.prepare("SELECT key, value FROM user_preferences WHERE userId = ? AND key LIKE 'smtp.%'").all(userId) as { key: string; value: string }[];
        const cfg: Record<string, string> = {};
        rows.forEach(r => { cfg[r.key.slice(5)] = r.value; });
        const smtpPort = parseInt(cfg.port || '587', 10) || 587;
        const auth = {
          imapHost: cfg.host, imapPort: 993, imapSecure: true,
          smtpHost: cfg.host, smtpPort, smtpSecure: cfg.secure === 'true',
          username: cfg.username || '', password: cfg.password || '',
        };
        const email = (cfg.fromAddress || cfg.username || '').trim().toLowerCase();
        // No address to send as: leave the prefs in place (they are the only copy of
        // that half-filled config) and say so, rather than silently dropping the user.
        if (!email) { console.warn(`[migration 31] user ${userId}: smtp.host set but no fromAddress/username — left untouched`); continue; }
        const id = 'mailacct-' + userId;
        db.prepare(`INSERT OR IGNORE INTO mail_accounts (id, userId, provider, emailAddress, displayName, isDefault, authBlob, indexedSince, status, createdAt, updatedAt)
                    VALUES (?, ?, 'imap', ?, ?, 1, ?, ?, 'needs_review', ?, ?)`)
          .run(id, userId, email, cfg.fromName || null, mailCrypto.seal(auth), since, now, now);
        db.prepare("DELETE FROM user_preferences WHERE userId = ? AND key LIKE 'smtp.%'").run(userId);
      }
    },
  },
  {
    version: 32,
    name: 'mail_messages providerThreadId index',
    // deriveThreadKey now resolves a provider conversation id to a thread we
    // already hold, which is one lookup per synced message. Without this index
    // that is a full scan of mail_messages per message — on a real mailbox,
    // a delta page would cost millions of row visits.
    up({ db }) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_mail_messages_acct_pthread ON mail_messages(accountId, providerThreadId);');
    },
  },
  {
    version: 33,
    name: 'invoice-notes',
    // ADDITIVE, IDEMPOTENT: one nullable column, same pattern as migration 24
    // (change_orders.title). Internal-only notes (the owner's ruling) — never
    // printed on the invoice PDF or included in invoice emails, so existing
    // rows getting NULL changes nothing about how they render or send.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(invoices)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('notes')) {
        db.exec(`ALTER TABLE invoices ADD COLUMN notes TEXT;`);
      }
    },
  },
  {
    version: 34,
    name: 'invoice-photos-attachments',
    // ADDITIVE: two join tables, same shape as their precedents — photos mirror
    // change_order_photos (migration 14), attachments mirror proposal_attachments
    // (migration 28). IF NOT EXISTS makes replaying up() a no-op.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoice_photos (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(invoiceId, fileId)
        );
        CREATE INDEX IF NOT EXISTS idx_invoice_photos_invoice ON invoice_photos (invoiceId);

        CREATE TABLE IF NOT EXISTS invoice_attachments (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(invoiceId, fileId)
        );
        CREATE INDEX IF NOT EXISTS idx_invoice_attachments_invoice ON invoice_attachments (invoiceId);
      `);
    },
  },
  {
    version: 35,
    name: 'sov-line-types-and-locks',
    // ADDITIVE. lineType ('item' | 'header' | 'blank') lets a schedule of
    // values carry label-only header rows and blank spacers; the default keeps
    // every existing row an item. aia_sov_locks (row present = locked) is what
    // stops SOV edits from silently rewriting prior pay applications — see
    // docs/superpowers/specs/2026-09-11-sov-finalize-headers-split-design.md.
    // Backfill: any project that already has a pay application is locked
    // (reason 'pay-app', lockedAt = its earliest app), so existing projects
    // follow the new rule from day one. An admin can reopen in one click.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(aia_sov_lines)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('lineType')) {
        db.exec(`ALTER TABLE aia_sov_lines ADD COLUMN lineType TEXT NOT NULL DEFAULT 'item';`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS aia_sov_locks (
          projectId      TEXT PRIMARY KEY,
          lockedAt       INTEGER NOT NULL,
          lockedByUserId TEXT,
          reason         TEXT NOT NULL
        );
      `);
      const r = db.prepare(`
        INSERT OR IGNORE INTO aia_sov_locks (projectId, lockedAt, lockedByUserId, reason)
        SELECT projectId, MIN(createdAt), NULL, 'pay-app' FROM aia_pay_apps GROUP BY projectId
      `).run();
      if (r.changes > 0) console.log(`[migration 35] locked the schedule of values on ${r.changes} project(s) that already have pay applications`);
    },
  },
  {
    version: 36,
    name: 'backup-runs',
    // ADDITIVE: run history for the app-managed backups (spec
    // docs/superpowers/specs/2026-09-12-backup-restore-design.md).
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS backup_runs (
          id            TEXT PRIMARY KEY,
          target        TEXT NOT NULL,
          trigger       TEXT NOT NULL,
          startedAt     INTEGER NOT NULL,
          finishedAt    INTEGER,
          status        TEXT NOT NULL,
          snapshotId    TEXT,
          objectsAdded  INTEGER NOT NULL DEFAULT 0,
          bytesWritten  INTEGER NOT NULL DEFAULT 0,
          warningsJson  TEXT NOT NULL DEFAULT '[]',
          error         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs (startedAt);
      `);
    },
  },
  {
    version: 37,
    name: 'onlyoffice-editor',
    // ADDITIVE (ONLYOFFICE Phase 1, docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md):
    //   * files.createdBy — who produced each version (upload, generate or an
    //     editor save). NULL on every existing row: history from before this
    //     migration has no known author.
    //   * editor_sessions — one row per file while an ONLYOFFICE editing
    //     session is open, so everyone who opens the file joins that session
    //     (same document key) and its saves follow the one-version-per-session
    //     rule. Rows go when ONLYOFFICE reports the session closed.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(files)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('createdBy')) db.exec(`ALTER TABLE files ADD COLUMN createdBy TEXT;`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS editor_sessions (
          fileId             TEXT PRIMARY KEY,
          docKey             TEXT NOT NULL,
          baseVersionNumber  INTEGER NOT NULL,
          savedVersionNumber INTEGER,
          savedSha256        TEXT,
          startedAt          INTEGER NOT NULL,
          lastSavedAt        INTEGER,
          lastSavedBy        TEXT
        );
      `);
    },
  },
  {
    version: 38,
    name: 'onlyoffice-history',
    // ADDITIVE (ONLYOFFICE Phase 2 — version history, restore, delete):
    //   * files.versionOrigin — how the live bytes of a version came to be:
    //     'editor' (an ONLYOFFICE save), 'restore', or NULL (uploaded or
    //     generated). Lets a generated document show it was edited by hand.
    //   * editor_sessions.users — JSON array of the user ids ONLYOFFICE last
    //     reported in the session (callback status 1); restore is refused
    //     while anyone else is editing.
    //   * editor_changes — per (file, version) the change log and changes zip
    //     ONLYOFFICE sends when a session closes, so the editor's Version
    //     History can highlight what changed.
    //   * editor_superseded_sessions — sessions a restore replaced: a late
    //     save from one is only kept (as a new version) if it holds edits made
    //     after the restore.
    up({ db }) {
      const fileCols = (db.prepare(`PRAGMA table_info(files)`).all() as any[]).map((c: any) => c.name);
      if (!fileCols.includes('versionOrigin')) db.exec(`ALTER TABLE files ADD COLUMN versionOrigin TEXT;`);
      const sessionCols = (db.prepare(`PRAGMA table_info(editor_sessions)`).all() as any[]).map((c: any) => c.name);
      if (!sessionCols.includes('users')) db.exec(`ALTER TABLE editor_sessions ADD COLUMN users TEXT;`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS editor_changes (
          fileId        TEXT NOT NULL,
          versionNumber INTEGER NOT NULL,
          changesJson   TEXT NOT NULL,
          serverVersion TEXT,
          zip           BLOB,
          createdAt     INTEGER NOT NULL,
          PRIMARY KEY (fileId, versionNumber)
        );
        CREATE TABLE IF NOT EXISTS editor_superseded_sessions (
          docKey     TEXT PRIMARY KEY,
          fileId     TEXT NOT NULL,
          lastSha256 TEXT,
          closedAt   INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 39,
    name: 'notifications',
    // ADDITIVE (ONLYOFFICE Phase 5 — the notification bell):
    //   * notifications — one row per person told about something: an
    //     @mention in a document comment, a task or RFI assigned to them, a
    //     GC's answer to an RFI. readAt is NULL until they open or dismiss it.
    //     actorUserId is who caused it (never notified about their own act).
    //   * rfis.assigneeUserId — an internal "Assigned to" on RFIs.
    //   * rfis.sentByUserId — who last emailed the RFI out; told, with the
    //     assignee, when the GC's answer comes in.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id          TEXT PRIMARY KEY,
          userId      TEXT NOT NULL,
          type        TEXT NOT NULL,
          title       TEXT NOT NULL,
          body        TEXT,
          link        TEXT,
          actorUserId TEXT,
          createdAt   INTEGER NOT NULL,
          readAt      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (userId, createdAt);
      `);
      const rfiCols = (db.prepare(`PRAGMA table_info(rfis)`).all() as any[]).map((c: any) => c.name);
      if (!rfiCols.includes('assigneeUserId')) db.exec(`ALTER TABLE rfis ADD COLUMN assigneeUserId TEXT;`);
      if (!rfiCols.includes('sentByUserId')) db.exec(`ALTER TABLE rfis ADD COLUMN sentByUserId TEXT;`);
    },
  },
  {
    version: 40,
    name: 'push-subscriptions',
    // ADDITIVE (ONLYOFFICE Phase 5 — phone push, added 2026-09-27): one row per
    // device a person turned push notifications on for. endpoint is the
    // browser's push-service address (unique: the same browser signing in as
    // someone else moves it to them); p256dh/auth are the browser's keys that
    // encrypt each message. Rows go when the push service says the
    // subscription is gone, or when the person turns it off.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id         TEXT PRIMARY KEY,
          userId     TEXT NOT NULL,
          endpoint   TEXT NOT NULL UNIQUE,
          p256dh     TEXT NOT NULL,
          auth       TEXT NOT NULL,
          device     TEXT,
          createdAt  INTEGER NOT NULL,
          lastUsedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (userId);
      `);
    },
  },
  {
    version: 41,
    name: 'share-expiry',
    // ADDITIVE (ONLYOFFICE Phase 7 — sharing upgrades):
    //   * shares.expiresAt — when the link stops working; NULL = never. Links
    //     made before this keep NULL, so they keep working (the owner,
    //     2026-09-25) and show in the file's active-links list to be turned off.
    //   * shares.revokedAt — "Stop sharing": the row stays so the link can say
    //     it was turned off, rather than that it never existed.
    //   * shares.createdBy — who made it, shown in the links list.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(shares)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('expiresAt')) db.exec(`ALTER TABLE shares ADD COLUMN expiresAt INTEGER;`);
      if (!cols.includes('revokedAt')) db.exec(`ALTER TABLE shares ADD COLUMN revokedAt INTEGER;`);
      if (!cols.includes('createdBy')) db.exec(`ALTER TABLE shares ADD COLUMN createdBy TEXT;`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_shares_resourceId ON shares (resourceId);`);
    },
  },
  {
    version: 42,
    name: 'pdf-attachments',
    // ADDITIVE: PDF attachments for change orders, RFIs, issues and daily
    // reports — four join tables, each the same shape as invoice_attachments
    // (migration 34), keyed by the same owner column as that record's photo
    // table. Attached PDFs are appended to the end of the record's generated
    // PDF, after its photos (spec
    // docs/superpowers/specs/2026-10-06-pdf-attachments-design.md). Existing
    // records simply have none. IF NOT EXISTS makes replaying up() a no-op.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS change_order_attachments (
          id TEXT PRIMARY KEY,
          changeOrderId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(changeOrderId, fileId)
        );
        CREATE INDEX IF NOT EXISTS idx_change_order_attachments_change_order ON change_order_attachments (changeOrderId);

        CREATE TABLE IF NOT EXISTS rfi_attachments (
          id TEXT PRIMARY KEY,
          rfiId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(rfiId, fileId)
        );
        CREATE INDEX IF NOT EXISTS idx_rfi_attachments_rfi ON rfi_attachments (rfiId);

        CREATE TABLE IF NOT EXISTS issue_attachments (
          id TEXT PRIMARY KEY,
          issueId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(issueId, fileId)
        );
        CREATE INDEX IF NOT EXISTS idx_issue_attachments_issue ON issue_attachments (issueId);

        CREATE TABLE IF NOT EXISTS daily_report_attachments (
          id TEXT PRIMARY KEY,
          dailyReportId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(dailyReportId, fileId)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_report_attachments_report ON daily_report_attachments (dailyReportId);
      `);
    },
  },
  {
    version: 43,
    name: 'payment-attachments',
    // ADDITIVE: photos and PDFs on a payment — a check image, a receipt,
    // remittance advice, an ACH confirmation. One join table for both, the
    // same shape as the attachment tables of migrations 34 and 42; the file's
    // mime tells a photo from a PDF. Unlike those, nothing here ever reaches a
    // generated document: the attachments show only on the payment itself
    // (spec docs/superpowers/specs/2026-10-06-payment-attachments-design.md).
    // Existing payments simply have none. IF NOT EXISTS makes replaying up()
    // a no-op.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_attachments (
          id TEXT PRIMARY KEY,
          paymentId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(paymentId, fileId)
        );
        CREATE INDEX IF NOT EXISTS idx_payment_attachments_payment ON payment_attachments (paymentId);
      `);
    },
  },
  {
    version: 44,
    name: 'daily-report-start-time',
    // ADDITIVE, IDEMPOTENT: one nullable column, same pattern as migrations
    // 24 and 33. daily_reports.startTime is 'HH:MM' (24-hour); the report's
    // weather covers that hour through 12 hours later (spec
    // docs/superpowers/specs/2026-10-06-daily-report-start-time-design.md).
    // Existing reports keep NULL — their weather was fetched for the old fixed
    // 6 AM–6 PM window, which is also what a NULL start time fetches, and their
    // stored weather is untouched.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(daily_reports)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('startTime')) {
        db.exec(`ALTER TABLE daily_reports ADD COLUMN startTime TEXT;`);
      }
    },
  },
  {
    version: 45,
    name: 'daily-report-crews',
    // DATA-TRANSFORMING (supervised). Daily reports become per crew: each
    // project's Daily Reports page has named crew tabs, each its own set of
    // reports, one per date per crew (spec
    // docs/superpowers/specs/2026-10-06-daily-report-crews-design.md).
    //   * daily_report_crews — one row per crew (name, tab order).
    //   * daily_reports is REBUILT: SQLite cannot change the table-level
    //     UNIQUE(projectId, reportDate) in place, so the table is recreated with
    //     a crewId column and UNIQUE(projectId, crewId, reportDate), every row
    //     is copied (same ids, so daily_report_photos / daily_report_attachments
    //     and every files.sourceId / mail link that points at a report still
    //     resolve), the old table dropped and the new one renamed into place.
    //     Its indexes and triggers are read from sqlite_master first and
    //     recreated afterwards.
    //   * Every project that has reports gets one crew, "Crew 1", and all of
    //     its reports move into it — including reports of a project that has
    //     since been deleted (project delete never removed them), so no row is
    //     lost to the new NOT NULL crewId.
    // NON-DESTRUCTIVE: no report data changes; nothing references daily_reports
    // by a declared FOREIGN KEY, so the drop cascades nowhere. The framework
    // backs the database up first and the whole up() runs in one transaction,
    // so a failure (e.g. the row-count check below) leaves the table as it was.
    // Replay-safe: the crews table is IF NOT EXISTS, a project that already
    // has a crew gets no second one, and a daily_reports that already has
    // crewId is not rebuilt again.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_report_crews (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          name TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_report_crews_project ON daily_report_crews (projectId);
      `);
      const oldCols = (db.prepare(`PRAGMA table_info(daily_reports)`).all() as { name: string }[]).map(c => c.name);
      if (oldCols.includes('crewId')) return; // already rebuilt

      // "Crew 1" for every project with reports that has no crew yet.
      const now = Date.now();
      const insCrew = db.prepare(`INSERT INTO daily_report_crews (id, projectId, name, sortOrder, createdAt, updatedAt)
        VALUES (?, ?, 'Crew 1', 0, ?, ?)`);
      const projectIds = (db.prepare(`SELECT DISTINCT projectId FROM daily_reports
        WHERE projectId NOT IN (SELECT projectId FROM daily_report_crews) ORDER BY projectId`).all() as { projectId: string }[])
        .map(r => r.projectId);
      for (const pid of projectIds) insCrew.run(crypto.randomUUID(), pid, now, now);

      // The rebuild. Indexes and triggers are captured before the drop takes
      // them with it (sql IS NULL = the UNIQUE constraint's own autoindex,
      // which the new table brings back in its new form).
      const attached = db.prepare(`SELECT sql FROM sqlite_master
        WHERE tbl_name = 'daily_reports' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all() as { sql: string }[];
      db.exec(`
        CREATE TABLE daily_reports_new (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          crewId TEXT NOT NULL,
          reportDate TEXT NOT NULL,
          startTime TEXT,
          jobName TEXT NOT NULL DEFAULT '',
          contractorName TEXT NOT NULL DEFAULT '',
          weatherSummary TEXT NOT NULL DEFAULT '',
          temperature TEXT NOT NULL DEFAULT '',
          weatherHourly TEXT NOT NULL DEFAULT '[]',
          manCounts TEXT NOT NULL DEFAULT '[]',
          fieldNotes TEXT NOT NULL DEFAULT '',
          issues TEXT NOT NULL DEFAULT '',
          createdBy TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(projectId, crewId, reportDate)
        );
      `);
      // Copy by name. A column the new table lacks would be lost, so it stops
      // the migration instead (the transaction rolls back).
      const newCols = (db.prepare(`PRAGMA table_info(daily_reports_new)`).all() as { name: string }[]).map(c => c.name);
      const missing = oldCols.filter(c => !newCols.includes(c));
      if (missing.length) throw new Error(`[migrations] 45: daily_reports has columns the rebuild would drop: ${missing.join(', ')}`);
      const colList = oldCols.join(', ');
      db.exec(`
        INSERT INTO daily_reports_new (${colList}, crewId)
          SELECT ${colList}, (SELECT c.id FROM daily_report_crews c WHERE c.projectId = daily_reports.projectId
                              ORDER BY c.sortOrder, c.createdAt, c.id LIMIT 1)
          FROM daily_reports;
      `);
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
      const before = count('daily_reports');
      if (count('daily_reports_new') !== before) throw new Error('[migrations] 45: daily_reports row count changed during the rebuild');
      db.exec(`
        DROP TABLE daily_reports;
        ALTER TABLE daily_reports_new RENAME TO daily_reports;
      `);
      for (const { sql } of attached) db.exec(sql);
      db.exec('CREATE INDEX IF NOT EXISTS idx_daily_reports_project ON daily_reports (projectId);');
      console.log(`[migrations] 45: ${before} daily report(s) moved into "Crew 1" on ${projectIds.length} project(s)`);
    },
  },
  {
    version: 46,
    name: 'invoices-auto-paid',
    // DATA-TRANSFORMING (supervised). Invoices now turn 'paid' by themselves
    // once their payments cover the total (billingStore.syncInvoicePaidStatus,
    // spec docs/superpowers/specs/2026-10-06-reports-design.md). This marks the
    // ones that already were: every 'sent' invoice with a total over $0 whose
    // payments reach it. Totals use the store's cents maths, inlined so a later
    // store change can't alter what this migration did: each line's qty ×
    // unitPrice rounded to cents before summing (sumCents), each payment rounded
    // to cents (paidCentsFor).
    // Only the status changes. version and updatedAt stay as they are, as they
    // do when a payment moves the status, so no open editor conflicts and no
    // stored PDF reads out of date (the PDF never prints the status). Drafts,
    // invoices already 'paid', and partly paid or $0 invoices are untouched.
    // Replay-safe: a second run finds nothing left to mark.
    up({ db }) {
      const cents = (dollars: unknown): number => Math.round((Number(dollars) || 0) * 100);
      const sent = db.prepare(`SELECT id FROM invoices WHERE status = 'sent'`).all() as { id: string }[];
      const linesOf = db.prepare('SELECT qty, unitPrice FROM invoice_lines WHERE invoiceId = ?');
      const paymentsOf = db.prepare(`SELECT amount FROM payments WHERE targetType = 'invoice' AND targetId = ?`);
      const markPaid = db.prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`);
      let marked = 0;
      for (const { id } of sent) {
        const totalCents = (linesOf.all(id) as { qty: number; unitPrice: number }[])
          .reduce((acc, l) => acc + cents((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)), 0);
        if (totalCents <= 0) continue;
        const paidCents = (paymentsOf.all(id) as { amount: number }[]).reduce((acc, p) => acc + cents(p.amount), 0);
        if (paidCents < totalCents) continue;
        markPaid.run(id);
        marked++;
      }
      console.log(`[migrations] 46: ${marked} fully paid invoice(s) marked paid`);
    },
  },
  {
    version: 47,
    name: 'change-order-legacy-lump-sum',
    // DATA-TRANSFORMING (supervised). A change order made before migration 14
    // keeps its value only in change_orders.amount: it has no
    // change_order_lines rows, and its lumpSumAmount is the 0 that migration
    // 14's new column defaulted to (14 deliberately rewrote no data). The
    // Change Orders tab, the editor and the PDF show Σ line cents + lump-sum
    // cents, so such a change order showed $0 there — and saving it from the
    // editor rewrote its amount to $0, dropping it from the contract total —
    // while billingSummary, the AIA SOV sync and Reports, which read amount,
    // still counted it. This moves the value into the lump sum: every change
    // order with no lines, a $0 lump sum and a non-zero amount gets
    // lumpSumAmount = amount, so Σ lines + lump sum equals amount again.
    // Cents compare with the store's rounding (toCents), inlined so a later
    // store change can't alter what this migration did.
    // amount — and so the contract total and any synced SOV line — is what it
    // was, and version stays as it is (no open editor is sent a conflict). A
    // fixed row's updatedAt moves to now, though: a PDF generated for it since
    // migration 14 printed a $0 total, and the fresh stamp makes its "up to
    // date" chip say it needs regenerating. Change orders with lines, with a
    // lump sum, or worth $0 are untouched.
    // billingStore.readChangeOrderRow reads any row still in this shape the
    // same way. Replay-safe: a second run finds nothing left to fix.
    up({ db }) {
      const cents = (dollars: unknown): number => Math.round((Number(dollars) || 0) * 100);
      const lineless = db.prepare(`SELECT id, amount, lumpSumAmount FROM change_orders c
        WHERE NOT EXISTS (SELECT 1 FROM change_order_lines l WHERE l.changeOrderId = c.id)`).all() as
        { id: string; amount: number; lumpSumAmount: number }[];
      const toLumpSum = db.prepare('UPDATE change_orders SET lumpSumAmount = amount, updatedAt = ? WHERE id = ?');
      const now = Date.now();
      let fixed = 0;
      for (const co of lineless) {
        if (cents(co.lumpSumAmount) !== 0 || cents(co.amount) === 0) continue;
        toLumpSum.run(now, co.id);
        fixed++;
      }
      console.log(`[migrations] 47: ${fixed} change order(s) from before line items given their amount as a lump sum`);
    },
  },
  {
    version: 48,
    name: 'mail-trusted-image-senders',
    // Senders whose remote images a user always loads. Per user (not per mail
    // account), keyed by lower-cased address.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_trusted_image_senders (
          userId TEXT NOT NULL,
          addr TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          PRIMARY KEY (userId, addr)
        );
      `);
    },
  },
  {
    version: 49,
    name: 'lien-releases',
    // Florida releases of lien (Fla. Stat. 713.20), docs/superpowers/specs/
    // 2026-10-15-florida-lien-release-design.md §5.2. One row per release, holding
    // a copy of every value printed on it. Additive: no existing data is touched.
    // Money is integer cents; days are 'YYYY-MM-DD' text.
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lien_releases (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number TEXT,
          paymentType TEXT NOT NULL,
          conditional INTEGER NOT NULL,
          sourceType TEXT,
          sourceId TEXT,
          supersedesId TEXT,
          lienorName TEXT NOT NULL,
          customerName TEXT NOT NULL,
          ownerName TEXT NOT NULL,
          propertyDescription TEXT NOT NULL,
          amountCents INTEGER NOT NULL,
          throughDate TEXT,
          releaseDate TEXT NOT NULL,
          signerName TEXT NOT NULL,
          signerTitle TEXT,
          conditionKind TEXT,
          checkNumber TEXT,
          checkMaker TEXT,
          checkBank TEXT,
          exceptions TEXT,
          signatureFileId TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          createdByUserId TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lien_releases_projectId ON lien_releases (projectId);
      `);
    },
  },
  {
    version: 50,
    name: 'lien-release-company-legal',
    // Each lien release keeps its own copy of the lienor's entity type and state
    // of formation (printed in the notary sentence), prefilled from Settings.
    // Additive: two nullable columns.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(lien_releases)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('lienorEntityType')) db.exec(`ALTER TABLE lien_releases ADD COLUMN lienorEntityType TEXT;`);
      if (!cols.includes('lienorState')) db.exec(`ALTER TABLE lien_releases ADD COLUMN lienorState TEXT;`);
    },
  },
];
