import { describe, it, expect } from 'vitest';
import { parseAddressList, formatAddress, htmlToText, stripQuotedReply, snippetOf, newMessageIdHeader } from './mime';

describe('mime helpers', () => {
  it('parses display-name and bare addresses', () => {
    expect(parseAddressList('"Mike T" <m@x.com>, a@y.org; bad')).toEqual([{ addr: 'm@x.com', name: 'Mike T' }, { addr: 'a@y.org' }]);
  });
  it('formats with quotes only when a name exists', () => {
    expect(formatAddress({ addr: 'm@x.com', name: 'Mike' })).toBe('"Mike" <m@x.com>');
    expect(formatAddress({ addr: 'm@x.com' })).toBe('m@x.com');
  });
  it('htmlToText keeps line breaks for block elements and drops tags', () => {
    expect(htmlToText('<p>Hi<br>there</p><div>ok &amp; done</div>')).toBe('Hi\nthere\nok & done');
  });
  it('htmlToText breaks around a blockquote so the quote attribution stands alone', () => {
    expect(htmlToText('<div>Corridor 9ft</div><blockquote class="gmail_quote" type="cite">On Aug 26 Noah wrote:<br>RFI attached</blockquote>'))
      // </div> then <blockquote> is a paragraph break, hence the blank line.
      .toBe('Corridor 9ft\n\nOn Aug 26 Noah wrote:\nRFI attached');
    // The point of the break: the reply survives, the quoted history does not.
    expect(stripQuotedReply(htmlToText('Corridor 9ft<blockquote>On Aug 26 Noah wrote:<br>RFI attached</blockquote>')))
      .toBe('Corridor 9ft');
  });
  it('htmlToText decodes numeric and the common named entities in one pass', () => {
    expect(htmlToText('<p>Level&nbsp;6 &mdash; Mike&#39;s call&hellip;</p>')).toBe("Level 6 — Mike's call…");
    expect(htmlToText('<p>caf&#xe9; &ndash; &lsquo;ok&rsquo; &ldquo;q&rdquo;</p>')).toBe('café – ‘ok’ “q”');
    // One pass only: an escaped entity must survive as literal text.
    expect(htmlToText('<p>ok &amp;#39; done</p>')).toBe('ok &#39; done');
    // Anything unrecognised is left exactly as written.
    expect(htmlToText('<p>a &bogus; b &#0; c</p>')).toBe('a &bogus; b &#0; c');
  });
  it('stripQuotedReply removes On … wrote:, > blocks and From: headers', () => {
    const t = 'Approved.\n\nOn Aug 25, 2026, Noah wrote:\n> COR attached\n> thanks';
    expect(stripQuotedReply(t)).toBe('Approved.');
    expect(stripQuotedReply('Yes\n\nFrom: Noah\nSent: x\n\noriginal')).toBe('Yes');
    expect(stripQuotedReply('> only quoted')).toBe('> only quoted');   // never returns empty
  });
  it('snippetOf collapses whitespace and caps at 200', () => {
    expect(snippetOf('a\n\n  b'.padEnd(500, 'x')).length).toBe(200);
  });
  it('newMessageIdHeader is bracket-free and lowercase', () => {
    expect(newMessageIdHeader('Birchwood.example')).toMatch(/^[0-9a-f-]{36}@birchwood.example$/);
  });
});
