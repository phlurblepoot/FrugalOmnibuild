// ONLYOFFICE as a viewer (Phase 6), in the browser: the attachment page
// mounts the server's signed view-only config (desktop or phone), falls back
// to a download when it can't open, and the share page shows the embedded
// viewer for a file it can read and its own preview otherwise.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  openAttachmentViewer: vi.fn(), openShareViewer: vi.fn(), getShareInfo: vi.fn(), loadDocsApi: vi.fn(),
}));
vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  openAttachmentViewer: h.openAttachmentViewer, openShareViewer: h.openShareViewer, getShareInfo: h.getShareInfo,
}));
vi.mock('../utils/onlyofficeApi', () => ({ loadDocsApi: h.loadDocsApi }));
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ mode: 'dark' }) }));
vi.mock('../utils/mailApi', () => ({ mailApi: { attachmentUrl: (m: string, a: string) => `/api/mail/messages/${m}/attachments/${a}?token=t` } }));
import { EditorOpenError } from '../utils/store';
import { AttachmentViewer } from './AttachmentViewer';
import { ShareView } from './ShareView';

let constructed: { config: any }[];
const originalMatchMedia = window.matchMedia;
const opening = (type = 'desktop') => ({ publicUrl: 'https://docs.example.com', config: { type, token: 'signed', document: { fileType: 'docx' } }, file: { name: 'Scope.docx', ext: 'docx' } });

beforeEach(() => {
  vi.clearAllMocks();
  constructed = [];
  h.loadDocsApi.mockResolvedValue(undefined);
  window.DocsAPI = {
    DocEditor: function DocEditor(this: any, _id: string, config: any) {
      constructed.push({ config });
      this.destroyEditor = vi.fn();
    } as any,
  };
});
afterEach(() => {
  delete window.DocsAPI;
  window.matchMedia = originalMatchMedia;
});

const at = (url: string, element: React.ReactNode, path: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path={path} element={element} />
      <Route path="/mail" element={<div>Mail page</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('AttachmentViewer', () => {
  it('opens the attachment view only from the server config, in the theme and device of the moment', async () => {
    h.openAttachmentViewer.mockResolvedValue(opening());
    at('/tools/view?message=m1&att=a1&name=Scope.docx', <AttachmentViewer />, '/tools/view');
    await waitFor(() => expect(constructed).toHaveLength(1));
    expect(h.openAttachmentViewer).toHaveBeenCalledWith('m1', 'a1', { device: 'desktop', theme: 'dark' });
    expect(h.loadDocsApi).toHaveBeenCalledWith('https://docs.example.com');
    expect(constructed[0].config).toMatchObject({ token: 'signed', document: { fileType: 'docx' } });
    expect(typeof constructed[0].config.events.onRequestClose).toBe('function');
  });

  it('asks for the phone viewer on small screens', async () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} })) as any;
    h.openAttachmentViewer.mockResolvedValue(opening('mobile'));
    at('/tools/view?message=m1&att=a1&name=Scope.docx', <AttachmentViewer />, '/tools/view');
    await waitFor(() => expect(h.openAttachmentViewer).toHaveBeenCalledWith('m1', 'a1', expect.objectContaining({ device: 'phone' })));
  });

  it("offers the download when it can't open", async () => {
    h.openAttachmentViewer.mockRejectedValue(new EditorOpenError("The document viewer isn't set up, so attachments download instead.", 503, 'not-configured'));
    at('/tools/view?message=m1&att=a1&name=Scope.docx', <AttachmentViewer />, '/tools/view');
    expect(await screen.findByText("Can't show Scope.docx here")).toBeInTheDocument();
    expect(screen.getByText(/isn't set up/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/mail/messages/m1/attachments/a1?token=t');
    expect(constructed).toHaveLength(0);
  });

  it('says so when the link is missing its attachment', () => {
    at('/tools/view?message=m1', <AttachmentViewer />, '/tools/view');
    expect(screen.getByText(/missing the attachment/)).toBeInTheDocument();
    expect(h.openAttachmentViewer).not.toHaveBeenCalled();
  });
});

describe('ShareView with the viewer', () => {
  it('shows a shared file in the embedded viewer, with the Download button kept', async () => {
    h.getShareInfo.mockResolvedValue({ type: 'printout', name: 'Bid set', viewer: true });
    h.openShareViewer.mockResolvedValue(opening('embedded'));
    at('/share/s1', <ShareView />, '/share/:shareId');
    await waitFor(() => expect(constructed).toHaveLength(1));
    expect(h.openShareViewer).toHaveBeenCalledWith('s1', expect.objectContaining({ device: 'desktop' }), undefined);
    expect(constructed[0].config.type).toBe('embedded');
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/share/s1?download=1');
    expect(document.querySelector('object')).toBeNull();
  });

  it("falls back to the page's own preview when the viewer can't open", async () => {
    h.getShareInfo.mockResolvedValue({ type: 'printout', name: 'Bid set', viewer: true });
    h.openShareViewer.mockRejectedValue(new EditorOpenError('unreachable', 503, 'onlyoffice-unreachable'));
    at('/share/s1', <ShareView />, '/share/:shareId');
    await waitFor(() => expect(document.querySelector('object[type="application/pdf"]')).not.toBeNull());
  });

  it('keeps the preview for files the viewer is not for', async () => {
    h.getShareInfo.mockResolvedValue({ type: 'page', name: 'Photo', mime: 'image/png', viewer: false });
    at('/share/s2', <ShareView />, '/share/:shareId');
    expect(await screen.findByRole('img', { name: 'Photo' })).toHaveAttribute('src', '/api/share/s2');
    expect(h.openShareViewer).not.toHaveBeenCalled();
  });
});
