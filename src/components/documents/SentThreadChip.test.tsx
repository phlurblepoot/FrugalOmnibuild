// src/components/documents/SentThreadChip.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ThreadLink } from '../../pages/mail/types';

const h = vi.hoisted(() => ({ openThreadLink: vi.fn() }));
vi.mock('../../pages/mail/openThreadLink', () => ({ openThreadLink: h.openThreadLink }));
// Kept as a thin stub — ThreadReferenceCard has its own test file; here we
// only need to prove SentThreadChip renders it (with the right link) and can
// dismiss it.
vi.mock('../../pages/mail/ThreadReferenceCard', () => ({
  ThreadReferenceCard: ({ links, onClose }: { links: ThreadLink[]; onClose: () => void }) => (
    <div data-testid="thread-reference-card-stub">
      <span data-testid="card-link-count">{links.length}</span>
      <button data-testid="card-close" onClick={onClose}>close</button>
    </div>
  ),
}));

import { SentThreadChip } from './SentThreadChip';

const link = (over: Partial<ThreadLink> = {}): ThreadLink => ({
  id: 'l1', threadKey: 'tk 1', subjectSnapshot: 'Invoice 12 — Dunmore Heights',
  firstDate: '2026-08-27T12:00:00.000Z', participantsJson: null, itemType: 'invoice', itemId: 'inv-1',
  projectId: 'p1', customerId: null, linkedByUserId: 'u1', createdAt: '2026-08-27T12:00:00.000Z',
  ...over,
});

const mount = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => { h.openThreadLink.mockReset(); });

describe('SentThreadChip', () => {
  it('renders nothing for an item that was never emailed', () => {
    const { container } = mount(<SentThreadChip link={null} myThread={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links into the mail client when the user owns the thread', () => {
    mount(
      <SentThreadChip
        link={link()}
        myThread={{ accountId: 'a1', threadKey: 'tk 1', subject: 'Invoice 12' }}
      />,
    );
    const chip = screen.getByTestId('sent-thread-chip');
    expect(chip).toHaveTextContent('Open thread');
    // `_` is MailPage's "any folder" segment; the key is URL-encoded because a
    // threadKey is opaque server text, not a path-safe id.
    expect(chip).toHaveAttribute('href', '/mail/a1/_/tk%201');
    expect(chip).toHaveAttribute('title', 'Invoice 12 — Dunmore Heights');
    // A known match is a real link — no need to ask the server again.
    expect(h.openThreadLink).not.toHaveBeenCalled();
  });

  it('shows the send date', () => {
    mount(<SentThreadChip link={link()} myThread={{ accountId: 'a1', threadKey: 'tk 1', subject: 's' }} />);
    // Formatted by the mail client's own formatter — the exact string depends
    // on the current year, so assert the shape rather than a fixed value.
    expect(screen.getByTestId('sent-thread-chip').textContent).toMatch(/^Sent · .+ · Open thread$/);
  });

  it('falls back to createdAt when the link carries no first date', () => {
    mount(
      <SentThreadChip
        link={link({ firstDate: null })}
        myThread={{ accountId: 'a1', threadKey: 'tk 1', subject: 's' }}
      />,
    );
    expect(screen.getByTestId('sent-thread-chip').textContent).toMatch(/^Sent · .+ · Open thread$/);
  });

  // Without a known myThread the chip is an interactive button (not a dead
  // <a>), since a click may still resolve a match via openThreadLink.
  it('is a clickable button, not a link, while myThread is unresolved', () => {
    mount(<SentThreadChip link={link()} myThread={null} resolving />);
    const chip = screen.getByTestId('sent-thread-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).not.toHaveAttribute('href');
    expect(chip).toHaveAttribute('title', 'Looking for the conversation…');
  });

  // A mailbox added since the hook last resolved, or the subject+date
  // fallback, can still find a match on click even though myThread was null.
  it('navigates via openThreadLink when a click resolves a match', async () => {
    h.openThreadLink.mockResolvedValue('opened');
    mount(<SentThreadChip link={link()} myThread={null} />);
    fireEvent.click(screen.getByTestId('sent-thread-chip'));
    await waitFor(() => expect(h.openThreadLink).toHaveBeenCalledTimes(1));
    expect(h.openThreadLink.mock.calls[0][0]).toMatchObject({ id: 'l1' });
    expect(screen.queryByTestId('thread-reference-card-stub')).toBeNull();
  });

  // No copy of the conversation anywhere this user can reach: the reference
  // card stands in for what would otherwise be a dead link.
  it('shows the reference card when openThreadLink finds no match', async () => {
    h.openThreadLink.mockResolvedValue('card');
    mount(<SentThreadChip link={link()} myThread={null} />);
    fireEvent.click(screen.getByTestId('sent-thread-chip'));
    expect(await screen.findByTestId('thread-reference-card-stub')).toBeInTheDocument();
    expect(screen.getByTestId('card-link-count')).toHaveTextContent('1');

    fireEvent.click(screen.getByTestId('card-close'));
    expect(screen.queryByTestId('thread-reference-card-stub')).toBeNull();
  });
});
