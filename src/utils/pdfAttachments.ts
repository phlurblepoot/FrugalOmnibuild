// src/utils/pdfAttachments.ts
// The last step of every generator whose record can carry PDF attachments —
// invoices, change orders, RFIs, issues and daily reports (spec
// docs/superpowers/specs/2026-10-06-pdf-attachments-design.md): the record's
// own pages and its photo pages are built first, then each attached PDF's
// pages go on the end, in attachment order. Sending emails the stored
// document, so the attached pages ride along in the email too.
import { fetchFileBlob } from './store';

// Merges PDF attachment bytes onto the end of a generated PDF, in order.
// Mirrors the proposal generator's attachment merge (proposalGenerator.ts).
// An attachment whose bytes can't be parsed as a PDF is skipped (warned, not
// thrown) rather than failing the whole document. With nothing to append the
// base comes back untouched — the generators hand back an ArrayBuffer, so
// either kind of bytes is accepted.
export async function appendPdfAttachments(
  base: Uint8Array | ArrayBuffer, attachments: ArrayBuffer[],
): Promise<Uint8Array | ArrayBuffer> {
  if (!attachments.length) return base;
  const { PDFDocument } = await import('pdf-lib');
  const merged = await PDFDocument.load(base, { ignoreEncryption: true });
  for (const bytes of attachments) {
    try {
      const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
      (await merged.copyPages(d, d.getPageIndices())).forEach(p => merged.addPage(p));
    } catch (e) {
      console.warn('[pdf] skipped unreadable attachment', e);
    }
  }
  return merged.save();
}

// Reads each attached file (authenticated content endpoint) and appends it.
// Pass the attachments of the SAVED record, in the order the server lists
// them (sortOrder). A file that can't be fetched is skipped like one that
// can't be parsed — the document still generates.
export async function appendAttachedPdfs(
  base: Uint8Array | ArrayBuffer, attachments: { fileId: string }[],
): Promise<Uint8Array | ArrayBuffer> {
  if (!attachments.length) return base;
  const buffers: ArrayBuffer[] = [];
  for (const a of attachments) {
    try { buffers.push(await (await fetchFileBlob(a.fileId)).arrayBuffer()); } catch { /* skip unreadable */ }
  }
  return appendPdfAttachments(base, buffers);
}
