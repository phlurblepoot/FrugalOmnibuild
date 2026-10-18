// server/mail/sanitize.ts (spec §4.3, §7)
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const window = new JSDOM('').window as unknown as Window & typeof globalThis;
const purify = createDOMPurify(window);

// NOTE: dompurify's persisted `setConfig()` does not merge correctly with a
// per-call `RETURN_DOM: true` option (the sanitize() call falls back to
// returning a string instead of a DOM node). Pass the full config on every
// call instead of pre-setting it via setConfig().
const SANITIZE_CONFIG = {
  RETURN_DOM: true as const,
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'svg', 'math'],
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'xlink:href'],   // dynsrc/lowsrc are not on DOMPurify's allowlist at all, so they never survive
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
};

const REMOTE = /^(https?:)?\/\//i;
// Every attribute that makes the renderer fetch a URL on its own — not just img[src].
// `background` (any element) and `video[poster]` are on DOMPurify's allowlist and would
// otherwise leak a tracking pixel's worth of "this mail was opened" to the sender;
// dynsrc/lowsrc are legacy IE aliases DOMPurify already strips, listed here so a future
// config change can't quietly re-admit them.
const REMOTE_FETCH_ATTRS = ['src', 'background', 'poster', 'dynsrc', 'lowsrc'] as const;
// `img` is in the selector on its own so a srcless <img> is still dropped, as before.
const REMOTE_ATTR_SELECTOR = ['img', ...REMOTE_FETCH_ATTRS.map(a => `[${a}]`)].join(',');

