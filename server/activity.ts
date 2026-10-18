// server/activity.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export interface ActivityEvent {
  projectId?: string | null;
  userId?: string | null;
  type: string;
  message: string;
}

// Best-effort event log powering the dashboard feed. Logging must never break
// the operation it decorates — failures are swallowed (and logged to stderr).
// No retention policy (rows are ~150 bytes; add a createdAt sweep if it grows).
export function logActivity(db: Database.Database, e: ActivityEvent): void {
  try {
    db.prepare(
      'INSERT INTO activity (id, projectId, userId, type, message, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), e.projectId ?? null, e.userId ?? null, e.type, e.message, Date.now());
  } catch (err) {
    console.error('[activity] failed to log event:', err);
  }
}

export function listActivity(db: Database.Database, limit = 30, projectId?: string): any[] {
  const capped = Math.max(1, Math.min(100, Math.floor(limit) || 30));
  return db.prepare(`
    SELECT a.id, a.projectId, a.userId, a.type, a.message, a.createdAt,
           p.name AS projectName, u.username AS username
    FROM activity a
    LEFT JOIN projects p ON p.id = a.projectId
    LEFT JOIN users u ON u.id = a.userId
    ${projectId ? 'WHERE a.projectId = ?' : ''}
    ORDER BY a.createdAt DESC, a.rowid DESC
    LIMIT ?
  `).all(...(projectId ? [projectId, capped] : [capped]));
}
