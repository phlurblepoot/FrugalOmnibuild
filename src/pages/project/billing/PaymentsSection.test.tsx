// src/pages/project/billing/PaymentsSection.test.tsx
// Billing → Payments: photos and PDFs staged while a payment is recorded and
// filed under it once it exists; a row opens the payment's detail view (spec
// docs/superpowers/specs/2026-10-06-payment-attachments-design.md).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Payment } from '../../../utils/store';
import { useTimeZone } from '../../../test/timeZone';

const h = vi.hoisted(() => ({
  getProjectPayments: vi.fn(),
  getInvoices: vi.fn(),
  getPayApps: vi.fn(),
  recordPayment: vi.fn(),
  deletePayment: vi.fn(),
  uploadProjectFile: vi.fn(),
  addPaymentAttachment: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  pickerProps: null as any,
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../../components/ConfirmDialog', () => ({ useConfirm: () => h.confirm }));
vi.mock('../../../components/Toast', async (orig) => ({
  ...(await orig<typeof import('../../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getProjectPayments: h.getProjectPayments,
  getInvoices: h.getInvoices,
  getPayApps: h.getPayApps,
  recordPayment: h.recordPayment,
  deletePayment: h.deletePayment,
  uploadProjectFile: h.uploadProjectFile,
  addPaymentAttachment: h.addPaymentAttachment,
}));

const CHECK = new File(['jpg'], 'Check.jpg', { type: 'image/jpeg' });
const RECEIPT = new File(['%PDF'], 'Receipt.pdf', { type: 'application/pdf' });

// Stand-in picker button: the Upload tab hands back files unstored
// (onPickFiles); the Existing tab hands back rows already in the app.
vi.mock('../../../components/documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickerProps = props;
    return (
      <>
        <button data-testid="pick-files" disabled={props.disabled} onClick={() => void props.onPickFiles?.([CHECK, RECEIPT])}>{props.label}</button>
        <button data-testid="pick-existing" onClick={() => void props.onPick?.([{ id: 'doc-7', name: 'ACH confirmation.pdf' }])}>existing</button>
      </>
    );
  },
}));

// The detail view has its own tests; here only what the section hands it.
vi.mock('./PaymentDetailModal', async (orig) => ({
  ...(await orig<typeof import('./PaymentDetailModal')>()),
  PaymentDetailModal: ({ paymentId, onClose, onChanged }: any) => (
    <div data-testid="payment-detail">
      <span>{paymentId}</span>
      <button onClick={onChanged}>detail changed</button>
      <button onClick={onClose}>detail close</button>
    </div>
  ),
}));

import { PaymentsSection } from './PaymentsSection';

const pay = (over: Partial<Payment> = {}): Payment => ({
  id: 'pay-1', targetType: 'invoice', targetId: 'inv-1', date: Date.UTC(2026, 9, 1, 12), amount: 100,
  method: 'ach', note: null, createdAt: 1, targetLabel: 'Invoice 1001', attachmentCount: 2,
  ...over,
});

const Location = () => <span data-testid="location">{useLocation().search}</span>;
const onChange = vi.fn();
const mount = (entry = '/') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <PaymentsSection projectId="p1" onChange={onChange} />
      <Location />
    </MemoryRouter>
  );

const fillForm = () => {
  fireEvent.change(screen.getByLabelText('Applied to'), { target: { value: 'invoice:inv-1' } });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.pickerProps = null;
  h.getProjectPayments.mockResolvedValue([pay(), pay({ id: 'pay-2', targetLabel: 'Application #3', method: 'check', attachmentCount: 0 })]);
  h.getInvoices.mockResolvedValue([{ id: 'inv-1', number: '1001' }]);
  h.getPayApps.mockResolvedValue([]);
  h.recordPayment.mockResolvedValue({ id: 'new-pay' });
  h.deletePayment.mockResolvedValue(undefined);
  h.uploadProjectFile.mockImplementation(async (_p: string, f: File) => ({ fileId: `up-${f.name}`, versioned: false }));
  h.addPaymentAttachment.mockResolvedValue(undefined);
  h.confirm.mockResolvedValue(true);
});