const SAFE_REMOTE_URL = /^https?:\/\/[^\s"'()\\]+$/i;
function onlyRemoteUrls(decl: string): boolean {
  if (/image-set|expression|@import|\\/i.test(decl)) return false;
  const urls = Array.from(decl.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi));
  if (!urls.length) return false;
  // Every "url(" must have parsed as a complete url(...) token.
  if ((decl.match(/url\s*\(/gi) || []).length !== urls.length) return false;
  return urls.every(m => SAFE_REMOTE_URL.test(m[2].trim()));
}

export function sanitizeEmailHtml(
  html: string,
  opts: { attachmentUrl: (contentId: string) => string | null; allowRemoteImages: boolean }
): { html: string; blockedRemoteImages: number } {
  let blocked = 0;
  const clean = purify.sanitize(html || '', SANITIZE_CONFIG) as unknown as HTMLElement;
  const doc = clean.ownerDocument!;
  clean.querySelectorAll<HTMLElement>(REMOTE_ATTR_SELECTOR).forEach((el) => {
    const isImg = el.tagName.toLowerCase() === 'img';
    // Dropping the whole element is right for <img> (an empty img is a broken-image
    // icon); for a <table background> or <video poster> only the attribute goes.
    const drop = () => { if (isImg) el.remove(); else REMOTE_FETCH_ATTRS.forEach(a => el.removeAttribute(a)); };
    if (isImg && el.getAttribute('src') == null) { el.remove(); return; }
    for (const attr of REMOTE_FETCH_ATTRS) {
      const value = el.getAttribute(attr);
      if (value == null) continue;
      if (value.toLowerCase().startsWith('cid:')) {
        const url = opts.attachmentUrl(value.slice(4).replace(/^<|>$/g, ''));
        if (url) el.setAttribute(attr, url);
        else { drop(); return; }
      } else if (REMOTE.test(value)) {
        if (!opts.allowRemoteImages) {
          el.removeAttribute(attr);
          el.setAttribute(`data-blocked-${attr}`, value);
          blocked++;
        }
      } else if (!value.startsWith('data:image/')) {
        drop(); return;
      }
    }
  });
  clean.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    if (/url\s*\(/i.test(style)) {
      if (!opts.allowRemoteImages && REMOTE.test(style.replace(/.*url\s*\(\s*['"]?/i, ''))) blocked++;
      // With images on, a declaration whose every url() is a plain http(s)
      // address stays (the frame's CSP is what permits the fetch); anything
      // else (data:, cid:, relative, image-set tricks) goes.
      el.setAttribute('style', style.replace(/[a-z-]*\s*:\s*[^;]*url\s*\([^)]*\)[^;]*;?/gi, (decl) =>
        opts.allowRemoteImages && onlyRemoteUrls(decl) ? decl : ''));
    }
  });
  clean.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  collapseQuotedHistory(clean, doc);
  const wrapper = doc.createElement('div');
  wrapper.append(...Array.from(clean.childNodes));
  return { html: wrapper.innerHTML, blockedRemoteImages: blocked };
}

/**
 * The light clean a draft body gets before it goes back into the composer's
 * editor. Unlike sanitizeEmailHtml this keeps inline styles and remote images
 * (the user wrote this mail; the editor is not a tracking surface the way the
 * reader is) and never folds quoted history. Active content is still removed,
 * and `cid:` images are dropped because their parts come back as attachments.
 */
export function cleanDraftHtml(html: string): string {
  const clean = purify.sanitize(html || '', SANITIZE_CONFIG) as unknown as HTMLElement;
  clean.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').trim();
    if (!src || /^cid:/i.test(src)) img.remove();
  });
  return clean.innerHTML;
}

// ── quoted history ─────────────────────────────────────────────────────────
// A long reply chain is mostly a copy of what the reader already has. Every
// mail client hides it behind a "…" and so do we — but the hiding has to
// happen HERE rather than in the client, because the body is rendered inside a
// sandboxed, opaque-origin iframe that the app cannot reach into. The markers
// this leaves (a plain <button data-mail-quote-toggle> next to a
// <div data-mail-quote hidden>) are what MessageBodyFrame's nonce'd script
// toggles. They are added AFTER sanitizing on purpose: `button` is on
// FORBID_TAGS and `data-*` is off, so a sender cannot forge either one.

/** The containers the big three actually emit for a quoted reply. */
const QUOTE_SELECTOR = 'div.gmail_quote, div.gmail_quote_container, blockquote[type=cite]';
/** "On Fri, Aug 29, 2026 at 9:14 AM Bob <bob@x.com> wrote:" — the attribution
 *  line clients without a marker class write above the quote. Bounded so a body
 *  that merely opens with the word "On" cannot scan the whole message. */
const WROTE_RE = /^\s*on\b[\s\S]{0,300}?\bwrote\s*:/i;

/** Minimal, self-contained styling: the frame's stylesheet is ours, but the
 *  sender's CSS is not, so the toggle carries its own look inline. */
const TOGGLE_STYLE = 'display:inline-block;margin:6px 0;padding:0 8px;border:1px solid #ccc;'
  + 'border-radius:8px;background:#f1f3f4;color:#444;font:inherit;line-height:1.6;cursor:pointer';

/** How long the attribution line may be before it stops looking like one and
 *  starts looking like a sentence the sender wrote. */
const ATTRIBUTION_MAX = 120;

/** Text that is JUST an attribution: it opens with "On … wrote:" (the caller
 *  has already checked that) and ends there, rather than carrying on into the
 *  sender's own prose. */
const isAttributionOnly = (el: Element): boolean => {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length <= ATTRIBUTION_MAX && text.endsWith(':');
};

/** …or it is followed by the quote it introduces, which settles it either way. */
const introducesQuote = (el: Element): boolean => {
  const next = el.nextElementSibling;
  return !!next && (next.matches(QUOTE_SELECTOR) || next.tagName.toLowerCase() === 'blockquote');
};

function collapseQuotedHistory(root: HTMLElement, doc: Document): void {
  const wrap = (nodes: ChildNode[]): void => {
    const first = nodes[0];
    const parent = first.parentNode;
    if (!parent) return;
    const holder = doc.createElement('div');
    holder.setAttribute('data-mail-quote', '');
    holder.setAttribute('hidden', '');
    const toggle = doc.createElement('button');
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('data-mail-quote-toggle', '');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Show trimmed content');
    toggle.setAttribute('style', TOGGLE_STYLE);
    toggle.textContent = '\u22ef';
    parent.insertBefore(toggle, first);
    parent.insertBefore(holder, first);
    for (const n of nodes) holder.appendChild(n);
  };

  // The attribution line and the quote it introduces are usually siblings, so
  // matching on it collapses BOTH — a plain `blockquote` match would leave the
  // "On … wrote:" line stranded above the toggle.
  //
  // The fold swallows everything after the line it starts on, so the line has
  // to REALLY be an attribution before that is safe: "On Monday the crew wrote:
  // bring the mixer" opens with the pattern but is the sender's own text, and
  // folding from there would hide it and every paragraph after it (a trailing
  // "Thanks" included). So the match only counts when the element is a marked
  // quote container, or its text is nothing but the attribution, or the quote
  // it introduces follows it directly.
  const kids = Array.from(root.childNodes);
  const top = Array.from(root.children);
  const startedAt = top.findIndex(el => WROTE_RE.test(el.textContent || ''));
  if (startedAt >= 0) {
    const el = top[startedAt];
    const isContainer = el.matches(QUOTE_SELECTOR);
    // `nextSibling`, not `nextElementSibling`: a fold that covers only the
    // attribution line itself hides nothing and is not worth a toggle.
    if (isContainer || ((isAttributionOnly(el) || introducesQuote(el)) && el.nextSibling)) {
      // Sliced from childNodes rather than children so the TEXT between those
      // elements travels into the fold too — left behind, it re-emerges below
      // the toggle as loose fragments of the quote.
      wrap(kids.slice(kids.indexOf(el)));
      return;
    }
  }

  // Otherwise wrap each marked container — outermost only, so a five-deep
  // reply chain gets one toggle rather than five nested ones.
  const marked = Array.from(root.querySelectorAll<HTMLElement>(QUOTE_SELECTOR));
  const outermost = marked.filter(el => !marked.some(other => other !== el && other.contains(el)));
  for (const el of outermost) wrap([el]);
}
