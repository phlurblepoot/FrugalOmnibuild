// src/pages/settings/MailAccountsTab.tsx — Settings → Mail.
//
// Replaces the old Email tab. Outbound mail no longer has a global SMTP config:
// every user connects their own mailbox here, so this screen owns connecting
// (OAuth or IMAP), repairing (test / reconnect / edit), disabling and removing
// them — plus the per-user signature and the Always-CC preference the old tab
// already carried.
//
// The Connect / Reconnect controls are real <a href> links rather than buttons
// that assign window.location: the OAuth start route answers with a 302 to the
// provider, so a link is the honest element for it (middle-click, "copy link"),
// and it keeps the redirect testable without jsdom navigation.
import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Mail, Plus, RefreshCw, Save, Server, Trash2 } from 'lucide-react';
import { Button, StatusPill, type PillTone } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { getUserPreferences, saveUserPreferences } from '../../utils/store';
import { mailApi } from '../../utils/mailApi';
import { useMailAccounts } from '../mail/useMailAccounts';
import { MailSetupGuide } from '../mail/MailSetupGuide';
import { RichTextEditor } from '../mail/compose/RichTextEditor';
import type { MailAccount, MailAccountStatus } from '../mail/types';
import { ImapAccountForm } from './ImapAccountForm';

const STATUS_META: Record<MailAccountStatus, { label: string; tone: PillTone }> = {
  ok: { label: 'Connected', tone: 'green' },
  syncing: { label: 'Syncing', tone: 'blue' },
  needs_review: { label: 'Needs review', tone: 'amber' },
  auth_error: { label: 'Reconnect needed', tone: 'red' },
  disabled: { label: 'Disabled', tone: 'slate' },
};

const PROVIDER_LABEL: Record<MailAccount['provider'], string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  imap: 'IMAP',
  fake: 'Test provider',
};

const isOAuth = (p: MailAccount['provider']): p is 'google' | 'microsoft' => p === 'google' || p === 'microsoft';
/** `fake` is the dev/E2E stand-in for IMAP and is managed the same way. */
const isImapLike = (p: MailAccount['provider']): boolean => p === 'imap' || p === 'fake';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong');

/** "Last sync 5 min ago" — coarse on purpose; the exact second is never useful here. */
export function lastSyncLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never synced';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never synced';
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return 'Last sync just now';
  if (mins < 60) return `Last sync ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last sync ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Last sync ${days} day${days === 1 ? '' : 's'} ago`;
  return `Last sync ${new Date(iso).toLocaleDateString('en-US')}`;
}

/** How an account's `lastError` should read. A provider throttling a big first
 *  import is a wait, not a fault — the server keeps resuming it on its own — so
 *  it gets amber rather than the red reserved for something the user has to act
 *  on. Matches the server's wording (RATE_LIMIT_NOTICE in server/mail/sync/engine.ts). */
export function lastErrorTone(message: string): string {
  return /rate limited/i.test(message) ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
}

