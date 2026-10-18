// src/pages/project/proposal/ProposalEditor.test.tsx
//
// Document delivery is no longer the editor's job: DocumentActionsBar owns
// Generate / Open / Download / Email (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout). What stays the
// editor's job — and is what these tests pin — is the wiring it hands the bar:
// a build() that renders the on-screen draft, an onGenerated that keeps
// proposals.fileId in sync WITHOUT throwing away the open draft, and a sendFn
// that reports the "already sent" lock.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import { ToastProvider } from '../../../components/Toast';
import type { FileUploadOpts, GeneratedDoc, ProposalSaveInput } from '../../../utils/store';
import type { BuildProposalPdfArgs } from './buildProposalPdf';

const proposal = {
  id: 'p1', projectId: 'proj1', number: 2, revisedFromId: null, revisedFromNumber: null,
  status: 'draft', legacy: false, title: 'Stucco package', validUntil: null,
  fontFamily: 'helvetica', coverNotes: 'Hello', terms: 'Net 30',
  inclusions: ['Scaffolding'], exclusions: ['Paint'], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: true, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 3, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 1000000, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
  lines: [{ id: 'l1', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'Mobilization', amountCents: 1000000, derivedAmountCents: null, measurementSummary: null, isAlternate: false }],
  photos: [], attachments: [],
};

const storedDoc = (over: Partial<GeneratedDoc> = {}): GeneratedDoc => ({
  id: 'f-existing', name: 'Proposal – Test.pdf', mime: 'application/pdf', size: 3,
  createdAt: 5, versionNumber: 1, ...over,
});

const saveProposal = vi.fn(async (_id: string, _input: ProposalSaveInput) => ({ version: 4, updatedAt: 500 }));
const saveUserPreferences = vi.fn(async (_prefs: Record<string, string>) => {});
const getProposal = vi.fn(async () => proposal);
const getProject = vi.fn(async (_id: string) => ({
  id: 'proj1', name: 'Test', pages: [], takeoffs: [], planSets: [],
  contactEmails: { estimating: { to: 'client@example.com' } },
}));
const persistGeneratedDocument = vi.fn(async (_blob: Blob, _opts: FileUploadOpts & { kind: string; name: string }) => ({ fileId: 'f-generated', versioned: false }));
const setProposalFile = vi.fn(async (_id: string, _fileId: string) => {});
const sendProposal = vi.fn(async (_id: string, _payload: { to: string; fileId: string; html?: string; attachmentFileIds?: string[] }) => ({ version: 5 }));
const getDocumentBySource = vi.fn(async (_q: { sourceType: string; sourceId: string; kind: string }): Promise<GeneratedDoc | null> => null);

vi.mock('../../../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/store')>('../../../utils/store');
  return {
    ...actual,
    getProposal,
    getProject,
    getUserPreferences: vi.fn(async () => ({ 'proposal-manualLine-history': JSON.stringify([{ description: 'Permit', amountCents: 25000 }]) })),
    saveProposal,
    saveUserPreferences,
    persistGeneratedDocument,
    setProposalFile,
    sendProposal,
    getDocumentBySource,
    getDocumentsBySource: vi.fn(async () => ({})),
    getDocumentTypes: vi.fn(async () => []),
    fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
    getFileMeta: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({ companyEmail: 'office@birchwood.test' })),
    getMailAccounts: vi.fn(async () => [{ id: 'a1', provider: 'fake', emailAddress: 'me@birchwood.test', displayName: null, isDefault: 1, status: 'ok', unreadCount: 0 }]),
    getAlwaysCc: vi.fn(async () => ''),
    getCustomer: vi.fn(async () => undefined),
  };
});

// The bar's useLiveQuery reaches for the collaboration socket, which throws
// outside a provider (unlike useCollabEditing, which degrades on its own).
vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

// The real mail composer renders here (this is the one send site tested
// end-to-end), so its API surface has to answer: no other mailbox holds this
// proposal's thread, and the recipient index is empty.
vi.mock('../../../utils/mailApi', () => ({
  mailApi: {
    accounts: vi.fn(async () => [
      { id: 'a1', provider: 'fake', emailAddress: 'me@birchwood.test', displayName: null, signatureHtml: null,
        isDefault: 1, status: 'ok', lastSyncAt: null, lastError: null, indexedSince: '', unreadCount: 0 },
    ]),
    links: vi.fn(async () => []),
    thread: vi.fn(async () => { throw new Error('not found'); }),
    recipients: vi.fn(async () => []),
    stageUpload: vi.fn(async () => ({ uploadId: 'u1' })),
  },
}));

