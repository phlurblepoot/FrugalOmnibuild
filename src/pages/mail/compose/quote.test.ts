// src/pages/mail/compose/quote.test.ts
import { describe, it, expect } from 'vitest';
import type { MessageRow } from '../types';
import {
  expandQuotedHistory, forwardSubject, quoteForForward, quoteForReply, replyAllRecipients, replySubject, splitDraftQuote,
} from './quote';

const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1', accountId: 'a1', threadKey: 'tk-1', messageIdHeader: null, inReplyTo: null, references: [],
  from: { addr: 'bob@acme.com', name: 'Bob Smith' },
  to: [{ addr: 'noah@birchwoodplaster.example', name: 'Noah' }, { addr: 'carol@acme.com' }],
  cc: [{ addr: 'dave@acme.com' }],
  bcc: [], subject: 'Roof detail', snippet: '', date: '2026-08-27T16:00:00.000Z',
  isRead: true, isStarred: false, isDraft: false, hasAttachments: false, attachments: [],
  sizeBytes: 0, folderIds: [], sentFromApp: false, ...over,
});

describe('quoteForReply', () => {
  it('wraps the original body in an attribution block', () => {
    const html = quoteForReply(msg(), '<p>Hello there</p>');
    expect(html.startsWith('<br><br>')).toBe(true);
    expect(html).toContain('class="ft-quote"');
    expect(html).toContain('border-left:2px solid #ccc');
    expect(html).toContain('wrote:');
    expect(html).toContain('Bob Smith');
    expect(html).toContain('&lt;bob@acme.com&gt;');
    expect(html).toContain('<p>Hello there</p>');
  });

  it('survives a missing sender and a bad date', () => {
    const html = quoteForReply(msg({ from: null, date: 'nope' }), '<p>x</p>');
    expect(html).toContain('wrote:');
    expect(html).toContain('<p>x</p>');
  });

  it('escapes a hostile display name', () => {
    const html = quoteForReply(msg({ from: { addr: 'x@y.com', name: '<script>bad()</script>' } }), '');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('quoteForForward', () => {
  it('emits the forwarded-message header block', () => {
    const html = quoteForForward(msg(), '<p>Body copy</p>');
    expect(html).toContain('---------- Forwarded message ----------');
    expect(html).toContain('From:');
    expect(html).toContain('Date:');
    expect(html).toContain('Subject:');
    expect(html).toContain('To:');
    expect(html).toContain('Roof detail');
    expect(html).toContain('noah@birchwoodplaster.example');
    expect(html).toContain('<p>Body copy</p>');
  });
});

describe('replyAllRecipients', () => {
  it('puts the sender and original To on To, keeps Cc, and drops our own addresses', () => {
    const { to, cc } = replyAllRecipients(msg(), ['NOAH@birchwoodplaster.example']);
    expect(to.map(a => a.addr)).toEqual(['bob@acme.com', 'carol@acme.com']);
    expect(cc.map(a => a.addr)).toEqual(['dave@acme.com']);
  });

  it('dedupes across and within the lists', () => {
    const m = msg({
      to: [{ addr: 'bob@acme.com' }, { addr: 'Carol@acme.com' }, { addr: 'carol@acme.com' }],
      cc: [{ addr: 'CAROL@acme.com' }, { addr: 'dave@acme.com' }],
    });
    const { to, cc } = replyAllRecipients(m, []);
    expect(to.map(a => a.addr.toLowerCase())).toEqual(['bob@acme.com', 'carol@acme.com']);
    expect(cc.map(a => a.addr)).toEqual(['dave@acme.com']);
  });

  it('handles a message with no sender', () => {
    const { to } = replyAllRecipients(msg({ from: null, to: [], cc: [] }), []);
    expect(to).toEqual([]);
  });
});

describe('subjects', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Roof detail')).toBe('Re: Roof detail');
    expect(replySubject('Re: Roof detail')).toBe('Re: Roof detail');
    expect(replySubject('RE: Roof detail')).toBe('RE: Roof detail');
    expect(replySubject('')).toBe('Re:');
  });

  it('prefixes Fwd: once', () => {
    expect(forwardSubject('Roof detail')).toBe('Fwd: Roof detail');
    expect(forwardSubject('Fwd: Roof detail')).toBe('Fwd: Roof detail');
    expect(forwardSubject('FW: Roof detail')).toBe('FW: Roof detail');
  });
});

// The reading pane folds a message's quoted history away (server-side, in
// sanitize.ts) so the reader is not shown a copy of what they already have.
// The SAME html seeds a reply, and the fold must not go out with it: the
// toggle would reach the recipient as a dead button, and `hidden` on the
// holder would strip the whole prior thread from their copy.
describe('expandQuotedHistory', () => {
  const folded = '<p>My answer</p>'
    + '<button type="button" data-mail-quote-toggle="" aria-label="Show trimmed content" style="cursor:pointer">\u22ef</button>'
    + '<div data-mail-quote="" hidden=""><blockquote type="cite">the older thread</blockquote></div>';

  it('drops the toggle and un-hides the history', () => {
    const out = expandQuotedHistory(folded);
    expect(out).not.toContain('data-mail-quote-toggle');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('hidden');
    expect(out).toContain('the older thread');
    expect(out).toContain('<p>My answer</p>');
  });

  it('passes a body with no fold through untouched', () => {
    const plain = '<p>Hello there</p><blockquote>quoted</blockquote>';
    expect(expandQuotedHistory(plain)).toBe(plain);
  });

  it('is applied by both quote builders', () => {
    for (const html of [quoteForReply(msg(), folded), quoteForForward(msg(), folded)]) {
      expect(html).not.toContain('data-mail-quote-toggle');
      expect(html).not.toContain('hidden=""');
      expect(html).toContain('the older thread');
    }
  });
});

describe('splitDraftQuote', () => {
  it('round-trips a reply the composer built: body back to the editor, quote beside it', () => {
    const quote = quoteForReply(msg(), '<p>Original</p>');
    expect(splitDraftQuote('<p>My reply</p>' + quote)).toEqual({ body: '<p>My reply</p>', quote });
  });

  it('leaves a body with no quote of ours entirely in the editor', () => {
    expect(splitDraftQuote('<p>Just text</p>')).toEqual({ body: '<p>Just text</p>', quote: '' });
  });
});
