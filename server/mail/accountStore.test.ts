import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { MailCrypto } from './crypto';
import * as store from './accountStore';

let db: Database.Database; const crypto = new MailCrypto(Buffer.alloc(32, 3));
const imapAuth: store.ImapAuth = { imapHost: 'imap.x', imapPort: 993, imapSecure: true, smtpHost: 'smtp.x', smtpPort: 587, smtpSecure: false, username: 'u', password: 'p' };

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-as-')), migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin'), ('u2','b','x','user')`).run();
});

describe('accountStore', () => {
  it('creates a sealed account, first one becomes default, rows never expose authBlob', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    expect(a.isDefault).toBe(1);
    expect((a as any).authBlob).toBeUndefined();
    const raw = db.prepare('SELECT authBlob FROM mail_accounts WHERE id = ?').get(a.id) as any;
    expect(raw.authBlob).not.toContain('"p"');
    expect(store.readAuth(db, crypto, a.id)).toEqual(imapAuth);
    expect(a.indexedSince <= new Date().toISOString()).toBe(true);
  });
  it('second account is not default; setDefault flips exactly one', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    const b = store.createAccount(db, crypto, { userId: 'u1', provider: 'google', emailAddress: 'b@x', auth: { refreshToken: 'r' } });
    expect(b.isDefault).toBe(0);
    store.setDefault(db, 'u1', b.id);
    expect(store.getOwned(db, 'u1', a.id)!.isDefault).toBe(0);
    expect(store.getOwned(db, 'u1', b.id)!.isDefault).toBe(1);
  });
  it('getOwned enforces ownership; listAccounts scoped per user', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    expect(store.getOwned(db, 'u2', a.id)).toBeNull();
    expect(store.listAccounts(db, 'u2')).toEqual([]);
    expect(store.listAccounts(db, 'u1').map(r => r.id)).toEqual([a.id]);
  });
  it('updateAccount patches status/syncState; listActiveAccounts filters', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    store.updateAccount(db, a.id, { status: 'auth_error', lastError: 'bad token', syncState: JSON.stringify({ historyId: '5' }) });
    const row = store.getAccountAny(db, a.id)!;
    expect(row.status).toBe('auth_error'); expect(row.lastError).toBe('bad token'); expect(JSON.parse(row.syncState!)).toEqual({ historyId: '5' });
    expect(store.listActiveAccounts(db)).toEqual([]);
    store.updateAccount(db, a.id, { status: 'ok' });
    expect(store.listActiveAccounts(db).map(r => r.id)).toEqual([a.id]);
  });
  it('deleteAccount removes it and promotes another to default', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    const b = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'b@x', auth: imapAuth });
    store.deleteAccount(db, a.id);
    expect(store.getAccountAny(db, a.id)).toBeNull();
    expect(store.getOwned(db, 'u1', b.id)!.isDefault).toBe(1);
  });
  it('updateAccount normalizes emailAddress', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    store.updateAccount(db, a.id, { emailAddress: ' New@X.COM ' });
    expect(store.getAccountAny(db, a.id)!.emailAddress).toBe('new@x.com');
  });
  it('setDefault throws for a non-owned account and leaves the existing default untouched', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    const other = store.createAccount(db, crypto, { userId: 'u2', provider: 'imap', emailAddress: 'c@x', auth: imapAuth });
    expect(() => store.setDefault(db, 'u1', other.id)).toThrow('Account not found');
    expect(store.getOwned(db, 'u1', a.id)!.isDefault).toBe(1);
  });
});
