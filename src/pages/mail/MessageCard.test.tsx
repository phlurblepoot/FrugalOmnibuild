// src/pages/mail/MessageCard.test.tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MessageRow } from './types';

vi.mock('./MessageBodyFrame', () => ({
  MessageBodyFrame: ({ messageId }: { messageId: string }) => <div data-testid="body-frame">{messageId}</div>,
}));

import { MessageCard } from './MessageCard';

const message = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1',
  accountId: 'a1',
  threadKey: 'tk-1',
  messageIdHeader: '<m1@acme.com>',
  inReplyTo: null,
  references: [],
  from: { addr: 'bob@acme.com', name: 'Bob Smith' },
  to: [{ addr: 'noah@birchwoodplaster.example', name: 'Noah' }],
  cc: [{ addr: 'dana@acme.com', name: 'Dana Lee' }],
  bcc: [],
  subject: 'Roof detail',
  snippet: 'Please review the attached detail',
  date: '2025-08-27T12:00:00.000Z',
  isRead: true,
  isStarred: false,
  isDraft: false,
  hasAttachments: false,
  attachments: [],
  sizeBytes: 2048,
  folderIds: ['f-inbox'],
  sentFromApp: false,
  ...over,
});

const props = {
  ownAddresses: ['noah@birchwoodplaster.example'],
  onToggle: vi.fn(),
  onReply: vi.fn(),
  onSave: vi.fn(),
};

describe('MessageCard', () => {
  it('shows one summary line when collapsed and no body', () => {
    render(<MessageCard {...props} message={message()} expanded={false} />);
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();
    expect(screen.getByText(/Please review the attached detail/)).toBeInTheDocument();
    expect(screen.getByText('8/27/25')).toBeInTheDocument();
    expect(screen.queryByTestId('body-frame')).toBeNull();
    expect(screen.getByTestId('mail-message-card')).toHaveAttribute('data-expanded', 'false');
  });

  it('toggles when the collapsed row is clicked', () => {
    const onToggle = vi.fn();
    render(<MessageCard {...props} onToggle={onToggle} message={message()} expanded={false} />);
    fireEvent.click(screen.getByTestId('mail-message-card'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows sender, recipients and the body frame when expanded', () => {
    render(<MessageCard {...props} message={message()} expanded />);
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();
    expect(screen.getByText('bob@acme.com')).toBeInTheDocument();
    expect(screen.getByText('to me, cc Dana Lee')).toBeInTheDocument();
    expect(screen.getByTestId('body-frame')).toHaveTextContent('m1');
    expect(screen.getByTestId('mail-message-card')).toHaveAttribute('data-expanded', 'true');
  });

  it('names the recipients when the reader is not one of them', () => {
    render(
      <MessageCard
        {...props}
        message={message({ to: [{ addr: 'sam@acme.com', name: 'Sam Reyes' }], cc: [] })}
        expanded
      />,
    );
    expect(screen.getByText('to Sam Reyes')).toBeInTheDocument();
  });

  it('shows the avatar initial of the sender', () => {
    render(<MessageCard {...props} message={message()} expanded />);
    expect(screen.getByTestId('mail-avatar')).toHaveTextContent('B');
  });

  it('calls onReply with the mode of the button pressed', () => {
    const onReply = vi.fn();
    render(<MessageCard {...props} onReply={onReply} message={message()} expanded />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply to this message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reply all to this message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward this message' }));
    expect(onReply.mock.calls.map(c => c[0])).toEqual(['reply', 'replyAll', 'forward']);
  });

  // Reply and reply-all were both corner-arrows and read as the same button at
  // a glance; the distinct lucide Reply/ReplyAll glyphs are the whole point.
  it('gives reply and reply-all their own icons', () => {
    render(<MessageCard {...props} message={message()} expanded />);
    const iconOf = (name: string) =>
      screen.getByRole('button', { name }).querySelector('svg')!;
    expect(iconOf('Reply to this message').classList.contains('lucide-reply')).toBe(true);
    expect(iconOf('Reply all to this message').classList.contains('lucide-reply-all')).toBe(true);
    expect(iconOf('Reply all to this message').classList.contains('lucide-reply')).toBe(false);
    expect(iconOf('Forward this message').classList.contains('lucide-forward')).toBe(true);
  });

  it('renders attachment chips for an expanded message that has attachments', () => {
    render(
      <MessageCard
        {...props}
        expanded
        message={message({
          hasAttachments: true,
          attachments: [{ attId: 'a1', name: 'detail.pdf', mime: 'application/pdf', size: 1024 }],
        })}
      />,
    );
    expect(screen.getByText('detail.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save to Documents/i })).toBeInTheDocument();
  });

  it('marks an unread message for the reader', () => {
    render(<MessageCard {...props} message={message({ isRead: false })} expanded={false} />);
    expect(screen.getByTestId('mail-message-card')).toHaveAttribute('data-unread', 'true');
  });
});
