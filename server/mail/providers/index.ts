// server/mail/providers/index.ts
// The one place a MailAccountRow turns into a live MailProvider.
import type Database from 'better-sqlite3';
import type { MailAccountRow, ImapAuth, OAuthAuth } from '../accountStore';
import * as accounts from '../accountStore';
import type { MailCrypto } from '../crypto';
import type { MailProvider } from './types';
import { getFakeProvider } from './fakeRegistry';
import { ImapMailProvider } from './imap';
import { GmailProvider, googleRefresh } from './google';
import { GraphProvider, microsoftRefresh } from './microsoft';
import { TokenSource } from './tokenSource';

export interface ProviderDeps { env: NodeJS.ProcessEnv; db: Database.Database; crypto: MailCrypto; fetch: typeof fetch }

export const defaultProviderDeps = (db: Database.Database, crypto: MailCrypto): ProviderDeps =>
  ({ env: process.env, db, crypto, fetch: globalThis.fetch });

function need(env: NodeJS.ProcessEnv, ...keys: string[]): void {
  for (const k of keys) if (!env[k]) throw new Error(`${k} is not set — see Settings → Mail → Server setup guide`);
}

// MAIL_FAKE_PROVIDER=1 routes every account through the fake — the dev/e2e
// switch that lets the whole mail UI be exercised without real credentials.
export function createMailProvider(account: MailAccountRow, auth: ImapAuth | OAuthAuth, deps: ProviderDeps): MailProvider {
  if (deps.env.MAIL_FAKE_PROVIDER === '1' || account.provider === 'fake') return getFakeProvider(account.id);
  const onRotate = (rt: string) => { if (deps.db) accounts.updateAuth(deps.db, deps.crypto, account.id, { refreshToken: rt }); };
  switch (account.provider) {
    case 'imap':
      return new ImapMailProvider(auth as ImapAuth, { fromAddress: account.emailAddress });
    case 'google': {
      need(deps.env, 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET');
      const ts = new TokenSource({ refreshToken: (auth as OAuthAuth).refreshToken, refresh: rt => googleRefresh(deps.env, rt, deps.fetch), onRotate });
      return new GmailProvider(ts, { fetch: deps.fetch, emailAddress: account.emailAddress });
    }
    case 'microsoft': {
      need(deps.env, 'MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET');
      const ts = new TokenSource({ refreshToken: (auth as OAuthAuth).refreshToken, refresh: rt => microsoftRefresh(deps.env, rt, deps.fetch), onRotate });
      return new GraphProvider(ts, { fetch: deps.fetch });
    }
    default:
      throw new Error(`Unknown mail provider ${account.provider}`);
  }
}
