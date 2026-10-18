// src/pages/ShareView.test.tsx — the public share page (ONLYOFFICE Phase 7):
// a link that expired, was turned off or never existed says which; several
// documents under one link list and open one at a time; a file nothing can
// preview gets a download card. (The viewer itself: AttachmentViewer.test.tsx.)
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({ openShareViewer: vi.fn(), getShareInfo: vi.fn(), loadDocsApi: vi.fn() }));
vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()), openShareViewer: h.openShareViewer, getShareInfo: h.getShareInfo,
}));
vi.mock('../utils/onlyofficeApi', () => ({ loadDocsApi: h.loadDocsApi }));
import { ShareLinkError } from '../utils/store';
import { ShareView } from './ShareView';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
let constructed: { config: any }[];

beforeEach(() => {
  vi.clearAllMocks();
  constructed = [];
  h.loadDocsApi.mockResolvedValue(undefined);
  h.openShareViewer.mockResolvedValue({ publicUrl: 'https://docs.example.com', config: { type: 'embedded', token: 't' }, file: { name: 'x', ext: 'docx' } });
  window.DocsAPI = {
    DocEditor: function DocEditor(this: any, _id: string, config: any) {
      constructed.push({ config });
      this.destroyEditor = vi.fn();
    } as any,
  };
});
afterEach(() => { delete window.DocsAPI; });

const visit = (url = '/share/s1') => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/share/:shareId" element={<ShareView />} /></Routes>
  </MemoryRouter>,
);

describe('a link that no longer opens', () => {
  it.each([
    ['expired', 'This link has expired', 'Ask whoever sent it for a new one.'],
    ['revoked', 'This link was turned off', /stopped sharing/],
    ['missing', "This link doesn't exist", /Check the address/],
  ] as const)('%s: says so', async (code, title, hint) => {
    h.getShareInfo.mockRejectedValue(new ShareLinkError('x', code));
    visit();
    const page = await screen.findByTestId('share-problem');
    expect(page).toHaveAttribute('data-problem', code);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(h.openShareViewer).not.toHaveBeenCalled();
  });
});

describe('several documents under one link', () => {
  const info = {
    type: 'files', name: 'Job 12: 3 documents', count: 3, expiresAt: new Date(2026, 9, 27).getTime(),
    files: [
      { name: 'Scope.docx', mime: DOCX, size: 2048, viewer: true },
      { name: 'Takeoff.zip', mime: 'application/zip', size: 10, viewer: false },
      { name: 'Gone.pdf', mime: 'application/pdf', size: 0, viewer: false, missing: true },
    ],
  };

  it('lists them with their sizes and download links; one no longer there is not clickable', async () => {
    h.getShareInfo.mockResolvedValue(info);
    visit();
    const rows = await screen.findAllByTestId('share-file-row');
    expect(screen.getByRole('heading', { name: 'Job 12: 3 documents' })).toBeInTheDocument();
    expect(screen.getByTestId('share-expiry-note')).toHaveTextContent(/^3 documents · Link expires Oct 27, 2026$/);
    expect(rows[0]).toHaveTextContent('Scope.docx2.0 KB');
    expect(within(rows[0]).getByLabelText('Download Scope.docx')).toHaveAttribute('href', '/api/share/s1/file/0?download=1');
    expect(within(rows[2]).queryByTestId('share-file-open')).toBeNull();
    expect(within(rows[2]).queryByRole('link')).toBeNull();
    expect(screen.getAllByTestId('share-file-open')).toHaveLength(2);
  });

  it('opens one in the viewer, and goes back to the list', async () => {
    h.getShareInfo.mockResolvedValue(info);
    visit();
    fireEvent.click((await screen.findAllByTestId('share-file-open'))[0]);
    await waitFor(() => expect(constructed).toHaveLength(1));
    expect(h.openShareViewer).toHaveBeenCalledWith('s1', expect.objectContaining({ device: 'desktop' }), 0);
    expect(screen.getByRole('heading', { name: 'Scope.docx' })).toBeInTheDocument();
    expect(screen.getByTestId('share-expiry-note')).toHaveTextContent('1 of 3 · Job 12: 3 documents');
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/share/s1/file/0?download=1');
    fireEvent.click(screen.getByTestId('share-back'));
    expect(await screen.findAllByTestId('share-file-row')).toHaveLength(3);
  });

  it('a file neither the viewer nor the browser can show gets a download card', async () => {
    h.getShareInfo.mockResolvedValue(info);
    visit('/share/s1?f=1');
    expect(await screen.findByTestId('share-download-card')).toHaveTextContent("This file can't be previewed here.");
    expect(screen.getByRole('link', { name: 'Download Takeoff.zip' })).toHaveAttribute('href', '/api/share/s1/file/1?download=1');
    expect(h.openShareViewer).not.toHaveBeenCalled();
  });

  it('a link to a file no longer there shows the list', async () => {
    h.getShareInfo.mockResolvedValue(info);
    visit('/share/s1?f=2');
    expect(await screen.findAllByTestId('share-file-row')).toHaveLength(3);
  });
});

describe('one file', () => {
  it('says when the link expires; a link that never does says nothing', async () => {
    h.getShareInfo.mockResolvedValue({ type: 'file', name: 'Notes.zip', mime: 'application/zip', viewer: false, expiresAt: new Date(2026, 9, 27).getTime() });
    visit();
    expect(await screen.findByTestId('share-expiry-note')).toHaveTextContent('Link expires Oct 27, 2026');
    expect(screen.getByTestId('share-download-card')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'Notes.zip');
  });

  it('an older link with no expiry', async () => {
    h.getShareInfo.mockResolvedValue({ type: 'printout', name: 'Bid set', viewer: false, expiresAt: null });
    visit();
    await waitFor(() => expect(document.querySelector('object[type="application/pdf"]')).not.toBeNull());
    expect(screen.queryByTestId('share-expiry-note')).toBeNull();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'Bid set.pdf');
  });
});
