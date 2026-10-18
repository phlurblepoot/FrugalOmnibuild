// server/auth.ts — signing in and out, and checking a request's session token
// (spec docs/superpowers/specs/2026-10-07-file-link-security-design.md).
//
//   POST /api/auth/login           username + password → { token, user }, plus the media cookie
//   POST /api/auth/media-session   Bearer token → the media cookie (a session older than the cookie)
//   POST /api/auth/logout          clears the media cookie
//
// The token travels in the Authorization header, as it always has. The media
// cookie carries the same token for what can't send that header: <img src>,
// pdf.js and download links. Only mediaViewer() reads it — the GET routes that
// send a photo's or file's bytes — and authenticateToken never does, so the
// cookie can't make a state-changing request on anyone's behalf (no CSRF).
import express from 'express';
import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { normalizeTokenPayload } from './realtime/verifyPayload';

/** The app's two token checks, over one secret. */
export function tokenAuth(jwtSecret: string) {
  // One token verifier, shared by realtime, the data routes, the mail routes
  // and the media routes, so a token means the same thing everywhere.
  const verifyToken = (token: string) => {
    try { return normalizeTokenPayload(jwt.verify(token, jwtSecret)); }
    catch { return null; }
  };

  // Every other signed-in route: the Authorization header only, never the
  // media cookie.
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    jwt.verify(token, jwtSecret, (err: any, user: any) => {
      if (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    });
  };

  return { verifyToken, authenticateToken };
}

// ── The media cookie ─────────────────────────────────────────────────────────

export const MEDIA_COOKIE = 'ft_media';

// HttpOnly: no page script ever sees it. SameSite=Lax: no other site's page
// can have the browser send it with an <img>, fetch or form; it still goes
// with a link someone follows to a file, which only shows them a file they
// can see anyway (Strict would refuse a file link opened from an email or a
// text message). Secure whenever the visitor came over HTTPS: server.ts
// trusts Cloudflare's hop, so req.secure sees the visitor's https. Path=/api:
// never sent with the app's pages or assets.
const mediaCookieOptions = (req: express.Request): express.CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  path: '/api',
});

/** Gives this browser the media cookie for `token`, expiring with it. */
export function setMediaCookie(req: express.Request, res: express.Response, token: string): void {
  const exp = (jwt.decode(token) as { exp?: unknown } | null)?.exp;
  res.cookie(MEDIA_COOKIE, token, {
    ...mediaCookieOptions(req),
    ...(typeof exp === 'number' ? { expires: new Date(exp * 1000) } : {}),
  });
}

export function clearMediaCookie(req: express.Request, res: express.Response): void {
  res.clearCookie(MEDIA_COOKIE, mediaCookieOptions(req));
}

/** The media cookie's token, or '' when the request has none. */
export function readMediaCookie(req: express.Request): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== MEDIA_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return '';
}

export type MediaViewer = { id?: unknown; role?: unknown };

/** Who is asking for a photo's or file's bytes: the first token that verifies
 *  among the Authorization header, ?token= (pdf.js and media elements handed
 *  one) and the media cookie. Null when none does. */
export function mediaViewer(req: express.Request, verifyToken: (token: string) => unknown | null): MediaViewer | null {
  const header = req.headers['authorization'];
  const tokens = [
    header ? header.split(' ')[1] : '',
    typeof req.query.token === 'string' ? req.query.token : '',
    readMediaCookie(req),
  ];
  for (const token of tokens) {
    const viewer = token ? verifyToken(token) : null;
    if (viewer) return viewer as MediaViewer;
  }
  return null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export interface AuthRouteDeps {
  db: Database.Database;
  jwtSecret: string;
  verifyToken: (token: string) => unknown | null;
  /** Caps login attempts per client (server.ts). */
  loginLimiter: express.RequestHandler;
}

export function registerAuthRoutes(app: express.Express, deps: AuthRouteDeps): void {
  const { db, jwtSecret, verifyToken, loginLimiter } = deps;

  app.post('/api/auth/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    try {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const validPassword = bcrypt.compareSync(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, jwtSecret, { expiresIn: '24h' });
      setMediaCookie(req, res, token);
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) {
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // A session that began before the media cookie existed (or lost it): the
  // app trades its token for the cookie as it starts. Only the header's token
  // counts, never a cookie; one that doesn't verify clears any old cookie.
  app.post('/api/auth/media-session', (req, res) => {
    const header = req.headers['authorization'];
    const token = header && header.split(' ')[1];
    if (!token || !verifyToken(token)) {
      clearMediaCookie(req, res);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    setMediaCookie(req, res, token);
    res.json({ success: true });
  });

  // Signing out. Nothing about a token is stored here to revoke, so this
  // clears the cookie and the app forgets its own copy of the token.
  app.post('/api/auth/logout', (req, res) => {
    clearMediaCookie(req, res);
    res.json({ success: true });
  });
}
