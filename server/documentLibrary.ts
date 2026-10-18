// server/documentLibrary.ts — what new documents are made from, and the
// images people put into them (ONLYOFFICE Phase 3,
// docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md):
//
//   * blank Word, Excel and PDF-form files, bundled with the app
//   * document templates (kind 'document-template'): admins manage them in
//     Settings → Document Templates; everyone can start a document from one
//   * company stamps (kind 'company-stamp'): admins upload, everyone inserts
//   * signatures (kind 'signature'): each person's own, several, one default
//
// All three are ordinary files rows, so versions, backups and the editor work
// on them unchanged. They belong to no project and never show on the
// Documents page (documents.ts ALWAYS_EXCLUDED_KINDS).
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { getMeta, isDirectUploadKind, listVersions, putBuffer, removeFile, type FileMeta } from './files';
import { readFileContent } from './fileStore';
import { editorTitle } from './onlyoffice/editorConfig';
import { isNewDocumentType, officeFormatByExt, officeFormatOf, type NewDocumentType } from '../src/utils/officeFormats';

export const TEMPLATE_KIND = 'document-template';
export const STAMP_KIND = 'company-stamp';
export const SIGNATURE_KIND = 'signature';
export const LIBRARY_KINDS = [TEMPLATE_KIND, STAMP_KIND, SIGNATURE_KIND] as const;

/** Where the person's default signature id is kept (user_preferences). */
const DEFAULT_SIGNATURE_PREF = 'signatures.defaultId';

/** Images ONLYOFFICE can insert (insertImage), by mime. */
export const INSERTABLE_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
};

const blankPath = (type: NewDocumentType) => fileURLToPath(new URL(`./documentLibrary/blank/new.${type}`, import.meta.url));
/** The company letterhead, offered as a one-click starter template. */
export const LETTERHEAD_PATH = fileURLToPath(new URL('../docs/Template.docx', import.meta.url));
export const LETTERHEAD_NAME = 'Letterhead.docx';

/** A refusal the routes turn into an HTTP answer. */
export class LibraryError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'LibraryError';
  }
}

export interface LibraryItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  createdBy: string | null;
}
export interface TemplateItem extends LibraryItem { ext: NewDocumentType }
export interface SignatureItem extends LibraryItem { isDefault: boolean }

const cleanName = (name: unknown, fallback: string): string => {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) : '';
  return s || fallback;
};

const listKind = (db: Database.Database, kind: string, where = '', params: unknown[] = []): LibraryItem[] =>
  (db.prepare(`SELECT id, name, mime, size, createdAt, createdBy FROM files
               WHERE kind = ? AND parentFileId IS NULL ${where} ORDER BY createdAt ASC, id ASC`)
    .all(kind, ...params) as LibraryItem[]).map(r => ({ ...r, name: r.name ?? '', createdBy: r.createdBy == null ? null : String(r.createdBy) }));

/** The live row of a library file of this kind, or null. */
export function libraryFile(db: Database.Database, id: string, kind: string): FileMeta | null {
  const meta = getMeta(db, id);
  return meta && meta.kind === kind && !meta.parentFileId ? meta : null;
}

/** Deletes a library file with every version of it. */
function removeWithVersions(db: Database.Database, dataDir: string, id: string): void {
  for (const v of listVersions(db, id).slice(1)) removeFile(db, dataDir, v.id);
  removeFile(db, dataDir, id);
}

// ── Templates ──────────────────────────────────────────────────────────────

const templateExt = (meta: { mime: string; name: string | null }): NewDocumentType | null => {
  const ext = officeFormatOf(meta)?.ext;
  return isNewDocumentType(ext) ? ext : null;
};

export function listTemplates(db: Database.Database): TemplateItem[] {
  return listKind(db, TEMPLATE_KIND)
    .map(t => ({ ...t, ext: templateExt(t) }))
    .filter((t): t is TemplateItem => t.ext !== null);
}

/** Stores an uploaded template. Only what "New document" makes: Word, Excel
 *  or PDF. */
