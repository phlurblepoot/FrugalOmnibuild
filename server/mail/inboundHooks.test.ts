// server/mail/inboundHooks.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { createRfi, getRfi, markRfiSent, setRfiStatus } from '../rfiStore';
import { MailCrypto } from './crypto';
import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import { createLink } from './links';
import type { MailContext } from './context';
import type { Envelope } from './providers/types';
import { upsertFolders, upsertEnvelopes, clearInboundHooks } from './sync/engine';
import { MailScheduler } from './sync/scheduler';
import { installInboundHooks, resetInboundHooks, rfiPendingReplyHook } from './inboundHooks';
import { Notifier } from '../notifications';

let db: Database.Database; let ctx: MailContext; let acct: accounts.MailAccountRow;
let provider: FakeMailProvider; let events: any[]; let dir: string;
const crypto = new MailCrypto(Buffer.alloc(32, 9));

const THREAD = 'rfi-thread@birchwood.example';
const BODY_TEXT = "Corridor 9ft\n\nOn Aug 26 Noah wrote:\n> RFI attached";

type Seeded = Envelope & { html?: string; text?: string };
const env = (id: string, o: Partial<Seeded> = {}): Seeded => ({
  providerMessageId: id, references: [THREAD], from: { addr: 'gc@tidewater.example', name: 'Mike' }, to: [{ addr: 'me@birchwood.example' }], cc: [], bcc: [],
  subject: 'Re: RFI-001', snippet: 'Corridor 9ft (snippet)', date: '2026-08-28T10:00:00.000Z',
  isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 10,
  folderProviderIds: ['INBOX'], messageIdHeader: id + '@tidewater.example',
  // The "On … wrote:" marker has to survive htmlToText as its OWN line, the way
  // real clients emit it — stripQuotedReply cuts on lines, not on <blockquote>.
  text: BODY_TEXT, html: "<p>Corridor 9ft</p><div>On Aug 26 Noah wrote:</div><blockquote><p>RFI attached</p></blockquote>", ...o,
});

/** Feeds one message through the engine exactly as a sync would: the provider
 *  must know the body, because the hook fetches it. */
function deliver(m: Seeded): void {
  provider.injectInbound(m);
  upsertEnvelopes(ctx, acct, [m]);
}

/** Points the scheduler at a different provider for this test. */
function useProvider(p: unknown): void {
  ctx.providerFactory = () => p as never;
  ctx.scheduler = new MailScheduler(ctx);
}

