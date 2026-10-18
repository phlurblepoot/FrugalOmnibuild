// server/onlyoffice/tokens.ts — short-lived, single-purpose tokens that let the
// Document Server fetch one thing from this app (a connection-test file now;
// a document or a version later).
//
// Never a user's login JWT: that is valid for 24 hours against every route.
// These are signed with a key derived from the app secret for this one use,
// so a link token can never pass as a login token (or the reverse), and each
// one names the single thing it opens.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const AUDIENCE = 'onlyoffice';

export class LinkTokens {
  private readonly key: Buffer;

  constructor(appSecret: string) {
    this.key = crypto.createHmac('sha256', appSecret).update('onlyoffice-link-token-v1').digest();
  }

  sign(subject: string, ttlSeconds: number): string {
    return jwt.sign({}, this.key, { algorithm: 'HS256', audience: AUDIENCE, subject, expiresIn: ttlSeconds });
  }

  /** True only for an unexpired token issued for exactly this subject. */
  verify(token: string, subject: string): boolean {
    if (!token) return false;
    try {
      jwt.verify(token, this.key, { algorithms: ['HS256'], audience: AUDIENCE, subject });
      return true;
    } catch {
      return false;
    }
  }
}
