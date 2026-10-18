import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { writeFileContent, readFileContent, deleteFileContent } from './fileStore';

// Matches the legacy dataURL format used everywhere in the old images table.
// Keep in sync with the regex previously at server.ts:608. The `s` flag
// deliberately differs from the legacy regex: a newline inside the payload
// would match here. Harmless for real data, all of which is canonical base64.
export const DATA_URL_RE = /^data:([A-Za-z0-9.+\/-]+)(?:;[^;,]+)*;base64,(.+)$/s;

// Parses a legacy stored string. legacyFormat is 'dataurl' when the prefix is
// exactly `data:<mime>;base64,`, 'base64' for bare-base64 strings, or the
// verbatim prefix (e.g. 'data:text/plain;charset=utf-8;base64,') when the
// dataURL carried extra parameters — getDataUrlString replays it byte-identically.
export function parseDataUrl(data: string): { mime: string; legacyFormat: string; buf: Buffer } {
  const m = data.match(DATA_URL_RE);
  if (!m) return { mime: 'application/octet-stream', legacyFormat: 'base64', buf: Buffer.from(data, 'base64') };
  const mime = m[1];
  const prefix = data.slice(0, data.length - m[2].length); // everything before the b64 payload
  const canonical = `data:${mime};base64,`;
  return { mime, legacyFormat: prefix === canonical ? 'dataurl' : prefix, buf: Buffer.from(m[2], 'base64') };
}

export interface FileMeta {
  id: string;
  projectId: string | null;
  name: string | null;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  parentFileId: string | null;
  versionNumber: number;
  legacyFormat: string | null; // 'dataurl' | 'base64' | verbatim non-canonical prefix | null
  createdAt: number;
  customerId: string | null;
  // Owning entity: invoice|payapp|payment|change-order|issue|punch|rfi|task|
  // proposal|printout|plan-set + its id. Null on loose uploads and legacy rows.
  sourceType: string | null;
  sourceId: string | null;
  archived: number; // 0 | 1 — soft hide on the Documents page
  // Who produced this version: an upload, a generate or an editor save
  // (migration 37). Null for history from before then and for writes with no
  // signed-in user behind them (mail sync, migrations).
  createdBy: string | null;
  // How this version's bytes came to be (migration 38): 'editor' for an
  // ONLYOFFICE save, 'restore' for a restored older version, 'convert' for an
  // old format converted on upload, null for an upload or a generate.
  versionOrigin: string | null;
}

// Canonical document kinds (spec 2026-08-17 §Data model). System kinds are
// written by the program; users can never re-type a file into or out of one.
export const SYSTEM_KINDS = [
  'plan-source', 'plan', 'proposal', 'proposal-photo', 'proposal-signed', 'printout',
  'takeoff-print', 'takeoff-export',
  'invoice', 'invoice-photo', 'change-order', 'change-order-photo', 'lien-release', 'issue-report',
  'issue-photo', 'punch-report', 'punch-photo', 'rfi', 'rfi-photo',
  'rfi-response', 'task-photo', 'payapp-export', 'email-attachment',
  'settings-asset', 'daily-report', 'daily-report-photo', 'payapp-pdf',
  // A photo or PDF uploaded onto a payment (migration 43): a check image, a
  // receipt, remittance advice. Admin-only, like the rest of billing.
  'payment-attachment',
  // The document library (server/documentLibrary.ts, ONLYOFFICE Phase 3).
  'document-template', 'company-stamp', 'signature',
] as const;

// Kinds an entity legitimately holds MANY of: one issue has a dozen photos,
// all sharing the same (sourceType, sourceId, kind) triple. They are excluded
// from upsert-by-source — otherwise the second photo would silently overwrite
// the first as a "new version" of it (spec 2026-08-17, second amendment).
// `plan-source` belongs here for the same reason and with sharper teeth: a
// plan set is routinely built from several uploaded PDFs, and versioning one
// onto another would keep the live id — so the pages split out of the FIRST
// pdf would start rendering the second.
export const MULTI_INSTANCE_KINDS = [
  'issue-photo', 'punch-photo', 'task-photo', 'change-order-photo', 'invoice-photo',
  'rfi-photo', 'proposal-photo', 'plan-source', 'daily-report-photo',
  'payment-attachment',
  // Several attachments saved from one email message share a source triple
  // (sourceType='mailMessage', sourceId=<messageId>) — spec §3.2. The kind
  // alone only covers the default; CONTAINER_SOURCE_TYPES below is what makes
  // a user-picked kind ('document', 'photo', custom:*) behave the same way.
  'email-attachment',
] as const;