// Opening a document is the viewer's business, exercised by its own tests.
vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

// The renderer itself is exercised by proposalGenerator.layout.test.ts; here
// only the pipeline around it matters.
const buildProposalPdf = vi.fn(async (_args: BuildProposalPdfArgs) => ({
  pdfBytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
  suggestedName: 'Proposal – Test – 2026-08-28',
  overBudget: false,
  sections: {},
}));
vi.mock('./buildProposalPdf', () => ({ buildProposalPdf }));

// Imported dynamically, not statically: a static import is evaluated before
// this file's `const proposal` runs, and the store mock's factory closes over
// it. Awaiting the import here means the fixture is initialised first.
const { ProposalEditor } = await import('./ProposalEditor');

const { ProposalLockedError } = await import('../../../utils/store');
const { proposalFileName } = await import('./proposalGenerator');

// The bar names the stored document after the project + today's date, so the
// expectation is derived the same way rather than frozen to one day.
const expectedFileName = () =>
  `${proposalFileName({ name: 'Test' } as Parameters<typeof proposalFileName>[0])}.pdf`;

const renderEditor = () => render(
  <ToastProvider>
    <ConfirmProvider>
      <MemoryRouter initialEntries={['/project/proj1/proposal/p1']}>
        <Routes><Route path="/project/:projectId/proposal/:proposalId" element={<ProposalEditor />} /></Routes>
      </MemoryRouter>
    </ConfirmProvider>
  </ToastProvider>,
);