/** Lets the hook's fire-and-forget capture run to completion. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

function makeSentRfi(): string {
  const { id } = createRfi(db, 'p1', { title: 'Corridor height?' });
  markRfiSent(db, id);
  createLink(db, { threadKey: THREAD, itemType: 'rfi', itemId: id, linkedByUserId: 'u1' });
  return id;
}

beforeEach(() => {
  db = openDb(':memory:'); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ih-'));
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
  createProject(db, { id: 'p1', name: 'Test Project', createdAt: 1, pages: [], takeoffs: [] });
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@birchwood.example', auth: { refreshToken: 'r' }, indexedSince: '2026-06-01T00:00:00.000Z' });
  provider = new FakeMailProvider(); provider.seed([]);
  events = [];
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: e => events.push(e) };
  ctx.scheduler = new MailScheduler(ctx);   // never started: only getProvider() is used
  upsertFolders(db, acct.id, provider.folders);
  clearInboundHooks(); resetInboundHooks();
  installInboundHooks();
});
afterEach(() => { clearInboundHooks(); resetInboundHooks(); db.close(); });

describe('rfi pending-reply inbound hook', () => {
  it('captures a quote-stripped reply on a sent, linked RFI and broadcasts it', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1', { attachments: [{ attId: 'a1', name: 'answer.pdf', mime: 'application/pdf', size: 12 }] }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    const rfi = getRfi(db, rfiId);
    expect(rfi.pendingReply.text).toBe('Corridor 9ft');
    expect(rfi.status).toBe('sent');                       // stays pending review
    expect(rfi.pendingReply.threadKey).toBe(THREAD);
    expect(rfi.pendingReply.accountId).toBe(acct.id);
    expect(rfi.pendingReply.messageIdHeader).toBe('m1@tidewater.example');
    expect(rfi.pendingReply.from).toEqual({ addr: 'gc@tidewater.example', name: 'Mike' });
    expect(rfi.pendingReply.date).toBe('2026-08-28T10:00:00.000Z');
    expect(rfi.pendingReply.attachments).toEqual([{ attId: 'a1', name: 'answer.pdf', mime: 'application/pdf', size: 12 }]);
    expect(rfi.pendingReply.receivedAt).toBeTruthy();
    expect(rfi.pendingReply.mailMessageId).toBe((db.prepare(`SELECT id FROM mail_messages WHERE providerMessageId = 'm1'`).get() as any).id);
    expect(events.filter(e => e.type === 'rfi')).toEqual([{ type: 'rfi', id: rfiId, projectId: 'p1', version: rfi.version, action: 'updated' }]);
  });

  it('falls back to the html body when the provider has no text part', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1', { text: undefined }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(getRfi(db, rfiId).pendingReply.text).toBe('Corridor 9ft');
  });

  it('a second reply replaces the first', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    deliver(env('m2', { text: 'Make it 8ft', date: '2026-08-29T10:00:00.000Z' }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply.text).toBe('Make it 8ft'));
    expect(getRfi(db, rfiId).pendingReply.date).toBe('2026-08-29T10:00:00.000Z');
  });

  it('re-running the hook for the same message does not capture twice', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    const { version } = getRfi(db, rfiId);
    const messageId = (db.prepare(`SELECT id FROM mail_messages WHERE providerMessageId = 'm1'`).get() as any).id;
    rfiPendingReplyHook(ctx, { threadKey: THREAD, messageId, account: acct });
    await settle();
    expect(getRfi(db, rfiId).version).toBe(version);
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(1);
  });

  it('ignores an outbound message from one of our own addresses', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1', { from: { addr: 'me@birchwood.example' } }));
    await settle();
    expect(getRfi(db, rfiId).pendingReply).toBeNull();
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(0);
  });

  it.each(['open', 'answered', 'closed'])('ignores a reply when the RFI is %s', async status => {
    const { id } = createRfi(db, 'p1', { title: 'Q' });
    createLink(db, { threadKey: THREAD, itemType: 'rfi', itemId: id, linkedByUserId: 'u1' });
    if (status !== 'open') setRfiStatus(db, id, status);
    deliver(env('m1'));
    await settle();
    expect(getRfi(db, id).pendingReply).toBeNull();
  });

  it('ignores a thread linked to something that is not an RFI', async () => {
    createLink(db, { threadKey: THREAD, itemType: 'project', itemId: 'p1', linkedByUserId: 'u1' });
    deliver(env('m1'));
    await settle();
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(0);
  });

  it('captures onto every sent RFI linked to the thread', async () => {
    const a = makeSentRfi(); const b = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => {
      expect(getRfi(db, a).pendingReply).toBeTruthy();
      expect(getRfi(db, b).pendingReply).toBeTruthy();
    });
    expect(getRfi(db, b).pendingReply.text).toBe('Corridor 9ft');
  });

  it('falls back to the indexed snippet when the body fetch fails', async () => {
    const rfiId = makeSentRfi();
    const m = env('m1');
    provider.injectInbound(m);
    provider.failNextWith(new Error('provider down'));
    upsertEnvelopes(ctx, acct, [m]);
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(getRfi(db, rfiId).pendingReply.text).toBe('Corridor 9ft (snippet)');
  });

  it('an older reply whose body arrives late does not overwrite a newer one', async () => {
    // Both fetches are held open, then released newest-first: the older one
    // resolving last must not win just because it wrote last.
    const release = new Map<string, () => void>();
    const gated = Object.create(provider);
    gated.getBody = (id: string) => new Promise(res => release.set(id, () => res({ text: id === 'm1' ? 'older answer' : 'newer answer', attachments: [] })));
    useProvider(gated);
    const rfiId = makeSentRfi();
    deliver(env('m1', { date: '2026-08-28T10:00:00.000Z' }));
    deliver(env('m2', { date: '2026-08-29T10:00:00.000Z' }));
    await vi.waitFor(() => expect(release.size).toBe(2));
    release.get('m2')!();
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply?.text).toBe('newer answer'));
    release.get('m1')!();
    await settle();
    expect(getRfi(db, rfiId).pendingReply.text).toBe('newer answer');
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(1);
  });

  it('the same email indexed by a second mailbox does not capture twice', async () => {
    const rfiId = makeSentRfi();
    const second = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'ops@birchwood.example', auth: { refreshToken: 'r' }, indexedSince: '2026-06-01T00:00:00.000Z' });
    upsertFolders(db, second.id, provider.folders);
    const m = env('m1');
    deliver(m);
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    const first = getRfi(db, rfiId);
    // Same Message-ID, different row (unique index is per account).
    upsertEnvelopes(ctx, second, [m]);
    await settle();
    const after = getRfi(db, rfiId);
    expect(after.pendingReply.mailMessageId).toBe(first.pendingReply.mailMessageId);
    expect(after.version).toBe(first.version);
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(1);
  });

  it('caps a huge reply body and a long attachment list', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1', {
      text: 'x'.repeat(50_000),
      attachments: Array.from({ length: 25 }, (_, i) => ({ attId: 'a' + i, name: `f${i}.pdf`, mime: 'application/pdf', size: 1 })),
    }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    const { pendingReply } = getRfi(db, rfiId);
    expect(pendingReply.text).toHaveLength(4001);        // 4000 + the … marker
    expect(pendingReply.text.endsWith('…')).toBe(true);
    expect(pendingReply.attachments).toHaveLength(20);
    expect(pendingReply.attachments[0].attId).toBe('a0');
  });

  it('truncates between characters, never inside one', async () => {
    // The 4000-code-unit boundary lands in the middle of the emoji.
    const rfiId = makeSentRfi();
    deliver(env('m1', { text: 'a'.repeat(3999) + '\u{1F600}' + 'b'.repeat(50) }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    const { text } = getRfi(db, rfiId).pendingReply;
    expect(text).toBe('a'.repeat(3999) + '…');            // the split emoji is dropped whole
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
    expect((text as string & { isWellFormed?: () => boolean }).isWellFormed?.() ?? true).toBe(true);
    expect(JSON.parse(JSON.stringify(text))).toBe(text);  // survives the JSON column round-trip
  });

  it('keeps a whole character that ends exactly on the boundary', async () => {
    // Same emoji one position earlier: both halves fit, so both are kept.
    const rfiId = makeSentRfi();
    deliver(env('m1', { text: 'a'.repeat(3998) + '\u{1F600}' + 'b'.repeat(50) }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(getRfi(db, rfiId).pendingReply.text).toBe('a'.repeat(3998) + '\u{1F600}' + '…');
  });

  it('falls back to the snippet when the provider itself cannot be built', async () => {
    useProvider(null);
    ctx.providerFactory = () => { throw new Error('undecryptable auth blob'); };
    const rfiId = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(getRfi(db, rfiId).pendingReply.text).toBe('Corridor 9ft (snippet)');
  });

  it('installInboundHooks is idempotent', async () => {
    installInboundHooks(); installInboundHooks();
    const rfiId = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(1);
  });

  it('never throws out of the synchronous hook call', () => {
    const broken = { ...ctx, db: { prepare: () => { throw new Error('db gone'); } } } as unknown as MailContext;
    expect(() => rfiPendingReplyHook(broken, { threadKey: THREAD, messageId: 'x', account: acct })).not.toThrow();
  });
});

describe('rfi answered notification (the bell, ONLYOFFICE Phase 5)', () => {
  let notifier: Notifier;
  beforeEach(() => {
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u2','maria','x','user'), ('u3','joe','x','user')`).run();
    notifier = new Notifier(db);
    ctx.notifier = notifier;
  });
  const sentRfi = (assignee: string | null, sender: string) => {
    const { id } = createRfi(db, 'p1', { title: 'Corridor height?', assigneeUserId: assignee });
    markRfiSent(db, id, sender);
    createLink(db, { threadKey: THREAD, itemType: 'rfi', itemId: id, linkedByUserId: 'u1' });
    return id;
  };

  it('tells the assignee and the sender once when the GC replies', async () => {
    const rfiId = sentRfi('u2', 'u3');
    deliver(env('m1'));
    await vi.waitFor(() => expect(notifier.list('u2').items).toHaveLength(1));
    for (const u of ['u2', 'u3']) {
      expect(notifier.list(u).items).toEqual([expect.objectContaining({
        type: 'rfi-answered', title: 'Reply received on RFI-001',
        body: 'Mike replied to "Corridor height?". Review it to record the answer.',
        link: `/project/p1/rfis?open=${rfiId}`,
      })]);
    }
    // The same message again (a retried hook) tells nobody twice.
    const messageId = (db.prepare(`SELECT id FROM mail_messages WHERE providerMessageId = 'm1'`).get() as any).id;
    rfiPendingReplyHook(ctx, { threadKey: THREAD, messageId, account: acct });
    await settle();
    expect(notifier.list('u2').items).toHaveLength(1);
    expect(notifier.list('u1').items).toEqual([]);
  });

  it('tells one person once when they both sent it and own it', async () => {
    sentRfi('u2', 'u2');
    deliver(env('m1'));
    await vi.waitFor(() => expect(notifier.list('u2').items).toHaveLength(1));
    await settle();
    expect(notifier.list('u2').items).toHaveLength(1);
  });
});
