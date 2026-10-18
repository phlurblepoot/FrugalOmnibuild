// src/pages/mail/MessageBodyFrame.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { BodyPayload } from './types';

const h = vi.hoisted(() => ({ body: vi.fn(), trustImageSender: vi.fn(), untrustImageSender: vi.fn(), getMailToken: vi.fn(() => 'tok en/123') }));
vi.mock('../../utils/mailApi', () => ({ mailApi: h, getMailToken: h.getMailToken }));

import { MessageBodyFrame, buildFrameDoc } from './MessageBodyFrame';

const payload = (over: Partial<BodyPayload> = {}): BodyPayload => ({
  html: '<p>Hello from the roof</p>',
  text: 'Hello from the roof',
  blockedRemoteImages: 0,
  attachments: [],
  ...over,
});

const frame = () => screen.getByTestId('mail-body-frame') as HTMLIFrameElement;

const post = (data: unknown, source: MessageEventSource | null) =>
  fireEvent(window, new MessageEvent('message', { data, source }));

// jsdom replaces an iframe's contentWindow when its srcdoc finishes loading,
// so a single dispatch races that swap and the (correct, strict) source check
// in the component drops it. Retrying with a freshly read contentWindow is
// what makes the assertion deterministic.
const postHeight = (height: number, expected: string) =>
  waitFor(() => {
    post({ type: 'mail-frame-height', height }, frame().contentWindow);
    expect(frame().style.height).toBe(expected);
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.body.mockResolvedValue(payload());
});

