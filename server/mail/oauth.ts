// server/mail/oauth.ts  (spec §4.4, §7)
//
// The consent-screen dance for the two OAuth providers. Everything here is a
// pure function over `env` + an injected `fetch`, so the whole flow is testable
// without a browser or a real provider.
//
// State: there is no server-side session table. The `state` parameter is a JWT
// signed with the app's own JWT secret carrying { userId, provider, verifier }
// and a 10-minute expiry. The provider echoes it back on the callback, which is
// what tells us WHO started the flow — the callback itself is unauthenticated
// because the browser arrives from the provider, not from the app.
//
// The PKCE verifier rides inside that signed state. It is signed, not
// encrypted, so a user could read their own verifier — which is harmless: the
// token exchange also requires the client secret, which never leaves the server.
import { randomBytes, createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { GRAPH_SCOPES } from './providers/microsoft';

export type OAuthProvider = 'google' | 'microsoft';
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'microsoft'];
export const isOAuthProvider = (v: unknown): v is OAuthProvider =>
  typeof v === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(v);

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const MS_HOST = 'https://login.microsoftonline.com';
const MS_ME_URL = 'https://graph.microsoft.com/v1.0/me';
const TIMEOUT_MS = 30_000;
/** 10 minutes: long enough to read a consent screen, short enough that a state
 *  copied out of a browser history is useless. */
const STATE_TTL_SEC = 600;

// gmail.modify covers read/label/draft; gmail.send is listed explicitly so the
// grant survives a future narrowing of modify. openid+email are what make the
// userinfo call answer with an address.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
].join(' ');
// GRAPH_SCOPES already carries Mail.ReadWrite/Mail.Send/User.Read/offline_access.
const MS_SCOPES = `${GRAPH_SCOPES} openid email`;

const tenantOf = (env: NodeJS.ProcessEnv): string => env.MS_OAUTH_TENANT || 'common';

/** Missing credentials are a deployment problem, not a user error — the message
 *  names the variable so the setup guide can be followed straight from it. */
function need(env: NodeJS.ProcessEnv, ...keys: string[]): void {
  for (const k of keys) if (!env[k]) throw new Error(`${k} is not set — see Settings → Mail → Server setup guide`);
}

/** The redirect URI must match the one registered with the provider CHARACTER
 *  for character, so it is built in exactly one place. */