export function addTemplate(
  db: Database.Database, dataDir: string, bytes: Buffer, input: { name: unknown; mime: string; userId: string },
): TemplateItem {
  const name = cleanName(input.name, 'Template');
  const ext = templateExt({ mime: input.mime, name });
  if (!ext) throw new LibraryError(415, 'A template must be a Word (.docx), Excel (.xlsx) or PDF file.', 'unsupported');
  if (!bytes.length) throw new LibraryError(400, 'The file is empty.', 'empty');
  const id = crypto.randomUUID();
  putBuffer(db, dataDir, id, bytes, officeFormatByExt(ext)!.mime, {
    kind: TEMPLATE_KIND, name: editorTitle(name, ext), createdBy: input.userId,
  });
  return listTemplates(db).find(t => t.id === id)!;
}

/** Adds the company letterhead (docs/Template.docx) as a template, once. */
export function addLetterheadTemplate(db: Database.Database, dataDir: string, userId: string): TemplateItem {
  if (listTemplates(db).some(t => t.name === LETTERHEAD_NAME)) {
    throw new LibraryError(409, 'The letterhead template is already added.', 'exists');
  }
  return addTemplate(db, dataDir, fs.readFileSync(LETTERHEAD_PATH), {
    name: LETTERHEAD_NAME, mime: officeFormatByExt('docx')!.mime, userId,
  });
}

// ── Stamps and signatures (images) ────────────────────────────────────────

const requireImage = (bytes: Buffer, mime: string) => {
  if (!INSERTABLE_IMAGE_TYPES[mime]) throw new LibraryError(415, 'Upload a PNG or JPEG image.', 'unsupported');
  if (!bytes.length) throw new LibraryError(400, 'The image is empty.', 'empty');
};

export const listStamps = (db: Database.Database): LibraryItem[] => listKind(db, STAMP_KIND);

export function addStamp(
  db: Database.Database, dataDir: string, bytes: Buffer, input: { name: unknown; mime: string; userId: string },
): LibraryItem {
  requireImage(bytes, input.mime);
  const id = crypto.randomUUID();
  putBuffer(db, dataDir, id, bytes, input.mime, { kind: STAMP_KIND, name: cleanName(input.name, 'Stamp'), createdBy: input.userId });
  return listStamps(db).find(s => s.id === id)!;
}

/** This person's signatures, oldest first; the default one is flagged (their
 *  chosen one, else the oldest). */
export function listSignatures(db: Database.Database, userId: string): SignatureItem[] {
  const rows = listKind(db, SIGNATURE_KIND, 'AND createdBy = ?', [userId]);
  const chosen = (db.prepare('SELECT value FROM user_preferences WHERE userId = ? AND key = ?')
    .get(userId, DEFAULT_SIGNATURE_PREF) as { value: string } | undefined)?.value;
  const defaultId = rows.some(r => r.id === chosen) ? chosen : rows[0]?.id;
  return rows.map(r => ({ ...r, isDefault: r.id === defaultId }));
}

export function addSignature(
  db: Database.Database, dataDir: string, bytes: Buffer, input: { name: unknown; mime: string; userId: string },
): SignatureItem {
  requireImage(bytes, input.mime);
  const id = crypto.randomUUID();
  const count = listSignatures(db, input.userId).length;
  putBuffer(db, dataDir, id, bytes, input.mime, {
    kind: SIGNATURE_KIND, name: cleanName(input.name, `Signature ${count + 1}`), createdBy: input.userId,
  });
  return listSignatures(db, input.userId).find(s => s.id === id)!;
}

/** A signature the person may change: only their own. */
export function ownSignature(db: Database.Database, id: string, userId: string): FileMeta {
  const meta = libraryFile(db, id, SIGNATURE_KIND);
  if (!meta || String(meta.createdBy) !== String(userId)) throw new LibraryError(404, 'Signature not found', 'not-found');
  return meta;
}

