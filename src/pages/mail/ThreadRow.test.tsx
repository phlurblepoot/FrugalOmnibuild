// src/pages/mail/ThreadRow.test.tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThreadRow } from './ThreadRow';
import type { ThreadLink, ThreadListRow } from './types';

const link = (over: Partial<ThreadLink> = {}): ThreadLink => ({
  id: 'l1', threadKey: 't1', subjectSnapshot: null, firstDate: null, participantsJson: null,
  itemType: 'rfi', itemId: 'r1', projectId: null, customerId: null, linkedByUserId: 'u1',
  createdAt: '2026-08-27T12:00:00.000Z', ...over,
});

const row = (over: Partial<ThreadListRow> = {}): ThreadListRow => ({
  threadKey: 't1',
  subject: 'Roof detail',
  firstDate: '2025-08-27T12:00:00.000Z',
  lastDate: '2025-08-27T12:00:00.000Z',
  messageCount: 1,
  unreadCount: 0,
  hasAttachments: 0,
  isStarred: 0,
  participants: [{ addr: 'bob@acme.com', name: 'Bob Smith' }],
  folderIds: ['f-inbox'],
  snippet: 'Please review the attached detail',
  links: [],
  ...over,
});

const props = {
  selected: false,
  ownAddresses: ['noah@birchwoodplaster.example'],
  onOpen: vi.fn(),
  onToggleStar: vi.fn(),
};

describe('ThreadRow', () => {
  it('marks an unread thread and renders its subject bold', () => {
    render(<ThreadRow {...props} row={row({ unreadCount: 2, messageCount: 3 })} />);
    const el = screen.getByTestId('mail-thread-row');
    expect(el).toHaveAttribute('data-unread', 'true');
    expect(screen.getByText('Roof detail').className).toMatch(/font-semibold/);
    // message count rides next to the participants when the thread has replies
    expect(screen.getByText('3')).toBeInTheDocument();
    // ...and both the dot and the count carry a label, so "unread" and "how
    // many messages" aren't colour/position-only cues (a11y pass).
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    expect(screen.getByLabelText('3 messages')).toBeInTheDocument();
  });

  it('leaves a read thread unbolded and without a message count on a single message', () => {
    render(<ThreadRow {...props} row={row()} />);
    expect(screen.getByTestId('mail-thread-row')).toHaveAttribute('data-unread', 'false');
    expect(screen.getByText('Roof detail').className).not.toMatch(/font-semibold/);
    expect(screen.queryByText('1')).toBeNull();
  });

  it('opens the thread on click and on Enter', () => {
    const onOpen = vi.fn();
    render(<ThreadRow {...props} onOpen={onOpen} row={row()} />);
    fireEvent.click(screen.getByTestId('mail-thread-row'));
    fireEvent.keyDown(screen.getByTestId('mail-thread-row'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('toggles the star without opening the thread', () => {
    const onOpen = vi.fn();
    const onToggleStar = vi.fn();
    render(<ThreadRow {...props} onOpen={onOpen} onToggleStar={onToggleStar} row={row()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Star$/ }));
    expect(onToggleStar).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('labels the star button by its current state', () => {
    render(<ThreadRow {...props} row={row({ isStarred: 1 })} />);
    expect(screen.getByRole('button', { name: /^Unstar$/ })).toBeInTheDocument();
  });

  it('shows the resolved label for each linked item, not just its type', () => {
    render(<ThreadRow {...props} row={row({
      links: [
        link({ label: 'RFI-012' }),
        link({ id: 'l2', itemType: 'proposal', itemId: 'p1', label: 'Proposal #2 — Deck' }),
      ],
    })} />);
    expect(screen.getAllByTestId('mail-link-chip').map(c => c.textContent)).toEqual(['RFI-012', 'Proposal #2 — Deck']);
  });

  it('falls back to the item-type name when a link has no resolved label', () => {
    render(<ThreadRow {...props} row={row({ links: [link({ label: undefined })] })} />);
    expect(screen.getAllByTestId('mail-link-chip').map(c => c.textContent)).toEqual(['RFI']);
  });

  it('dedupes chips by the rendered label, not by item type — two distinctly labeled RFIs both show', () => {
    render(<ThreadRow {...props} row={row({
      links: [
        link({ label: 'RFI-012' }),
        link({ id: 'l2', itemId: 'r2', label: 'RFI-013' }),
        link({ id: 'l3', itemId: 'r2', label: 'RFI-013' }), // exact duplicate label collapses
      ],
    })} />);
    expect(screen.getAllByTestId('mail-link-chip').map(c => c.textContent)).toEqual(['RFI-012', 'RFI-013']);
  });

  it('caps visible chips and folds the rest into a "+N" overflow chip', () => {
    render(<ThreadRow {...props} row={row({
      links: [
        link({ label: 'RFI-012' }),
        link({ id: 'l2', itemType: 'proposal', itemId: 'p1', label: 'Proposal #2' }),
        link({ id: 'l3', itemType: 'invoice', itemId: 'i1', label: 'Invoice 104' }),
        link({ id: 'l4', itemType: 'issue', itemId: 'iss1', label: 'ISS-004' }),
        link({ id: 'l5', itemType: 'task', itemId: 't1', label: 'Order material' }),
      ],
    })} />);
    expect(screen.getAllByTestId('mail-link-chip').map(c => c.textContent)).toEqual(['RFI-012', 'Proposal #2', 'Invoice 104']);
    const overflow = screen.getByTestId('mail-link-chip-overflow');
    expect(overflow).toHaveTextContent('+2');
    expect(overflow).toHaveAttribute('title', 'ISS-004, Order material');
  });

  it('shows no overflow chip when every link fits under the cap', () => {
    render(<ThreadRow {...props} row={row({ links: [link({ label: 'RFI-012' })] })} />);
    expect(screen.queryByTestId('mail-link-chip-overflow')).toBeNull();
  });

  it('shows the paperclip only when the thread has attachments', () => {
    const { rerender } = render(<ThreadRow {...props} row={row()} />);
    expect(screen.queryByTestId('mail-attachment-icon')).toBeNull();
    rerender(<ThreadRow {...props} row={row({ hasAttachments: 1 })} />);
    expect(screen.getByTestId('mail-attachment-icon')).toBeInTheDocument();
  });

  it('renders the participants label and the formatted date', () => {
    render(<ThreadRow {...props} row={row()} />);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('8/27/25')).toBeInTheDocument();
  });

  it('flags the selected row for the caller', () => {
    render(<ThreadRow {...props} selected row={row()} />);
    expect(screen.getByTestId('mail-thread-row')).toHaveAttribute('data-selected', 'true');
  });
});
