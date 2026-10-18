// src/pages/project/billing/PayAppPdfControls.tsx — "Make PDF" for an AIA pay
// app (ONLYOFFICE Phase 4). The G702/G703 stays an Excel workbook; this turns
// it into a PDF through ONLYOFFICE (US number and date formats), stored as the
// pay app's own PDF and pre-attached when the pay app is emailed.
//
// It always makes the PDF from a workbook that matches the pay app: unsaved
// changes are saved first, and a missing or out-of-date workbook is generated
// before converting, exactly as the document bar would.
import React, { useState } from 'react';
import { ExternalLink, FileText } from 'lucide-react';
import { Button } from '../../../components/ui';
import { useToast } from '../../../components/Toast';
import { DocumentStatusChip } from '../../../components/documents/DocumentStatusChip';
import { useDocumentViewer } from '../../../components/documents/useDocumentViewer';
import { isUpToDate, type GeneratedDocState } from '../../../hooks/useGeneratedDocument';
import { getDocumentBySource, getPayApp, makePayAppPdf, persistGeneratedDocument } from '../../../utils/store';

/** Workbooks built before the PDF page setup (landscape, G702 on one page,
 *  change orders on a new page; 2026-09-26) don't carry it, and the PDF is
 *  made from the workbook's own settings: rebuild those once. */
export const WORKBOOK_LAYOUT_SINCE = Date.parse('2026-09-26T14:30:00Z');

export const PayAppPdfControls: React.FC<{
  payAppId: string;
  projectId: string;
  /** The pay app's PDF (kind 'payapp-pdf'), from useGeneratedDocument. */
  pdf: GeneratedDocState;
  dirty: boolean;
  save: () => Promise<boolean>;
  buildWorkbook: () => Promise<Blob>;
  workbookName: string;
  /** Tells the document bar its workbook changed. */
  onWorkbookChanged?: () => void;
}> = ({ payAppId, projectId, pdf, dirty, save, buildWorkbook, workbookName, onWorkbookChanged }) => {
  const { toast } = useToast();
  const viewer = useDocumentViewer();
  const [busy, setBusy] = useState<string | null>(null);

  const make = async () => {
    if (busy) return;
    try {
      if (dirty) {
        setBusy('Saving…');
        if (!(await save())) { toast('Save failed — no PDF made', { type: 'error' }); return; }
      }
      // The workbook must match the saved pay app before it becomes a PDF.
      const saved = await getPayApp(payAppId);
      const workbook = await getDocumentBySource({ sourceType: 'payapp', sourceId: payAppId, kind: 'payapp-export' });
      if (!workbook || !isUpToDate(workbook, saved?.app?.updatedAt) || workbook.createdAt < WORKBOOK_LAYOUT_SINCE) {
        setBusy('Generating Excel…');
        await persistGeneratedDocument(await buildWorkbook(), {
          projectId, kind: 'payapp-export', name: workbookName, sourceType: 'payapp', sourceId: payAppId,
        });
        onWorkbookChanged?.();
      }
      setBusy('Making PDF…');
      const made = await makePayAppPdf(payAppId);
      await pdf.refresh();
      toast(!made.changed ? 'The PDF was already up to date' : made.versionNumber > 1 ? `PDF updated (version ${made.versionNumber})` : 'PDF made', { type: 'success' });
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't make the PDF", { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="payapp-pdf">
      {pdf.file && <DocumentStatusChip file={pdf.file} upToDate={pdf.upToDate} format="pdf" size="sm" />}
      <Button size="sm" variant="secondary" onClick={() => void make()} disabled={!!busy} data-testid="payapp-make-pdf">
        <FileText size={15} />{pdf.file ? 'Update PDF' : 'Make PDF'}
      </Button>
      {pdf.file && (
        <Button size="sm" variant="secondary" onClick={() => viewer.open(pdf.file!, 'payapp-pdf', projectId)} disabled={!!busy} data-testid="payapp-open-pdf">
          <ExternalLink size={15} />Open PDF
        </Button>
      )}
      {busy && <span className="text-xs text-ink-faint">{busy}</span>}
      {viewer.modal}
    </div>
  );
};
