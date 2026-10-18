// server/mail/providers/microsoft.test.ts
// Every Graph call goes through an injected `fetch`, so the whole provider is
// exercised against recorded API shapes without a network or a real tenant.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GraphProvider, microsoftRefresh } from './microsoft';
import { TokenSource } from './tokenSource';
import { AuthExpiredError, RateLimitedError, ProviderNotFoundError } from './types';
import type { Envelope, MailProvider, OutgoingMessage } from './types';

const fx = (n: string): any => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./__fixtures__/${n}`, import.meta.url)), 'utf8'));

type Route = [RegExp, (url: string, init: any) => unknown];
type FakeFetch = typeof fetch & { calls: Array<{ url: string; init: any }> };

function fakeFetch(routes: Route[]): FakeFetch {
  const calls: Array<{ url: string; init: any }> = [];
  const f = async (url: string, init: any = {}): Promise<Response> => {
    calls.push({ url, init });
    for (const [re, h] of routes) {
      if (!re.test(url)) continue;
      const r = h(url, init);
      return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"error":{"code":"ErrorItemNotFound"}}', { status: 404 });
  };
  return Object.assign(f as unknown as typeof fetch, { calls });
}

const tokens = (): TokenSource => new TokenSource({ refreshToken: 'r', refresh: async () => ({ accessToken: 'AT', expiresInSec: 3600 }) });
// The sent-items read-back backs off between attempts; no test should spend
// real seconds on that, so the wait is injected and recorded instead.
const provider = (f: typeof fetch, slept?: number[]): GraphProvider =>
  new GraphProvider(tokens(), { fetch: f, sleep: async ms => { slept?.push(ms); } });

const outgoing = (): OutgoingMessage => ({
  from: { addr: 'me@x' }, to: [{ addr: 'y@z', name: 'Why Zed' }], cc: [], bcc: [],
  subject: 's', html: '<p>h</p>', text: 'h', attachments: [], messageIdHeader: 'mid@x',
});

/** The sent-items read-back only trusts a copy sent within the last minute, so
 *  the recorded row has to be re-stamped with "now" for every test that uses it. */
const sentItemsNow = (over: Record<string, unknown> = {}): unknown => {
  const base = fx('graph-sentitems.json');
  return { ...base, value: [{ ...base.value[0], sentDateTime: new Date().toISOString(), ...over }] };
};

const FOLDER_ROUTES: Route[] = [
  [/\/me\/mailFolders\/AAMkFolderInbox\/childFolders/, () => fx('graph-child-folders.json')],
  [/\/me\/mailFolders\?/, () => fx('graph-folders.json')],
];

/** delta answers with the recorded page for the inbox and an empty (but
 *  terminated) page for every other folder, so assertions stay about the inbox. */
const deltaRoute = (page: () => unknown): Route => [
  /\/messages\/delta/,
  url => (/AAMkFolderInbox\//.test(url) ? page() : { value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/x/messages/delta?$deltatoken=EMPTY` }),
];

async function drainBackfill(p: GraphProvider, since: Date): Promise<Envelope[]> {
  const all: Envelope[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const r = await p.backfill({ since, cursor });
    all.push(...r.messages);
    cursor = r.cursor;
    if (r.done) return all;
  }
  throw new Error('backfill never reported done');
}

