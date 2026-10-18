// src/pages/settings/MailAccountsTab.test.tsx
//
// Settings → Mail is where a mailbox is connected, repaired, and removed, so
// the tests cover the states an account can be caught in rather than the happy
// path alone: a needs_review row (every migrated SMTP account starts there)
// must offer "Test & activate"; an auth_error row must offer Reconnect; a
// Connect button must be dead when the server has no credentials for that
// provider; and Remove must not delete a mailbox index without a confirm.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { MailAccount } from '../mail/types';

const h = vi.hoisted(() => ({
  accounts: vi.fn(),
  providers: vi.fn(),
  testAccount: vi.fn(),
  patchAccount: vi.fn(),
  deleteAccount: vi.fn(),
  oauthStartUrl: vi.fn((p: string) => `/api/mail/oauth/${p}/start?token=t`),
  setupInfo: vi.fn(),
  getUserPreferences: vi.fn(),
  saveUserPreferences: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../../utils/mailApi', () => ({ mailApi: h }));
vi.mock('../../utils/store', () => ({
  getUserPreferences: h.getUserPreferences,
  saveUserPreferences: h.saveUserPreferences,
}));
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: null }) }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
vi.mock('../../components/ConfirmDialog', async orig => ({
  ...(await orig<typeof import('../../components/ConfirmDialog')>()),
  useConfirm: () => h.confirm,
}));
// The real editor is covered by RichTextEditor.test.tsx; a textarea keeps the
// signature assertions off ProseMirror.
vi.mock('../mail/compose/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="signature-body" value={value} onChange={e => onChange(e.target.value)} />
  ),
}));
vi.mock('../mail/MailSetupGuide', () => ({ MailSetupGuide: () => <div data-testid="setup-guide" /> }));

import { MailAccountsTab, lastErrorTone } from './MailAccountsTab';

const acct = (over: Partial<MailAccount> = {}): MailAccount => ({
  id: 'a1', provider: 'imap', emailAddress: 'noah@birchwoodplaster.example', displayName: 'Noah',
  signatureHtml: null, isDefault: 1, status: 'ok', lastSyncAt: null, lastError: null,
  indexedSince: '2026-02-01T00:00:00.000Z', unreadCount: 0, ...over,
});

beforeEach(() => {
  for (const fn of Object.values(h)) if (typeof fn === 'function' && 'mockReset' in fn) (fn as any).mockReset();
  h.oauthStartUrl.mockImplementation((p: string) => `/api/mail/oauth/${p}/start?token=t`);
  h.accounts.mockResolvedValue([acct()]);
  h.providers.mockResolvedValue({ google: true, microsoft: true });
  h.getUserPreferences.mockResolvedValue({ emailAlwaysCc: 'boss@co.com' });
  h.saveUserPreferences.mockResolvedValue(undefined);
  h.confirm.mockResolvedValue(true);
  h.patchAccount.mockResolvedValue(acct());
});

const mount = (isAdmin = false) => render(<MailAccountsTab isAdmin={isAdmin} />);
const card = async (id = 'a1') => {
  await waitFor(() => expect(screen.getByTestId(`mail-account-${id}`)).toBeInTheDocument());
  return screen.getByTestId(`mail-account-${id}`);
};

