// src/pages/settings/ImapAccountForm.test.tsx
//
// The IMAP form is the only place in the app that hands the server a mailbox
// password, and "Test & save" is two calls (save, then test) that can fail
// independently — so these tests pin the halves apart: nothing is sent until
// the required fields are there, a save whose test fails keeps the modal open
// with the server's own message, and a retry after that failure UPDATES the
// account it already created instead of adding a second one.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MailAccount } from '../mail/types';

const h = vi.hoisted(() => ({
  createImapAccount: vi.fn(),
  testAccount: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../utils/mailApi', () => ({ mailApi: h }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

import { ImapAccountForm } from './ImapAccountForm';

const ACCOUNT: MailAccount = {
  id: 'a1', provider: 'imap', emailAddress: 'noah@birchwoodplaster.example', displayName: 'Noah',
  signatureHtml: null, isDefault: 1, status: 'needs_review', lastSyncAt: null, lastError: null,
  indexedSince: '2026-02-01T00:00:00.000Z', unreadCount: 0,
  imapAuth: {
    imapHost: 'imap.birchwoodplaster.example', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.birchwoodplaster.example', smtpPort: 587, smtpSecure: false, username: 'noah-imap',
  },
};

beforeEach(() => {
  h.createImapAccount.mockReset();
  h.testAccount.mockReset();
  h.toast.mockReset();
});

const mount = (existing?: MailAccount) => {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<ImapAccountForm open onClose={onClose} existing={existing} onSaved={onSaved} />);
  return { onClose, onSaved };
};

const fill = () => {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'Noah@Birchwood.example' } });
  fireEvent.change(screen.getByLabelText('IMAP host'), { target: { value: 'imap.birchwood.example' } });
  fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'smtp.birchwood.example' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'noah' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'app-password' } });
};

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Test & save' }));

describe('ImapAccountForm', () => {
  it('will not call the server until the required fields are filled in', async () => {
    mount();
    save();
    await screen.findByText('Email address is required');
    expect(screen.getByText('IMAP host is required')).toBeInTheDocument();
    expect(screen.getByText('SMTP host is required')).toBeInTheDocument();
    expect(screen.getByText('Username is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(h.createImapAccount).not.toHaveBeenCalled();
  });

  it('saves then tests, and closes once both succeed', async () => {
    h.createImapAccount.mockResolvedValue({ ...ACCOUNT, id: 'new1' });
    h.testAccount.mockResolvedValue(undefined);
    const { onClose, onSaved } = mount();
    fill();
    save();

    await waitFor(() => expect(h.testAccount).toHaveBeenCalledWith('new1'));
    expect(h.createImapAccount).toHaveBeenCalledWith({
      emailAddress: 'Noah@Birchwood.example',
      displayName: '',
      imapHost: 'imap.birchwood.example',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.birchwood.example',
      smtpPort: 587,
      smtpSecure: false,
      username: 'noah',
      password: 'app-password',
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('sends the ports and SSL choices the user picked', async () => {
    h.createImapAccount.mockResolvedValue({ ...ACCOUNT, id: 'new1' });
    h.testAccount.mockResolvedValue(undefined);
    mount();
    fill();
    fireEvent.change(screen.getByLabelText('IMAP port'), { target: { value: '143' } });
    fireEvent.click(screen.getByLabelText('IMAP uses SSL/TLS'));
    fireEvent.change(screen.getByLabelText('SMTP port'), { target: { value: '465' } });
    fireEvent.click(screen.getByLabelText('SMTP uses SSL/TLS (not STARTTLS)'));
    save();

    await waitFor(() => expect(h.createImapAccount).toHaveBeenCalled());
    expect(h.createImapAccount).toHaveBeenCalledWith(expect.objectContaining({
      imapPort: 143, imapSecure: false, smtpPort: 465, smtpSecure: true,
    }));
  });

  it('shows the server error inline and keeps the form open when the save is rejected', async () => {
    h.createImapAccount.mockRejectedValue(new Error('emailAddress is required'));
    const { onClose } = mount();
    fill();
    save();

    await screen.findByText('emailAddress is required');
    expect(h.testAccount).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the form open on a failed test, and a retry updates the same account', async () => {
    h.createImapAccount.mockResolvedValue({ ...ACCOUNT, id: 'new1' });
    h.testAccount.mockRejectedValueOnce(new Error('Invalid credentials'));
    const { onClose, onSaved } = mount();
    fill();
    save();

    await screen.findByText(/Invalid credentials/);
    expect(onClose).not.toHaveBeenCalled();
    // The row exists (in needs_review) even though the test failed, so the list refreshes.
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1' }));

    h.testAccount.mockResolvedValue(undefined);
    save();
    await waitFor(() => expect(h.createImapAccount).toHaveBeenCalledTimes(2));
    expect(h.createImapAccount.mock.calls[1][0]).toEqual(expect.objectContaining({ id: 'new1' }));
  });

  it('prefills an existing account from its non-secret imapAuth, password left blank', async () => {
    h.createImapAccount.mockResolvedValue(ACCOUNT);
    h.testAccount.mockResolvedValue(undefined);
    mount(ACCOUNT);

    expect(screen.getByLabelText('Email address')).toHaveValue('noah@birchwoodplaster.example');
    expect(screen.getByLabelText('Display name')).toHaveValue('Noah');
    expect(screen.getByLabelText('IMAP host')).toHaveValue('imap.birchwoodplaster.example');
    expect(screen.getByLabelText('IMAP port')).toHaveValue(993);
    expect(screen.getByLabelText('IMAP uses SSL/TLS')).toBeChecked();
    expect(screen.getByLabelText('SMTP host')).toHaveValue('smtp.birchwoodplaster.example');
    expect(screen.getByLabelText('SMTP port')).toHaveValue(587);
    expect(screen.getByLabelText('SMTP uses SSL/TLS (not STARTTLS)')).not.toBeChecked();
    expect(screen.getByLabelText('Username')).toHaveValue('noah-imap');
    expect(screen.getByLabelText('Password')).toHaveValue('');

    save();

    await waitFor(() => expect(h.createImapAccount).toHaveBeenCalled());
    expect(h.createImapAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1', imapHost: 'imap.birchwoodplaster.example', smtpHost: 'smtp.birchwoodplaster.example',
      username: 'noah-imap', password: '',
    }));
  });

  it('an existing account without imapAuth (older row, or not yet loaded) still starts blank', async () => {
    h.createImapAccount.mockResolvedValue(ACCOUNT);
    h.testAccount.mockResolvedValue(undefined);
    const { imapAuth: _omit, ...noAuth } = ACCOUNT;
    mount(noAuth as MailAccount);

    expect(screen.getByLabelText('IMAP host')).toHaveValue('');
    expect(screen.getByLabelText('SMTP host')).toHaveValue('');
    expect(screen.getByLabelText('Username')).toHaveValue('');
  });

  it('renders nothing when closed', () => {
    render(<ImapAccountForm open={false} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });
});
