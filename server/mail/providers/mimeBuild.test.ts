import { describe, it, expect } from 'vitest';
import { buildRawMime } from './mimeBuild';
import type { OutgoingMessage } from './types';

const base: OutgoingMessage = {
  from: { addr: 'me@x.com', name: 'Me' }, to: [{ addr: 'you@y.com' }], cc: [], bcc: [],
  subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', attachments: [], messageIdHeader: 'm@x.com',
};

describe('buildRawMime', () => {
  it('produces a multipart message with headers and attachment', async () => {
    const raw = (await buildRawMime({
      ...base,
      attachments: [{ name: 'a.pdf', mime: 'application/pdf', content: Buffer.from('%PDF') }],
      inReplyTo: 'p@y.com', references: ['r@y.com', 'p@y.com'],
    })).toString();
    expect(raw).toMatch(/^From: "?Me"? <me@x\.com>/m);
    expect(raw).toMatch(/^To: you@y\.com/m);
    expect(raw).toMatch(/^Message-ID: <m@x\.com>/m);
    expect(raw).toMatch(/^In-Reply-To: <p@y\.com>/m);
    expect(raw).toMatch(/^References: <r@y\.com> <p@y\.com>/m);
    expect(raw).toContain('application/pdf');
    expect(raw).toContain('a.pdf');
    expect(raw).toContain('text/html');
    expect(raw).toContain('text/plain');
  });

  it('omits cc/bcc/threading headers when there are none', async () => {
    const raw = (await buildRawMime(base)).toString();
    expect(raw).not.toMatch(/^Cc:/m);
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).not.toMatch(/^In-Reply-To:/m);
    expect(raw).not.toMatch(/^References:/m);
  });

  it('includes cc recipients and inline attachments by content id', async () => {
    const raw = (await buildRawMime({
      ...base,
      cc: [{ addr: 'c@y.com', name: 'Cee' }],
      attachments: [{ name: 'logo.png', mime: 'image/png', content: Buffer.from('PNG'), contentId: 'logo@sig' }],
    })).toString();
    expect(raw).toMatch(/^Cc: "?Cee"? <c@y\.com>/m);
    expect(raw).toMatch(/Content-ID: <logo@sig>/);
  });

  // Bcc must never travel in the message body — the SMTP envelope carries it.
  it('does not leak bcc into the raw headers', async () => {
    const raw = (await buildRawMime({ ...base, bcc: [{ addr: 'secret@y.com' }] })).toString();
    expect(raw).not.toContain('secret@y.com');
  });

  // ...unless the caller asks for it, which only an API with no envelope of
  // ours to read (Gmail's messages/send) ever does.
  it('keeps the Bcc header when keepBcc is set', async () => {
    const raw = (await buildRawMime({ ...base, bcc: [{ addr: 'secret@y.com' }] }, { keepBcc: true })).toString();
    expect(raw).toMatch(/^Bcc: secret@y\.com/m);
  });
});
