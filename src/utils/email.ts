// src/utils/email.ts
// Shared lightweight email validation. Replaces the `/\S+@\S+\.\S+/` regex
// previously duplicated across the invoice/CO/issue send editors.
import type { Addr } from '../pages/mail/types';

const EMAIL_RE = /\S+@\S+\.\S+/;

/** True when `s` (trimmed) looks like a single email address. */
export const isValidEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

/**
 * Split a comma/semicolon-separated list of addresses into trimmed entries,
 * dropping empties. Returns [] for blank/whitespace input.
 */
export const parseAddressList = (s: string): string[] =>
  s
    .split(/[,;]/)
    .map(a => a.trim())
    .filter(Boolean);

/**
 * True when every parsed address is valid. An empty list returns true
 * (suitable for optional cc/bcc fields). For required fields, also check
 * the list is non-empty.
 */
export const isValidAddressList = (s: string): boolean =>
  parseAddressList(s).every(isValidEmail);

// ── Structured addresses ─────────────────────────────────────────────────────
// The mail composer works in `Addr` objects while every editor still holds its
// prefilled recipients as a comma-separated string, so one parser has to bridge
// them. It deliberately mirrors server/mail/mime.ts's ADDR_RE: a name the
// server would keep must survive the round trip, and an address the server
// would reject must never be shown as an accepted chip.

const ADDR_RE = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$|^\s*([^\s<>@]+@[^\s<>]+)\s*$/;

/** `Bob <bob@acme.com>` / `bob@acme.com` → Addr; anything else → null. */
export const parseAddress = (s: string): Addr | null => {
  const m = ADDR_RE.exec(s || '');
  if (!m) return null;
  if (m[2]) {
    const name = (m[1] || '').trim();
    const addr = m[2].trim().toLowerCase();
    return name ? { addr, name } : { addr };
  }
  return { addr: m[3].trim().toLowerCase() };
};

/** Split a comma/semicolon list into Addr entries, dropping unparseable ones. */
export const parseAddresses = (s: string): Addr[] =>
  (s || '').split(/[,;]/).map(parseAddress).filter((a): a is Addr => a !== null);

/** The inverse: what the item send routes still take as a `to`/`cc` string. */
export const formatAddress = (a: Addr): string =>
  a.name ? `"${a.name.replace(/"/g, '')}" <${a.addr}>` : a.addr;

export const formatAddresses = (list: Addr[]): string => list.map(formatAddress).join(', ');

// Mirrors server/routes.ts textToHtml. The editors' prefilled bodies are plain
// text with newlines; the composer's document is html, so the seed has to be
// converted on the way in or the paragraph breaks collapse into one run-on
// line the moment it is rendered.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export const textToHtml = (t: string): string =>
  `<p>${(t || '').replace(/[&<>]/g, c => HTML_ESCAPES[c]).replace(/\r?\n/g, '<br>')}</p>`;
