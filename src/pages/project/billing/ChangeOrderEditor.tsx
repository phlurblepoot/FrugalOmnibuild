// src/pages/project/billing/ChangeOrderEditor.tsx
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  ChangeOrder, ChangeOrderLine,
  saveChangeOrder, getChangeOrder, setChangeOrderStatus, getSettings, sendChangeOrder,
  addCOPhoto, removeCOPhoto, fetchFileBlob,
  addCOAttachment, updateCOAttachment, removeCOAttachment,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { billingDay } from '../../../utils/billingDates';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, NumberInput, Textarea, Table, TBody, TD, TH, THead, TR } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { PhotoDropCard } from '../../../components/documents/PhotoDropCard';
import { PdfAttachmentsCard } from '../../../components/documents/PdfAttachmentsCard';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { useItemEmailDefaults } from '../../../hooks/useItemEmailDefaults';
import { itemSendPayload } from '../../../utils/itemSend';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { ChangeOrderStatusPill } from '../../../components/ui/BillingPills';
import { buildChangeOrderPdf } from './changeOrderPdf';
import { appendAttachedPdfs } from '../../../utils/pdfAttachments';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';
import { lineCents, draftTotalCents, lineContentKey } from './InvoiceEditor';
import { useDiscardGuard } from '../../../components/ui/useDiscardGuard';

