import { describe, it, expect } from 'vitest';
import { normalizeMessageId, deriveThreadKey, normalizeSubject, mergeThreadKeys } from './threadKey';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import fs from 'fs'; import os from 'os'; import path from 'path';

describe('normalizeMessageId', () => {
  it('strips brackets and whitespace, lowercases', () => {
    expect(normalizeMessageId(' <ABC@Mail.Example> ')).toBe('abc@mail.example');
    expect(normalizeMessageId('')).toBeNull(); expect(normalizeMessageId(undefined)).toBeNull();
  });
});
describe('normalizeSubject', () => {
  it('removes reply/forward prefixes repeatedly', () => {
    expect(normalizeSubject('RE: Fwd: re: Change Order #4')).toBe('change order #4');
    expect(normalizeSubject('  FW:  Quote ')).toBe('quote');
  });
});
describe('deriveThreadKey', () => {
  const none = () => null;
  it('falls back to the provider conversation when the tenant omits the headers', () => {
    // Some Microsoft 365 tenants leave internetMessageHeaders off a delta
    // projection, so the second message of a conversation arrives with nothing
    // to thread on but its conversationId.
    const byThread = (pt: string) => (pt === 'CONV-1' ? 'synthetic:abc' : null);
    expect(deriveThreadKey(none, { messageIdHeader: null, inReplyTo: null, references: [], fallbackSeed: 'a', providerThreadId: 'CONV-1' }, byThread))
      .toEqual({ threadKey: 'synthetic:abc', synthetic: false });
    // An unknown conversation still falls through to the synthetic key.
    expect(deriveThreadKey(none, { messageIdHeader: null, inReplyTo: null, references: [], fallbackSeed: 'a', providerThreadId: 'CONV-9' }, byThread).synthetic).toBe(true);
  });
  it('a message with its own chain never consults the provider conversation', () => {
    // Gmail stamps a threadId on EVERY message and groups by subject, so a
    // reply whose parent has not synced yet must keep its provisional
    // References key — trusting the conversation here merges strangers.
    const byThread = () => 'other-thread';
    expect(deriveThreadKey(none, { messageIdHeader: 'b@x', inReplyTo: null, references: ['z@x'], fallbackSeed: 'a', providerThreadId: 'T' }, byThread))
      .toEqual({ threadKey: 'z@x', synthetic: false });
    expect(deriveThreadKey(none, { messageIdHeader: 'b@x', inReplyTo: 'z@x', references: [], fallbackSeed: 'a', providerThreadId: 'T' }, byThread))
      .toEqual({ threadKey: 'z@x', synthetic: false });
  });
  it('the header chain outranks the provider conversation', () => {
    const byThread = () => 'from-conversation';
    // A known References entry wins outright...
    expect(deriveThreadKey(k => (k === 'root@x' ? 'from-header' : null), { messageIdHeader: 'me@x', inReplyTo: null, references: ['root@x'], fallbackSeed: 'a', providerThreadId: 'CONV-1' }, byThread).threadKey)
      .toBe('from-header');
    // ...and so does an unknown one, which is what bridges a late-arriving root.
    expect(deriveThreadKey(none, { messageIdHeader: 'me@x', inReplyTo: null, references: [], fallbackSeed: 'a' }, byThread).threadKey).toBe('me@x');
  });
  it('own Message-ID becomes the key for a root message', () => {
    expect(deriveThreadKey(none, { messageIdHeader: 'root@x', inReplyTo: null, references: [], fallbackSeed: 'a' })).toEqual({ threadKey: 'root@x', synthetic: false });
  });
  it('reuses an existing key found via References (earliest first)', () => {
    const lookup = (id: string) => (id === 'mid@x' ? 'existing-key' : null);
    expect(deriveThreadKey(lookup, { messageIdHeader: 'new@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'], fallbackSeed: 'a' }).threadKey).toBe('existing-key');
  });
  it('falls back to the References root when nothing is indexed yet', () => {
    expect(deriveThreadKey(none, { messageIdHeader: 'new@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'], fallbackSeed: 'a' }).threadKey).toBe('root@x');
  });
  it('uses In-Reply-To when References is empty', () => {
    expect(deriveThreadKey(none, { messageIdHeader: 'new@x', inReplyTo: 'parent@x', references: [], fallbackSeed: 'a' }).threadKey).toBe('parent@x');
  });
  it('synthesizes a key when there is no Message-ID', () => {
    const r = deriveThreadKey(none, { messageIdHeader: null, inReplyTo: null, references: [], fallbackSeed: 'acct:pm1' });
    expect(r.synthetic).toBe(true); expect(r.threadKey.startsWith('synthetic:')).toBe(true);
    expect(deriveThreadKey(none, { messageIdHeader: null, inReplyTo: null, references: [], fallbackSeed: 'acct:pm1' }).threadKey).toBe(r.threadKey);
  });
});
describe('mergeThreadKeys', () => {
  it('rewrites messages, links, reply state and drops the stale thread rollup', () => {
    const db = openDb(':memory:');
    runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-tk-')), migrations);
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
    db.prepare(`INSERT INTO mail_accounts (id,userId,provider,emailAddress,isDefault,authBlob,indexedSince,status,createdAt,updatedAt) VALUES ('a1','u1','fake','a@x',1,'v1:x','2026-01-01','ok','t','t')`).run();
    const ins = db.prepare(`INSERT INTO mail_messages (id,accountId,providerMessageId,threadKey,date,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`);
    ins.run('m1', 'a1', 'p1', 'child@x', '2026-01-02', 't', 't'); ins.run('m2', 'a1', 'p2', 'root@x', '2026-01-01', 't', 't');
    db.prepare(`INSERT INTO mail_threads (id,accountId,threadKey,firstDate,lastDate,updatedAt) VALUES ('t1','a1','child@x','2026-01-02','2026-01-02','t'),('t2','a1','root@x','2026-01-01','2026-01-01','t')`).run();
    db.prepare(`INSERT INTO mail_thread_links (id,threadKey,itemType,itemId,linkedByUserId,createdAt) VALUES ('l1','child@x','rfi','r1','u1','t')`).run();
    db.prepare(`INSERT INTO mail_thread_reply_state (threadKey,updatedAt) VALUES ('child@x','t')`).run();
    mergeThreadKeys(db, 'a1', 'child@x', 'root@x');
    expect(db.prepare(`SELECT threadKey FROM mail_messages WHERE id='m1'`).get()).toEqual({ threadKey: 'root@x' });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_threads WHERE threadKey='child@x'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT threadKey FROM mail_thread_links WHERE id='l1'`).get()).toEqual({ threadKey: 'root@x' });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_thread_reply_state WHERE threadKey='root@x'`).get()).toEqual({ c: 1 });
  });
});
