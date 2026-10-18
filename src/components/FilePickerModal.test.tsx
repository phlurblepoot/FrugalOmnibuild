import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FilePickerModal } from './FilePickerModal';

// previewEngine (pulled in by DocumentHoverPreview) imports pdfjs at module
// load, which jsdom can't execute.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));

// The default rows live here (not inline in the factory) so beforeEach can
// restore them: one test swaps in a never-resolving implementation, and
// clearAllMocks only clears calls, not implementations.
const h = vi.hoisted(() => {
  const ROWS = [
    { id: 'a', name: 'Warranty.pdf', mime: 'application/pdf', size: 10, kind: 'company-document', createdAt: 1, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null },
    { id: 'b', name: 'Spec.pdf', mime: 'application/pdf', size: 10, kind: 'document', createdAt: 2, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Job', customerId: null, customerName: null, source: null },
  ];
  return {
    docs: async (f: { q?: string }) => ({
      rows: ROWS.filter(r => !f.q || r.name.toLowerCase().includes(f.q.toLowerCase())),
      total: 2,
    }),
    up: async (_projectId: string, f: File) => ({ fileId: `up-${f.name}`, versioned: false }),
    toast: vi.fn(),
  };
});

vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  getDocuments: vi.fn(h.docs),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
  uploadProjectFile: vi.fn(h.up),
  saveBinaryFile: vi.fn(async (id: string) => ({ fileId: id, versioned: false })),
  getFileMeta: vi.fn(async (id: string) => ({
    id, projectId: 'p1', name: `${id}.png`, mime: 'image/png', size: 42,
    kind: 'photo', parentFileId: null, versionNumber: 1, createdAt: 7,
  })),
  fetchFileBlob: vi.fn(async (id: string) => new Blob([id], { type: 'application/pdf' })),
}));
vi.mock('./Toast', async (orig) => ({
  ...(await orig<typeof import('./Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
import { fetchFileBlob, getDocuments, getFileMeta, saveBinaryFile, uploadProjectFile } from '../utils/store';

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'u', role: 'admin' }));
  vi.clearAllMocks();
  (getDocuments as unknown as ReturnType<typeof vi.fn>).mockImplementation(h.docs);
  (uploadProjectFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(h.up);
});

const png = (name: string) => new File(['x'], name, { type: 'image/png' });
const uploadCfg = { kind: 'photo', projectId: 'p1', sourceType: 'issue', sourceId: 'i1' };

describe('FilePickerModal', () => {
  it('lists documents, requests the pdf mime filter, hides excluded ids, and returns picked rows', async () => {
    const onPick = vi.fn();
    render(<FilePickerModal open onClose={() => {}} onPick={onPick} accept="pdf" excludeFileIds={['b']} />);
    await screen.findByText('Warranty.pdf');
    expect(screen.queryByText('Spec.pdf')).toBeNull();
    expect((getDocuments as any).mock.calls[0][0].mimes).toEqual(['application/pdf']);
    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })]));
  });

  it('single-select mode replaces the selection', async () => {
    const onPick = vi.fn();
    render(<FilePickerModal open onClose={() => {}} onPick={onPick} multi={false} />);
    await screen.findByText('Spec.pdf');
    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Spec\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })]));
  });

  it('search re-queries', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    await screen.findByText('Spec.pdf');
    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'warr' } });
    await waitFor(() => expect((getDocuments as any).mock.calls.at(-1)[0].q).toBe('warr'), { timeout: 2000 });
  });

  it('asks the server for spreadsheet mimes on accept="spreadsheet"', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} accept="spreadsheet" />);
    await waitFor(() => expect((getDocuments as any).mock.calls[0][0].mimes).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ));
  });

  it('asks the server for photos and PDFs together on accept="image-pdf"', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} accept="image-pdf" />);
    await waitFor(() => expect((getDocuments as any).mock.calls[0][0].mimes).toEqual(['image/', 'application/pdf']));
  });

  // The hover card is portalled to document.body as `fixed z-[240]` by
  // default, which is BEHIND the Modal overlay's z-[250] — inside the picker
  // it must be raised or it renders behind the dialog it belongs to.
  it('renders the hover preview above the modal overlay', async () => {
    // jsdom's matchMedia has no implementation; the picker only mounts the
    // preview when '(hover: hover)' matches.
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as never;

    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    const row = (await screen.findByText('Spec.pdf')).closest('li')!;
    fireEvent.mouseEnter(row, { clientX: 10, clientY: 10 });

    const card = await screen.findByTestId('doc-hover-preview', undefined, { timeout: 2000 });
    expect(card).toHaveClass('z-[260]');
    expect(card).not.toHaveClass('z-[240]');
    expect(Number(screen.getByTestId('modal-overlay').className.match(/z-\[(\d+)\]/)![1])).toBeLessThan(260);
  });

  it('drops a stale response when the filters change again before it resolves', async () => {
    // Two in-flight requests (the initial fetch, then a filter change) that
    // resolve OUT OF ORDER — the older (first) request's response must be
    // dropped so it can't clobber the newer (second) request's rows.
    const resolvers: ((v: unknown) => void)[] = [];
    (getDocuments as any).mockImplementation(
      () => new Promise(resolve => { resolvers.push(resolve); })
    );

    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    await waitFor(() => expect(resolvers.length).toBe(1));

    fireEvent.click(screen.getByTestId('doc-filter-archived'));
    await waitFor(() => expect(resolvers.length).toBe(2));

    // Resolve the NEWER (second) request first.
    await act(async () => {
      resolvers[1]({
        rows: [{ id: 'b', name: 'Spec.pdf', mime: 'application/pdf', size: 10, kind: 'document', createdAt: 2, versionNumber: 1, archived: true, projectId: 'p1', projectName: 'Job', customerId: null, customerName: null, source: null }],
        total: 1,
      });
    });
    expect(screen.getByText('Spec.pdf')).toBeInTheDocument();

    // Now let the STALE (first) request resolve — it must not overwrite.
    await act(async () => {
      resolvers[0]({
        rows: [{ id: 'a', name: 'Warranty.pdf', mime: 'application/pdf', size: 10, kind: 'company-document', createdAt: 1, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null }],
        total: 1,
      });
    });
    expect(screen.queryByText('Warranty.pdf')).toBeNull();
    expect(screen.getByText('Spec.pdf')).toBeInTheDocument();
  });
});

