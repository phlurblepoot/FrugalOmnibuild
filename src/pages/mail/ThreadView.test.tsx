// src/pages/mail/ThreadView.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { MailAccount, MailFolder, MessageRow, ThreadLink, ThreadListRow } from './types';

const h = vi.hoisted(() => ({
  threadActions: vi.fn(),
  messageActions: vi.fn(),
  attachmentUrl: vi.fn(() => '/att'),
  deleteLink: vi.fn(),
  useThread: vi.fn(),
  folders: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../utils/mailApi', () => ({ mailApi: h }));
vi.mock('./useThread', () => ({ useThread: h.useThread }));
vi.mock('./useMailFolders', () => ({ useMailFolders: () => ({ folders: h.folders(), loading: false, reload: vi.fn() }) }));
vi.mock('./MessageBodyFrame', () => ({
  MessageBodyFrame: ({ messageId }: { messageId: string }) => <div data-testid="body-frame">{messageId}</div>,
}));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
// The composer itself is covered by MailComposer.test.tsx; here it's a stub
// that surfaces exactly the props ThreadView is responsible for wiring
// (variant/mode, onClose, onSent, onOpenInModal) as clickable buttons.
vi.mock('./compose/MailComposer', () => ({
  MailComposer: ({ variant, mode, onClose, onSent, onOpenInModal }: {
    variant: string; mode: string; onClose: () => void; onSent?: () => void; onOpenInModal?: () => void;
  }) => (
    <div data-testid="mail-composer" data-variant={variant} data-mode={mode}>
      <button onClick={onClose}>composer-close</button>
      <button onClick={() => onSent?.()}>composer-sent</button>
      {onOpenInModal && <button onClick={onOpenInModal}>composer-promote</button>}
    </div>
  ),
}));
// LinkPickerModal itself is covered by LinkPickerModal.test.tsx; here it's a
// stub that surfaces exactly the props ThreadView wires (open/threadKey/onLinked).
vi.mock('./LinkPickerModal', () => ({
  LinkPickerModal: ({ open, onClose, threadKey, onLinked }: {
    open: boolean; onClose: () => void; threadKey: string; onLinked: () => void;
  }) =>
    open ? (
      <div data-testid="link-picker-modal-stub" data-thread-key={threadKey}>
        <button onClick={onClose}>link-picker-close</button>
        <button onClick={onLinked}>link-picker-linked</button>
      </div>
    ) : null,
}));
// CreateFromThreadMenu is covered by CreateFromThreadMenu.test.tsx; here it's
// a stub that surfaces exactly the props ThreadView wires.
vi.mock('./CreateFromThreadMenu', () => ({
  CreateFromThreadMenu: ({ threadKey, subject }: { threadKey: string; subject: string }) => (
    <div data-testid="create-from-thread-menu-stub" data-thread-key={threadKey} data-subject={subject} />
  ),
}));

import { ThreadView } from './ThreadView';

const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1', accountId: 'a1', threadKey: 'tk-1', messageIdHeader: null, inReplyTo: null, references: [],
  from: { addr: 'bob@acme.com', name: 'Bob Smith' }, to: [{ addr: 'noah@birchwoodplaster.example' }], cc: [], bcc: [],
  subject: 'Roof detail', snippet: 'first message', date: '2026-08-27T12:00:00.000Z',
  isRead: true, isStarred: false, isDraft: false, hasAttachments: false, attachments: [],
  sizeBytes: 10, folderIds: ['f-inbox'], sentFromApp: false, ...over,
});

const THREAD: ThreadListRow = {
  threadKey: 'tk-1', subject: 'Roof detail', firstDate: '2026-08-27T12:00:00.000Z',
  lastDate: '2026-08-27T13:00:00.000Z', messageCount: 2, unreadCount: 0, hasAttachments: 0, isStarred: 0,
  participants: [{ addr: 'bob@acme.com', name: 'Bob Smith' }], folderIds: ['f-inbox'],
  snippet: 'second message', links: [],
};

const LINK: ThreadLink = {
  id: 'l1', threadKey: 'tk-1', subjectSnapshot: 'Roof detail', firstDate: null, participantsJson: null,
  itemType: 'rfi', itemId: 'r1', projectId: 'p1', customerId: null, linkedByUserId: 'u1',
  createdAt: '2026-08-27T12:00:00.000Z',
};

const FOLDERS: MailFolder[] = [
  { id: 'f-inbox', accountId: 'a1', providerId: 'INBOX', name: 'INBOX', role: 'inbox', unreadCount: 0, totalCount: 3, sortOrder: 0 },
  { id: 'f-jobs', accountId: 'a1', providerId: 'Jobs', name: 'Jobs', role: null, unreadCount: 0, totalCount: 1, sortOrder: 1 },
];

const state = (over: Partial<ReturnType<typeof baseState>> = {}) => ({ ...baseState(), ...over });
const baseState = () => ({
  thread: THREAD,
  messages: [msg(), msg({ id: 'm2', snippet: 'second message', date: '2026-08-27T13:00:00.000Z' })],
  links: [] as ThreadLink[],
  loading: false,
  error: null as string | null,
  reload: vi.fn(),
});

const ACCOUNTS: MailAccount[] = [{
  id: 'a1', provider: 'imap', emailAddress: 'noah@birchwoodplaster.example', displayName: 'Noah',
  signatureHtml: null, isDefault: 1, status: 'ok', lastSyncAt: null, lastError: null,
  indexedSince: '2026-01-01T00:00:00.000Z', unreadCount: 0,
}];

const props = {
  accountId: 'a1',
  threadKey: 'tk-1',
  ownAddresses: ['noah@birchwoodplaster.example'],
  accounts: ACCOUNTS,
  onBack: vi.fn(),
  onReply: vi.fn(),
  onOpenInComposer: vi.fn(),
  replyComposer: null as { mode: 'reply' | 'replyAll' | 'forward'; message: MessageRow; bodyHtml: string } | null,
  replyVariant: 'inline' as 'modal' | 'inline',
  onReplyClose: vi.fn(),
  onReplyPromote: vi.fn(),
  navigate: vi.fn(),
};

const cards = () => screen.getAllByTestId('mail-message-card');

beforeEach(() => {
  vi.clearAllMocks();
  h.threadActions.mockResolvedValue(undefined);
  h.messageActions.mockResolvedValue(undefined);
  h.deleteLink.mockResolvedValue(undefined);
  h.folders.mockReturnValue(FOLDERS);
  h.useThread.mockReturnValue(state());
  localStorage.removeItem('user');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThreadView', () => {
  it('shows a skeleton while the thread loads', () => {
    h.useThread.mockReturnValue(state({ thread: null, messages: [], loading: true }));
    render(<ThreadView {...props} />);
    expect(screen.getByTestId('mail-thread-loading')).toBeInTheDocument();
  });

  it('reports a thread that could not be loaded', () => {
    h.useThread.mockReturnValue(state({ thread: null, messages: [], error: 'Thread not found' }));
    render(<ThreadView {...props} />);
    expect(screen.getByText(/Thread not found/i)).toBeInTheDocument();
  });

  it('renders the subject and expands only the last message', () => {
    render(<ThreadView {...props} />);
    expect(screen.getByText('Roof detail')).toBeInTheDocument();
    expect(cards().map(c => c.getAttribute('data-expanded'))).toEqual(['false', 'true']);
    expect(screen.getByTestId('body-frame')).toHaveTextContent('m2');
  });

  it('also expands an earlier unread message', () => {
    h.useThread.mockReturnValue(state({
      messages: [msg({ isRead: false }), msg({ id: 'm2', date: '2026-08-27T13:00:00.000Z' })],
    }));
    render(<ThreadView {...props} />);
    expect(cards().map(c => c.getAttribute('data-expanded'))).toEqual(['true', 'true']);
  });

  it('collapses and re-expands a card on click', () => {
    render(<ThreadView {...props} />);
    fireEvent.click(cards()[0]);
    expect(cards().map(c => c.getAttribute('data-expanded'))).toEqual(['true', 'true']);
    fireEvent.click(screen.getAllByTestId('mail-message-header')[0]);
    expect(cards().map(c => c.getAttribute('data-expanded'))).toEqual(['false', 'true']);
  });

  it('marks a message read one second after it is expanded, flipping the dot immediately', async () => {
    vi.useFakeTimers();
    h.useThread.mockReturnValue(state({
      messages: [msg({ isRead: false }), msg({ id: 'm2', date: '2026-08-27T13:00:00.000Z' })],
    }));
    render(<ThreadView {...props} />);

    // optimistic: the unread flag is gone before the request goes out
    expect(cards()[0]).toHaveAttribute('data-unread', 'false');
    expect(h.messageActions).not.toHaveBeenCalled();

    // …and the request itself waits out the full second
    await act(async () => { vi.advanceTimersByTime(900); });
    expect(h.messageActions).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(200); });
    expect(h.messageActions).toHaveBeenCalledWith(['m1'], 'read');
    expect(h.messageActions).toHaveBeenCalledTimes(1);
  });

  it('does not mark an already-read message read again', async () => {
    vi.useFakeTimers();
    render(<ThreadView {...props} />);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(h.messageActions).not.toHaveBeenCalled();
  });

  it('archives the thread and goes back', async () => {
    const onBack = vi.fn();
    render(<ThreadView {...props} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'archive'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('trashes the thread and goes back', async () => {
    const onBack = vi.fn();
    render(<ThreadView {...props} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: /^Trash$/ }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'trash'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('keeps the reader open and warns when an action fails', async () => {
    const onBack = vi.fn();
    h.threadActions.mockRejectedValueOnce(new Error('nope'));
    render(<ThreadView {...props} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }));
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(onBack).not.toHaveBeenCalled();
  });

  it('stars and unstars the thread', async () => {
    const { rerender } = render(<ThreadView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^Star$/ }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'star'));

    h.useThread.mockReturnValue(state({ thread: { ...THREAD, isStarred: 1 } }));
    rerender(<ThreadView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^Unstar$/ }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'unstar'));
  });

  it('marks the thread unread and goes back to the list', async () => {
    const onBack = vi.fn();
    render(<ThreadView {...props} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark unread/i }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'unread'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('moves the thread into a folder picked from the Move menu', async () => {
    render(<ThreadView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'move', 'f-jobs'));
  });

  it('replies, replies all and forwards from the toolbar using the newest message', () => {
    const onReply = vi.fn();
    render(<ThreadView {...props} onReply={onReply} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reply$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Reply all$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Forward$/ }));
    expect(onReply.mock.calls.map(c => [c[0], c[1].id])).toEqual([
      ['reply', 'm2'], ['replyAll', 'm2'], ['forward', 'm2'],
    ]);
  });

  it('gives the toolbar reply and reply-all their own icons', () => {
    render(<ThreadView {...props} />);
    const iconOf = (name: RegExp) => screen.getByRole('button', { name }).querySelector('svg')!;
    expect(iconOf(/^Reply$/).classList.contains('lucide-reply')).toBe(true);
    expect(iconOf(/^Reply all$/).classList.contains('lucide-reply-all')).toBe(true);
    expect(iconOf(/^Reply all$/).classList.contains('lucide-reply')).toBe(false);
  });

  it('opens a blank composer from the overflow menu', () => {
    const onOpenInComposer = vi.fn();
    render(<ThreadView {...props} onOpenInComposer={onOpenInComposer} />);
    fireEvent.click(screen.getByRole('button', { name: /More actions/i }));
    // Labelled "New message": it composes a fresh mail, it does not carry this
    // thread into the composer.
    fireEvent.click(screen.getByRole('button', { name: /New message/i }));
    expect(onOpenInComposer).toHaveBeenCalledTimes(1);
  });

  it('closes an open menu on Escape', () => {
    render(<ThreadView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.getByTestId('mail-thread-menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('mail-thread-menu')).toBeNull();
  });

  it('shows the link strip only when the thread is linked to app items', () => {
    const { rerender } = render(<ThreadView {...props} />);
    expect(screen.queryByTestId('mail-thread-link-chip')).toBeNull();

    h.useThread.mockReturnValue(state({ links: [LINK, { ...LINK, id: 'l2', itemId: 'r2' }, { ...LINK, id: 'l3', itemType: 'invoice', itemId: 'i1' }] }));
    rerender(<ThreadView {...props} />);
    expect(screen.getAllByTestId('mail-thread-link-chip').map(c => c.textContent)).toEqual(['RFI', 'RFI', 'Invoice']);
  });

  it('shows a chip for every link, resolved label when present, itemTypeLabel as a fallback', () => {
    h.useThread.mockReturnValue(state({
      links: [{ ...LINK, label: 'RFI-012' }, { ...LINK, id: 'l2', itemType: 'invoice', itemId: 'i1', label: undefined }],
    }));
    render(<ThreadView {...props} />);
    expect(screen.getAllByTestId('mail-thread-link-chip').map(c => c.textContent)).toEqual(['RFI-012', 'Invoice']);
  });

  it('always shows a Link button that opens LinkPickerModal for this thread', () => {
    render(<ThreadView {...props} />);
    expect(screen.queryByTestId('link-picker-modal-stub')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Link$/ }));
    const stub = screen.getByTestId('link-picker-modal-stub');
    expect(stub).toHaveAttribute('data-thread-key', 'tk-1');
  });

  it('closing LinkPickerModal hides it again', () => {
    render(<ThreadView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^Link$/ }));
    fireEvent.click(screen.getByText('link-picker-close'));
    expect(screen.queryByTestId('link-picker-modal-stub')).toBeNull();
  });

  it('a successful link reloads the thread', () => {
    const reload = vi.fn();
    h.useThread.mockReturnValue(state({ reload }));
    render(<ThreadView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^Link$/ }));
    fireEvent.click(screen.getByText('link-picker-linked'));
    expect(reload).toHaveBeenCalled();
  });

  describe('unlink', () => {
    it('shows × on a link the current user made', () => {
      localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'user' }));
      h.useThread.mockReturnValue(state({ links: [{ ...LINK, linkedByUserId: 'u1' }] }));
      render(<ThreadView {...props} />);
      expect(screen.getByRole('button', { name: /Unlink/i })).toBeInTheDocument();
    });

    it('hides × on someone else\'s link for a non-admin', () => {
      localStorage.setItem('user', JSON.stringify({ id: 'u2', role: 'user' }));
      h.useThread.mockReturnValue(state({ links: [{ ...LINK, linkedByUserId: 'u1' }] }));
      render(<ThreadView {...props} />);
      expect(screen.queryByRole('button', { name: /Unlink/i })).toBeNull();
    });

    it('shows × on any link for an admin, even one they did not make', () => {
      localStorage.setItem('user', JSON.stringify({ id: 'u2', role: 'admin' }));
      h.useThread.mockReturnValue(state({ links: [{ ...LINK, linkedByUserId: 'u1' }] }));
      render(<ThreadView {...props} />);
      expect(screen.getByRole('button', { name: /Unlink/i })).toBeInTheDocument();
    });

    it('deletes the link and reloads on click', async () => {
      const reload = vi.fn();
      localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'user' }));
      h.useThread.mockReturnValue(state({ links: [{ ...LINK, id: 'l9', linkedByUserId: 'u1' }], reload }));
      render(<ThreadView {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /Unlink/i }));
      await waitFor(() => expect(h.deleteLink).toHaveBeenCalledWith('l9'));
      await waitFor(() => expect(reload).toHaveBeenCalled());
    });

    it('toasts and does not reload when the delete fails', async () => {
      const reload = vi.fn();
      h.deleteLink.mockRejectedValueOnce(new Error('nope'));
      localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'user' }));
      h.useThread.mockReturnValue(state({ links: [{ ...LINK, linkedByUserId: 'u1' }], reload }));
      render(<ThreadView {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /Unlink/i }));
      await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/could not remove/i), expect.objectContaining({ type: 'error' })));
      expect(reload).not.toHaveBeenCalled();
    });
  });

  it('renders no composer under the thread when no reply is in progress', () => {
    render(<ThreadView {...props} />);
    expect(screen.queryByTestId('mail-composer')).toBeNull();
  });

  it('renders the reply composer under the thread with the variant MailPage passed', () => {
    render(<ThreadView {...props} replyComposer={{ mode: 'reply', message: msg({ id: 'm2' }), bodyHtml: '<p>hi</p>' }} replyVariant="inline" />);
    const composer = screen.getByTestId('mail-composer');
    expect(composer).toHaveAttribute('data-variant', 'inline');
    expect(composer).toHaveAttribute('data-mode', 'reply');
    // Inline offers the promote-to-modal button; modal (below) does not.
    expect(screen.getByRole('button', { name: 'composer-promote' })).toBeInTheDocument();
  });

  it('does not offer "open in modal" once the composer is already the modal', () => {
    render(<ThreadView {...props} replyComposer={{ mode: 'forward', message: msg(), bodyHtml: '<p>hi</p>' }} replyVariant="modal" />);
    expect(screen.getByTestId('mail-composer')).toHaveAttribute('data-variant', 'modal');
    expect(screen.queryByRole('button', { name: 'composer-promote' })).toBeNull();
  });

  it('promotes the inline composer via onReplyPromote', () => {
    const onReplyPromote = vi.fn();
    render(<ThreadView {...props} replyComposer={{ mode: 'reply', message: msg(), bodyHtml: '<p>hi</p>' }} onReplyPromote={onReplyPromote} />);
    fireEvent.click(screen.getByRole('button', { name: 'composer-promote' }));
    expect(onReplyPromote).toHaveBeenCalledTimes(1);
  });

  it('closes the reply composer via onReplyClose', () => {
    const onReplyClose = vi.fn();
    render(<ThreadView {...props} replyComposer={{ mode: 'reply', message: msg(), bodyHtml: '<p>hi</p>' }} onReplyClose={onReplyClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'composer-close' }));
    expect(onReplyClose).toHaveBeenCalledTimes(1);
  });

  it('reloads the thread when the composer reports a successful send', () => {
    const st = state();
    h.useThread.mockReturnValue(st);
    render(<ThreadView {...props} replyComposer={{ mode: 'reply', message: msg(), bodyHtml: '<p>hi</p>' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'composer-sent' }));
    expect(st.reload).toHaveBeenCalledTimes(1);
  });
});
