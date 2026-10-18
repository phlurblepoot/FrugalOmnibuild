import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore'; import { createRfi, getRfi } from '../rfiStore';
import { putBuffer } from '../files';
import { MailCrypto } from './crypto'; import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import type { MailContext } from './context';
import { send, MailSendError } from './sendService';
import { stageUpload } from './uploads';
import { listLinksForThread } from './links';
import { upsertEnvelopes } from './sync/engine';
import type { EntityChangedEvent } from '../realtime/changeFeed';

vi.mock('./sync/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync/engine')>();
  return { ...actual, upsertEnvelopes: vi.fn(actual.upsertEnvelopes) };
});

let db: Database.Database; let ctx: MailContext; let provider: FakeMailProvider; let dir: string; let acct: accounts.MailAccountRow;
let events: EntityChangedEvent[];
const crypto = new MailCrypto(Buffer.alloc(32, 5)); const user = { id: 'u1', role: 'user' };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ss-')); db = openDb(':memory:'); runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','user')`).run();
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@birchwood.example', displayName: 'Me', auth: { refreshToken: 'r' } });
  provider = new FakeMailProvider(); provider.seed([]);
  events = [];
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: ev => { events.push(ev); } };
});
describe('sendService.send', () => {
  it('sends through the default account, indexes the sent row, links + effects the item', async () => {
    const { id: rfiId } = createRfi(db, 'p1', { title: 'Ceilings' });
    putBuffer(db, dir, 'f1', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'rfi', name: 'RFI-001.pdf' });
    const r = await send(ctx, user, { to: [{ addr: 'gc@tidewater.example' }], subject: 'RFI-001', html: '<p>See attached</p>', attachments: [{ fileId: 'f1', itemType: 'rfi', itemId: rfiId }] });
    expect(provider.sent.length).toBe(1);
    expect(provider.sent[0]).toMatchObject({ from: { addr: 'me@birchwood.example', name: 'Me' }, subject: 'RFI-001', text: 'See attached' });
    expect(provider.sent[0].attachments[0]).toMatchObject({ name: 'RFI-001.pdf', mime: 'application/pdf' });
    const row = db.prepare('SELECT threadKey, sentFromApp, isRead FROM mail_messages').get() as any;
    expect(row.sentFromApp).toBe(1); expect(row.threadKey).toBe(r.threadKey);
    expect(listLinksForThread(db, r.threadKey).map(l => l.itemType)).toEqual(['rfi']);
    expect(getRfi(db, rfiId).status).toBe('sent');
    expect(db.prepare('SELECT lastOutboundDate FROM mail_thread_reply_state WHERE threadKey = ?').get(r.threadKey)).toBeTruthy();
    expect(r.effectsSkipped).toEqual([]);
  });
  it('replies inside an existing thread with In-Reply-To/References to its last message', async () => {
    db.prepare(`INSERT INTO mail_messages (id, accountId, providerMessageId, messageIdHeader, threadKey, date, createdAt, updatedAt, referencesJson) VALUES ('m1', ?, 'p1', 'root@tidewater.example', 'root@tidewater.example', '2026-08-01T00:00:00.000Z', 't', 't', '[]')`).run(acct.id);
    const r = await send(ctx, user, { to: [{ addr: 'gc@tidewater.example' }], subject: 'Re: x', html: 'ok', attachments: [], replyTo: { accountId: acct.id, threadKey: 'root@tidewater.example' } });
    expect(provider.sent[0].inReplyTo).toBe('root@tidewater.example'); expect(provider.sent[0].references).toEqual(['root@tidewater.example']);
    expect(r.threadKey).toBe('root@tidewater.example');
  });
  it('indexes the sent row under the Message-ID the provider reports, not the one we generated', async () => {
    provider.sendMessageIdHeader = '<REWRITTEN@mail.gmail.com>';
    const r = await send(ctx, user, { to: [{ addr: 'gc@tidewater.example' }], subject: 's', html: 'h', attachments: [] });
    const row = db.prepare('SELECT messageIdHeader, threadKey FROM mail_messages').get() as any;
    expect(row.messageIdHeader).toBe('rewritten@mail.gmail.com');
    expect(row.threadKey).toBe('rewritten@mail.gmail.com');
    expect(r.threadKey).toBe('rewritten@mail.gmail.com');
    expect(provider.sent[0].messageIdHeader).not.toBe(row.messageIdHeader);   // ours was replaced
  });
  it('reports effectsSkipped for admin-gated items sent by a non-admin, still links', async () => {
    putBuffer(db, dir, 'f2', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'invoice', name: 'Invoice-1.pdf' });
    const r = await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [{ fileId: 'f2', itemType: 'invoice', itemId: 'inv1' }] });
    expect(r.effectsSkipped).toEqual(['invoice']);
    expect(listLinksForThread(db, r.threadKey).length).toBe(1);
  });
  it('uses staged uploads and deletes the draft after send', async () => {
    const { uploadId } = stageUpload(dir, 'site.jpg', 'image/jpeg', Buffer.from('jpg'));
    const d = await provider.saveDraft({ from: { addr: 'me@birchwood.example' }, to: [], cc: [], bcc: [], subject: '', html: '', text: '', attachments: [], messageIdHeader: 'x' });
    await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [{ uploadId }], draftProviderId: d.providerMessageId });
    expect(provider.sent[0].attachments[0].name).toBe('site.jpg'); expect(provider.drafts.size).toBe(0);
    expect(fs.existsSync(path.join(dir, 'tmp', 'mail-uploads', uploadId + '.bin'))).toBe(false);
  });
  it('fails cleanly with no account / inactive account', async () => {
    accounts.updateAccount(db, acct.id, { status: 'auth_error' });
    await expect(send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] })).rejects.toBeInstanceOf(MailSendError);
    accounts.deleteAccount(db, acct.id);
    await expect(send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] })).rejects.toThrow(/no usable mail account/i);
  });
  it('picks the first USABLE account, preferring the default one', async () => {
    // acct is the default. Park it in needs_review (where migration 31 leaves a
    // converted SMTP config) — the send must move to the healthy account rather
    // than fail on a default the user cannot send from.
    accounts.updateAccount(db, acct.id, { status: 'needs_review' });
    const good = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'good@birchwood.example', auth: { refreshToken: 'r' } });
    const r = await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] });
    expect(r.accountId).toBe(good.id);
    // a healthy default still wins over a healthy non-default
    accounts.updateAccount(db, acct.id, { status: 'ok' });
    const r2 = await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] });
    expect(r2.accountId).toBe(acct.id);
  });
  it('stamps bySessionId on the broadcasts a send causes', async () => {
    await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [], sessionId: 's9', links: [{ itemType: 'project', itemId: 'p1' }] });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.bySessionId === 's9')).toBe(true);
    // omitted → nobody is excluded from the refetch
    events.length = 0;
    await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] });
    expect(events.every(e => e.bySessionId === undefined)).toBe(true);
  });
  it('rejects a replyTo.accountId the user does not own, and sends nothing', async () => {
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u2','b','x','user')`).run();
    const otherAcct = accounts.createAccount(db, crypto, { userId: 'u2', provider: 'fake', emailAddress: 'other@birchwood.example', displayName: 'Other', auth: { refreshToken: 'r' } });
    const p = send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [], replyTo: { accountId: otherAcct.id, threadKey: 'root@tidewater.example' } });
    await expect(p).rejects.toMatchObject({ status: 404 });
    expect(provider.sent.length).toBe(0);
  });
  it('recovers cleanly when the sent message cannot be recorded locally, without asking to resend', async () => {
    (upsertEnvelopes as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('db boom'); });
    const p = send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] });
    await expect(p).rejects.toMatchObject({ status: 502 });
    await expect(p).rejects.toThrow(/do not resend/i);
    expect(provider.sent.length).toBe(1);
  });
});
