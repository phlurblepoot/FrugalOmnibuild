import { describe, it, expect } from 'vitest';
import { normalizeTokenPayload } from './verifyPayload';

describe('normalizeTokenPayload', () => {
  it('passes a valid payload through', () => {
    expect(normalizeTokenPayload({ id: 'u1', username: 'noah', role: 'admin', iat: 1, exp: 2 }))
      .toEqual({ id: 'u1', username: 'noah', role: 'admin' });
  });
  it('rejects missing role (legacy token)', () => {
    expect(normalizeTokenPayload({ id: 'u1', username: 'noah' })).toBeNull();
  });
  it('rejects non-string id and empty strings', () => {
    expect(normalizeTokenPayload({ id: 5, username: 'n', role: 'admin' })).toBeNull();
    expect(normalizeTokenPayload({ id: '', username: 'n', role: 'admin' })).toBeNull();
  });
  it('rejects null/undefined/non-object', () => {
    expect(normalizeTokenPayload(null)).toBeNull();
    expect(normalizeTokenPayload('str')).toBeNull();
  });
});