describe('MailAccountsTab', () => {
  it('renders a card per account with its address, provider and status pill', async () => {
    h.accounts.mockResolvedValue([
      acct(),
      acct({ id: 'a2', provider: 'google', emailAddress: 'nick@gmail.com', isDefault: 0, status: 'syncing' }),
    ]);
    mount();
    expect(within(await card('a1')).getByText('noah@birchwoodplaster.example')).toBeInTheDocument();
    expect(within(await card('a1')).getByText('Connected')).toBeInTheDocument();
    expect(within(await card('a2')).getByText('Syncing')).toBeInTheDocument();
    expect(within(await card('a2')).getByText('Google')).toBeInTheDocument();
  });

  it('shows the last error and last sync time on a broken account', async () => {
    h.accounts.mockResolvedValue([acct({ status: 'auth_error', lastError: 'invalid_grant', lastSyncAt: null })]);
    mount();
    const c = await card();
    expect(within(c).getByText('Reconnect needed')).toBeInTheDocument();
    expect(within(c).getByText('invalid_grant')).toBeInTheDocument();
    expect(within(c).getByText('Never synced')).toBeInTheDocument();
  });

  it('offers Test & activate on a needs_review account and reloads after it passes', async () => {
    h.accounts.mockResolvedValue([acct({ status: 'needs_review' })]);
    h.testAccount.mockResolvedValue(undefined);
    mount();
    const c = await card();
    expect(within(c).getByText('Needs review')).toBeInTheDocument();
    fireEvent.click(within(c).getByRole('button', { name: 'Test & activate' }));

    await waitFor(() => expect(h.testAccount).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(h.accounts).toHaveBeenCalledTimes(2));
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('connected'), { type: 'success' });
  });

  it('reports the server message when Test & activate fails', async () => {
    h.accounts.mockResolvedValue([acct({ status: 'needs_review' })]);
    h.testAccount.mockRejectedValue(new Error('Authentication failed'));
    mount();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Test & activate' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Authentication failed', { type: 'error' }));
  });

  it('links Reconnect at the provider start URL for an OAuth account', async () => {
    h.accounts.mockResolvedValue([acct({ provider: 'google', status: 'auth_error' })]);
    mount();
    const link = within(await card()).getByRole('link', { name: 'Reconnect' });
    expect(link).toHaveAttribute('href', '/api/mail/oauth/google/start?token=t');
  });

  it('disables a Connect button the server has no credentials for', async () => {
    h.providers.mockResolvedValue({ google: false, microsoft: true });
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /Connect Google/ })).toBeDisabled());
    expect(screen.getByRole('button', { name: /Connect Google/ }))
      .toHaveAttribute('title', 'Not configured on this server — see the setup guide');
    expect(screen.getByRole('link', { name: /Connect Microsoft/ }))
      .toHaveAttribute('href', '/api/mail/oauth/microsoft/start?token=t');
  });

  it('confirms before removing an account, and does nothing if the confirm is declined', async () => {
    h.confirm.mockResolvedValue(false);
    mount();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Removes the local index for this mailbox'),
    })));
    expect(h.deleteAccount).not.toHaveBeenCalled();

    h.confirm.mockResolvedValue(true);
    h.deleteAccount.mockResolvedValue(undefined);
    fireEvent.click(within(await card()).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(h.deleteAccount).toHaveBeenCalledWith('a1'));
  });

  it('saves a signature through patchAccount', async () => {
    mount();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Signature' }));
    fireEvent.change(await screen.findByTestId('signature-body'), { target: { value: '<p>Thanks</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save signature' }));
    await waitFor(() => expect(h.patchAccount).toHaveBeenCalledWith('a1', { signatureHtml: '<p>Thanks</p>' }));
  });

  it('sets the default mailbox and toggles disable/enable', async () => {
    h.accounts.mockResolvedValue([acct(), acct({ id: 'a2', emailAddress: 'b@c.com', isDefault: 0 })]);
    mount();
    fireEvent.click(within(await card('a2')).getByRole('radio', { name: 'Default' }));
    await waitFor(() => expect(h.patchAccount).toHaveBeenCalledWith('a2', { isDefault: true }));

    // The reload after Disable brings the row back disabled, which is what
    // turns the same control into Enable — so this walks the round trip.
    h.accounts.mockResolvedValue([acct({ status: 'disabled' }), acct({ id: 'a2', emailAddress: 'b@c.com', isDefault: 0 })]);
    fireEvent.click(within(await card('a1')).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(h.patchAccount).toHaveBeenCalledWith('a1', { status: 'disabled' }));

    fireEvent.click(await within(await card('a1')).findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(h.patchAccount).toHaveBeenCalledWith('a1', { status: 'ok' }));
  });

  it('opens the IMAP form for Add and for Edit', async () => {
    mount();
    await card();
    fireEvent.click(screen.getByRole('button', { name: 'Add IMAP account' }));
    expect(await screen.findByLabelText('IMAP host')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByLabelText('IMAP host')).not.toBeInTheDocument());
    fireEvent.click(within(await card()).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByLabelText('Email address')).toHaveValue('noah@birchwoodplaster.example');
  });

  it('keeps the Always CC card working', async () => {
    mount();
    const input = await screen.findByLabelText('Always CC addresses');
    expect(input).toHaveValue('boss@co.com');
    fireEvent.change(input, { target: { value: 'boss@co.com, records@co.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(h.saveUserPreferences)
      .toHaveBeenCalledWith({ emailAlwaysCc: 'boss@co.com, records@co.com' }));
  });

  it('shows an empty state when no mailbox is connected', async () => {
    h.accounts.mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/No mailbox connected/)).toBeInTheDocument();
  });

  it('shows the setup guide to admins only, and never asks for setup-info as a non-admin', async () => {
    mount(false);
    await card();
    expect(screen.queryByTestId('setup-guide')).not.toBeInTheDocument();
    expect(h.setupInfo).not.toHaveBeenCalled();

    mount(true);
    await waitFor(() => expect(screen.getByTestId('setup-guide')).toBeInTheDocument());
  });
  // A mailbox import being throttled by Google is a wait the server is already
  // handling, not something the user has to fix — a red error there sent Noah
  // looking for a broken connection that was working fine.
  it('shows a throttled import in amber and a real fault in red', async () => {
    h.accounts.mockResolvedValue([
      acct({ status: 'syncing', lastError: 'Mailbox import is rate limited by the provider — retrying automatically' }),
      acct({ id: 'a2', status: 'auth_error', lastError: 'invalid_grant' }),
    ]);
    mount();
    const waiting = within(await card('a1')).getByText(/rate limited/);
    expect(waiting.className).toContain('text-amber-600');
    expect(waiting.className).not.toContain('text-red-600');
    const broken = within(await card('a2')).getByText('invalid_grant');
    expect(broken.className).toContain('text-red-600');
  });

  it('lastErrorTone keeps the amber/red split on the message alone', () => {
    expect(lastErrorTone('Mailbox import is rate limited by the provider — retrying automatically'))
      .toBe('text-amber-600 dark:text-amber-400');
    expect(lastErrorTone('Gmail 403 — Rate Limited')).toBe('text-amber-600 dark:text-amber-400');
    expect(lastErrorTone('invalid_grant')).toBe('text-red-600 dark:text-red-400');
    expect(lastErrorTone('')).toBe('text-red-600 dark:text-red-400');
  });
});