export function setDefaultSignature(db: Database.Database, id: string, userId: string): void {
  ownSignature(db, id, userId);
  db.prepare('INSERT OR REPLACE INTO user_preferences (userId, key, value) VALUES (?, ?, ?)').run(userId, DEFAULT_SIGNATURE_PREF, id);
}

/** When a person is removed, their signatures go with them. */
export function removeUserSignatures(db: Database.Database, dataDir: string, userId: string): void {
  for (const s of listKind(db, SIGNATURE_KIND, 'AND createdBy = ?', [userId])) removeWithVersions(db, dataDir, s.id);
}

// ── Shared by all three ────────────────────────────────────────────────────

/** Renames a template (keeping its extension), stamp or signature. */
export function renameLibraryFile(db: Database.Database, meta: FileMeta, name: unknown): void {
  const ext = meta.kind === TEMPLATE_KIND ? templateExt(meta) : null;
  const next = cleanName(name, '');
  if (!next) throw new LibraryError(400, 'Give it a name.', 'no-name');
  db.prepare('UPDATE files SET name = ? WHERE id = ?').run(ext ? editorTitle(next, ext) : next, meta.id);
}

export function removeLibraryFile(db: Database.Database, dataDir: string, meta: FileMeta): void {
  removeWithVersions(db, dataDir, meta.id);
}

/** Whether this person may read a library file's bytes. Signatures are
 *  personal: only their owner. Everything else follows the usual rules. */
export function mayReadLibraryFile(meta: { kind: string; createdBy: string | null }, user: { id?: unknown } | null | undefined): boolean {
  if (meta.kind !== SIGNATURE_KIND) return true;
  return !!user && meta.createdBy != null && String(meta.createdBy) === String(user.id);
}

// ── New documents ──────────────────────────────────────────────────────────

export interface NewDocumentInput {
  type: unknown;
  templateId?: unknown;
  name?: unknown;
  projectId?: unknown;
  kind?: unknown;
  userId: string;
}

/** Makes a new document from a blank file or a template, filed in a project
 *  (company documents belong to none). Returns the stored file. */
export function createNewDocument(db: Database.Database, dataDir: string, input: NewDocumentInput): FileMeta {
  if (!isNewDocumentType(input.type)) throw new LibraryError(400, 'Pick Word, Excel or PDF form.', 'bad-type');
  const type = input.type;
  const format = officeFormatByExt(type)!;

  const kind = typeof input.kind === 'string' && input.kind ? input.kind : (type === 'xlsx' ? 'spreadsheet' : 'document');
  if (!isDirectUploadKind(kind) || kind === 'photo') throw new LibraryError(400, "That document type can't be used for a new document.", 'bad-kind');

  let projectId: string | null = null;
  let customerId: string | undefined;
  if (kind !== 'company-document') {
    const project = typeof input.projectId === 'string' && input.projectId
      ? db.prepare('SELECT id, customerId FROM projects WHERE id = ?').get(input.projectId) as { id: string; customerId: string | null } | undefined
      : undefined;
    if (!project) throw new LibraryError(400, 'Pick the project this document belongs to.', 'no-project');
    projectId = project.id;
    customerId = project.customerId ?? undefined;
  }

  let bytes: Buffer | null;
  if (typeof input.templateId === 'string' && input.templateId) {
    const template = libraryFile(db, input.templateId, TEMPLATE_KIND);
    if (!template) throw new LibraryError(404, 'That template no longer exists.', 'no-template');
    if (templateExt(template) !== type) throw new LibraryError(400, `That template isn't a ${type} file.`, 'template-type');
    bytes = readFileContent(dataDir, template.id);
  } else {
    bytes = fs.readFileSync(blankPath(type));
  }
  if (!bytes) throw new LibraryError(404, 'That template no longer exists.', 'no-template');

  const id = crypto.randomUUID();
  putBuffer(db, dataDir, id, bytes, format.mime, {
    ...(projectId ? { projectId } : {}),
    ...(customerId ? { customerId } : {}),
    kind,
    name: editorTitle(cleanName(input.name, 'Untitled'), type),
    createdBy: input.userId,
  });
  return getMeta(db, id)!;
}
