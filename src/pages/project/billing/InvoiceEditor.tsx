// src/pages/project/billing/InvoiceEditor.tsx
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Invoice, saveInvoice, getInvoice, getSettings, sendInvoice, InvoiceLine,
  addInvoicePhoto, removeInvoicePhoto, fetchFileBlob,
  addInvoiceAttachment, updateInvoiceAttachment, removeInvoiceAttachment,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { billingDay, formatBillingDate } from '../../../utils/billingDates';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, NumberInput, Table, TBody, TD, TH, THead, TR, Textarea } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { PhotoDropCard } from '../../../components/documents/PhotoDropCard';
import { PdfAttachmentsCard } from '../../../components/documents/PdfAttachmentsCard';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { useItemEmailDefaults } from '../../../hooks/useItemEmailDefaults';
import { itemSendPayload } from '../../../utils/itemSend';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { buildInvoicePdf } from './invoicePdf';
import { LienReleaseLauncher } from './LienReleaseLauncher';
import { appendAttachedPdfs } from '../../../utils/pdfAttachments';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';
import { useDiscardGuard } from '../../../components/ui/useDiscardGuard';

export const lineCents = (l: { description?: string; qty: number; unitPrice: number }): number =>
  Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100);
export const draftTotalCents = (lines: { description?: string; qty: number; unitPrice: number }[]): number =>
  lines.reduce((a, l) => a + lineCents(l), 0);

// Dirty-check key for invoice/change-order line items. Content only: the
// server re-INSERTs the rows on every save (billingStore's writeLines /
// writeChangeOrderLines), so a saved record comes back with brand-new line
// ids — comparing whole objects would leave the editor permanently "dirty"
// and the document bar permanently blocked on "Save first".
export const lineContentKey = (
  lines: { description?: string; qty: number | string; unitPrice: number | string }[],
): string =>
  JSON.stringify(lines.map(l => ({
    description: l.description ?? '',
    qty: Number(l.qty) || 0,
    unitPrice: Number(l.unitPrice) || 0,
  })));

