// src/pages/mail/compose/MailComposer.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { MailAccount, MessageRow, SendRequest } from '../types';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  stageUpload: vi.fn(),
  recipients: vi.fn(),
  getAlwaysCc: vi.fn(),
  toast: vi.fn(),
  picked: [] as unknown[],
}));

vi.mock('../../../utils/mailApi', () => ({
  mailApi: {
    send: h.send, saveDraft: h.saveDraft, deleteDraft: h.deleteDraft,
    stageUpload: h.stageUpload, recipients: h.recipients,
  },
}));
vi.mock('../../../utils/store', () => ({ getAlwaysCc: h.getAlwaysCc }));
vi.mock('../../../components/Toast', () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock('../../../components/FilePickerModal', () => ({
  FilePickerModal: ({ open, onPick, onClose }: { open: boolean; onPick?: (r: unknown[]) => void; onClose: () => void }) =>
    open ? (
      <button data-testid="fake-pick" onClick={() => { onPick?.(h.picked); onClose(); }}>pick</button>
    ) : null,
}));
// The real editor is covered by RichTextEditor.test.tsx; here it is a plain
// textarea so body assertions are about the composer, not ProseMirror.
vi.mock('./RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="composer-body" value={value} onChange={e => onChange(e.target.value)} />
  ),
}));

import { MailComposer, agoLabel, itemTypeFromSource, type MailComposerProps } from './MailComposer';

const account = (over: Partial<MailAccount> = {}): MailAccount => ({
  id: 'a1', provider: 'imap', emailAddress: 'noah@birchwoodplaster.example', displayName: 'Noah',
  signatureHtml: null, isDefault: 1, status: 'ok', lastSyncAt: null, lastError: null,
  indexedSince: '2026-01-01T00:00:00.000Z', unreadCount: 0, ...over,
});

const ACCOUNTS: MailAccount[] = [
  account(),
  account({ id: 'a2', emailAddress: 'shop@birchwoodplaster.example', status: 'auth_error', lastError: 'Sign in again', isDefault: 0 }),
];

const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1', accountId: 'a1', threadKey: 'tk-1', messageIdHeader: null, inReplyTo: null, references: [],
  from: { addr: 'bob@acme.com', name: 'Bob Smith' }, to: [{ addr: 'noah@birchwoodplaster.example' }], cc: [],
  bcc: [], subject: 'Roof detail', snippet: '', date: '2026-08-27T16:00:00.000Z',
  isRead: true, isStarred: false, isDraft: false, hasAttachments: false, attachments: [],
  sizeBytes: 0, folderIds: [], sentFromApp: false, ...over,
});

// A provider body with the two things StarterKit would silently drop if the
// quote were ever parsed into the editor document.
const RICH_BODY =
  '<p>Original text</p><img src="https://cdn.example.com/logo.png">' +
  '<table><tr><td>Cell</td></tr></table>';

const setup = (over: Partial<MailComposerProps> = {}) => {
  const onClose = vi.fn();
  const props: MailComposerProps = {
    open: true, onClose, variant: 'modal', accounts: ACCOUNTS, defaultAccountId: 'a1', ...over,
  };
  const view = render(<MailComposer {...props} />);
  return { ...view, onClose, props };
};

const to = () => screen.getByLabelText('To') as HTMLInputElement;
const subject = () => screen.getByLabelText('Subject') as HTMLInputElement;
const body = () => screen.getByTestId('composer-body') as HTMLTextAreaElement;
const sendBtn = () => screen.getByRole('button', { name: 'Send' });
// Pill text only — the From <select> also renders our own address, so a bare
// getByText would match the option instead of a recipient.
const pills = () => screen.queryAllByTestId('recipient-pill').map(e => e.textContent ?? '').join(' | ');
const addTo = (addr: string) => {
  fireEvent.change(to(), { target: { value: addr } });
  fireEvent.keyDown(to(), { key: 'Enter' });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getAlwaysCc.mockResolvedValue('');
  h.recipients.mockResolvedValue([]);
  h.send.mockResolvedValue({ messageId: 'm9', threadKey: 'tk-9', accountId: 'a1', effectsSkipped: [] });
  h.saveDraft.mockResolvedValue({ draftId: 'd1' });
  h.stageUpload.mockResolvedValue({ uploadId: 'u1' });
  h.picked = [];
});

