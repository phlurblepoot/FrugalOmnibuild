import { describe, it, expect } from 'vitest';
import { createMailProvider } from './index';
import { FakeMailProvider } from './fake';
import { ImapMailProvider } from './imap';
import { GmailProvider } from './google';
import { GraphProvider } from './microsoft';

const base: any = { id: 'a1', userId: 'u1', emailAddress: 'x@y', displayName: null };
const deps: any = { env: {}, db: null, crypto: null, fetch: async () => new Response('{}') };

describe('createMailProvider', () => {
  it('routes by account.provider', () => {
    expect(createMailProvider({ ...base, provider: 'fake' }, { refreshToken: 'r' }, deps)).toBeInstanceOf(FakeMailProvider);
    expect(createMailProvider({ ...base, provider: 'imap' }, { imapHost: 'h', imapPort: 993, imapSecure: true, smtpHost: 's', smtpPort: 587, smtpSecure: false, username: 'u', password: 'p' }, deps)).toBeInstanceOf(ImapMailProvider);
    expect(createMailProvider({ ...base, provider: 'google' }, { refreshToken: 'r' }, { ...deps, env: { GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's' } })).toBeInstanceOf(GmailProvider);
    expect(createMailProvider({ ...base, provider: 'microsoft' }, { refreshToken: 'r' }, { ...deps, env: { MS_OAUTH_CLIENT_ID: 'i', MS_OAUTH_CLIENT_SECRET: 's' } })).toBeInstanceOf(GraphProvider);
  });
  it('MAIL_FAKE_PROVIDER=1 forces the fake for every provider kind', () => {
    expect(createMailProvider({ ...base, provider: 'google' }, { refreshToken: 'r' }, { ...deps, env: { MAIL_FAKE_PROVIDER: '1' } })).toBeInstanceOf(FakeMailProvider);
  });
  it('throws a clear error when OAuth env is missing', () => {
    expect(() => createMailProvider({ ...base, provider: 'google' }, { refreshToken: 'r' }, deps)).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });
});
