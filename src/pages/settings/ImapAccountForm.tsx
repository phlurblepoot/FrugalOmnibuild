// src/pages/settings/ImapAccountForm.tsx — add or repair an IMAP/SMTP mailbox.
//
// "Test & save" is deliberately two server calls, not one: the account row is
// written first (status `needs_review`) and only then tested, so a mailbox that
// saves but cannot connect still exists to be corrected instead of vanishing
// with the typed-in settings. That is also why a retry after a failed test
// carries the id of the row that was already created — otherwise every attempt
// would leave another dead account behind.
//
// The server never returns the stored PASSWORD (see server/mail/accountStore.ts
// — the auth blob is sealed and read-only to the server), but the accounts GET
// route does hand back the rest of an imap account's auth (host/port/username)
// for edit prefill (server/mail/routes.ts), so only the password field starts
// blank on an edit — leaving it blank keeps the one already stored.
import React, { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button, Checkbox, Field, Input, Modal, NumberInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { mailApi, type ImapAccountInput } from '../../utils/mailApi';
import type { MailAccount } from '../mail/types';

export interface ImapAccountFormProps {
  open: boolean;
  onClose: () => void;
  /** Present to edit an existing IMAP account in place. */
  existing?: MailAccount;
  /** Fired whenever the account row was written — including when the test then failed. */
  onSaved: (account: MailAccount) => void;
}

type Errors = Partial<Record<'emailAddress' | 'imapHost' | 'smtpHost' | 'username' | 'password', string>>;

const DEFAULTS = {
  emailAddress: '',
  displayName: '',
  imapHost: '',
  imapPort: '993',
  imapSecure: true,
  smtpHost: '',
  smtpPort: '587',
  smtpSecure: false,
  username: '',
  password: '',
};

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong');

export const ImapAccountForm: React.FC<ImapAccountFormProps> = ({ open, onClose, existing, onSaved }) => {
  const { toast } = useToast();
  const [form, setForm] = useState({ ...DEFAULTS });
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The id of a row this form already created; a retry updates it in place.
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      ...DEFAULTS,
      emailAddress: existing?.emailAddress ?? '',
      displayName: existing?.displayName ?? '',
      imapHost: existing?.imapAuth?.imapHost ?? '',
      imapPort: existing?.imapAuth ? String(existing.imapAuth.imapPort) : DEFAULTS.imapPort,
      imapSecure: existing?.imapAuth?.imapSecure ?? DEFAULTS.imapSecure,
      smtpHost: existing?.imapAuth?.smtpHost ?? '',
      smtpPort: existing?.imapAuth ? String(existing.imapAuth.smtpPort) : DEFAULTS.smtpPort,
      smtpSecure: existing?.imapAuth?.smtpSecure ?? DEFAULTS.smtpSecure,
      username: existing?.imapAuth?.username ?? '',
    });
    setErrors({});
    setServerError(null);
    setSavedId(null);
  }, [open, existing]);

  if (!open) return null;

  const set = <K extends keyof typeof DEFAULTS>(key: K, value: (typeof DEFAULTS)[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const accountId = existing?.id ?? savedId;

  const validate = (): Errors => {
    const e: Errors = {};
    if (!form.emailAddress.trim()) e.emailAddress = 'Email address is required';
    if (!form.imapHost.trim()) e.imapHost = 'IMAP host is required';
    if (!form.smtpHost.trim()) e.smtpHost = 'SMTP host is required';
    if (!form.username.trim()) e.username = 'Username is required';
    // A stored password is kept when this box is left blank, so it is only
    // required for an account that does not exist yet.
    if (!accountId && !form.password) e.password = 'Password is required';
    return e;
  };

  const submit = async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    setServerError(null);
    try {
      const body: ImapAccountInput = {
        ...(accountId ? { id: accountId } : {}),
        emailAddress: form.emailAddress,
        displayName: form.displayName,
        imapHost: form.imapHost,
        imapPort: Number(form.imapPort) || 993,
        imapSecure: form.imapSecure,
        smtpHost: form.smtpHost,
        smtpPort: Number(form.smtpPort) || 587,
        smtpSecure: form.smtpSecure,
        username: form.username,
        password: form.password,
      };
      const account = await mailApi.createImapAccount(body);
      setSavedId(account.id);
      onSaved(account);
      try {
        await mailApi.testAccount(account.id);
      } catch (e) {
        setServerError(
          `Saved, but the connection test failed: ${errText(e)} — the account stays in Needs review until a test passes.`
        );
        return;
      }
      toast('Mail account connected.', { type: 'success' });
      onClose();
    } catch (e) {
      setServerError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title={existing ? 'Edit mail account' : 'Add IMAP account'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Testing…' : 'Test & save'}</Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={e => { e.preventDefault(); void submit(); }}
      >
        {serverError && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{serverError}</span>
          </p>
        )}

        {existing && (
          <p className="rounded-lg border border-edge bg-sunken px-3 py-2 text-xs text-ink-soft">
            The stored password is never sent back to the browser. Leave it blank to keep the one already saved.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email address" htmlFor="imap-email" error={errors.emailAddress}>
            <Input id="imap-email" type="email" autoComplete="off" value={form.emailAddress}
              onChange={e => set('emailAddress', e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field label="Display name" htmlFor="imap-display" hint="Shown as the sender name on mail you send.">
            <Input id="imap-display" value={form.displayName}
              onChange={e => set('displayName', e.target.value)} placeholder="Jane at Example Co" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="IMAP host" htmlFor="imap-host" error={errors.imapHost}>
            <Input id="imap-host" value={form.imapHost}
              onChange={e => set('imapHost', e.target.value)} placeholder="imap.company.com" />
          </Field>
          <Field label="IMAP port" htmlFor="imap-port">
            <NumberInput id="imap-port" inputMode="numeric" value={form.imapPort}
              onChange={e => set('imapPort', e.target.value)} />
          </Field>
        </div>
        <Checkbox label="IMAP uses SSL/TLS" checked={form.imapSecure}
          onChange={e => set('imapSecure', e.target.checked)} />

        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="SMTP host" htmlFor="smtp-host" error={errors.smtpHost}>
            <Input id="smtp-host" value={form.smtpHost}
              onChange={e => set('smtpHost', e.target.value)} placeholder="smtp.company.com" />
          </Field>
          <Field label="SMTP port" htmlFor="smtp-port">
            <NumberInput id="smtp-port" inputMode="numeric" value={form.smtpPort}
              onChange={e => set('smtpPort', e.target.value)} />
          </Field>
        </div>
        <Checkbox label="SMTP uses SSL/TLS (not STARTTLS)" checked={form.smtpSecure}
          onChange={e => set('smtpSecure', e.target.checked)} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" htmlFor="imap-username" error={errors.username}
            hint="Usually the full email address.">
            <Input id="imap-username" autoComplete="off" value={form.username}
              onChange={e => set('username', e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="imap-password" error={errors.password}
            hint={existing ? 'Blank keeps the stored password.' : 'Many providers require an app password.'}>
            <Input id="imap-password" type="password" autoComplete="new-password" value={form.password}
              onChange={e => set('password', e.target.value)} />
          </Field>
        </div>

        {/* Submits on Enter without a second visible button (the footer holds the real one). */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
};
