// src/pages/project/billing/PaymentDetailModal.test.tsx
// One payment opened from Billing → Payments: edit, delete, and its own photos
// and PDFs (spec docs/superpowers/specs/2026-10-06-payment-attachments-design.md).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HttpError, type PaymentDetail } from '../../../utils/store';
import { useTimeZone } from '../../../test/timeZone';

const h = vi.hoisted(() => ({
  getPayment: vi.fn(),
  updatePayment: vi.fn(),
  deletePayment: vi.fn(),
  addPaymentAttachment: vi.fn(),
  removePaymentAttachment: vi.fn(),
  uploadProjectFile: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  pickerProps: null as any,
  socket: null as any,
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: h.socket, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../../components/ConfirmDialog', () => ({ useConfirm: () => h.confirm }));
vi.mock('../../../components/Toast', async (orig) => ({
  ...(await orig<typeof import('../../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getPayment: h.getPayment,
  updatePayment: h.updatePayment,
  deletePayment: h.deletePayment,
  addPaymentAttachment: h.addPaymentAttachment,
  removePaymentAttachment: h.removePaymentAttachment,
  uploadProjectFile: h.uploadProjectFile,
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
}));

// Stand-in button: records the picker config and hands back one stored row.
vi.mock('../../../components/documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickerProps = props;
    return (
      <button data-testid="add-files-button" disabled={props.disabled} onClick={() => void props.onPick?.([{ id: 'picked-1', name: 'Remit.pdf' }])}>
        {props.label}
      </button>
    );
  },
}));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row }: any) => <div data-testid="viewer">{row.name} · {row.kind} · {row.mime}</div>,
}));

import { PaymentDetailModal } from './PaymentDetailModal';

const PHOTO = { id: 'pa-1', fileId: 'f-check', sortOrder: 0, name: 'Check.jpg', mime: 'image/jpeg', size: 2048, kind: 'payment-attachment', createdAt: 5, versionNumber: 1 };
const PDF = { id: 'pa-2', fileId: 'f-remit', sortOrder: 1, name: 'Remittance.pdf', mime: 'application/pdf', size: 4096, kind: 'document', createdAt: 6, versionNumber: 2 };

const payment = (over: Partial<PaymentDetail> = {}): PaymentDetail => ({
  id: 'pay-1', targetType: 'invoice', targetId: 'inv-1', date: Date.UTC(2026, 9, 1, 15, 30), amount: 1250.5,
  method: 'check', note: 'Deposit', createdAt: 1, targetLabel: 'Invoice 1001', projectId: 'p1',
  attachments: [PHOTO, PDF],
  ...over,
});

const onClose = vi.fn();
const onChanged = vi.fn();

const mount = () =>
  render(
    <MemoryRouter>
      <PaymentDetailModal paymentId="pay-1" projectId="p1" onClose={onClose} onChanged={onChanged} />
    </MemoryRouter>
  );

const amountBox = () => screen.getByLabelText('Amount') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  h.socket = null;
  h.pickerProps = null;
  h.getPayment.mockResolvedValue(payment());
  h.updatePayment.mockResolvedValue(undefined);
  h.deletePayment.mockResolvedValue(undefined);
  h.addPaymentAttachment.mockResolvedValue(undefined);
  h.removePaymentAttachment.mockResolvedValue(undefined);
  h.uploadProjectFile.mockResolvedValue({ fileId: 'up-1', versioned: false });
  h.confirm.mockResolvedValue(true);
});

