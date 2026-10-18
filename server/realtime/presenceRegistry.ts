// In-memory session registry — the single source of truth for presence.
// Deliberately free of socket.io imports: this is the interface a
// distributed adapter would replace if the app ever runs multi-process.
import type { LocationInfo, SessionInfo } from './types';

export class PresenceRegistry {
  private sessions = new Map<string, SessionInfo>();

  add(session: SessionInfo): void {
    this.sessions.set(session.sessionId, session);
  }

  remove(sessionId: string): SessionInfo | undefined {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return s;
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  all(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  setLocation(sessionId: string, loc: LocationInfo): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.location = loc;
    s.lastActive = Date.now();
  }

  update(sessionId: string, patch: Partial<Pick<SessionInfo, 'name' | 'color' | 'editing' | 'cursor'>>): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    Object.assign(s, patch);
    s.lastActive = Date.now();
  }

  touch(sessionId: string, now: number = Date.now()): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.lastActive = now;
  }

  sweep(staleAfterMs: number, now: number = Date.now()): SessionInfo[] {
    const stale: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (now - s.lastActive > staleAfterMs) stale.push(s);
    }
    for (const s of stale) this.sessions.delete(s.sessionId);
    return stale;
  }
}
