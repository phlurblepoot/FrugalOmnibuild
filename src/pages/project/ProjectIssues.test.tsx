// src/pages/project/ProjectIssues.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor as rtlWaitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

const { fakeSocket, getIssues, getIssue, getDocumentsBySource } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket, getIssues: vi.fn(), getIssue: vi.fn(), getDocumentsBySource: vi.fn() };
});
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
// Not under test here — see ReplyFlagChip/useReplyFlags.test for that; a real
// fetch would otherwise fire (and outlive) this file's tests.
vi.mock('../../hooks/useReplyFlags', () => ({ useReplyFlags: () => new Set<string>() }));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getIssues, getIssue, getDocumentsBySource,
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
}));
vi.mock('../documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row, onClose }: any) => (
    <div data-testid="viewer">
      <span>{row.name}</span>
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));

// A stand-in editor that reports every mount: the list must not re-key it when
// the editor saves itself, or the document bar inside it would be torn down
// mid-flow.
const mounts = { count: 0 };
vi.mock('./issues/IssueEditor', () => ({
  IssueEditor: ({ onSaved }: any) => {
    React.useEffect(() => { mounts.count += 1; }, []);
    return (
      <div data-testid="editor">
        <button data-testid="save-kept" onClick={() => onSaved({ keepMounted: true })}>save kept</button>
        <button data-testid="save-plain" onClick={() => onSaved()}>save plain</button>
      </div>
    );
  },
}));
vi.mock('./ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'P1', contractor: '' } }),
}));

import { fireEvent } from '@testing-library/react';
import { ProjectIssues } from './ProjectIssues';

function mount(initialEntry = '/project/p1/issues') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes><Route path="/project/:projectId/issues" element={<ProjectIssues />} /></Routes>
    </MemoryRouter>
  );
}

describe('ProjectIssues live refresh', () => {
  beforeEach(() => {
    getIssues.mockReset();
    getDocumentsBySource.mockReset();
    getDocumentsBySource.mockResolvedValue({});
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  it('refetches when a foreign issue event for this project arrives', async () => {
    getIssues.mockResolvedValueOnce([]);
    getIssues.mockResolvedValueOnce([{ id: 'i1', number: 1, title: 'new crack', status: 'open', photoCount: 0 }]);
    mount();
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(1));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'issue', id: 'i1', projectId: 'p1', action: 'created', bySessionId: 'other-tab' });
    });
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await rtlWaitFor(() => expect(screen.getByText('new crack')).toBeInTheDocument());
  });

  it('ignores issue events for other projects', async () => {
    getIssues.mockResolvedValue([]);
    mount();
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(1));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'issue', id: 'iX', projectId: 'OTHER', action: 'created', bySessionId: 'other-tab' });
    });
    await new Promise(r => setTimeout(r, 500));
    expect(getIssues).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Document status on rows + editor remounting (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md)

const listRow = (over: Record<string, any> = {}) => ({
  id: 'i1', projectId: 'p1', number: 1, title: 'Cracked stucco', description: null,
  status: 'open', version: 1, sentAt: null, createdAt: 1, updatedAt: 10, photoCount: 0,
  ...over,
});

const FILE = { id: 'f1', name: 'ISS-001.pdf', mime: 'application/pdf', size: 12, createdAt: 50, versionNumber: 1 };

describe('ProjectIssues — report status on rows', () => {
  beforeEach(() => {
    getIssues.mockReset();
    getIssue.mockReset();
    getDocumentsBySource.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
    getIssues.mockResolvedValue([listRow(), listRow({ id: 'i2', number: 2, title: 'Loose trim' })]);
    getDocumentsBySource.mockResolvedValue({ i1: FILE, i2: null });
    getIssue.mockResolvedValue(null);
  });

  it('shows a chip and an Open button only for the issue that has a report', async () => {
    mount();
    await screen.findByText('Cracked stucco');
    await rtlWaitFor(() => expect(getDocumentsBySource).toHaveBeenCalled());
    expect(getDocumentsBySource.mock.calls[0][0]).toMatchObject({
      sourceType: 'issue', kind: 'issue-report', sourceIds: ['i1', 'i2'],
    });

    await rtlWaitFor(() => expect(screen.getByText('PDF up to date')).toBeInTheDocument());
    expect(screen.queryByText('No PDF yet')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open PDF' })).toHaveLength(1);
  });

  it('?open= opens that issue\'s editor (CreateFromThreadMenu convention) and strips the param', async () => {
    getIssue.mockResolvedValue({ ...listRow(), photos: [] });
    mount('/project/p1/issues?open=i1');
    await screen.findByTestId('editor');
    expect(getIssue).toHaveBeenCalledWith('i1');
  });

  it('marks the chip out of date when the issue changed after the report was made', async () => {
    getDocumentsBySource.mockResolvedValue({ i1: { ...FILE, createdAt: 5 }, i2: null });
    mount();
    await rtlWaitFor(() => expect(screen.getByText('PDF out of date')).toBeInTheDocument());
  });

  it('opens the viewer instead of the editor when Open is clicked', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open PDF' }));

    expect(await screen.findByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByText('ISS-001.pdf')).toBeInTheDocument();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it('keeps the editor mounted for its own saves and re-keys it for outside refreshes', async () => {
    getIssue.mockResolvedValue({ ...listRow(), photos: [] });
    mounts.count = 0;
    mount();

    fireEvent.click(await screen.findByText('Cracked stucco'));
    await screen.findByTestId('editor');
    await rtlWaitFor(() => expect(mounts.count).toBe(1));

    // act() flushes the reload's promises and the resulting render, so a
    // remount would already have happened by the time we count.
    await act(async () => { fireEvent.click(screen.getByTestId('save-kept')); });
    expect(getIssue).toHaveBeenCalledTimes(2); // open + reload
    expect(mounts.count).toBe(1);

    // A refresh that found nothing new must not throw away a typed draft.
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(1);

    // A record that actually moved on does re-key the editor.
    getIssue.mockResolvedValue({ ...listRow({ version: 2 }), photos: [] });
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(2);
  });
});
