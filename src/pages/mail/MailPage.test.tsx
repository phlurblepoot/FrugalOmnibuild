// src/pages/mail/MailPage.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { MailAccount, MailFolder, MessageRow, OpenedDraft, SendRequest, ThreadListRow } from './types';

const h = vi.hoisted(() => ({
  accounts: vi.fn(), folders: vi.fn(), threads: vi.fn(), thread: vi.fn(), body: vi.fn(),
  threadActions: vi.fn(), messageActions: vi.fn(), attachmentUrl: vi.fn(() => '/att'),
  heartbeat: vi.fn(), loadOlder: vi.fn(), toast: vi.fn(), searchServer: vi.fn(), refreshAccount: vi.fn(),
  send: vi.fn(), saveDraft: vi.fn(), deleteDraft: vi.fn(), stageUpload: vi.fn(), recipients: vi.fn(),
  getAlwaysCc: vi.fn(), openDraft: vi.fn(),
}));
vi.mock('../../utils/mailApi', () => ({ mailApi: h }));
vi.mock('../../utils/store', () => ({ getAlwaysCc: h.getAlwaysCc }));
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: null }) }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
// The reading pane's own body iframe isn't what these tests exercise — real
// only where the composer needs it (buildFrameDoc, for the quote preview).
vi.mock('./MessageBodyFrame', async orig => ({
  ...(await orig<typeof import('./MessageBodyFrame')>()),
  MessageBodyFrame: ({ messageId }: { messageId: string }) => <div data-testid="body-frame">{messageId}</div>,
}));
// The real editor is covered by RichTextEditor.test.tsx; here it's a plain
// textarea so composer-body assertions don't depend on ProseMirror.
vi.mock('./compose/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="composer-body" value={value} onChange={e => onChange(e.target.value)} />
  ),
}));
vi.mock('../../components/FilePickerModal', () => ({ FilePickerModal: () => null }));

import { MailPage } from './MailPage';

const ACCOUNT: MailAccount = {
  id: 'a1', provider: 'imap', emailAddress: 'noah@birchwoodplaster.example', displayName: 'Noah',
  signatureHtml: null, isDefault: 1, status: 'ok', lastSyncAt: null, lastError: null,
  indexedSince: '2026-02-01T00:00:00.000Z', unreadCount: 2,
};
const FOLDERS: MailFolder[] = [
  { id: 'f-inbox', accountId: 'a1', providerId: 'INBOX', name: 'INBOX', role: 'inbox', unreadCount: 2, totalCount: 9, sortOrder: 0 },
  { id: 'f-sent', accountId: 'a1', providerId: 'Sent', name: 'Sent', role: 'sent', unreadCount: 0, totalCount: 4, sortOrder: 1 },
];
const THREAD: ThreadListRow = {
  threadKey: 'tk-1', subject: 'Roof detail', firstDate: '2026-08-27T12:00:00.000Z',
  lastDate: '2026-08-27T12:00:00.000Z', messageCount: 2, unreadCount: 1, hasAttachments: 1, isStarred: 0,
  participants: [{ addr: 'bob@acme.com', name: 'Bob Smith' }], folderIds: ['f-inbox'],
  snippet: 'Please review the attached detail', links: [],
};
const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1', accountId: 'a1', threadKey: 'tk-1', messageIdHeader: null, inReplyTo: null, references: [],
  from: { addr: 'bob@acme.com', name: 'Bob Smith' }, to: [{ addr: 'noah@birchwoodplaster.example' }], cc: [], bcc: [],
  subject: 'Roof detail', snippet: 'first message', date: '2026-08-27T12:00:00.000Z',
  isRead: true, isStarred: false, isDraft: false, hasAttachments: false, attachments: [],
  sizeBytes: 10, folderIds: ['f-inbox'], sentFromApp: false, ...over,
});
const MESSAGES: MessageRow[] = [
  msg(),
  msg({ id: 'm2', snippet: 'second message', date: '2026-08-27T13:00:00.000Z' }),
];

