// server/shares.ts — public share links (ONLYOFFICE Phase 7: sharing
// upgrades). A share is a read-only link anyone can open without an account.
//
// Kinds (shares.type), and what resourceId holds:
//   'file'      one stored file (any document)            — a file id
//   'printout'  one stored file (older takeoff-print links) — a file id
//   'page'      one plan page's image                      — a file id
//   'pages'     several plan pages, as a gallery           — JSON [{imageId, name, pageNumber}]
//   'files'     several documents under one link          — JSON [fileId, …]
//
// New links expire (7, 30 or 90 days, or never; 30 by default) and can be
// stopped. Links made before expiry existed never expire (the owner,
// 2026-09-25). Every public route asks activeShare() first, so an expired or
// stopped link gets the same friendly answer everywhere.
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getMeta, type FileMeta } from './files';
import { LIBRARY_KINDS } from './documentLibrary';
import { NON_ADMIN_EXCLUDED_KINDS } from './documents';

export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export const DEFAULT_SHARE_DAYS = 30;
const DAY_MS = 86_400_000;
/** One link, one sitting: more than this many files is a folder, not a share. */
export const MAX_SHARED_FILES = 50;

export const SINGLE_FILE_TYPES = ['file', 'printout', 'page'] as const;

export interface ShareRow {
  id: string;
  type: string;
  resourceId: string;
  name: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdBy: string | null;
}

export type ShareProblem = 'missing' | 'expired' | 'revoked';

export class ShareError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** The days asked for: one of the choices, null for never, the default when unsaid. */
export function parseExpiryDays(value: unknown): number | null {
  if (value === undefined) return DEFAULT_SHARE_DAYS;
  if (value === null || value === 'never') return null;
  const n = Number(value);
  if ((SHARE_EXPIRY_DAYS as readonly number[]).includes(n)) return n;
  throw new ShareError('Links last 7, 30 or 90 days, or never expire.');
}

const expiresAtFor = (days: number | null, now: number) => (days === null ? null : now + days * DAY_MS);

export function getShare(db: Database.Database, id: string): ShareRow | null {
  return (db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined) ?? null;
}

/** The share if its link still works; otherwise why not. */
export function activeShare(db: Database.Database, id: string, now = Date.now()): { share: ShareRow } | { problem: ShareProblem } {
  const share = getShare(db, id);
  if (!share) return { problem: 'missing' };
  if (share.revokedAt) return { problem: 'revoked' };
  if (share.expiresAt !== null && share.expiresAt !== undefined && share.expiresAt <= now) return { problem: 'expired' };
  return { share };
}

/** What a public route says when a link doesn't work. */
export const SHARE_PROBLEM_TEXT: Record<ShareProblem, string> = {
  missing: "This link doesn't exist.",
  expired: 'This link has expired.',
  revoked: 'This link was turned off by whoever shared it.',
};
export const shareProblemStatus = (p: ShareProblem) => (p === 'missing' ? 404 : 410);