// Kinds a person can pick in the upload popup — the only ones a file may be
// re-typed to, and the only ones that are ever really deletable.
export const DIRECT_UPLOAD_KINDS = ['document', 'spreadsheet', 'photo', 'other', 'company-document'] as const;

// Admin-defined types are stored as `custom:<id>` and behave like uploads.
export function isDirectUploadKind(kind: string): boolean {
  return (DIRECT_UPLOAD_KINDS as readonly string[]).includes(kind) || kind.startsWith('custom:');
}

export interface PutOpts {
  projectId?: string;
  kind?: string;
  name?: string;
  customerId?: string;
  // The entity this file belongs to. With a kind, the pair identifies ONE
  // stable document — see the upsert-by-source note on `store` below.
  sourceType?: string;
  sourceId?: string;
  // The signed-in user producing these bytes (FileMeta.createdBy).
  createdBy?: string;
}

export type VersionOrigin = 'editor' | 'restore' | 'convert';

// files.createdBy (migration 37) and files.versionOrigin (38) arrive late, but
// older migrations (e.g. images-to-disk) write files through this module
// before they exist. Only a positive answer is cached: a column appears
// mid-run, when its migration applies.
const knownColumns = new WeakMap<Database.Database, Set<string>>();
function hasFileColumn(db: Database.Database, name: 'createdBy' | 'versionOrigin'): boolean {
  if (knownColumns.get(db)?.has(name)) return true;
  const cols = db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
  if (!cols.some(c => c.name === name)) return false;
  if (!knownColumns.has(db)) knownColumns.set(db, new Set());
  knownColumns.get(db)!.add(name);
  return true;
}
const hasCreatedBy = (db: Database.Database) => hasFileColumn(db, 'createdBy');

/** Stamps who produced the live bytes, and how, after a write. */
function stampVersion(db: Database.Database, id: string, createdBy: string | null | undefined, origin: VersionOrigin | null | undefined): void {
  if (hasCreatedBy(db)) db.prepare('UPDATE files SET createdBy = ? WHERE id = ?').run(createdBy ?? null, id);
  if (hasFileColumn(db, 'versionOrigin')) db.prepare('UPDATE files SET versionOrigin = ? WHERE id = ?').run(origin ?? null, id);
}

// A put either created/overwrote the requested id, or landed as a new version
// of the document that already stood for this source (in which case `id` is
// that document's id, not the one the caller asked for).
export type PutResult = FileMeta & { versioned: boolean };

function upsertRow(
  db: Database.Database,
  id: string,
  mime: string,
  size: number,
  sha256: string,
  legacyFormat: string | null,
  opts: PutOpts
): void {
  // INSERT OR REPLACE resets unlisted columns to defaults, so carry over
  // every column we don't intend to change.
  const withCreatedBy = hasCreatedBy(db);
  const existing = db
    .prepare(`SELECT projectId, kind, name, parentFileId, versionNumber, createdAt,
                     customerId, sourceType, sourceId, archived${withCreatedBy ? ', createdBy' : ''} FROM files WHERE id = ?`)
    .get(id) as
    | {
        projectId: string | null;
        kind: string;
        name: string | null;
        parentFileId: string | null;
        versionNumber: number;
        createdAt: number;
        customerId: string | null;
        sourceType: string | null;
        sourceId: string | null;
        archived: number;
        createdBy?: string | null;
      }
    | undefined;
  const values: unknown[] = [
    id,
    opts.projectId ?? existing?.projectId ?? null,
    opts.name ?? existing?.name ?? null,
    mime,
    size,
    sha256,
    opts.kind ?? existing?.kind ?? 'other',
    existing?.parentFileId ?? null,
    existing?.versionNumber ?? 1,
    legacyFormat,
    existing?.createdAt ?? Date.now(),
    opts.customerId ?? existing?.customerId ?? null,
    opts.sourceType ?? existing?.sourceType ?? null,
    opts.sourceId ?? existing?.sourceId ?? null,
    existing?.archived ?? 0,
  ];
  if (withCreatedBy) values.push(opts.createdBy ?? existing?.createdBy ?? null);
  // New bytes are an upload or a generate unless a caller stamps otherwise
  // afterwards (stampVersion), so versionOrigin is never carried over.
  const withOrigin = hasFileColumn(db, 'versionOrigin');
  db.prepare(`
    INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt, customerId, sourceType, sourceId, archived${withCreatedBy ? ', createdBy' : ''}${withOrigin ? ', versionOrigin' : ''})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${withCreatedBy ? ', ?' : ''}${withOrigin ? ', NULL' : ''})
  `).run(...values);
}

