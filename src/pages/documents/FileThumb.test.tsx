// src/pages/documents/FileThumb.test.tsx — thumbnails in the Documents list:
// page one of editor files, waited for while being made (202) and remembered
// per file version; photos shrunk by the server, as a plain <img>; the type
// icon otherwise.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileThumb, resetThumbnailCache, useThumbnail } from './FileThumb';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'f1', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Letter.docx',
  versionNumber: 2, createdAt: 100, ...over,
});

let responses: number[];
const fetchMock = vi.fn(async () => {
  const status = responses.shift() ?? 404;
  return new Response(status === 200 ? 'png' : '{}', { status });
});

beforeEach(() => {
  resetThumbnailCache();
  responses = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:thumb');
});
afterEach(() => vi.unstubAllGlobals());

const Probe: React.FC<{ r: ReturnType<typeof row> }> = ({ r }) => {
  const url = useThumbnail(r, true, async () => {});
  return <span data-testid="url">{url ?? 'none'}</span>;
};

describe('FileThumb', () => {
  it('waits while it is being made, then shows page one; asks with the file version', async () => {
    responses = [202, 202, 200];
    render(<Probe r={row()} />);
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('blob:thumb'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/onlyoffice/thumbnail/f1?v=2-100');
  });

  it('remembers the answer for that version', async () => {
    responses = [200];
    const first = render(<Probe r={row()} />);
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('blob:thumb'));
    first.unmount();
    render(<Probe r={row()} />);
    expect(screen.getByTestId('url')).toHaveTextContent('blob:thumb');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the icon when there is none, and never asks for images', async () => {
    responses = [404];
    render(<FileThumb row={row()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('file-thumb')).toBeNull();

    fetchMock.mockClear();
    render(<FileThumb row={row({ id: 'p', mime: 'image/png', name: 'site.png' })} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the picture once it is ready', async () => {
    responses = [200];
    render(<FileThumb row={row({ id: 'f2' })} />);
    expect(await screen.findByTestId('file-thumb')).toBeInTheDocument();
  });

  it('shows a photo shrunk, straight from its thumb url with the file version', () => {
    render(<FileThumb row={row({ id: 'p', mime: 'image/jpeg', name: 'site.jpg' })} />);
    const img = screen.getByTestId('file-thumb').querySelector('img')!;
    expect(img).toHaveAttribute('src', '/api/images/p/thumb?v=2-100');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the icon when the photo fails to load, or cannot be shrunk', () => {
    const { unmount } = render(<FileThumb row={row({ id: 'p', mime: 'image/png', name: 'site.png' })} />);
    fireEvent.error(screen.getByTestId('file-thumb').querySelector('img')!);
    expect(screen.queryByTestId('file-thumb')).toBeNull();
    unmount();

    render(<FileThumb row={row({ id: 'h', mime: 'image/heic', name: 'IMG_0001.HEIC' })} />);
    expect(screen.queryByTestId('file-thumb')).toBeNull();
  });
});
