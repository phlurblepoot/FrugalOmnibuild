// src/pages/mail/compose/quote.ts — pure helpers that turn the message being
// replied to / forwarded into the seed content of a new composer draft.
//
// Everything here is a string transform with no React and no I/O: the composer
// calls these once when it opens, and the tests can assert on the exact markup.
// The quoted body arrives as provider HTML, so every value this module
// interpolates around it is escaped; the body itself is passed through
// unchanged (it is already rendered sandboxed elsewhere — see MessageBodyFrame).
import type { Addr, MessageRow } from '../types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const QUOTE_STYLE = 'border-left:2px solid #ccc;padding-left:8px;color:#555';

/** Minimal HTML-entity escaping for text we interpolate into the quote block. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `Aug 27, 2026 at 12:00 PM` — locale pinned like the rest of the mail UI. */
export function quoteDateLabel(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${time}`;
}

/** `Bob Smith <bob@acme.com>`, or just the address when there is no name. */
export function formatAddr(a: Addr | null | undefined): string {
  if (!a) return '';
  const addr = (a.addr ?? '').trim();
  const name = (a.name ?? '').trim();
  if (!name) return addr;
  return addr ? `${name} <${addr}>` : name;
}

const formatList = (list: Addr[]): string => list.map(formatAddr).filter(Boolean).join(', ');

/**
 * Undo the reading pane's quoted-history fold before the body is quoted into a
 * new message.
 *
 * server/mail/sanitize.ts collapses a reply chain behind a `⋯` toggle so the
 * READER is not shown a copy of what they already have — but the same HTML is
 * what seeds a reply or forward, and pasting the fold into an outgoing message
 * would send a dead button to the recipient AND hide the whole prior thread
 * from them (`hidden` on the holder). Both markers are dropped here so what
 * goes out is the full quote, as every other client sends it.
 *
 * Parsed through an inert `<template>` rather than regexed: the holder's
 * content is arbitrary sender HTML, so its closing tag cannot be matched by
 * pattern. Bodies that carry no fold skip the round trip entirely and are
 * passed through byte for byte.
 */
export function expandQuotedHistory(html: string): string {
  if (!html.includes('data-mail-quote') || typeof document === 'undefined') return html;
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('[data-mail-quote-toggle]').forEach(el => el.remove());
  t.content.querySelectorAll('[data-mail-quote]').forEach(el => el.removeAttribute('hidden'));
  return t.innerHTML;
}

/**
 * Gmail-style attribution block appended below the reply body.
 * Leading `<br><br>` keeps a blank line between what the user types and the quote.
 */
export function quoteForReply(message: MessageRow, bodyHtml: string): string {
  const when = quoteDateLabel(message.date);
  const who = escapeHtml(formatAddr(message.from)) || 'someone';
  const attribution = when ? `On ${escapeHtml(when)}, ${who} wrote:` : `${who} wrote:`;
  return `<br><br><div class="ft-quote" style="${QUOTE_STYLE}">${attribution}<br>${expandQuotedHistory(bodyHtml)}</div>`;
}

/**
 * Splits a reopened draft's body back into what the user typed and the quote
 * the composer appended (`quoteForReply` / `quoteForForward`), so the quote
 * goes back beside the editor instead of into it, where TipTap would rewrite
 * it. A body with no quote of ours is all editor text.
 */
export function splitDraftQuote(html: string): { body: string; quote: string } {
  const at = html.search(/<div[^>]*\bclass="ft-quote"/i);
  if (at < 0) return { body: html, quote: '' };
  // quoteFor* lead with two <br>s; they belong to the quote, not the body.
  const body = html.slice(0, at).replace(/(?:<br\s*\/?>\s*){1,2}$/i, '');
  return { body, quote: `<br><br>${html.slice(at)}` };
}

/** The `---------- Forwarded message ----------` header block plus the body. */
export function quoteForForward(message: MessageRow, bodyHtml: string): string {
  const lines = [
    '---------- Forwarded message ----------',
    `From: ${escapeHtml(formatAddr(message.from))}`,
    `Date: ${escapeHtml(quoteDateLabel(message.date))}`,
    `Subject: ${escapeHtml(message.subject ?? '')}`,
    `To: ${escapeHtml(formatList(message.to ?? []))}`,
  ];
  if (message.cc?.length) lines.push(`Cc: ${escapeHtml(formatList(message.cc))}`);
  return `<br><br><div class="ft-quote" style="${QUOTE_STYLE}">${lines.join('<br>')}<br><br>${expandQuotedHistory(bodyHtml)}</div>`;
}

const key = (a: Addr): string => (a.addr ?? '').trim().toLowerCase();

/**
 * Reply-all split: the original sender plus everyone on To goes to To, the
 * original Cc stays on Cc. Our own mailboxes are dropped from both, and an
 * address is kept only the first time it appears across the two lists.
 */
export function replyAllRecipients(message: MessageRow, ownAddresses: string[]): { to: Addr[]; cc: Addr[] } {
  const own = new Set(ownAddresses.map(a => a.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();

  const take = (list: Array<Addr | null | undefined>): Addr[] => {
    const out: Addr[] = [];
    for (const a of list) {
      if (!a) continue;
      const k = key(a);
      if (!k || own.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
    return out;
  };

  return {
    to: take([message.from, ...(message.to ?? [])]),
    cc: take(message.cc ?? []),
  };
}

const prefixOnce = (subject: string, prefix: string, already: RegExp): string => {
  const s = (subject ?? '').trim();
  if (already.test(s)) return s;
  return s ? `${prefix} ${s}` : prefix;
};

/** `Re: Roof` — left alone when the subject already carries a reply prefix. */
export const replySubject = (subject: string): string => prefixOnce(subject, 'Re:', /^re\s*:/i);

/** `Fwd: Roof` — left alone for an existing `Fwd:` / `Fw:` prefix. */
export const forwardSubject = (subject: string): string => prefixOnce(subject, 'Fwd:', /^(fwd?|fw)\s*:/i);
