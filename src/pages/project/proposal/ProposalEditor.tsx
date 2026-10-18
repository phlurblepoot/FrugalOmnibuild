// src/pages/project/proposal/ProposalEditor.tsx — /project/:projectId/proposal/:proposalId
// The full-page proposal editor. It owns the whole editable draft (via
// useProposalDraft); every card below it is controlled. Only a DRAFT (and
// non-legacy) proposal is editable — once sent, a proposal is a historical
// record and must be revised instead.
//
// Generate / Open / Download / Email belong to the shared DocumentActionsBar
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout); this file
// only supplies the wiring — what to render, what to save first, and where the
// resulting file id goes.
import React, { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import {
  ProposalLockedError, sendProposal, setProposalFile,
  type Proposal,
} from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { Button, Card, CardBody, CardHeader, Skeleton, StatusPill, Textarea } from '../../../components/ui';
import { formatCurrency, proposalFileName } from './proposalGenerator';
import { STATUS_TONE, proposalLabel } from './proposalPresentation';
import { buildProposalPdf } from './buildProposalPdf';
import { isAdmin, useProposalDraft } from './useProposalDraft';
import { useItemEmailDefaults } from '../../../hooks/useItemEmailDefaults';
import { itemSendPayload } from '../../../utils/itemSend';
import { HistoryMenu } from './HistoryMenu';
import { PricingLinesCard } from './PricingLinesCard';
import { InclusionsExclusionsCard } from './InclusionsExclusionsCard';
import { PaymentScheduleCard } from './PaymentScheduleCard';
import { ProposalOptionsCard } from './ProposalOptionsCard';
import { ProposalPhotosCard } from './ProposalPhotosCard';
import { ProposalAttachmentsCard } from './ProposalAttachmentsCard';

export const ProposalEditor: React.FC = () => {
  const { projectId, proposalId } = useParams<{ projectId: string; proposalId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const admin = isAdmin();

  const {
    project, proposal, draft, missingTakeoffIds, dirty, saving, loadFailed, readOnly,
    takeoffTotals, totals, notesHistory, termsHistory, inclusionsHistory, exclusionsHistory,
    lineLibrary, collab, patchDraft, applyOptions, save, reload, refreshMedia,
  } = useProposalDraft(projectId, proposalId);

  // Highlighted plan pages are a generate-time choice, not a stored proposal
  // column — the same option the old page carried.
  const [includeHighlights, setIncludeHighlights] = useState(false);
  const [progress, setProgress] = useState('');
  const emailDefaults = useItemEmailDefaults('proposal', projectId);

  // The PDF renders the draft as it stands on screen — Generate saves first, so
  // what the client receives is exactly what was just stored.
  const renderPdf = (headerEmail?: string) => buildProposalPdf({
    proposal: { ...(proposal as Proposal), ...draft },
    project: project!,
    takeoffTotals,
    includeHighlights,
    headerEmail,
    onProgress: setProgress,
    onSkippedAttachment: name => toast(`Skipped unreadable attachment ${name}`, { type: 'warning' }),
  });

  /** The bar's build(): the on-screen draft as PDF bytes, wrapped for storage. */
  const buildPdfBlob = async ({ headerEmail }: { headerEmail?: string }): Promise<Blob> => {
    try {
      const { pdfBytes, overBudget } = await renderPdf(headerEmail);
      if (overBudget) {
        toast(`Proposal is ${(pdfBytes.byteLength / 1048576).toFixed(1)}MB — above the 18MB email target`, { type: 'warning' });
      }
      return new Blob([pdfBytes], { type: 'application/pdf' });
    } finally {
      // The bar owns the busy label from here; the per-page progress line is
      // only meaningful while a render is actually running.
      setProgress('');
    }
  };

  // Every hook above runs unconditionally; the gate is the last thing before
  // render so a non-admin who guesses the URL lands back on the project.
  if (!admin) return <Navigate to={`/project/${projectId}`} replace />;

  const statusText = readOnly
    ? (proposal?.legacy ? 'Imported — revise to change' : 'Locked — revise to change')
    : dirty ? 'Unsaved changes' : 'Saved';
  // Send needs no prior Generate — the bar renders one when the stored
  // document is stale — but a proposal with no prices is not a proposal.
  // ('Save first' for a dirty draft is the bar's own fallback.)
  const sendBlockedReason = draft && draft.lines.length === 0 ? 'Add at least one price line' : undefined;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" aria-label="Back to proposals" onClick={() => navigate(`/project/${projectId}/proposal`)}>
            <ArrowLeft size={16} />Proposals
          </Button>
          {proposal && (
            <>
              <h1 className="text-xl font-bold text-ink">{proposalLabel(proposal)}</h1>
              <StatusPill tone={STATUS_TONE[proposal.status]}>{proposal.status}</StatusPill>
              <span className="text-sm text-ink-faint" data-testid="proposal-state">{statusText}</span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {progress && <span className="text-sm text-ink-faint" data-testid="proposal-progress">{progress}</span>}
          {totals && <span className="mr-1 text-sm font-semibold text-ink">{formatCurrency(totals.totalCents / 100)}</span>}
          {!readOnly && (
            <Button onClick={save} disabled={saving || !dirty} data-testid="btn-save-proposal">
              <Save size={16} />{saving ? 'Saving…' : 'Save'}
            </Button>
          )}
          {proposal && (project ? (
            <DocumentActionsBar
              source={{ sourceType: 'proposal', sourceId: proposal.id }}
              kind="proposal"
              format="pdf"
              projectId={proposal.projectId}
              fileName={`${proposalFileName(project)}.pdf`}
              build={buildPdfBlob}
              dirty={dirty}
              save={save}
              updatedAt={proposal.updatedAt}
              readOnly={readOnly}
              testIdPrefix="proposal"
              // The proposal row carries its own fileId column (the list and the
              // send route read it), so it follows whatever the bar just stored.
              // refreshMedia, not reload: re-deriving the draft here would throw
              // away whatever the estimator has typed since the save.
              onGenerated={async fileId => {
                await setProposalFile(proposal.id, fileId);
                refreshMedia();
              }}
              send={{
                blockedReason: sendBlockedReason ?? emailDefaults.sendBlockedReason,
                composer: {
                  title: 'Send proposal',
                  defaultTo: emailDefaults.defaultTo || project.email?.from || '',
                  defaultCc: emailDefaults.defaultCc || undefined,
                  defaultBcc: emailDefaults.defaultBcc || undefined,
                  defaultSubject: project.email?.subject ? `Re: ${project.email.subject}` : `Proposal — ${project.name}`,
                  defaultBody: "Please find our proposal attached. Don't hesitate to reach out with any questions.",
                  headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                  defaultHeaderEmail: emailDefaults.companyEmail || undefined,
                },
                sendFn: async (fileId, req) => {
                  let result;
                  try {
                    result = await sendProposal(proposal.id, { ...itemSendPayload(req), fileId });
                  } catch (e) {
                    // Someone else sent this proposal first. Say which failure
                    // it was, then rethrow — swallowing it would let the bar
                    // toast "Sent" for an email that never left.
                    if (e instanceof ProposalLockedError) {
                      toast('This proposal was already sent — revise it to send again', { type: 'error' });
                      reload();
                    }
                    throw e;
                  }
                  // The send stamps the proposal 'sent' server-side, which makes
                  // it read-only — the whole record has to come back.
                  reload();
                  return result;
                },
              }}
            />
          ) : (
            // No project means no takeoffs to price and nothing to address the
            // email to: the render would be wrong rather than merely
            // incomplete, so say why instead of offering a broken bar.
            <span className="text-sm text-ink-faint" data-testid="proposal-doc-blocked">
              Couldn&apos;t load the project — reload the page
            </span>
          ))}
        </div>
      </div>

      <EditPresenceBanner state={collab} />

      {loadFailed ? (
        <Card><CardBody><p className="text-sm text-ink-faint">This proposal could not be loaded.</p></CardBody></Card>
      ) : !draft || !proposal ? (
        <div className="space-y-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-32" />)}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <PricingLinesCard
              lines={draft.lines}
              onChange={lines => patchDraft({ lines })}
              readOnly={readOnly}
              takeoffTotals={takeoffTotals}
              missingTakeoffIds={missingTakeoffIds}
              showGrandTotal={draft.showGrandTotal}
              onShowGrandTotalChange={showGrandTotal => patchDraft({ showGrandTotal })}
              lineLibrary={lineLibrary}
            />
          </div>

          <div className="lg:col-span-2">
            <InclusionsExclusionsCard
              inclusions={draft.inclusions}
              exclusions={draft.exclusions}
              inclusionsHistory={inclusionsHistory}
              exclusionsHistory={exclusionsHistory}
              readOnly={readOnly}
              onChange={(inclusions, exclusions) => patchDraft({ inclusions, exclusions })}
            />
          </div>

          <Card data-testid="proposal-notes">
            <CardHeader
              title="Cover notes"
              actions={!readOnly && <HistoryMenu history={notesHistory} testId="notes-history" onSelect={coverNotes => patchDraft({ coverNotes })} />}
            />
            <CardBody>
              <Textarea
                aria-label="Cover notes"
                rows={8}
                value={draft.coverNotes}
                placeholder="The paragraph above the price."
                disabled={readOnly}
                onChange={e => patchDraft({ coverNotes: e.target.value })}
              />
            </CardBody>
          </Card>

          <Card data-testid="proposal-terms">
            <CardHeader
              title="Terms"
              actions={!readOnly && <HistoryMenu history={termsHistory} testId="terms-history" onSelect={terms => patchDraft({ terms })} />}
            />
            <CardBody>
              <Textarea
                aria-label="Terms"
                rows={8}
                value={draft.terms}
                placeholder="Payment terms, warranty, conditions."
                disabled={readOnly}
                onChange={e => patchDraft({ terms: e.target.value })}
              />
            </CardBody>
          </Card>

          <PaymentScheduleCard
            schedule={draft.paymentSchedule}
            totalCents={totals?.totalCents ?? 0}
            readOnly={readOnly}
            onChange={paymentSchedule => patchDraft({ paymentSchedule })}
          />

          <ProposalOptionsCard
            value={{
              title: draft.title,
              validUntil: draft.validUntil || null,
              fontFamily: draft.fontFamily,
              includeCostDetail: draft.includeCostDetail,
              includeSignature: draft.includeSignature,
              highlightQuality: draft.highlightQuality,
            }}
            includeHighlights={includeHighlights}
            canIncludeHighlights={draft.lines.some(l => l.kind === 'takeoff')}
            readOnly={readOnly}
            onChange={applyOptions}
            onIncludeHighlightsChange={setIncludeHighlights}
          />

          {/* refreshMedia, not reload: a photo/attachment change must not
              replace the draft the estimator is still typing into. */}
          <ProposalPhotosCard
            proposal={proposal}
            projectId={projectId!}
            readOnly={readOnly}
            onChanged={refreshMedia}
          />

          <ProposalAttachmentsCard
            proposal={proposal}
            projectId={projectId!}
            readOnly={readOnly}
            onChanged={refreshMedia}
          />
        </div>
      )}
    </div>
  );
};
