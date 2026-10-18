// src/pages/project/rfi/PendingReplyBanner.test.tsx
//
// The banner is the review step between "an email came back on this RFI" and
// "this is the recorded response". Everything it shows — sender name, body
// text, attachment names — is a string an outsider typed into an email, so the
// rendering tests below are as much about the trust boundary as the layout.
//
// The store is NOT mocked here: these tests stub `fetch` and assert on the
// requests that actually go out. A hand-mocked store function can't tell you
// that the client mis-reads the server's 409 body — which is exactly the bug
// this file is now shaped to catch.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Rfi, RfiPendingReply } from '../../../utils/store';

const h = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  saveProps: { last: null as any },
}));

// Stand-in for the mail-side save modal: records the props it was handed, and
// lets a test report saved files with or without closing itself (a partial save
// keeps the real modal open on the failures).
vi.mock('../../mail/SaveAttachmentsModal', () => ({
  SaveAttachmentsModal: (props: any) => {
    h.saveProps.last = props;
    return props.open ? (
      <div data-testid="save-attachments">
        <button
          data-testid="save-all"
          onClick={() => { props.onSaved?.([{ fileId: 'file-77', name: 'ceiling-detail.pdf' }]); props.onClose(); }}
        >saved and closed</button>
        <button
          data-testid="save-partial"
          onClick={() => props.onSaved?.([{ fileId: 'file-77', name: 'ceiling-detail.pdf' }])}
        >saved, still open</button>
        <button data-testid="save-close" onClick={() => props.onClose()}>close</button>
      </div>
    ) : null;
  },
}));

import { ToastProvider } from '../../../components/Toast';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import { PendingReplyBanner } from './PendingReplyBanner';

// A minimal Response stand-in: the store reads status/ok/json, and
// fetchWithRetry touches `body` only to drain a retry (never on these POSTs).
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  body: null,
});

const postsTo = (url: string) => h.fetchMock.mock.calls.filter(c => c[0] === url);
const bodyOf = (call: any[]) => JSON.parse(call[1].body);

const pending = (over: Partial<RfiPendingReply> = {}): RfiPendingReply => ({
  threadKey: 'thr-1', accountId: 'acct-1', mailMessageId: 'msg-1', messageIdHeader: 'm1@tidewater.example',
  from: { addr: 'gc@tidewater.example', name: 'Mike Ruiz' },
  date: '2026-08-28T10:00:00.000Z',
  text: 'Corridor is 9\'-0" per the reflected ceiling plan.',
  attachments: [], receivedAt: '2026-08-28T10:00:05.000Z',
  ...over,
});

const rfi = (over: Partial<Rfi> = {}): Rfi => ({
  id: 'rfi-1', projectId: 'p1', number: 4, title: 'Header detail',
  question: 'Which detail governs?', specRef: null, drawingRef: null,
  attention: null, responseNeededBy: null, responseText: null, responseFileId: null,
  status: 'sent', version: 2, sentAt: 5, answeredAt: null,
  createdAt: 1, updatedAt: 10, photos: [], attachments: [], pendingReply: pending(),
  ...over,
});

const cb = { onUseAsResponse: vi.fn(), onDismissed: vi.fn(), onAccepted: vi.fn(), onOpenThread: vi.fn() };

