// src/pages/project/ProjectMail.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ProjectThreadRow } from '../mail/types';

const h = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h2 => h2 !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return {
    fakeSocket,
    projectThreads: vi.fn(),
    accounts: vi.fn(),
    openThreadLink: vi.fn(),
  };
});

vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: h.fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));

vi.mock('../../utils/mailApi', () => ({
  mailApi: { projectThreads: h.projectThreads, accounts: h.accounts },
}));

vi.mock('../mail/openThreadLink', () => ({ openThreadLink: h.openThreadLink }));

vi.mock('../mail/ThreadReferenceCard', () => ({
  ThreadReferenceCard: ({ links, onClose }: any) => (
    <div data-testid="thread-reference-card">
      <span data-testid="card-link-count">{links.length}</span>
      <button onClick={onClose}>close card</button>
    </div>
  ),
}));

import { ProjectMail } from './ProjectMail';

const row = (over: Partial<ProjectThreadRow> = {}): ProjectThreadRow => ({
  threadKey: 'tk-1',
  subjectSnapshot: 'Re: Invoice 12 — Dunmore Heights',
  participants: [{ addr: 'gc@tidewater.example', name: 'Mike GC' }, { addr: 'noah@birchwoodplaster.example', name: 'Noah' }],
  firstDate: '2026-08-27T12:00:00.000Z',
  links: [{ itemType: 'invoice', itemId: 'inv-1', label: 'INV-012' }],
  lastInboundDate: null,
  lastOutboundDate: '2026-08-27T12:00:00.000Z',
  // Well before every date used elsewhere in this file — a neutral "this
  // thread was linked a while ago" default so it never becomes the floor
  // unless a test deliberately sets it to.
  earliestLinkCreatedAt: '2026-08-01T00:00:00.000Z',
  lastActivity: '2026-08-27T12:00:00.000Z',
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/project/p1/mail']}>
      <Routes>
        <Route path="/project/:projectId/mail" element={<ProjectMail />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  h.projectThreads.mockReset().mockResolvedValue([]);
  h.accounts.mockReset().mockResolvedValue([{ id: 'a1', emailAddress: 'noah@birchwoodplaster.example' }]);
  h.openThreadLink.mockReset();
  h.fakeSocket.on.mockClear();
  h.fakeSocket.off.mockClear();
});

afterEach(() => {
  for (const key of Object.keys(h.fakeSocket.handlers)) h.fakeSocket.handlers[key] = [];
});

describe('ProjectMail', () => {
  it('renders a row with subject, item chip, participants, last activity', async () => {
    h.projectThreads.mockResolvedValue([row()]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());
    expect(screen.getByText('Re: Invoice 12 — Dunmore Heights')).toBeInTheDocument();
    expect(screen.getByText('INV-012')).toBeInTheDocument();
    // "me" replaces the viewer's own address in the compact participants label.
    expect(screen.getByText(/Mike, me/)).toBeInTheDocument();
    expect(screen.getByText('Aug 27')).toBeInTheDocument();
  });

  it('shows the reply chip only when the thread has an unanswered inbound reply', async () => {
    h.projectThreads.mockResolvedValue([
      row({ threadKey: 'tk-reply', lastInboundDate: '2026-08-28T12:00:00.000Z', lastOutboundDate: '2026-08-27T12:00:00.000Z' }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());
    expect(screen.getByTestId('project-mail-reply-tk-reply')).toBeInTheDocument();
  });

  it('does not show the reply chip when the last outbound is newer', async () => {
    h.projectThreads.mockResolvedValue([row({ lastInboundDate: '2026-08-26T12:00:00.000Z', lastOutboundDate: '2026-08-27T12:00:00.000Z' })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());
    expect(screen.queryByTestId(/project-mail-reply-/)).toBeNull();
  });

  // Review finding 3 (fix round 1): linking an already-existing, inbound-only
  // thread must not immediately read as "they answered, you haven't" — the
  // floor is max(lastOutboundDate, earliestLinkCreatedAt), not just
  // lastOutboundDate, so mail from before anyone tracked this thread against
  // the project doesn't count as an unanswered reply.
  it('does not show the reply chip for a freshly-linked, old inbound-only thread', async () => {
    h.projectThreads.mockResolvedValue([row({
      threadKey: 'tk-old-inbound',
      lastInboundDate: '2026-08-10T12:00:00.000Z', // predates the link entirely
      lastOutboundDate: null,                       // never sent from this project
      earliestLinkCreatedAt: '2026-08-27T09:00:00.000Z', // linked just now
    })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());
    expect(screen.queryByTestId(/project-mail-reply-/)).toBeNull();
  });

  it('still shows the reply chip when the inbound reply arrived AFTER the thread was linked, with no outbound at all', async () => {
    h.projectThreads.mockResolvedValue([row({
      threadKey: 'tk-reply-after-link',
      lastInboundDate: '2026-08-28T12:00:00.000Z',
      lastOutboundDate: null,
      earliestLinkCreatedAt: '2026-08-27T09:00:00.000Z',
    })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());
    expect(screen.getByTestId('project-mail-reply-tk-reply-after-link')).toBeInTheDocument();
  });

  it('collapses more than 3 distinct item labels into an overflow chip', async () => {
    h.projectThreads.mockResolvedValue([
      row({
        links: [
          { itemType: 'invoice', itemId: 'inv-1', label: 'INV-012' },
          { itemType: 'rfi', itemId: 'r-1', label: 'RFI-001' },
          { itemType: 'issue', itemId: 'i-1', label: 'ISS-001' },
          { itemType: 'punch', itemId: 'p-1', label: 'Punch item' },
        ],
      }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());
    expect(screen.getAllByTestId('project-mail-chip')).toHaveLength(3);
    expect(screen.getByTestId('project-mail-chip-overflow')).toHaveTextContent('+1');
  });

  it('clicking a row builds the pseudo-link and calls openThreadLink, navigating on a match', async () => {
    const r = row();
    h.projectThreads.mockResolvedValue([r]);
    h.openThreadLink.mockResolvedValue('opened');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('project-mail-row'));

    await waitFor(() => expect(h.openThreadLink).toHaveBeenCalledTimes(1));
    const [pseudoLink, navigateFn] = h.openThreadLink.mock.calls[0];
    expect(pseudoLink.threadKey).toBe('tk-1');
    expect(pseudoLink.subjectSnapshot).toBe('Re: Invoice 12 — Dunmore Heights');
    expect(pseudoLink.firstDate).toBe('2026-08-27T12:00:00.000Z');
    expect(JSON.parse(pseudoLink.participantsJson)).toEqual(r.participants);
    expect(typeof navigateFn).toBe('function');
    expect(screen.queryByTestId('thread-reference-card')).toBeNull();
  });

  it('shows the ThreadReferenceCard with every linked item when no mailbox match is found', async () => {
    h.projectThreads.mockResolvedValue([
      row({
        links: [
          { itemType: 'invoice', itemId: 'inv-1', label: 'INV-012' },
          { itemType: 'rfi', itemId: 'r-1', label: 'RFI-001' },
        ],
      }),
    ]);
    h.openThreadLink.mockResolvedValue('card');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('project-mail-row'));

    await waitFor(() => expect(screen.getByTestId('thread-reference-card')).toBeInTheDocument());
    expect(screen.getByTestId('card-link-count')).toHaveTextContent('2');

    fireEvent.click(screen.getByText('close card'));
    expect(screen.queryByTestId('thread-reference-card')).toBeNull();
  });

  it('shows the empty state when the project has no linked threads', async () => {
    h.projectThreads.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(h.projectThreads).toHaveBeenCalled());
    expect(screen.getByText('No email threads linked to this project yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('project-mail-row')).toBeNull();
  });

  it('refetches on a mailThread live event', async () => {
    h.projectThreads.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(h.projectThreads).toHaveBeenCalledTimes(1));

    h.projectThreads.mockResolvedValue([row()]);
    act(() => { h.fakeSocket.fire('entity-changed', { type: 'mailThread', id: 'tk-1', projectId: 'p1', action: 'updated' }); });

    await waitFor(() => expect(screen.getByTestId('project-mail-row')).toBeInTheDocument());
  });
});