describe('PaymentsSection — rows', () => {
  it('shows a paperclip with the count only on payments that have attachments', async () => {
    mount();
    await screen.findByTestId('payment-row-pay-1');
    expect(screen.getByTestId('payment-attachment-count-pay-1')).toHaveTextContent('2');
    expect(screen.getByTestId('payment-attachment-count-pay-1')).toHaveAttribute('title', '2 attachments');
    expect(screen.queryByTestId('payment-attachment-count-pay-2')).toBeNull();
    expect(within(screen.getByTestId('payment-row-pay-1')).getByText('ACH')).toBeInTheDocument();
  });

  it('opens the payment\'s detail view when its row is clicked, and reloads when it changes', async () => {
    mount();
    fireEvent.click(await screen.findByText('Application #3'));
    expect(within(screen.getByTestId('payment-detail')).getByText('pay-2')).toBeInTheDocument();

    fireEvent.click(screen.getByText('detail changed'));
    await waitFor(() => expect(h.getProjectPayments).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenCalled();
    fireEvent.click(screen.getByText('detail close'));
    expect(screen.queryByTestId('payment-detail')).toBeNull();
  });

  it('deletes from the row after a confirm without opening the detail view', async () => {
    mount();
    await screen.findByTestId('payment-row-pay-1');
    fireEvent.click(within(screen.getByTestId('payment-row-pay-1')).getByRole('button', { name: 'Delete payment' }));
    await waitFor(() => expect(h.deletePayment).toHaveBeenCalledWith('pay-1'));
    expect(screen.queryByTestId('payment-detail')).toBeNull();
    expect(onChange).toHaveBeenCalled();
  });

  it('?open= opens that payment (the Documents source link) and strips the param', async () => {
    mount('/?tab=payments&open=pay-2');
    expect(within(await screen.findByTestId('payment-detail')).getByText('pay-2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=payments'));
    expect(screen.getByTestId('location').textContent).not.toContain('open=');
  });
});

describe('PaymentsSection — attaching while recording', () => {
  it('offers photos or PDFs, staged rather than stored, with no forced camera', async () => {
    mount();
    await screen.findByTestId('payment-row-pay-1');
    expect(h.pickerProps).toMatchObject({
      label: 'Attach', accept: 'image-pdf', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'payment-attachment', projectId: 'p1' },
    });
    expect(typeof h.pickerProps.onPickFiles).toBe('function');
    expect(h.pickerProps.upload.capture).toBeUndefined();
    expect(h.pickerProps.upload.sourceId).toBeUndefined(); // nothing to file under yet
  });

  it('stages picked files with remove, and stores nothing until the payment is recorded', async () => {
    mount();
    await screen.findByTestId('payment-row-pay-1');
    fireEvent.click(screen.getByTestId('pick-files'));
    fireEvent.click(screen.getByTestId('pick-existing'));
    expect(screen.getAllByTestId('payment-staged-attachment').map(e => e.textContent)).toEqual(['Check.jpg', 'Receipt.pdf', 'ACH confirmation.pdf']);
    expect(h.pickerProps.excludeFileIds).toEqual(['doc-7']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Receipt.pdf' }));
    expect(screen.getAllByTestId('payment-staged-attachment')).toHaveLength(2);
    expect(h.uploadProjectFile).not.toHaveBeenCalled();
    expect(h.addPaymentAttachment).not.toHaveBeenCalled();
  });

  it('records the payment, then uploads new files under it and links them and the picked document', async () => {
    mount();
    await screen.findByTestId('payment-row-pay-1');
    fillForm();
    fireEvent.click(screen.getByTestId('pick-files'));
    fireEvent.click(screen.getByTestId('pick-existing'));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    await waitFor(() => expect(h.addPaymentAttachment).toHaveBeenCalledTimes(3));
    expect(h.recordPayment).toHaveBeenCalledWith('p1', 'invoice', 'inv-1', expect.objectContaining({ amount: 250, method: 'check' }));
    expect(h.uploadProjectFile).toHaveBeenCalledTimes(2);
    expect(h.uploadProjectFile).toHaveBeenNthCalledWith(1, 'p1', CHECK, 'payment-attachment', { sourceType: 'payment', sourceId: 'new-pay' });
    expect(h.uploadProjectFile).toHaveBeenNthCalledWith(2, 'p1', RECEIPT, 'payment-attachment', { sourceType: 'payment', sourceId: 'new-pay' });
    expect(h.addPaymentAttachment.mock.calls).toEqual([
      ['new-pay', 'up-Check.jpg'], ['new-pay', 'up-Receipt.pdf'], ['new-pay', 'doc-7'],
    ]);
    expect(h.toast).toHaveBeenCalledWith('Payment recorded', { type: 'success' });
    await waitFor(() => expect(screen.queryAllByTestId('payment-staged-attachment')).toHaveLength(0));
    expect(onChange).toHaveBeenCalled();
  });

  it('stages photos and PDFs dropped on the form, ignoring other files', async () => {
    mount();
    await screen.findByTestId('payment-row-pay-1');
    fireEvent.drop(screen.getByTestId('payment-record-dropzone'), {
      dataTransfer: { files: [CHECK, new File(['a,b'], 'ledger.csv', { type: 'text/csv' }), RECEIPT] },
    });
    expect(screen.getAllByTestId('payment-staged-attachment').map(e => e.textContent)).toEqual(['Check.jpg', 'Receipt.pdf']);
    expect(h.uploadProjectFile).not.toHaveBeenCalled();
  });

  it('a payment with nothing staged uploads nothing', async () => {
    mount();
    await screen.findByTestId('payment-row-pay-1');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(h.recordPayment).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(h.uploadProjectFile).not.toHaveBeenCalled();
    expect(h.addPaymentAttachment).not.toHaveBeenCalled();
  });

  it('keeps the staged files when recording fails', async () => {
    h.recordPayment.mockRejectedValue(new Error('nope'));
    mount();
    await screen.findByTestId('payment-row-pay-1');
    fillForm();
    fireEvent.click(screen.getByTestId('pick-files'));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Failed to record payment', { type: 'error' }));
    expect(screen.getAllByTestId('payment-staged-attachment')).toHaveLength(2);
    expect(h.uploadProjectFile).not.toHaveBeenCalled();
  });

  it('says how many attachments made it when some fail, the payment itself being recorded', async () => {
    h.uploadProjectFile.mockRejectedValueOnce(new Error('offline'));
    mount();
    await screen.findByTestId('payment-row-pay-1');
    fillForm();
    fireEvent.click(screen.getByTestId('pick-files'));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(
      'Added 1 of 2 attachments — open the payment to add the rest', { type: 'warning' },
    ));
    expect(h.addPaymentAttachment).toHaveBeenCalledWith('new-pay', 'up-Receipt.pdf');
  });
});

