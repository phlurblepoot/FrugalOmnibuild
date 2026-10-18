// src/pages/mail/MailSetupGuide.tsx — admin-only "Server setup guide" panel
// under Settings → Mail.
//
// Everything host-specific comes from GET /api/mail/setup-info rather than
// being templated in the client: the redirect URI a provider console needs must
// be byte-identical to the one the server will actually send, and a guide that
// guessed it would be the most convincing possible way to send an admin down
// the wrong path. The steps themselves mirror docs/mail-setup.md §2–§3.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound } from 'lucide-react';
import { StatusPill } from '../../components/ui';
import { mailApi } from '../../utils/mailApi';
import type { SetupInfo } from './types';

/** Plain-HTTP LAN deployments have no navigator.clipboard; the value stays selectable there. */
const canCopy = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';

export const CopyValue: React.FC<{ label: string; value: string | null; unavailable?: string }> = ({
  label, value, unavailable = 'Set APP_PUBLIC_URL to see this',
}) => {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-edge px-3 py-2 text-xs text-ink-faint">
        {unavailable}
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* a failed copy just leaves the text selectable */ }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-sunken px-3 py-2">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-ink">{value}</code>
      {canCopy() && (
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
          className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
    </div>
  );
};

export const EnvRow: React.FC<{ name: string; set: boolean; note?: string }> = ({ name, set, note }) => (
  <div data-testid={`env-${name}`} className="flex flex-wrap items-center gap-2 py-1.5">
    <code className="font-mono text-xs text-ink">{name}</code>
    <StatusPill tone={set ? 'green' : 'slate'}>{set ? 'set' : 'not set'}</StatusPill>
    {note && <span className="text-xs text-ink-faint">{note}</span>}
  </div>
);

export const Step: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <li className="text-sm text-ink-soft [&>code]:font-mono [&>code]:text-xs">{children}</li>
);

