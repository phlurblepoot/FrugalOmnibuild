import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { LinkTokens } from './tokens';

describe('LinkTokens', () => {
  const tokens = new LinkTokens('app-secret');

  it('verifies a fresh token for the subject it was issued for', () => {
    expect(tokens.verify(tokens.sign('file:abc', 60), 'file:abc')).toBe(true);
  });

  it('rejects a token for a different subject, an expired one, and an empty one', () => {
    expect(tokens.verify(tokens.sign('file:abc', 60), 'file:xyz')).toBe(false);
    expect(tokens.verify(tokens.sign('file:abc', -10), 'file:abc')).toBe(false);
    expect(tokens.verify('', 'file:abc')).toBe(false);
  });

  it('rejects tokens from another app secret', () => {
    expect(new LinkTokens('other-secret').verify(tokens.sign('file:abc', 60), 'file:abc')).toBe(false);
  });

  it('never crosses over with login tokens signed by the app secret', () => {
    const login = jwt.sign({ id: 'u1', username: 'noah', role: 'admin', sub: 'file:abc', aud: 'onlyoffice' }, 'app-secret');
    expect(tokens.verify(login, 'file:abc')).toBe(false);
    expect(() => jwt.verify(tokens.sign('file:abc', 60), 'app-secret')).toThrow();
  });
});