export const InvoiceEditor: React.FC<{
  invoice: Invoice;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  projectId: string;
}> = ({ invoice, onClose, onSaved, projectName, contractor, address, projectId }) => {
  const { toast } = useToast();
  const [number, setNumber] = useState(invoice.number ?? '');
  const [terms, setTerms] = useState(invoice.terms ?? '');
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [date, setDate] = useState(billingDay(invoice.date) ?? '');
  const [lines, setLines] = useState<InvoiceLine[]>(invoice.lines.length ? invoice.lines : []);
  const [saving, setSaving] = useState(false);

  const initialDate = billingDay(invoice.date) ?? '';
  const dirty =
    number !== (invoice.number ?? '') ||
    terms !== (invoice.terms ?? '') ||
    notes !== (invoice.notes ?? '') ||
    date !== initialDate ||
    lineContentKey(lines) !== lineContentKey(invoice.lines);
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({
    type: 'invoice',
    id: invoice.id,
    isDirty: () => dirty,
    onFresh: onSaved,
  });

  // Email defaults: resolved recipient, always-CC, header-email options.
  const emailDefaults = useItemEmailDefaults('invoice', projectId);

  // One name for the stored document and the email attachment — they upsert
  // onto the same document row, so a differing name would flip the stored name
  // depending on which ran last. Keyed off the edited number rather than the
  // loaded one because the bar saves before it generates, so the draft number
  // is the one the document will carry. The id fallback keeps unnumbered
  // drafts from all landing on the same "invoice.pdf".
  const pdfFileName = `Invoice-${number || invoice.id}.pdf`;

  const total = draftTotalCents(lines);
  const paid = invoice.paidCents;
  const balance = total - paid;

  const setLine = (i: number, patch: Partial<InvoiceLine>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(prev => [...prev, { description: '', qty: 1, unitPrice: 0 }]);
  const removeLine = (i: number) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    setSaving(true);
    try {
      await saveInvoice(invoice.id, {
        ...invoice,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        number: number || null,
        terms: terms || null,
        notes: notes || null,
        date: date ? new Date(date).getTime() : null,
        lines: lines.map(l => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0 })),
      });
      toast('Invoice saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Invoice changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
      throw e;
    } finally {
      setSaving(false);
    }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeInvoicePhoto(invoice.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // Built from the SAVED invoice, never the typed-in draft: the bar commits
  // first, so re-reading the record here is what keeps a generated PDF and the
  // invoice it claims to represent from drifting apart. A failed re-read
  // throws on purpose — the bar then reports the failure and keeps the
  // existing document, rather than quietly storing pre-save bytes and marking
  // them current.
  const buildBytes = async (headerEmail?: string): Promise<Uint8Array | ArrayBuffer> => {
    const saved = await getInvoice(invoice.id);
    if (!saved) throw new Error('Invoice not found');
    const settings = await getSettings();
    let logoDataUrl: string | undefined;
    const logoUrl = settings.logoUrl;
    if (logoUrl) {
      if (logoUrl.startsWith('data:')) {
        logoDataUrl = logoUrl;
      } else {
        try {
          const resp = await fetch(logoUrl);
          const blob = await resp.blob();
          logoDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch { /* skip logo on fetch error */ }
      }
    }
    if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
      logoDataUrl = await invertImageDataUrl(logoDataUrl);
    }
    // fetch each photo as a dataURL (authenticated content endpoint)
    const photoDataUrls: string[] = [];
    for (const p of saved.photos) {
      try {
        const blob = await fetchFileBlob(p.fileId);
        photoDataUrls.push(await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); }));
      } catch { /* skip */ }
    }
    const bytes = buildInvoicePdf({
      invoice: saved,
      projectName,
      contractor,
      address,
      letterhead: {
        brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
        company: {
          name: settings.companyName || settings.appName,
          phone: settings.companyPhone,
          email: settings.companyEmail,
          address: settings.companyAddress,
        },
        logoDataUrl,
      },
      photoDataUrls,
      headerEmail: headerEmail || undefined,
    });
    // Attached PDFs go last, after the photo pages, in attachment order.
    return appendAttachedPdfs(bytes, saved.attachments);
  };

  return (
    <Modal open onClose={onClose} dirty={dirty} title={`Invoice ${invoice.number ?? ''}`} width="lg"
      footer={<>
        <div className="mr-auto flex flex-wrap items-center gap-2">
          <DocumentActionsBar
            source={{ sourceType: 'invoice', sourceId: invoice.id }}
            kind="invoice"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={invoice.updatedAt}
            size="sm"
            send={{
              blockedReason: emailDefaults.sendBlockedReason,
              composer: {
                title: 'Send invoice',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `Invoice ${number} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached Invoice ${number} for ${projectName}.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, req) => {
                const result = await sendInvoice(invoice.id, { ...itemSendPayload(req), fileId });
                // The send stamps the invoice 'sent' server-side.
                onSaved({ keepMounted: true });
                return result;
              },
            }}
          />
          <LienReleaseLauncher projectId={projectId} source={{ sourceType: 'invoice', sourceId: invoice.id }} testId="invoice-lien-release" />
        </div>
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save invoice'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Number" htmlFor="inv-num"><Input id="inv-num" value={number} onChange={e => setNumber(e.target.value)} /></Field>
        <Field label="Date" htmlFor="inv-date"><Input id="inv-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Terms" htmlFor="inv-terms"><Input id="inv-terms" value={terms} onChange={e => setTerms(e.target.value)} placeholder="Net 30" /></Field>
      </div>

      <div className="mt-4">
        <Field label="Notes (internal)" htmlFor="inv-notes">
          <Textarea
            id="inv-notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Internal notes — not shown on the invoice PDF"
          />
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Line items</h4>
          <Button variant="ghost" size="sm" onClick={addLine}><Plus size={14} />Add line</Button>
        </div>
        <Table>
          <THead><TR><TH>Description</TH><TH>Qty</TH><TH>Unit price</TH><TH>Amount</TH><TH></TH></TR></THead>
          <TBody>
            {lines.map((l, i) => (
              <TR key={i}>
                <TD><Input value={l.description} onChange={e => setLine(i, { description: e.target.value })} /></TD>
                <TD className="w-20"><NumberInput value={String(l.qty)} onChange={e => setLine(i, { qty: parseFloat(e.target.value) || 0 })} /></TD>
                <TD className="w-28"><NumberInput value={String(l.unitPrice)} onChange={e => setLine(i, { unitPrice: parseFloat(e.target.value) || 0 })} /></TD>
                <TD className="text-ink-soft">{formatMoney(lineCents(l))}</TD>
                <TD><button onClick={() => removeLine(i)} title="Remove" className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <div className="mt-4 flex justify-end gap-6 border-t border-edge pt-3 text-sm">
        <div className="text-right">
          <div className="text-ink-soft">Total <span className="ml-2 font-semibold text-ink">{formatMoney(total)}</span></div>
          <div className="text-ink-soft">Paid <span className="ml-2 font-semibold text-ink">{formatMoney(paid)}</span></div>
          <div className="text-ink-soft">Balance <span className="ml-2 font-semibold text-ink">{formatMoney(balance)}</span></div>
        </div>
      </div>

      {/* Payments — read-only; recording/deleting happens in the project's
          Billing → Payments tab. */}
      <div className="mt-4 border-t border-edge pt-3">
        <h4 className="mb-2 text-sm font-semibold text-ink">Payments</h4>
        {invoice.payments.length === 0 ? (
          <p className="text-sm text-ink-faint">No payments recorded. Record payments in the Billing → Payments tab.</p>
        ) : (
          <Table>
            <THead><TR><TH>Date</TH><TH>Note</TH><TH className="text-right">Amount</TH></TR></THead>
            <TBody>
              {invoice.payments.map(p => (
                <TR key={p.id}>
                  <TD className="text-ink-soft">{formatBillingDate(p.date)}</TD>
                  <TD className="text-ink-faint">{p.note || '—'}</TD>
                  <TD className="text-right tabular-nums text-ink-soft">{formatMoney(Math.round((Number(p.amount) || 0) * 100))}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="mt-2 text-sm text-ink-soft">
          Paid <span className="font-semibold text-ink">{formatMoney(paid)}</span>
          {' · '}
          Balance <span className="font-semibold text-ink">{formatMoney(balance)}</span>
        </p>
        {invoice.payments.length > 0 && (
          <p className="mt-1 text-xs text-ink-faint">Record payments in the Billing → Payments tab.</p>
        )}
      </div>

      <PhotoDropCard
        title="Photos"
        emptyText="No photos. Attach reference shots for the invoice."
        testId="invoice"
        photos={invoice.photos}
        upload={{ kind: 'invoice-photo', projectId, sourceType: 'invoice', sourceId: invoice.id }}
        initialProjectIds={[projectId]}
        link={fileId => addInvoicePhoto(invoice.id, fileId)}
        onRemove={dropPhoto}
        onDone={onSaved}
      />

      <PdfAttachmentsCard
        attachments={invoice.attachments}
        projectId={projectId}
        documentName="invoice"
        testId="invoice"
        link={fileId => addInvoiceAttachment(invoice.id, fileId)}
        update={(fileId, patch) => updateInvoiceAttachment(invoice.id, fileId, patch)}
        remove={fileId => removeInvoiceAttachment(invoice.id, fileId)}
        onChanged={onSaved}
      />
    </Modal>
  );
};
