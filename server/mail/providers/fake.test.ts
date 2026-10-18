import { describe, it, expect } from 'vitest';
import { FakeMailProvider } from './fake';
import { ProviderNotFoundError } from './types';

const env = (id: string, extra: Partial<Parameters<FakeMailProvider['seed']>[0][number]> = {}) => ({
  providerMessageId: id, references: [], from: { addr: 'x@y' }, to: [], cc: [], bcc: [], subject: 's', snippet: '', date: '2026-08-01T00:00:00.000Z',
  isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 1, folderProviderIds: ['INBOX'], ...extra,
});

describe('FakeMailProvider', () => {
  it('backfills seeded messages after `since` and reports done', async () => {
    const p = new FakeMailProvider();
    p.seed([env('a', { date: '2026-01-01T00:00:00.000Z' }), env('b', { date: '2026-08-01T00:00:00.000Z' })]);
    const r = await p.backfill({ since: new Date('2026-06-01') });
    expect(r.messages.map(m => m.providerMessageId)).toEqual(['b']); expect(r.done).toBe(true);
  });
  it('incremental returns injected messages once', async () => {
    const p = new FakeMailProvider(); p.seed([]);
    let s = (await p.incremental({})).state;
    p.injectInbound(env('n1'));
    const r = await p.incremental(s); expect(r.upserts.map(m => m.providerMessageId)).toEqual(['n1']); s = r.state;
    expect((await p.incremental(s)).upserts).toEqual([]);
  });
  it('send records the message and makes it fetchable', async () => {
    const p = new FakeMailProvider(); p.seed([]);
    const r = await p.send({ from: { addr: 'me@x' }, to: [{ addr: 'y@z' }], cc: [], bcc: [], subject: 'hi', html: '<b>hi</b>', text: 'hi', attachments: [], messageIdHeader: 'mid@x' });
    expect(p.sent.length).toBe(1);
    expect((await p.getBody(r.providerMessageId)).html).toBe('<b>hi</b>');
  });
  it('gmailAttachmentIds rotates ids on every body read and counts the reads', async () => {
    const p = new FakeMailProvider();
    p.seed([env('a', { attachments: [{ attId: 'x', name: 'x.pdf', mime: 'application/pdf', size: 1 }] })]);
    p.gmailAttachmentIds = true;
    expect((await p.getBody('a')).attachments[0].attId).toBe('x-gen1');
    expect((await p.getBody('a')).attachments[0].attId).toBe('x-gen2');
    // The current id resolves without a read; a stale one without a hint costs
    // a read (which rotates again) and still misses; with a hint it misses
    // outright, no read.
    expect((await p.getAttachment('a', 'x-gen2')).name).toBe('x.pdf');
    expect(p.bodyReads).toBe(2);
    await expect(p.getAttachment('a', 'x-gen1')).rejects.toBeInstanceOf(ProviderNotFoundError);
    expect(p.bodyReads).toBe(3);
    await expect(p.getAttachment('a', 'x-gen1', { name: 'x.pdf', mime: 'application/pdf' })).rejects.toBeInstanceOf(ProviderNotFoundError);
    expect(p.bodyReads).toBe(3);
  });
  it('failNextWith throws once', async () => {
    const p = new FakeMailProvider(); p.seed([]);
    p.failNextWith(new Error('boom'));
    await expect(p.listFolders()).rejects.toThrow('boom');
    await expect(p.listFolders()).resolves.toBeTruthy();
  });
});
