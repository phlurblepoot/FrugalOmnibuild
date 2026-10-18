// server/mail/oauth.test.ts  (spec §4.4, plan 2 task 5)
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { buildAuthUrl, exchangeCode, signState, verifyState, createVerifier, challengeOf, redirectUri, STATE_TYP } from './oauth';

/* eslint-disable @typescript-eslint/no-explicit-any */
const env: any = {
  GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gs',
  MS_OAUTH_CLIENT_ID: 'mid', MS_OAUTH_CLIENT_SECRET: 'ms', MS_OAUTH_TENANT: 'tenant1',
};

describe('oauth', () => {
  it('builds provider auth URLs with PKCE and exact redirect URIs', () => {
    const g = new URL(buildAuthUrl('google', env, 'https://app.test', 'st', 'ch'));
    expect(g.origin + g.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(g.searchParams.get('client_id')).toBe('gid');
    expect(g.searchParams.get('redirect_uri')).toBe('https://app.test/api/mail/oauth/google/callback');
    expect(g.searchParams.get('response_type')).toBe('code');
    expect(g.searchParams.get('scope')).toContain('gmail.modify');
    expect(g.searchParams.get('scope')).toContain('gmail.send');
    expect(g.searchParams.get('access_type')).toBe('offline');
    expect(g.searchParams.get('prompt')).toBe('consent');
    expect(g.searchParams.get('state')).toBe('st');
    expect(g.searchParams.get('code_challenge')).toBe('ch');
    expect(g.searchParams.get('code_challenge_method')).toBe('S256');
    // The client secret never rides in a URL the browser can see.
    expect(g.search).not.toContain('gs');

    const m = new URL(buildAuthUrl('microsoft', env, 'https://app.test/', 'st', 'ch'));
    expect(m.origin).toBe('https://login.microsoftonline.com');
    expect(m.pathname).toBe('/tenant1/oauth2/v2.0/authorize');
    expect(m.searchParams.get('redirect_uri')).toBe('https://app.test/api/mail/oauth/microsoft/callback');
    expect(m.searchParams.get('response_mode')).toBe('query');
    expect(m.searchParams.get('scope')).toContain('offline_access');
    expect(m.searchParams.get('scope')).toContain('Mail.Send');
    expect(m.searchParams.get('code_challenge_method')).toBe('S256');
    expect(m.search).not.toContain('ms');
  });

  it('defaults the Microsoft tenant to common and names a missing env var', () => {
    const noTenant = new URL(buildAuthUrl('microsoft', { ...env, MS_OAUTH_TENANT: '' } as any, 'https://app.test', 's', 'c'));
    expect(noTenant.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(() => buildAuthUrl('google', {} as any, 'https://app.test', 's', 'c')).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
    expect(() => buildAuthUrl('microsoft', { MS_OAUTH_CLIENT_ID: 'x' } as any, 'https://app.test', 's', 'c')).toThrow(/MS_OAUTH_CLIENT_SECRET/);
  });

  const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

  it('state round-trips, is bound to the secret and expires', () => {
    const s = signState('secret', { userId: 'u1', provider: 'google', verifier: 'v' });
    expect(verifyState('secret', s)).toMatchObject({ userId: 'u1', provider: 'google', verifier: 'v' });
    expect(() => verifyState('other', s)).toThrow();
    expect(() => verifyState('secret', 'not-a-jwt')).toThrow();
    // 10-minute lifetime, per spec §7.
    const claims = claimsOf(s);
    expect(claims.exp - claims.iat).toBe(600);
  });

  it('state carries a fresh nonce and a type claim', () => {
    const a = signState('secret', { userId: 'u1', provider: 'google', verifier: 'v' });
    const b = signState('secret', { userId: 'u1', provider: 'google', verifier: 'v' });
    expect(claimsOf(a).nonce).toMatch(/^[0-9a-f]{32}$/);
    // Two flows started in the same second must not be byte-identical.
    expect(claimsOf(a).nonce).not.toBe(claimsOf(b).nonce);
    expect(a).not.toBe(b);
    expect(verifyState('secret', a).nonce).toBe(claimsOf(a).nonce);
    expect(claimsOf(a).typ).toBe(STATE_TYP);
  });

  it('rejects a JWT that is not a state, and a state missing its nonce', () => {
    // A session token signed with the SAME secret must not pass as a state.
    const session = jwt.sign({ id: 'u1', username: 'nick', role: 'admin' }, 'secret', { expiresIn: '24h' });
    expect(() => verifyState('secret', session)).toThrow(/not a mail sign-in state/);
    // Neither may a hand-rolled state that skipped the nonce.
    const noNonce = jwt.sign({ userId: 'u1', provider: 'google', verifier: 'v', typ: STATE_TYP }, 'secret', { expiresIn: 600 });
    expect(() => verifyState('secret', noNonce)).toThrow(/Malformed/);
    const badProvider = jwt.sign({ userId: 'u1', provider: 'aol', verifier: 'v', nonce: 'n', typ: STATE_TYP }, 'secret', { expiresIn: 600 });
    expect(() => verifyState('secret', badProvider)).toThrow(/Malformed/);
    // Expiry is enforced.
    const expired = jwt.sign({ userId: 'u1', provider: 'google', verifier: 'v', nonce: 'n', typ: STATE_TYP }, 'secret', { expiresIn: -1 });
    expect(() => verifyState('secret', expired)).toThrow();
  });

  it('PKCE verifier/challenge are base64url S256', () => {
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(v);
    const c = challengeOf(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeOf(v)).toBe(c);
    expect(c).not.toBe(v);
  });

  it('redirectUri trims a trailing slash', () => {
    expect(redirectUri('https://app.test/', 'google')).toBe('https://app.test/api/mail/oauth/google/callback');
    expect(redirectUri('https://app.test', 'microsoft')).toBe('https://app.test/api/mail/oauth/microsoft/callback');
  });

  it('exchangeCode posts code+verifier and fetches identity', async () => {
    const calls: any[] = [];
    const f: any = async (url: string, init: any) => {
      calls.push({ url, init });
      if (/token/.test(url)) return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ email: 'me@birchwood.example', name: 'Nick' }), { status: 200 });
    };
    const r = await exchangeCode('google', env, 'https://app.test', 'code1', 'verif', f);
    expect(r).toEqual({ refreshToken: 'R', accessToken: 'A', email: 'me@birchwood.example', name: 'Nick' });
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].init.body).toContain('grant_type=authorization_code');
    expect(calls[0].init.body).toContain('code=code1');
    expect(calls[0].init.body).toContain('code_verifier=verif');
    expect(calls[0].init.body).toContain('redirect_uri=https%3A%2F%2Fapp.test%2Fapi%2Fmail%2Foauth%2Fgoogle%2Fcallback');
    expect(calls[1].url).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(calls[1].init.headers.Authorization).toBe('Bearer A');

    const noRt: any = async () => new Response(JSON.stringify({ access_token: 'A' }), { status: 200 });
    await expect(exchangeCode('google', env, 'https://app.test', 'c', 'v', noRt)).rejects.toThrow(/refresh token/);
  });

  it('exchangeCode reads the Microsoft tenant token endpoint and Graph identity', async () => {
    const calls: any[] = [];
    const f: any = async (url: string, init: any) => {
      calls.push({ url, init });
      if (/token/.test(url)) return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 });
      return new Response(JSON.stringify({ userPrincipalName: 'me@birchwood.example', displayName: 'Nick' }), { status: 200 });
    };
    const r = await exchangeCode('microsoft', env, 'https://app.test', 'c1', 'v1', f);
    expect(r).toEqual({ refreshToken: 'R', accessToken: 'A', email: 'me@birchwood.example', name: 'Nick' });
    expect(calls[0].url).toBe('https://login.microsoftonline.com/tenant1/oauth2/v2.0/token');
    expect(calls[1].url).toBe('https://graph.microsoft.com/v1.0/me');
    // `mail` wins over userPrincipalName when the mailbox differs from the login.
    const withMail: any = async (url: string) => /token/.test(url)
      ? new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 })
      : new Response(JSON.stringify({ mail: 'Box@birchwood.example', userPrincipalName: 'login@birchwood.example' }), { status: 200 });
    expect((await exchangeCode('microsoft', env, 'https://app.test', 'c', 'v', withMail)).email).toBe('box@birchwood.example');
  });

  it('exchangeCode echoes only the enumerated error code, never the description', async () => {
    const bad: any = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code sekritcode for verifier sekritverif' }), { status: 400 });
    await expect(exchangeCode('google', env, 'https://app.test', 'sekritcode', 'sekritverif', bad))
      .rejects.toThrow(/invalid_grant/);
    const e = await exchangeCode('google', env, 'https://app.test', 'sekritcode', 'sekritverif', bad).then(() => new Error('should have thrown'), (x: Error) => x);
    // The provider's free-text description is log-only: it can quote the grant back.
    expect(e.message).not.toContain('sekritcode');
    expect(e.message).not.toContain('sekritverif');
    expect(e.message).not.toContain('Bad code');

    // A non-enumerated `error` (free text, or a missing one) falls back to the status.
    const weird: any = async () => new Response(JSON.stringify({ error: 'Something <b>went</b> wrong sekritcode' }), { status: 500 });
    const w = await exchangeCode('google', env, 'https://app.test', 'sekritcode', 'v', weird).then(() => new Error('nope'), (x: Error) => x);
    expect(w.message).toBe('HTTP 500: the mail provider rejected the sign-in');

    const noIdentity: any = async (url: string) => /token/.test(url)
      ? new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 })
      : new Response('nope', { status: 403 });
    await expect(exchangeCode('google', env, 'https://app.test', 'c', 'v', noIdentity)).rejects.toThrow(/email address/);
  });

  it('rejects a Google address the provider says is unverified', async () => {
    const identity = (extra: object): any => async (url: string) => /token/.test(url)
      ? new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 })
      : new Response(JSON.stringify({ email: 'me@birchwood.example', ...extra }), { status: 200 });
    await expect(exchangeCode('google', env, 'https://app.test', 'c', 'v', identity({ email_verified: false })))
      .rejects.toThrow('Google reports this address is not verified');
    // Workspace omits the claim entirely — absence is not a rejection.
    expect((await exchangeCode('google', env, 'https://app.test', 'c', 'v', identity({}))).email).toBe('me@birchwood.example');
    expect((await exchangeCode('google', env, 'https://app.test', 'c', 'v', identity({ email_verified: true }))).email).toBe('me@birchwood.example');
  });
});
