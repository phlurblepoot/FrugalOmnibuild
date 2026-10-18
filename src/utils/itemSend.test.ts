// src/utils/itemSend.test.ts
import { describe, it, expect } from 'vitest';
import { itemSendPayload } from './itemSend';
import type { SendRequest } from '../pages/mail/types';

const req = (over: Partial<SendRequest> = {}): SendRequest => ({
  to: [{ addr: 'client@example.com' }],
  subject: 'Invoice 12',
  html: '<p>Attached</p>',
  attachments: [],
  ...over,
});

describe('itemSendPayload', () => {
  it('joins the structured recipients back into the strings the routes take', () => {
    const p = itemSendPayload(req({
      to: [{ addr: 'a@b.com', name: 'Ann' }, { addr: 'c@d.com' }],
      cc: [{ addr: 'cc@b.com' }],
      bcc: [{ addr: 'bcc@b.com' }],
    }));
    expect(p.to).toBe('"Ann" <a@b.com>, c@d.com');
    expect(p.cc).toBe('cc@b.com');
    expect(p.bcc).toBe('bcc@b.com');
  });

  it('omits empty cc/bcc rather than sending blank strings', () => {
    const p = itemSendPayload(req({ cc: [], bcc: undefined }));
    expect(p.cc).toBeUndefined();
    expect(p.bcc).toBeUndefined();
  });

  it('carries the composer html, not a plain body', () => {
    expect(itemSendPayload(req({ html: '<p>hi <b>there</b></p>' })).html).toBe('<p>hi <b>there</b></p>');
  });

  // Both attachment kinds have to survive: a document already in the app and a
  // file the user dragged in. Dropping either would lose it silently.
  it('splits stored documents from staged uploads', () => {
    const p = itemSendPayload(req({
      attachments: [{ fileId: 'f1', name: 'a.pdf' }, { uploadId: 'u1' }, { fileId: 'f2' }],
    }));
    expect(p.attachmentFileIds).toEqual(['f1', 'f2']);
    expect(p.uploadIds).toEqual(['u1']);
  });

  it('passes the thread and account choices through', () => {
    const p = itemSendPayload(req({ replyTo: { accountId: 'a1', threadKey: 'k' }, accountId: 'a1' }));
    expect(p.replyTo).toEqual({ accountId: 'a1', threadKey: 'k' });
    expect(p.accountId).toBe('a1');
  });

  it('leaves replyTo/accountId off when the composer resolved neither', () => {
    const p = itemSendPayload(req());
    expect('replyTo' in p).toBe(false);
    expect('accountId' in p).toBe(false);
  });
});
