// src/pages/mail/MessageBodyFrame.tsx — one message's HTML body, rendered
// inside a sandboxed iframe (spec §5.2 / §7).
//
// The body has already been sanitized on the server (DOMPurify on jsdom); the
// iframe is the second wall. `allow-same-origin` is deliberately NOT granted,
// so the frame is an opaque origin: it cannot read the app's DOM, cookies or
// localStorage. `allow-scripts` is granted for exactly one script — the
// height reporter injected below, allowed by a per-render nonce in the CSP,
// which is why 'unsafe-inline' never appears there. `allow-popups(-to-escape-
// sandbox)` is what lets `<base target="_blank">` links actually open.
//
// Email bodies stay on a light background in dark mode: every mail client does
// this, and re-theming sender HTML wrecks it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Skeleton } from '../../components/ui';
import { getMailToken, mailApi } from '../../utils/mailApi';
import type { BodyPayload } from './types';

/** Tallest frame we will grow to; past this the body scrolls inside itself. */
const MAX_HEIGHT = 20000;
const MIN_HEIGHT = 80;

// A just-sent message whose provider copy has not been filed yet answers 202.
// The thread's live refresh does not remount this component (same message id),
// so the placeholder has to come back for its own answer.
const PENDING_RETRY_MS = 15000;
const PENDING_RETRIES = 8;

/**
 * Runs inside the opaque-origin frame. Two jobs, and they have to share one
 * script because the CSP admits exactly one nonce'd block: report the body's
 * height to the parent, and expand/collapse the quoted reply history the
 * server folded away (server/mail/sanitize.ts leaves a
 * `[data-mail-quote-toggle]` button in front of each `[data-mail-quote]`).
 * The toggle has to live in here rather than in React because the app cannot
 * reach into a sandboxed frame's DOM — and a re-report follows every toggle,
 * or the frame keeps the height it had before the quote unfolded.
 *
 * Height is measured from the #__mail_root wrapper's bounding rect, not
 * document.documentElement/body.scrollHeight. Once the parent grows the
 * iframe tall, the frame's own viewport is that tall, and scrollHeight of
 * html/body can never report LESS than the viewport it is laid out in — so a
 * scrollHeight-based report only ever grows, and collapsing the quoted
 * history (which shrinks the content) never shrinks the reported height. The
 * wrapper's rect reflects its actual content height regardless of viewport
 * size, so it correctly reports smaller once the quote is re-hidden.
 */
const frameScript = `
(function () {
  var last = 0;
  function report() {
    var root = document.getElementById('__mail_root');
    // +24 restores the body's own 12px top/bottom padding, which sits outside
    // the wrapper's own rect (the wrapper is measured, not the body).
    var h = root
      ? Math.ceil(root.getBoundingClientRect().height) + 24
      : Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0
        );
    if (h === last) return;
    last = h;
    parent.postMessage({ type: 'mail-frame-height', height: h }, '*');
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-mail-quote-toggle]') : null;
    if (!t) return;
    e.preventDefault();
    var q = t.nextElementSibling;
    if (!q || !q.hasAttribute('data-mail-quote')) return;
    var hidden = q.hasAttribute('hidden');
    if (hidden) q.removeAttribute('hidden'); else q.setAttribute('hidden', '');
    t.setAttribute('aria-expanded', hidden ? 'true' : 'false');
    t.setAttribute('aria-label', hidden ? 'Hide trimmed content' : 'Show trimmed content');
    report();
  });
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  document.addEventListener('load', report, true);
  setTimeout(report, 0);
  setTimeout(report, 300);
  setTimeout(report, 1500);
})();
`.trim();

