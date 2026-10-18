// src/pages/project/billing/PaymentDetailModal.tsx
// One payment, opened from its row on Billing → Payments: its date, amount,
// method and note can be edited or the payment deleted, and it keeps its own
// photos and PDFs — a check image, a receipt, remittance advice, an ACH
// confirmation (spec docs/superpowers/specs/2026-10-06-payment-attachments-design.md).
// The attachments show here ONLY: never in the invoice editor's payment list,
// on an invoice or pay app PDF, or in a report. What the payment paid is fixed
// — paying a different record is a delete and a new payment.
import React, { useCallback, useRef, useState } from 'react';
import { FileText, Trash2 } from 'lucide-react';
import {
  HttpError, PaymentAttachment, PaymentDetail,
  addPaymentAttachment, deletePayment, formatBytes, getImageThumbUrl, getImageUrl, getPayment,
  removePaymentAttachment, updatePayment,
} from '../../../utils/store';
import { billingDay } from '../../../utils/billingDates';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Button, Field, Input, NumberInput, Modal, Select, Skeleton } from '../../../components/ui';
import { AddFilesButton } from '../../../components/documents/AddFilesButton';
import { useAttachFiles } from '../../../components/documents/useAttachFiles';
import { useDocumentViewer } from '../../../components/documents/useDocumentViewer';
import { Lightbox } from '../../../components/Lightbox';
import { useLiveQuery } from '../../../hooks/useLiveQuery';

/** The file kind a photo or PDF uploaded onto a payment is stored as —
 *  admin-only, like the rest of billing (server/documents.ts). */
export const PAYMENT_ATTACHMENT_KIND = 'payment-attachment';

export const PAYMENT_METHODS = [
  { value: 'check', label: 'Check' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'ach', label: 'ACH' },
  { value: 'other', label: 'Other' },
] as const;

/** 'ach' → 'ACH'; a method recorded some other way shows as stored. */
export const paymentMethodLabel = (method: string | null | undefined): string =>
  PAYMENT_METHODS.find(m => m.value === method)?.label ?? (method || '—');

export const isImageAttachment = (a: { mime: string | null }) => !!a.mime?.startsWith('image/');

interface Draft { date: string; amount: string; method: string; note: string }

// The date box holds a calendar day — the picked day, or the local day of one
// stamped "now" when recorded without a date (utils/billingDates) — so an
// untouched box is sent back as the stored timestamp, never re-parsed.
const toDateInput = (ts: number | null) => billingDay(ts) ?? '';
const draftFrom = (p: PaymentDetail): Draft => ({
  date: toDateInput(p.date), amount: String(p.amount), method: p.method ?? '', note: p.note ?? '',
});
const cents = (v: string) => Math.round((parseFloat(v) || 0) * 100);

export interface PaymentDetailModalProps {
  paymentId: string;
  projectId: string;
  onClose: () => void;
  /** The payment changed here (saved, deleted, attachments) — reload the list
   *  and the billing totals. Changes made elsewhere arrive on the change feed. */
  onChanged: () => void;
}

