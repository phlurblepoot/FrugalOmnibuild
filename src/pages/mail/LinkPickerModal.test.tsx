import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  createLink: vi.fn(async (b: unknown) => ({ id: 'link-1', ...(b as object) })),
  toast: vi.fn(),
}));

vi.mock('../../utils/mailApi', () => ({ mailApi: { createLink: h.createLink } }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

vi.mock('../../utils/store', async orig => ({
  ...(await orig<typeof import('../../utils/store')>()),
  getCustomers: vi.fn(async () => [{ id: 'c1', name: 'Acme Co', emails: {} }, { id: 'c2', name: 'Beta LLC', emails: {} }]),
  getProjectsSummary: vi.fn(async () => [
    { id: 'p1', name: 'Job One', status: 'active', contractor: null, customerId: 'c1', address: null, bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false, pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0 },
  ]),
  getProposals: vi.fn(async () => [{ id: 'pr1', number: 2, title: 'Deck', projectId: 'p1' }]),
  getInvoices: vi.fn(async () => [{ id: 'i1', number: '104', projectId: 'p1' }]),
  getChangeOrders: vi.fn(async () => [{ id: 'co1', number: '3', title: 'Extra work', projectId: 'p1' }]),
  getPayApps: vi.fn(async () => [{ id: 'pa1', number: 1, projectId: 'p1' }]),
  getIssues: vi.fn(async () => [{ id: 'iss1', number: 4, title: 'Crack', projectId: 'p1' }]),
  getRfis: vi.fn(async () => [{ id: 'r1', number: 12, title: 'Detail', projectId: 'p1' }]),
  getDailyReports: vi.fn(async () => [{ id: 'd1', reportDate: '2026-08-26', projectId: 'p1', crewId: 'c1', crewName: 'Crew 1' }]),
  getTasks: vi.fn(async () => [{ id: 't1', title: 'Order material', projectId: 'p1' }]),
}));

import { mailApi } from '../../utils/mailApi';
import { getChangeOrders, getInvoices, getIssues, getPayApps, getProposals, getRfis, getTasks, getDailyReports } from '../../utils/store';
import { LinkPickerModal } from './LinkPickerModal';

const setup = (overrides: Partial<React.ComponentProps<typeof LinkPickerModal>> = {}) => {
  const onClose = vi.fn();
  const onLinked = vi.fn();
  const props = { open: true, onClose, threadKey: 'tk-1', onLinked, ...overrides };
  const utils = render(<LinkPickerModal {...props} />);
  return { ...utils, onClose, onLinked };
};

/** Opens the Item tab and waits for the project options to be in the DOM —
 *  a <select>'s DOM value can't move to an option that doesn't exist yet, so
 *  every test that picks a project must wait for the list to have loaded. */
const openItemTab = async () => {
  fireEvent.click(screen.getByRole('tab', { name: 'Item' }));
  await screen.findByText('Job One');
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createLink.mockImplementation(async (b: unknown) => ({ id: 'link-1', ...(b as object) }));
});

const ITEM_FIELD_LABEL: Record<string, string> = {
  proposal: 'Proposal', invoice: 'Invoice', changeOrder: 'Change Order', payApp: 'Pay App',
  issue: 'Issue', rfi: 'RFI', dailyReport: 'Daily Report', task: 'Task',
};

describe('LinkPickerModal', () => {
  it('renders nothing when closed', () => {
    setup({ open: false });
    expect(screen.queryByTestId('link-picker-modal')).toBeNull();
  });

  it('defaults to the Customer tab and links to a chosen customer', async () => {
    const { onLinked, onClose } = setup();
    await screen.findByText('Acme Co');
    expect(screen.getByRole('tab', { name: 'Customer' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(mailApi.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'customer', itemId: 'c1' }));
    expect(onLinked).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('links to a chosen project on the Project tab', async () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: 'Project' }));
    await screen.findByText('Job One');

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(mailApi.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'project', itemId: 'p1' }));
  });

  it('the Link button starts disabled and stays disabled until a target is chosen', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
  });

  it.each([
    ['proposal', getProposals, 'pr1', 'Proposal #2 — Deck'],
    ['invoice', getInvoices, 'i1', 'Invoice 104'],
    ['changeOrder', getChangeOrders, 'co1', 'CO-3 — Extra work'],
    ['payApp', getPayApps, 'pa1', 'Pay App #1'],
    ['issue', getIssues, 'iss1', 'ISS-004 — Crack'],
    ['rfi', getRfis, 'r1', 'RFI-012 — Detail'],
    ['dailyReport', getDailyReports, 'd1', 'Daily Report — 2026-08-26 — Crew 1'], // a date names a report only with its crew
    ['task', getTasks, 't1', 'Order material'],
  ] as const)('item drill (%s) fetches per-project rows and links the chosen one', async (type, fetcher, expectedId, expectedLabel) => {
    setup();
    await openItemTab();
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: type } });

    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    // getTasks is called with a params object; everything else with a bare projectId.
    const lastArg = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(lastArg === 'p1' || (lastArg && typeof lastArg === 'object' && (lastArg as { projectId?: string }).projectId === 'p1')).toBe(true);

    const select = await screen.findByLabelText(ITEM_FIELD_LABEL[type]);
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: expectedId } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(mailApi.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: type, itemId: expectedId }));
  });

  it('item drill: punch has no item-list step and links the project itself', async () => {
    setup();
    await openItemTab();
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'punch' } });

    expect(screen.queryByLabelText('Punch')).toBeNull();
    expect(screen.getByRole('button', { name: 'Link' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(mailApi.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'punch', itemId: 'p1' }));
  });

  it('changing the drill project resets the type and item selection', async () => {
    setup();
    await openItemTab();
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'rfi' } });
    await screen.findByLabelText('RFI');

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } });
    expect(screen.queryByLabelText('Type')).toBeNull();
  });

  it('Cancel closes without linking', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(mailApi.createLink).not.toHaveBeenCalled();
  });

  it('shows a toast and keeps the modal open when createLink fails', async () => {
    h.createLink.mockRejectedValueOnce(new Error('nope'));
    const { onClose, onLinked } = setup();
    await screen.findByText('Acme Co');
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/could not link/i), expect.objectContaining({ type: 'error' })));
    expect(onClose).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('resets its selections between opens', async () => {
    const { rerender } = setup();
    await screen.findByText('Acme Co');
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c1' } });
    rerender(<LinkPickerModal open={false} onClose={() => {}} threadKey="tk-1" onLinked={() => {}} />);
    rerender(<LinkPickerModal open onClose={() => {}} threadKey="tk-1" onLinked={() => {}} />);
    await screen.findByText('Acme Co');
    expect(screen.getByLabelText('Customer')).toHaveValue('');
  });
});
