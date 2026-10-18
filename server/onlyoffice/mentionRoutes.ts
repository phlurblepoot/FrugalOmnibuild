// server/onlyoffice/mentionRoutes.ts — @mentions in document comments
// (ONLYOFFICE Phase 5):
//
//   GET  /api/onlyoffice/mention-users/:fileId  who can be mentioned in this file
//   POST /api/onlyoffice/mention/:fileId        { emails, message, actionLink }
//
// ONLYOFFICE keys the people it lists (onRequestUsers, c: "mention") by email:
// it shows the address under the name and types it into the comment
// ("+maria@team.invalid"). The app's users have no email, so each gets a
// readable made-up one from their username, under the reserved .invalid
// domain, so nothing can ever be mailed there. When someone is mentioned the
// editor calls onRequestSendNotify with the addresses found in the comment;
// the page posts them here, they are matched back to users, and each person
// gets a notification whose link opens the document at the comment.
import express from 'express';
import type Database from 'better-sqlite3';
import { getMeta } from '../files';
import { editorPath, normalizeActionLink } from '../../src/utils/editorLinks';
import type { Notifier } from '../notifications';
import { isAdminOnlyKind } from './editorRoutes';

/** Never a real mailbox (.invalid is reserved). */
const MENTION_DOMAIN = 'team.invalid';
const MAX_RECIPIENTS = 50;

/** Each user's mention address, by user id: their username in the characters
 *  ONLYOFFICE recognises in a comment ([a-z0-9._-]), with ".2", ".3"… when two
 *  usernames come out the same (the earlier account keeps the plain one). */
export function mentionAddresses(users: { id: string; username: string }[]): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  const ordered = [...users].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const u of ordered) {
    const base = u.username.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '.')
      .replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '') || 'user';
    let local = base;
    for (let n = 2; taken.has(local); n++) local = `${base}.${n}`;
    taken.add(local);
    out.set(u.id, `${local}@${MENTION_DOMAIN}`);
  }
  return out;
}

export interface OnlyofficeMentionDeps {
  db: Database.Database;
  authenticateToken: express.RequestHandler;
  notifier?: Notifier;
}

interface UserRow { id: string; username: string; role: string }

export function registerOnlyofficeMentionRoutes(app: express.Express, deps: OnlyofficeMentionDeps): void {
  const { db, authenticateToken } = deps;

  /** The file, if the requester may open it. */
  const fileFor = (req: express.Request) => {
    const meta = getMeta(db, req.params.fileId);
    const isAdmin = (req as any).user?.role === 'admin';
    return meta && (isAdmin || !isAdminOnlyKind(meta.kind)) ? meta : null;
  };
  /** Everyone who could open the file (an admin-only document only has
   *  admins), with their addresses. Addresses come from ALL users, so one
   *  never depends on which file is asking. */
  const audience = (kind: string): (UserRow & { email: string })[] => {
    const users = db.prepare('SELECT id, username, role FROM users ORDER BY username COLLATE NOCASE').all() as UserRow[];
    const addresses = mentionAddresses(users);
    return users
      .filter(u => !isAdminOnlyKind(kind) || u.role === 'admin')
      .map(u => ({ ...u, email: addresses.get(u.id)! }));
  };

  app.get('/api/onlyoffice/mention-users/:fileId', authenticateToken, (req, res) => {
    const meta = fileFor(req);
    if (!meta) return res.status(404).json({ error: 'File not found' });
    const me = String((req as any).user?.id ?? '');
    res.json({
      users: audience(meta.kind)
        .filter(u => u.id !== me)
        .map(u => ({ id: u.id, name: u.username, email: u.email })),
    });
  });

  app.post('/api/onlyoffice/mention/:fileId', authenticateToken, (req, res) => {
    const meta = fileFor(req);
    if (!meta) return res.status(404).json({ error: 'File not found' });
    const emails = Array.isArray(req.body?.emails)
      ? (req.body.emails as unknown[]).filter((e): e is string => typeof e === 'string').slice(0, MAX_RECIPIENTS)
      : [];
    const wanted = new Set(emails.map(e => e.trim().toLowerCase()));
    const recipients = audience(meta.kind).filter(u => wanted.has(u.email));
    const by = (req as any).user as { id?: unknown; username?: unknown } | undefined;
    const byName = typeof by?.username === 'string' && by.username ? by.username : 'Someone';
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const link = editorPath(meta.id, normalizeActionLink(req.body?.actionLink));
    const sent = deps.notifier?.notifyEach(recipients.map(u => u.id), {
      type: 'mention',
      actorUserId: by?.id != null ? String(by.id) : null,
      title: `${byName} mentioned you in ${meta.name || 'a document'}`,
      body: message,
      link,
    }) ?? [];
    res.json({ notified: sent.length });
  });
}
