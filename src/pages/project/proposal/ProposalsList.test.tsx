import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../../components/Toast';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import type { ProposalSummary } from '../../../utils/store';

// useLiveQuery needs a socket context we don't care about here; the list only
// relies on it to run `load` on mount.
vi.mock('../../../hooks/useLiveQuery', () => ({
  useLiveQuery: (load: () => void) => { React.useEffect(() => { load(); }, []); }, // eslint-disable-line react-hooks/exhaustive-deps
}));
// Not under test here — see ReplyFlagChip/useReplyFlags.test for that; a real
// fetch would otherwise fire (and outlive) this file's tests.
vi.mock('../../../hooks/useReplyFlags', () => ({ useReplyFlags: () => new Set<string>() }));
vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  getProposals: vi.fn(async () => rows),
  createProposal: vi.fn(async () => ({ id: 'new1', number: 4, version: 1 })),
  deleteProposal: vi.fn(async () => {}),
  setProposalStatus: vi.fn(async () => ({ version: 2 })),
  getProposal: vi.fn(async () => ({ ...rows[0], lines: [], photos: [], attachments: [] })),
  getSov: vi.fn(async () => []),
  createSovLine: vi.fn(async () => ({ id: 's1' })),
  getUserPreferences: vi.fn(async () => userPrefs),
  getFileMeta: vi.fn(async (id: string) => ({ id, projectId: 'p1', name: `${id}.pdf`, mime: 'application/pdf', size: 10, kind: 'proposal', parentFileId: null, versionNumber: 2, createdAt: 5 })),
}));
const viewerOpen = vi.fn();
vi.mock('../../../components/documents/useDocumentViewer', () => ({
  useDocumentViewer: () => ({ open: viewerOpen, modal: <div data-testid="viewer-modal-mock" /> }),
}));
import { createProposal, createSovLine, deleteProposal, getFileMeta, getProposal, setProposalStatus } from '../../../utils/store';
import { ProposalsList } from './ProposalsList';

const base: ProposalSummary = {
  id: 'pr1', projectId: 'p1', number: 1, revisedFromId: null, revisedFromNumber: null,
  status: 'draft', legacy: false, title: 'Base bid', validUntil: null,
  fontFamily: null, coverNotes: null, terms: null, inclusions: [], exclusions: [], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: true, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 125_000_00, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
};
let rows: ProposalSummary[] = [];
let userPrefs: Record<string, string> = {};

const renderList = () => render(
  <ToastProvider>
    <ConfirmProvider>
      <MemoryRouter initialEntries={['/project/p1/proposal']}>
        <Routes>
          <Route path="/project/:projectId/proposal" element={<ProposalsList />} />
          <Route path="/project/:projectId" element={<div>project overview</div>} />
          <Route path="/project/:projectId/proposal/:proposalId" element={<div>editor</div>} />
        </Routes>
      </MemoryRouter>
    </ConfirmProvider>
  </ToastProvider>
);

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'admin' }));
  vi.clearAllMocks();
  userPrefs = {};
  rows = [
    base,
    { ...base, id: 'pr2', number: 2, revisedFromId: 'pr1', revisedFromNumber: 1, status: 'sent', title: 'Revised bid', hasOverride: true, alternateCount: 2, sentAt: Date.UTC(2026, 7, 20, 18) },
  ];
});