export function redirectUri(publicUrl: string, provider: OAuthProvider): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/mail/oauth/${provider}/callback`;
}

// ── PKCE ───────────────────────────────────────────────────────────────────
const b64url = (b: Buffer): string => b.toString('base64url');
/** RFC 7636 code verifier: 32 random bytes, base64url → 43 chars. */
export const createVerifier = (): string => b64url(randomBytes(32));
export const challengeOf = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

// ── signed state ───────────────────────────────────────────────────────────
/** Marks this JWT as an OAuth state and NOTHING else. The app signs session
 *  tokens with the same secret, so without a type claim a stolen session token
 *  would verify here as a state (and `authenticateToken` doesn't check `typ`
 *  either — but a state presented as a session yields no `id`, so it fails). */
export const STATE_TYP = 'mail_oauth_state';

export interface StatePayload { userId: string; provider: OAuthProvider; verifier: string; nonce: string }

export function signState(jwtSecret: string, payload: Omit<StatePayload, 'nonce'> & { nonce?: string }): string {
  // Two consent flows started in the same second by the same user would
  // otherwise produce byte-identical states; the nonce keeps each one distinct.
  const nonce = payload.nonce || randomBytes(16).toString('hex');
  return jwt.sign({ userId: payload.userId, provider: payload.provider, verifier: payload.verifier, nonce, typ: STATE_TYP },
    jwtSecret, { algorithm: 'HS256', expiresIn: STATE_TTL_SEC });
}

/** Throws on a bad signature, a wrong algorithm, an expired state, a JWT that
 *  isn't one of ours, or a payload that isn't shaped like a state. */
export function verifyState(jwtSecret: string, state: string): StatePayload {
  const claims = jwt.verify(state, jwtSecret, { algorithms: ['HS256'] }) as Partial<StatePayload> & { typ?: string };
  if (claims?.typ !== STATE_TYP) throw new Error('That token is not a mail sign-in state');
  if (typeof claims.userId !== 'string' || !claims.userId
    || typeof claims.verifier !== 'string' || !claims.verifier
    || typeof claims.nonce !== 'string' || !claims.nonce
    || !isOAuthProvider(claims.provider)) {
    throw new Error('Malformed sign-in state');
  }
  return { userId: claims.userId, provider: claims.provider, verifier: claims.verifier, nonce: claims.nonce };
}

// ── consent URL ────────────────────────────────────────────────────────────
export function buildAuthUrl(
  provider: OAuthProvider,
  env: NodeJS.ProcessEnv,
  publicUrl: string,
  state: string,
  codeChallenge: string,
): string {
  const redirect = redirectUri(publicUrl, provider);
  if (provider === 'google') {
    need(env, 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET');
    const q = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: redirect,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      // Without BOTH of these Google issues a refresh token only on the very
      // first consent, so a reconnect would come back with nothing to store.
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${GOOGLE_AUTH_URL}?${q}`;
  }
  need(env, 'MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET');
  const q = new URLSearchParams({
    client_id: env.MS_OAUTH_CLIENT_ID!,
    redirect_uri: redirect,
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${MS_HOST}/${encodeURIComponent(tenantOf(env))}/oauth2/v2.0/authorize?${q}`;
}

// ── code → tokens → identity ───────────────────────────────────────────────
export interface ExchangeResult { refreshToken: string; accessToken: string; email: string; name?: string }

interface TokenBody { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }

/** A provider's error text is shown to the user; scrub anything we handed it so
 *  an echoed grant can never ride back out into a redirect or a log. */
export const redactGrant = (msg: string, ...secrets: string[]): string => {
  let out = msg;
  for (const s of secrets) if (s) out = out.split(s).join('…');
  return out.slice(0, 300);
};

export async function exchangeCode(
  provider: OAuthProvider,
  env: NodeJS.ProcessEnv,
  publicUrl: string,
  code: string,
  codeVerifier: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ExchangeResult> {
  const google = provider === 'google';
  if (google) need(env, 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET');
  else need(env, 'MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET');

  const tokenUrl = google ? GOOGLE_TOKEN_URL : `${MS_HOST}/${encodeURIComponent(tenantOf(env))}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id: (google ? env.GOOGLE_OAUTH_CLIENT_ID : env.MS_OAUTH_CLIENT_ID)!,
    client_secret: (google ? env.GOOGLE_OAUTH_CLIENT_SECRET : env.MS_OAUTH_CLIENT_SECRET)!,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(publicUrl, provider),
  });
  if (!google) form.set('scope', MS_SCOPES);

  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as TokenBody;
  if (!res.ok) {
    // `error` is an enumerated OAuth code; `error_description` is free text the
    // provider composes and can quote the grant back into. Only the code is
    // shown, and only if it LOOKS like a code — the description stays in the log.
    console.error('[mail] oauth token exchange rejected', provider, res.status, redactGrant(body.error_description || '', code, codeVerifier));
    const enumerated = /^[a-z][a-z0-9_.-]{0,63}$/.test(String(body.error ?? '')) ? String(body.error) : `HTTP ${res.status}`;
    throw new Error(`${enumerated}: the mail provider rejected the sign-in`);
  }
  if (!body.access_token) throw new Error('The provider returned no access token');
  // Without a refresh token the account would work until the first access token
  // expired and then silently stop — better to fail the connect outright.
  if (!body.refresh_token) {
    throw new Error("No refresh token returned — remove the app from your account's third-party access and try again");
  }

  const accessToken = String(body.access_token);
  const idRes = await fetchFn(google ? GOOGLE_USERINFO_URL : MS_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const id = (await idRes.json().catch(() => ({}))) as { email?: string; email_verified?: boolean; name?: string; mail?: string; userPrincipalName?: string; displayName?: string };
  const email = (google ? id.email : id.mail || id.userPrincipalName) ?? '';
  if (!idRes.ok || !email) throw new Error('Connected, but the provider would not tell us the mailbox email address');
  // Only an explicit false is a rejection: Workspace omits the claim entirely.
  if (google && id.email_verified === false) throw new Error('Google reports this address is not verified');
  return {
    refreshToken: String(body.refresh_token),
    accessToken,
    email: email.trim().toLowerCase(),
    name: (google ? id.name : id.displayName) || undefined,
  };
}
