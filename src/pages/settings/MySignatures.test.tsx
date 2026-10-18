// src/pages/settings/MySignatures.test.tsx — User Preferences → My
// signatures: the list with its default, making another the default, and the
// one-time import from the old PDF editor.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { MySignatures } from './MySignatures';

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  listSignatures: vi.fn(), addSignature: vi.fn(), updateSignature: vi.fn(), deleteSignature: vi.fn(), fetchFileBlob: vi.fn(),
}));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock('../../utils/store', async (orig) => {
  const { toast: _t, ...store } = h;
  return { ...(await orig<typeof import('../../utils/store')>()), ...store };
});

const sig = (id: string, name: string, isDefault = false) => ({ id, name, isDefault, mime: 'image/png', size: 1, createdAt: 1, createdBy: 'me' });
const renderIt = () => render(<ConfirmProvider><MySignatures /></ConfirmProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.listSignatures.mockResolvedValue([sig('a', 'Full', true), sig('b', 'Initials')]);
  h.fetchFileBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  h.updateSignature.mockResolvedValue({});
  h.deleteSignature.mockResolvedValue(undefined);
  h.addSignature.mockResolvedValue({});
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:sig');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('MySignatures', () => {
  it('shows each signature, loaded through the signed-in route, and which is the default', async () => {
    renderIt();
    const rows = await screen.findAllByTestId('signature-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId('signature-default')).toBeInTheDocument();
    await waitFor(() => expect(within(rows[0]).getByAltText('Full')).toHaveAttribute('src', 'blob:sig'));
    expect(h.fetchFileBlob).toHaveBeenCalledWith('a');
  });

  it('makes another the default, and deletes after a confirm', async () => {
    renderIt();
    const rows = await screen.findAllByTestId('signature-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(h.updateSignature).toHaveBeenCalledWith('b', { isDefault: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Initials' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.deleteSignature).toHaveBeenCalledWith('b'));
  });

  it('brings over signatures the old PDF editor saved in this browser, once', async () => {
    const png = 'data:image/png;base64,' + btoa('old sig');
    localStorage.setItem('pdfEditorSignatures', JSON.stringify([
      { id: 'x', name: 'Old one', dataUrl: png, naturalWidth: 10, naturalHeight: 5 },
      { id: 'y', name: 'Broken', dataUrl: 'not an image' },
    ]));
    renderIt();
    await waitFor(() => expect(h.addSignature).toHaveBeenCalledTimes(1));
    const [blob, name] = h.addSignature.mock.calls[0];
    expect(name).toBe('Old one');
    expect((blob as Blob).type).toBe('image/png');
    expect(h.toast).toHaveBeenCalledWith('1 signature from the old PDF editor added', { type: 'success' });
    expect(localStorage.getItem('pdfEditorSignatures')).toBeNull();
  });

  it('keeps an old signature that failed to upload for next time', async () => {
    localStorage.setItem('pdfEditorSignatures', JSON.stringify([{ name: 'Old', dataUrl: 'data:image/png;base64,' + btoa('x') }]));
    h.addSignature.mockRejectedValue(new Error('offline'));
    renderIt();
    await waitFor(() => expect(h.addSignature).toHaveBeenCalled());
    await waitFor(() => expect(JSON.parse(localStorage.getItem('pdfEditorSignatures')!)).toHaveLength(1));
    expect(h.toast).not.toHaveBeenCalledWith(expect.stringContaining('from the old PDF editor'), expect.anything());
  });
});
