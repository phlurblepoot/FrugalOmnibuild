// src/pages/documents/DocumentsPage.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor as rtlWaitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';
import { CLIENT_SESSION_ID } from '../../utils/clientSession';

const { fakeSocket, getDocuments } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket, getDocuments: vi.fn() };
});
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDocuments,
  getProjectsSummary: vi.fn().mockResolvedValue([]),
  getCustomers: vi.fn().mockResolvedValue([]),
  getDocumentTypes: vi.fn().mockResolvedValue([]),
}));

import { DocumentsPage, ProjectDocuments } from './DocumentsPage';

function mount() {
  return render(
    <MemoryRouter initialEntries={['/documents']}>
      <Routes><Route path="/documents" element={<DocumentsPage />} /></Routes>
    </MemoryRouter>
  );
}

describe('DocumentsPage live refresh', () => {
  beforeEach(() => {
    getDocuments.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  // DocumentsPage keeps its pre-existing `[filterKey]` mount effect AND adds
  // useLiveQuery(refresh, ...) for the socket subscription (the hook's filter
  // identity can't carry this page's own richer filterKey — see the ruling
  // noted at the call site). That means TWO refresh() calls fire on mount;
  // the requestIdRef race guard already makes the loser harmless, so this
  // duplicate is accepted rather than engineered away.
  it('refetches when a foreign file event arrives', async () => {
    const withResult = {
      rows: [{
        id: 'f1', name: 'plan.pdf', mime: 'application/pdf', size: 1024, kind: 'other',
        createdAt: Date.now(), versionNumber: 1, archived: false,
        projectId: null, projectName: null, customerId: null, customerName: null, source: null,
      }],
      total: 1,
    };
    // First two calls (the duplicate mount fetches) resolve empty; the third
    // call (post-event refetch) is the one that should surface the new row.
    getDocuments.mockImplementation(() =>
      Promise.resolve(getDocuments.mock.calls.length <= 2 ? { rows: [], total: 0 } : withResult)
    );
    mount();
    await rtlWaitFor(() => expect(getDocuments).toHaveBeenCalledTimes(2));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'file', id: 'f1', action: 'created', bySessionId: 'other-tab' });
    });
    await rtlWaitFor(() => expect(getDocuments).toHaveBeenCalledTimes(3), { timeout: 2000 });
    await rtlWaitFor(() => expect(screen.getAllByText('plan.pdf').length).toBeGreaterThan(0));
  });

  it('ignores self-echo file events (bySessionId === CLIENT_SESSION_ID)', async () => {
    getDocuments.mockResolvedValue({ rows: [], total: 0 });
    mount();
    await rtlWaitFor(() => expect(getDocuments).toHaveBeenCalledTimes(2));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'file', id: 'f1', action: 'created', bySessionId: CLIENT_SESSION_ID });
    });
    await new Promise(r => setTimeout(r, 500));
    expect(getDocuments).toHaveBeenCalledTimes(2);
  });
});

describe('ProjectDocuments (project Documents tab)', () => {
  beforeEach(() => {
    getDocuments.mockReset();
    getDocuments.mockResolvedValue({ rows: [], total: 0 });
  });

  it('pins the list to the route project, ignores projectIds in the URL, and hides the Project filter', async () => {
    render(
      <MemoryRouter initialEntries={['/project/p1/documents?projectIds=p9']}>
        <Routes><Route path="/project/:projectId/documents" element={<ProjectDocuments />} /></Routes>
      </MemoryRouter>
    );
    await rtlWaitFor(() => expect(getDocuments).toHaveBeenCalled());
    for (const [args] of getDocuments.mock.calls) {
      expect(args.projectIds).toEqual(['p1']);
      expect(args.unassigned).toBe(false);
    }
    expect(screen.queryByTestId('doc-filter-project')).toBeNull();
    expect(screen.getByTestId('doc-filter-customer')).toBeTruthy();
  });
});