const ProviderBadge: React.FC<{ provider: MailAccount['provider'] }> = ({ provider }) => {
  if (provider === 'google') {
    return (
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-sunken font-bold text-[#4285F4]">
        G
      </span>
    );
  }
  if (provider === 'microsoft') {
    return (
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-sunken font-bold text-[#0078D4]">
        M
      </span>
    );
  }
  return (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-sunken text-ink-soft">
      <Server size={16} />
    </span>
  );
};

const LINK_BTN =
  'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-edge bg-raised ' +
  'px-4 text-sm font-medium text-ink transition-colors hover:bg-hover md:min-h-0 md:h-9';

const ConnectButton: React.FC<{ provider: 'google' | 'microsoft'; configured: boolean; label: string }> = ({
  provider, configured, label,
}) =>
  configured ? (
    <a href={mailApi.oauthStartUrl(provider)} className={LINK_BTN}>
      <Plus size={15} /> {label}
    </a>
  ) : (
    <Button variant="secondary" disabled title="Not configured on this server — see the setup guide">
      <Plus size={15} /> {label}
    </Button>
  );

const AccountCard: React.FC<{
  account: MailAccount;
  onChanged: () => void;
  onEdit: (a: MailAccount) => void;
}> = ({ account, onChanged, onEdit }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [sigOpen, setSigOpen] = useState(false);
  const [signature, setSignature] = useState(account.signatureHtml ?? '');
  const meta = STATUS_META[account.status] ?? STATUS_META.needs_review;

  // Another device (or the OAuth callback) can change the signature under us;
  // adopt the server's copy while the editor is closed.
  useEffect(() => { if (!sigOpen) setSignature(account.signatureHtml ?? ''); }, [account.signatureHtml, sigOpen]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, { type: 'success' });
      onChanged();
    } catch (e) {
      toast(errText(e), { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const yes = await confirm({
      title: 'Remove this mail account?',
      message: 'Removes the local index for this mailbox. Thread links stay.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!yes) return;
    await run(() => mailApi.deleteAccount(account.id), 'Mail account removed.');
  };

  return (
    <div data-testid={`mail-account-${account.id}`} className="rounded-xl border border-edge bg-raised p-4">
      <div className="flex flex-wrap items-start gap-3">
        <ProviderBadge provider={account.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-ink">{account.emailAddress}</span>
            <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          </div>
          {/* Each fact is its own <span> so it reads (and is queried) as a discrete label. */}
          <p className="mt-0.5 text-xs text-ink-soft">
            <span>{PROVIDER_LABEL[account.provider]}</span>
            {account.displayName && (
              <>
                <span aria-hidden> · </span>
                <span>{account.displayName}</span>
              </>
            )}
            <span aria-hidden> · </span>
            <span>{lastSyncLabel(account.lastSyncAt)}</span>
          </p>
          {account.lastError && (
            <p className={`mt-1 text-xs ${lastErrorTone(account.lastError)}`}>{account.lastError}</p>
          )}
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="radio"
            name="mail-default-account"
            className="size-4 accent-accent-600"
            checked={account.isDefault === 1}
            disabled={busy}
            onChange={() => run(() => mailApi.patchAccount(account.id, { isDefault: true }), 'Default mailbox updated.')}
          />
          Default
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {(account.status === 'needs_review' || isImapLike(account.provider)) && (
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => run(async () => { await mailApi.testAccount(account.id); }, 'Mail account connected.')}>
            <RefreshCw size={14} /> Test &amp; activate
          </Button>
        )}
        {isOAuth(account.provider) && (
          <a href={mailApi.oauthStartUrl(account.provider)} className={`${LINK_BTN} h-8 px-3 text-xs md:h-8`}>
            <KeyRound size={14} /> Reconnect
          </a>
        )}
        {isImapLike(account.provider) && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onEdit(account)}>Edit</Button>
        )}
        <Button size="sm" variant="secondary" disabled={busy} aria-expanded={sigOpen}
          onClick={() => setSigOpen(o => !o)}>Signature</Button>
        {account.status === 'disabled' ? (
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => run(() => mailApi.patchAccount(account.id, { status: 'ok' }), 'Mail account enabled.')}>
            Enable
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => run(() => mailApi.patchAccount(account.id, { status: 'disabled' }), 'Mail account disabled.')}>
            Disable
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" disabled={busy} onClick={remove}>
          <Trash2 size={14} /> Remove
        </Button>
      </div>

      {sigOpen && (
        <div className="mt-3 space-y-2 border-t border-edge pt-3">
          <p className="text-xs text-ink-soft">Appended to messages you send from this mailbox.</p>
          <RichTextEditor value={signature} onChange={setSignature} placeholder="Your signature…" minHeight={120} />
          <Button size="sm" disabled={busy}
            onClick={() => run(() => mailApi.patchAccount(account.id, { signatureHtml: signature }), 'Signature saved.')}>
            <Save size={14} /> Save signature
          </Button>
        </div>
      )}
    </div>
  );
};

const AlwaysCcCard: React.FC = () => {
  const { toast } = useToast();
  const [alwaysCc, setAlwaysCc] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getUserPreferences()
      .then(prefs => setAlwaysCc(prefs['emailAlwaysCc'] ?? ''))
      .catch(() => { /* an unreadable pref is the same as an empty one here */ });
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await saveUserPreferences({ emailAlwaysCc: alwaysCc });
      toast('Always CC saved.', { type: 'success' });
    } catch {
      toast('Failed to save Always CC.', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-edge bg-raised p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
        <Mail size={18} className="text-accent-600" /> Always CC
      </h2>
      <p className="mt-1 text-sm text-ink-soft">These addresses are added to CC on every template you send.</p>
      <div className="mt-4 space-y-1.5">
        <label htmlFor="mail-always-cc" className="block text-sm font-medium text-ink">Always CC addresses</label>
        <input
          id="mail-always-cc"
          className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-accent-400 focus:ring-2 focus:ring-accent-500/25 focus-visible:outline-none"
          value={alwaysCc}
          onChange={e => setAlwaysCc(e.target.value)}
          placeholder="e.g. boss@company.com, records@company.com"
        />
        <p className="text-xs text-ink-faint">Separate multiple addresses with a comma or semicolon.</p>
      </div>
      <Button className="mt-4" onClick={save} disabled={saving}>
        <Save size={16} /> {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
};

export const MailAccountsTab: React.FC<{ isAdmin?: boolean }> = ({ isAdmin = false }) => {
  const { accounts, loading, reload } = useMailAccounts();
  const [providers, setProviders] = useState<{ google: boolean; microsoft: boolean }>({ google: false, microsoft: false });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MailAccount | undefined>(undefined);

  useEffect(() => {
    // Which OAuth providers this server has credentials for — readable by any
    // user, unlike the admin-only setup-info the guide below uses.
    mailApi.providers().then(setProviders).catch(() => { /* leave both disabled */ });
  }, []);

  const openAdd = useCallback(() => { setEditing(undefined); setFormOpen(true); }, []);
  const openEdit = useCallback((a: MailAccount) => { setEditing(a); setFormOpen(true); }, []);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-edge bg-raised p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
              <Mail size={18} className="text-accent-600" /> Mail accounts
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              Mail is sent and read from your own mailbox. Everything the app emails — proposals, invoices, change
              orders, reports — goes out from the account you mark as default.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <ConnectButton provider="google" configured={providers.google} label="Connect Google" />
          <ConnectButton provider="microsoft" configured={providers.microsoft} label="Connect Microsoft" />
          <Button variant="secondary" onClick={openAdd}><Plus size={15} /> Add IMAP account</Button>
        </div>

        <div className="mt-4 space-y-3">
          {loading ? (
            <p className="text-sm text-ink-faint">Loading mail accounts…</p>
          ) : accounts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-edge p-6 text-center">
              <p className="text-sm font-medium text-ink">No mailbox connected yet</p>
              <p className="mt-1 text-sm text-ink-soft">
                Connect Google or Microsoft above, or add an IMAP account. Until then nothing can be emailed from
                the app.
              </p>
            </div>
          ) : (
            accounts.map(a => (
              <AccountCard key={a.id} account={a} onChanged={reload} onEdit={openEdit} />
            ))
          )}
        </div>
      </div>

      <AlwaysCcCard />

      {isAdmin && <MailSetupGuide />}

      <ImapAccountForm
        open={formOpen}
        existing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={reload}
      />
    </div>
  );
};