describe('MessageBodyFrame', () => {
  it('renders the sanitized html inside a sandboxed iframe with a locked-down CSP', async () => {
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(frame()).toBeInTheDocument());

    const el = frame();
    expect(el).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(el).toHaveAttribute('title', 'Message');

    const doc = el.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('<p>Hello from the roof</p>');
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("style-src 'unsafe-inline'");
    expect(doc).toContain('<base target="_blank">');
    // Only our own height-reporting script may run: a nonce, never 'unsafe-inline'.
    expect(doc).toMatch(/script-src 'nonce-[0-9a-f-]{36}'/);
    expect(doc).not.toContain("script-src 'unsafe-inline'");
    expect(doc).toContain(`img-src ${window.location.origin} data:`);
  });

  // The quote toggle has to live inside the frame: the app cannot reach into a
  // sandboxed, opaque-origin document, so the only handler that can unfold the
  // server-collapsed history is the one nonce'd script. jsdom does not run an
  // iframe srcdoc, so this asserts the wiring is in the document it builds.
  it('ships the quoted-history toggle inside the same nonce\'d script', () => {
    const doc = buildFrameDoc('<p>hi</p>', 'nonce-1', 'https://app.test');
    expect(doc).toContain('[data-mail-quote-toggle]');
    expect(doc).toContain("q.hasAttribute('data-mail-quote')");
    expect(doc).toContain("q.removeAttribute('hidden')");
    expect(doc).toContain("q.setAttribute('hidden', '')");
    // The toggle reports its own state, not just a swapped label.
    expect(doc).toContain("t.setAttribute('aria-expanded'");
    // Re-measured after the fold opens, or the frame keeps its old height.
    expect(doc).toMatch(/aria-label[\s\S]*?report\(\);/);
    // Still exactly one script, still nonce'd.
    expect(doc.match(/<script/g)).toHaveLength(1);
    expect(doc).toContain('<script nonce="nonce-1">');
  });

  // Regression: collapsing the quote used to leave the frame tall, because
  // document.documentElement/body.scrollHeight can never report less than
  // the frame's current viewport (which the parent had already grown to fit
  // the expanded quote). Measuring a wrapper's own rect fixes that — the
  // wrapper shrinks when the quoted block goes `hidden`, independent of
  // whatever height the iframe element currently has.
  it('measures a viewport-independent wrapper instead of document scrollHeight', () => {
    const doc = buildFrameDoc('<p>hi</p>', 'nonce-1', 'https://app.test');
    // html/body must not be stretched to fill the (possibly tall) iframe
    // viewport, or the wrapper's rect would be inflated by it too.
    expect(doc).toContain('html,body{margin:0;height:auto!important}');
    // ...and the wrapper contains its floats: a float-only body (newsletters,
    // some signatures) has no in-flow content, so without a block formatting
    // context the wrapper's rect is 0 and the message renders as a sliver.
    expect(doc).toContain('#__mail_root{display:flow-root}');
    // Body content is wrapped so it can be measured independent of body/html.
    expect(doc).toContain('<div id="__mail_root"><p>hi</p></div>');
    // The report() function reads the wrapper's own bounding rect...
    expect(doc).toContain("document.getElementById('__mail_root')");
    expect(doc).toContain('root.getBoundingClientRect().height');
    // ...and no longer falls back to scrollHeight in the normal (root found) path.
    expect(doc).toMatch(/var h = root\s*\?\s*Math\.ceil\(root\.getBoundingClientRect\(\)\.height\)/);
  });

  it('shows a skeleton while the body is loading', async () => {
    let resolve: (p: BodyPayload) => void = () => {};
    h.body.mockReturnValue(new Promise<BodyPayload>(r => { resolve = r; }));
    render(<MessageBodyFrame messageId="m1" />);

    expect(screen.getByTestId('mail-body-loading')).toBeInTheDocument();
    resolve(payload());
    await waitFor(() => expect(frame()).toBeInTheDocument());
  });

  it('offers to load blocked remote images and refetches with images enabled', async () => {
    h.body.mockResolvedValueOnce(payload({ blockedRemoteImages: 3 }));
    h.body.mockResolvedValueOnce(payload({ html: '<img src="https://x.test/a.png">', blockedRemoteImages: 0 }));
    render(<MessageBodyFrame messageId="m1" />);

    await waitFor(() => expect(screen.getByText(/Remote images blocked/i)).toBeInTheDocument());
    expect(h.body).toHaveBeenCalledWith('m1', { images: false });

    fireEvent.click(screen.getByRole('button', { name: /Load images/i }));
    await waitFor(() => expect(h.body).toHaveBeenCalledWith('m1', { images: true }));
    await waitFor(() => expect(screen.queryByText(/Remote images blocked/i)).toBeNull());
  });

  it('hides the blocked-images bar when nothing was blocked', async () => {
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(frame()).toBeInTheDocument());
    expect(screen.queryByText(/Remote images blocked/i)).toBeNull();
  });

  it('grows the frame when it reports its height, and caps runaway values', async () => {
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(frame()).toBeInTheDocument());

    await postHeight(500, '500px');
    await postHeight(99999, '20000px');
  });

  it('ignores height messages from any other window and any other payload', async () => {
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(frame()).toBeInTheDocument());
    // Establish the real channel first, so the rejections below are proof the
    // guard rejected them rather than proof the message never landed.
    await postHeight(500, '500px');
    const source = frame().contentWindow;

    post({ type: 'mail-frame-height', height: 700 }, window as unknown as MessageEventSource);
    post({ type: 'something-else', height: 700 }, source);
    post('mail-frame-height', source);
    post({ type: 'mail-frame-height', height: -5 }, source);

    expect(frame().style.height).toBe('500px');
  });

  it('renders a "still being filed" placeholder for a just-sent message (202 pending)', async () => {
    h.body.mockResolvedValue({ pending: true });
    render(<MessageBodyFrame messageId="m1" />);

    await waitFor(() => expect(screen.getByTestId('mail-body-pending')).toBeInTheDocument());
    expect(screen.getByText(/still being filed by the mail server/i)).toBeInTheDocument();
    expect(screen.queryByTestId('mail-body-frame')).toBeNull();
  });

  it('asks again while the message is still being filed', async () => {
    vi.useFakeTimers();
    try {
      h.body.mockResolvedValue({ pending: true });
      render(<MessageBodyFrame messageId="m1" />);
      await act(async () => {});
      expect(screen.getByTestId('mail-body-pending')).toBeInTheDocument();
      expect(h.body).toHaveBeenCalledTimes(1);

      h.body.mockResolvedValue(payload());
      await act(async () => { vi.advanceTimersByTime(15000); });
      expect(h.body).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('mail-body-pending')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a body that could not be loaded', async () => {
    h.body.mockRejectedValue(new Error('Failed to load message'));
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(screen.getByText(/Failed to load message/i)).toBeInTheDocument());
  });

  // The frame is an opaque origin, so it cannot send our Authorization header:
  // without the token in the URL every inline (cid:) image 401s.
  it('carries the auth token on the inline attachment URLs it hands the frame', async () => {
    h.body.mockResolvedValue(payload({
      html: '<img src="/api/mail/messages/m1/attachments/a1?inline=1">'
        + '<img src="" data-blocked-src="https://tracker.test/pixel.png">',
    }));
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(frame()).toBeInTheDocument());

    const doc = frame().getAttribute('srcdoc') ?? '';
    expect(doc).toContain('src="/api/mail/messages/m1/attachments/a1?inline=1&token=tok%20en%2F123"');
    // The blocked remote image is not ours to authorize — it stays as it was.
    expect(doc).toContain('data-blocked-src="https://tracker.test/pixel.png"');
    expect(doc).not.toContain('tracker.test/pixel.png?token');
    expect(doc).not.toContain('tracker.test/pixel.png&token');
  });

  it('leaves the body alone when there is no token to add', async () => {
    h.getMailToken.mockReturnValueOnce('');
    h.body.mockResolvedValue(payload({ html: '<img src="/api/mail/messages/m1/attachments/a1?inline=1">' }));
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(frame()).toBeInTheDocument());
    expect(frame().getAttribute('srcdoc') ?? '').toContain('src="/api/mail/messages/m1/attachments/a1?inline=1">');
  });

  it('refetches when the message changes', async () => {
    const { rerender } = render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(frame()).toBeInTheDocument());
    rerender(<MessageBodyFrame messageId="m2" />);
    await waitFor(() => expect(h.body).toHaveBeenCalledWith('m2', { images: false }));
  });
});