const Probe: React.FC = () => {
  const loc = useLocation();
  return <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>;
};

const mount = (path = '/mail') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {['mail', 'mail/:accountId', 'mail/:accountId/:folderId', 'mail/:accountId/:folderId/:threadKey'].map(p => (
          <Route key={p} path={`/${p}`} element={<MailPage />} />
        ))}
        <Route path="/settings" element={<h1>Settings</h1>} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );

const loc = () => screen.getByTestId('loc').textContent;
const folderRow = (id: string): HTMLElement =>
  screen.getAllByTestId('mail-folder-row').find(r => r.getAttribute('data-folder-id') === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.accounts.mockResolvedValue([ACCOUNT]);
  h.folders.mockResolvedValue(FOLDERS);
  h.threads.mockResolvedValue({ threads: [THREAD], hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z' });
  h.thread.mockResolvedValue({ thread: THREAD, messages: MESSAGES, links: [] });
  h.body.mockResolvedValue({ html: '<p>Original message</p>', text: 'Original message', blockedRemoteImages: 0, attachments: [] });
  h.threadActions.mockResolvedValue(undefined);
  h.messageActions.mockResolvedValue(undefined);
  h.heartbeat.mockResolvedValue(undefined);
  h.loadOlder.mockResolvedValue({ indexedSince: '2025-08-01T00:00:00.000Z' });
  h.send.mockResolvedValue({ messageId: 'm-new', threadKey: 'tk-1', accountId: 'a1', effectsSkipped: [] });
  h.saveDraft.mockResolvedValue({ draftId: 'd1' });
  h.deleteDraft.mockResolvedValue(undefined);
  h.stageUpload.mockResolvedValue({ uploadId: 'u1' });
  h.recipients.mockResolvedValue([]);
  h.searchServer.mockResolvedValue({ count: 0, threadKeys: [] });
  h.refreshAccount.mockResolvedValue(undefined);
  h.getAlwaysCc.mockResolvedValue('');
});

describe('MailPage', () => {
  it('sends a user with no mail accounts to the mail settings tab', async () => {
    h.accounts.mockResolvedValue([]);
    mount();
    await screen.findByText('Connect a mail account');
    fireEvent.click(screen.getByRole('button', { name: /mail settings/i }));
    await waitFor(() => expect(loc()).toBe('/settings?tab=mail'));
    expect(h.threads).not.toHaveBeenCalled();
  });

  it('lands on the default account inbox and lists its threads', async () => {
    mount();
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox'));
    expect(await screen.findByText('Roof detail')).toBeInTheDocument();
    expect(screen.getByTestId('mail-thread-row')).toHaveAttribute('data-unread', 'true');
    expect(h.threads).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a1', folderId: 'f-inbox' }));
  });

  it('falls back to the "_" no-folder id when the account has no inbox folder', async () => {
    h.folders.mockResolvedValue([FOLDERS[1]]);
    mount();
    await waitFor(() => expect(loc()).toBe('/mail/a1/_'));
    await waitFor(() => expect(h.threads).toHaveBeenCalledWith(expect.not.objectContaining({ folderId: expect.anything() })));
  });

  it('opens a thread by URL and keeps the selection in the list', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByTestId('mail-thread-row'));
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox/tk-1'));
    expect(screen.getByTestId('mail-thread-row')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('mail-thread-slot')).toHaveAttribute('data-thread-key', 'tk-1');
  });

  it('renders a deep-linked thread straight away', async () => {
    mount('/mail/a1/f-inbox/tk-1');
    await waitFor(() => expect(screen.getByTestId('mail-thread-slot')).toHaveAttribute('data-thread-key', 'tk-1'));
  });

  it('switches folder from the rail without leaving the account', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(folderRow('f-sent'));
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-sent'));
  });

  it('waits for the new account\'s own folders before picking its inbox', async () => {
    const a2: MailAccount = { ...ACCOUNT, id: 'a2', emailAddress: 'office@birchwoodplaster.example', isDefault: 0 };
    const a2Inbox: MailFolder = { ...FOLDERS[0], id: 'f2-inbox', accountId: 'a2' };
    h.accounts.mockResolvedValue([ACCOUNT, a2]);
    h.folders.mockImplementation(async (id: string) => (id === 'a1' ? FOLDERS : [a2Inbox]));

    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.change(screen.getByLabelText('Mail account'), { target: { value: 'a2' } });

    await waitFor(() => expect(loc()).toBe('/mail/a2/f2-inbox'));
  });

  it('stars a thread through the thread action route', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByRole('button', { name: /^Star$/ }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'star'));
  });

  it('debounces the search box into the ?q= query string', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.change(screen.getByPlaceholderText(/search mail/i), { target: { value: 'roof' } });
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox?q=roof'));
    await waitFor(() => expect(h.threads).toHaveBeenCalledWith(expect.objectContaining({ q: 'roof' })));
  });

  it('offers to backfill older mail from the end of the list', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByRole('button', { name: /load older mail/i }));
    await waitFor(() => expect(h.loadOlder).toHaveBeenCalledWith('a1', 6));
    expect(h.toast).toHaveBeenCalled();
  });

  it('keeps the mailbox syncing with a heartbeat for the open account', async () => {
    mount('/mail/a1/f-inbox');
    await waitFor(() => expect(h.heartbeat).toHaveBeenCalledWith(['a1']));
  });

  it('routes Compose through the ?compose=1 URL flag and opens the modal composer', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    // Two entry points by design: the rail (>= md) and the mobile folder bar.
    const composeButtons = screen.getAllByRole('button', { name: /compose/i });
    expect(composeButtons).toHaveLength(2);
    fireEvent.click(composeButtons[0]);
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox?compose=1'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toBeInTheDocument();
  });

  describe('compose and reply', () => {
    it('opens the modal composer straight from a ?compose=1 deep link', async () => {
      mount('/mail/a1/f-inbox?compose=1');
      await screen.findByText('Roof detail');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('New message')).toBeInTheDocument();
    });

    it('clears ?compose=1 and closes the modal when it is dismissed', async () => {
      mount('/mail/a1/f-inbox?compose=1');
      await screen.findByText('Roof detail');
      fireEvent.click(screen.getByLabelText('Close dialog'));
      await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox'));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('opens the inline reply composer under the thread, quoting the fetched body', async () => {
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await waitFor(() => expect(h.body).toHaveBeenCalledWith('m2'));
      expect(await screen.findByTestId('mail-composer-inline')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).toBeNull();
      // Reply seeds To from the newest message's sender and quotes its body —
      // seeding is a post-mount effect, so wait for it rather than reading
      // the DOM the instant the (still-empty) composer first appears.
      await waitFor(() => expect(screen.getAllByTestId('recipient-pill')).not.toHaveLength(0));
      expect(screen.getAllByTestId('recipient-pill').map(e => e.textContent).join(' ')).toContain('Bob Smith');
      fireEvent.click(screen.getByText('Show quoted message'));
      expect(screen.getByTestId('quote-preview')).toBeInTheDocument();
    });

    it('warns instead of opening a composer when the message body is still syncing', async () => {
      h.body.mockResolvedValueOnce({ pending: true });
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Message still syncing — try again shortly.'));
      expect(screen.queryByTestId('mail-composer-inline')).toBeNull();
    });

    it('remounts the composer with fresh recipients/subject when switching from reply to forward on another message', async () => {
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');

      // Toolbar Reply always acts on the newest message (m2).
      fireEvent.click(await screen.findByRole('button', { name: /^Reply$/ }));
      await screen.findByTestId('mail-composer-inline');
      await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Re: Roof detail'));

      // Forward the OTHER (earlier, still-collapsed) message from its own
      // per-message button — expand its card to reach it.
      fireEvent.click(screen.getAllByTestId('mail-message-card')[0]);
      fireEvent.click(screen.getAllByRole('button', { name: 'Forward this message' })[0]);
      await waitFor(() => expect(h.body).toHaveBeenCalledWith('m1'));
      await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Fwd: Roof detail'));
      // A fresh forward has no recipient seeded yet.
      expect(screen.queryAllByTestId('recipient-pill')).toHaveLength(0);
    });

    it('promotes the inline reply to the modal without losing what was typed', async () => {
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await screen.findByTestId('mail-composer-inline');
      // Seeding is a post-mount effect that (re)sets the body too — wait for
      // it to settle before typing, or it can clobber what was just typed.
      await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Re: Roof detail'));

      fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'Sounds good, thanks!' } });
      fireEvent.click(screen.getByRole('button', { name: /open in composer/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByTestId('mail-composer-inline')).toBeNull();
      expect(screen.getByTestId('composer-body')).toHaveValue('Sounds good, thanks!');
    });

    // A brand-new message never lands in an open thread, and the live event is
    // suppressed for the tab that sent it, so the list has to be told.
    it('refreshes the thread list after sending a brand-new message', async () => {
      mount('/mail/a1/f-inbox?compose=1');
      await screen.findByText('Roof detail');
      await waitFor(() => expect(h.threads).toHaveBeenCalledTimes(1));

      const to = screen.getByLabelText('To');
      fireEvent.change(to, { target: { value: 'bob@acme.com' } });
      fireEvent.keyDown(to, { key: 'Enter' });
      fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'New scope' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(h.send).toHaveBeenCalled());
      await waitFor(() => expect(h.threads).toHaveBeenCalledTimes(2));
    });

    it('closes the composer and reloads the thread after a successful send', async () => {
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await screen.findByTestId('mail-composer-inline');
      // Send is disabled until seeding fills in To — wait for it before clicking.
      await waitFor(() => expect(screen.getAllByTestId('recipient-pill')).not.toHaveLength(0));

      expect(h.thread).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(h.send).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByTestId('mail-composer-inline')).toBeNull());
      await waitFor(() => expect(h.thread).toHaveBeenCalledTimes(2));
    });
  });

  // Piece 1 (reply-discard confirm): a typed-but-unsent inline reply is
  // trivial to lose by clicking somewhere else in the mailbox — thread
  // switch, folder switch, account switch all unmount ThreadView (and the
  // composer with it). window.confirm is the guard; both the accept and
  // cancel path are exercised, and a composer with nothing typed never asks.
  describe('reply-discard confirm', () => {
    const THREAD2: ThreadListRow = {
      ...THREAD, threadKey: 'tk-2', subject: 'Stucco mock-up',
      snippet: 'Approved, please proceed', participants: [{ addr: 'dana@tidewater.test', name: 'Dana Lee' }],
    };
    const MESSAGES2: MessageRow[] = [msg({ id: 'm3', threadKey: 'tk-2', subject: 'Stucco mock-up', from: { addr: 'dana@tidewater.test', name: 'Dana Lee' } })];

    const startTyping = async (text = 'Sounds good, thanks!') => {
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await screen.findByTestId('mail-composer-inline');
      await waitFor(() => expect(screen.getAllByTestId('recipient-pill')).not.toHaveLength(0));
      fireEvent.change(screen.getByTestId('composer-body'), { target: { value: text } });
    };

    beforeEach(() => {
      h.threads.mockResolvedValue({ threads: [THREAD, THREAD2], hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z' });
      h.thread.mockImplementation(async (_accountId: string, key: string) =>
        key === 'tk-2' ? { thread: THREAD2, messages: MESSAGES2, links: [] } : { thread: THREAD, messages: MESSAGES, links: [] });
    });

    it('blocks a thread switch on Cancel and leaves the reply and the URL alone', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      await startTyping();

      fireEvent.click(screen.getAllByTestId('mail-thread-row')[1]);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(loc()).toBe('/mail/a1/f-inbox/tk-1');
      expect(screen.getByTestId('composer-body')).toHaveValue('Sounds good, thanks!');
      confirmSpy.mockRestore();
    });

    it('proceeds with a thread switch on OK and discards the reply', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      await startTyping();

      fireEvent.click(screen.getAllByTestId('mail-thread-row')[1]);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox/tk-2'));
      expect(screen.queryByTestId('mail-composer-inline')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('never asks when the reply composer has nothing typed', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await screen.findByTestId('mail-composer-inline');
      await waitFor(() => expect(screen.getAllByTestId('recipient-pill')).not.toHaveLength(0));

      fireEvent.click(screen.getAllByTestId('mail-thread-row')[1]);
      expect(confirmSpy).not.toHaveBeenCalled();
      await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox/tk-2'));
      confirmSpy.mockRestore();
    });

    // Review finding 1 (fix round 1): a failed send must not silently
    // disarm the guard — the composer stays open with the same unsent text,
    // so the next nav still has something real to lose.
    it('still asks after a failed send leaves the composer open with the typed text intact', async () => {
      h.send.mockRejectedValueOnce(new Error('SMTP refused the message'));
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      await startTyping();

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(h.toast).toHaveBeenCalledWith('SMTP refused the message', { type: 'error' }));
      expect(screen.getByTestId('mail-composer-inline')).toBeInTheDocument();
      expect(screen.getByTestId('composer-body')).toHaveValue('Sounds good, thanks!');

      fireEvent.click(screen.getAllByTestId('mail-thread-row')[1]);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(loc()).toBe('/mail/a1/f-inbox/tk-1');
      expect(screen.getByTestId('composer-body')).toHaveValue('Sounds good, thanks!');
      confirmSpy.mockRestore();
    });

    it('guards a folder switch from the rail the same way', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      await startTyping();

      fireEvent.click(folderRow('f-sent'));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(loc()).toBe('/mail/a1/f-inbox/tk-1');
      confirmSpy.mockRestore();
    });

    it('lets a confirmed folder switch through and clears the reply', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      mount('/mail/a1/f-inbox/tk-1');
      await screen.findByText('Roof detail');
      await startTyping();

      fireEvent.click(folderRow('f-sent'));
      await waitFor(() => expect(loc()).toBe('/mail/a1/f-sent'));
      confirmSpy.mockRestore();
    });
  });

  // End-to-end for the whole-mailbox search: the button in the list, the keys
  // the server hands back, the by-key re-query that bypasses the folder and q
  // filters, and Clear putting the folder view back.
  it('shows whole-mailbox search results by key, then clears back to the folder', async () => {
    h.threads.mockResolvedValue({ threads: [], hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z' });
    h.searchServer.mockResolvedValue({ count: 2, threadKeys: ['tk-old', 'tk-older'] });
    mount('/mail/a1/f-inbox?q=shingle');
    await screen.findByText('No matching mail');

    const found = { ...THREAD, threadKey: 'tk-old', subject: 'Ancient shingle CO' };
    h.threads.mockResolvedValue({ threads: [found], hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z' });
    fireEvent.click(screen.getByRole('button', { name: /Search the whole mailbox/i }));

    await screen.findByText('Ancient shingle CO');
    expect(h.searchServer).toHaveBeenCalledWith('a1', 'shingle');
    // By key, with neither the Inbox folder nor the q LIKE in the request —
    // both would hide an archived, body-text-only hit.
    expect(h.threads).toHaveBeenLastCalledWith({ accountId: 'a1', threadKeys: ['tk-old', 'tk-older'], limit: 50 });
    expect(screen.getByTestId('mail-server-results-banner')).toHaveTextContent('Showing 2 results from the full mailbox');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(h.threads).toHaveBeenLastCalledWith({ accountId: 'a1', folderId: 'f-inbox', q: 'shingle', limit: 50 }));
    expect(screen.queryByTestId('mail-server-results-banner')).toBeNull();
  });

  // The two widths ride into the grid as custom properties, not an inline
  // grid-template — an inline template would beat the `lg:` breakpoint and
  // pin the px widths on tablets and phones too.
  describe('resizable panes', () => {
    const grid = () => screen.getByTestId('mail-grid');

    it('starts from the widths stored on this device', async () => {
      localStorage.setItem('mail.rail.w', '260');
      localStorage.setItem('mail.list.w', '420');
      mount('/mail/a1/f-inbox');
      await screen.findByText('Roof detail');
      expect(grid().style.getPropertyValue('--mail-rail-w')).toBe('260px');
      expect(grid().style.getPropertyValue('--mail-list-w')).toBe('420px');
      // The px values are scoped to lg; the narrower layouts keep their own columns.
      expect(grid().className).toContain('lg:grid-cols-[var(--mail-rail-w)_var(--mail-list-w)_minmax(0,1fr)]');
    });

    it('falls back to the defaults when nothing is stored (or storage is unreadable)', async () => {
      mount('/mail/a1/f-inbox');
      await screen.findByText('Roof detail');
      expect(grid().style.getPropertyValue('--mail-rail-w')).toBe('208px');
      expect(grid().style.getPropertyValue('--mail-list-w')).toBe('320px');
    });

    it('resizes the list on a drag and persists the width on release', async () => {
      mount('/mail/a1/f-inbox');
      await screen.findByText('Roof detail');

      const handle = screen.getByTestId('mail-resize-list');
      fireEvent.pointerDown(handle, { clientX: 500 });
      fireEvent.pointerMove(window, { clientX: 560 });
      expect(grid().style.getPropertyValue('--mail-list-w')).toBe('380px');
      // Nothing is written until the drag ends.
      expect(localStorage.getItem('mail.list.w')).toBeNull();

      fireEvent.pointerUp(window);
      expect(localStorage.getItem('mail.list.w')).toBe('380');
      // The pointer has been let go: further movement is not a resize.
      fireEvent.pointerMove(window, { clientX: 700 });
      expect(grid().style.getPropertyValue('--mail-list-w')).toBe('380px');
    });

    it('clamps a drag that would collapse the rail or eat the reading pane', async () => {
      mount('/mail/a1/f-inbox');
      await screen.findByText('Roof detail');

      const rail = screen.getByTestId('mail-resize-rail');
      fireEvent.pointerDown(rail, { clientX: 200 });
      fireEvent.pointerMove(window, { clientX: -400 });
      expect(grid().style.getPropertyValue('--mail-rail-w')).toBe('160px');
      fireEvent.pointerMove(window, { clientX: 2000 });
      expect(grid().style.getPropertyValue('--mail-rail-w')).toBe('320px');
      fireEvent.pointerUp(window);
      expect(localStorage.getItem('mail.rail.w')).toBe('320');
    });

    it('nudges a pane from the keyboard, since the handle is a real separator', async () => {
      mount('/mail/a1/f-inbox');
      await screen.findByText('Roof detail');

      const handle = screen.getByTestId('mail-resize-list');
      expect(handle).toHaveAttribute('aria-valuenow', '320');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(grid().style.getPropertyValue('--mail-list-w')).toBe('336px');
      expect(localStorage.getItem('mail.list.w')).toBe('336');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(grid().style.getPropertyValue('--mail-list-w')).toBe('320px');
    });
  });

  describe('mobile stacking', () => {
    it('shows only the list pane until a thread is opened, then only the thread pane, and Back reverses it', async () => {
      const { container } = mount('/mail/a1/f-inbox');
      await screen.findByText('Roof detail');
      let [listSection, threadSection] = container.querySelectorAll('section');
      expect(listSection.className).not.toContain('hidden');
      expect(threadSection.className).toContain('hidden');

      fireEvent.click(screen.getByTestId('mail-thread-row'));
      await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox/tk-1'));
      [listSection, threadSection] = container.querySelectorAll('section');
      expect(listSection.className).toContain('hidden');
      expect(threadSection.className).not.toContain('hidden');

      fireEvent.click(screen.getByRole('button', { name: /Back/i }));
      await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox'));
      [listSection, threadSection] = container.querySelectorAll('section');
      expect(listSection.className).not.toContain('hidden');
      expect(threadSection.className).toContain('hidden');
    });
  });
});

describe('MailPage drafts (spec §9)', () => {
  const DRAFTS_FOLDER: MailFolder = { id: 'f-drafts', accountId: 'a1', providerId: 'Drafts', name: 'Drafts', role: 'drafts', unreadCount: 0, totalCount: 1, sortOrder: 2 };
  const OPENED: OpenedDraft = {
    messageId: 'm3', accountId: 'a1', draftId: 'Drafts/12', to: [{ addr: 'bob@acme.com' }], cc: [], bcc: [],
    subject: 'Re: Roof detail', html: '<p>Half done</p>',
    attachments: [{ uploadId: 'up-1', name: 'detail.pdf', size: 4 }],
    replyTo: { accountId: 'a1', threadKey: 'tk-1' },
  };
  const DRAFT_MESSAGES = [...MESSAGES, msg({ id: 'm3', isDraft: true, snippet: 'Half done', date: '2026-08-27T14:00:00.000Z' })];

  beforeEach(() => {
    h.folders.mockResolvedValue([...FOLDERS, DRAFTS_FOLDER]);
    h.thread.mockResolvedValue({ thread: THREAD, messages: DRAFT_MESSAGES, links: [] });
    h.openDraft.mockResolvedValue(OPENED);
  });

  it('opens a thread in the Drafts folder as its draft, in the composer', async () => {
    mount('/mail/a1/f-drafts');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByTestId('mail-thread-row'));
    await waitFor(() => expect(h.openDraft).toHaveBeenCalledWith('m3'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Edit draft')).toBeInTheDocument();
    await waitFor(() => expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Re: Roof detail'));
    expect((screen.getByTestId('composer-body') as HTMLTextAreaElement).value).toBe('<p>Half done</p>');
    expect(screen.getByText('detail.pdf')).toBeInTheDocument();
    // The composer opens over the list; nothing navigated to the reader.
    expect(loc()).toBe('/mail/a1/f-drafts');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(h.send).toHaveBeenCalled());
    const req = h.send.mock.calls[0][0] as SendRequest;
    expect(req.draftProviderId).toBe('Drafts/12');
    expect(req.replyTo).toEqual({ accountId: 'a1', threadKey: 'tk-1' });
    expect(req.attachments).toEqual([{ uploadId: 'up-1' }]);
  });

  it('outside Drafts, a thread row still opens the reader', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByTestId('mail-thread-row'));
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox/tk-1'));
    expect(h.openDraft).not.toHaveBeenCalled();
  });

  it('offers Edit draft on a draft inside a thread', async () => {
    mount('/mail/a1/f-inbox/tk-1');
    fireEvent.click(await screen.findByTestId('mail-edit-draft'));
    await waitFor(() => expect(h.openDraft).toHaveBeenCalledWith('m3'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('says so when a draft cannot be opened, and falls back to the reader', async () => {
    h.openDraft.mockRejectedValue(new Error('Mail provider request failed'));
    mount('/mail/a1/f-drafts');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByTestId('mail-thread-row'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Mail provider request failed', { type: 'error' }));
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-drafts/tk-1'));
  });
});
