// src/pages/project/billing/ChangeOrdersSection.tsx
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, FileText, Plus, Trash2 } from 'lucide-react';
import {
  ChangeOrder, ChangeOrderListItem,
  getChangeOrders, getChangeOrder, createChangeOrder, setChangeOrderStatus, deleteChangeOrder,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { formatBillingDate } from '../../../utils/billingDates';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { ChangeOrderStatusPill } from '../../../components/ui/BillingPills';
import { ChangeOrderEditor } from './ChangeOrderEditor';
import { useProjectOutlet } from '../ProjectLayout';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { EditingChip } from '../../../components/EditingChip';
import { useGeneratedDocuments } from '../../../hooks/useGeneratedDocument';
import { useReplyFlags } from '../../../hooks/useReplyFlags';
import { DocumentStatusChip } from '../../../components/documents/DocumentStatusChip';
import { ReplyFlagChip } from '../../../components/documents/ReplyFlagChip';
import { useDocumentViewer } from '../../../components/documents/useDocumentViewer';

export const ChangeOrdersSection: React.FC<{ projectId: string; onChange?: () => void }> = ({ projectId, onChange }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { summary: projectSummary } = useProjectOutlet();
  const [changeOrders, setChangeOrders] = useState<ChangeOrderListItem[] | null>(null);
  const [editing, setEditing] = useState<ChangeOrder | null>(null);
  // Bumped only when an outside change actually moved the record on, re-keying
  // the modal so it reloads (the collab "review merge" path). A refresh the
  // editor asked to survive — or one that changed nothing — leaves the user's
  // typed draft alone.
  const [editorSeq, setEditorSeq] = useState(0);

  const reload = () => {
    if (!projectId) return;
    getChangeOrders(projectId).then(setChangeOrders).catch(() => setChangeOrders([]));
  };
  useLiveQuery(reload, { types: ['changeOrder'], projectId });

  // One batched by-source lookup for the whole list: each row shows whether its
  // change-order PDF exists and is still current.
  const rows = changeOrders ?? [];
  const docs = useGeneratedDocuments({
    sourceType: 'change-order',
    kind: 'change-order',
    sourceIds: rows.map(r => r.id),
    updatedAtById: Object.fromEntries(rows.map(r => [r.id, r.updatedAt])),
  });
  const replyFlags = useReplyFlags('changeOrder', rows.map(r => r.id));
  const viewer = useDocumentViewer();

  const openChangeOrder = async (id: string) => {
    try { setEditing(await getChangeOrder(id)); } catch { toast('Failed to open change order', { type: 'error' }); }
  };

  // Open a specific change order's editor when arriving via CreateFromThreadMenu
  // (mail Task 3/follow-up) — same one-shot query-param convention as the
  // Tasks/RFI/Issue pages' ?open=.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    openChangeOrder(openId);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('open'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const newChangeOrder = async () => {
    if (!projectId) return;
    try {
      const r = await createChangeOrder(projectId, {});
      const co = await getChangeOrder(r.id);
      setEditing(co);
      reload();
      onChange?.();
    } catch { toast('Failed to create change order', { type: 'error' }); }
  };
  const removeChangeOrder = async (id: string) => {
    if (!(await confirm({ title: 'Delete change order?', message: 'This permanently removes the change order and its line items and photos.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteChangeOrder(id); reload(); onChange?.(); } catch { toast('Delete failed', { type: 'error' }); }
  };
  const coStatus = async (id: string, status: string) => {
    try { await setChangeOrderStatus(id, status); reload(); onChange?.(); } catch { toast('Update failed', { type: 'error' }); }
  };

  return (
    <>
      <Card className="mb-5">
        <CardHeader title="Change Orders" actions={<Button size="sm" onClick={newChangeOrder}><Plus size={14} />New change order</Button>} />
        <CardBody className="p-0">
          {changeOrders === null ? (
            <div className="space-y-2 p-4">{[0, 1].map(i => <Skeleton key={i} className="h-9" />)}</div>
          ) : changeOrders.length === 0 ? (
            <EmptyState icon={<FileText size={20} />} title="No change orders yet" description="Approved change orders increase the contract value." />
          ) : (
            <Table>
              <THead><TR><TH>Number</TH><TH>Title</TH><TH>Status</TH><TH>Amount</TH><TH>Date</TH><TH></TH></TR></THead>
              <TBody>
                {changeOrders.map(co => (
                  <TR key={co.id} interactive onClick={() => openChangeOrder(co.id)}>
                    <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">CO-{co.number || '—'}<EditingChip type="changeOrder" id={co.id} />{replyFlags.has(co.id) && <ReplyFlagChip data-testid={`co-reply-flag-${co.id}`} />}</span></TD>
                    <TD className="text-ink-soft">{co.title || '—'}</TD>
                    <TD><ChangeOrderStatusPill status={co.status} /></TD>
                    <TD className="text-ink-soft">{formatMoney(co.totalCents)}</TD>
                    <TD className="text-ink-soft">{formatBillingDate(co.date)}</TD>
                    <TD onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {docs.byId[co.id]?.file && (
                          <>
                            <DocumentStatusChip file={docs.byId[co.id].file} upToDate={docs.byId[co.id].upToDate} size="sm" />
                            <button
                              onClick={() => viewer.open(docs.byId[co.id].file!, 'change-order', projectId)}
                              title="Open PDF" aria-label="Open PDF"
                              className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink"
                            >
                              <Eye size={14} />
                            </button>
                          </>
                        )}
                        {co.status !== 'approved' && <button onClick={() => coStatus(co.id, 'approved')} className="rounded px-3 py-1.5 min-h-[36px] text-xs text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20">Approve</button>}
                        {co.status !== 'rejected' && <button onClick={() => coStatus(co.id, 'rejected')} className="rounded px-3 py-1.5 min-h-[36px] text-xs text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20">Reject</button>}
                        <button onClick={() => removeChangeOrder(co.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
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
        <ChangeOrderEditor
          key={`${editing.id}:${editorSeq}`}
          changeOrder={editing}
          onClose={() => setEditing(null)}
          onSaved={async (opts) => {
            // reload the open change order (lines/photos/version) and the list
            let fresh: ChangeOrder | null = null;
            try { fresh = await getChangeOrder(editing.id); setEditing(fresh); } catch { setEditing(null); }
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