describe('ProposalsList', () => {
  it('renders a row per proposal with label, status, total and the override marker', async () => {
    renderList();
    await screen.findByTestId('proposal-row-1');

    const revision = screen.getByTestId('proposal-row-2');
    expect(revision).toHaveTextContent('#2 (rev. of #1)');
    expect(revision).toHaveTextContent('sent');
    expect(revision).toHaveTextContent('$125,000.00');
    expect(revision).toHaveTextContent('2');
    expect(within(revision).getByLabelText('Contains overridden takeoff amounts')).toBeInTheDocument();

    const original = screen.getByTestId('proposal-row-1');
    expect(original).toHaveTextContent('#1');
    expect(original).toHaveTextContent('draft');
    expect(within(original).queryByLabelText('Contains overridden takeoff amounts')).toBeNull();
  });

  it('offers accept/decline only on sent proposals and delete only on drafts', async () => {
    renderList();
    const sent = await screen.findByTestId('proposal-row-2');
    const draft = screen.getByTestId('proposal-row-1');

    expect(within(sent).getByLabelText('Mark accepted')).toBeInTheDocument();
    expect(within(sent).getByLabelText('Mark declined')).toBeInTheDocument();
    expect(within(sent).queryByLabelText('Delete draft')).toBeNull();
    expect(within(draft).getByLabelText('Delete draft')).toBeInTheDocument();
    expect(within(draft).queryByLabelText('Mark accepted')).toBeNull();
  });

  it('shows an expiry countdown for a sent proposal only', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000);
    const iso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    rows = [{ ...base, validUntil: iso }, { ...base, id: 'pr2', number: 2, status: 'sent', validUntil: iso }];
    renderList();

    await screen.findByTestId('proposal-row-2');
    expect(within(screen.getByTestId('proposal-row-2')).getByText('expires in 3 days')).toBeInTheDocument();
    expect(within(screen.getByTestId('proposal-row-1')).queryByText('expires in 3 days')).toBeNull();
  });

  it('creates a blank proposal and opens its editor', async () => {
    renderList();
    await screen.findByTestId('proposal-row-1');
    fireEvent.click(screen.getByTestId('btn-new-proposal'));
    await waitFor(() => expect(createProposal).toHaveBeenCalledWith('p1', {}));
    await screen.findByText('editor');
  });

  it('seeds a new proposal with this user\'s last-used document options', async () => {
    userPrefs = {
      'proposal-fontFamily': 'times',
      'proposal-highlightQuality': 'email',
      'proposal-includeCostDetail': 'true',
      'proposal-includeSignature': 'false',
      'proposal-showGrandTotal': 'false',
      'proposal-coverNotes-history': JSON.stringify(['Thanks for the opportunity', 'older']),
      'proposal-terms-history': JSON.stringify(['Net 30']),
    };
    renderList();
    await screen.findByTestId('proposal-row-1');
    fireEvent.click(screen.getByTestId('btn-new-proposal'));
    await waitFor(() => expect(createProposal).toHaveBeenCalledWith('p1', {
      fontFamily: 'times',
      highlightQuality: 'email',
      includeCostDetail: true,
      includeSignature: false,
      showGrandTotal: false,
      // the boilerplate this user last wrote is prefilled too
      coverNotes: 'Thanks for the opportunity',
      terms: 'Net 30',
    }));
  });

  it('confirms before deleting a draft', async () => {
    renderList();
    const draft = await screen.findByTestId('proposal-row-1');
    fireEvent.click(within(draft).getByLabelText('Delete draft'));
    const dialog = await screen.findByRole('dialog', { name: 'Delete draft?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteProposal).toHaveBeenCalledWith('pr1'));
  });

  it('declines a sent proposal only after confirmation', async () => {
    renderList();
    const sent = await screen.findByTestId('proposal-row-2');
    fireEvent.click(within(sent).getByLabelText('Mark declined'));
    const dialog = await screen.findByRole('dialog', { name: 'Mark declined?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark declined' }));
    await waitFor(() => expect(setProposalStatus).toHaveBeenCalledWith('pr2', 'declined'));
  });

  // Legacy rows (migration 28) are read-only history: Open PDF + Revise only
  // (spec §5). The server refuses setStatus on them, so the buttons must go.
  it('hides accept/decline on a legacy row even though it is sent', async () => {
    rows = [{ ...base, id: 'pr9', number: 9, status: 'sent', legacy: true, sentAt: 1 }];
    renderList();
    const legacy = await screen.findByTestId('proposal-row-9');
    expect(legacy).toHaveTextContent('(legacy)');
    expect(within(legacy).queryByLabelText('Mark accepted')).toBeNull();
    expect(within(legacy).queryByLabelText('Mark declined')).toBeNull();
    // Revise is still offered — that's the way forward from a legacy row.
    expect(within(legacy).getByLabelText('Revise')).toBeInTheDocument();
  });

  // AcceptDialog only offers the prefill when it counted lines, so this
  // branch is the race: the proposal was emptied between the dialog's count
  // and the accept. Silence there reads as "the SOV was filled".
  it('says so instead of silently doing nothing when there are no lines to prefill the SOV with', async () => {
    const line = { id: 'l1', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'Stucco', amountCents: 100, derivedAmountCents: null, measurementSummary: null, isAlternate: false };
    vi.mocked(getProposal)
      .mockResolvedValueOnce({ ...rows[1], lines: [line], photos: [], attachments: [] } as any)
      .mockResolvedValue({ ...rows[1], lines: [], photos: [], attachments: [] } as any);
    renderList();
    const sent = await screen.findByTestId('proposal-row-2');
    fireEvent.click(within(sent).getByLabelText('Mark accepted'));
    // wait for the dialog's line count to land, so the prefill box is ticked
    await screen.findByLabelText(/Prefill the schedule of values/);
    fireEvent.click(await screen.findByTestId('confirm-accept'));

    expect(await screen.findByText('No price lines to prefill')).toBeInTheDocument();
    expect(createSovLine).not.toHaveBeenCalled();
  });

  it('redirects a non-admin back to the project', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u2', role: 'user' }));
    renderList();
    expect(await screen.findByText('project overview')).toBeInTheDocument();
  });

  it('Open PDF and Signed copy open the preview modal (not the editor) with the file metadata', async () => {
    rows = [{ ...base, status: 'sent', fileId: 'f-pdf', signedFileId: 'f-signed' }];
    renderList();
    fireEvent.click(await screen.findByLabelText('Open PDF'));
    await waitFor(() => expect(viewerOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f-pdf', name: 'f-pdf.pdf', mime: 'application/pdf', versionNumber: 2 }), 'proposal', 'p1'));
    expect(getFileMeta).toHaveBeenCalledWith('f-pdf');
    fireEvent.click(screen.getByLabelText('Signed copy'));
    await waitFor(() => expect(viewerOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'f-signed' }), 'proposal-signed', 'p1'));
    expect(screen.getByTestId('viewer-modal-mock')).toBeInTheDocument();
  });
});
