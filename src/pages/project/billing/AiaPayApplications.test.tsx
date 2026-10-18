// src/pages/project/billing/AiaPayApplications.test.tsx
//
// The pay-app list answers "does this application already have its G702/G703
// Excel, and is it still current?" at a glance, and lets you peek at that
// workbook without opening the editor (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../../components/Toast';
import type { AiaPayAppListItem } from '../../../utils/store';
import { useTimeZone } from '../../../test/timeZone';

const h = vi.hoisted(() => ({
  getPayApps: vi.fn(),
  getDocumentsBySource: vi.fn(),
  getSovLock: vi.fn(async () => ({ locked: true, payAppCount: 1 })),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getPayApps: h.getPayApps,
  getDocumentsBySource: h.getDocumentsBySource,
  getSovLock: h.getSovLock,
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['xlsx'])),
}));
vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
// Not under test here — see ReplyFlagChip/useReplyFlags.test for that; a real
// fetch would otherwise fire (and outlive) this file's tests.
vi.mock('../../../hooks/useReplyFlags', () => ({ useReplyFlags: () => new Set<string>() }));
vi.mock('../../documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row }: any) => <div data-testid="viewer">{row.name}</div>,
}));
vi.mock('./AiaPayAppEditor', () => ({
  AiaPayAppEditor: () => <div data-testid="editor" />,
}));

import { AiaPayApplications } from './AiaPayApplications';

const app = (over: Partial<AiaPayAppListItem> = {}): AiaPayAppListItem => ({
  id: 'app1', projectId: 'p1', number: 1, periodTo: '2026-06-30', applicationDate: '2026-07-01',
  retainagePercent: 10, storedRetainagePercent: 10, releasedRetainagePoints: 0,
  status: 'draft', version: 1, createdAt: 1, updatedAt: 10,
  totalCents: 250000, paidCents: 0, balanceCents: null,
  ...over,
});

const FILE = {
  id: 'f1', name: 'Pay App #1 — G702.xlsx',
  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: 12, createdAt: 50, versionNumber: 1,
};

const mount = (contractTotalCents?: number) => render(
  <MemoryRouter>
    <ToastProvider>
      <AiaPayApplications projectId="p1" contractTotalCents={contractTotalCents} />
    </ToastProvider>
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.getPayApps.mockResolvedValue([app(), app({ id: 'app2', number: 2, updatedAt: 20 })]);
  h.getDocumentsBySource.mockResolvedValue({ app1: FILE, app2: null });
});

describe('AiaPayApplications — Excel status on rows', () => {
  it('looks the whole list up in one batched call', async () => {
    mount();
    await screen.findByText('#1');

    await waitFor(() => expect(h.getDocumentsBySource).toHaveBeenCalled());
    expect(h.getDocumentsBySource).toHaveBeenCalledTimes(1);
    expect(h.getDocumentsBySource.mock.calls[0][0]).toMatchObject({
      sourceType: 'payapp', kind: 'payapp-export', sourceIds: ['app1', 'app2'],
    });
  });

  it('shows a chip and an Open button only for the application that has a workbook', async () => {
    mount();

    await waitFor(() => expect(screen.getByText('Excel up to date')).toBeInTheDocument());
    expect(screen.queryByText('No Excel yet')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open Excel' })).toHaveLength(1);
  });

  it('marks the chip out of date when the application changed after the workbook was made', async () => {
    h.getDocumentsBySource.mockResolvedValue({ app1: { ...FILE, createdAt: 5 }, app2: null });
    mount();
    await waitFor(() => expect(screen.getByText('Excel out of date')).toBeInTheDocument());
  });

  it('opens the viewer, not the editor, when Open is clicked', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Excel' }));

    expect(await screen.findByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByText('Pay App #1 — G702.xlsx')).toBeInTheDocument();
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('still opens the editor on a row click', async () => {
    mount();
    fireEvent.click(await screen.findByText('#1'));
    expect(await screen.findByTestId('editor')).toBeInTheDocument();
  });
});

describe('AiaPayApplications — draft completion bar (Wave 3 Task 11)', () => {
  it('shows a labeled bar on draft rows once contractTotalCents is known', async () => {
    // Both fixture rows are drafts with totalCents 250000; a 1,000,000-cent
    // contract puts each at 25%.
    mount(1_000_000);
    await screen.findByText('#1');
    expect(screen.getAllByText('this draft = 25% of contract')).toHaveLength(2);
  });

  it('omits the bar entirely when contractTotalCents is not yet known', async () => {
    mount(); // no contractTotalCents — e.g. summary still loading, or non-admin
    await screen.findByText('#1');
    expect(screen.queryByText(/this draft = .*% of contract/)).toBeNull();
  });

  it('omits the bar for a finalized application even when contractTotalCents is known', async () => {
    h.getPayApps.mockResolvedValue([app({ status: 'finalized' })]);
    mount(1_000_000);
    await screen.findByText('#1');
    expect(screen.queryByText(/this draft = .*% of contract/)).toBeNull();
  });

  it('does not divide by zero for a zero contract total', async () => {
    mount(0);
    await screen.findByText('#1');
    expect(screen.getAllByText('this draft = 0% of contract')).toHaveLength(2);
  });
});

describe('AiaPayApplications — first application finalizes the SOV', () => {
  it('shows the note in the create form while the SOV is unlocked', async () => {
    h.getPayApps.mockResolvedValue([]);
    h.getDocumentsBySource.mockResolvedValue({});
    h.getSovLock.mockResolvedValueOnce({ locked: false, payAppCount: 0 });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /new application/i }));
    expect(await screen.findByText(/finalizes the schedule of values/i)).toBeInTheDocument();
  });

  it('shows no note once the SOV is locked', async () => {
    h.getPayApps.mockResolvedValue([]);
    h.getDocumentsBySource.mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /new application/i }));
    await screen.findByLabelText('Period to');
    expect(screen.queryByText(/finalizes the schedule of values/i)).toBeNull();
  });
});

describe('AiaPayApplications — dates west of UTC', () => {
  useTimeZone('America/Los_Angeles');
  afterEach(() => { vi.useRealTimers(); });

  it('shows the period-to and application dates as the days they say', async () => {
    h.getPayApps.mockResolvedValue([app()]);
    mount();
    await screen.findByText('#1');
    expect(screen.getByText(new Date(2026, 5, 30).toLocaleDateString())).toBeInTheDocument();
    expect(screen.getByText(new Date(2026, 6, 1).toLocaleDateString())).toBeInTheDocument();
  });

  it('starts a new application\'s date at today on the local calendar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 7, 3, 30)); // Oct 6, 8:30pm in Los Angeles — already Oct 7 in UTC
    mount();
    await screen.findByText('#1');
    fireEvent.click(screen.getByRole('button', { name: 'New application' }));
    expect(await screen.findByLabelText('Application date')).toHaveValue('2026-10-06');
  });
});
