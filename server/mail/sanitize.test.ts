import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml, cleanDraftHtml } from './sanitize';

const opts = { attachmentUrl: (cid: string) => (cid === 'img1' ? '/api/mail/messages/m/attachments/a1?inline=1' : null), allowRemoteImages: false };

describe('sanitizeEmailHtml', () => {
  it('drops scripts, forms, iframes and event handlers', () => {
    const r = sanitizeEmailHtml('<p onclick="x()">hi</p><script>bad()</script><form><input></form><iframe src="x"></iframe>', opts);
    expect(r.html).toBe('<p>hi</p>');
  });
  it('rewrites cid: images to the attachment route and blocks remote ones', () => {
    const r = sanitizeEmailHtml('<img src="cid:img1"><img src="https://t.example/p.png"><div style="background:url(https://t.example/b.png)">x</div>', opts);
    expect(r.html).toContain('src="/api/mail/messages/m/attachments/a1?inline=1"');
    expect(r.html).toContain('data-blocked-src="https://t.example/p.png"');
    expect(r.html).not.toContain('<img src="https://t.example/p.png"');
    expect(r.html).not.toContain('url(https://t.example/b.png)');
    expect(r.blockedRemoteImages).toBe(2);
  });
  it('keeps remote images when allowed', () => {
    const r = sanitizeEmailHtml('<img src="https://t.example/p.png">', { ...opts, allowRemoteImages: true });
    expect(r.html).toContain('src="https://t.example/p.png"'); expect(r.blockedRemoteImages).toBe(0);
  });
  it('blocks remote fetches from background/poster too, not just img[src]', () => {
    const r = sanitizeEmailHtml('<table background="https://t.example/x.png"><tr><td>c</td></tr></table><video poster="https://t.example/y.png"></video>', opts);
    expect(r.html).not.toMatch(/\sbackground="https/);
    expect(r.html).not.toMatch(/\sposter="https/);
    expect(r.html).toContain('data-blocked-background="https://t.example/x.png"');
    expect(r.html).toContain('data-blocked-poster="https://t.example/y.png"');
    expect(r.blockedRemoteImages).toBe(2);
  });
  it('keeps background/poster when remote images are allowed', () => {
    const r = sanitizeEmailHtml('<table background="https://t.example/x.png"><tr><td>c</td></tr></table><video poster="https://t.example/y.png"></video>', { ...opts, allowRemoteImages: true });
    expect(r.html).toContain('background="https://t.example/x.png"');
    expect(r.html).toContain('poster="https://t.example/y.png"');
    expect(r.blockedRemoteImages).toBe(0);
  });
  it('drops the legacy dynsrc/lowsrc fetch attributes outright', () => {
    // Choice: these two are not on DOMPurify's allowlist, so they never reach our
    // rewrite pass — they are removed rather than counted. Asserted both ways so a
    // config change that re-admits them fails here.
    for (const allowRemoteImages of [false, true]) {
      const r = sanitizeEmailHtml('<img src="data:image/png;base64,AA" dynsrc="https://t.example/d.png" lowsrc="https://t.example/l.png">', { ...opts, allowRemoteImages });
      expect(r.html).not.toContain('t.example');
      expect(r.blockedRemoteImages).toBe(0);
    }
  });
  it('forces links to open safely', () => {
    const r = sanitizeEmailHtml('<a href="https://x.y" target="_self">l</a><a href="javascript:alert(1)">j</a>', opts);
    expect(r.html).toContain('target="_blank"'); expect(r.html).toContain('rel="noopener noreferrer"'); expect(r.html).not.toContain('javascript:');
  });
  // Quoted history: the toggle + hidden holder the frame script drives. The
  // markers are added after sanitizing, so `button` staying on FORBID_TAGS and
  // data-attributes staying off means a sender cannot forge either one.
  describe('quoted history', () => {
    const quote = (html: string) => sanitizeEmailHtml(html, opts).html;

    it('folds a gmail_quote away behind a toggle', () => {
      const r = quote('<div>My answer</div><div class="gmail_quote">On Fri Bob wrote:<blockquote>old</blockquote></div>');
      expect(r).toContain('<button type="button" data-mail-quote-toggle="" aria-expanded="false" aria-label="Show trimmed content"');
      expect(r).toMatch(/<div data-mail-quote="" hidden="">.*gmail_quote/);
      // The reply itself stays outside the fold.
      expect(r.indexOf('My answer')).toBeLessThan(r.indexOf('data-mail-quote-toggle'));
    });

    it('folds a blockquote[type=cite] away behind a toggle', () => {
      const r = quote('<p>Answer</p><blockquote type="cite">old thread</blockquote>');
      expect(r).toContain('data-mail-quote-toggle');
      expect(r).toMatch(/<div data-mail-quote="" hidden=""><blockquote type="cite">old thread<\/blockquote><\/div>/);
    });

    it('folds an unmarked "On … wrote:" attribution AND everything after it', () => {
      const r = quote('<div>Sure thing</div><div>On Fri, Aug 29, 2026 at 9:14 AM Bob &lt;b@x.com&gt; wrote:</div><blockquote>old</blockquote>');
      expect(r).toContain('data-mail-quote-toggle');
      // Attribution line and the quote it introduces are folded together.
      const holder = r.slice(r.indexOf('data-mail-quote=""'));
      expect(holder).toContain('wrote:');
      expect(holder).toContain('old');
      expect(r.indexOf('Sure thing')).toBeLessThan(r.indexOf('data-mail-quote-toggle'));
    });

    it('leaves a body with no quoted history alone', () => {
      const r = quote('<p>Just a note</p><div>Nothing quoted here</div>');
      expect(r).toBe('<p>Just a note</p><div>Nothing quoted here</div>');
    });

    it('does not fold a whole message that merely opens with the word "On"', () => {
      const r = quote('<div>On site tomorrow — the crew wrote: bring the mixer</div>');
      expect(r).not.toContain('data-mail-quote');
    });

    // The fold swallows the matching element AND everything after it, so a
    // sentence that merely opens with the pattern would take the sender's own
    // following paragraphs down with it.
    it('does not fold a sentence that opens with the pattern but carries on', () => {
      const r = quote('<p>Hi Bob</p><p>On Monday the crew wrote: bring the mixer</p><p>Thanks</p>');
      expect(r).not.toContain('data-mail-quote');
      expect(r).toContain('Thanks');
      expect(r).toContain('bring the mixer');
    });

    it('still folds an attribution line that is followed by its quote, even when long', () => {
      const longLine = `On ${'a very long friday '.repeat(12)}Bob wrote: and then some`;
      const r = quote(`<p>Answer</p><div>${longLine}</div><blockquote>old</blockquote>`);
      // Too long to be attribution-only, but the blockquote right after settles it.
      expect(r).toContain('data-mail-quote-toggle');
      expect(r.slice(r.indexOf('data-mail-quote=""'))).toContain('old');
    });

    it('does not open a fold that would hide nothing but the attribution itself', () => {
      const r = quote('<div>On Fri, Bob wrote:</div>');
      expect(r).not.toContain('data-mail-quote');
    });

    // `children` skips text nodes; left behind they re-emerge BELOW the toggle
    // as loose fragments of the quote the fold was supposed to hide.
    it('takes the loose text between folded elements into the fold', () => {
      const r = quote('<p>Answer</p><div>On Fri, Bob wrote:</div>stray quote text<blockquote>old</blockquote>trailing');
      const holder = r.slice(r.indexOf('data-mail-quote=""'));
      expect(holder).toContain('stray quote text');
      expect(holder).toContain('trailing');
      // Only the reply itself is left outside the fold.
      expect(r.slice(0, r.indexOf('data-mail-quote-toggle'))).toContain('Answer');
      expect(r.slice(0, r.indexOf('data-mail-quote-toggle'))).not.toContain('stray');
    });

    it('marks the toggle collapsed for assistive tech', () => {
      const r = quote('<p>Answer</p><blockquote type="cite">old</blockquote>');
      expect(r).toContain('aria-expanded="false"');
    });

    it('folds nested quotes once, at the outermost level', () => {
      const r = quote('<p>Latest</p><blockquote type="cite">a<blockquote type="cite">b</blockquote></blockquote>');
      expect(r.match(/data-mail-quote-toggle/g)).toHaveLength(1);
      expect(r.match(/data-mail-quote=""/g)).toHaveLength(1);
    });

    it('folds two sibling quote containers separately', () => {
      const r = quote('<p>hi</p><blockquote type="cite">a</blockquote><p>and</p><blockquote type="cite">b</blockquote>');
      expect(r.match(/data-mail-quote-toggle/g)).toHaveLength(2);
    });

    it('still refuses a sender\'s own forged toggle markup', () => {
      const r = quote('<button data-mail-quote-toggle>tap me</button><div data-mail-quote>secret</div>');
      // `button` is on FORBID_TAGS and data-attributes are off, so the only
      // markers in the output are ones this module put there.
      expect(r).not.toContain('<button');
      expect(r).not.toContain('data-mail-quote=""');
    });
  });

  it('drops unknown cid: images', () => {
    expect(sanitizeEmailHtml('<img src="cid:nope">', opts).html).not.toContain('<img');
  });
});

describe('sanitizeEmailHtml inline-style images', () => {
  const on = { ...opts, allowRemoteImages: true };
  it('keeps an http(s) background url when images are allowed', () => {
    const r = sanitizeEmailHtml('<div style="background:url(https://t.example/b.png)">x</div>', on);
    expect(r.html).toContain('url(https://t.example/b.png)');
  });
  it('still strips non-remote or odd urls when images are allowed', () => {
    const r = sanitizeEmailHtml('<div style="background:url(javascript:alert(1))">x</div><p style="background:url(/api/x)">y</p>', on);
    expect(r.html).not.toContain('url(');
  });
});

describe('cleanDraftHtml', () => {
  it('keeps styles and remote images, drops scripts and cid images, never folds quotes', () => {
    const out = cleanDraftHtml('<p style="color:red">Hi <img src="https://x/a.png"><img src="cid:logo"></p><script>alert(1)</script><blockquote type="cite">old</blockquote>');
    expect(out).toContain('style="color:red"');
    expect(out).toContain('src="https://x/a.png"');
    expect(out).not.toContain('cid:');
    expect(out).not.toContain('script');
    expect(out).not.toContain('data-mail-quote');
    expect(out).toContain('old');
  });
});