export const ChangeOrderEditor: React.FC<{
  changeOrder: ChangeOrder;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  projectId: string;
}> = ({ changeOrder, onClose, onSaved, projectName, contractor, address, projectId }) => {
  const { toast } = useToast();
  const co = changeOrder;
  const [number, setNumber] = useState(co.number ?? '');
  const [date, setDate] = useState(billingDay(co.date) ?? '');
  const [title, setTitle] = useState(co.title ?? '');
  const [description, setDescription] = useState(co.description ?? '');
  const [lines, setLines] = useState<ChangeOrderLine[]>(co.lines.length ? co.lines : []);
  const [lumpSumAmount, setLumpSumAmount] = useState(String(co.lumpSumAmount ?? 0));
  const [scheduleImpactDays, setScheduleImpactDays] = useState(
    co.scheduleImpactDays === null || co.scheduleImpactDays === undefined ? '' : String(co.scheduleImpactDays)
  );
  const [saving, setSaving] = useState(false);

  const initialDate = billingDay(co.date) ?? '';
  // Numbers are compared by value, not by the string in the box: the server
  // hands back 500.5 for a typed "500.50", which a text compare would read as
  // an edit that never goes away.
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v) || 0);
  const dirty =
    number !== (co.number ?? '') ||
    date !== initialDate ||
    title !== (co.title ?? '') ||
    description !== (co.description ?? '') ||
    (Number(lumpSumAmount) || 0) !== (Number(co.lumpSumAmount) || 0) ||
    numOrNull(scheduleImpactDays) !== (co.scheduleImpactDays ?? null) ||
    lineContentKey(lines) !== lineContentKey(co.lines);
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({
    type: 'changeOrder',
    id: co.id,
    isDirty: () => dirty,
    onFresh: onSaved,
  });

  // Email defaults: resolved recipient, always-CC, header-email options.
  const emailDefaults = useItemEmailDefaults('changeOrder', projectId);

  // One name for the stored document and the email attachment — they upsert
  // onto the same row, so a differing name would flip it depending on which
  // ran last. Keyed off the edited number rather than the loaded one because
  // the bar saves before it generates, so the draft number is the one the
  // document will carry. The id fallback keeps unnumbered drafts apart.
  const pdfFileName = `CO-${number || co.id}.pdf`;

  const lumpCents = Math.round((Number(lumpSumAmount) || 0) * 100);
  const total = draftTotalCents(lines) + lumpCents;

  const setLine = (i: number, patch: Partial<ChangeOrderLine>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(prev => [...prev, { description: '', qty: 1, unitPrice: 0 }]);
  const removeLine = (i: number) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    setSaving(true);
    try {
      await saveChangeOrder(co.id, {
        ...co,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        number: number || null,
        date: date ? new Date(date).getTime() : null,
        title: title || null,
        description: description || null,
        lumpSumAmount: Number(lumpSumAmount) || 0,
        scheduleImpactDays: scheduleImpactDays.trim() === '' ? null : (Number(scheduleImpactDays) || 0),
        lines: lines.map(l => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0 })),
      });
      toast('Change order saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Change order changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
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
    try { await removeCOPhoto(co.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // Built from the SAVED change order, never the typed-in draft: the bar
  // commits first, so re-reading the record here is what keeps a generated PDF
  // and the change order it claims to represent from drifting apart. A failed
  // re-read throws on purpose — the bar then reports the failure and keeps the
  // existing document, rather than quietly storing pre-save bytes and marking
  // them current.
  const buildBytes = async (headerEmail?: string): Promise<Uint8Array | ArrayBuffer> => {
    const saved = await getChangeOrder(co.id);
    if (!saved) throw new Error('Change order not found');
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
    const bytes = buildChangeOrderPdf({
      changeOrder: saved,
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

  const changeStatus = async (status: string) => {
    try { await setChangeOrderStatus(co.id, status); onSaved(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} dirty={dirty} title={`Change Order CO-${co.number ?? ''}`} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'change-order', sourceId: co.id }}
            kind="change-order"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={co.updatedAt}
            size="sm"
            send={{
              blockedReason: emailDefaults.sendBlockedReason,
              composer: {
                title: 'Send change order request',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `Change Order Request CO-${number} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached Change Order Request CO-${number} for ${projectName}${description ? ', covering: ' + description : ''}.\n\nPlease review and approve at your convenience.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, req) => {
                const result = await sendChangeOrder(co.id, { ...itemSendPayload(req), fileId });
                // The send moves the change order to 'sent' server-side.
                onSaved({ keepMounted: true });
                return result;
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save change order'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ChangeOrderStatusPill status={co.status} />
        {co.status !== 'approved' && <Button variant="ghost" size="sm" onClick={() => changeStatus('approved')}>Approve</Button>}
        {co.status !== 'rejected' && <Button variant="ghost" size="sm" onClick={() => changeStatus('rejected')}>Reject</Button>}
        <span className="text-xs text-ink-faint">Only approved change orders count toward the contract total.</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Number" htmlFor="co-num"><Input id="co-num" value={number} onChange={e => setNumber(e.target.value)} /></Field>
        <Field label="Date" htmlFor="co-date"><Input id="co-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Schedule impact (days)" htmlFor="co-impact"><NumberInput allowEmpty id="co-impact" value={scheduleImpactDays} onChange={e => setScheduleImpactDays(e.target.value)} placeholder="0" /></Field>
      </div>

      <div className="mt-3">
        <Field label="Title" htmlFor="co-title"><Input id="co-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Kitchen electrical add" /></Field>
      </div>

      <div className="mt-3">
        <Field label="Description" htmlFor="co-desc"><Textarea id="co-desc" value={description} onChange={e => setDescription(e.target.value)} rows={4} placeholder="Describe the scope change…" /></Field>
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

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Lump sum" htmlFor="co-lump"><NumberInput allowEmpty id="co-lump" value={lumpSumAmount} onChange={e => setLumpSumAmount(e.target.value)} placeholder="0.00" /></Field>
      </div>

      <div className="mt-4 flex justify-end gap-6 border-t border-edge pt-3 text-sm">
        <div className="text-right">
          <div className="text-ink-soft">Total <span className="ml-2 font-semibold text-ink">{formatMoney(total)}</span></div>
        </div>
      </div>

      <PhotoDropCard
        title="Photos"
        emptyText="No photos. Attach reference shots for the change order request."
        testId="change-order"
        photos={co.photos}
        upload={{ kind: 'change-order-photo', projectId, sourceType: 'change-order', sourceId: co.id }}
        initialProjectIds={[projectId]}
        link={fileId => addCOPhoto(co.id, fileId)}
        onRemove={dropPhoto}
        onDone={onSaved}
      />

      <PdfAttachmentsCard
        attachments={co.attachments}
        projectId={projectId}
        documentName="change order"
        testId="change-order"
        link={fileId => addCOAttachment(co.id, fileId)}
        update={(fileId, patch) => updateCOAttachment(co.id, fileId, patch)}
        remove={fileId => removeCOAttachment(co.id, fileId)}
        onChanged={onSaved}
      />
    </Modal>
  );
};
