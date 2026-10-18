// src/pages/project/billing/ChangeOrdersSection.test.tsx
// Mirror of InvoicesSection's row-level document state, for change orders.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChangeOrderListItem } from '../../../utils/store';
import { useTimeZone } from '../../../test/timeZone';

const h = vi.hoisted(() => ({
  getChangeOrders: vi.fn(),
  getChangeOrder: vi.fn(),
  getDocumentsBySource: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
// Not under test here — see ReplyFlagChip/useReplyFlags.test for that; a real
// fetch would otherwise fire (and outlive) this file's tests.
vi.mock('../../../hooks/useReplyFlags', () => ({ useReplyFlags: () => new Set<string>() }));

vi.mock('../ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'Big Job', contractor: null, address: null } }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getChangeOrders: h.getChangeOrders,
  getChangeOrder: h.getChangeOrder,
  getDocumentsBySource: h.getDocumentsBySource,
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
}));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row, onClose }: any) => (
    <div data-testid="viewer">
      <span>{row.name}</span>
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));

// A stand-in editor that reports every mount: the section must not re-key it
// when the editor saves itself, or the document bar inside it would be torn
// down mid-flow.
const mounts = { count: 0 };
vi.mock('./ChangeOrderEditor', () => ({
  ChangeOrderEditor: ({ onSaved }: any) => {
    React.useEffect(() => { mounts.count += 1; }, []);
    return (
      <div data-testid="editor">
        <button data-testid="save-kept" onClick={() => onSaved({ keepMounted: true })}>save kept</button>
        <button data-testid="save-plain" onClick={() => onSaved()}>save plain</button>
      </div>
    );
  },
}));

import { ToastProvider } from '../../../components/Toast';
import { ChangeOrdersSection } from './ChangeOrdersSection';

const row = (over: Partial<ChangeOrderListItem> = {}): ChangeOrderListItem => ({
  id: 'co-1', projectId: 'p1', number: '001', date: null, title: 'Extra wall',
  description: null, lumpSumAmount: 0, scheduleImpactDays: null, status: 'draft',
  version: 1, createdAt: 1, updatedAt: 10, amount: 100, totalCents: 10000,
  ...over,
});

const FILE = { id: 'f2', name: 'CO-001.pdf', mime: 'application/pdf', size: 12, createdAt: 50, versionNumber: 1 };

const mount = (initialEntry = '/') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <ChangeOrdersSection projectId="p1" />
      </ToastProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getChangeOrders.mockResolvedValue([row(), row({ id: 'co-2', number: '002', title: 'Second' })]);
  h.getDocumentsBySource.mockResolvedValue({ 'co-1': FILE, 'co-2': null });
  h.getChangeOrder.mockResolvedValue(null);
});

describe('ChangeOrdersSection — PDF status on rows', () => {
  it('shows a chip and an Open button only for the change order that has a PDF', async () => {
    mount();
    await screen.findByText('Extra wall');
    await waitFor(() => expect(h.getDocumentsBySource).toHaveBeenCalled());
    expect(h.getDocumentsBySource.mock.calls[0][0]).toMatchObject({
      sourceType: 'change-order', kind: 'change-order', sourceIds: ['co-1', 'co-2'],
    });

    await waitFor(() => expect(screen.getByText('PDF up to date')).toBeInTheDocument());
    expect(screen.queryByText('No PDF yet')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open PDF' })).toHaveLength(1);
  });

  it('opens the viewer instead of the editor when Open is clicked', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open PDF' }));

    expect(await screen.findByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByText('CO-001.pdf')).toBeInTheDocument();
    expect(h.getChangeOrder).not.toHaveBeenCalled();
  });

  it('?open= opens that change order\'s editor (CreateFromThreadMenu convention) and strips the param', async () => {
    h.getChangeOrder.mockResolvedValue({ ...row(), lines: [], photos: [], lumpSumCents: 0 });
    mount('/?open=co-1');
    await screen.findByTestId('editor');
    expect(h.getChangeOrder).toHaveBeenCalledWith('co-1');
  });

  it('?open= with a stale id fails gracefully (toast, no editor)', async () => {
    h.getChangeOrder.mockRejectedValue(new Error('not found'));
    mount('/?open=nope');
    await screen.findByText('Extra wall');
    expect(screen.queryByTestId('editor')).toBeNull();
  });
});

describe('ChangeOrdersSection — editor remounting', () => {
  it('keeps the editor mounted for its own saves and re-keys it for outside refreshes', async () => {
    h.getChangeOrder.mockResolvedValue({ ...row(), lines: [], photos: [], lumpSumCents: 0 });
    mounts.count = 0;
    mount();

    fireEvent.click(await screen.findByText('Extra wall'));
    await screen.findByTestId('editor');
    await waitFor(() => expect(mounts.count).toBe(1));

    // act() flushes the reload's promises and the resulting render, so a
    // remount would already have happened by the time we count.
    await act(async () => { fireEvent.click(screen.getByTestId('save-kept')); });
    expect(mounts.count).toBe(1);

    // A refresh that found nothing new must not throw away a typed draft.
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(1);

    // A record that actually moved on does re-key the editor.
    h.getChangeOrder.mockResolvedValue({ ...row({ version: 2 }), lines: [], photos: [], lumpSumCents: 0 });
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(2);
  });
});

describe('ChangeOrdersSection — dates west of UTC', () => {
  useTimeZone('America/Los_Angeles');

  it('shows a change order\'s date as the day that was picked', async () => {
    h.getChangeOrders.mockResolvedValue([row({ date: new Date('2026-10-01').getTime() })]);
    mount();
    await screen.findByText('Extra wall');
    expect(screen.getByText(new Date(2026, 9, 1).toLocaleDateString())).toBeInTheDocument();
    expect(screen.queryByText(new Date(2026, 8, 30).toLocaleDateString())).toBeNull();
  });
});
