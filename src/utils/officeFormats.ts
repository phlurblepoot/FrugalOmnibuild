// src/utils/officeFormats.ts — which stored files open in the ONLYOFFICE
// editor, as what, and whether they can be edited there. Shared by the client
// (what "Open" does for a Documents row) and the server (the editor config),
// so the two can never disagree about a file.
//
// Legacy and interchange formats open read-only for now: ONLYOFFICE can show
// them, but saving them back in their own format is lossy. Phase 4 of the
// ONLYOFFICE project converts them to .docx/.xlsx on upload
// (docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).

/** ONLYOFFICE's `documentType`: which of its editors opens the file. */
export type OfficeDocumentType = 'word' | 'cell' | 'slide' | 'pdf';

export interface OfficeFormat {
  /** ONLYOFFICE's `document.fileType`, and the file extension. */
  ext: string;
  mime: string;
  documentType: OfficeDocumentType;
  editable: boolean;
}

export const OFFICE_FORMATS: readonly OfficeFormat[] = [
  { ext: 'pdf',  mime: 'application/pdf', documentType: 'pdf', editable: true },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', documentType: 'word', editable: true },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', documentType: 'cell', editable: true },
  { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', documentType: 'slide', editable: true },
  { ext: 'doc',  mime: 'application/msword', documentType: 'word', editable: false },
  { ext: 'xls',  mime: 'application/vnd.ms-excel', documentType: 'cell', editable: false },
  { ext: 'ppt',  mime: 'application/vnd.ms-powerpoint', documentType: 'slide', editable: false },
  { ext: 'odt',  mime: 'application/vnd.oasis.opendocument.text', documentType: 'word', editable: false },
  { ext: 'ods',  mime: 'application/vnd.oasis.opendocument.spreadsheet', documentType: 'cell', editable: false },
  { ext: 'odp',  mime: 'application/vnd.oasis.opendocument.presentation', documentType: 'slide', editable: false },
  { ext: 'rtf',  mime: 'application/rtf', documentType: 'word', editable: false },
  { ext: 'csv',  mime: 'text/csv', documentType: 'cell', editable: false },
  { ext: 'txt',  mime: 'text/plain', documentType: 'word', editable: false },
];

// Other spellings browsers and mail clients use for the same formats.
const MIME_ALIASES: Record<string, string> = {
  'text/rtf': 'rtf',
  'application/csv': 'csv',
};

const byExt = new Map(OFFICE_FORMATS.map(f => [f.ext, f]));
const byMime = new Map(OFFICE_FORMATS.map(f => [f.mime, f]));

export const extensionOf = (name: string | null | undefined): string => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name ?? '');
  return m ? m[1].toLowerCase() : '';
};

export const officeFormatByExt = (ext: string | null | undefined): OfficeFormat | null =>
  byExt.get((ext ?? '').toLowerCase()) ?? null;

/** The office format of a stored file, or null when it doesn't open in the
 *  editor. A recognised extension wins over the mime type: Windows browsers
 *  label .csv uploads `application/vnd.ms-excel`, and some uploads arrive as
 *  `application/octet-stream`. Generated documents often have no extension in
 *  their name, so the mime type is the fallback. */
export function officeFormatOf(file: { mime?: string | null; name?: string | null }): OfficeFormat | null {
  const fromExt = officeFormatByExt(extensionOf(file.name));
  if (fromExt) return fromExt;
  const mime = (file.mime ?? '').split(';')[0].trim().toLowerCase();
  return byMime.get(mime) ?? officeFormatByExt(MIME_ALIASES[mime]) ?? null;
}

/** What "New document" can make (decision 2026-09-25: Word, Excel and PDF
 *  form; no PowerPoint). Shared by the dialog and POST /api/documents/new. */
export const NEW_DOCUMENT_TYPES = [
  { ext: 'docx', label: 'Word document', short: 'Word' },
  { ext: 'xlsx', label: 'Excel spreadsheet', short: 'Excel' },
  { ext: 'pdf', label: 'PDF form', short: 'PDF form' },
] as const;
export type NewDocumentType = (typeof NEW_DOCUMENT_TYPES)[number]['ext'];
export const isNewDocumentType = (v: unknown): v is NewDocumentType =>
  NEW_DOCUMENT_TYPES.some(t => t.ext === v);

// ── Converted on upload (ONLYOFFICE Phase 4) ────────────────────────────────
// Old and unusual formats become .docx/.xlsx/.pptx when uploaded, the upload
// kept as version 1. Shared: the server converts, the browser lets these be
// picked where only editor files are allowed.
export type ConversionTarget = 'docx' | 'xlsx' | 'pptx';

// ONLYOFFICE's conversion tables, less what the app already handles as is
// (PDF, plain text, CSV, HTML, e-books) and the modern formats themselves.
const TO_DOCX = ['doc', 'docm', 'dot', 'dotm', 'dotx', 'fodt', 'odt', 'ott', 'pages', 'rtf', 'stw', 'sxw', 'wps', 'wpt', 'hwp', 'hwpx'];
const TO_XLSX = ['et', 'ett', 'fods', 'numbers', 'ods', 'ots', 'sxc', 'xls', 'xlsb', 'xlsm', 'xlt', 'xltm', 'xltx'];
const TO_PPTX = ['dps', 'dpt', 'fodp', 'key', 'odp', 'otp', 'pot', 'potm', 'potx', 'pps', 'ppsm', 'ppsx', 'ppt', 'pptm', 'sxi'];
/** Every extension converted on upload, for file pickers. */
export const CONVERTIBLE_EXTENSIONS: readonly string[] = [...TO_DOCX, ...TO_XLSX, ...TO_PPTX];
const UPLOAD_CONVERSIONS: Record<string, ConversionTarget> = Object.fromEntries([
  ...TO_DOCX.map(e => [e, 'docx'] as const),
  ...TO_XLSX.map(e => [e, 'xlsx'] as const),
  ...TO_PPTX.map(e => [e, 'pptx'] as const),
]);

/** What an uploaded file would be converted to, judged by its name (browsers
 *  send all sorts of types for Pages or Numbers files, or none). */
export function uploadConversionTarget(name: string | null): { from: string; to: ConversionTarget } | null {
  const from = extensionOf(name);
  const to = UPLOAD_CONVERSIONS[from];
  return to ? { from, to } : null;
}

