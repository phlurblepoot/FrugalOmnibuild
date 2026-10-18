// src/pages/project/billing/PaymentsSection.tsx
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Paperclip, Trash2, X } from 'lucide-react';
import {
  Payment, InvoiceListItem, AiaPayApp, DocumentRow,
  getProjectPayments, getInvoices, getPayApps, recordPayment, deletePayment,
  uploadProjectFile, addPaymentAttachment,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { formatBillingDate, todayDay } from '../../../utils/billingDates';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, NumberInput, Select, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { AddFilesButton } from '../../../components/documents/AddFilesButton';
import { useDropZone } from '../../../hooks/useDropZone';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { LienReleaseLauncher } from './LienReleaseLauncher';
import { PAYMENT_ATTACHMENT_KIND, PAYMENT_METHODS, PaymentDetailModal, paymentMethodLabel } from './PaymentDetailModal';

// A photo or PDF picked for a payment that isn't recorded yet: a new file
// from the device (stored once the payment exists, filed under it) or one
// already in the app (only linked).
type Staged = { key: string; name: string; file: File } | { key: string; name: string; fileId: string };

let stagedSeq = 0;
const stageFile = (file: File): Staged => ({ key: `file-${++stagedSeq}`, name: file.name, file });

export const PaymentsSection: React.FC<{ projectId: string; onChange?: () => void }> = ({ projectId, onChange }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [payApps, setPayApps] = useState<AiaPayApp[]>([]);
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  // Today on the local calendar, so a new payment is always a picked day.
  const [date, setDate] = useState(todayDay);
  const [method, setMethod] = useState('check');
  const [note, setNote] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [recording, setRecording] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = () => {
    if (!projectId) return;
    getProjectPayments(projectId).then(setPayments).catch(() => setPayments([]));
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
    getPayApps(projectId).then(setPayApps).catch(() => setPayApps([]));
  };
  // Invoices and pay apps too: they are the "Applied to" choices and labels.
  useLiveQuery(reload, { types: ['payment', 'invoice', 'aiaPayApp'], projectId });

  // ?open=<paymentId> opens that payment (the Documents page links a payment's
  // photos back to it) — the same one-shot convention as InvoicesSection.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const id = searchParams.get('open');
    if (!id) return;
    setOpenId(id);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('open'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const stageFiles = (files: File[]) => setStaged(prev => [...prev, ...files.map(stageFile)]);
  const stageRows = (rows: DocumentRow[]) => setStaged(prev => [
    ...prev,
    ...rows.filter(r => !prev.some(s => 'fileId' in s && s.fileId === r.id))
      .map(r => ({ key: `row-${r.id}`, name: r.name ?? r.id, fileId: r.id })),
  ]);
  const { dragActive, dropProps } = useDropZone(stageFiles, { accept: 'image-pdf', disabled: recording });

  const amountNum = parseFloat(amount);
  const canRecord = !!target && Number.isFinite(amountNum) && amountNum > 0 && !recording;

  // After the payment exists: store each new file under it (the payment's own
  // kind and source) and link it. One summary for the batch, like
  // useAttachFiles — the payment itself is already recorded, so a file that
  // didn't make it can be added again from the payment.
  const attachStaged = async (paymentId: string, items: Staged[]) => {
    let ok = 0;
    for (const item of items) {
      try {
        const fileId = 'file' in item
          ? (await uploadProjectFile(projectId, item.file, PAYMENT_ATTACHMENT_KIND, { sourceType: 'payment', sourceId: paymentId })).fileId
          : item.fileId;
        await addPaymentAttachment(paymentId, fileId);
        ok++;
      } catch { /* counted below */ }
    }
    if (ok < items.length) {
      toast(`Added ${ok} of ${items.length} attachments — open the payment to add the rest`, { type: ok ? 'warning' : 'error' });
    }
  };

  const record = async () => {
    if (!canRecord) return;
    const sep = target.indexOf(':');
    const targetType = target.slice(0, sep) as 'invoice' | 'payapp';
    const targetId = target.slice(sep + 1);
    setRecording(true);
    try {
      let paymentId: string;
      try {
        ({ id: paymentId } = await recordPayment(projectId, targetType, targetId, {
          amount: amountNum,
          date: date ? new Date(date).getTime() : undefined,
          method,
          note: note || undefined,
        }));
      } catch { toast('Failed to record payment', { type: 'error' }); return; }
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse' } }));
      toast('Payment recorded', { type: 'success' });
      const toAttach = staged;
      setTarget(''); setAmount(''); setDate(todayDay()); setMethod('check'); setNote(''); setStaged([]);
      if (toAttach.length) await attachStaged(paymentId, toAttach);
      reload();
      onChange?.();
    } finally { setRecording(false); }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Delete payment?', message: 'This permanently removes the payment. Its photos and PDFs stay in Documents.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await deletePayment(id);
      reload();
      onChange?.();
    } catch { toast('Delete failed', { type: 'error' }); }
  };

  const total = (payments ?? []).reduce((a, p) => a + Math.round(p.amount * 100), 0);

  return (
    <Card className="mb-5">
      <CardHeader title="Payments" />
      <CardBody>
        <div
          {...dropProps}
          data-testid="payment-record-dropzone"
          className={`mb-4 rounded-lg transition-shadow ${dragActive ? 'ring-2 ring-accent-500' : ''}`}
        >
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Applied to" htmlFor="pay-target">
              <Select id="pay-target" value={target} onChange={e => setTarget(e.target.value)} className="w-full sm:w-56">
                <option value="">Select target…</option>
                {invoices.length > 0 && (
                  <optgroup label="Invoices">
                    {invoices.map(inv => (
                      <option key={inv.id} value={`invoice:${inv.id}`}>Invoice {inv.number || inv.id}</option>
                    ))}
                  </optgroup>
                )}
                {payApps.length > 0 && (
                  <optgroup label="Pay applications">
                    {payApps.map(pa => (
                      <option key={pa.id} value={`payapp:${pa.id}`}>Application #{pa.number}</option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </Field>
            <Field label="Amount" htmlFor="pay-amt"><NumberInput allowEmpty id="pay-amt" value={amount} onChange={e => setAmount(e.target.value)} className="w-28" placeholder="0.00" /></Field>
            <Field label="Date" htmlFor="pay-date"><Input id="pay-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40" /></Field>
            <Field label="Method" htmlFor="pay-method">
              <Select id="pay-method" value={method} onChange={e => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Field>
            <Field label="Note" htmlFor="pay-note"><Input id="pay-note" value={note} onChange={e => setNote(e.target.value)} className="w-48" placeholder="Optional" /></Field>
            <Button onClick={() => { void record(); }} disabled={!canRecord}>{recording ? 'Recording…' : 'Record'}</Button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <AddFilesButton
              label="Attach"
              accept="image-pdf"
              size="sm"
              variant="ghost"
              defaultTab="upload"
              // The payment doesn't exist yet, so the Upload tab hands the
              // files back unstored (onPickFiles); record() files them under
              // the payment once it does. No `capture`, as PhotoDropCard: on
              // a phone the native picker offers the camera itself.
              upload={{ kind: PAYMENT_ATTACHMENT_KIND, projectId }}
              initialProjectIds={[projectId]}
              excludeFileIds={staged.flatMap(s => ('fileId' in s ? [s.fileId] : []))}
              disabled={recording}
              onPick={stageRows}
              onPickFiles={stageFiles}
            />
            {staged.length === 0 ? (
              <span className="text-xs text-ink-faint">A photo of the check, a receipt or remittance advice (photos or PDFs).</span>
            ) : staged.map(s => (
              <span key={s.key} data-testid="payment-staged-attachment"
                className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-edge bg-sunken px-2 py-1 text-xs text-ink">
                <Paperclip size={12} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 truncate">{s.name}</span>
                <button type="button" aria-label={`Remove ${s.name}`} disabled={recording}
                  className="shrink-0 opacity-60 hover:opacity-100"
                  onClick={() => setStaged(prev => prev.filter(x => x.key !== s.key))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        </div>

        {payments === null ? (
          <Skeleton className="h-9" />
        ) : payments.length === 0 ? (
          <EmptyState title="No payments yet" description="Record a payment against an invoice or pay application." />
        ) : (
          <Table>
            <THead><TR><TH>Date</TH><TH>Applied to</TH><TH>Method</TH><TH>Note</TH><TH>Amount</TH><TH></TH></TR></THead>
            <TBody>
              {payments.map(p => (
                <TR key={p.id} interactive onClick={() => setOpenId(p.id)} data-testid={`payment-row-${p.id}`}>
                  <TD className="text-ink-soft">{formatBillingDate(p.date)}</TD>
                  <TD className="font-medium text-ink">{p.targetLabel || `${p.targetType} ${p.targetId}`}</TD>
                  <TD className="text-ink-soft">{paymentMethodLabel(p.method)}</TD>
                  <TD className="text-ink-soft max-w-[16rem] truncate" title={p.note || ''}>{p.note || '—'}</TD>
                  <TD className="text-ink-soft">{formatMoney(Math.round(p.amount * 100))}</TD>
                  <TD onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {!!p.attachmentCount && (
                        <span
                          className="inline-flex items-center gap-0.5 text-xs text-ink-faint"
                          title={`${p.attachmentCount} attachment${p.attachmentCount === 1 ? '' : 's'}`}
                          data-testid={`payment-attachment-count-${p.id}`}
                        >
                          <Paperclip size={13} />{p.attachmentCount}
                        </span>
                      )}
                      <LienReleaseLauncher projectId={projectId} paymentId={p.id} variant={{ paymentType: 'progress', conditional: false }} label="Unconditional release for this payment" buttonVariant="ghost" testId={`payment-lien-release-${p.id}`} />
                      <button onClick={() => { void remove(p.id); }} title="Delete" aria-label="Delete payment" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                    </div>
                  </TD>
                </TR>
              ))}
              <TR>
                <TD className="font-semibold text-ink" colSpan={4}>Total</TD>
                <TD className="font-semibold text-ink">{formatMoney(total)}</TD>
                <TD></TD>
              </TR>
            </TBody>
          </Table>
        )}
      </CardBody>

      {openId && (
        <PaymentDetailModal
          key={openId}
          paymentId={openId}
          projectId={projectId}
          onClose={() => setOpenId(null)}
          onChanged={() => { reload(); onChange?.(); }}
        />
      )}
    </Card>
  );
};
