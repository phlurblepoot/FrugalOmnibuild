// src/components/ShareLinkModal.test.tsx — the share window (ONLYOFFICE
// Phase 7): a document's working links, a new link with its expiry, changing
// an expiry, stopping a link, a plan page's link made straight away, and one
// link for several documents.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  getSettings: vi.fn(), listShareLinks: vi.fn(), createShareLink: vi.fn(), setShareLinkExpiry: vi.fn(), stopShareLink: vi.fn(),
}));
vi.mock('../utils/store', async (orig) => ({ ...(await orig<typeof import('../utils/store')>()), ...h }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr') } }));
import { ShareProvider, useShare, type ShareRequest } from './ShareLinkModal';
import { ToastProvider } from './Toast';
import { ConfirmProvider } from './ConfirmDialog';

const DAY = 86_400_000;
const link = (over: object) => ({
  id: 'l1', type: 'file', name: 'Scope', createdAt: 1, expiresAt: Date.now() + 20 * DAY,
  createdBy: 'u1', createdByName: 'noah', fileCount: 1, ...over,
});

const Opener: React.FC<{ request: ShareRequest }> = ({ request }) => {
  const share = useShare();
  return <button onClick={() => share(request)}>open share</button>;
};
const open = (request: ShareRequest) => {
  render(
    <ToastProvider><ConfirmProvider><ShareProvider><Opener request={request} /></ShareProvider></ConfirmProvider></ToastProvider>,
  );
  fireEvent.click(screen.getByText('open share'));
  return screen.getByTestId('share-dialog');
};
const fileRequest: ShareRequest = { title: 'Share Scope.docx', target: { type: 'file', resourceId: 'doc1' }, name: 'Scope.docx' };

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettings.mockResolvedValue({ publicHost: 'https://takeoff.example.com/' });
  h.listShareLinks.mockResolvedValue([]);
  h.createShareLink.mockResolvedValue({ id: 'new1', expiresAt: Date.now() + 7 * DAY });
  h.setShareLinkExpiry.mockResolvedValue({ expiresAt: null });
  h.stopShareLink.mockResolvedValue(undefined);
});

describe('share window', () => {
  it("lists a document's working links, including several-documents links it is in", async () => {
    h.listShareLinks.mockResolvedValue([
      link({ id: 'l1' }),
      link({ id: 'l2', type: 'files', fileCount: 3, expiresAt: null, createdByName: 'maria' }),
    ]);
    open(fileRequest);
    const rows = await screen.findAllByTestId('share-link-row');
    expect(h.listShareLinks).toHaveBeenCalledWith('doc1');
    expect(rows[0]).toHaveTextContent('takeoff.example.com/share/l1');
    expect(rows[0]).toHaveTextContent(/Expires .* · by noah/);
    expect(rows[1]).toHaveTextContent('Never expires · with 2 other documents · by maria');
    // Nothing is made just by opening the window.
    expect(h.createShareLink).not.toHaveBeenCalled();
  });

  it('makes a new link lasting the chosen time (30 days unless picked)', async () => {
    open(fileRequest);
    expect(await screen.findByTestId('share-links-empty')).toHaveTextContent('Not shared yet.');
    expect(screen.getByTestId('share-expiry-30')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('share-expiry-7'));
    fireEvent.click(screen.getByTestId('share-create'));
    await waitFor(() => expect(h.createShareLink).toHaveBeenCalledWith({ type: 'file', resourceId: 'doc1' }, 'Scope.docx', 7));
    expect(await screen.findByLabelText('Share URL')).toHaveValue('https://takeoff.example.com/share/new1');
    expect(screen.getByTestId('share-current-expiry')).toHaveTextContent(/^Expires /);
    expect(screen.getAllByTestId('share-link-row')).toHaveLength(1);
    expect(await screen.findByAltText('QR code linking to the shared page')).toHaveAttribute('src', 'data:image/png;base64,qr');

    fireEvent.click(screen.getByTestId('share-expiry-never'));
    fireEvent.click(screen.getByTestId('share-create'));
    await waitFor(() => expect(h.createShareLink).toHaveBeenLastCalledWith(expect.anything(), 'Scope.docx', null));
  });

  it("changes a link's expiry", async () => {
    h.listShareLinks.mockResolvedValue([link({ id: 'l1' })]);
    open(fileRequest);
    fireEvent.click(within(await screen.findByTestId('share-link-row')).getByTitle('Show this link'));
    fireEvent.change(screen.getByLabelText('Change how long this link lasts'), { target: { value: 'null' } });
    await waitFor(() => expect(h.setShareLinkExpiry).toHaveBeenCalledWith('l1', null));
    expect(await screen.findByTestId('share-current-expiry')).toHaveTextContent('Never expires');
  });

  it('stops sharing after asking, and warns when the link opens several documents', async () => {
    h.listShareLinks.mockResolvedValue([link({ id: 'l2', type: 'files', fileCount: 3 })]);
    open(fileRequest);
    fireEvent.click(await screen.findByTestId('share-stop'));
    expect(await screen.findByText(/opens 3 documents; it stops working for all of them/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stop sharing?' })).getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(h.stopShareLink).toHaveBeenCalledWith('l2'));
    expect(await screen.findByTestId('share-links-empty')).toBeInTheDocument();
  });

  it("a plan page's link is made as the window opens", async () => {
    open({ title: 'Share A-101', target: { type: 'page', resourceId: 'img1' }, name: 'A-101', createNow: true });
    await waitFor(() => expect(h.createShareLink).toHaveBeenCalledWith({ type: 'page', resourceId: 'img1' }, 'A-101', 30));
    expect(await screen.findByLabelText('Share URL')).toHaveValue('https://takeoff.example.com/share/new1');
  });

  it('several documents: one link, their names listed, and it can be stopped', async () => {
    const dialog = open({
      title: 'Share 2 documents', target: { type: 'files', fileIds: ['doc1', 'pdf1'] }, name: 'Job 12: 2 documents',
      fileNames: ['Scope.docx', 'Bid set.pdf'],
    });
    expect(within(dialog).getByTestId('share-file-names')).toHaveTextContent('One link to 2 documents: Scope.docx, Bid set.pdf');
    fireEvent.click(within(dialog).getByTestId('share-create'));
    await waitFor(() => expect(h.createShareLink).toHaveBeenCalledWith(
      { type: 'files', fileIds: ['doc1', 'pdf1'] }, 'Job 12: 2 documents', 30));
    expect(h.listShareLinks).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('share-stop'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Stop sharing?' })).getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(h.stopShareLink).toHaveBeenCalledWith('new1'));
    await waitFor(() => expect(screen.queryByTestId('share-current')).toBeNull());
  });

  it("says why a link couldn't be made", async () => {
    h.createShareLink.mockRejectedValue(new Error('That document can’t be shared.'));
    open(fileRequest);
    fireEvent.click(await screen.findByTestId('share-create'));
    expect(await screen.findByText('That document can’t be shared.')).toBeInTheDocument();
  });
});