describe('FilePickerModal — returnBlobs on the Existing tab', () => {
  it('fetches the bytes of every picked row before handing them over', async () => {
    const onPickBlobs = vi.fn();
    const onClose = vi.fn();
    render(<FilePickerModal open onClose={onClose} onPickBlobs={onPickBlobs} returnBlobs />);
    await screen.findByText('Spec.pdf');

    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));

    await waitFor(() => expect(onPickBlobs).toHaveBeenCalled());
    expect(fetchFileBlob).toHaveBeenCalledWith('a');
    const picked = onPickBlobs.mock.calls[0][0];
    expect(picked).toHaveLength(1);
    expect(picked[0].row.id).toBe('a');
    expect(picked[0].blob).toBeInstanceOf(Blob);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('FilePickerModal — Upload tab', () => {
  it('has no tabs at all without an upload config', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    await screen.findByText('Spec.pdf');
    expect(screen.queryByRole('tab', { name: 'Upload' })).toBeNull();
    expect(screen.queryByTestId('picker-upload-panel')).toBeNull();
  });

  it('shows the tabs when given an upload config and opens on Existing by default', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} upload={uploadCfg} />);
    await screen.findByText('Spec.pdf');
    expect(screen.getByRole('tab', { name: 'Upload' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Existing' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('picker-upload-panel')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
    expect(screen.getByTestId('picker-upload-panel')).toBeInTheDocument();
  });

  it('starts on the Upload tab with defaultTab="upload"', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} upload={uploadCfg} defaultTab="upload" />);
    expect(screen.getByTestId('picker-upload-panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Upload' })).toHaveAttribute('aria-selected', 'true');
  });

  it('uploads every chosen file, hands back rows built from the stored meta, and closes', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FilePickerModal open onClose={onClose} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    const a = png('a.png');
    const b = png('b.png');
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [a, b] } });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).toHaveBeenCalledTimes(2);
    expect(uploadProjectFile).toHaveBeenNthCalledWith(1, 'p1', a, 'photo', { sourceType: 'issue', sourceId: 'i1' });
    expect(getFileMeta).toHaveBeenCalledWith('up-a.png');
    expect(onPick.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: 'up-a.png', name: 'up-a.png.png', kind: 'photo', projectId: 'p1' }),
      expect.objectContaining({ id: 'up-b.png' }),
    ]);
    expect(h.toast).not.toHaveBeenCalledWith(expect.stringContaining('of'), expect.anything());
    expect(onClose).toHaveBeenCalled();
  });

  it('uploads through saveBinaryFile when the config has no project', async () => {
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image" defaultTab="upload"
        upload={{ kind: 'photo', customerId: 'c1' }} />
    );
    const a = png('a.png');
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [a] } });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).not.toHaveBeenCalled();
    expect(saveBinaryFile).toHaveBeenCalledWith(expect.any(String), a, expect.objectContaining({
      kind: 'photo', name: 'a.png', customerId: 'c1',
    }));
  });

  it('reports a partial failure and still returns what made it', async () => {
    (uploadProjectFile as any).mockRejectedValueOnce(new Error('boom'));
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [png('a.png'), png('b.png')] } });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(h.toast).toHaveBeenCalledWith('Uploaded 1 of 2 files', expect.objectContaining({ type: 'warning' }));
    expect(onPick.mock.calls[0][0]).toEqual([expect.objectContaining({ id: 'up-b.png' })]);
  });

  it('keeps the picker open when every upload fails', async () => {
    (uploadProjectFile as any).mockRejectedValue(new Error('boom'));
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FilePickerModal open onClose={onClose} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [png('a.png')] } });

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Uploaded 0 of 1 files', expect.objectContaining({ type: 'error' })));
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hands back the original File as the blob when returnBlobs is set', async () => {
    const onPickBlobs = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPickBlobs={onPickBlobs} returnBlobs accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    const a = png('a.png');
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [a] } });

    await waitFor(() => expect(onPickBlobs).toHaveBeenCalled());
    expect(onPickBlobs.mock.calls[0][0][0].blob).toBe(a);
    expect(onPickBlobs.mock.calls[0][0][0].row.id).toBe('up-a.png');
  });

  it('drops files the accept filter rejects on a drag-drop', async () => {
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    const good = png('a.png');
    fireEvent.drop(screen.getByTestId('picker-dropzone'), {
      dataTransfer: { files: [good, new File(['x'], 'plan.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).toHaveBeenCalledTimes(1);
    expect(uploadProjectFile).toHaveBeenCalledWith('p1', good, 'photo', expect.anything());
  });
});

// For a record that doesn't exist yet (a payment being recorded): the Upload
// tab hands the chosen files back unstored and the caller files them later.
describe('FilePickerModal — onPickFiles (staged uploads)', () => {
  it('hands back the chosen files without storing them, and closes', async () => {
    const onPickFiles = vi.fn();
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FilePickerModal open onClose={onClose} onPick={onPick} onPickFiles={onPickFiles} accept="image-pdf"
        upload={{ kind: 'payment-attachment', projectId: 'p1' }} defaultTab="upload" />
    );
    const input = screen.getByTestId('picker-upload-input');
    expect(input).toHaveAttribute('accept', 'image/*,application/pdf,.pdf');
    expect(input).not.toHaveAttribute('capture');
    const a = png('check.png');
    const b = new File(['%PDF'], 'remit.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [a, b] } });

    await waitFor(() => expect(onPickFiles).toHaveBeenCalledWith([a, b]));
    expect(onClose).toHaveBeenCalled();
    expect(uploadProjectFile).not.toHaveBeenCalled();
    expect(saveBinaryFile).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('stages a drag-drop the same way, still filtered by accept', async () => {
    const onPickFiles = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPickFiles={onPickFiles} accept="image-pdf"
        upload={{ kind: 'payment-attachment', projectId: 'p1' }} defaultTab="upload" />
    );
    const shot = png('check.png');
    fireEvent.drop(screen.getByTestId('picker-dropzone'), {
      dataTransfer: { files: [shot, new File(['a,b'], 'ledger.csv', { type: 'text/csv' })] },
    });
    await waitFor(() => expect(onPickFiles).toHaveBeenCalledWith([shot]));
    expect(uploadProjectFile).not.toHaveBeenCalled();
  });

  it('leaves the Existing tab returning rows as before', async () => {
    const onPick = vi.fn();
    const onPickFiles = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} onPickFiles={onPickFiles}
        upload={{ kind: 'payment-attachment', projectId: 'p1' }} />
    );
    await screen.findByText('Spec.pdf');
    fireEvent.click(screen.getByRole('checkbox', { name: /Spec\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })]));
    expect(onPickFiles).not.toHaveBeenCalled();
  });
});

