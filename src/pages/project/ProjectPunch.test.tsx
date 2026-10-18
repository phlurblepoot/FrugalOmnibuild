// src/pages/project/ProjectPunch.test.tsx
//
// Punch has no per-record editor modal to save first — the whole list IS the
// content — so its DocumentActionsBar is always "clean" (dirty=false, save
// always succeeds) and lives in the page header rather than a modal footer
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// What these tests pin: the bar renders in place of the old Download/Send
// buttons, `build` turns the punch PDF into a Blob, and Send is blocked with
// an explanatory reason when there are no punch items.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  getPunchItems: vi.fn(),
  sendPunchReport: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildPunchPdf: vi.fn(),
}));

vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/store')>()),
  getPunchItems: h.getPunchItems,
  sendPunchReport: h.sendPunchReport,
  persistGeneratedDocument: h.persistGeneratedDocument,
  getDocumentBySource: h.getDocumentBySource,
  getDocumentsBySource: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getMailAccounts: vi.fn(async () => [{ id: 'a1', provider: 'fake', emailAddress: 'me@birchwood.test', displayName: null, isDefault: 1, status: 'ok', unreadCount: 0 }]),
  getAlwaysCc: vi.fn(async () => ''),
  getProject: vi.fn(async () => null),
  getCustomer: vi.fn(async () => undefined),
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
  getFileMeta: vi.fn(async () => null),
}));

vi.mock('./punch/punchPdf', () => ({ buildPunchPdf: h.buildPunchPdf }));

vi.mock('./punch/PunchItemEditor', () => ({
  PunchItemEditor: () => <div data-testid="punch-item-editor" />,
}));

vi.mock('../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

vi.mock('./ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'Big Job', contractor: 'GC Inc' } }),
}));

// The bar's own composer is the shared mail composer now; the stub resolves a
// SendRequest exactly as the real one does once the user hits Send.
vi.mock('../../pages/mail/compose/MailComposer', async (orig) => ({
  ...(await orig<typeof import('../../pages/mail/compose/MailComposer')>()),
  MailComposer: ({ open, onSend, onClose }: any) =>
    open ? (
      <div data-testid="composer">
        <button
          data-testid="composer-send"
          onClick={() => {
            void onSend({ to: [{ addr: 'gc@example.com' }], subject: 's', html: '<p>b</p>', attachments: [] })
              .then(() => onClose())
              .catch(() => {});
          }}
        >
          send
        </button>
      </div>
    ) : null,
}));

// The document bar loads the user's mailboxes (for the composer's From select)
// and the item's mail thread links (for the Sent chip). Neither is under test
// here; an empty mailbox list is the honest default.
vi.mock('../../utils/mailApi', () => ({
  mailApi: {
    accounts: vi.fn(async () => []),
    links: vi.fn(async () => []),
    thread: vi.fn(async () => { throw new Error('not found'); }),
  },
}));

import { ToastProvider } from '../../components/Toast';
import { ProjectPunch } from './ProjectPunch';

const item = (over: Record<string, any> = {}) => ({
  id: 'pi-1', projectId: 'p1', area: 'Kitchen', description: 'Fix trim',
  done: 0, sortOrder: 0, version: 1, createdAt: 1, photoCount: 0,
  ...over,
});

const mount = () => render(
  <MemoryRouter initialEntries={['/project/p1/punch']}>
    <ToastProvider>
      <Routes><Route path="/project/:projectId/punch" element={<ProjectPunch />} /></Routes>
    </ToastProvider>
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.getPunchItems.mockResolvedValue([item()]);
  h.sendPunchReport.mockResolvedValue(undefined);
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildPunchPdf.mockReturnValue({ output: () => new Uint8Array([1, 2, 3]).buffer });
});

describe('ProjectPunch — document actions', () => {
  it('mounts the shared bar and drops its own Download report / Send report buttons', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download report/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send report/i })).toBeNull();
  });

  it('builds the punch PDF into a Blob and persists it under the project source', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.buildPunchPdf).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));

    const [blob, opts] = h.persistGeneratedDocument.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(opts).toMatchObject({ projectId: 'p1', kind: 'punch-report', sourceType: 'punch', sourceId: 'p1' });
  });

  it('blocks Send with "No punch items" when the list is empty', async () => {
    h.getPunchItems.mockResolvedValue([]);
    mount();

    const send = await screen.findByTestId('doc-send');
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', 'No punch items');
  });

  it('enables Send once there are punch items', async () => {
    mount();
    const send = await screen.findByTestId('doc-send');
    expect(send).toBeEnabled();
  });

  // Punch items carry no updatedAt, so the generic "file newer than the record"
  // check would call any stored report current forever. The bar is told the
  // staleness is unknown instead: no freshness claim, and Send rebuilds — which
  // is what the old always-regenerate Send report button did.
  it('never claims a stored report is current, and rebuilds on send anyway', async () => {
    h.getDocumentBySource.mockResolvedValue({
      id: 'file-old', name: 'punch.pdf', mime: 'application/pdf', size: 10,
      createdAt: 5_000, versionNumber: 1,
    });
    mount();

    expect(await screen.findByTestId('doc-status')).toHaveTextContent('PDF saved');

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    // The rebuild becomes a new version of the stored report (no prompt).
    await waitFor(() => expect(h.buildPunchPdf).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.sendPunchReport).toHaveBeenCalledTimes(1));
    // The freshly built file goes out, not the stored one.
    expect(h.sendPunchReport.mock.calls[0][1]).toMatchObject({ fileId: 'file-9' });
  });

  it('sends the generated file through sendPunchReport', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendPunchReport).toHaveBeenCalledTimes(1));
    expect(h.sendPunchReport.mock.calls[0][0]).toBe('p1');
    expect(h.sendPunchReport.mock.calls[0][1]).toMatchObject({ to: 'gc@example.com', fileId: 'file-9' });
  });
});
