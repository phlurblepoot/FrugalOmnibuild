// src/pages/documents/DocumentViewerModal.test.tsx
// Covers the viewer's pdf.js document lifecycle — one load per open, page
// flips reuse the handle, and closing destroys it (a leaked handle keeps a
// worker-side document alive for the rest of the session).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));

const loadPdfDoc = vi.fn();
const renderPdfPage = vi.fn();
vi.mock('./previewEngine', async importOriginal => ({
  ...(await importOriginal<typeof import('./previewEngine')>()),
  loadPdfDoc: (...args: unknown[]) => loadPdfDoc(...args),
  renderPdfPage: (...args: unknown[]) => renderPdfPage(...args),
}));

import { DocumentRow } from '../../utils/store';
import { DocumentViewerModal } from './DocumentViewerModal';

const makeRow = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: 'f1',
  name: 'plans.pdf',
  mime: 'application/pdf',
  size: 1234,
  kind: 'document',
  createdAt: Date.now(),
  versionNumber: 1,
  archived: false,
  projectId: null,
  projectName: null,
  customerId: null,
  customerName: null,
  source: null,
  ...over,
});

const props = {
  customTypes: [],
  onClose: vi.fn(),
  onOpenInEditor: vi.fn(),
  onDownload: vi.fn(),
  onArchive: vi.fn().mockResolvedValue(undefined),
};

const destroy = vi.fn().mockResolvedValue(undefined);

const renderModal = (row: DocumentRow, over: Partial<typeof props> & { onShare?: (r: DocumentRow) => void } = {}) => render(
  <MemoryRouter><DocumentViewerModal row={row} {...props} {...over} /></MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  loadPdfDoc.mockResolvedValue({ numPages: 3, getPage: vi.fn(), destroy });
  renderPdfPage.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
});

describe('DocumentViewerModal', () => {
  it('titles itself with the file name and renders the modal body', async () => {
    renderModal(makeRow());
    expect(await screen.findByTestId('doc-viewer-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'plans.pdf' })).toBeInTheDocument();
  });

  it('loads the pdf once, flips pages from the same handle, and destroys it on close', async () => {
    const { unmount } = renderModal(makeRow());

    await waitFor(() => expect(renderPdfPage).toHaveBeenCalled());
    expect(loadPdfDoc).toHaveBeenCalledTimes(1);
    expect(renderPdfPage.mock.calls[0][1]).toBe(1);
    expect(screen.getByText('Page 1 / 3')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('doc-viewer-page-next'));
    await waitFor(() => expect(screen.getByText('Page 2 / 3')).toBeInTheDocument());
    expect(renderPdfPage.mock.calls[1][1]).toBe(2);
    expect(loadPdfDoc).toHaveBeenCalledTimes(1);

    expect(destroy).not.toHaveBeenCalled();
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('lays the pdf canvas out so it keeps its aspect ratio (no flex stretch)', async () => {
    renderModal(makeRow());
    await waitFor(() => expect(renderPdfPage).toHaveBeenCalled());
    const canvas = document.querySelector('canvas')!; // Modal portals to document.body
    const wrap = canvas.parentElement!;
    // A flex row stretches its children by default (align-items: stretch), which
    // forces the canvas to the container height regardless of its width cap.
    expect(wrap.className).toMatch(/\bitems-start\b/);
    expect(canvas.className).toMatch(/\bmax-h-\[/);
    expect(canvas.className).toMatch(/\bw-auto\b/);
  });

  it('offers Share for the open document when the page can share (Phase 7)', async () => {
    const onShare = vi.fn();
    const row = makeRow();
    renderModal(row, { onShare });
    fireEvent.click(await screen.findByTestId('doc-viewer-share'));
    expect(onShare).toHaveBeenCalledWith(row);
  });

  it('has no Share button where the page gives it nothing to share with', async () => {
    renderModal(makeRow());
    await screen.findByTestId('doc-viewer-modal');
    expect(screen.queryByTestId('doc-viewer-share')).toBeNull();
  });

  it('hides page navigation for a single-page pdf', async () => {
    loadPdfDoc.mockResolvedValue({ numPages: 1, getPage: vi.fn(), destroy });
    renderModal(makeRow());
    await waitFor(() => expect(renderPdfPage).toHaveBeenCalled());
    expect(screen.queryByTestId('doc-viewer-page-next')).toBeNull();
    expect(screen.queryByTestId('doc-viewer-page-prev')).toBeNull();
  });

  it('images render from the raw stream with no pdf work', async () => {
    renderModal(makeRow({ mime: 'image/png', name: 'site.png' }));
    const img = await screen.findByAltText('site.png');
    expect(img).toHaveAttribute('src', '/api/images/f1/raw');
    expect(loadPdfDoc).not.toHaveBeenCalled();
  });

  // Nested-modal case: the shared Lightbox is deliberately layered on top of
  // this Modal rather than folded into it — this proves it actually opens
  // over an already-open Modal, and that the underlying Modal survives.
  it('clicking the image opens the app-wide Lightbox on top of this Modal', async () => {
    renderModal(makeRow({ mime: 'image/png', name: 'site.png' }));
    const img = await screen.findByAltText('site.png');
    fireEvent.click(img);
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument();
    // The DocumentViewerModal dialog is still mounted underneath.
    expect(screen.getByTestId('doc-viewer-modal')).toBeInTheDocument();
  });

  it('Open in editor closes first, then hands off to openTargetFor', async () => {
    const onClose = vi.fn();
    const onOpenInEditor = vi.fn();
    renderModal(makeRow(), { onClose, onOpenInEditor });
    fireEvent.click(await screen.findByTestId('doc-viewer-open-editor'));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenInEditor).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('archive patches the row then closes (the list refreshes behind it)', async () => {
    const onClose = vi.fn();
    const onArchive = vi.fn().mockResolvedValue(undefined);
    renderModal(makeRow(), { onClose, onArchive });
    fireEvent.click(await screen.findByTestId('doc-viewer-archive'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }), true);
  });
});
