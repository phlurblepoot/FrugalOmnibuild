import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../Toast';
import type { PdfAttachment } from '../../utils/store';

// The picker's Existing tab lists these; nothing here goes over the network.
vi.mock('../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../utils/store')>()),
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
import { PdfAttachmentsCard } from './PdfAttachmentsCard';

// Listed out of order on purpose: the card shows them by sortOrder.
const ATTACHMENTS: PdfAttachment[] = [
  { id: 'a2', fileId: 'f2', sortOrder: 1, name: 'brochure.pdf', mime: 'application/pdf', size: 2 * 1048576 },
  { id: 'a1', fileId: 'f1', sortOrder: 0, name: 'warranty.pdf', mime: 'application/pdf', size: 51200 },
];

const api = { link: vi.fn(), update: vi.fn(), remove: vi.fn(), onChanged: vi.fn() };

const renderCard = (over: Partial<React.ComponentProps<typeof PdfAttachmentsCard>> = {}) =>
  render(
    <ToastProvider>
      <PdfAttachmentsCard
        attachments={ATTACHMENTS}
        projectId="p1"
        documentName="RFI"
        testId="rfi"
        link={api.link}
        update={api.update}
        remove={api.remove}
        onChanged={api.onChanged}
        {...over}
      />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.link.mockResolvedValue(undefined);
  api.update.mockResolvedValue(undefined);
  api.remove.mockResolvedValue(undefined);
});

describe('PdfAttachmentsCard', () => {
  it('lists the attachments in sortOrder with their sizes, and says where they go', () => {
    renderCard();
    const rows = screen.getAllByTestId(/^rfi-attachment-/);
    expect(rows.map(r => r.getAttribute('data-testid'))).toEqual(['rfi-attachment-a1', 'rfi-attachment-a2']);
    expect(screen.getByText('50 KB')).toBeInTheDocument();
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('Attached PDFs are appended to the end of the generated RFI, after any photos, in this order.')).toBeInTheDocument();
  });

  it('shows the empty state', () => {
    renderCard({ attachments: [] });
    expect(screen.getByText('No attachments.')).toBeInTheDocument();
  });

  it('offers one Add PDFs button and no bare file input', () => {
    const { container } = renderCard();
    expect(screen.getByRole('button', { name: /Add PDFs/i })).toBeEnabled();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it('the picker\'s Existing tab links each picked row, then resyncs', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    fireEvent.click(await screen.findByLabelText('spec-sheet.pdf'));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/i }));
    await waitFor(() => expect(api.link).toHaveBeenCalledWith('f-pick'));
    await waitFor(() => expect(api.onChanged).toHaveBeenCalled());
  });

  it('a partial add failure toasts a warning but still resyncs', async () => {
    api.link.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Only PDF files can be attached'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    fireEvent.click(await screen.findByLabelText('spec-sheet.pdf'));
    fireEvent.click(screen.getByLabelText('terms.pdf'));
    fireEvent.click(screen.getByRole('button', { name: /Add 2 files/i }));
    await screen.findByText('Added 1 of 2 files');
    await waitFor(() => expect(api.onChanged).toHaveBeenCalled());
  });

  it('reorder: swaps two neighbours\' sortOrders with two sequential updates', async () => {
    renderCard();
    expect(screen.getAllByLabelText('Move up')[0]).toBeDisabled();
    expect(screen.getAllByLabelText('Move down')[1]).toBeDisabled();
    fireEvent.click(screen.getAllByLabelText('Move down')[0]);
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
    expect(api.update.mock.calls[0]).toEqual(['f1', { sortOrder: 1 }]);
    expect(api.update.mock.calls[1]).toEqual(['f2', { sortOrder: 0 }]);
    await waitFor(() => expect(api.onChanged).toHaveBeenCalled());
  });

  it('reorder: if the second update fails, toasts and still resyncs', async () => {
    api.update.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));
    renderCard();
    fireEvent.click(screen.getAllByLabelText('Move up')[1]);
    await screen.findByText('Failed to reorder attachments');
    await waitFor(() => expect(api.onChanged).toHaveBeenCalled());
  });

  it('remove calls the API with the file id and reloads', async () => {
    renderCard();
    fireEvent.click(screen.getAllByLabelText('Remove attachment')[1]);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('f2'));
    await waitFor(() => expect(api.onChanged).toHaveBeenCalled());
  });

  it('a failed remove toasts and leaves the list as it was', async () => {
    api.remove.mockRejectedValueOnce(new Error('offline'));
    renderCard();
    fireEvent.click(screen.getAllByLabelText('Remove attachment')[0]);
    await screen.findByText('Failed to remove attachment');
    expect(api.onChanged).not.toHaveBeenCalled();
  });

  it('disabled refuses additions and says why, but reorder and remove still work', async () => {
    renderCard({ disabled: true, disabledMessage: 'Save your changes first' });
    const add = screen.getByRole('button', { name: /Add PDFs/i });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'Save your changes first');
    fireEvent.click(screen.getAllByLabelText('Remove attachment')[0]);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('f1'));
  });
});
