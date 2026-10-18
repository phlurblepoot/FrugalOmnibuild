// src/utils/uploadConversion.ts — telling the uploader what happened to old
// formats (ONLYOFFICE Phase 4): the server converts .doc, .xls, Pages and the
// like on upload, keeping the original as version 1, or keeps the file as it
// came when it can't.
import type { UploadConversion } from './store';

type Toast = (message: string, opts?: { type?: 'success' | 'error' | 'warning' | 'info' }) => void;

/** One notice for everything converted, and one per file that couldn't be. */
export function reportConversions(toast: Toast, uploads: { name: string; conversion?: UploadConversion }[]): void {
  const converted = uploads.filter(u => u.conversion?.status === 'converted');
  if (converted.length === 1) {
    const c = converted[0].conversion as Extract<UploadConversion, { status: 'converted' }>;
    toast(`"${converted[0].name}" was converted to .${c.to} so it can be edited. The original is kept as version 1.`, { type: 'info' });
  } else if (converted.length > 1) {
    toast(`${converted.length} files were converted to .docx, .xlsx or .pptx so they can be edited. Each original is kept as version 1.`, { type: 'info' });
  }
  for (const u of uploads) {
    if (u.conversion?.status === 'failed') toast(`"${u.name}": ${u.conversion.message}`, { type: 'warning' });
  }
}