/** The file ids a share opens, in order (none for a page gallery). */
export function sharedFileIds(share: Pick<ShareRow, 'type' | 'resourceId'>): string[] {
  if (share.type === 'files') {
    try {
      const ids = JSON.parse(share.resourceId);
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }
  // Any other kind is one file, as share links always were (an older link
  // of a kind this list doesn't name keeps working).
  return share.type === 'pages' ? [] : [share.resourceId];
}

/** Whether someone may put a stored file behind a public link: they must be
 *  able to see it, and signatures, templates and stamps are never shared. */
export function mayShareFile(meta: FileMeta | null, user: { role?: string } | undefined): meta is FileMeta {
  if (!meta) return false;
  if ((LIBRARY_KINDS as readonly string[]).includes(meta.kind)) return false;
  if (user?.role !== 'admin' && (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(meta.kind)) return false;
  return true;
}

export interface NewShare {
  type: string;
  /** For 'files': the documents; for the rest, resourceId. */
  fileIds?: string[];
  resourceId?: string;
  name?: string | null;
  expiresInDays?: unknown;
  createdBy?: string | null;
  user?: { role?: string };
}

/** Makes a new link. Always a new one: an old link's expiry is its own. */
export function createShare(db: Database.Database, input: NewShare, now = Date.now()): ShareRow {
  const days = parseExpiryDays(input.expiresInDays);
  const type = String(input.type || '');
  let resourceId: string;
  if (type === 'files') {
    const ids = [...new Set((input.fileIds ?? []).filter((x): x is string => typeof x === 'string' && !!x))];
    if (ids.length === 0) throw new ShareError('Pick at least one document to share.');
    if (ids.length > MAX_SHARED_FILES) throw new ShareError(`Share up to ${MAX_SHARED_FILES} documents in one link.`);
    for (const id of ids) {
      if (!mayShareFile(getMeta(db, id), input.user)) throw new ShareError('One of those documents can’t be shared.', 404);
    }
    resourceId = JSON.stringify(ids);
  } else if ((SINGLE_FILE_TYPES as readonly string[]).includes(type)) {
    resourceId = String(input.resourceId || '');
    if (!mayShareFile(getMeta(db, resourceId), input.user)) throw new ShareError('That document can’t be shared.', 404);
  } else if (type === 'pages') {
    resourceId = String(input.resourceId || '');
    try {
      const pages = JSON.parse(resourceId);
      if (!Array.isArray(pages) || pages.length === 0) throw new Error('empty');
    } catch { throw new ShareError('Pick at least one page to share.'); }
  } else {
    throw new ShareError('Unknown kind of share.');
  }
  const row: ShareRow = {
    id: crypto.randomUUID(), type, resourceId, name: (input.name ?? '').toString().slice(0, 200) || null,
    createdAt: now, expiresAt: expiresAtFor(days, now), revokedAt: null, createdBy: input.createdBy ?? null,
  };
  db.prepare(`INSERT INTO shares (id, type, resourceId, name, createdAt, expiresAt, revokedAt, createdBy)
              VALUES (@id, @type, @resourceId, @name, @createdAt, @expiresAt, @revokedAt, @createdBy)`).run(row);
  return row;
}

/** A new expiry, counted from now. */
export function setShareExpiry(db: Database.Database, id: string, expiresInDays: unknown, now = Date.now()): ShareRow {
  const share = getShare(db, id);
  if (!share || share.revokedAt) throw new ShareError('Link not found', 404);
  const expiresAt = expiresAtFor(parseExpiryDays(expiresInDays), now);
  db.prepare('UPDATE shares SET expiresAt = ? WHERE id = ?').run(expiresAt, id);
  return { ...share, expiresAt };
}

/** "Stop sharing". The row stays, so the link can say it was turned off. */
export function revokeShare(db: Database.Database, id: string, now = Date.now()): boolean {
  return db.prepare('UPDATE shares SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL').run(now, id).changes > 0;
}

export interface ShareListItem {
  id: string;
  type: string;
  name: string | null;
  createdAt: number;
  expiresAt: number | null;
  createdBy: string | null;
  createdByName: string | null;
  /** For a several-files link: how many files it opens. */
  fileCount: number;
}

/** A file's working links: its own, and several-files links it is part of
 *  (only those `visible` allows). */
export function activeSharesForFile(
  db: Database.Database, fileId: string, visible: (share: ShareRow) => boolean = () => true, now = Date.now(),
): ShareListItem[] {
  const rows = db.prepare(`
    SELECT s.*, u.username AS createdByName FROM shares s LEFT JOIN users u ON u.id = s.createdBy
    WHERE s.revokedAt IS NULL AND (s.expiresAt IS NULL OR s.expiresAt > ?)
      AND (s.resourceId = ? OR (s.type = 'files' AND instr(s.resourceId, ?) > 0))
    ORDER BY s.createdAt DESC
  `).all(now, fileId, JSON.stringify(fileId)) as (ShareRow & { createdByName: string | null })[];
  return rows
    .filter(r => sharedFileIds(r).includes(fileId) && visible(r))
    .map(r => ({
      id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, expiresAt: r.expiresAt,
      createdBy: r.createdBy, createdByName: r.createdByName, fileCount: sharedFileIds(r).length,
    }));
}
