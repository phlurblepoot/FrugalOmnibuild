import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/Toast';
import type { Proposal } from '../../../utils/store';

vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  addProposalAttachment: vi.fn(async () => {}),
  updateProposalAttachment: vi.fn(async () => {}),
  removeProposalAttachment: vi.fn(async () => {}),
  uploadProjectFile: vi.fn(async () => ({ fileId: 'f-new', versioned: false })),
  getDocuments: vi.fn(async () => ({
    rows: [
      { id: 'f-pick', name: 'spec-sheet.pdf', mime: 'application/pdf', size: 204800, kind: 'other', createdAt: 0, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null },
      { id: 'f-pick2', name: 'terms.pdf', mime: 'application/pdf', size: 51200, kind: 'other', createdAt: 0, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null },
    ],
    total: 2,
  })),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
}));
import { addProposalAttachment, removeProposalAttachment, updateProposalAttachment, uploadProjectFile, ProposalLockedError } from '../../../utils/store';
import { ProposalAttachmentsCard } from './ProposalAttachmentsCard';

const proposal = {
  id: 'pr1', projectId: 'p1',
  attachments: [
    { id: 'a1', fileId: 'f1', sortOrder: 0, name: 'warranty.pdf', mime: 'application/pdf', size: 51200 },
    { id: 'a2', fileId: 'f2', sortOrder: 1, name: 'brochure.pdf', mime: 'application/pdf', size: 102400 },
  ],
} as unknown as Proposal;

const renderCard = (readOnly = false, onChanged = vi.fn()) => {
  render(
    <ToastProvider>
      <ProposalAttachmentsCard proposal={proposal} projectId="p1" readOnly={readOnly} onChanged={onChanged} />
    </ToastProvider>
  );
  return onChanged;
};

beforeEach(() => { vi.clearAllMocks(); });

describe('ProposalAttachmentsCard', () => {
  it('renders attachments from props', () => {
    renderCard();
    expect(screen.getByText('warranty.pdf')).toBeInTheDocument();
    expect(screen.getByText('brochure.pdf')).toBeInTheDocument();
    expect(screen.getByText('50 KB')).toBeInTheDocument();
  });

  it('hides the toolbar when read-only', () => {
    renderCard(true);
    expect(screen.queryByRole('button', { name: /Add PDFs/i })).toBeNull();
  });

  // One button now covers both "upload a new PDF" and "reuse an existing
  // one" — and nothing behind it is a bare file input any more.
  it('offers a single Add PDFs button and no hidden file input', () => {
    const { container } = render(
      <ToastProvider>
        <ProposalAttachmentsCard proposal={proposal} projectId="p1" readOnly={false} onChanged={vi.fn()} />
      </ToastProvider>
    );
    expect(screen.getByRole('button', { name: /Add PDFs/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose existing/i })).toBeNull();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it('a dropped PDF is uploaded into the project, attached, then resynced', async () => {
    const onChanged = renderCard();
    const pdf = new File(['x'], 'spec.pdf', { type: 'application/pdf' });
    fireEvent.drop(screen.getByTestId('proposal-attachments'), { dataTransfer: { files: [pdf] } });

    await waitFor(() => expect(uploadProjectFile).toHaveBeenCalledWith('p1', pdf, 'document', expect.anything()));
    await waitFor(() => expect(addProposalAttachment).toHaveBeenCalledWith('pr1', 'f-new'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a drop on a locked proposal says why instead of uploading', async () => {
    renderCard(true);
    fireEvent.drop(screen.getByTestId('proposal-attachments'), {
      dataTransfer: { files: [new File(['x'], 'spec.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByText('This proposal was sent and is now locked');
    expect(uploadProjectFile).not.toHaveBeenCalled();
  });

  it('remove calls the mocked API and reloads', async () => {
    const onChanged = renderCard();
    fireEvent.click(screen.getAllByLabelText('Remove attachment')[0]);
    await waitFor(() => expect(removeProposalAttachment).toHaveBeenCalledWith('pr1', 'f1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('the picker\'s Existing tab attaches each picked row', async () => {
    const onChanged = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    const checkbox = await screen.findByLabelText('spec-sheet.pdf');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/i }));
    await waitFor(() => expect(addProposalAttachment).toHaveBeenCalledWith('pr1', 'f-pick'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a partial add failure toasts a warning but still resyncs', async () => {
    const onChanged = renderCard();
    vi.mocked(addProposalAttachment)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('nope'); });
    fireEvent.click(screen.getByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    fireEvent.click(await screen.findByLabelText('spec-sheet.pdf'));
    fireEvent.click(screen.getByLabelText('terms.pdf'));
    fireEvent.click(screen.getByRole('button', { name: /Add 2 files/i }));
    await screen.findByText('Added 1 of 2 files');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reorder: swaps sortOrder via two PATCHes on the proposal id', async () => {
    const onChanged = renderCard();
    fireEvent.click(screen.getAllByLabelText('Move down')[0]);
    await waitFor(() => expect(updateProposalAttachment).toHaveBeenCalledTimes(2));
    // First arg is the PROPOSAL id, not the attachment row id — the API route
    // is /api/proposals/:id/attachments/:fileId, so a row id 404s.
    expect(vi.mocked(updateProposalAttachment).mock.calls[0]).toEqual(['pr1', 'f1', { sortOrder: 1 }]);
    expect(vi.mocked(updateProposalAttachment).mock.calls[1]).toEqual(['pr1', 'f2', { sortOrder: 0 }]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reorder: if the second PATCH fails, toasts and still resyncs via onChanged', async () => {
    const onChanged = renderCard();
    vi.mocked(updateProposalAttachment)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('boom'); });
    fireEvent.click(screen.getAllByLabelText('Move down')[0]);
    await screen.findByText('Failed to reorder attachments');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('remove: a locked proposal toasts a warning and still reloads into read-only', async () => {
    const onChanged = renderCard();
    vi.mocked(removeProposalAttachment).mockRejectedValueOnce(new ProposalLockedError());
    fireEvent.click(screen.getAllByLabelText('Remove attachment')[0]);
    await screen.findByText('This proposal was sent and is now locked');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