// Source types whose id is a CONTAINER of peer documents rather than the
// identity of one document. An email message holds many attachments, and a
// person saving them picks a type for each ("document", "photo", a custom
// type) — so several of them legitimately share the whole
// (sourceType, sourceId, kind) triple without being versions of each other.
// The link exists for provenance ("this came out of that email"), never for
// identity, so these never upsert-by-source no matter which kind was picked.
// Contrast an invoice, whose (invoice, <id>, 'invoice') triple names exactly
// one document that regenerating should version.
// Exported (with isContainerSourceType) for server/documents.ts's delete
// guard: a document under a container source is a COPY of something the
// container still holds, so deleting it here loses nothing.
export const CONTAINER_SOURCE_TYPES = ['mailMessage'] as const;

export function isContainerSourceType(sourceType: string | null | undefined): boolean {
  return !!sourceType && (CONTAINER_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

// The live document standing for (sourceType, sourceId, kind), if any. Only
// live rows qualify: version history hangs off a parentFileId and must never
// be picked up as an upsert target. Multi-instance kinds never match — an
// entity's second photo is another photo, not a new version of the first.
function findLiveBySource(db: Database.Database, opts: PutOpts): string | null {
  if (!opts.sourceType || !opts.sourceId || !opts.kind) return null;
  if (isContainerSourceType(opts.sourceType)) return null;
  if ((MULTI_INSTANCE_KINDS as readonly string[]).includes(opts.kind)) return null;
  const row = db.prepare(`
    SELECT id FROM files
    WHERE parentFileId IS NULL AND sourceType = ? AND sourceId = ? AND kind = ?
    ORDER BY createdAt ASC, id ASC LIMIT 1
  `).get(opts.sourceType, opts.sourceId, opts.kind) as { id: string } | undefined;
  return row?.id ?? null;
}

// Older migration paths (e.g. images-to-disk, which runs before migration 7
// creates `drafts`) can reach the store/version path pre-drafts-table.
function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

// Upsert-by-source (spec 2026-08-17 §Data model): a generate/download flow
// uploads with the owning entity's source metadata every time, minting a fresh
// id client-side. When that source already has a live document of the same
// kind, the bytes become a new VERSION of it rather than a second row — so
// regenerating an invoice never clutters the Documents page. Without a full
// sourceType+sourceId+kind triple this is an ordinary create/overwrite.
function store(
  db: Database.Database,
  dataDir: string,
  id: string,
  buf: Buffer,
  mime: string,
  legacyFormat: string | null,
  opts: PutOpts
): PutResult {
  const existingId = findLiveBySource(db, opts);
  if (existingId) {
    // Always a new version, never an overwrite (ONLYOFFICE decision
    // 2026-09-25): older versions are deleted one by one if unwanted.
    saveNewVersion(db, dataDir, existingId, buf, mime, opts.createdBy);
    // saveNewVersion re-enters putBuffer with no opts, which stamps the
    // dataURL format and keeps the old labels. Replay the caller's actual
    // format (so getDataUrlString still round-trips) and take whichever
    // descriptive fields this regenerate carried — kind and source are equal
    // by construction, so nothing about the document's identity moves.
    // Regenerating a document is also an act of using it: un-archive.
    const sets = ['legacyFormat = ?', 'archived = 0'];
    const vals: unknown[] = [legacyFormat];
    if (opts.name) { sets.push('name = ?'); vals.push(opts.name); }
    if (opts.projectId) { sets.push('projectId = ?'); vals.push(opts.projectId); }
    if (opts.customerId) { sets.push('customerId = ?'); vals.push(opts.customerId); }
    db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...vals, existingId);
    // A regenerate invalidates any
    // in-progress editor draft for the old bytes; keeping it around would let
    // a stale PDF-editor draft silently resurrect content the regenerate just
    // replaced. drafts (migration 7) postdates files, so older migration
    // paths that call putBuffer before it exists (e.g. images-to-disk) must
    // not explode on this.
    if (tableExists(db, 'drafts')) {
      db.prepare('DELETE FROM drafts WHERE fileId = ?').run(existingId);
    }
    return { ...getMeta(db, existingId)!, versioned: true };
  }
  const { size, sha256 } = writeFileContent(dataDir, id, buf);
  upsertRow(db, id, mime, size, sha256, legacyFormat, opts);
  return { ...getMeta(db, id)!, versioned: false };
}

// Stores a legacy dataURL string (the only format the old /api/images wrote).
// Non-dataURL strings are treated as bare base64 — getDataUrlString restores
// the original string shape either way.
export function putDataUrl(db: Database.Database, dataDir: string, id: string, data: string, opts: PutOpts = {}): PutResult {
  const { mime, legacyFormat, buf } = parseDataUrl(data);
  return store(db, dataDir, id, buf, mime, legacyFormat, opts);
}

export function putBuffer(db: Database.Database, dataDir: string, id: string, buf: Buffer, mime: string, opts: PutOpts = {}): PutResult {
  // Raw uploads were converted to dataURLs by the old code, so reads expect
  // a dataURL back — mark accordingly.
  return store(db, dataDir, id, buf, mime || 'application/octet-stream', 'dataurl', opts);
}

// Archive/re-type a document. Deliberately policy-free — which kinds may be
// re-typed and who may archive is enforced at the route. Version rows are left
// alone: they are only ever reached through their live row.
export function setFileFlags(
  db: Database.Database,
  id: string,
  flags: { archived?: boolean; kind?: string }
): FileMeta | null {
  if (!getMeta(db, id)) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (flags.archived !== undefined) { sets.push('archived = ?'); vals.push(flags.archived ? 1 : 0); }
  if (flags.kind !== undefined) { sets.push('kind = ?'); vals.push(flags.kind); }
  if (sets.length) db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getMeta(db, id);
}

export function getMeta(db: Database.Database, id: string): FileMeta | null {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileMeta | undefined;
  return row ?? null;
}

// Reconstructs the exact string the legacy images.data column held.
export function getDataUrlString(db: Database.Database, dataDir: string, id: string): string | null {
  const meta = getMeta(db, id);
  if (!meta) return null;
  const buf = readFileContent(dataDir, id);
  if (!buf) return null;
  const b64 = buf.toString('base64');
  if (meta.legacyFormat === 'base64') return b64;
  if (meta.legacyFormat && meta.legacyFormat !== 'dataurl') return meta.legacyFormat + b64; // verbatim prefix replay
  return `data:${meta.mime};base64,${b64}`;
}

export function removeFile(db: Database.Database, dataDir: string, id: string): void {
  // The editor's change log for this version goes with it (migration 38). A
  // live row takes every version's log; an archived row just its own.
  if (tableExists(db, 'editor_changes')) {
    const row = getMeta(db, id);
    if (row?.parentFileId) {
      db.prepare('DELETE FROM editor_changes WHERE fileId = ? AND versionNumber = ?').run(row.parentFileId, row.versionNumber);
    } else if (row) {
      db.prepare('DELETE FROM editor_changes WHERE fileId = ?').run(id);
    }
  }
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  deleteFileContent(dataDir, id);
}

// Archive-then-overwrite versioning (spec §3.2). The LIVE content always
// keeps its original id so every reference (printouts, proposals, share
// links) stays valid. Each save first snapshots the current content into a
// new row pointing at the original, then overwrites the live row in place.
// Disk writes are not transactional with the DB; a crash can at worst leave
// an unreferenced archived row — reclaimable via explicit orphan cleanup.
export function saveNewVersion(
  db: Database.Database,
  dataDir: string,
  id: string,
  buf: Buffer,
  mime: string,
  // Who produced the NEW bytes, and how. The archived row keeps the old
  // version's author and origin.
  createdBy?: string | null,
  origin?: VersionOrigin | null
): { archivedVersionId: string; versionNumber: number } {
  const live = getMeta(db, id);
  if (!live) throw new Error(`Cannot version unknown file ${id}`);
  const stampAuthor = () => stampVersion(db, id, createdBy, origin);

  const archivedVersionId = crypto.randomUUID();
  const oldContent = readFileContent(dataDir, id);
  if (!oldContent) {
    console.warn(`[files] versioning ${id} with no on-disk content — version history will have a gap`);
  } else {
    // archived bytes to disk before the tx (idempotent; leak-only on rollback)
    const { size, sha256 } = writeFileContent(dataDir, archivedVersionId, oldContent);
    const versionNumber = live.versionNumber + 1;
    const tx = db.transaction(() => {
      // The archived row deliberately carries no source metadata: the source
      // points at the LIVE document, and leaving these NULL keeps history out
      // of every source-keyed lookup (upsert-by-source, /api/documents).
      db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        // createdAt: when these bytes were produced, not when they were archived.
        archivedVersionId, live.projectId, live.name, live.mime, size, sha256, live.kind, id, live.versionNumber, live.legacyFormat, live.createdAt
      );
      stampVersion(db, archivedVersionId, live.createdBy, (live.versionOrigin as VersionOrigin | null) ?? null);
      putBuffer(db, dataDir, id, buf, mime); // disk write is non-tx but idempotent; row upsert is in-tx
      // putBuffer -> upsertRow carries the OLD createdAt forward (it only
      // defaults createdAt for brand-new rows), so a versioned save must
      // refresh it explicitly — otherwise the live row's createdAt would
      // never move past its original creation time, breaking anything that
      // reads createdAt as "when was this document last produced".
      db.prepare('UPDATE files SET versionNumber = ?, createdAt = ? WHERE id = ?').run(versionNumber, Date.now(), id);
      stampAuthor();
    });
    tx();
    return { archivedVersionId, versionNumber };
  }
  // no old content: just overwrite + bump (still atomic for the two DB writes)
  const versionNumber = live.versionNumber + 1;
  const tx = db.transaction(() => {
    putBuffer(db, dataDir, id, buf, mime);
    db.prepare('UPDATE files SET versionNumber = ?, createdAt = ? WHERE id = ?').run(versionNumber, Date.now(), id);
    stampAuthor();
  });
  tx();
  return { archivedVersionId, versionNumber };
}

