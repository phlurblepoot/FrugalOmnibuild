import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviseDialog } from './ReviseDialog';
import type { ProposalSummary } from '../../../utils/store';

const proposal = (over: Partial<ProposalSummary> = {}): ProposalSummary => ({
  id: 'pr1', projectId: 'p1', number: 2, revisedFromId: 'pr0', revisedFromNumber: 1,
  status: 'sent', legacy: false, title: 'Stucco', validUntil: null,
  fontFamily: null, coverNotes: null, terms: null, inclusions: [], exclusions: [], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: true, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 100_00, alternateCount: 0, hasOverride: false, photoCount: 3, attachmentCount: 2,
  ...over,
});

describe('ReviseDialog', () => {
  it('defaults both carry-overs on and confirms with them', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ReviseDialog open source={proposal()} onClose={() => {}} onConfirm={onConfirm} />);

    expect(screen.getByLabelText('Bring over photos (3)')).toBeChecked();
    expect(screen.getByLabelText('Bring over attachments (2)')).toBeChecked();
    fireEvent.click(screen.getByTestId('confirm-revise'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ carryPhotos: true, carryAttachments: true }));
  });

  it('disables an empty set and never carries it over', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ReviseDialog open source={proposal({ photoCount: 0, attachmentCount: 4 })} onClose={() => {}} onConfirm={onConfirm} />);

    const photos = screen.getByLabelText('Bring over photos (0)');
    expect(photos).toBeDisabled();
    expect(photos).not.toBeChecked();
    expect(screen.getByLabelText('Bring over attachments (4)')).toBeEnabled();

    fireEvent.click(screen.getByTestId('confirm-revise'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ carryPhotos: false, carryAttachments: true }));
  });

  it('passes an unticked box through as false', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ReviseDialog open source={proposal()} onClose={() => {}} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Bring over attachments (2)'));
    expect(screen.getByLabelText('Bring over attachments (2)')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('confirm-revise'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ carryPhotos: true, carryAttachments: false }));
  });

  it('names the proposal being revised', () => {
    render(<ReviseDialog open source={proposal()} onClose={() => {}} onConfirm={async () => {}} />);
    expect(screen.getByText(/#2 \(rev\. of #1\)/)).toBeInTheDocument();
  });
});