export const MailSetupGuide: React.FC = () => {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    mailApi.setupInfo()
      .then(i => { if (!cancelled) setInfo(i); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the setup information'); });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-edge bg-raised p-6">
        <h2 className="text-base font-semibold text-ink">Server setup guide</h2>
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="rounded-xl border border-edge bg-raised p-6 text-sm text-ink-faint">Loading setup guide…</div>
    );
  }

  return (
    <div className="space-y-5 rounded-xl border border-edge bg-raised p-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Server setup guide</h2>
        <p className="mt-1 text-sm text-ink-soft">
          One-time, admin-only. Google and Microsoft need an app registration on their side; generic IMAP needs
          nothing here. Values below are the ones this deployment actually resolved.
        </p>
      </div>

      {!info.publicUrl && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            <strong>APP_PUBLIC_URL is not set</strong> on this server. Google and Microsoft sign-in answers 503 and
            Microsoft accounts fall back to polling until it is set to the HTTPS origin users reach the app on.
          </span>
        </p>
      )}

      {/* ── Google ── */}
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          Google Workspace
          <StatusPill tone={info.google.configured ? 'green' : 'slate'}>
            {info.google.configured ? 'Configured' : 'Not configured'}
          </StatusPill>
        </h3>
        <ol className="list-decimal space-y-1 pl-5">
          <Step>Google Cloud Console → your project → APIs &amp; Services → Library → enable <strong>Gmail API</strong>.</Step>
          <Step>OAuth consent screen → user type <strong>Internal</strong> (Workspace only; personal @gmail.com accounts would need External + verification and are not supported).</Step>
          <Step>Credentials → Create credentials → OAuth client ID → <strong>Web application</strong>, with this authorized redirect URI:</Step>
        </ol>
        <CopyValue label="the Google redirect URI" value={info.google.redirectUri} />
        <ol className="list-decimal space-y-1 pl-5" start={4}>
          <Step>Put the client id and secret in <code>GOOGLE_OAUTH_CLIENT_ID</code> / <code>GOOGLE_OAUTH_CLIENT_SECRET</code> and restart.</Step>
          <Step>Scopes requested (nothing to configure): <code>gmail.modify</code>, <code>gmail.send</code>, <code>openid</code>, <code>email</code>.</Step>
        </ol>

        {/* Optional: Gmail pushes through a Pub/Sub topic you own. Without it
            Gmail simply polls, which is why this reads as an add-on rather
            than a step 6 that looks mandatory. */}
        <div className="space-y-2 rounded-lg border border-edge bg-sunken/50 p-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
            Real-time push (optional)
            <StatusPill tone={info.google.pubsub.configured ? 'green' : 'slate'}>
              {info.google.pubsub.configured ? 'Configured' : 'Not configured'}
            </StatusPill>
          </h4>
          <p className="text-xs text-ink-faint">
            Gmail polls every 30 seconds while Mail is open and every 5 minutes otherwise. Cloud Pub/Sub makes new
            mail arrive within a second or two; polling stays on as the fallback either way.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <Step>Google Cloud Console → Pub/Sub → <strong>Create topic</strong>.</Step>
            <Step>On that topic, grant <code>gmail-api-push@system.gserviceaccount.com</code> the <strong>Pub/Sub Publisher</strong> role.</Step>
            <Step>Create a <strong>Push</strong> subscription on the topic with this endpoint URL (it contains a secret — treat it like a password):</Step>
          </ol>
          <CopyValue label="the Gmail push endpoint" value={info.google.pubsub.webhookUrl} />
          <ol className="list-decimal space-y-1 pl-5" start={4}>
            <Step>
              Set <code>GOOGLE_PUBSUB_TOPIC</code> to the full topic name
              {info.google.pubsub.topic ? <> (currently <code>{info.google.pubsub.topic}</code>)</> : <> (<code>projects/&lt;project&gt;/topics/&lt;topic&gt;</code>)</>}
              {' '}and restart. The server renews each mailbox&rsquo;s watch automatically.
            </Step>
          </ol>
        </div>
      </section>

      {/* ── Microsoft ── */}
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          Microsoft 365
          <StatusPill tone={info.microsoft.configured ? 'green' : 'slate'}>
            {info.microsoft.configured ? 'Configured' : 'Not configured'}
          </StatusPill>
        </h3>
        <ol className="list-decimal space-y-1 pl-5">
          <Step>Entra admin center → App registrations → New registration (single tenant unless other tenants must connect), with this Web redirect URI:</Step>
        </ol>
        <CopyValue label="the Microsoft redirect URI" value={info.microsoft.redirectUri} />
        <ol className="list-decimal space-y-1 pl-5" start={2}>
          <Step>API permissions → Microsoft Graph → Delegated: <code>Mail.ReadWrite</code>, <code>Mail.Send</code>, <code>User.Read</code>, <code>offline_access</code> → <strong>Grant admin consent</strong>.</Step>
          <Step>Certificates &amp; secrets → New client secret (the value is shown once).</Step>
          <Step>Set <code>MS_OAUTH_CLIENT_ID</code>, <code>MS_OAUTH_CLIENT_SECRET</code> and <code>MS_OAUTH_TENANT</code> (currently <code>{info.microsoft.tenant}</code>) and restart.</Step>
        </ol>
        <p className="text-xs text-ink-faint">
          Change notifications are delivered to this URL, which must be reachable from the internet over HTTPS.
          Without it, Microsoft accounts poll every 5 minutes instead.
        </p>
        <CopyValue label="the Graph webhook URL" value={info.microsoft.webhookUrl} />
      </section>

      {/* ── Generic IMAP ── */}
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-ink">Generic IMAP / SMTP</h3>
        <p className="text-sm text-ink-soft">
          No server setup. Each user adds their own with <strong>Add IMAP account</strong> above — host, port,
          username and (usually) an app password.
        </p>
      </section>

      {/* ── Env vars ── */}
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-ink">Environment variables on this server</h3>
        <div className="divide-y divide-edge">
          <EnvRow name="APP_PUBLIC_URL" set={!!info.publicUrl} note={info.publicUrl ?? 'required for OAuth and Microsoft push'} />
          <EnvRow name="GOOGLE_OAUTH_CLIENT_ID" set={info.google.configured} note="with GOOGLE_OAUTH_CLIENT_SECRET" />
          <EnvRow name="GOOGLE_PUBSUB_TOPIC" set={info.google.pubsub.configured} note={info.google.pubsub.topic ?? 'optional — Gmail real-time push'} />
          <EnvRow name="MS_OAUTH_CLIENT_ID" set={info.microsoft.configured} note="with MS_OAUTH_CLIENT_SECRET" />
          <EnvRow name="MS_OAUTH_TENANT" set={info.microsoft.tenant !== 'common'} note={info.microsoft.tenant} />
          <EnvRow name="MAIL_SECRET_KEY" set={info.secretKey === 'env'} note="encrypts stored mail credentials" />
        </div>
      </section>

      {/* ── Key file ── */}
      <p className="flex items-start gap-2 rounded-lg border border-edge bg-sunken px-3 py-2 text-xs text-ink-soft">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        {info.secretKey === 'env' ? (
          <span>
            Mail credentials are encrypted with <code className="font-mono">MAIL_SECRET_KEY</code> from the
            environment. Keep it with your backups — without it every user has to reconnect.
          </span>
        ) : (
          <span>
            No <code className="font-mono">MAIL_SECRET_KEY</code> is set, so the server generated
            {' '}<code className="font-mono">data/mail.key</code> and encrypts stored mail credentials with it.
            Back that file up with the data directory — without it every user has to reconnect (no other data is lost).
          </span>
        )}
      </p>
    </div>
  );
};