export const PaymentDetailModal: React.FC<PaymentDetailModalProps> = ({ paymentId, projectId, onClose, onChanged }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const viewer = useDocumentViewer();
  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  // null while the form shows the saved payment as-is, so a refresh from the
  // change feed lands straight in it; set once the user types, so a refresh
  // never clobbers an edit in progress.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const closedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setPayment(await getPayment(paymentId));
    } catch (e) {
      if (closedRef.current) return;
      // Deleted from another tab or by someone else while open.
      if (e instanceof HttpError && e.status === 404) {
        closedRef.current = true;
        toast('This payment was deleted', { type: 'warning' });
        onClose();
        return;
      }
      toast('Failed to load the payment', { type: 'error' });
    }
  }, [paymentId, toast, onClose]);
  useLiveQuery(load, { types: ['payment'], id: paymentId });

  const refreshed = useCallback(() => { void load(); onChanged(); }, [load, onChanged]);

  const attachUpload = { kind: PAYMENT_ATTACHMENT_KIND, projectId, sourceType: 'payment', sourceId: paymentId };
  const { dragActive, dropProps, busy, attachRows } = useAttachFiles({
    upload: attachUpload,
    accept: 'image-pdf',
    link: fileId => addPaymentAttachment(paymentId, fileId),
    onDone: refreshed,
    noun: 'files',
  });

  const base = payment ? draftFrom(payment) : null;
  const values = draft ?? base;
  // Typing a field back to exactly what is saved makes the form pristine again,
  // so later refreshes from the feed show up in it.
  const edit = (patch: Partial<Draft>) => {
    if (!values || !base) return;
    const next = { ...values, ...patch };
    const same = next.date === base.date && next.amount === base.amount && next.method === base.method && next.note === base.note;
    setDraft(same ? null : next);
  };
  const dirty = !!(draft && base) && (
    draft.date !== base.date || cents(draft.amount) !== cents(base.amount) ||
    draft.method !== base.method || draft.note !== base.note
  );
  const amountNum = values ? parseFloat(values.amount) : NaN;
  const valid = !!values?.date && Number.isFinite(amountNum) && amountNum > 0;

  const save = async () => {
    if (!payment || !values || !base || !dirty || !valid) return;
    setSaving(true);
    try {
      await updatePayment(payment.id, {
        amount: amountNum,
        date: values.date === base.date ? payment.date : new Date(values.date).getTime(),
        method: values.method || null,
        note: values.note,
      });
      toast('Payment saved', { type: 'success' });
      await load();
      setDraft(null);
      onChanged();
    } catch { toast('Save failed', { type: 'error' }); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!(await confirm({
      title: 'Delete payment?',
      message: 'This permanently removes the payment. Its photos and PDFs stay in Documents.',
      tone: 'danger', confirmLabel: 'Delete',
    }))) return;
    try {
      closedRef.current = true;
      await deletePayment(paymentId);
      onChanged();
      onClose();
    } catch {
      closedRef.current = false;
      toast('Delete failed', { type: 'error' });
    }
  };

  const removeAttachment = async (a: PaymentAttachment) => {
    if (!(await confirm({
      title: 'Remove attachment?',
      message: `Remove ${a.name ?? 'this file'} from the payment? The file stays in Documents.`,
      tone: 'danger', confirmLabel: 'Remove',
    }))) return;
    try { await removePaymentAttachment(paymentId, a.fileId); refreshed(); }
    catch { toast('Failed to remove attachment', { type: 'error' }); }
  };

  const attachments = payment?.attachments ?? [];
  const photos = attachments.filter(isImageAttachment);
  const files = attachments.filter(a => !isImageAttachment(a));
  const openFile = (a: PaymentAttachment) => viewer.open({
    id: a.fileId, name: a.name, mime: a.mime ?? 'application/pdf', size: a.size ?? 0,
    createdAt: a.createdAt ?? 0, versionNumber: a.versionNumber ?? 1,
  }, a.kind ?? PAYMENT_ATTACHMENT_KIND, projectId);

  // A method recorded some other way (an import, an older form) stays
  // selectable rather than silently becoming the first option.
  const methodOptions: { value: string; label: string }[] = [...PAYMENT_METHODS];
  if (base && !methodOptions.some(m => m.value === base.method)) {
    methodOptions.unshift({ value: base.method, label: base.method || '—' });
  }

  return (
    <>
      <Modal open onClose={onClose} dirty={dirty} title="Payment" width="lg"
        footer={<>
          <Button variant="ghost" className="mr-auto text-red-600 dark:text-red-400" onClick={remove} disabled={!payment}>
            <Trash2 size={14} />Delete payment
          </Button>
          <Button variant="secondary" onClick={() => setDraft(null)} disabled={!dirty || saving}>Cancel</Button>
          <Button onClick={() => { void save(); }} disabled={!dirty || !valid || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </>}
      >
        {!payment || !values ? (
          <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-soft">
              Applied to <span className="font-medium text-ink" data-testid="payment-target">{payment.targetLabel}</span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Date" htmlFor="pay-edit-date">
                <Input id="pay-edit-date" type="date" value={values.date} onChange={e => edit({ date: e.target.value })} />
              </Field>
              <Field label="Amount" htmlFor="pay-edit-amt">
                <NumberInput allowEmpty id="pay-edit-amt" value={values.amount} onChange={e => edit({ amount: e.target.value })} placeholder="0.00" />
              </Field>
              <Field label="Method" htmlFor="pay-edit-method">
                <Select id="pay-edit-method" value={values.method} onChange={e => edit({ method: e.target.value })}>
                  {methodOptions.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Note" htmlFor="pay-edit-note">
                <Input id="pay-edit-note" value={values.note} onChange={e => edit({ note: e.target.value })} placeholder="Optional" />
              </Field>
            </div>

            <div
              {...dropProps}
              data-testid="payment-attachments-dropzone"
              className={`mt-4 rounded-lg border-t border-edge pt-3 transition-shadow ${dragActive ? 'ring-2 ring-accent-500' : ''}`}
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-ink">Attachments</h4>
                <div className="flex items-center gap-2">
                  {busy && <span className="text-xs text-ink-faint">Uploading…</span>}
                  <AddFilesButton
                    label="Add photos or PDFs"
                    accept="image-pdf"
                    size="sm"
                    defaultTab="upload"
                    // No `capture` (as PhotoDropCard): on a phone the native
                    // picker offers the camera as one of its sources.
                    upload={attachUpload}
                    initialProjectIds={[projectId]}
                    excludeFileIds={attachments.map(a => a.fileId)}
                    disabled={busy}
                    onPick={attachRows}
                  />
                </div>
              </div>
              {attachments.length === 0 ? (
                <p className="text-xs text-ink-faint">No attachments. Add a photo of the check, a receipt, remittance advice or an ACH confirmation.</p>
              ) : (
                <>
                  {photos.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {photos.map((p, i) => (
                        <div key={p.id} className="group relative" data-testid={`payment-photo-${p.fileId}`}>
                          <img
                            src={getImageThumbUrl(p.fileId)}
                            alt={p.name ?? ''}
                            onClick={() => setLightboxIndex(i)}
                            className="h-24 w-full cursor-pointer rounded-lg border border-edge object-cover"
                          />
                          <button onClick={() => { void removeAttachment(p); }} title="Remove" aria-label={`Remove ${p.name ?? 'photo'}`}
                            className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {files.length > 0 && (
                    <ul className={`divide-y divide-edge ${photos.length ? 'mt-2' : ''}`}>
                      {files.map(a => (
                        <li key={a.id} className="flex items-center gap-3 py-2" data-testid={`payment-file-${a.fileId}`}>
                          <FileText size={16} className="shrink-0 text-ink-faint" />
                          <div className="min-w-0 flex-1">
                            {a.mime ? (
                              <button type="button" onClick={() => openFile(a)} className="block max-w-full truncate text-left text-sm font-medium text-ink hover:underline">
                                {a.name ?? a.fileId}
                              </button>
                            ) : (
                              // The file was deleted from Documents since.
                              <p className="truncate text-sm text-ink-faint">File no longer available</p>
                            )}
                            {a.size != null && <p className="text-xs text-ink-faint">{formatBytes(a.size)}</p>}
                          </div>
                          <Button variant="ghost" size="sm" aria-label={`Remove ${a.name ?? 'file'}`} title="Remove" onClick={() => { void removeAttachment(a); }}>
                            <Trash2 size={14} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </Modal>

      {lightboxIndex !== null && (
        <Lightbox
          items={photos.map(p => ({ src: getImageUrl(p.fileId), caption: p.name ?? undefined }))}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
      {viewer.modal}
    </>
  );
};
