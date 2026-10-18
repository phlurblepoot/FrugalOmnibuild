import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/Toast';
import type { Proposal } from '../../../utils/store';

vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  addProposalPhoto: vi.fn(async () => {}),
  updateProposalPhoto: vi.fn(async () => {}),
  removeProposalPhoto: vi.fn(async () => {}),
  uploadProjectFile: vi.fn(async () => ({ fileId: 'f-new', versioned: false })),
  getDocuments: vi.fn(async () => ({
    rows: [
      { id: 'f-pick', name: 'site.jpg', mime: 'image/jpeg', size: 1024, kind: 'other', createdAt: 0, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Test', customerId: null, customerName: null, source: null },
      { id: 'f-pick2', name: 'site2.jpg', mime: 'image/jpeg', size: 2048, kind: 'other', createdAt: 0, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Test', customerId: null, customerName: null, source: null },
    ],
    total: 2,
  })),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
}));
import { addProposalPhoto, removeProposalPhoto, updateProposalPhoto, uploadProjectFile, ProposalLockedError } from '../../../utils/store';
import { ProposalPhotosCard } from './ProposalPhotosCard';

const proposal = {
  id: 'pr1', projectId: 'p1',
  photos: [
    { id: 'ph1', fileId: 'f1', sortOrder: 0, caption: 'Front porch' },
    { id: 'ph2', fileId: 'f2', sortOrder: 1, caption: null },
  ],
} as unknown as Proposal;

const renderCard = (readOnly = false, onChanged = vi.fn()) => {
  const utils = render(
    <ToastProvider>
      <ProposalPhotosCard proposal={proposal} projectId="p1" readOnly={readOnly} onChanged={onChanged} />
    </ToastProvider>
  );
  return { onChanged, ...utils };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('ProposalPhotosCard', () => {
  it('renders photos from props with captions', () => {
    const { container } = renderCard();
    // Thumbnails use alt="" (decorative) so they carry no accessible "img"
    // role — query the elements directly instead.
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(screen.getByDisplayValue('Front porch')).toBeInTheDocument();
  });

  it('hides the toolbar when read-only', () => {
    renderCard(true);
    expect(screen.queryByRole('button', { name: /Add photos/i })).toBeNull();
  });

  // One button now covers both "upload a new shot" and "reuse an existing
  // one" — and nothing behind it is a bare file input any more.
  it('offers a single Add photos button and no hidden file input', () => {
    const { container } = renderCard();
    expect(screen.getByRole('button', { name: /Add photos/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose existing/i })).toBeNull();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  // Proposal photos are chosen after the fact from what's already on the
  // phone, unlike the six field cards where the camera is the point — so this
  // upload must not force the camera roll open.
  it('opens the gallery rather than the camera when uploading', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Add photos/i }));
    const input = await screen.findByTestId('picker-upload-input');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).not.toHaveAttribute('capture');
  });

  it('a dropped image is uploaded into the proposal, added, then resynced', async () => {
    const { onChanged } = renderCard();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('proposal-photos'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'proposal-photo', { sourceType: 'proposal', sourceId: 'pr1' },
    ));
    await waitFor(() => expect(addProposalPhoto).toHaveBeenCalledWith('pr1', 'f-new'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a drop on a locked proposal says why instead of uploading', async () => {
    renderCard(true);
    fireEvent.drop(screen.getByTestId('proposal-photos'), {
      dataTransfer: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
    });
    await screen.findByText('This proposal was sent and is now locked');
    expect(uploadProjectFile).not.toHaveBeenCalled();
  });

  it('remove calls the mocked API and reloads', async () => {
    const { onChanged } = renderCard();
    fireEvent.click(screen.getAllByLabelText('Remove photo')[0]);
    await waitFor(() => expect(removeProposalPhoto).toHaveBeenCalledWith('pr1', 'f1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('the picker\'s Existing tab adds each picked row', async () => {
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Add photos/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    const checkbox = await screen.findByLabelText('site.jpg');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/i }));
    await waitFor(() => expect(addProposalPhoto).toHaveBeenCalledWith('pr1', 'f-pick'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a partial add failure toasts a warning but still resyncs', async () => {
    const { onChanged } = renderCard();
    vi.mocked(addProposalPhoto)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('nope'); });
    fireEvent.click(screen.getByRole('button', { name: /Add photos/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    fireEvent.click(await screen.findByLabelText('site.jpg'));
    fireEvent.click(screen.getByLabelText('site2.jpg'));
    fireEvent.click(screen.getByRole('button', { name: /Add 2 files/i }));
    await screen.findByText('Added 1 of 2 photos');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('caption commit PATCHes on the proposal id, not the photo row id', async () => {
    const { onChanged } = renderCard();
    const input = screen.getByDisplayValue('Front porch');
    fireEvent.change(input, { target: { value: 'Back porch' } });
    fireEvent.blur(input);
    await waitFor(() => expect(updateProposalPhoto).toHaveBeenCalledWith('pr1', 'f1', { caption: 'Back porch' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reorder: swaps sortOrder via two PATCHes on the proposal id', async () => {
    const { onChanged } = renderCard();
    fireEvent.click(screen.getAllByLabelText('Move right')[0]);
    await waitFor(() => expect(updateProposalPhoto).toHaveBeenCalledTimes(2));
    // First arg is the PROPOSAL id, not the photo row id — the API route is
    // /api/proposals/:id/photos/:fileId, so passing the row id 404s.
    expect(vi.mocked(updateProposalPhoto).mock.calls[0]).toEqual(['pr1', 'f1', { sortOrder: 1 }]);
    expect(vi.mocked(updateProposalPhoto).mock.calls[1]).toEqual(['pr1', 'f2', { sortOrder: 0 }]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reorder: if the second PATCH fails, toasts and still resyncs via onChanged', async () => {
    const { onChanged } = renderCard();
    vi.mocked(updateProposalPhoto)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('boom'); });
    fireEvent.click(screen.getAllByLabelText('Move right')[0]);
    await screen.findByText('Failed to reorder photos');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('remove: a locked proposal toasts a warning and still reloads into read-only', async () => {
    const { onChanged } = renderCard();
    vi.mocked(removeProposalPhoto).mockRejectedValueOnce(new ProposalLockedError());
    fireEvent.click(screen.getAllByLabelText('Remove photo')[0]);
    await screen.findByText('This proposal was sent and is now locked');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('clicking a photo opens the lightbox with its caption; Remove/Move/caption clicks do not open it', () => {
    const { container } = renderCard();
    const thumbs = container.querySelectorAll('img');
    fireEvent.click(thumbs[0]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Front porch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText('Move right')[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText('Remove photo')[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