// Attributes the server may have pointed at our own attachment route when it
// resolved a `cid:` reference (server/mail/sanitize.ts REMOTE_FETCH_ATTRS).
const INLINE_URL_RE = /(\s(?:src|background|poster|dynsrc|lowsrc)=)(["'])(\/api\/mail\/messages\/[^"'\s]*)\2/gi;

/**
 * Inline images arrive as `<img src="/api/mail/messages/…/attachments/…?inline=1">`,
 * but the frame is an OPAQUE origin: it cannot send our Authorization header,
 * so every one of those requests would 401 and the message would render with
 * broken images. Same escape hatch as mailApi.attachmentUrl — the token rides
 * in the query string. Remote images the sanitizer parked in `data-blocked-src`
 * are untouched: they are not our URLs, and they stay blocked until the user
 * asks for them.
 */
export function authorizeInlineUrls(html: string, token: string): string {
  if (!token) return html;
  return html.replace(INLINE_URL_RE, (_m, attr: string, quote: string, url: string) =>
    `${attr}${quote}${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}${quote}`);
}

export function buildFrameDoc(html: string, nonce: string, origin: string, allowRemoteImages = false): string {
  // Remote images are admitted only once the server has let them through
  // (sanitize parks them in data-blocked-src until then).
  const imgSrc = allowRemoteImages ? `${origin} data: https: http:` : `${origin} data:`;
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<base target="_blank">',
    '<style>',
    // height:auto (not just margin reset) keeps html/body from being stretched
    // to fill whatever height the parent last set on the iframe — otherwise
    // #__mail_root's rect would itself be measured inside an inflated
    // viewport and the shrink-on-collapse fix below would not hold.
    'html,body{margin:0;height:auto!important}',
    // A body that is nothing but floats (a common newsletter/signature shape)
    // has zero in-flow content, so #__mail_root's rect measures 0 and the
    // message renders as a sliver. flow-root makes the wrapper establish a
    // block formatting context, so it contains its floats and reports their
    // real height.
    '#__mail_root{display:flow-root}',
    'body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;background:#fff;',
    'word-break:break-word;overflow-wrap:anywhere;padding:12px}',
    'img{max-width:100%;height:auto}',
    'table{max-width:100%}',
    'blockquote{margin:0 0 0 .75rem;padding-left:.75rem;border-left:2px solid #ddd;color:#555}',
    'a{color:#0b57d0}',
    '</style></head><body>',
    '<div id="__mail_root">',
    html,
    '</div>',
    `<script nonce="${nonce}">${frameScript}</` + 'script>',
    '</body></html>',
  ].join('');
}

export const MessageBodyFrame: React.FC<{ messageId: string }> = ({ messageId }) => {
  const [payload, setPayload] = useState<BodyPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showImages, setShowImages] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Remote images are a per-message opt-in, so a new message re-blocks them.
  useEffect(() => {
    setShowImages(false);
    setAttempt(0);
  }, [messageId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    mailApi
      .body(messageId, { images: showImages })
      .then(res => {
        if (cancelled) return;
        if (res && (res as { pending?: boolean }).pending) {
          setPending(true);
          setPayload(null);
        } else {
          setPending(false);
          setPayload(res as BodyPayload);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load message');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, showImages, attempt]);

  useEffect(() => {
    if (!pending || attempt >= PENDING_RETRIES) return;
    const t = setTimeout(() => setAttempt(a => a + 1), PENDING_RETRY_MS);
    return () => clearTimeout(t);
    // messageId is a dependency so switching messages restarts the countdown
    // rather than inheriting the previous message's place in it.
  }, [pending, attempt, messageId]);

  // A fresh nonce per document: a nonce that repeats across renders would let
  // any inline script that ever slipped past the sanitizer keep running.
  const doc = useMemo(
    () => (payload
      ? buildFrameDoc(authorizeInlineUrls(payload.html, getMailToken()), uuidv4(), window.location.origin, !!payload.imagesAllowed)
      : null),
    [payload],
  );

  // Reset the height with the document so a short message after a long one
  // does not keep the tall frame.
  useEffect(() => {
    setHeight(MIN_HEIGHT);
  }, [doc]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only our own frame is believed — any other window (including a nested
      // frame the body tried to open) is ignored.
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as { type?: string; height?: unknown } | null;
      if (!data || typeof data !== 'object' || data.type !== 'mail-frame-height') return;
      const h = Number(data.height);
      if (!Number.isFinite(h) || h <= 0) return;
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const loadImages = useCallback(() => setShowImages(true), []);

  // Trust is stored per user on the server; a change refetches the body so the
  // bar and the images follow it.
  const setTrusted = useCallback(async (trust: boolean) => {
    const addr = payload?.sender;
    if (!addr) return;
    try {
      if (trust) await mailApi.trustImageSender(addr);
      else await mailApi.untrustImageSender(addr);
      setShowImages(trust);
      setAttempt(a => a + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the sender setting');
    }
  }, [payload?.sender]);

  if (loading && !payload && !pending && !error) {
    return (
      <div data-testid="mail-body-loading" className="space-y-2 py-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (pending) {
    return (
      <p data-testid="mail-body-pending" className="rounded-lg border border-edge bg-sunken px-3 py-2 text-sm text-ink-faint">
        Sending… this message is still being filed by the mail server. It will appear here in a minute.
      </p>
    );
  }

  if (error) {
    return (
      <p data-testid="mail-body-error" className="rounded-lg border border-edge bg-sunken px-3 py-2 text-sm text-ink-faint">
        {error}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!!payload && payload.blockedRemoteImages > 0 && (
        <div
          data-testid="mail-images-bar"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <ImageOff size={14} className="shrink-0" />
          <span>Remote images blocked</span>
          <button
            type="button"
            onClick={loadImages}
            className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-amber-100 dark:hover:bg-amber-500/20"
          >
            Load images
          </button>
          {payload.sender && (
            <button
              type="button"
              onClick={() => { void setTrusted(true); }}
              className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-amber-100 dark:hover:bg-amber-500/20"
            >
              Always load from {payload.sender}
            </button>
          )}
        </div>
      )}
      {!!payload && payload.senderTrusted && !!payload.sender && (
        <div data-testid="mail-trusted-bar" className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <span>Images always load from {payload.sender}.</span>
          <button
            type="button"
            onClick={() => { void setTrusted(false); }}
            className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-sunken"
          >
            Stop loading
          </button>
        </div>
      )}

      {doc !== null && (
        <iframe
          ref={frameRef}
          data-testid="mail-body-frame"
          title="Message"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          style={{ height: `${height}px` }}
          className="w-full rounded-lg border border-edge bg-white"
        />
      )}
    </div>
  );
};
