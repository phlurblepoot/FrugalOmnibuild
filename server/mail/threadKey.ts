// server/mail/threadKey.ts  (spec §3.1)
import crypto from 'crypto';
import type Database from 'better-sqlite3';

export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^<+|>+$/g, '').trim().toLowerCase();
  return t || null;
}
const SUBJECT_PREFIX_RE = /^(re|fw|fwd|aw|wg)\s*:\s*/i;
// Strips repeated reply/forward prefixes without altering case or collapsing
// whitespace — safe for DISPLAY. `normalizeSubject` builds on this for the
// case-insensitive MATCHING key so the two never drift apart.
export function stripSubjectPrefixes(s: string): string {
  let t = (s || '').trim();
  while (SUBJECT_PREFIX_RE.test(t)) t = t.replace(SUBJECT_PREFIX_RE, '').trim();
  return t;
}
export function normalizeSubject(s: string): string {
  return stripSubjectPrefixes(s).replace(/\s+/g, ' ').toLowerCase();
}
export function deriveThreadKey(
  lookup: (messageIdHeader: string) => string | null,
  env: { messageIdHeader: string | null; inReplyTo: string | null; references: string[]; fallbackSeed: string; providerThreadId?: string | null },
  // The provider's own conversation id, resolved to a thread we already hold.
  // Threading otherwise rests entirely on In-Reply-To/References, and some
  // Microsoft 365 tenants omit `internetMessageHeaders` from a delta
  // projection — without this every message in such a mailbox would be its own
  // one-message thread. Consulted ONLY when the message carries no chain of its
  // own (see the gate below).
  lookupByProviderThread?: (providerThreadId: string) => string | null,
): { threadKey: string; synthetic: boolean } {
  const refs = env.references.map(normalizeMessageId).filter((x): x is string => !!x);
  const irt = normalizeMessageId(env.inReplyTo);
  const own = normalizeMessageId(env.messageIdHeader);
  const candidates = [...refs, ...(irt ? [irt] : []), ...(own ? [own] : [])];
  for (const c of candidates) { const k = lookup(c); if (k) return { threadKey: k, synthetic: false }; }
  // Strictly a substitute for headers this message does not have. A message
  // WITH a chain whose parent simply has not synced yet must keep falling
  // through to refs[0]/irt, which is what lets the real parent bridge the two
  // groups later — Gmail puts a threadId on every message and groups by
  // subject, so trusting it here would merge two unrelated conversations.
  if (!refs.length && !irt && env.providerThreadId && lookupByProviderThread) {
    const k = lookupByProviderThread(env.providerThreadId);
    if (k) return { threadKey: k, synthetic: false };
  }
  if (refs.length) return { threadKey: refs[0], synthetic: false };
  if (irt) return { threadKey: irt, synthetic: false };
  if (own) return { threadKey: own, synthetic: false };
  return { threadKey: 'synthetic:' + crypto.createHash('sha1').update(env.fallbackSeed).digest('hex'), synthetic: true };
}
// A late-arriving root bridges two keys: fold `fromKey` into `toKey`. The
// mail_threads rollup for fromKey is dropped — the engine rebuilds toKey's.
export function mergeThreadKeys(db: Database.Database, accountId: string, fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  db.transaction(() => {
    db.prepare('UPDATE mail_messages SET threadKey = ? WHERE accountId = ? AND threadKey = ?').run(toKey, accountId, fromKey);
    db.prepare('DELETE FROM mail_threads WHERE accountId = ? AND threadKey = ?').run(accountId, fromKey);
    db.prepare('UPDATE OR IGNORE mail_thread_links SET threadKey = ? WHERE threadKey = ?').run(toKey, fromKey);
    db.prepare('DELETE FROM mail_thread_links WHERE threadKey = ?').run(fromKey); // leftovers that collided on the unique index
    db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(toKey, new Date().toISOString());
    db.prepare(`UPDATE mail_thread_reply_state SET
        lastInboundDate = MAX(COALESCE(lastInboundDate,''), COALESCE((SELECT lastInboundDate FROM mail_thread_reply_state WHERE threadKey = ?),'')),
        lastOutboundDate = MAX(COALESCE(lastOutboundDate,''), COALESCE((SELECT lastOutboundDate FROM mail_thread_reply_state WHERE threadKey = ?),''))
      WHERE threadKey = ?`).run(fromKey, fromKey, toKey);
    db.prepare('DELETE FROM mail_thread_reply_state WHERE threadKey = ?').run(fromKey);
  })();
}
