// server/onlyoffice/sessions.ts — one row per file while an ONLYOFFICE
// editing session is open (table editor_sessions, migration 37).
//
// Two jobs:
//   * Everyone who opens a file during a session must get the SAME document
//     key, or ONLYOFFICE starts a second, separate session on the same file and
//     the two overwrite each other. The key is pinned here, because the file's
//     own version (which normally drives the key) moves when the session saves.
//   * The one-version-per-session rule (decision 2026-09-25): a session's first
//     save archives the pre-session bytes as a version; its later saves
//     overwrite in place. savedVersionNumber/savedSha256 record exactly what
//     this session last wrote, so a save only overwrites if nothing else has
//     changed the file since (a regenerate, an upload, a restore).
import type Database from 'better-sqlite3';

export interface EditorSession {
  fileId: string;
  docKey: string;
  /** The file's live version when the session started. */
  baseVersionNumber: number;
  /** The live version this session produced with its first save; null until then. */
  savedVersionNumber: number | null;
  /** The sha256 of the bytes this session last wrote. */
  savedSha256: string | null;
  startedAt: number;
  lastSavedAt: number | null;
  lastSavedBy: string | null;
  /** JSON array of the user ids ONLYOFFICE last reported editing (status 1). */
  users: string | null;
}

/** A session a restore replaced (migration 38). */
export interface SupersededSession { docKey: string; fileId: string; lastSha256: string | null; closedAt: number }

export class EditorSessions {
  constructor(private readonly db: Database.Database) {}

  get(fileId: string): EditorSession | null {
    return (this.db.prepare('SELECT * FROM editor_sessions WHERE fileId = ?').get(fileId) as EditorSession | undefined) ?? null;
  }

  /** Starts a session unless one is already open, and returns whichever
   *  session is now open (two people opening at once both get the first). */
  start(fileId: string, docKey: string, baseVersionNumber: number): EditorSession {
    this.db.prepare(`INSERT OR IGNORE INTO editor_sessions (fileId, docKey, baseVersionNumber, startedAt) VALUES (?, ?, ?, ?)`)
      .run(fileId, docKey, baseVersionNumber, Date.now());
    return this.get(fileId)!;
  }

  recordSave(fileId: string, docKey: string, saved: { versionNumber: number; sha256: string; by: string | null }): void {
    this.db.prepare(`UPDATE editor_sessions SET savedVersionNumber = ?, savedSha256 = ?, lastSavedAt = ?, lastSavedBy = ?
                     WHERE fileId = ? AND docKey = ?`)
      .run(saved.versionNumber, saved.sha256, Date.now(), saved.by, fileId, docKey);
  }

  /** Ends the session with this key only: a late message from an old session
   *  must never close a newer one. */
  end(fileId: string, docKey: string): void {
    this.db.prepare('DELETE FROM editor_sessions WHERE fileId = ? AND docKey = ?').run(fileId, docKey);
  }

  /** Who ONLYOFFICE says is in the session right now (callback status 1). */
  setUsers(fileId: string, docKey: string, users: string[]): void {
    this.db.prepare('UPDATE editor_sessions SET users = ? WHERE fileId = ? AND docKey = ?')
      .run(JSON.stringify(users), fileId, docKey);
  }

  usersOf(session: EditorSession): string[] {
    try {
      const parsed = JSON.parse(session.users || '[]');
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }

  // ── Sessions a restore replaced ────────────────────────────────────────
  // A restore ends the open session so the file reopens on the restored
  // bytes. ONLYOFFICE still closes that old session a few seconds later (a
  // final status 2 or 4); its save must not quietly undo the restore, yet
  // real edits made after the restore (a second tab still open) must not be
  // lost either. So the old key is remembered with the bytes it last saved:
  // a save that matches them is dropped, anything else becomes a new version.

  supersede(fileId: string, docKey: string, lastSha256: string | null): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT OR REPLACE INTO editor_superseded_sessions (docKey, fileId, lastSha256, closedAt) VALUES (?, ?, ?, ?)`)
        .run(docKey, fileId, lastSha256, Date.now());
      // Anything older than a day is long closed; keep the table small.
      this.db.prepare('DELETE FROM editor_superseded_sessions WHERE closedAt < ?').run(Date.now() - 24 * 3600_000);
      this.end(fileId, docKey);
    });
    tx();
  }

  getSuperseded(docKey: string): SupersededSession | null {
    return (this.db.prepare('SELECT * FROM editor_superseded_sessions WHERE docKey = ?').get(docKey) as SupersededSession | undefined) ?? null;
  }

  updateSuperseded(docKey: string, lastSha256: string): void {
    this.db.prepare('UPDATE editor_superseded_sessions SET lastSha256 = ? WHERE docKey = ?').run(lastSha256, docKey);
  }

  dropSuperseded(docKey: string): void {
    this.db.prepare('DELETE FROM editor_superseded_sessions WHERE docKey = ?').run(docKey);
  }
}

/** Lets a restore wait for the save it asked ONLYOFFICE for (command
 *  `forcesave`) to be stored before replacing the file. */
export class ForcesaveWaiters {
  private readonly waiting = new Map<string, Array<() => void>>();

  /** Resolves true once `settle(docKey)` runs, false after the timeout. */
  wait(docKey: string, timeoutMs: number): { promise: Promise<boolean>; cancel: () => void } {
    let done: (v: boolean) => void = () => {};
    const promise = new Promise<boolean>(resolve => { done = resolve; });
    const onSettle = () => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { this.remove(docKey, onSettle); done(false); }, timeoutMs);
    this.waiting.set(docKey, [...(this.waiting.get(docKey) ?? []), onSettle]);
    return { promise, cancel: () => { clearTimeout(timer); this.remove(docKey, onSettle); done(false); } };
  }

  settle(docKey: string): void {
    const list = this.waiting.get(docKey) ?? [];
    this.waiting.delete(docKey);
    for (const fn of list) fn();
  }

  private remove(docKey: string, fn: () => void): void {
    const rest = (this.waiting.get(docKey) ?? []).filter(f => f !== fn);
    if (rest.length) this.waiting.set(docKey, rest); else this.waiting.delete(docKey);
  }
}

/** Runs work for one file strictly one at a time: saves arriving back to back
 *  and a restore each decide what to do from what the previous one wrote. */
export class FileQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  run<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(fileId) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => undefined);
    this.queues.set(fileId, settled);
    void settled.then(() => { if (this.queues.get(fileId) === settled) this.queues.delete(fileId); });
    return run;
  }
}
