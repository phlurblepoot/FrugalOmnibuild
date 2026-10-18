// src/pages/project/billing/AiaScheduleOfValues.test.tsx
//
// The SOV can be seeded from a spreadsheet. Until now that spreadsheet had to
// come off the local disk, even when the very same workbook was already filed
// under Documents — so the import now accepts a picked document and runs the
// identical column A/column B parse over its bytes
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as XLSX from 'xlsx';
import { ToastProvider } from '../../../components/Toast';
import { ConfirmProvider } from '../../../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  pickers: new Map<string, any>(),
  getSov: vi.fn(async () => [] as any[]),
  seedSov: vi.fn(async (_p: string, lines: any[]) => ({ count: lines.length })),
  getSovLock: vi.fn(async () => ({ locked: false, payAppCount: 0 }) as any),
  lockSov: vi.fn(async () => ({ locked: true, payAppCount: 0 }) as any),
  unlockSov: vi.fn(async () => ({ locked: false, payAppCount: 0 }) as any),
  reorderSov: vi.fn(async () => undefined),
  createSovLine: vi.fn(async () => ({ id: 'new' })),
  deleteSovLine: vi.fn(async () => undefined),
}));

vi.mock('../../../components/documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickers.set(props.label, props);
    return <button data-testid={`picker-${props.label}`}>{props.label}</button>;
  },
}));
vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  getSov: h.getSov,
  seedSov: h.seedSov,
  getSovLock: h.getSovLock,
  lockSov: h.lockSov,
  unlockSov: h.unlockSov,
  reorderSov: h.reorderSov,
  createSovLine: h.createSovLine,
  deleteSovLine: h.deleteSovLine,
  syncChangeOrders: vi.fn(async () => ({ added: 0 })),
  getProject: vi.fn(async () => null),
}));

import { AiaScheduleOfValues } from './AiaScheduleOfValues';

const sheetBlob = (rows: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'SOV');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
};

const row = { id: 'doc-1', name: 'SOV.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const mount = () => render(
  <ToastProvider>
    <ConfirmProvider>
      <AiaScheduleOfValues projectId="p1" aiaSettings={null} />
    </ConfirmProvider>
  </ToastProvider>
);

// clearAllMocks wipes call history but keeps implementations, so the lock
// state a single test overrides has to be restored explicitly.
beforeEach(() => {
  h.pickers.clear();
  vi.clearAllMocks();
  h.getSov.mockResolvedValue([]);
  h.getSovLock.mockResolvedValue({ locked: false, payAppCount: 0 });
});

const line = (over: Partial<any>): any => ({
  id: 'l1', projectId: 'p1', itemNo: '1', description: 'Framing', scheduledValueCents: 100000,
  retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0, lineType: 'item', ...over,
});

describe('AiaScheduleOfValues — import from documents', () => {
  it('offers a single-pick spreadsheet picker that returns bytes', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Import from documents');
    expect(props).toBeTruthy();
    expect(props.accept).toBe('spreadsheet');
    expect(props.multi).toBe(false);
    expect(props.returnBlobs).toBe(true);
    expect(props.initialProjectIds).toEqual(['p1']);
    // The disk upload stays — this is an extra route in, not a replacement.
    expect(screen.getByRole('button', { name: /Upload sheet/i })).toBeInTheDocument();
  });

  it('parses the picked workbook into schedule-of-values lines', async () => {
    await act(async () => { mount(); });
    await act(async () => {
      await h.pickers.get('Import from documents').onPickBlobs([{
        row,
        blob: sheetBlob([
          ['Description', 'Value'],
          ['Lath & scratch', '12,500.00'],
          ['Brown coat', 8000],
          ['', ''],
        ]),
      }]);
    });
    await waitFor(() => expect(h.seedSov).toHaveBeenCalledWith('p1', [
      { description: 'Lath & scratch', scheduledValueCents: 1250000 },
      { description: 'Brown coat', scheduledValueCents: 800000 },
    ]));
  });

  it('reports a workbook with no usable rows instead of wiping the SOV', async () => {
    await act(async () => { mount(); });
    await act(async () => {
      await h.pickers.get('Import from documents').onPickBlobs([{
        row, blob: sheetBlob([['Description', 'Value'], ['no value here', 'n/a']]),
      }]);
    });
    expect(h.seedSov).not.toHaveBeenCalled();
    expect(await screen.findByText(/No valid rows found/i)).toBeInTheDocument();
  });
});

