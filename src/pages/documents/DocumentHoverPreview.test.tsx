// src/pages/documents/DocumentHoverPreview.test.tsx
// The two behaviors of the hover card that are easy to regress and invisible
// in a screenshot: the 350ms delay gates the FETCH (not just the display), and
// a thumb that resolves late never lands on a different row's card.
// pdfjs is mocked because previewEngine imports it at module load; the engine
// itself is real apart from getPreviewThumb.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));

const getPreviewThumb = vi.fn();
vi.mock('./previewEngine', async importOriginal => ({
  ...(await importOriginal<typeof import('./previewEngine')>()),
  getPreviewThumb: (...args: unknown[]) => getPreviewThumb(...args),
}));

// Real store module apart from fetchFileBlob, so the "no fetch" assertion
// below can observe the byte-level network call previewEngine's real
// getPreviewThumb would (or, for a capped pdf, would NOT) make.
const fetchFileBlob = vi.fn();
vi.mock('../../utils/store', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/store')>()),
  fetchFileBlob: (...args: unknown[]) => fetchFileBlob(...args),
}));

import { DocumentRow } from '../../utils/store';
import { DocumentHoverPreview, HOVER_DELAY_MS } from './DocumentHoverPreview';
import { HOVER_PDF_SIZE_CAP } from './previewEngine';

const makeRow = (id: string, over: Partial<DocumentRow> = {}): DocumentRow => ({
  id,
  name: `${id}.png`,
  mime: 'image/png',
  size: 1234,
  kind: 'photo',
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

const card = () => screen.queryByTestId('doc-hover-preview');
// The thumb is decorative (alt=""), so it has no accessible img role to query.
const thumbSrc = () => card()?.querySelector('img')?.getAttribute('src');

const settle = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  getPreviewThumb.mockReset();
  getPreviewThumb.mockResolvedValue({ kind: 'image', url: '/api/images/a/raw' });
  fetchFileBlob.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DocumentHoverPreview', () => {
  it('does nothing at all until the hover delay elapses', async () => {
    render(<DocumentHoverPreview row={makeRow('a')} startX={10} startY={10} customTypes={[]} onHide={vi.fn()} />);

    await settle(HOVER_DELAY_MS - 50);
    expect(card()).toBeNull();
    expect(getPreviewThumb).not.toHaveBeenCalled();

    await settle(50);
    expect(card()).not.toBeNull();
    expect(getPreviewThumb).toHaveBeenCalledTimes(1);
    expect(getPreviewThumb).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), { forHover: true });
    expect(thumbSrc()).toBe('/api/images/a/raw');
  });

  it('leaving the row before the delay never fetches', async () => {
    const { unmount } = render(
      <DocumentHoverPreview row={makeRow('a')} startX={10} startY={10} customTypes={[]} onHide={vi.fn()} />
    );
    await settle(HOVER_DELAY_MS - 100);
    unmount();
    await settle(500);
    expect(getPreviewThumb).not.toHaveBeenCalled();
  });

  it('a thumb that resolves after the pointer moved to another row is dropped', async () => {
    let resolveA: (t: unknown) => void = () => {};
    getPreviewThumb.mockImplementationOnce(() => new Promise(res => { resolveA = res; }));

    const { rerender } = render(
      <DocumentHoverPreview row={makeRow('a')} startX={10} startY={10} customTypes={[]} onHide={vi.fn()} />
    );
    await settle(HOVER_DELAY_MS);
    expect(getPreviewThumb).toHaveBeenCalledTimes(1);

    // Pointer moves to row b; b's thumb resolves normally.
    getPreviewThumb.mockResolvedValue({ kind: 'image', url: '/api/images/b/raw' });
    rerender(<DocumentHoverPreview row={makeRow('b')} startX={10} startY={10} customTypes={[]} onHide={vi.fn()} />);
    await settle(HOVER_DELAY_MS);

    // ...and only now does a's render finish. It must not replace b's.
    await act(async () => { resolveA({ kind: 'image', url: '/api/images/a/raw' }); });
    expect(thumbSrc()).toBe('/api/images/b/raw');
    expect(screen.getByText('b.png')).toBeInTheDocument();
  });

  it('a pdf over HOVER_PDF_SIZE_CAP falls back to icon + "Open to preview" without fetching bytes', async () => {
    // Delegate to previewEngine's real getPreviewThumb (not the file-wide
    // mock) so the hover-cap check itself is exercised, not just the UI's
    // reaction to a pre-baked icon result.
    const { getPreviewThumb: real } = await vi.importActual<typeof import('./previewEngine')>('./previewEngine');
    getPreviewThumb.mockImplementation(real);

    const row = makeRow('big', { mime: 'application/pdf', size: HOVER_PDF_SIZE_CAP + 1 });
    render(<DocumentHoverPreview row={row} startX={10} startY={10} customTypes={[]} onHide={vi.fn()} />);
    await settle(HOVER_DELAY_MS);

    expect(card()).not.toBeNull();
    expect(screen.getByText('Open to preview')).toBeInTheDocument();
    expect(thumbSrc()).toBeUndefined();
    expect(fetchFileBlob).not.toHaveBeenCalled();
  });

  it('hides itself on scroll, right-click and mousedown', async () => {
    for (const event of ['scroll', 'contextmenu', 'mousedown'] as const) {
      const onHide = vi.fn();
      const { unmount } = render(
        <DocumentHoverPreview row={makeRow('a')} startX={10} startY={10} customTypes={[]} onHide={onHide} />
      );
      await settle(HOVER_DELAY_MS);
      await act(async () => { window.dispatchEvent(new Event(event)); });
      expect(onHide, event).toHaveBeenCalled();
      unmount();
    }
  });

  // Regression guard: hiding on `click` re-applied a controlled checkbox's
  // `checked` between the browser's pre-click toggle and React's onChange
  // plugin, swallowing the click (file-picker checkboxes needed 1-3 clicks).
  // mousedown covers the same dismissal cases and lands the render first.
  it('does NOT hide on click — the press is handled by mousedown instead', async () => {
    const onHide = vi.fn();
    render(<DocumentHoverPreview row={makeRow('a')} startX={10} startY={10} customTypes={[]} onHide={onHide} />);
    await settle(HOVER_DELAY_MS);
    await act(async () => { window.dispatchEvent(new Event('click')); });
    expect(onHide).not.toHaveBeenCalled();
  });

  it('defaults to z-[240] and honours an explicit zIndexClass', async () => {
    const { unmount } = render(
      <DocumentHoverPreview row={makeRow('a')} startX={10} startY={10} customTypes={[]} onHide={vi.fn()} />
    );
    await settle(HOVER_DELAY_MS);
    expect(card()).toHaveClass('z-[240]');
    unmount();

    // Inside a Modal (overlay z-[250]) the default would paint behind it.
    render(
      <DocumentHoverPreview
        row={makeRow('a')} startX={10} startY={10} customTypes={[]} onHide={vi.fn()} zIndexClass="z-[260]"
      />
    );
    await settle(HOVER_DELAY_MS);
    expect(card()).toHaveClass('z-[260]');
    expect(card()).not.toHaveClass('z-[240]');
  });
});
