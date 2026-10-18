// src/pages/project/billing/InvoicesSection.tsx
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, FileText, Plus, Trash2 } from 'lucide-react';
import {
  Invoice, InvoiceListItem,
  getInvoices, getInvoice, createInvoice, deleteInvoice, setInvoiceStatus,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { InvoiceStatusPill } from '../../../components/ui/BillingPills';
import { InvoiceEditor } from './InvoiceEditor';
import { useProjectOutlet } from '../ProjectLayout';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { EditingChip } from '../../../components/EditingChip';
import { useGeneratedDocuments } from '../../../hooks/useGeneratedDocument';
import { useReplyFlags } from '../../../hooks/useReplyFlags';
import { DocumentStatusChip } from '../../../components/documents/DocumentStatusChip';
import { ReplyFlagChip } from '../../../components/documents/ReplyFlagChip';
import { useDocumentViewer } from '../../../components/documents/useDocumentViewer';

export const InvoicesSection: React.FC<{ projectId: string; onChange?: () => void }> = ({ projectId, onChange }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { summary: projectSummary } = useProjectOutlet();
  const [invoices, setInvoices] = useState<InvoiceListItem[] | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  // Bumped only when an outside change actually moved the record on, re-keying
  // the modal so it reloads (the collab "review merge" path). A refresh the
  // editor asked to survive — or one that changed nothing — leaves the user's
  // typed draft alone.
  const [editorSeq, setEditorSeq] = useState(0);

  const reload = () => {
    if (!projectId) return;
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
  };
  useLiveQuery(reload, { types: ['invoice', 'payment'], projectId });

  // One batched by-source lookup for the whole list: each row shows whether its
  // invoice PDF exists and is still current.
  const rows = invoices ?? [];
  const docs = useGeneratedDocuments({
    sourceType: 'invoice',
    kind: 'invoice',
    sourceIds: rows.map(r => r.id),
    updatedAtById: Object.fromEntries(rows.map(r => [r.id, r.updatedAt])),
  });
  const replyFlags = useReplyFlags('invoice', rows.map(r => r.id));
  const viewer = useDocumentViewer();

  const openInvoice = async (id: string) => {
    try { setEditing(await getInvoice(id)); } catch { toast('Failed to open invoice', { type: 'error' }); }
  };

  // Open a specific invoice's editor when arriving via CreateFromThreadMenu
  // (mail Task 3/follow-up) — same one-shot query-param convention as the
  // Tasks/RFI/Issue pages' ?open=.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    openInvoice(openId);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('open'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const newInvoice = async () => {
    if (!projectId) return;
    try {
      const r = await createInvoice(projectId, { number: '', lines: [] });
      const inv = await getInvoice(r.id);
      setEditing(inv);
      reload();
      onChange?.();
    } catch { toast('Failed to create invoice', { type: 'error' }); }
  };
  const removeInvoice = async (id: string) => {
    if (!(await confirm({ title: 'Delete invoice?', message: 'This permanently removes the invoice and its payments.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteInvoice(id); reload(); onChange?.(); } catch { toast('Delete failed', { type: 'error' }); }
  };
  const cycleStatus = async (inv: InvoiceListItem) => {
    const next = inv.status === 'draft' ? 'sent' : inv.status === 'sent' ? 'paid' : 'draft';
    try { await setInvoiceStatus(inv.id, next); reload(); onChange?.(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <>
      <Card className="mb-5">
        <CardHeader title="Invoices" actions={<Button size="sm" onClick={newInvoice}><Plus size={14} />New invoice</Button>} />
        <CardBody className="p-0">
          {invoices === null ? (
            <div className="space-y-2 p-4">{[0, 1].map(i => <Skeleton key={i} className="h-9" />)}</div>
          ) : invoices.length === 0 ? (
            <EmptyState icon={<FileText size={20} />} title="No invoices yet" description="Create an invoice to bill against this project." />
          ) : (
            <Table>
              <THead><TR><TH>Number</TH><TH>Status</TH><TH>Total</TH><TH>Balance</TH><TH></TH></TR></THead>
              <TBody>
                {invoices.map(inv => (
                  <TR key={inv.id} interactive onClick={() => openInvoice(inv.id)}>
                    <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">{inv.number || '(untitled)'}<EditingChip type="invoice" id={inv.id} />{replyFlags.has(inv.id) && <ReplyFlagChip data-testid={`invoice-reply-flag-${inv.id}`} />}</span></TD>
                    <TD title="Click to advance status" onClick={e => { e.stopPropagation(); cycleStatus(inv); }}><InvoiceStatusPill status={inv.status} /></TD>
                    <TD className="text-ink-soft">{formatMoney(inv.totalCents)}</TD>
                    <TD className="text-ink-soft">{formatMoney(inv.balanceCents)}</TD>
                    <TD onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {docs.byId[inv.id]?.file && (
                          <>
                            <DocumentStatusChip file={docs.byId[inv.id].file} upToDate={docs.byId[inv.id].upToDate} size="sm" />
                            <button
                              onClick={() => viewer.open(docs.byId[inv.id].file!, 'invoice', projectId)}
                              title="Open PDF" aria-label="Open PDF"
                              className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink"
                            >
                              <Eye size={14} />
                            </button>
                          </>
                        )}
                        <button onClick={() => removeInvoice(inv.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {editing && (
        <InvoiceEditor
          key={`${editing.id}:${editorSeq}`}
          invoice={editing}
          onClose={() => setEditing(null)}
          onSaved={async (opts) => {
            // reload the open invoice (payments/lines) and the lists
            let fresh: Invoice | null = null;
            try { fresh = await getInvoice(editing.id); setEditing(fresh); } catch { setEditing(null); }
            // Remounting mid-flow would tear down the editor's document bar
            // (and its version dialog), so its own saves ask to stay mounted —
            // their local state already matches what came back. A refresh that
            // found nothing new (a failed photo upload, say) must not discard
            // what the user has typed either.
            if (!opts?.keepMounted && fresh && fresh.version !== editing.version) {
              setEditorSeq(n => n + 1);
            }
            reload();
            onChange?.();
          }}
          projectName={projectSummary?.name ?? ''}
          contractor={projectSummary?.contractor}
          address={projectSummary?.address}
          projectId={projectId ?? ''}
        />
      )}

      {viewer.modal}
    </>
  );
};
