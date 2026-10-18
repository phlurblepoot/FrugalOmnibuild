// src/pages/project/billing/LienReleasesSection.tsx — Billing -> Lien Releases.
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, FileSignature, Trash2 } from 'lucide-react';
import {
  LienRelease, AiaPayApp, InvoiceListItem,
  getLienReleases, getLienRelease, deleteLienRelease, getPayApps, getInvoices,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { formatBillingDate } from '../../../utils/billingDates';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Card, CardBody, CardHeader, EmptyState, Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR } from '../../../components/ui';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { EditingChip } from '../../../components/EditingChip';
import { useGeneratedDocuments } from '../../../hooks/useGeneratedDocument';
import { DocumentStatusChip } from '../../../components/documents/DocumentStatusChip';
import { useDocumentViewer } from '../../../components/documents/useDocumentViewer';
import { LIEN_STATUS_META } from './LienReleaseEditor';
import { LienReleaseHost, LienReleaseLauncher, lienVariantLabel, type HostedRelease } from './LienReleaseLauncher';

export const LienReleasesSection: React.FC<{ projectId: string; onChange?: () => void }> = ({ projectId, onChange }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [releases, setReleases] = useState<LienRelease[] | null>(null);
  const [payApps, setPayApps] = useState<AiaPayApp[]>([]);
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [editing, setEditing] = useState<HostedRelease | null>(null);

  const reload = () => {
    if (!projectId) return;
    getLienReleases(projectId).then(setReleases).catch(() => setReleases([]));
    getPayApps(projectId).then(setPayApps).catch(() => setPayApps([]));
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
  };
  useLiveQuery(reload, { types: ['lienRelease', 'invoice', 'aiaPayApp'], projectId });

  const rows = releases ?? [];
  const docs = useGeneratedDocuments({
    sourceType: 'lien-release',
    kind: 'lien-release',
    sourceIds: rows.map(r => r.id),
    updatedAtById: Object.fromEntries(rows.map(r => [r.id, r.updatedAt])),
  });
  const viewer = useDocumentViewer();

  const sourceLabel = (r: LienRelease): string => {
    if (!r.sourceType || !r.sourceId) return '—';
    if (r.sourceType === 'payapp') {
      const app = payApps.find(a => a.id === r.sourceId);
      return app ? `Pay App #${app.number}` : 'Pay App';
    }
    const inv = invoices.find(i => i.id === r.sourceId);
    return inv ? `Invoice ${inv.number ?? ''}`.trim() : 'Invoice';
  };

  const openRelease = async (id: string) => {
    try { setEditing({ release: await getLienRelease(id) }); } catch { toast('Failed to open release', { type: 'error' }); }
  };

  // One-shot ?open=<id> (a Documents row links back here).
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    void openRelease(openId);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('open'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Delete release?', message: 'Only drafts can be deleted. A sent release is voided instead.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteLienRelease(id); reload(); onChange?.(); } catch (e) { toast((e instanceof Error && e.message) || 'Delete failed', { type: 'error' }); }
  };

  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title="Lien Releases"
          actions={<LienReleaseLauncher projectId={projectId} label="New release" buttonVariant="primary" menuDirection="down" testId="lien-new-release" onChanged={() => { reload(); onChange?.(); }} />}
        />
        <CardBody className="p-0">
          {releases === null ? (
            <div className="space-y-2 p-4">{[0, 1].map(i => <Skeleton key={i} className="h-9" />)}</div>
          ) : releases.length === 0 ? (
            <EmptyState icon={<FileSignature size={20} />} title="No lien releases yet"
              description="Start one from a pay app, an invoice or a payment, or choose New release." />
          ) : (
            <Table>
              <THead><TR><TH>Number</TH><TH>Type</TH><TH>Amount</TH><TH>Through</TH><TH>Release date</TH><TH>Status</TH><TH>For</TH><TH></TH></TR></THead>
              <TBody>
                {rows.map(r => {
                  const meta = LIEN_STATUS_META[r.status] ?? LIEN_STATUS_META.draft;
                  const doc = docs.byId[r.id];
                  return (
                    <TR key={r.id} interactive onClick={() => void openRelease(r.id)} className={r.status === 'void' ? 'opacity-60' : undefined}>
                      <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">LR-{r.number || '—'}<EditingChip type="lienRelease" id={r.id} /></span></TD>
                      <TD className="text-ink-soft capitalize">{lienVariantLabel(r)}</TD>
                      <TD className="text-ink-soft">{formatMoney(r.amountCents)}</TD>
                      <TD className="text-ink-soft">{r.paymentType === 'progress' ? formatBillingDate(r.throughDate) : '—'}</TD>
                      <TD className="text-ink-soft">{formatBillingDate(r.releaseDate)}</TD>
                      <TD><StatusPill tone={meta.tone}>{meta.label}</StatusPill></TD>
                      <TD className="text-ink-soft">{sourceLabel(r)}</TD>
                      <TD onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {doc?.file && (
                            <>
                              <DocumentStatusChip file={doc.file} upToDate={doc.upToDate} size="sm" />
                              <button
                                onClick={() => viewer.open(doc.file!, 'lien-release', projectId)}
                                title="Open PDF" aria-label="Open PDF"
                                className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink"
                              >
                                <Eye size={14} />
                              </button>
                            </>
                          )}
                          {r.status === 'draft' && (
                            <button onClick={() => void remove(r.id)} title="Delete draft" aria-label="Delete draft" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {editing && (
        <LienReleaseHost
          projectId={projectId}
          initial={editing}
          onClose={() => setEditing(null)}
          onChanged={() => { reload(); onChange?.(); }}
        />
      )}
      {viewer.modal}
    </>
  );
};
