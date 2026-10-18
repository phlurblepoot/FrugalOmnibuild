// Which account a send goes out through. This rule is duplicated on the server
// (server/mail/sendService.ts) — the two must agree, or the Send button and the
// send route disagree about whether a send can happen at all.
import { describe, it, expect } from 'vitest';
import { pickSendableAccount, mailSendBlockedReason, NO_MAIL_ACCOUNT_REASON, type MailAccountSummary } from './store';

const acct = (o: Partial<MailAccountSummary>): MailAccountSummary =>
  ({ id: 'a', provider: 'imap', emailAddress: 'a@b.com', displayName: null, isDefault: 0, status: 'ok', unreadCount: 0, ...o });

describe('pickSendableAccount', () => {
  it('prefers the default account when it is usable', () => {
    const d = acct({ id: 'd', isDefault: 1 });
    expect(pickSendableAccount([acct({ id: 'x' }), d])?.id).toBe('d');
  });

  it('falls through to the first usable account when the default cannot send', () => {
    const list = [acct({ id: 'd', isDefault: 1, status: 'needs_review' }), acct({ id: 'x', status: 'syncing' })];
    expect(pickSendableAccount(list)?.id).toBe('x');
  });

  it('is null when nothing is usable, and only then does it block Send', () => {
    expect(pickSendableAccount([])).toBeNull();
    expect(pickSendableAccount([acct({ status: 'auth_error' }), acct({ status: 'disabled' })])).toBeNull();
    expect(mailSendBlockedReason([])).toBe(NO_MAIL_ACCOUNT_REASON);
    expect(mailSendBlockedReason([acct({})])).toBeUndefined();
  });
});
