import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/Toast';
import type { ProposalSummary } from '../../../utils/store';

vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  getProposal: vi.fn(async () => ({ ...proposal, lines })),
  uploadProjectFile: vi.fn(async () => ({ fileId: 'f-signed', versioned: false })),
  getDocuments: vi.fn(async () => ({ rows: [], total: 0 })),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
}));
import { uploadProjectFile } from '../../../utils/store';
import { AcceptDialog } from './AcceptDialog';

const proposal: ProposalSummary = {
  id: 'pr1', projectId: 'p1', number: 3, revisedFromId: null, revisedFromNumber: null,
  status: 'sent', legacy: false, title: 'Base bid', validUntil: null,
  fontFamily: null, coverNotes: null, terms: null, inclusions: [], exclusions: [], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: true, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 0, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
};
const line = (over: Record<string, unknown>) => ({
  id: 'l', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'Work',
  amountCents: 100, derivedAmountCents: null, measurementSummary: null, isAlternate: false, ...over,
});
let lines: ReturnType<typeof line>[] = [];

const renderDialog = (onConfirm = vi.fn(async () => {})) => {
  render(
    <ToastProvider>
      <AcceptDialog open proposal={proposal} projectId="p1" onClose={() => {}} onConfirm={onConfirm} />
    </ToastProvider>
  );
  return onConfirm;
};

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'admin' }));
  vi.clearAllMocks();
  lines = [line({ id: 'a' }), line({ id: 'b' }), line({ id: 'c', isAlternate: true })];
});

describe('AcceptDialog', () => {
  it('counts only non-alternate lines and confirms with the prefill on by default', async () => {
    const onConfirm = renderDialog();
    const box = await screen.findByLabelText("Prefill the schedule of values from this proposal's 2 lines");
    expect(box).toBeChecked();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ signedFileId: null, prefillSov: true }));
  });

  it('disables the prefill when the proposal has no billable lines', async () => {
    lines = [line({ id: 'c', isAlternate: true })];
    const onConfirm = renderDialog();
    const box = await screen.findByLabelText("Prefill the schedule of values from this proposal's 0 lines");
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ signedFileId: null, prefillSov: false }));
  });

  it('uploads a signed copy, shows it, and can clear it again', async () => {
    const onConfirm = renderDialog();
    await screen.findByLabelText("Prefill the schedule of values from this proposal's 2 lines");

    const file = new File(['%PDF-'], 'countersigned.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Upload signed PDF'), { target: { files: [file] } });
    await screen.findByText('countersigned.pdf');
    expect(uploadProjectFile).toHaveBeenCalledWith('p1', file, 'proposal-signed', { sourceType: 'proposal', sourceId: 'pr1' });

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ signedFileId: 'f-signed', prefillSov: true }));

    fireEvent.click(screen.getByLabelText('Remove signed copy'));
    expect(screen.queryByText('countersigned.pdf')).toBeNull();
  });

  it('unticking the prefill is passed through', async () => {
    const onConfirm = renderDialog();
    fireEvent.click(await screen.findByLabelText("Prefill the schedule of values from this proposal's 2 lines"));
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ signedFileId: null, prefillSov: false }));
  });
});
