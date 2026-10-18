// src/pages/mail/SaveAttachmentsModal.test.tsx
//
// SaveAttachmentsModal is the remote-items wiring around the shared Documents
// upload modal: it loads projects/customers/customTypes the way DocumentsPage
// does, hands the message's attachments to UploadDocumentsModal as
// `remoteItems`, and turns a confirm into mailApi.saveAttachments — surfacing
// the server's per-item saved/failed split as toasts and, on a partial
// failure, keeping the modal open with only the failed chips so a retry
// can't re-save what already landed.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/Toast';
import type { AttachmentMeta } from './types';

const h = vi.hoisted(() => ({
  saveAttachments: vi.fn(),
  toast: vi.fn(),
  getProjectsSummary: vi.fn(),
}));
vi.mock('../../utils/mailApi', () => ({ mailApi: { saveAttachments: h.saveAttachments } }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectsSummary: h.getProjectsSummary,
  getCustomers: vi.fn().mockResolvedValue([{ id: 'cust1', name: 'Test Customer' }]),
  getDocumentTypes: vi.fn().mockResolvedValue([]),
}));

import { SaveAttachmentsModal } from './SaveAttachmentsModal';

const att = (over: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  attId: 'a1', name: 'invoice.pdf', mime: 'application/pdf', size: 2048, ...over,
});

beforeEach(() => {
  h.saveAttachments.mockReset();
  h.toast.mockReset();
  h.getProjectsSummary.mockReset();
  h.getProjectsSummary.mockResolvedValue([{ id: 'proj1', name: 'Test Project', customerId: 'cust1' }]);
});

const mount = (attachments: AttachmentMeta[], onClose = vi.fn(), onSaved?: (files: Array<{ fileId: string; name: string }>) => void) => {
  render(
    <ToastProvider>
      <SaveAttachmentsModal open onClose={onClose} messageId="m1" attachments={attachments} onSaved={onSaved} />
    </ToastProvider>
  );
  return onClose;
};

describe('SaveAttachmentsModal', () => {
  it('renders the modal seeded with the message attachments', async () => {
    mount([att()]);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());
  });

  it('confirming calls mailApi.saveAttachments with attId/name/kind/projectId', async () => {
    h.saveAttachments.mockResolvedValue({ fileIds: ['f1'], saved: [{ attId: 'a1', fileId: 'f1' }], failed: [] });
    mount([att()]);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));

    await waitFor(() => expect(h.saveAttachments).toHaveBeenCalledTimes(1));
    expect(h.saveAttachments).toHaveBeenCalledWith('m1', [
      expect.objectContaining({ attId: 'a1', name: 'invoice.pdf', kind: 'document', projectId: 'proj1' }),
    ]);
  });

  it('all saved: toasts success and closes the modal', async () => {
    h.saveAttachments.mockResolvedValue({ fileIds: ['f1'], saved: [{ attId: 'a1', fileId: 'f1' }], failed: [] });
    const onClose = mount([att()]);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('Saved 1'), expect.objectContaining({ type: 'success' }));
  });

  it('partial failure: warns with counts, keeps the modal open showing only the failed chip', async () => {
    h.saveAttachments.mockResolvedValue({
      fileIds: ['f1'],
      saved: [{ attId: 'a1', fileId: 'f1' }],
      failed: [{ attId: 'a2', error: 'boom' }],
    });
    const onClose = mount([att({ attId: 'a1', name: 'invoice.pdf' }), att({ attId: 'a2', name: 'site.jpg', mime: 'image/jpeg' })]);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save 2 files' }));

    await waitFor(() => expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument());
    expect(screen.getByText('site.jpg')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'warning' }));

    // Retrying now only resubmits the failed item.
    h.saveAttachments.mockResolvedValue({ fileIds: ['f2'], saved: [{ attId: 'a2', fileId: 'f2' }], failed: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));
    await waitFor(() => expect(h.saveAttachments).toHaveBeenCalledTimes(2));
    expect(h.saveAttachments.mock.calls[1][1]).toEqual([
      expect.objectContaining({ attId: 'a2', name: 'site.jpg' }),
    ]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('all failed: shows an error toast and keeps the modal open with all chips', async () => {
    h.saveAttachments.mockResolvedValue({ fileIds: [], saved: [], failed: [{ attId: 'a1', error: 'boom' }] });
    const onClose = mount([att()]);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));
    // The reason travels with the count: a bare "Failed to save 1 file" is
    // what made the live attachment bug undiagnosable from the UI.
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Failed to save 1 file — boom', { type: 'error' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
  });

  it('all failed with no reason given: still names the count', async () => {
    h.saveAttachments.mockResolvedValue({ fileIds: [], saved: [], failed: [{ attId: 'a1', error: '' }] });
    mount([att()]);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Failed to save 1 file', { type: 'error' }));
  });
});

// The RFI pending-reply banner saves an emailed answer through this modal and
// then offers the saved file as the RFI's response document — it needs the ids
// the server minted, which only this component ever sees.
describe('SaveAttachmentsModal — onSaved', () => {
  const att2 = (): AttachmentMeta => ({ attId: 'a1', name: 'invoice.pdf', mime: 'application/pdf', size: 2048 });

  // The id alone is not enough for a caller that wants to NAME the file it just
  // saved (the RFI banner's confirm does): only this component can join the
  // server's id back to the name the user submitted.
  it('reports the saved files, with the names they were saved under', async () => {
    h.saveAttachments.mockResolvedValue({ fileIds: ['f1'], saved: [{ attId: 'a1', fileId: 'f1' }], failed: [] });
    const onSaved = vi.fn();
    mount([att2()], vi.fn(), onSaved);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith([{ fileId: 'f1', name: 'invoice.pdf' }]));
  });

  // Callers that keep the modal mounted while closed (the RFI pending-reply
  // banner) would otherwise pay for the project/customer/type lists on every
  // render of the record they sit on.
  it('loads nothing until it is opened', async () => {
    render(
      <ToastProvider>
        <SaveAttachmentsModal open={false} onClose={vi.fn()} messageId="m1" attachments={[att2()]} />
      </ToastProvider>
    );
    await waitFor(() => expect(screen.queryByText('invoice.pdf')).toBeNull());
    expect(h.getProjectsSummary).not.toHaveBeenCalled();
  });

  it('stays silent when nothing landed', async () => {
    h.saveAttachments.mockResolvedValue({ fileIds: [], saved: [], failed: [{ attId: 'a1', error: 'gone' }] });
    const onSaved = vi.fn();
    mount([att2()], vi.fn(), onSaved);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));
    await waitFor(() => expect(h.saveAttachments).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
