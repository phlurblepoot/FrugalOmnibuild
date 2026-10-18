// src/pages/documents/openTarget.ts
// Extracted from the retired ProjectDocuments.tsx (spec §Client) — shared
// logic for turning a stored file into either the document editor, a raw
// image view, or a plain download, based on its type.
import { officeFormatOf } from '../../utils/officeFormats';

export const SHEET_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

// Word-processor and presentation files a person uploads are "documents".
const DOCUMENT_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.presentation',
];

// Generic direct-upload kind inferred from a file's mime type. Only relevant
// for direct uploads — program-generated files carry their own canonical
// kind (invoice, issue-report, etc.) instead of this.
export const kindFromMime = (mime: string): string => {
  if (mime === 'application/pdf' || DOCUMENT_MIMES.includes(mime)) return 'document';
  if (SHEET_MIMES.includes(mime) || mime === 'application/vnd.oasis.opendocument.spreadsheet') return 'spreadsheet';
  if (mime.startsWith('image/')) return 'photo';
  return 'other';
};

export type OpenTargetType = 'edit' | 'image' | 'download';

/** Where "Open" takes a file: PDFs, Word, Excel, PowerPoint and the older
 *  formats all open in the ONLYOFFICE document editor (read-only where they
 *  can't be edited); images open raw in a tab; anything else downloads. */
export const openTargetFor = (f: { id: string; mime: string; name?: string | null }): { type: OpenTargetType; url: string | null } => {
  if (officeFormatOf(f)) return { type: 'edit', url: `/tools/edit?fileId=${encodeURIComponent(f.id)}` };
  if (f.mime.startsWith('image/')) return { type: 'image', url: `/api/images/${f.id}/raw` };
  return { type: 'download', url: null };
};
