// server/whatsNew.ts
// The last app version each person has seen the "What's new" popup for, kept
// with their account (user_preferences) so it follows them from computer to
// iPad and shows once. Accounts made from 4.7 on start with the version they
// were made in, so new people don't get a tour of changes they never saw.
import type express from 'express';
import type Database from 'better-sqlite3';

export const LAST_SEEN_PREF = 'whatsNew.lastSeenVersion';

/** Versions such as 4.6.9.7 or 4.7.0, compared part by part (missing parts count as 0). */
export const VERSION_RE = /^\d+(\.\d+){1,3}$/;

export const getLastSeenVersion = (db: Database.Database, userId: string): string | null => {
  const row = db.prepare('SELECT value FROM user_preferences WHERE userId = ? AND key = ?').get(userId, LAST_SEEN_PREF) as { value: string } | undefined;
  return row?.value && VERSION_RE.test(row.value) ? row.value : null;
};

export const setLastSeenVersion = (db: Database.Database, userId: string, version: string): void => {
  db.prepare('INSERT OR REPLACE INTO user_preferences (userId, key, value) VALUES (?, ?, ?)').run(userId, LAST_SEEN_PREF, version);
};

export interface WhatsNewRouteDeps {
  db: Database.Database;
  authenticateToken: express.RequestHandler;
}

export function registerWhatsNewRoutes(app: express.Express, deps: WhatsNewRouteDeps): void {
  const { db, authenticateToken } = deps;
  const userId = (req: express.Request) => String((req as any).user?.id ?? '');

  app.get('/api/me/whats-new', authenticateToken, (req, res) => {
    res.json({ lastSeenVersion: getLastSeenVersion(db, userId(req)) });
  });

  // Closing the popup (or an update with nothing to show) saves the version
  // the app is now on.
  app.put('/api/me/whats-new', authenticateToken, (req, res) => {
    const version = req.body?.lastSeenVersion;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'lastSeenVersion must be a version such as 4.7.0' });
    }
    setLastSeenVersion(db, userId(req), version);
    res.json({ lastSeenVersion: version });
  });
}