describe('PaymentsSection — dates west of UTC', () => {
  useTimeZone('America/Los_Angeles');
  afterEach(() => { vi.useRealTimers(); });

  it('shows a picked date as that day, and a payment stamped "now" as its local day', async () => {
    h.getProjectPayments.mockResolvedValue([
      pay({ date: new Date('2026-10-01').getTime() }),
      pay({ id: 'pay-2', date: Date.UTC(2026, 9, 7, 3, 30) }), // Oct 6, 8:30pm in Los Angeles
    ]);
    mount();
    const row1 = await screen.findByTestId('payment-row-pay-1');
    expect(within(row1).getByText(new Date(2026, 9, 1).toLocaleDateString())).toBeInTheDocument();
    expect(within(screen.getByTestId('payment-row-pay-2')).getByText(new Date(2026, 9, 6).toLocaleDateString())).toBeInTheDocument();
  });

  it('starts the date box at today on the local calendar and records that picked day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 7, 3, 30)); // Oct 6, 8:30pm in Los Angeles — already Oct 7 in UTC
    mount();
    await screen.findByTestId('payment-row-pay-1');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-06');

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(h.recordPayment).toHaveBeenCalledWith('p1', 'invoice', 'inv-1', expect.objectContaining({ date: new Date('2026-10-06').getTime() }));
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-06'); // ready for the next one
  });
});
