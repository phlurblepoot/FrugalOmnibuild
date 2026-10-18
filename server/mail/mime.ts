import { v4 as uuidv4 } from 'uuid';
import type { Addr } from './providers/types';

const ADDR_RE = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$|^\s*([^\s<>@]+@[^\s<>]+)\s*$/;
export function parseAddress(s: string): Addr | null {
  const m = ADDR_RE.exec(s || '');
  if (!m) return null;
  if (m[2]) { const name = (m[1] || '').trim(); return name ? { addr: m[2].trim().toLowerCase(), name } : { addr: m[2].trim().toLowerCase() }; }
  return { addr: m[3].trim().toLowerCase() };
}
export function parseAddressList(s: string): Addr[] {
  return (s || '').split(/[,;]/).map(parseAddress).filter((a): a is Addr => !!a);
}
export function formatAddress(a: Addr): string {
  return a.name ? `"${a.name.replace(/"/g, '')}" <${a.addr}>` : a.addr;
}
// nbsp deliberately becomes a PLAIN space: htmlToText trims each line, and a
// real U+00A0 would survive that and leave ragged indentation behind.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};
/** One pass over the string, so `&amp;#39;` decodes to the literal `&#39;`
 *  rather than being decoded twice into an apostrophe. Anything unrecognised
 *  is left exactly as it was written. */
export function decodeEntities(s: string): string {
  return (s || '').replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
export function htmlToText(html: string): string {
  return decodeEntities((html || '')
    // A blockquote is a quote boundary, so BOTH its tags become line breaks
    // (attributes and all): that is what leaves "On … wrote:" on a line of its
    // own for stripQuotedReply, whatever the sending client wrapped it in.
    .replace(/<\s*\/?\s*blockquote(\s[^>]*)?>/gi, '\n')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function newMessageIdHeader(domain: string): string {
  return `${uuidv4()}@${(domain || 'localhost').toLowerCase()}`;
}
// Keeps only the author's own words: cuts at "On … wrote:", an Outlook
// "From:" header block, or the first run of '>'-quoted lines. Never returns
// an empty string — a reply that is ALL quote comes back untouched.
export function stripQuotedReply(text: string): string {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^on .+wrote:$/i.test(l) || /^-{2,}\s*original message\s*-{2,}$/i.test(l) || /^from:\s.+/i.test(l) || l.startsWith('>')) { cut = i; break; }
  }
  const out = lines.slice(0, cut).join('\n').trim();
  return out || (text || '').trim();
}
export function snippetOf(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