describe('FilePickerModal — query cost', () => {
  it('does not query documents while it is showing the Upload tab', async () => {
    render(
      <FilePickerModal open onClose={() => {}} onPick={() => {}} upload={uploadCfg} defaultTab="upload" />
    );
    expect(screen.getByTestId('picker-upload-panel')).toBeInTheDocument();
    expect(getDocuments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    await screen.findByText('Spec.pdf');
    expect(getDocuments).toHaveBeenCalledTimes(1);
  });
});

describe('FilePickerModal — upload guards', () => {
  // useDropZone filters by type, not by count: without a cap in runUpload a
  // single-file picker silently uploads a whole dropped batch.
  it('uploads only the first file when multi is false, however many are dropped', async () => {
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image" multi={false}
        upload={uploadCfg} defaultTab="upload" />
    );
    const first = png('a.png');
    fireEvent.drop(screen.getByTestId('picker-dropzone'), {
      dataTransfer: { files: [first, png('b.png'), png('c.png')] },
    });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).toHaveBeenCalledTimes(1);
    expect(uploadProjectFile).toHaveBeenCalledWith('p1', first, 'photo', expect.anything());
    expect(h.toast).toHaveBeenCalledWith('Only one file can be added here', expect.objectContaining({ type: 'warning' }));
    expect(onPick.mock.calls[0][0]).toHaveLength(1);
  });

  it('honours a single-file upload config even when the picker itself is multi', async () => {
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image"
        upload={{ ...uploadCfg, multi: false }} defaultTab="upload" />
    );
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [png('a.png'), png('b.png')] } });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).toHaveBeenCalledTimes(1);
  });

  // Modal calls onClose unconditionally from Escape, the backdrop and the X.
  // Closing mid-upload would leave a file stored server-side that onPick never
  // reported — an orphan the caller can't link.
  it('refuses to close while an upload is in flight, then closes when it lands', async () => {
    let release!: (v: { fileId: string; versioned: boolean }) => void;
    (uploadProjectFile as any).mockImplementationOnce(() => new Promise(res => { release = res; }));
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FilePickerModal open onClose={onClose} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [png('a.png')] } });
    await screen.findByText('Uploading…');

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('modal-overlay'));
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('picker-upload-panel')).toBeInTheDocument();

    // The tabs stay live during an upload, so the Existing tab's (enabled)
    // Cancel is another route to the same orphan.
    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));

    await act(async () => { release({ fileId: 'up-a.png', versioned: false }); });
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the picker is unmounted mid-upload', async () => {
    let release!: (v: { fileId: string; versioned: boolean }) => void;
    (uploadProjectFile as any).mockImplementationOnce(() => new Promise(res => { release = res; }));
    const onPick = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <FilePickerModal open onClose={onClose} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [png('a.png')] } });
    await screen.findByText('Uploading…');

    unmount();
    await act(async () => { release({ fileId: 'up-a.png', versioned: false }); });

    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
