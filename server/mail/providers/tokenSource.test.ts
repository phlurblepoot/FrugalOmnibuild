import { describe, it, expect } from 'vitest';
import { TokenSource } from './tokenSource';
import { AuthExpiredError } from './types';

describe('TokenSource', () => {
  it('refreshes once and caches until near expiry', async () => {
    let calls = 0; let now = 0;
    const ts = new TokenSource({ refreshToken: 'r', refresh: async () => { calls++; return { accessToken: 'a' + calls, expiresInSec: 3600 }; }, now: () => now });
    expect(await ts.get()).toBe('a1'); expect(await ts.get()).toBe('a1');
    now = 3600_000 - 30_000; expect(await ts.get()).toBe('a2');
  });
  it('rotates the refresh token through onRotate', async () => {
    let rotated = ''; const ts = new TokenSource({ refreshToken: 'r', refresh: async () => ({ accessToken: 'a', expiresInSec: 10, refreshToken: 'r2' }), onRotate: t => { rotated = t; } });
    await ts.get(); expect(rotated).toBe('r2');
  });
  it('maps invalid_grant to AuthExpiredError, other errors pass through', async () => {
    const bad = new TokenSource({ refreshToken: 'r', refresh: async () => { throw new Error('invalid_grant: Token has been expired or revoked.'); } });
    await expect(bad.get()).rejects.toBeInstanceOf(AuthExpiredError);
    const net = new TokenSource({ refreshToken: 'r', refresh: async () => { throw new Error('ECONNRESET'); } });
    await expect(net.get()).rejects.toThrow('ECONNRESET');
  });
});