describe('ProposalEditor smoke', () => {
  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify({ role: 'admin' }));
    saveProposal.mockClear();
    getProject.mockClear();
    getProposal.mockClear();
    getProposal.mockImplementation(async () => proposal);
    buildProposalPdf.mockClear();
    persistGeneratedDocument.mockClear();
    setProposalFile.mockClear();
    sendProposal.mockClear();
    getDocumentBySource.mockClear();
    getDocumentBySource.mockImplementation(async () => null);
  });

  it('mounts, edits, and saves', async () => {
    renderEditor();
    expect(await screen.findByText('#2')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-state')).toHaveTextContent('Saved');
    expect(screen.getByTestId('pricing-total')).toHaveTextContent('$10,000.00');
    // library select from prefs
    expect(await screen.findByLabelText('From library')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'New notes' } });
    expect(screen.getByTestId('proposal-state')).toHaveTextContent('Unsaved changes');
    fireEvent.click(screen.getByTestId('btn-save-proposal'));
    await waitFor(() => expect(saveProposal).toHaveBeenCalled());
    expect(saveProposal.mock.calls[0][1]).toMatchObject({
      version: 3, coverNotes: 'New notes', inclusions: ['Scaffolding'], exclusions: ['Paint'],
      lines: [{ kind: 'manual', description: 'Mobilization', amountCents: 1000000 }],
    });
    await waitFor(() => expect(screen.getByTestId('proposal-state')).toHaveTextContent('Saved'));
    await waitFor(() => expect(saveUserPreferences).toHaveBeenCalled());
    expect(saveUserPreferences.mock.calls[0][0]).toMatchObject({
      'proposal-coverNotes-history': JSON.stringify(['New notes']),
      'proposal-manualLine-history': JSON.stringify([{ description: 'Mobilization', amountCents: 1000000 }, { description: 'Permit', amountCents: 25000 }]),
      'proposal-showGrandTotal': 'true',
    });
    // no takeoff lines => no highlights option
    expect(screen.queryByLabelText('Attach highlighted plan pages')).not.toBeInTheDocument();
  });

  it('mounts the shared document bar and drops its own Generate / Open / Send buttons', async () => {
    renderEditor();
    expect(await screen.findByTestId('proposal-generate')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-send')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-status')).toHaveTextContent('No PDF yet');
    expect(screen.queryByTestId('btn-generate-proposal')).toBeNull();
    expect(screen.queryByTestId('btn-send-proposal')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open PDF/i })).toBeNull();
    // Save stays the editor's own.
    expect(screen.getByTestId('btn-save-proposal')).toBeInTheDocument();
  });

  it('does not flag every takeoff line as missing when the project fetch fails', async () => {
    const takeoffLine = {
      id: 'l2', sortOrder: 1, kind: 'takeoff', takeoffId: 't1', description: 'Stucco',
      amountCents: 500000, derivedAmountCents: 500000, measurementSummary: '5,000.00 sq ft', isAlternate: false,
    };
    proposal.lines.push(takeoffLine as (typeof proposal)['lines'][number]);
    getProject.mockRejectedValueOnce(new Error('offline'));
    try {
      render(
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={['/project/proj1/proposal/p1']}>
              <Routes><Route path="/project/:projectId/proposal/:proposalId" element={<ProposalEditor />} /></Routes>
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>,
      );
      expect(await screen.findByText('#2')).toBeInTheDocument();
      expect(screen.queryByText(/no longer exists/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Remove line/ })).not.toBeInTheDocument();
      expect(await screen.findByText(/amounts not refreshed/i)).toBeInTheDocument();
      // Nothing was re-derived, so there is nothing to save.
      expect(screen.getByTestId('proposal-state')).toHaveTextContent('Saved');
      // No project means no takeoffs to price and nothing to address an email
      // to, so the bar is replaced by the reason rather than offered broken.
      expect(screen.queryByTestId('proposal-generate')).toBeNull();
      expect(screen.getByTestId('proposal-doc-blocked')).toHaveTextContent(/Couldn't load the project/);
    } finally {
      proposal.lines.pop();
    }
  });

  it('payment schedule toggles and inclusions edit', async () => {
    renderEditor();
    await screen.findByText('#2');
    fireEvent.click(screen.getByLabelText('Include payment schedule'));
    fireEvent.click(screen.getByRole('button', { name: /Add row/ }));
    expect(screen.getByTestId('schedule-total')).toHaveTextContent('$10,000.00');
    fireEvent.change(screen.getByLabelText('Percent'), { target: { value: '40' } });
    expect(screen.getByTestId('schedule-total')).toHaveTextContent('$4,000.00');
    expect(screen.getByText(/not 100%/)).toBeInTheDocument();

    const inc = screen.getByTestId('proposal-inclusions');
    fireEvent.change(inc, { target: { value: 'Scaffolding\n' } });
    expect((inc as HTMLTextAreaElement).value).toBe('Scaffolding\n');
  });

  it('Generate saves the draft first, then stores the PDF as the proposal document', async () => {
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'Ready to print' } });

    fireEvent.click(screen.getByTestId('proposal-generate'));
    await waitFor(() => expect(setProposalFile).toHaveBeenCalledWith('p1', 'f-generated'));

    // Save-first is the whole contract: the client receives exactly what was
    // stored, never a PDF of edits that failed to save.
    expect(saveProposal.mock.invocationCallOrder[0])
      .toBeLessThan(buildProposalPdf.mock.invocationCallOrder[0]);
    const rendered = buildProposalPdf.mock.calls[0][0];
    expect(rendered.proposal.coverNotes).toBe('Ready to print');
    expect(rendered.includeHighlights).toBe(false);
    expect(rendered.headerEmail).toBeUndefined();
    expect(persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'proj1', kind: 'proposal', name: expectedFileName(),
      sourceType: 'proposal', sourceId: 'p1',
    });
    expect(await screen.findByText('PDF generated')).toBeInTheDocument();
  });

  it('re-reads the proposal after Generate without replacing the open draft', async () => {
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'Ready to print' } });
    // Anything that rebuilds the draft from this response would show up on
    // screen — the media-only resync must not.
    getProposal.mockImplementation(async () => ({ ...proposal, coverNotes: 'SERVER NOTES', fileId: 'f-generated' }));

    fireEvent.click(screen.getByTestId('proposal-generate'));
    await waitFor(() => expect(setProposalFile).toHaveBeenCalledWith('p1', 'f-generated'));
    // The record is re-read so proposals.fileId is live locally…
    await waitFor(() => expect(getProposal).toHaveBeenCalledTimes(2));
    // …but the estimator's editor is untouched.
    expect(screen.getByLabelText('Cover notes')).toHaveValue('Ready to print');
    expect(screen.getByTestId('proposal-state')).toHaveTextContent('Saved');
  });

  it('a Save after Generate makes the stored PDF stale, so Send rebuilds', async () => {
    // The regression this pins: the editor used to keep the pre-save
    // updatedAt, so the chip still read "up to date" after an edit and Send
    // happily emailed the PDF of the OLD price.
    getDocumentBySource.mockImplementation(async () => storedDoc({ createdAt: 100 }));
    renderEditor();
    await screen.findByText('#2');
    await waitFor(() => expect(screen.getByTestId('proposal-status')).toHaveTextContent('PDF up to date'));

    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'Revised price' } });
    fireEvent.click(screen.getByTestId('btn-save-proposal'));
    // saveProposal returns updatedAt 500, which is newer than the document.
    await waitFor(() => expect(screen.getByTestId('proposal-status')).toHaveTextContent('PDF out of date'));

    fireEvent.click(screen.getByTestId('proposal-send'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByTestId('recipient-pill')).toHaveTextContent('client@example.com'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendProposal).toHaveBeenCalled());
    expect(buildProposalPdf).toHaveBeenCalledTimes(1);
    expect(buildProposalPdf.mock.calls[0][0].proposal.coverNotes).toBe('Revised price');
    expect(sendProposal.mock.calls[0][1]).toMatchObject({ fileId: 'f-generated' });
  });

  it('Generate during an in-flight save waits for it instead of reporting a failure', async () => {
    let release = () => {};
    saveProposal.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve({ version: 4, updatedAt: 500 }); }));
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'in flight' } });
    fireEvent.click(screen.getByTestId('btn-save-proposal'));
    await waitFor(() => expect(screen.getByTestId('btn-save-proposal')).toHaveTextContent('Saving…'));

    fireEvent.click(screen.getByTestId('proposal-generate'));
    await act(async () => { release(); });

    await waitFor(() => expect(setProposalFile).toHaveBeenCalledWith('p1', 'f-generated'));
    // One write, not two, and no "Save failed" for a save that succeeded.
    expect(saveProposal).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Save failed — nothing generated')).toBeNull();
  });

  it('persists text typed during an in-flight save before Generate renders it', async () => {
    let release = () => {};
    saveProposal.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve({ version: 4, updatedAt: 500 }); }));
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'A' } });
    fireEvent.click(screen.getByTestId('btn-save-proposal'));
    await waitFor(() => expect(screen.getByTestId('btn-save-proposal')).toHaveTextContent('Saving…'));

    // Typing continues while A is going out, then Generate saves-first. Letting
    // A's write satisfy that would store a PDF of A+B against a record of A.
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'A+B' } });
    fireEvent.click(screen.getByTestId('proposal-generate'));
    await act(async () => { release(); });

    await waitFor(() => expect(setProposalFile).toHaveBeenCalledWith('p1', 'f-generated'));
    expect(saveProposal).toHaveBeenCalledTimes(2);
    expect(saveProposal.mock.calls[1][1]).toMatchObject({ version: 4, coverNotes: 'A+B' });
    // The stored PDF and the stored record say the same thing.
    expect(buildProposalPdf.mock.calls[0][0].proposal.coverNotes).toBe('A+B');
  });

  it('a save that bounces off a lock aborts the generate', async () => {
    saveProposal.mockRejectedValueOnce(new ProposalLockedError());
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'Too late' } });

    fireEvent.click(screen.getByTestId('proposal-generate'));
    await waitFor(() => expect(saveProposal).toHaveBeenCalled());
    expect(await screen.findByText(/no longer a draft/)).toBeInTheDocument();
    expect(await screen.findByText('Save failed — nothing generated')).toBeInTheDocument();
    expect(buildProposalPdf).not.toHaveBeenCalled();
    expect(setProposalFile).not.toHaveBeenCalled();
  });

  it('Send needs no prior Generate, and stays available while the draft is dirty', async () => {
    renderEditor();
    await screen.findByText('#2');
    // Send renders its own PDF, so a proposal with no document is still sendable.
    expect(proposal.fileId).toBeNull();
    expect(await screen.findByTestId('proposal-send')).toBeEnabled();

    // A pending edit is committed by Send itself (spec §2), not a blocker.
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'edited' } });
    const send = screen.getByTestId('proposal-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
  });

  const openComposer = async () => {
    renderEditor();
    await screen.findByText('#2');
    fireEvent.click(await screen.findByTestId('proposal-send'));
    const dialog = await screen.findByRole('dialog');
    // The composer holds recipients as pills, seeded from the project's
    // estimating contact — proof the prefill survived the conversion.
    await waitFor(() => expect(within(dialog).getByTestId('recipient-pill')).toHaveTextContent('client@example.com'));
    return dialog;
  };

  it('emails the stored document when it is already current', async () => {
    // createdAt 5 >= updatedAt 0: the document on file IS the record, so
    // re-rendering it would only burn time and bump the version.
    getDocumentBySource.mockImplementation(async () => storedDoc());
    const dialog = await openComposer();
    await waitFor(() => expect(screen.getByTestId('proposal-status')).toHaveTextContent('PDF up to date'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendProposal).toHaveBeenCalled());
    expect(buildProposalPdf).not.toHaveBeenCalled();
    expect(persistGeneratedDocument).not.toHaveBeenCalled();
    expect(sendProposal.mock.calls[0]).toMatchObject(['p1', {
      to: 'client@example.com', fileId: 'f-existing', attachmentFileIds: [],
    }]);
    // The prefilled plain-text body reached the route as the composer's html —
    // the whole point of routing item sends through the mail composer.
    expect(sendProposal.mock.calls[0][1].html).toContain('Please find our proposal attached');
    expect(await screen.findByText('Sent')).toBeInTheDocument();
  });

  it('rebuilds before sending when the stored document is older than the proposal', async () => {
    proposal.updatedAt = 999;
    getDocumentBySource.mockImplementation(async () => storedDoc());
    try {
      const dialog = await openComposer();
      await waitFor(() => expect(screen.getByTestId('proposal-status')).toHaveTextContent('PDF out of date'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

      // A document already exists: the rebuild becomes its next version.
      await waitFor(() => expect(sendProposal).toHaveBeenCalled());
      expect(buildProposalPdf).toHaveBeenCalledTimes(1);
      expect(persistGeneratedDocument.mock.calls[0][1]).not.toHaveProperty('mode');
      expect(setProposalFile).toHaveBeenCalledWith('p1', 'f-generated');
      expect(buildProposalPdf.mock.invocationCallOrder[0])
        .toBeLessThan(sendProposal.mock.invocationCallOrder[0]);
      // The fresh document goes out — never the stale one on the record.
      expect(sendProposal.mock.calls[0]).toMatchObject(['p1', {
        to: 'client@example.com', fileId: 'f-generated', attachmentFileIds: [],
      }]);
    } finally {
      proposal.updatedAt = 0;
    }
  });

  it('stamps the from-address the sender picked onto that PDF', async () => {
    const dialog = await openComposer();
    fireEvent.change(within(dialog).getByLabelText('Document shows email:'), { target: { value: 'me@birchwood.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendProposal).toHaveBeenCalled());
    expect(buildProposalPdf.mock.calls[0][0]).toMatchObject({ headerEmail: 'me@birchwood.test' });
    expect(sendProposal.mock.calls[0][1]).toMatchObject({ fileId: 'f-generated' });
  });

  it('a render that fails aborts the send instead of emailing the old PDF', async () => {
    proposal.updatedAt = 999;
    getDocumentBySource.mockImplementation(async () => storedDoc());
    buildProposalPdf.mockRejectedValueOnce(new Error('render blew up'));
    try {
      const dialog = await openComposer();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

      expect(await screen.findByText('Failed to generate the PDF — nothing sent')).toBeInTheDocument();
      expect(sendProposal).not.toHaveBeenCalled();
      // The composer stays open so the send can be retried.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    } finally {
      proposal.updatedAt = 0;
    }
  });

  it('reports the already-sent lock instead of claiming the email went out', async () => {
    // A current document keeps this test on the lock path alone — no rebuild,
    // so the only re-read of the record is the one the lock triggers.
    getDocumentBySource.mockImplementation(async () => storedDoc());
    sendProposal.mockRejectedValueOnce(new ProposalLockedError());
    const dialog = await openComposer();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/revise it to send again/)).toBeInTheDocument();
    expect(screen.queryByText('Sent')).toBeNull();
    // Reloaded, so the editor picks up whatever the record now is.
    await waitFor(() => expect(getProposal).toHaveBeenCalledTimes(2));
  });

  it('blocks Send when the draft has no price lines', async () => {
    const savedLines = proposal.lines;
    proposal.lines = [];
    try {
      renderEditor();
      await screen.findByText('#2');
      expect(await screen.findByTestId('proposal-send')).toBeDisabled();
      expect(screen.getByTestId('proposal-send')).toHaveAttribute('title', 'Add at least one price line');
    } finally {
      proposal.lines = savedLines;
    }
  });

  it('disables Generate while a send is rendering its own PDF, re-enabling once it settles', async () => {
    let release = () => {};
    buildProposalPdf.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({
        pdfBytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
        suggestedName: 'Proposal – Test – 2026-08-28', overBudget: false, sections: {},
      });
    }));
    const dialog = await openComposer();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByTestId('proposal-generate')).toBeDisabled());
    await act(async () => { release(); });
    await waitFor(() => expect(sendProposal).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('proposal-generate')).toBeEnabled());
  });
});