const mount = (
  r: Rfi = rfi(),
  opts: { canOpenThread?: boolean; ownsMailbox?: boolean; draftText?: string | null } = {}
) =>
  render(
    <ToastProvider>
      <ConfirmProvider>
        <PendingReplyBanner
          rfi={r}
          projectId="p1"
          canOpenThread={opts.canOpenThread ?? true}
          ownsMailbox={opts.ownsMailbox ?? true}
          draftText={opts.draftText ?? null}
          onUseAsResponse={cb.onUseAsResponse}
          onDismissed={cb.onDismissed}
          onAccepted={cb.onAccepted}
          onOpenThread={cb.onOpenThread}
        />
      </ConfirmProvider>
    </ToastProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.saveProps.last = null;
  h.fetchMock.mockResolvedValue(res(200, { success: true, status: 'answered' }));
  vi.stubGlobal('fetch', h.fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('PendingReplyBanner', () => {
  it('renders the sender, the date and the reply text', () => {
    mount();
    expect(screen.getByTestId('rfi-pending-reply')).toBeInTheDocument();
    expect(screen.getByText(/Mike Ruiz/)).toBeInTheDocument();
    expect(screen.getByTestId('rfi-pending-reply-text')).toHaveTextContent(
      'Corridor is 9\'-0" per the reflected ceiling plan.'
    );
  });

  it('falls back to the address when the sender has no display name', () => {
    mount(rfi({ pendingReply: pending({ from: { addr: 'gc@tidewater.example' } }) }));
    expect(screen.getByText(/gc@tidewater.example/)).toBeInTheDocument();
  });

  // The RFI's status is the authority on whether an answer is still awaited: a
  // pendingReply row can outlive an out-of-band status change (someone closed
  // the RFI by hand), and reviewing a reply on a closed RFI is nonsense.
  it('renders nothing unless the RFI is still awaiting a reply', () => {
    mount(rfi({ status: 'closed' }));
    expect(screen.queryByTestId('rfi-pending-reply')).toBeNull();
  });

  it('renders nothing when there is no pending reply', () => {
    mount(rfi({ pendingReply: null }));
    expect(screen.queryByTestId('rfi-pending-reply')).toBeNull();
  });

  // Trust boundary: sender name, body and attachment names are attacker-chosen
  // strings from an inbound email. They must reach the DOM as text — never as
  // markup — so the literal characters survive and no element is created.
  it('renders hostile sender/body/attachment strings as text, not markup', () => {
    const evil = '<img src=x onerror="alert(1)">';
    mount(rfi({
      pendingReply: pending({
        from: { addr: 'gc@tidewater.example', name: evil },
        text: `answer ${evil}`,
        attachments: [{ attId: 'a1', name: `${evil}.pdf`, mime: 'application/pdf', size: 10 }],
      }),
    }));
    const banner = screen.getByTestId('rfi-pending-reply');
    expect(banner.textContent).toContain(evil);            // the literal characters survived
    expect(banner.querySelector('img')).toBeNull();         // and made no element
    expect(banner.innerHTML).toContain('&lt;img src=x');    // escaped, not markup
  });

  it('collapses a long reply behind Show more', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    mount(rfi({ pendingReply: pending({ text: long }) }));
    const body = screen.getByTestId('rfi-pending-reply-text');
    expect(body.className).toContain('line-clamp-6');

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByTestId('rfi-pending-reply-text').className).not.toContain('line-clamp-6');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('offers no Show more for a short reply', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('Use as response hands the reply text back to the editor', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Use as response' }));
    expect(cb.onUseAsResponse).toHaveBeenCalledWith('Corridor is 9\'-0" per the reflected ceiling plan.');
    // Nothing is written from here — the editor's own Save is the commit point.
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('Dismiss posts to the dismiss route and tells the editor to refresh', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(postsTo('/api/rfis/rfi-1/pending-reply/dismiss')).toHaveLength(1));
    await waitFor(() => expect(cb.onDismissed).toHaveBeenCalled());
  });

  // The real server's 409 body is the thing under test: someone else accepted
  // or dismissed the same reply first, and the client must read that as "gone"
  // — including when the body carries no `code` at all.
  it('treats a bare 409 from the server as "already handled" and refreshes', async () => {
    h.fetchMock.mockResolvedValue(res(409, { error: 'No pending reply to dismiss' }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByText('That reply was already handled')).toBeInTheDocument();
    await waitFor(() => expect(cb.onDismissed).toHaveBeenCalled());
  });

  it('reads the coded 409 the same way', async () => {
    h.fetchMock.mockResolvedValue(res(409, { error: 'No pending reply to dismiss', code: 'no_pending_reply' }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(cb.onDismissed).toHaveBeenCalled());
  });

  // A dropped request is not the same thing: the reply is still pending, so the
  // banner has to stay put and say the dismiss failed.
  it('keeps the banner when the dismiss request itself fails', async () => {
    h.fetchMock.mockRejectedValue(new Error('network down'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Failed to dismiss the reply')).toBeInTheDocument();
    expect(cb.onDismissed).not.toHaveBeenCalled();
    expect(screen.getByTestId('rfi-pending-reply')).toBeInTheDocument();
  });

  it('opens the thread when the current user owns the mailbox', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(cb.onOpenThread).toHaveBeenCalled();
  });

  // The reply landed in the mailbox of whoever sent the RFI. For anyone else
  // the mail routes answer 403/404, so the button must not be armed — and the
  // banner has to say why instead of just going quiet.
  it('degrades to a muted note when the mailbox belongs to another user', () => {
    mount(rfi(), { canOpenThread: false });
    expect(screen.getByRole('button', { name: 'Open thread' })).toBeDisabled();
    expect(screen.getByTestId('rfi-pending-reply-foreign')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(cb.onOpenThread).not.toHaveBeenCalled();
  });

  describe('attachments', () => {
    const withAtt = () => rfi({
      pendingReply: pending({
        attachments: [{ attId: 'a1', name: 'ceiling-detail.pdf', mime: 'application/pdf', size: 2048 }],
      }),
    });

    it('lists attachment names and hands the message id to the save modal', () => {
      mount(withAtt());
      expect(screen.getByText('ceiling-detail.pdf')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      expect(h.saveProps.last).toMatchObject({
        open: true, messageId: 'msg-1', defaultProjectId: 'p1',
        attachments: [expect.objectContaining({ attId: 'a1', name: 'ceiling-detail.pdf' })],
      });
    });

    // ONE call records text and file: accept clears the pending row in the same
    // transaction. setRfiResponse would flip the RFI to answered and leave the
    // reply pending — an orphan that the (now hidden) banner could never clear.
    it('accepts text and file together, using the reply text by default', async () => {
      mount(withAtt());
      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      fireEvent.click(screen.getByTestId('save-all'));

      // The prompt names the file, and that name is attacker-chosen text —
      // matching it as text proves it stayed text.
      expect(await screen.findByText(/Use ceiling-detail\.pdf as the RFI response document/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Use it' }));

      await waitFor(() => expect(postsTo('/api/rfis/rfi-1/pending-reply/accept')).toHaveLength(1));
      expect(bodyOf(postsTo('/api/rfis/rfi-1/pending-reply/accept')[0])).toEqual({
        text: 'Corridor is 9\'-0" per the reflected ceiling plan.', fileId: 'file-77',
      });
      expect(postsTo('/api/rfis/rfi-1/response')).toHaveLength(0);
      await waitFor(() => expect(cb.onAccepted).toHaveBeenCalled());
    });

    // Ordering: Use as response first (the user edits the text), THEN save the
    // attachment. The edit must ride along on the accept, not be overwritten by
    // the reply's original text.
    it('carries the editor draft when Use as response came first', async () => {
      mount(withAtt(), { draftText: 'Corridor is 9 ft — confirmed on site.' });
      fireEvent.click(screen.getByRole('button', { name: 'Use as response' }));
      fireEvent.click(screen.getByTestId('save-all'));
      fireEvent.click(await screen.findByRole('button', { name: 'Use it' }));

      await waitFor(() => expect(postsTo('/api/rfis/rfi-1/pending-reply/accept')).toHaveLength(1));
      expect(bodyOf(postsTo('/api/rfis/rfi-1/pending-reply/accept')[0])).toEqual({
        text: 'Corridor is 9 ft — confirmed on site.', fileId: 'file-77',
      });
    });

    // Use as response opens the save modal itself when the reply has files, so
    // the answer and its attachment are filed in one motion.
    it('opens the save modal from Use as response when there are attachments', () => {
      mount(withAtt());
      fireEvent.click(screen.getByRole('button', { name: 'Use as response' }));
      expect(screen.getByTestId('save-attachments')).toBeInTheDocument();
    });

    // A partial save leaves the modal open on the files that failed. Asking
    // "use this one as the response?" over the top of that would interrupt a
    // retry the user is in the middle of.
    it('defers the response-document question until the save modal closes', async () => {
      mount(withAtt());
      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      fireEvent.click(screen.getByTestId('save-partial'));

      await waitFor(() => expect(h.saveProps.last.open).toBe(true));
      expect(screen.queryByText(/as the RFI response document/)).toBeNull();

      fireEvent.click(screen.getByTestId('save-close'));
      expect(await screen.findByText(/Use ceiling-detail\.pdf as the RFI response document/)).toBeInTheDocument();
    });

    it('leaves the response alone when the confirmation is declined', async () => {
      mount(withAtt());
      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      fireEvent.click(screen.getByTestId('save-all'));

      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(h.fetchMock).not.toHaveBeenCalled());
    });

    // The reply went away while the file was uploading. Accept has nothing left
    // to clear, so the plain response write is now the right call — the user
    // still gets the document they picked.
    // The save route reads the message out of pendingReply.accountId, so for
    // anyone who doesn't own that mailbox it 404s. Offering the button would
    // hand them a guaranteed failure; the muted note says why instead.
    it('offers no save button for a mailbox the viewer does not own', () => {
      mount(withAtt(), { ownsMailbox: false });
      // The attachment is still LISTED — knowing an answer came with a file
      // is useful even when you can't file it.
      expect(screen.getByText('ceiling-detail.pdf')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Save to Documents/i })).toBeNull();
      expect(screen.getByTestId('rfi-pending-reply-attachments-foreign')).toBeInTheDocument();
    });

    // ownsMailbox is NARROWER than canOpenThread: the thread may also sit in a
    // second mailbox of the viewer's (so the deep link works), but this
    // message id lives only in the receiving one.
    it('gates the save on the mailbox, not on the thread link', () => {
      mount(withAtt(), { canOpenThread: true, ownsMailbox: false });
      expect(screen.getByRole('button', { name: 'Open thread' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /Save to Documents/i })).toBeNull();
    });

    // Use as response opens the save modal for the owner (test above). For a
    // non-owner it must stay shut — the text-only accept still has to work,
    // and a modal whose every save 404s is a dead end.
    it('does not auto-open the save modal from Use as response for a non-owner', () => {
      mount(withAtt(), { ownsMailbox: false });
      fireEvent.click(screen.getByRole('button', { name: 'Use as response' }));
      expect(cb.onUseAsResponse).toHaveBeenCalledWith('Corridor is 9\'-0" per the reflected ceiling plan.');
      expect(screen.queryByTestId('save-attachments')).toBeNull();
      expect(h.saveProps.last?.open ?? false).toBe(false);
    });

    it('falls back to a plain response write when the reply vanished mid-flight', async () => {
      h.fetchMock.mockImplementation(async (url: string) =>
        url.includes('pending-reply/accept')
          ? res(409, { error: 'No pending reply to accept', code: 'no_pending_reply' })
          : res(200, { success: true }));
      mount(withAtt());
      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      fireEvent.click(screen.getByTestId('save-all'));
      fireEvent.click(await screen.findByRole('button', { name: 'Use it' }));

      await waitFor(() => expect(postsTo('/api/rfis/rfi-1/response')).toHaveLength(1));
      expect(bodyOf(postsTo('/api/rfis/rfi-1/response')[0])).toEqual({ fileId: 'file-77' });
      await waitFor(() => expect(cb.onAccepted).toHaveBeenCalled());
    });
  });
});