describe('itemTypeFromSource', () => {
  it('maps the sourceType strings the document editors actually write', () => {
    expect(itemTypeFromSource('proposal')).toBe('proposal');
    expect(itemTypeFromSource('invoice')).toBe('invoice');
    expect(itemTypeFromSource('change-order')).toBe('changeOrder');
    expect(itemTypeFromSource('changeOrder')).toBe('changeOrder');
    expect(itemTypeFromSource('issue')).toBe('issue');
    expect(itemTypeFromSource('rfi')).toBe('rfi');
    expect(itemTypeFromSource('dailyReport')).toBe('dailyReport');
    expect(itemTypeFromSource('daily-report')).toBe('dailyReport');
    expect(itemTypeFromSource('payapp')).toBe('payApp');
    expect(itemTypeFromSource('aiaPayApp')).toBe('payApp');
    expect(itemTypeFromSource('punch')).toBe('punch');
    expect(itemTypeFromSource('task')).toBe('task');
    expect(itemTypeFromSource('mystery')).toBeUndefined();
    expect(itemTypeFromSource(undefined)).toBeUndefined();
  });
});

describe('MailComposer', () => {
  it('prefills Cc from the always-CC preference and reveals the Cc row', async () => {
    h.getAlwaysCc.mockResolvedValue('office@birchwoodplaster.example, boss@birchwoodplaster.example');
    setup();
    await waitFor(() => expect(screen.getByLabelText('Cc')).toBeInTheDocument());
    await waitFor(() => expect(pills()).toContain('office@birchwoodplaster.example'));
    expect(pills()).toContain('boss@birchwoodplaster.example');
  });

  it('hides Cc/Bcc behind a toggle when nothing is prefilled', async () => {
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    expect(screen.queryByLabelText('Cc')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cc Bcc' }));
    expect(screen.getByLabelText('Cc')).toBeInTheDocument();
    expect(screen.getByLabelText('Bcc')).toBeInTheDocument();
  });

  it('keeps Send disabled until there is at least one valid recipient', async () => {
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    expect(sendBtn()).toBeDisabled();
    addTo('client@acme.com');
    expect(sendBtn()).toBeEnabled();
  });

  it('builds the send request and reports success', async () => {
    const onSent = vi.fn();
    const { onClose } = setup({ onSent });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    addTo('client@acme.com');
    fireEvent.change(subject(), { target: { value: 'Roof detail' } });
    fireEvent.change(body(), { target: { value: '<p>Here it is</p>' } });
    await act(async () => { fireEvent.click(sendBtn()); });

    expect(h.send).toHaveBeenCalledTimes(1);
    const req = h.send.mock.calls[0][0] as SendRequest;
    expect(req).toMatchObject({
      accountId: 'a1',
      to: [{ addr: 'client@acme.com' }],
      subject: 'Roof detail',
      html: '<p>Here it is</p>',
      attachments: [],
    });
    expect(req.cc).toBeUndefined();
    expect(req.replyTo).toBeUndefined();
    expect(h.toast).toHaveBeenCalledWith('Sent', { type: 'success' });
    expect(onSent).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('routes the send through onSend when the caller supplies one', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    setup({ onSend });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('warns about effects the server could not apply', async () => {
    h.send.mockResolvedValue({ messageId: 'm9', threadKey: 'tk-9', accountId: 'a1', effectsSkipped: ['proposal', 'invoice'] });
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    expect(h.toast).toHaveBeenCalledWith('Sent — status not updated for: Proposal, Invoice', { type: 'warning' });
  });

  it('keeps the composer open and toasts the server message when the send fails', async () => {
    h.send.mockRejectedValue(new Error('SMTP refused the message'));
    const { onClose } = setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    expect(h.toast).toHaveBeenCalledWith('SMTP refused the message', { type: 'error' });
    expect(onClose).not.toHaveBeenCalled();
    expect(sendBtn()).toBeEnabled();
  });

  it('prefills a reply with the sender, Re: subject and the quoted body', async () => {
    setup({
      mode: 'reply',
      replyTo: { accountId: 'a1', threadKey: 'tk-1', message: msg(), bodyHtml: '<p>Original text</p>' },
    });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    expect(pills()).toContain('bob@acme.com');
    expect(subject().value).toBe('Re: Roof detail');
    // The quote is kept out of the editor document — it rides alongside it.
    expect(body().value).not.toContain('wrote:');
    expect(body().value).not.toContain('Original text');
    expect(screen.getByTestId('composer-quote')).toBeInTheDocument();

    await act(async () => { fireEvent.click(sendBtn()); });
    const req = h.send.mock.calls[0][0] as SendRequest;
    expect(req.replyTo).toEqual({ accountId: 'a1', threadKey: 'tk-1' });
    expect(req.html).toContain('wrote:');
    expect(req.html).toContain('<p>Original text</p>');
  });

  it('transmits the quoted markup verbatim after the user edits the body', async () => {
    setup({
      mode: 'reply',
      replyTo: { accountId: 'a1', threadKey: 'tk-1', message: msg(), bodyHtml: RICH_BODY },
    });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    fireEvent.change(body(), { target: { value: '<p>Sure thing</p>' } });
    await act(async () => { fireEvent.click(sendBtn()); });

    const { html } = h.send.mock.calls[0][0] as SendRequest;
    expect(html).toContain('<p>Sure thing</p>');
    expect(html).toContain('<img src="https://cdn.example.com/logo.png">');
    expect(html).toContain('<table><tr><td>Cell</td></tr></table>');
    // The reply reads above the thing it is replying to.
    expect(html.indexOf('Sure thing')).toBeLessThan(html.indexOf('ft-quote'));
  });

  it('sends without the quote once it is removed', async () => {
    setup({
      mode: 'reply',
      replyTo: { accountId: 'a1', threadKey: 'tk-1', message: msg(), bodyHtml: RICH_BODY },
    });
    await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Remove quoted message'));
    expect(screen.queryByTestId('composer-quote')).toBeNull();

    await act(async () => { fireEvent.click(sendBtn()); });
    const { html } = h.send.mock.calls[0][0] as SendRequest;
    expect(html).not.toContain('ft-quote');
    expect(html).not.toContain('Original text');
  });

  it('shows the quoted message on demand in a sandboxed frame', async () => {
    setup({
      mode: 'reply',
      replyTo: { accountId: 'a1', threadKey: 'tk-1', message: msg(), bodyHtml: RICH_BODY },
    });
    await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show quoted message' }));

    const frame = screen.getByTestId('quote-preview') as HTMLIFrameElement;
    expect(frame.getAttribute('srcdoc')).toContain('<img src="https://cdn.example.com/logo.png">');
    // No allow-scripts and no allow-same-origin: the preview cannot run the
    // sender's JS or reach the app's DOM.
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');

    fireEvent.click(screen.getByRole('button', { name: 'Hide quoted message' }));
    expect(screen.queryByTestId('quote-preview')).toBeNull();
  });

  it('prefills reply-all with everyone but our own mailboxes', async () => {
    setup({
      mode: 'replyAll',
      replyTo: {
        accountId: 'a1', threadKey: 'tk-1', bodyHtml: '<p>x</p>',
        message: msg({
          to: [{ addr: 'noah@birchwoodplaster.example' }, { addr: 'carol@acme.com' }],
          cc: [{ addr: 'dave@acme.com' }],
        }),
      },
    });
    await waitFor(() => expect(pills()).toContain('carol@acme.com'));
    expect(pills()).toContain('bob@acme.com');
    expect(pills()).not.toContain('noah@birchwoodplaster.example');
    expect(pills()).toContain('dave@acme.com');
  });

  it('prefills a forward with an empty To, Fwd: subject and the forwarded block', async () => {
    setup({
      mode: 'forward',
      replyTo: { accountId: 'a1', threadKey: 'tk-1', message: msg(), bodyHtml: '<p>Original text</p>' },
    });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    expect(subject().value).toBe('Fwd: Roof detail');
    expect(body().value).not.toContain('Forwarded message');
    expect(screen.getByTestId('composer-quote')).toBeInTheDocument();
    expect(sendBtn()).toBeDisabled();
  });

  it('appends the account signature under a -- separator', async () => {
    setup({ accounts: [account({ signatureHtml: '<p>Noah — Birchwood Plaster</p>' })] });
    await waitFor(() => expect(body().value).toContain('Birchwood Plaster'));
    expect(body().value).toContain('<br><br>--<br>');
    expect(body().value.indexOf('--<br>')).toBeLessThan(body().value.indexOf('Birchwood'));
  });

  it('defaults to replying inside the existing thread', async () => {
    setup({ existingThread: { accountId: 'a1', threadKey: 'tk-7', subject: 'Invoice 12' } });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    expect(screen.getByLabelText(/Reply in existing thread/)).toBeChecked();
    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    expect((h.send.mock.calls[0][0] as SendRequest).replyTo).toEqual({ accountId: 'a1', threadKey: 'tk-7' });
  });

  it('drops replyTo when the user picks a new thread instead', async () => {
    setup({ existingThread: { accountId: 'a1', threadKey: 'tk-7', subject: 'Invoice 12' } });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('New thread'));
    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    expect((h.send.mock.calls[0][0] as SendRequest).replyTo).toBeUndefined();
  });

  it('will not double-send while a send is in flight', async () => {
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    // The parent closes the composer on success; until it does, Send stays out
    // of reach so a second click cannot post the message twice.
    expect(sendBtn()).toBeDisabled();
    fireEvent.click(sendBtn());
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('shows a locked primary attachment with its item label', async () => {
    setup({ primaryAttachment: { name: 'Invoice 12.pdf', itemType: 'invoice', itemId: 'i12' } });
    await waitFor(() => expect(screen.getByText('Invoice 12.pdf')).toBeInTheDocument());
    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Invoice 12.pdf')).toBeNull();
    // No freshness claim: the sender's document is regenerated during the send
    // whenever it is behind the record, so there is nothing to warn about.
    expect(screen.queryByText(/out of date/i)).toBeNull();
  });

  it('adds a tagged chip for a document picked from Documents', async () => {
    h.picked = [{
      id: 'f1', name: 'Proposal 3.pdf', mime: 'application/pdf', size: 1234, kind: 'proposal',
      createdAt: 1, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Job',
      customerId: null, customerName: null, source: { type: 'proposal', id: 'pr9', label: 'Proposal 3', href: null },
    }];
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /From Documents/ }));
    await act(async () => { fireEvent.click(screen.getByTestId('fake-pick')); });

    expect(screen.getByText('Proposal 3.pdf')).toBeInTheDocument();
    expect(screen.getByText('Proposal')).toBeInTheDocument();

    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    expect((h.send.mock.calls[0][0] as SendRequest).attachments).toEqual([
      { fileId: 'f1', name: 'Proposal 3.pdf', itemType: 'proposal', itemId: 'pr9' },
    ]);
  });

  it('removes a picked attachment from its chip', async () => {
    h.picked = [{
      id: 'f1', name: 'Photo.jpg', mime: 'image/jpeg', size: 10, kind: 'photo', createdAt: 1,
      versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null,
      customerName: null, source: null,
    }];
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /From Documents/ }));
    await act(async () => { fireEvent.click(screen.getByTestId('fake-pick')); });
    expect(screen.getByText('Photo.jpg')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove Photo.jpg'));
    expect(screen.queryByText('Photo.jpg')).toBeNull();
  });

  it('stages a device upload and sends it by uploadId', async () => {
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    const file = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());

    addTo('client@acme.com');
    await act(async () => { fireEvent.click(sendBtn()); });
    expect(h.stageUpload).toHaveBeenCalledWith(file);
    expect((h.send.mock.calls[0][0] as SendRequest).attachments).toEqual([{ uploadId: 'u1' }]);
  });

  it('lists unusable accounts in the From select but disables them', async () => {
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    const from = screen.getByLabelText('From') as HTMLSelectElement;
    const broken = Array.from(from.options).find(o => o.value === 'a2')!;
    expect(broken.disabled).toBe(true);
    expect(broken.textContent).toContain('Sign in again');
  });

  it('renders the inline variant as a card that can escalate to the modal', async () => {
    const onOpenInModal = vi.fn();
    setup({ variant: 'inline', onOpenInModal });
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    expect(screen.queryByTestId('modal-overlay')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open in composer/ }));
    expect(onOpenInModal).toHaveBeenCalled();
  });

  it('renders an extraHeader supplied by the caller', async () => {
    setup({ extraHeader: <div data-testid="extra">Document shows email</div> });
    await waitFor(() => expect(screen.getByTestId('extra')).toBeInTheDocument());
  });

  it('does not autosave the state it opened with', async () => {
    h.getAlwaysCc.mockResolvedValue('office@birchwoodplaster.example');
    vi.useFakeTimers();
    try {
      setup({ mode: 'reply', replyTo: { accountId: 'a1', threadKey: 'tk-1', message: msg(), bodyHtml: '<p>x</p>' } });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect(h.saveDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autosaves the draft once the user edits it', async () => {
    vi.useFakeTimers();
    try {
      setup();
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      fireEvent.change(subject(), { target: { value: 'Roof detail' } });
      await act(async () => { vi.advanceTimersByTime(3000); });
      await act(async () => { await Promise.resolve(); });
      expect(h.saveDraft).toHaveBeenCalledTimes(1);
      expect(h.saveDraft.mock.calls[0][0]).toMatchObject({ accountId: 'a1', subject: 'Roof detail' });
      expect(screen.getByTestId('draft-status').textContent).toMatch(/Draft saved/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the draft id to the send so the server clears it atomically', async () => {
    vi.useFakeTimers();
    try {
      setup();
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });

      fireEvent.change(subject(), { target: { value: 'Roof detail' } });
      await act(async () => { vi.advanceTimersByTime(3000); });
      await act(async () => { await Promise.resolve(); });
      expect(h.saveDraft).toHaveBeenCalledTimes(1);

      addTo('client@acme.com');
      await act(async () => { fireEvent.click(sendBtn()); });

      expect((h.send.mock.calls[0][0] as SendRequest).draftProviderId).toBe('d1');
      // The send route drops the draft; a separate DELETE would be a second
      // round trip that can fail on its own and strand a ghost draft.
      expect(h.deleteDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks autosave while sending so a pending timer cannot recreate the draft', async () => {
    vi.useFakeTimers();
    try {
      setup();
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });

      fireEvent.change(subject(), { target: { value: 'Roof detail' } });
      await act(async () => { vi.advanceTimersByTime(2000); });   // debounce still pending
      addTo('client@acme.com');
      await act(async () => { fireEvent.click(sendBtn()); });

      await act(async () => { vi.advanceTimersByTime(10000); });
      await act(async () => { await Promise.resolve(); });
      expect(h.saveDraft).not.toHaveBeenCalled();
      expect((h.send.mock.calls[0][0] as SendRequest).draftProviderId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts and commits an address still sitting uncommitted in the To input', async () => {
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());

    // Typed, but never confirmed with Enter/comma — the user just hits Send.
    fireEvent.change(to(), { target: { value: 'client@acme.com' } });
    expect(sendBtn()).toBeEnabled();

    await act(async () => { fireEvent.click(sendBtn()); });
    expect((h.send.mock.calls[0][0] as SendRequest).to).toEqual([{ addr: 'client@acme.com' }]);
  });

  it('leaves Send disabled for To text that is not an address', async () => {
    setup();
    await waitFor(() => expect(h.getAlwaysCc).toHaveBeenCalled());
    fireEvent.change(to(), { target: { value: 'not an address' } });
    expect(sendBtn()).toBeDisabled();
  });

  it('does not autosave drafts for item sends', async () => {
    vi.useFakeTimers();
    try {
      const onSend = vi.fn().mockResolvedValue(undefined);
      setup({ onSend, primaryAttachment: { name: 'Invoice 12.pdf' } });
      await act(async () => { await Promise.resolve(); });
      fireEvent.change(subject(), { target: { value: 'Anything' } });
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect(h.saveDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // T18 left this untested: attachments are part of the draft snapshot, so
  // adding or removing one is an edit like any other and is autosaved.
  it('autosaves when an attachment is added, and again when it is removed', async () => {
    vi.useFakeTimers();
    try {
      setup();
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      // A subject keeps the post-removal state apart from the empty one the
      // composer opened with (which, by design, is never saved).
      fireEvent.change(subject(), { target: { value: 'Takeoff notes' } });

      const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
      const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
      await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('notes.txt')).toBeInTheDocument();

      await act(async () => { vi.advanceTimersByTime(3000); });
      await act(async () => { await Promise.resolve(); });
      expect(h.saveDraft).toHaveBeenCalledTimes(1);
      expect(h.saveDraft.mock.calls[0][0]).toMatchObject({ accountId: 'a1', attachments: [{ uploadId: 'u1' }] });

      fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
      await act(async () => { vi.advanceTimersByTime(3000); });
      await act(async () => { await Promise.resolve(); });
      expect(h.saveDraft).toHaveBeenCalledTimes(2);
      expect(h.saveDraft.mock.calls[1][0]).toMatchObject({ attachments: [] });
      expect(h.saveDraft.mock.calls[1][1]).toBe('d1');   // the same draft, updated in place
    } finally {
      vi.useRealTimers();
    }
  });

  describe('resuming a draft', () => {
    const resume = (over: Partial<MailComposerProps> = {}) => setup({
      mode: 'new',
      defaultAccountId: 'a1',
      accounts: [account({ signatureHtml: '<b>Noah</b>' }), ACCOUNTS[1]],
      initial: {
        to: [{ addr: 'bob@acme.com' }], cc: [{ addr: 'pm@acme.com' }], subject: 'Re: Roof detail',
        html: '<p>My half-written reply</p><br><br><div class="ft-quote" style="color:#555">Bob wrote:<br><p>Original</p></div>',
        attachments: [{ kind: 'upload', uploadId: 'up-1', name: 'takeoff.pdf', size: 4 }],
      },
      resumeDraft: { accountId: 'a1', draftId: 'prov-d7', replyTo: { accountId: 'a1', threadKey: 'tk-1' } },
      ...over,
    });

    it('opens with the draft\'s content and attachments, no signature, no always-Cc, quote beside the editor', async () => {
      h.getAlwaysCc.mockResolvedValue('office@birchwoodplaster.example');
      resume();
      await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());
      expect(body().value).toBe('<p>My half-written reply</p>');
      expect(subject().value).toBe('Re: Roof detail');
      expect(pills()).toContain('bob@acme.com');
      expect(pills()).toContain('pm@acme.com');
      expect(pills()).not.toContain('office@birchwoodplaster.example');
      expect(h.getAlwaysCc).not.toHaveBeenCalled();
      expect(screen.getByText('takeoff.pdf')).toBeInTheDocument();
      expect(screen.getByText('Edit draft')).toBeInTheDocument();
    });

    it('does not save on open, then updates the same provider draft with its thread and attachments', async () => {
      vi.useFakeTimers();
      try {
        h.saveDraft.mockResolvedValue({ draftId: 'prov-d7' });
        resume();
        await act(async () => { await Promise.resolve(); });
        await act(async () => { vi.advanceTimersByTime(10000); });
        expect(h.saveDraft).not.toHaveBeenCalled();

        fireEvent.change(body(), { target: { value: '<p>My finished reply</p>' } });
        await act(async () => { vi.advanceTimersByTime(3000); });
        await act(async () => { await Promise.resolve(); });
        expect(h.saveDraft).toHaveBeenCalledTimes(1);
        const [saved, id] = h.saveDraft.mock.calls[0];
        expect(id).toBe('prov-d7');
        expect(saved).toMatchObject({
          accountId: 'a1', subject: 'Re: Roof detail',
          attachments: [{ uploadId: 'up-1' }],
          replyTo: { accountId: 'a1', threadKey: 'tk-1' },
        });
        // The quote is saved back exactly as it was.
        expect(saved.html).toBe('<p>My finished reply</p><br><br><div class="ft-quote" style="color:#555">Bob wrote:<br><p>Original</p></div>');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a follow-up save adopts the id the provider hands back (IMAP re-keys every save)', async () => {
      vi.useFakeTimers();
      try {
        h.saveDraft.mockResolvedValueOnce({ draftId: 'Drafts/41' }).mockResolvedValueOnce({ draftId: 'Drafts/42' });
        resume();
        await act(async () => { await Promise.resolve(); });
        fireEvent.change(subject(), { target: { value: 'Re: Roof detail v2' } });
        await act(async () => { vi.advanceTimersByTime(3000); });
        await act(async () => { await Promise.resolve(); });
        fireEvent.change(subject(), { target: { value: 'Re: Roof detail v3' } });
        await act(async () => { vi.advanceTimersByTime(3000); });
        await act(async () => { await Promise.resolve(); });
        expect(h.saveDraft.mock.calls.map(c => c[1])).toEqual(['prov-d7', 'Drafts/41']);
        await act(async () => { fireEvent.click(sendBtn()); });
        expect((h.send.mock.calls[0][0] as SendRequest).draftProviderId).toBe('Drafts/42');
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends as a reply in its thread and hands over the draft id so the draft is removed', async () => {
      resume();
      await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());
      await act(async () => { fireEvent.click(sendBtn()); });
      const req = h.send.mock.calls[0][0] as SendRequest;
      expect(req.draftProviderId).toBe('prov-d7');
      expect(req.replyTo).toEqual({ accountId: 'a1', threadKey: 'tk-1' });
      expect(req.attachments).toEqual([{ uploadId: 'up-1' }]);
      expect(req.html).toContain('class="ft-quote"');
      expect(h.deleteDraft).not.toHaveBeenCalled();
    });

    it('discard deletes the reopened draft', async () => {
      resume();
      await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })); });
      expect(h.deleteDraft).toHaveBeenCalledWith('a1', 'prov-d7');
    });
  });

  it('renders nothing while closed', () => {
    setup({ open: false });
    expect(screen.queryByLabelText('To')).toBeNull();
  });
});