describe('remote images in the frame', () => {
  it('CSP only admits remote images when allowed', () => {
    expect(buildFrameDoc('<p>x</p>', 'n', 'https://app.test')).not.toMatch(/data: https:/);
    expect(buildFrameDoc('<p>x</p>', 'n', 'https://app.test', true)).toMatch(/img-src https:\/\/app\.test data: https: http:;/);
  });

  it('Load images produces a frame whose CSP allows remote images', async () => {
    h.body.mockResolvedValueOnce(payload({ blockedRemoteImages: 1 }));
    h.body.mockResolvedValueOnce(payload({ html: '<img src="https://x.test/a.png">', imagesAllowed: true }));
    render(<MessageBodyFrame messageId="m1" />);
    await waitFor(() => expect(screen.getByText(/Remote images blocked/i)).toBeInTheDocument());
    expect(frame().getAttribute('srcdoc')).not.toMatch(/data: https:/);
    fireEvent.click(screen.getByRole('button', { name: /Load images/i }));
    await waitFor(() => expect(frame().getAttribute('srcdoc')).toMatch(/data: https: http:/));
  });

  it('Always load from sender saves trust and refetches; trusted senders can be untrusted', async () => {
    h.trustImageSender.mockResolvedValue(undefined);
    h.untrustImageSender.mockResolvedValue(undefined);
    h.body.mockResolvedValueOnce(payload({ blockedRemoteImages: 1, sender: 'a@b.com' }));
    h.body.mockResolvedValueOnce(payload({ imagesAllowed: true, sender: 'a@b.com', senderTrusted: true }));
    h.body.mockResolvedValueOnce(payload({ blockedRemoteImages: 1, sender: 'a@b.com' }));
    render(<MessageBodyFrame messageId="m1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Always load from a@b\.com/i }));
    await waitFor(() => expect(h.trustImageSender).toHaveBeenCalledWith('a@b.com'));
    fireEvent.click(await screen.findByRole('button', { name: /Stop loading/i }));
    await waitFor(() => expect(h.untrustImageSender).toHaveBeenCalledWith('a@b.com'));
  });
});