describe('GraphProvider', () => {
  it('lists mail folders (one level of children) with roles from wellKnownName', async () => {
    const f = fakeFetch(FOLDER_ROUTES);
    const folders = await provider(f).listFolders();

    expect(folders.find(x => x.providerId === 'AAMkFolderInbox')).toMatchObject({ name: 'Inbox', role: 'inbox', unreadCount: 7, totalCount: 4210 });
    expect(folders.find(x => x.providerId === 'AAMkFolderSent')!.role).toBe('sent');
    expect(folders.find(x => x.providerId === 'AAMkFolderDrafts')!.role).toBe('drafts');
    expect(folders.find(x => x.providerId === 'AAMkFolderDeleted')!.role).toBe('trash');
    expect(folders.find(x => x.providerId === 'AAMkFolderJunk')!.role).toBe('spam');
    expect(folders.find(x => x.providerId === 'AAMkFolderArchive')!.role).toBe('archive');
    expect(folders.find(x => x.providerId === 'AAMkFolderBids')).toMatchObject({ name: 'Bids', role: null });
    // A child folder is listed under its parent's name so two "Tidewater" folders in
    // different parents stay distinguishable.
    expect(folders.find(x => x.providerId === 'AAMkFolderInboxTidewater')).toMatchObject({ name: 'Inbox/Tidewater', role: null });
    // Inbox first regardless of the order Graph listed the folders in.
    expect(folders[0].providerId).toBe('AAMkFolderInbox');
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer AT');
    // Only the folder that says it has children is asked for them.
    expect(f.calls.filter(c => /childFolders/.test(c.url)).length).toBe(1);
  });

  it('backfill walks each folder delta with a receivedDateTime filter and maps messages to envelopes', async () => {
    const f = fakeFetch([
      ...FOLDER_ROUTES,
      [/\/me\/messages\/m1\/attachments/, () => fx('graph-attachments.json')],
      deltaRoute(() => fx('graph-delta-initial.json')),
    ]);
    const msgs = await drainBackfill(provider(f), new Date('2026-03-01T00:00:00.000Z'));

    const initial = f.calls.find(c => /messages\/delta/.test(c.url))!;
    expect(initial.url).toMatch(/\$filter=receivedDateTime%20ge%202026-03-01T00%3A00%3A00\.000Z/);
    expect(initial.url).toMatch(/\$select=id%2CconversationId%2CinternetMessageId/);
    // Junk and deleted items are never indexed.
    expect(f.calls.some(c => /AAMkFolderJunk|AAMkFolderDeleted/.test(c.url) && /delta/.test(c.url))).toBe(false);

    const m = msgs.find(x => x.providerMessageId === 'm1')!;
    expect(m).toMatchObject({
      providerThreadId: 't1',
      subject: 'Re: COR-4 Level 6 revisions',
      isRead: false, isStarred: true, isDraft: false,
      folderProviderIds: ['AAMkFolderInbox'],
    });
    expect(m.messageIdHeader).toBe('as8pr01mb1234.eurprd01.prod.outlook.com');
    expect(m.inReplyTo).toBe('reply-2@tidewater.example');
    expect(m.references).toEqual(['root-1@birchwoodplaster.example', 'reply-2@tidewater.example']);
    expect(m.from).toEqual({ addr: 'mike@tidewater.example', name: 'Mike Ross' });
    expect(m.to).toEqual([{ addr: 'me@x' }]);                       // an empty name is dropped
    expect(m.cc.map(a => a.addr)).toEqual(['ap@tidewater.example', 'pm@tidewater.example']);
    expect(m.cc[1]).toEqual({ addr: 'pm@tidewater.example' });                // name === address is noise
    expect(m.date).toBe('2026-08-10T14:22:05.000Z');
    expect(m.snippet).toContain('COR-4');
    expect(m.attachments.map(a => a.name)).toEqual(['COR-4.pdf', 'signature.png']);
    expect(m.attachments[1]).toMatchObject({ attId: 'ATT-SIG', mime: 'image/png', size: 4211, contentId: 'ii_sig_001' });

    // m2 says hasAttachments:false, so it must not cost an attachments request.
    const m2 = msgs.find(x => x.providerMessageId === 'm2')!;
    expect(m2).toMatchObject({ isRead: true, isStarred: false, references: [], attachments: [] });
    expect(m2.inReplyTo).toBeUndefined();
    expect(f.calls.some(c => /\/m2\/attachments/.test(c.url))).toBe(false);
  });

  it('backfill follows @odata.nextLink before moving on to the next folder', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMkFolderInbox/messages/delta?$skiptoken=S2';
    let page = 0;
    const f = fakeFetch([
      ...FOLDER_ROUTES,
      [/\/me\/messages\/m1\/attachments/, () => fx('graph-attachments.json')],
      deltaRoute(() => (page++ === 0
        ? { value: fx('graph-delta-initial.json').value, '@odata.nextLink': nextLink }
        : fx('graph-delta-initial.json'))),
    ]);
    const p = provider(f);
    const first = await p.backfill({ since: new Date('2026-03-01T00:00:00.000Z') });
    expect(first.done).toBe(false);
    expect(first.cursor).toBeTruthy();
    const second = await p.backfill({ since: new Date('2026-03-01T00:00:00.000Z'), cursor: first.cursor });
    expect(second.messages.length).toBe(2);
    expect(f.calls.some(c => c.url === nextLink)).toBe(true);
  });

  it('incremental after a backfill adopts the delta links it collected, without refetching', async () => {
    const f = fakeFetch([...FOLDER_ROUTES, deltaRoute(() => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMkFolderInbox/messages/delta?$deltatoken=D1' }))]);
    const p = provider(f);
    await drainBackfill(p, new Date('2026-03-01T00:00:00.000Z'));
    const before = f.calls.length;
    const r = await p.incremental({});

    expect(r.upserts).toEqual([]);
    expect(r.deletes).toEqual([]);
    expect((r.state as any).deltaLinks.AAMkFolderInbox).toMatch(/\$deltatoken=D1/);
    expect(f.calls.length).toBe(before);                            // adoption is free
  });

  it('incremental with no state and no backfill establishes delta links from now', async () => {
    const f = fakeFetch([...FOLDER_ROUTES, deltaRoute(() => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMkFolderInbox/messages/delta?$deltatoken=DNOW' }))]);
    const r = await provider(f).incremental({});
    expect((r.state as any).deltaLinks.AAMkFolderInbox).toMatch(/DNOW/);
    expect(f.calls.some(c => /messages\/delta/.test(c.url) && /\$filter=receivedDateTime%20ge/.test(c.url))).toBe(true);
  });

  it('incremental upserts changed messages, applies @removed as deletes, and stores the new deltaLink', async () => {
    const f = fakeFetch([
      ...FOLDER_ROUTES,
      [/\$deltatoken=D1/, () => fx('graph-delta-incremental.json')],
      deltaRoute(() => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/x/messages/delta?$deltatoken=EMPTY' })),
    ]);
    const r = await provider(f).incremental({ deltaLinks: { AAMkFolderInbox: 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMkFolderInbox/messages/delta?$deltatoken=D1' } });

    expect(r.upserts.map(u => u.providerMessageId)).toEqual(['m2']);
    expect(r.upserts[0]).toMatchObject({ isRead: false, isStarred: true });
    expect(r.deletes).toEqual(['m0']);
    expect((r.state as any).deltaLinks.AAMkFolderInbox).toMatch(/\$deltatoken=D2/);
    expect(r.reset).toBeFalsy();
    // A folder that appeared since the last poll gets its own baseline link.
    expect((r.state as any).deltaLinks.AAMkFolderBids).toMatch(/EMPTY/);
  });

  it('incremental returns reset when Graph has expired the delta token', async () => {
    const f = fakeFetch([
      ...FOLDER_ROUTES,
      [/\$deltatoken=OLD/, () => new Response('{"error":{"code":"syncStateNotFound"}}', { status: 410 })],
    ]);
    const r = await provider(f).incremental({ deltaLinks: { AAMkFolderInbox: 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMkFolderInbox/messages/delta?$deltatoken=OLD' } });
    expect(r.reset).toBe(true);
    expect(r.upserts).toEqual([]);
    expect(r.state).toEqual({ deltaLinks: {} });
  });

  it('getBody asks for HTML with a Prefer header and lists attachments; getAttachment streams $value', async () => {
    const f = fakeFetch([
      [/\/me\/messages\/m1\/attachments\/ATT-COR4\/\$value/, () => new Response(Buffer.from('%PDF'), { headers: { 'content-length': '4' } })],
      [/\/me\/messages\/m1\/attachments/, () => fx('graph-attachments.json')],
      [/\/me\/messages\/m1\?/, () => fx('graph-message-body.json')],
    ]);
    const p = provider(f);
    const b = await p.getBody('m1');

    expect(f.calls[0].url).toMatch(/\$select=body%2CuniqueBody/);
    expect(f.calls[0].init.headers.Prefer).toBe('outlook.body-content-type="html"');
    expect(b.html).toContain('<b>COR-4</b>');
    expect(b.text).toContain('Mike here');
    expect(b.attachments.map(a => a.name)).toEqual(['COR-4.pdf', 'signature.png']);

    const a = await p.getAttachment('m1', 'ATT-COR4');
    const chunks: Buffer[] = [];
    for await (const c of a.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('%PDF');
    expect(a).toMatchObject({ mime: 'application/pdf', name: 'COR-4.pdf', size: 88231 });
  });

  it('getAttachment fetches the attachment list itself when getBody was never called', async () => {
    const f = fakeFetch([
      [/\/attachments\/ATT-SIG\/\$value/, () => new Response(Buffer.from('PNG'))],
      [/\/me\/messages\/m1\/attachments/, () => fx('graph-attachments.json')],
    ]);
    expect((await provider(f).getAttachment('m1', 'ATT-SIG')).name).toBe('signature.png');
    await expect(provider(f).getAttachment('m1', 'nope')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it('setFlags PATCHes isRead and the flag in one call per message', async () => {
    const f = fakeFetch([[/\/me\/messages\/m\d$/, () => ({})]]);
    const p = provider(f);
    await p.setFlags(['m1', 'm2'], { read: true, starred: true });
    expect(f.calls.map(c => c.init.method)).toEqual(['PATCH', 'PATCH']);
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ isRead: true, flag: { flagStatus: 'flagged' } });

    await p.setFlags(['m1'], { read: false, starred: false });
    expect(JSON.parse(f.calls[2].init.body)).toEqual({ isRead: false, flag: { flagStatus: 'notFlagged' } });

    const before = f.calls.length;
    await p.setFlags(['m1'], {});
    expect(f.calls.length).toBe(before);                            // nothing to change → no request
  });

  it('move/archive/trash POST /move and report the new id Graph assigns', async () => {
    const f = fakeFetch([[/\/me\/messages\/m1\/move$/, () => ({ id: 'moved-1', parentFolderId: 'AAMkFolderBids' })]]);
    const p = provider(f);

    expect(await p.move(['m1'], 'AAMkFolderBids')).toEqual([{ from: 'm1', to: 'moved-1' }]);
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ destinationId: 'AAMkFolderBids' });
    expect(await p.archive(['m1'])).toEqual([{ from: 'm1', to: 'moved-1' }]);
    expect(JSON.parse(f.calls[1].init.body)).toEqual({ destinationId: 'archive' });
    expect(await p.trash(['m1'])).toEqual([{ from: 'm1', to: 'moved-1' }]);
    expect(JSON.parse(f.calls[2].init.body)).toEqual({ destinationId: 'deleteditems' });

    // A move that answers without an id still has to map the pair.
    const quiet = fakeFetch([[/\/move$/, () => new Response(null, { status: 204 })]]);
    expect(await provider(quiet).move(['m1'], 'AAMkFolderBids')).toEqual([{ from: 'm1', to: null }]);
  });

  it('a new message goes out through sendMail and reads its real id back from Sent Items', async () => {
    const f = fakeFetch([
      [/\/me\/sendMail$/, () => new Response(null, { status: 202 })],
      [/\/me\/mailFolders\/sentitems\/messages\?/, () => sentItemsNow()],
    ]);
    const r = await provider(f).send(outgoing());

    const body = JSON.parse(f.calls[0].init.body);
    expect(body.saveToSentItems).toBe(true);
    expect(body.message).toMatchObject({
      subject: 's',
      body: { contentType: 'HTML', content: '<p>h</p>' },
      toRecipients: [{ emailAddress: { address: 'y@z', name: 'Why Zed' } }],
      ccRecipients: [], bccRecipients: [],
    });
    // Graph refuses to set Message-ID/In-Reply-To, but a custom x- header is
    // allowed and is what makes the sent copy findable without guessing.
    expect(body.message.internetMessageHeaders).toEqual([{ name: 'x-frugal-message-id', value: 'mid@x' }]);
    expect(f.calls[1].url).toMatch(/\$orderby=sentDateTime%20desc/);
    expect(r).toEqual({
      providerMessageId: 'SENT-1',
      providerThreadId: 't9',
      messageIdHeader: 'as8pr01mb9999.eurprd01.prod.outlook.com',
    });
  });

  it('send falls back to a sent: placeholder when the sent copy cannot be found', async () => {
    const f = fakeFetch([
      [/\/me\/sendMail$/, () => new Response(null, { status: 202 })],
      // Same folder, but nothing that matches this send (stale subject, old date).
      [/sentitems\/messages\?/, () => ({ value: [{ id: 'OTHER', subject: 'something else', sentDateTime: '2020-01-01T00:00:00Z' }] })],
    ]);
    expect(await provider(f).send(outgoing())).toEqual({ providerMessageId: 'sent:mid@x' });

    // A read-back that outright fails must not fail the send either.
    const broken = fakeFetch([[/\/me\/sendMail$/, () => new Response(null, { status: 202 })]]);
    expect(await provider(broken).send(outgoing())).toEqual({ providerMessageId: 'sent:mid@x' });
  });

  it('retries the sent-items read-back, because Exchange files the copy after it answers 202', async () => {
    let look = 0;
    const f = fakeFetch([
      [/\/me\/sendMail$/, () => new Response(null, { status: 202 })],
      // Not filed yet on the first look — the race a single read-back loses.
      [/sentitems\/messages\?/, () => (look++ === 0 ? { value: [] } : sentItemsNow())],
    ]);
    const slept: number[] = [];
    expect((await provider(f, slept).send(outgoing())).providerMessageId).toBe('SENT-1');
    expect(look).toBe(2);
    expect(slept).toEqual([500]);

    // Four attempts in all, then the placeholder.
    const never = fakeFetch([
      [/\/me\/sendMail$/, () => new Response(null, { status: 202 })],
      [/sentitems\/messages\?/, () => ({ value: [] })],
    ]);
    const waits: number[] = [];
    expect((await provider(never, waits).send(outgoing())).providerMessageId).toBe('sent:mid@x');
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it('a reply is built with createReply so Graph writes the threading headers itself', async () => {
    const f = fakeFetch([
      [/\/me\/messages\?\$filter=internetMessageId/, () => ({ value: [{ id: 'p1', conversationId: 't1' }] })],
      [/\/me\/messages\/p1\/createReply$/, () => ({ id: 'd1', conversationId: 't1' })],
      [/\/me\/messages\/d1\/attachments$/, () => ({ id: 'a1' })],
      [/\/me\/messages\/d1\/send$/, () => new Response(null, { status: 202 })],
      [/\/me\/messages\/d1$/, () => ({ id: 'd1' })],
      [/sentitems\/messages\?/, () => sentItemsNow({ subject: 'Re: COR-4' })],
    ]);
    const r = await provider(f).send({
      ...outgoing(), subject: 'Re: COR-4', inReplyTo: 'root-1@birchwoodplaster.example', references: ['root-1@birchwoodplaster.example'],
      attachments: [{ name: 'COR-4.pdf', mime: 'application/pdf', content: Buffer.from('%PDF') }],
    });

    expect(f.calls[0].url).toContain("internetMessageId%20eq%20'%3Croot-1%40birchwoodplaster.example%3E'");
    expect(f.calls.map(c => `${c.init.method ?? 'GET'} ${c.url.replace(/^.*\/v1\.0\//, '').split('?')[0]}`)).toEqual([
      'GET me/messages',
      'POST me/messages/p1/createReply',
      'PATCH me/messages/d1',
      'POST me/messages/d1/attachments',
      'POST me/messages/d1/send',
      'GET me/mailFolders/sentitems/messages',
    ]);
    expect(JSON.parse(f.calls[2].init.body)).toMatchObject({ subject: 'Re: COR-4', body: { contentType: 'HTML', content: '<p>h</p>' } });
    expect(JSON.parse(f.calls[3].init.body)).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'COR-4.pdf', contentType: 'application/pdf', contentBytes: Buffer.from('%PDF').toString('base64'), isInline: false,
    });
    expect(r).toMatchObject({ providerMessageId: 'SENT-1', providerThreadId: 't9' });
  });

  it('names the sent: placeholder it replaces when its own correlation header comes back on a sync', async () => {
    const base = fx('graph-delta-initial.json');
    const sent = {
      ...base.value[1], id: 'AAMkRealSentId', parentFolderId: 'AAMkFolderSent',
      internetMessageId: '<AS8PR01MB9999.EURPRD01.PROD.OUTLOOK.COM>',
      internetMessageHeaders: [{ name: 'x-frugal-message-id', value: 'mid@x' }],
    };
    const f = fakeFetch([
      ...FOLDER_ROUTES,
      deltaRoute(() => ({ value: [sent], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMkFolderInbox/messages/delta?$deltatoken=D3' })),
    ]);
    const msgs = await drainBackfill(provider(f), new Date('2026-03-01T00:00:00.000Z'));

    // Graph rewrote the Message-ID, so the header cannot tie these two together
    // — the correlation header we set on the way out is what does.
    const m = msgs.find(x => x.providerMessageId === 'AAMkRealSentId')!;
    expect(m.messageIdHeader).toBe('as8pr01mb9999.eurprd01.prod.outlook.com');
    expect(m.replacesProviderMessageId).toBe('sent:mid@x');
    // An ordinary inbound message names nothing.
    expect(msgs.every(x => x.providerMessageId === 'AAMkRealSentId' || x.replacesProviderMessageId === undefined)).toBe(true);
  });

  it('a reply finds its sent copy by conversation, not by a subject two messages can share', async () => {
    const f = fakeFetch([
      [/\/me\/messages\?\$filter=internetMessageId/, () => ({ value: [{ id: 'p1', conversationId: 't1' }] })],
      [/\/createReply$/, () => ({ id: 'd1' })],
      [/\/me\/messages\/d1\/send$/, () => new Response(null, { status: 202 })],
      [/\/me\/messages\/d1$/, () => ({ id: 'd1' })],
      [/sentitems\/messages\?/, () => ({
        value: [
          // A different message, same subject, sent moments ago — the trap.
          { id: 'DECOY', subject: 'Re: COR-4', conversationId: 'tOTHER', sentDateTime: new Date().toISOString() },
          { id: 'SENT-REPLY', subject: 'Re: COR-4', conversationId: 't1', internetMessageId: '<real@outlook.com>', sentDateTime: new Date().toISOString() },
        ],
      })],
    ]);
    expect(await provider(f).send({ ...outgoing(), subject: 'Re: COR-4', inReplyTo: 'root-1@birchwoodplaster.example' }))
      .toEqual({ providerMessageId: 'SENT-REPLY', providerThreadId: 't1', messageIdHeader: 'real@outlook.com' });
  });

  it('a reply whose parent is not in this mailbox still sends, through sendMail', async () => {
    const f = fakeFetch([
      [/\/me\/messages\?\$filter=internetMessageId/, () => ({ value: [] })],
      [/\/me\/sendMail$/, () => new Response(null, { status: 202 })],
      [/sentitems\/messages\?/, () => sentItemsNow()],
    ]);
    expect((await provider(f).send({ ...outgoing(), inReplyTo: 'elsewhere@x.com' })).providerMessageId).toBe('SENT-1');
    expect(f.calls.some(c => /createReply/.test(c.url))).toBe(false);
  });

  it('a reply deletes its half-built draft when a later step fails, and refuses an oversize attachment', async () => {
    const f = fakeFetch([
      [/\$filter=internetMessageId/, () => ({ value: [{ id: 'p1', conversationId: 't1' }] })],
      [/\/createReply$/, () => ({ id: 'd1' })],
      [/\/me\/messages\/d1\/send$/, () => new Response('{"error":{"code":"ErrorSendFailed"}}', { status: 500 })],
      [/\/me\/messages\/d1$/, () => new Response(null, { status: 204 })],
    ]);
    await expect(provider(f).send({ ...outgoing(), inReplyTo: 'root-1@birchwoodplaster.example' })).rejects.toThrow(/Graph 500/);
    expect(f.calls.some(c => /\/me\/messages\/d1$/.test(c.url) && c.init.method === 'DELETE')).toBe(true);

    // The size check runs before anything is sent, so an oversize attachment
    // costs no request at all — there is no draft left to clean up.
    const big = fakeFetch([[/./, () => ({})]]);
    await expect(provider(big).send({
      ...outgoing(), inReplyTo: 'root-1@birchwoodplaster.example',
      attachments: [{ name: 'huge.pdf', mime: 'application/pdf', content: Buffer.alloc(4 * 1024 * 1024) }],
    })).rejects.toThrow(/huge\.pdf.*3 MB/);
    expect(big.calls).toEqual([]);
  });

  it('drafts round-trip: create, update in place, reconcile attachments, delete', async () => {
    const f = fakeFetch([
      [/\/me\/messages\/d1\/attachments\/OLD$/, () => new Response(null, { status: 204 })],
      [/\/me\/messages\/d1\/attachments(\?|$)/, (_u, init) => (init.method === 'POST' ? { id: 'a2' } : { value: [{ id: 'OLD', name: 'gone.pdf', contentType: 'application/pdf', size: 10 }] })],
      [/\/me\/messages\/d1$/, (_u, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : { id: 'd1' })],
      [/\/me\/messages$/, () => ({ id: 'd1', conversationId: 't5' })],
    ]);
    const p = provider(f);

    expect(await p.saveDraft(outgoing())).toEqual({ providerMessageId: 'd1' });
    expect(f.calls[0].init.method).toBe('POST');
    expect(JSON.parse(f.calls[0].init.body)).toMatchObject({ subject: 's', body: { contentType: 'HTML', content: '<p>h</p>' } });

    const before = f.calls.length;
    expect(await p.saveDraft({ ...outgoing(), attachments: [{ name: 'new.pdf', mime: 'application/pdf', content: Buffer.from('%PDF') }] }, 'd1'))
      .toEqual({ providerMessageId: 'd1' });
    const after = f.calls.slice(before).map(c => `${c.init.method ?? 'GET'} ${c.url.replace(/^.*\/v1\.0\//, '').split('?')[0]}`);
    expect(after).toEqual([
      'PATCH me/messages/d1',
      'GET me/messages/d1/attachments',
      'DELETE me/messages/d1/attachments/OLD',                      // dropped since the last save
      'POST me/messages/d1/attachments',                            // newly added
    ]);

    await p.deleteDraft('d1');
    expect(f.calls[f.calls.length - 1].init.method).toBe('DELETE');
    // A draft already discarded elsewhere is not an error.
    await expect(p.deleteDraft('gone')).resolves.toBeUndefined();
  });

  it('a new reply draft is built with createReply so it sits in the parent conversation', async () => {
    const f = fakeFetch([
      [/\/me\/messages\?\$filter=internetMessageId/, () => ({ value: [{ id: 'p1', conversationId: 't1' }] })],
      [/\/me\/messages\/p1\/createReply$/, () => ({ id: 'rd1', conversationId: 't1' })],
      [/\/me\/messages\/rd1\/attachments$/, () => ({ id: 'a1' })],
      [/\/me\/messages\/rd1$/, () => ({ id: 'rd1' })],
      [/\/me\/messages$/, () => { throw new Error('a reply draft must not be created standalone'); }],
    ]);
    const r = await provider(f).saveDraft({
      ...outgoing(), subject: 'Re: COR-4', inReplyTo: 'root-1@birchwoodplaster.example', references: ['root-1@birchwoodplaster.example'],
      attachments: [{ name: 'COR-4.pdf', mime: 'application/pdf', content: Buffer.from('%PDF') }],
    });
    expect(r).toEqual({ providerMessageId: 'rd1' });
    expect(f.calls.map(c => `${c.init.method ?? 'GET'} ${c.url.replace(/^.*\/v1\.0\//, '').split('?')[0]}`)).toEqual([
      'GET me/messages',
      'POST me/messages/p1/createReply',
      'PATCH me/messages/rd1',
      'POST me/messages/rd1/attachments',
    ]);
  });

  it('saveDraft writes a new draft when the one it was updating is gone', async () => {
    const f = fakeFetch([
      [/\/me\/messages\/gone$/, () => new Response('{}', { status: 404 })],
      [/\/me\/messages$/, () => ({ id: 'd9' })],
    ]);
    expect(await provider(f).saveDraft(outgoing(), 'gone')).toEqual({ providerMessageId: 'd9' });
    expect(f.calls.map(c => c.init.method)).toEqual(['PATCH', 'POST']);

    // A PATCH that succeeds with a bare 204 is still a successful save — reading
    // the empty body as "gone" would fork the draft into a second copy.
    const quiet = fakeFetch([
      [/\/me\/messages\/d4\/attachments/, () => ({ value: [] })],
      [/\/me\/messages\/d4$/, () => new Response(null, { status: 204 })],
      [/\/me\/messages$/, () => { throw new Error('a live draft must not be duplicated'); }],
    ]);
    expect(await provider(quiet).saveDraft(outgoing(), 'd4')).toEqual({ providerMessageId: 'd4' });
  });

  it('search uses $search and filters `before` on the client', async () => {
    const f = fakeFetch([
      [/\/me\/messages\/m1\/attachments/, () => fx('graph-attachments.json')],
      [/\/me\/messages\?/, () => ({ value: fx('graph-delta-initial.json').value })],
    ]);
    const hits = await provider(f).search('cor-4', { before: new Date('2026-08-11T00:00:00.000Z'), limit: 25 });
    expect(f.calls[0].url).toMatch(/\$search=%22cor-4%22/);
    expect(f.calls[0].url).toMatch(/\$top=25/);
    // m2 arrived after the `before` cutoff, so only m1 survives.
    expect(hits.map(h => h.providerMessageId)).toEqual(['m1']);
  });

  it('creates and renews a change subscription for push', async () => {
    const f = fakeFetch([[/\/subscriptions/, () => ({ id: 'sub1', expirationDateTime: '2026-08-31T00:00:00Z' })]]);
    const p = provider(f);
    expect(await p.createSubscription('https://app/x/hook', 'CS', '2026-08-31T00:00:00Z')).toEqual({ id: 'sub1', expirationDateTime: '2026-08-31T00:00:00Z' });
    expect(JSON.parse(f.calls[0].init.body)).toMatchObject({
      changeType: 'created,updated,deleted', notificationUrl: 'https://app/x/hook',
      resource: '/me/messages', clientState: 'CS', expirationDateTime: '2026-08-31T00:00:00Z',
    });
    await p.renewSubscription('sub1', '2026-09-01T00:00:00Z');
    expect(f.calls[1]).toMatchObject({ url: expect.stringContaining('/subscriptions/sub1'), init: { method: 'PATCH' } });
    expect(JSON.parse(f.calls[1].init.body)).toEqual({ expirationDateTime: '2026-09-01T00:00:00Z' });
    // Push itself is the webhook's job, not a socket this provider holds open.
    expect((p as MailProvider).startPush).toBeUndefined();
  });

  it('401 → invalidate + retry once, then AuthExpiredError; 429/503 → RateLimitedError', async () => {
    let n = 0;
    const f = fakeFetch([[/mailFolders\?/, () => new Response('{}', { status: n++ < 5 ? 401 : 200 })]]);
    await expect(provider(f).listFolders()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(n).toBe(2);

    let m = 0;
    const once = fakeFetch([[/mailFolders\?/, () => (m++ === 0 ? new Response('{}', { status: 401 }) : fx('graph-folders.json'))], ...FOLDER_ROUTES]);
    expect((await provider(once).listFolders()).length).toBeGreaterThan(0);
    expect(m).toBe(2);

    const limited = fakeFetch([[/mailFolders\?/, () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })]]);
    await expect(provider(limited).listFolders()).rejects.toMatchObject({ retryAfterMs: 30_000 });
    await expect(provider(limited).listFolders()).rejects.toBeInstanceOf(RateLimitedError);
    const unavailable = fakeFetch([[/mailFolders\?/, () => new Response('{}', { status: 503 })]]);
    await expect(provider(unavailable).listFolders()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('every request carries a timeout signal and no error leaks the access token', async () => {
    const f = fakeFetch([[/mailFolders\?/, () => new Response('{"error":{"code":"InternalServerError","message":"boom"}}', { status: 500 })]]);
    await expect(provider(f).listFolders()).rejects.toThrow(/Graph 500/);
    await expect(provider(f).listFolders()).rejects.not.toThrow(/AT/);
    expect(f.calls.every(c => c.init.signal instanceof AbortSignal)).toBe(true);
  });

  it('microsoftRefresh posts the form, returns the rotated refresh token, and honours the tenant', async () => {
    const ok = fakeFetch([[/login\.microsoftonline\.com/, () => ({ access_token: 'A', expires_in: 3599, refresh_token: 'RT2' })]]);
    expect(await microsoftRefresh({ MS_OAUTH_CLIENT_ID: 'i', MS_OAUTH_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv, 'rt', ok))
      .toEqual({ accessToken: 'A', expiresInSec: 3599, refreshToken: 'RT2' });
    expect(ok.calls[0].url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(ok.calls[0].init.body).toContain('grant_type=refresh_token');
    expect(ok.calls[0].init.body).toContain('refresh_token=rt');
    expect(ok.calls[0].init.body).toContain('offline_access');
    expect(ok.calls[0].init.body).toContain('Mail.ReadWrite');

    const tenant = fakeFetch([[/login\.microsoftonline\.com/, () => ({ access_token: 'A', expires_in: 3599 })]]);
    await microsoftRefresh({ MS_OAUTH_CLIENT_ID: 'i', MS_OAUTH_CLIENT_SECRET: 's', MS_OAUTH_TENANT: 'contoso.onmicrosoft.com' } as NodeJS.ProcessEnv, 'rt', tenant);
    expect(tenant.calls[0].url).toContain('/contoso.onmicrosoft.com/oauth2/v2.0/token');

    const bad = fakeFetch([[/token/, () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS50173 expired' }), { status: 400 })]]);
    await expect(microsoftRefresh({ MS_OAUTH_CLIENT_ID: 'i', MS_OAUTH_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv, 'rt', bad)).rejects.toThrow(/invalid_grant/);

    // A 200 with no token must not be cached as an empty Bearer.
    const empty = fakeFetch([[/token/, () => ({ expires_in: 3599 })]]);
    await expect(microsoftRefresh({ MS_OAUTH_CLIENT_ID: 'i', MS_OAUTH_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv, 'rt', empty)).rejects.toThrow(/no access token/);
  });
});