describe('agoLabel', () => {
  it('reads as a relative age', () => {
    const now = new Date('2026-08-29T12:00:00.000Z');
    const back = (secs: number) => new Date(now.getTime() - secs * 1000);
    expect(agoLabel(back(1), now)).toBe('just now');
    expect(agoLabel(back(12), now)).toBe('12s ago');
    expect(agoLabel(back(180), now)).toBe('3m ago');
    expect(agoLabel(back(7200), now)).toBe('2h ago');
  });
});

describe('MailComposer lifecycle', () => {
  it('survives being closed after it was open (no conditional hooks)', async () => {
    const onClose = vi.fn();
    const base: MailComposerProps = {
      open: true, onClose, variant: 'modal', accounts: ACCOUNTS, defaultAccountId: 'a1',
      mode: 'reply',
      replyTo: { accountId: 'a1', threadKey: 'tk-1', message: msg(), bodyHtml: '<p>Original text</p>' },
    };
    const { rerender } = render(<MailComposer {...base} />);
    await waitFor(() => expect(screen.getByTestId('composer-quote')).toBeInTheDocument());

    // Every hook must run on both renders; a hook after the `open` early
    // return would blow up here rather than in production.
    rerender(<MailComposer {...base} open={false} />);
    expect(screen.queryByLabelText('To')).toBeNull();

    rerender(<MailComposer {...base} open />);
    await waitFor(() => expect(screen.getByLabelText('To')).toBeInTheDocument());
  });
});
