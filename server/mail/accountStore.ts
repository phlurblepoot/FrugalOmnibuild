import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MailCrypto } from './crypto';

export type MailAccountStatus = 'ok' | 'syncing' | 'auth_error' | 'needs_review' | 'disabled';
export interface MailAccountRow {
  id: string; userId: string; provider: 'google' | 'microsoft' | 'imap' | 'fake'; emailAddress: string;
  displayName: string | null; signatureHtml: string | null; isDefault: number; syncState: string | null;
  indexedSince: string; status: MailAccountStatus; lastSyncAt: string | null; lastError: string | null;
  createdAt: string; updatedAt: string;
}
export type ImapAuth = { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string; password: string };
export type OAuthAuth = { refreshToken: string };

const COLS = 'id, userId, provider, emailAddress, displayName, signatureHtml, isDefault, syncState, indexedSince, status, lastSyncAt, lastError, createdAt, updatedAt';

export function listAccounts(db: Database.Database, userId: string): MailAccountRow[] {
  return db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE userId = ? ORDER BY isDefault DESC, createdAt`).all(userId) as MailAccountRow[];
}
export function getOwned(db: Database.Database, userId: string, accountId: string): MailAccountRow | null {
  return (db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE id = ? AND userId = ?`).get(accountId, userId) as MailAccountRow) ?? null;
}
export function getAccountAny(db: Database.Database, accountId: string): MailAccountRow | null {
  return (db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE id = ?`).get(accountId) as MailAccountRow) ?? null;
}
export function listActiveAccounts(db: Database.Database): MailAccountRow[] {
  return db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE status IN ('ok','syncing')`).all() as MailAccountRow[];
}
export function createAccount(db: Database.Database, crypto: MailCrypto, input: {
  userId: string; provider: MailAccountRow['provider']; emailAddress: string; displayName?: string | null;
  auth: ImapAuth | OAuthAuth; status?: MailAccountStatus; indexedSince?: string;
}): MailAccountRow {
  const id = uuidv4();
  const now = new Date().toISOString();
  const since = input.indexedSince ?? new Date(Date.now() - 180 * 86400000).toISOString();
  const hasDefault = db.prepare('SELECT 1 FROM mail_accounts WHERE userId = ? AND isDefault = 1').get(input.userId);
  db.prepare(`INSERT INTO mail_accounts (id, userId, provider, emailAddress, displayName, isDefault, authBlob, indexedSince, status, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.userId, input.provider, input.emailAddress.trim().toLowerCase(), input.displayName ?? null, hasDefault ? 0 : 1,
         crypto.seal(input.auth), since, input.status ?? 'ok', now, now);
  return getAccountAny(db, id)!;
}
export function updateAccount(db: Database.Database, accountId: string,
  patch: Partial<Pick<MailAccountRow, 'displayName' | 'signatureHtml' | 'status' | 'lastSyncAt' | 'lastError' | 'syncState' | 'indexedSince' | 'emailAddress'>>): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const normalized: typeof patch = { ...patch };
  if (normalized.emailAddress != null) normalized.emailAddress = normalized.emailAddress.trim().toLowerCase();
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE mail_accounts SET ${sets}, updatedAt = ? WHERE id = ?`).run(...keys.map(k => normalized[k] ?? null), new Date().toISOString(), accountId);
}
export function updateAuth(db: Database.Database, crypto: MailCrypto, accountId: string, auth: ImapAuth | OAuthAuth): void {
  db.prepare('UPDATE mail_accounts SET authBlob = ?, updatedAt = ? WHERE id = ?').run(crypto.seal(auth), new Date().toISOString(), accountId);
}
export function readAuth(db: Database.Database, crypto: MailCrypto, accountId: string): ImapAuth | OAuthAuth | null {
  const row = db.prepare('SELECT authBlob FROM mail_accounts WHERE id = ?').get(accountId) as { authBlob: string } | undefined;
  return row ? crypto.open<ImapAuth | OAuthAuth>(row.authBlob) : null;
}
export function setDefault(db: Database.Database, userId: string, accountId: string): void {
  db.transaction(() => {
    const owned = db.prepare('SELECT 1 FROM mail_accounts WHERE id = ? AND userId = ?').get(accountId, userId);
    if (!owned) throw new Error('Account not found');
    db.prepare('UPDATE mail_accounts SET isDefault = 0 WHERE userId = ?').run(userId);
    db.prepare('UPDATE mail_accounts SET isDefault = 1 WHERE id = ? AND userId = ?').run(accountId, userId);
  })();
}
export function deleteAccount(db: Database.Database, accountId: string): void {
  db.transaction(() => {
    const row = getAccountAny(db, accountId);
    if (!row) return;
    db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(accountId); // cascades folders/messages/threads
    if (row.isDefault) {
      const next = db.prepare('SELECT id FROM mail_accounts WHERE userId = ? ORDER BY createdAt LIMIT 1').get(row.userId) as { id: string } | undefined;
      if (next) db.prepare('UPDATE mail_accounts SET isDefault = 1 WHERE id = ?').run(next.id);
    }
  })();
}