describe('PaymentDetailModal — dates west of UTC', () => {
  useTimeZone('America/Los_Angeles');

  it('fills the date box with the day that was picked', async () => {
    h.getPayment.mockResolvedValue(payment({ date: new Date('2026-10-01').getTime() }));
    mount();
    await screen.findByTestId('payment-target');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-01');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('fills it with the local day of a payment stamped "now" on a US evening', async () => {
    h.getPayment.mockResolvedValue(payment({ date: Date.UTC(2026, 9, 7, 3, 30) })); // Oct 6, 8:30pm in Los Angeles
    mount();
    await screen.findByTestId('payment-target');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-06');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('PaymentDetailModal — the payment', () => {
  it('shows what it paid (read-only) and its fields', async () => {
    mount();
    expect(await screen.findByTestId('payment-target')).toHaveTextContent('Invoice 1001');
    expect(amountBox().value).toBe('1250.5');
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-01');
    expect((screen.getByLabelText('Method') as HTMLSelectElement).value).toBe('check');
    expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('Deposit');
    expect(h.getPayment).toHaveBeenCalledWith('pay-1');
  });

  it('Save and Cancel wake up only on an edit; Cancel puts the saved values back', async () => {
    mount();
    await screen.findByTestId('payment-target');
    const save = screen.getByRole('button', { name: 'Save' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(save).toBeDisabled();
    expect(cancel).toBeDisabled();

    fireEvent.change(amountBox(), { target: { value: '1300' } });
    expect(save).toBeEnabled();
    fireEvent.click(cancel);
    expect(amountBox().value).toBe('1250.5');
    expect(save).toBeDisabled();
  });

  it('saves the edit — an untouched date goes back exactly as stored — then reloads and tells the list', async () => {
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.change(amountBox(), { target: { value: '1300' } });
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'ach' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  ' } });
    h.getPayment.mockResolvedValue(payment({ amount: 1300, method: 'ach', note: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(h.updatePayment).toHaveBeenCalledWith('pay-1', {
      amount: 1300, date: Date.UTC(2026, 9, 1, 15, 30), method: 'ach', note: '  ',
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(h.getPayment).toHaveBeenCalledTimes(2);
    expect(amountBox().value).toBe('1300');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends a changed date as that day', async () => {
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.updatePayment).toHaveBeenCalledWith('pay-1', expect.objectContaining({
      date: new Date('2026-10-03').getTime(),
    })));
  });

  it('will not save a zero amount or an empty date', async () => {
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.change(amountBox(), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(amountBox(), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps a method recorded some other way selectable', async () => {
    h.getPayment.mockResolvedValue(payment({ method: 'wire' }));
    mount();
    await screen.findByTestId('payment-target');
    expect((screen.getByLabelText('Method') as HTMLSelectElement).value).toBe('wire');
  });

  it('deletes after a confirm, then tells the list and closes', async () => {
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.click(screen.getByRole('button', { name: /Delete payment/ }));
    await waitFor(() => expect(h.deletePayment).toHaveBeenCalledWith('pay-1'));
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete payment?', tone: 'danger' }));
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the payment when the delete is not confirmed', async () => {
    h.confirm.mockResolvedValue(false);
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.click(screen.getByRole('button', { name: /Delete payment/ }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalled());
    expect(h.deletePayment).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes with a note when the payment was deleted elsewhere', async () => {
    h.getPayment.mockRejectedValue(new HttpError('Payment not found', 404));
    mount();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.toast).toHaveBeenCalledWith('This payment was deleted', { type: 'warning' });
  });
});

describe('PaymentDetailModal — attachments', () => {
  it('shows photos as thumbnails and PDFs by name and size', async () => {
    mount();
    await screen.findByTestId('payment-target');
    // The modal portals to <body>: query the screen, not the render container.
    const thumb = screen.getByTestId('payment-photo-f-check').querySelector('img')!;
    expect(thumb.getAttribute('src')).toBe('/api/images/f-check/thumb');
    expect(screen.getByTestId('payment-file-f-remit')).toHaveTextContent('Remittance.pdf');
    expect(screen.getByTestId('payment-file-f-remit')).toHaveTextContent('4.0 KB');
  });

  it('opens a photo in the lightbox', async () => {
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.click(screen.getByTestId('payment-photo-f-check').querySelector('img')!);
    expect(await screen.findByText('1 / 1')).toBeInTheDocument();
  });

  it('opens a PDF in the document viewer', async () => {
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.click(screen.getByRole('button', { name: 'Remittance.pdf' }));
    expect(await screen.findByTestId('viewer')).toHaveTextContent('Remittance.pdf · document · application/pdf');
  });

  it('adds more through the shared picker: photos or PDFs, filed under the payment', async () => {
    mount();
    await screen.findByTestId('payment-target');
    expect(h.pickerProps).toMatchObject({
      accept: 'image-pdf', defaultTab: 'upload', initialProjectIds: ['p1'],
      excludeFileIds: ['f-check', 'f-remit'],
      upload: { kind: 'payment-attachment', projectId: 'p1', sourceType: 'payment', sourceId: 'pay-1' },
    });
    expect(h.pickerProps.upload.capture).toBeUndefined();

    fireEvent.click(screen.getByTestId('add-files-button'));
    await waitFor(() => expect(h.addPaymentAttachment).toHaveBeenCalledWith('pay-1', 'picked-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(h.getPayment).toHaveBeenCalledTimes(2);
  });

  it('uploads a dropped photo or PDF under the payment and links it; other files are ignored', async () => {
    mount();
    await screen.findByTestId('payment-target');
    const shot = new File(['x'], 'check.png', { type: 'image/png' });
    const pdf = new File(['%PDF'], 'ach.pdf', { type: 'application/pdf' });
    fireEvent.drop(screen.getByTestId('payment-attachments-dropzone'), {
      dataTransfer: { files: [shot, new File(['a,b'], 'ledger.csv', { type: 'text/csv' }), pdf] },
    });
    await waitFor(() => expect(h.addPaymentAttachment).toHaveBeenCalledTimes(2));
    expect(h.uploadProjectFile).toHaveBeenCalledTimes(2);
    expect(h.uploadProjectFile).toHaveBeenNthCalledWith(1, 'p1', shot, 'payment-attachment', { sourceType: 'payment', sourceId: 'pay-1' });
    expect(h.uploadProjectFile).toHaveBeenNthCalledWith(2, 'p1', pdf, 'payment-attachment', { sourceType: 'payment', sourceId: 'pay-1' });
  });

  it('removes a photo after a confirm', async () => {
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Check.jpg' }));
    await waitFor(() => expect(h.removePaymentAttachment).toHaveBeenCalledWith('pay-1', 'f-check'));
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove attachment?', tone: 'danger' }));
    // Removing the thumbnail's button did not also open the lightbox.
    expect(screen.queryByText('1 / 1')).toBeNull();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('keeps a PDF when the remove is not confirmed', async () => {
    h.confirm.mockResolvedValue(false);
    mount();
    await screen.findByTestId('payment-target');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Remittance.pdf' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalled());
    expect(h.removePaymentAttachment).not.toHaveBeenCalled();
  });

  it('shows the empty hint without attachments', async () => {
    h.getPayment.mockResolvedValue(payment({ attachments: [] }));
    mount();
    expect(await screen.findByText(/No attachments\./)).toBeInTheDocument();
  });

  it('lists a file deleted since as no longer available, still removable', async () => {
    h.getPayment.mockResolvedValue(payment({
      attachments: [{ id: 'pa-3', fileId: 'f-gone', sortOrder: 0, name: null, mime: null, size: null, kind: null, createdAt: null, versionNumber: null }],
    }));
    mount();
    expect(await screen.findByText('File no longer available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(h.removePaymentAttachment).toHaveBeenCalledWith('pay-1', 'f-gone'));
  });
});

describe('PaymentDetailModal — live refresh', () => {
  const fakeSocket = () => {
    const handlers: Record<string, ((...a: any[]) => void)[]> = {};
    return {
      on: (evt: string, cb: any) => { (handlers[evt] ??= []).push(cb); },
      off: (evt: string, cb: any) => { handlers[evt] = (handlers[evt] ?? []).filter(x => x !== cb); },
      fire: (evt: string, ...args: any[]) => (handlers[evt] ?? []).forEach(cb => cb(...args)),
    };
  };

  it('picks up a change to this payment made elsewhere, without clobbering an edit in progress', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const socket = fakeSocket();
      h.socket = socket;
      mount();
      await screen.findByTestId('payment-target');

      // Someone else changed the note: a pristine form shows it.
      h.getPayment.mockResolvedValue(payment({ note: 'Changed elsewhere' }));
      act(() => { socket.fire('entity-changed', { type: 'payment', id: 'pay-1', projectId: 'p1', action: 'updated', bySessionId: 'other' }); });
      await act(async () => { vi.advanceTimersByTime(400); });
      await waitFor(() => expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('Changed elsewhere'));

      // Mid-edit, another refresh leaves the typed value alone.
      fireEvent.change(amountBox(), { target: { value: '999' } });
      h.getPayment.mockResolvedValue(payment({ note: 'Again', amount: 5 }));
      act(() => { socket.fire('entity-changed', { type: 'payment', id: 'pay-1', projectId: 'p1', action: 'updated', bySessionId: 'other' }); });
      await act(async () => { vi.advanceTimersByTime(400); });
      await waitFor(() => expect(h.getPayment).toHaveBeenCalledTimes(3));
      expect(amountBox().value).toBe('999');

      // Another payment's change is not this one's business.
      act(() => { socket.fire('entity-changed', { type: 'payment', id: 'pay-2', projectId: 'p1', action: 'updated', bySessionId: 'other' }); });
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(h.getPayment).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