// Replaces the live bytes in place: same id, same versionNumber, history
// untouched. For a later save in an editing session whose first save already
// archived the pre-session bytes (ONLYOFFICE one-version-per-session rule).
// Every archived version is kept.
export function replaceLiveContent(
  db: Database.Database, dataDir: string, id: string, buf: Buffer, mime: string,
  createdBy?: string | null, origin?: VersionOrigin | null,
): FileMeta {
  if (!getMeta(db, id)) throw new Error(`Cannot replace unknown file ${id}`);
  const { size, sha256 } = writeFileContent(dataDir, id, buf); // atomic rename over the same path
  db.prepare(`UPDATE files SET mime = ?, size = ?, sha256 = ?, legacyFormat = 'dataurl', createdAt = ? WHERE id = ?`)
    .run(mime, size, sha256, Date.now(), id);
  stampVersion(db, id, createdBy, origin);
  return getMeta(db, id)!;
}

// Live row first, then archived history newest-first.
export function listVersions(db: Database.Database, id: string): FileMeta[] {
  const live = getMeta(db, id);
  if (!live) return [];
  const history = db.prepare(
    'SELECT * FROM files WHERE parentFileId = ? ORDER BY versionNumber DESC'
  ).all(id) as FileMeta[];
  return [live, ...history];
}
