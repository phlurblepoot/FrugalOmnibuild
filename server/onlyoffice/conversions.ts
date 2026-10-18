// server/onlyoffice/conversions.ts — the Document Server's conversion service,
// put to work (ONLYOFFICE Phase 4):
//
//   * Old or unusual formats are converted on upload (decision 2026-09-25):
//     .doc, .rtf, .odt, Pages… → .docx; .xls, .ods, Numbers… → .xlsx; .ppt,
//     .odp, Keynote… → .pptx. The upload is stored first, exactly as it came;
//     the converted file becomes version 2 with the extension updated, so the
//     original is always one click away. If conversion fails the original
//     stays as it is and the uploader is told why.
//   * An AIA pay app's workbook becomes a PDF ("Make PDF"), stored as the pay
//     app's own PDF document.
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getMeta, putBuffer, saveNewVersion, type FileMeta } from '../files';
import { extensionOf, officeFormatByExt, uploadConversionTarget } from '../../src/utils/officeFormats';
import { readOnlyofficeConfig } from './config';
import type { LinkTokens } from './tokens';
import { fileLink } from './links';
import { OnlyofficeError, convert, downloadFromOnlyoffice } from './client';

export { uploadConversionTarget };

export type UploadConversion =
  | { status: 'converted'; from: string; to: string; name: string }
  | { status: 'failed'; from: string; to: string; message: string };

/** ONLYOFFICE keys allow 0-9 a-z A-Z - . _ = and 128 characters. Keyed by the
 *  content, so the same bytes convert once and ONLYOFFICE's cache is reused. */
const conversionKey = (prefix: string, sha256: string, to: string) => `${prefix}-${sha256.slice(0, 40)}-${to}`;

export interface ConversionDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
  dataDir: string;
  tokens: LinkTokens;
  fetch: typeof fetch;
  /** How long one conversion may take before giving up. */
  timeoutMs?: number;
}

export class Conversions {
  constructor(private readonly deps: ConversionDeps) {}

  /** Converts a freshly uploaded file if its format calls for it. Null when
   *  nothing needed converting. Never throws: a failure is reported, and the
   *  upload stays exactly as it came. */
  async convertUpload(fileId: string, userId: string | null): Promise<UploadConversion | null> {
    const meta = getMeta(this.deps.db, fileId);
    const target = meta && !meta.parentFileId ? uploadConversionTarget(meta.name) : null;
    if (!meta || !target) return null;
    const { config: cfg } = readOnlyofficeConfig(this.deps.env);
    if (!cfg) {
      return { status: 'failed', ...target, message: `Kept as .${target.from}: the document editor isn't set up to convert it to .${target.to}.` };
    }
    try {
      const result = await convert(cfg, this.deps.fetch, {
        filetype: target.from, outputtype: target.to,
        key: conversionKey('conv', meta.sha256, target.to),
        title: meta.name ?? `file.${target.from}`,
        url: fileLink(cfg, this.deps.tokens, meta.id),
      }, this.deps.timeoutMs ?? 120_000);
      const bytes = await downloadFromOnlyoffice(cfg, this.deps.fetch, result.fileUrl);
      const live = getMeta(this.deps.db, fileId);
      if (!live) return null; // deleted meanwhile
      saveNewVersion(this.deps.db, this.deps.dataDir, fileId, bytes, officeFormatByExt(target.to)!.mime, userId, 'convert');
      const name = `${(live.name ?? 'file').slice(0, -target.from.length)}${target.to}`;
      this.deps.db.prepare('UPDATE files SET name = ? WHERE id = ?').run(name, fileId);
      return { status: 'converted', ...target, name };
    } catch (e) {
      const why = e instanceof OnlyofficeError ? e.message : 'Unexpected error converting the file.';
      console.warn(`[onlyoffice] converting ${fileId} (.${target.from} → .${target.to}) failed:`, why);
      return { status: 'failed', ...target, message: `Kept as .${target.from}: ${why}` };
    }
  }

  /** A PDF of a workbook, stored as a generated document of the same record
   *  (e.g. a pay app's G702/G703 → its PDF). Regenerating makes a new version
   *  of that PDF, like any generated document. Throws OnlyofficeError. */
  async workbookToPdf(
    workbook: FileMeta, target: { kind: string; sourceType: string; sourceId: string; userId: string | null },
  ): Promise<{ file: FileMeta; changed: boolean }> {
    const { config: cfg } = readOnlyofficeConfig(this.deps.env);
    if (!cfg) throw new OnlyofficeError('failed', "The document editor isn't set up, so it can't make PDFs.");
    const from = extensionOf(workbook.name) || 'xlsx';
    const result = await convert(cfg, this.deps.fetch, {
      filetype: from, outputtype: 'pdf',
      key: conversionKey('pdf', workbook.sha256, 'pdf'),
      title: workbook.name ?? 'workbook.xlsx',
      url: fileLink(cfg, this.deps.tokens, workbook.id),
      // Money and dates the US way.
      region: 'en-US',
      // Any spreadsheetLayout makes ONLYOFFICE print every sheet (without one
      // it prints only the active sheet: the G702 without its G703). Landscape
      // throughout; each sheet's own fit-to-page and page breaks still apply,
      // since neither fit nor scale is set here (sdkjs asc_nativePrint).
      spreadsheetLayout: { orientation: 'landscape', ignorePrintArea: false },
    }, this.deps.timeoutMs ?? 120_000);
    const bytes = await downloadFromOnlyoffice(cfg, this.deps.fetch, result.fileUrl);
    // Asked again with nothing changed: the same PDF, not a duplicate version.
    const existing = this.deps.db.prepare(
      'SELECT id FROM files WHERE parentFileId IS NULL AND sourceType = ? AND sourceId = ? AND kind = ?',
    ).get(target.sourceType, target.sourceId, target.kind) as { id: string } | undefined;
    const current = existing ? getMeta(this.deps.db, existing.id) : null;
    if (current && current.sha256 === crypto.createHash('sha256').update(bytes).digest('hex')) return { file: current, changed: false };
    const name = `${(workbook.name ?? 'workbook').replace(/\.[A-Za-z0-9]+$/, '')}.pdf`;
    const stored = putBuffer(this.deps.db, this.deps.dataDir, crypto.randomUUID(), bytes, 'application/pdf', {
      ...(workbook.projectId ? { projectId: workbook.projectId } : {}),
      ...(workbook.customerId ? { customerId: workbook.customerId } : {}),
      kind: target.kind, sourceType: target.sourceType, sourceId: target.sourceId,
      name, ...(target.userId ? { createdBy: target.userId } : {}),
    });
    return { file: getMeta(this.deps.db, stored.id)!, changed: true };
  }
}
