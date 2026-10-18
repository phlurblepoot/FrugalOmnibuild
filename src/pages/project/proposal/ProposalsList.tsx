// src/pages/project/proposal/ProposalsList.tsx — /project/:projectId/proposal
// The admin-only index of a project's proposals. Numbers shown here are
// internal (spec §2): they never reach a generated PDF, but they are how a
// revision chain is read back in the office.
import React, { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Check, Copy, FileText, Plus, Send, Trash2, X } from 'lucide-react';
import {
  ProposalSummary,
  createProposal, createSovLine, deleteProposal, getProposal, getProposals, getSov,
  getUserPreferences, setProposalStatus,
  getFileMeta,
} from '../../../utils/store';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { useReplyFlags } from '../../../hooks/useReplyFlags';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, EmptyState, Skeleton, StatusPill,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { formatCurrency } from './proposalGenerator';
import { STATUS_TONE, expiryText, proposalLabel } from './proposalPresentation';
import { optionDefaultsFromPrefs } from './proposalPrefs';
import { ReviseDialog } from './ReviseDialog';
import { AcceptDialog } from './AcceptDialog';
import { ReplyFlagChip } from '../../../components/documents/ReplyFlagChip';
import { useDocumentViewer } from '../../../components/documents/useDocumentViewer';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProposalsList: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const viewer = useDocumentViewer();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<ProposalSummary[] | null>(null);
  const [revising, setRevising] = useState<ProposalSummary | null>(null);
  const [accepting, setAccepting] = useState<ProposalSummary | null>(null);
  const admin = isAdmin();

  const load = () => {
    if (!projectId || !admin) return;
    getProposals(projectId).then(setRows).catch(() => setRows([]));
  };
  useLiveQuery(load, { types: ['proposal'], projectId });
  const replyFlags = useReplyFlags('proposal', (rows ?? []).map(r => r.id));

  // Every hook above runs unconditionally; the gate is the last thing before
  // render so a non-admin who guesses the URL lands back on the project.
  if (!admin) return <Navigate to={`/project/${projectId}`} replace />;

  const openEditor = (id: string) => navigate(`/project/${projectId}/proposal/${id}`);

  const handleNew = async () => {
    try {
      // A new proposal starts with the document options this user last saved
      // (font, quality, cost detail, signature, grand total) — nobody wants to
      // re-tick the same four boxes on every bid. Prefs are best-effort: an
      // offline fetch just means the server's own defaults apply.
      const prefs = await getUserPreferences().catch(() => ({} as Record<string, string>));
      const { id } = await createProposal(projectId!, optionDefaultsFromPrefs(prefs));
      openEditor(id);
    } catch { toast('Failed to create proposal', { type: 'error' }); }
  };

  const handleDelete = async (p: ProposalSummary) => {
    if (!await confirm({
      title: 'Delete draft?',
      message: `Delete proposal ${proposalLabel(p)}? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })) return;
    try { await deleteProposal(p.id); load(); } catch { toast('Failed to delete', { type: 'error' }); }
  };

  const handleDecline = async (p: ProposalSummary) => {
    if (!await confirm({
      title: 'Mark declined?',
      message: `Mark proposal ${proposalLabel(p)} as declined by the customer?`,
      confirmLabel: 'Mark declined',
    })) return;
    try { await setProposalStatus(p.id, 'declined'); load(); } catch { toast('Failed to update', { type: 'error' }); }
  };

  const handleRevise = async ({ carryPhotos, carryAttachments }: { carryPhotos: boolean; carryAttachments: boolean }) => {
    const source = revising;
    if (!source) return;
    try {
      const { id } = await createProposal(projectId!, { revisedFromId: source.id, carryPhotos, carryAttachments });
      setRevising(null);
      openEditor(id);
    } catch { toast('Failed to create revision', { type: 'error' }); }
  };

  // Seeds the schedule of values from the accepted price. Alternates are
  // excluded — they were priced but not bought. An SOV that already has lines
  // is never silently appended to.
  const prefillSov = async (proposal: ProposalSummary) => {
    try {
      const [full, existing] = await Promise.all([getProposal(proposal.id), getSov(projectId!)]);
      const lines = full.lines.filter(l => !l.isAlternate);
      // Silence here read as "the SOV was filled"; say why nothing happened.
      if (!lines.length) { toast('No price lines to prefill', { type: 'info' }); return; }
      if (existing.length && !await confirm({
        title: 'SOV already has lines',
        message: 'Add the proposal lines to the existing schedule of values?',
        confirmLabel: 'Add lines',
      })) return;
      for (const l of lines) {
        await createSovLine(projectId!, { description: l.description, scheduledValueCents: l.amountCents });
      }
      toast(`Added ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} to the schedule of values`, { type: 'success' });
    } catch { toast('Failed to prefill the schedule of values', { type: 'error' }); }
  };

  const handleAccept = async ({ signedFileId, prefillSov: wantsPrefill }: { signedFileId: string | null; prefillSov: boolean }) => {
    const target = accepting;
    if (!target) return;
    try {
      await setProposalStatus(target.id, 'accepted', signedFileId);
    } catch {
      toast('Failed to update', { type: 'error' });
      return;
    }
    setAccepting(null);
    load();
    toast('Proposal accepted', { type: 'success' });
    if (wantsPrefill) await prefillSov(target);
  };

  // Open PDF / Signed copy peek in the shared viewer modal first (same as every
  // other list); its "Open in editor" link is the path into the document editor.
  const openFile = async (fileId: string, kind: 'proposal' | 'proposal-signed') => {
    try {
      const meta = await getFileMeta(fileId);
      if (!meta) { toast('That document is no longer available', { type: 'warning' }); return; }
      viewer.open({ id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, createdAt: meta.createdAt, versionNumber: meta.versionNumber }, kind, projectId ?? null);
    } catch { toast('Failed to open document', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Proposals</h1>
          <p className="text-sm text-ink-faint">Numbered internally; revisions keep their lineage.</p>
        </div>
        <Button onClick={handleNew} data-testid="btn-new-proposal"><Plus size={16} />New proposal</Button>
      </div>

      <Card>
        <CardBody className="p-0">
          {rows === null ? (
            <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<FileText size={20} />}
              title="No proposals yet"
              description="Select takeoffs on the Takeoffs tab and click Proposal, or start a blank one."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>#</TH><TH>Title</TH><TH>Status</TH>
                  <TH className="text-right">Total</TH>
                  <TH>Alternates</TH><TH>Sent</TH><TH></TH>
                </TR>
              </THead>
              <TBody>
                {rows.map(p => {
                  const exp = expiryText(p);
                  return (
                    <TR key={p.id} interactive data-testid={`proposal-row-${p.number}`} onClick={() => openEditor(p.id)}>
                      <TD className="whitespace-nowrap font-medium text-ink">
                        <span className="inline-flex items-center gap-1.5">
                          {proposalLabel(p)}
                          {p.legacy && <span className="text-xs text-ink-faint">(legacy)</span>}
                          {replyFlags.has(p.id) && <ReplyFlagChip data-testid={`proposal-reply-flag-${p.id}`} />}
                        </span>
                      </TD>
                      <TD className="max-w-[16rem] truncate text-ink-soft">{p.title || '—'}</TD>
                      <TD>
                        <StatusPill tone={STATUS_TONE[p.status]}>{p.status}</StatusPill>
                        {exp && (
                          <span className={`ml-2 text-xs ${exp.startsWith('expired') ? 'text-red-600' : 'text-ink-faint'}`}>
                            {exp}
                          </span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-right font-medium text-ink">
                        {formatCurrency(p.totalCents / 100)}
                        {p.hasOverride && (
                          <span
                            title="Contains overridden takeoff amounts"
                            aria-label="Contains overridden takeoff amounts"
                            className="ml-1 inline-block align-middle text-amber-500"
                          >
                            <AlertTriangle size={12} />
                          </span>
                        )}
                      </TD>
                      <TD className="text-xs text-ink-faint">{p.alternateCount || '—'}</TD>
                      <TD
                        className="whitespace-nowrap text-xs text-ink-faint"
                        title={p.sentTo ? `To: ${p.sentTo.to}${p.sentTo.cc ? ` · CC: ${p.sentTo.cc}` : ''}\n${p.sentTo.subject}` : undefined}
                      >
                        {p.sentAt ? new Date(p.sentAt).toLocaleDateString() : '—'}
                      </TD>
                      <TD onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {p.fileId && (
                            <Button variant="ghost" size="sm" title="Open PDF" aria-label="Open PDF"
                              onClick={() => openFile(p.fileId!, 'proposal')}><FileText size={15} /></Button>
                          )}
                          {p.signedFileId && (
                            <Button variant="ghost" size="sm" title="Signed copy" aria-label="Signed copy"
                              onClick={() => openFile(p.signedFileId!, 'proposal-signed')}><Check size={15} /></Button>
                          )}
                          <Button variant="ghost" size="sm" title="Revise (new proposal from this one)"
                            aria-label="Revise" onClick={() => setRevising(p)}><Copy size={15} /></Button>
                          {p.status === 'draft' && !p.legacy && (
                            <Button variant="ghost" size="sm" title="Open & send" aria-label="Open and send"
                              onClick={() => openEditor(p.id)}><Send size={15} /></Button>
                          )}
                          {/* A legacy row is read-only history — Open PDF and
                              Revise only (spec §5) — even though it may carry
                              status 'sent'; the server refuses either way. */}
                          {p.status === 'sent' && !p.legacy && (
                            <>
                              <Button variant="ghost" size="sm" title="Mark accepted" aria-label="Mark accepted"
                                onClick={() => setAccepting(p)}><Check size={15} /></Button>
                              <Button variant="ghost" size="sm" title="Mark declined" aria-label="Mark declined"
                                onClick={() => handleDecline(p)}><X size={15} /></Button>
                            </>
                          )}
                          {p.status === 'draft' && !p.legacy && (
                            <Button variant="ghost" size="sm" title="Delete draft" aria-label="Delete draft"
                              onClick={() => handleDelete(p)}><Trash2 size={15} /></Button>
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

      {viewer.modal}
      <ReviseDialog open={!!revising} source={revising} onClose={() => setRevising(null)} onConfirm={handleRevise} />
      <AcceptDialog
        open={!!accepting}
        proposal={accepting}
        projectId={projectId!}
        onClose={() => setAccepting(null)}
        onConfirm={handleAccept}
      />
    </div>
  );
};