describe('AiaScheduleOfValues — lock, sections, line types, row actions', () => {
  it('draft: shows Draft chip + Finalize; Finalize confirms then locks', async () => {
    h.getSov.mockResolvedValue([line({})]);
    mount();
    expect(await screen.findByTestId('sov-lock-chip')).toHaveTextContent(/draft/i);
    await userEvent.click(screen.getByTestId('sov-finalize'));
    const finalizeDialog = await screen.findByRole('dialog');
    await userEvent.click(within(finalizeDialog).getByRole('button', { name: /finalize/i })); // confirm dialog
    await waitFor(() => expect(h.lockSov).toHaveBeenCalledWith('p1'));
  });

  it('locked: chip shows cause + date, edit/delete/add/import/seed/split/move are gone, sync stays, Reopen confirms with the pay-app count', async () => {
    h.getSov.mockResolvedValue([line({}), line({ id: 'co', itemNo: 'CO-1', description: 'Extra', isChangeOrder: 1, changeOrderId: 'c1', sortOrder: 1 })]);
    h.getSovLock.mockResolvedValue({ locked: true, lockedAt: Date.UTC(2026, 8, 11), lockedByUserId: null, lockedByName: null, reason: 'pay-app', payAppCount: 3 });
    mount();
    expect(await screen.findByTestId('sov-lock-chip')).toHaveTextContent(/locked/i);
    expect(screen.getByTestId('sov-lock-chip')).toHaveTextContent(/first pay application/i);
    expect(screen.queryByTitle('Edit')).toBeNull();
    expect(screen.queryByTitle('Delete')).toBeNull();
    expect(screen.queryByRole('button', { name: /add line/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /seed from estimate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /upload sheet/i })).toBeNull();
    expect(screen.queryByTestId('sov-split-l1')).toBeNull();
    expect(screen.queryByTestId('sov-move-up-l1')).toBeNull();
    expect(screen.getByRole('button', { name: /sync approved change orders/i })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sov-reopen'));
    expect(await screen.findByText(/3 pay applications will recompute/i)).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^reopen$/i }));
    await waitFor(() => expect(h.unlockSov).toHaveBeenCalledWith('p1'));
  });

  it('contract lines and change-order lines render in separate sections; CO section has no edit controls even when unlocked', async () => {
    h.getSov.mockResolvedValue([line({}), line({ id: 'co', itemNo: 'CO-1', description: 'Extra', isChangeOrder: 1, changeOrderId: 'c1', sortOrder: 1 })]);
    mount();
    const contract = await screen.findByTestId('sov-contract-section');
    const cos = screen.getByTestId('sov-co-section');
    expect(within(contract).getByText('Framing')).toBeInTheDocument();
    expect(within(cos).getByText('Extra')).toBeInTheDocument();
    expect(within(cos).queryByTitle('Edit')).toBeNull();
  });

  it('header and blank rows render without money; add form can create a header and a blank', async () => {
    h.getSov.mockResolvedValue([line({}), line({ id: 'h', lineType: 'header', description: 'Interior', itemNo: null, scheduledValueCents: 0, sortOrder: 1 }), line({ id: 'b', lineType: 'blank', description: '', itemNo: null, scheduledValueCents: 0, sortOrder: 2 })]);
    mount();
    const hRow = await screen.findByTestId('sov-row-h');
    expect(hRow).toHaveTextContent('Interior');
    expect(within(hRow).queryByText('$0.00')).toBeNull();
    expect(screen.getByTestId('sov-row-b')).toHaveTextContent(/blank/i);
    await userEvent.selectOptions(screen.getByTestId('sov-new-type'), 'header');
    await userEvent.type(screen.getByLabelText('Description'), 'Exterior');
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await waitFor(() => expect(h.createSovLine).toHaveBeenCalledWith('p1', expect.objectContaining({ lineType: 'header', description: 'Exterior' })));
    await userEvent.selectOptions(screen.getByTestId('sov-new-type'), 'blank');
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await waitFor(() => expect(h.createSovLine).toHaveBeenLastCalledWith('p1', { lineType: 'blank' }));
  });

  it('move down sends the full new order; insert header above sends insertBeforeId', async () => {
    h.getSov.mockResolvedValue([line({ id: 'a', description: 'A' }), line({ id: 'b', description: 'B', sortOrder: 1 })]);
    mount();
    await userEvent.click(await screen.findByTestId('sov-move-down-a'));
    await waitFor(() => expect(h.reorderSov).toHaveBeenCalledWith('p1', ['b', 'a']));
    await userEvent.click(screen.getByTestId('sov-insert-header-b'));
    await waitFor(() => expect(h.createSovLine).toHaveBeenCalledWith('p1', { lineType: 'header', description: 'New section', insertBeforeId: 'b' }));
  });

  it('a sov_locked rejection toasts and refetches the lock state', async () => {
    h.getSov.mockResolvedValue([line({})]);
    h.deleteSovLine.mockRejectedValueOnce(Object.assign(new Error('locked'), { name: 'SovLockedError' }));
    mount();
    await userEvent.click(await screen.findByTitle('Delete'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/schedule of values is finalized/i)).toBeInTheDocument();
    await waitFor(() => expect(h.getSovLock).toHaveBeenCalledTimes(2));
  });
});
