// src/pages/settings/BackupSetupGuide.tsx — the collapsible "Setup guide" on
// Settings → Backup (admin only): the backup folder, and connecting Google
// Drive from nothing.
//
// Like the mail guide, everything host-specific comes from the server (the
// `setup` block of GET /api/backup/status) rather than being templated here:
// a redirect URI must be byte-identical to the one the Drive sign-in sends, so
// the guide shows the server's own values with copy buttons. The steps mirror
// docs/mail-setup.md §4.1.
import React from 'react';
import { AlertTriangle, BookOpen, KeyRound } from 'lucide-react';
import { StatusPill } from '../../components/ui';
import { CopyValue, EnvRow, Step } from '../mail/MailSetupGuide';
import type { BackupStatus } from '../../utils/store';

// Google accepts plain http:// redirect URIs only for localhost.
const refusedByGoogle = (url: string): boolean =>
  !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url);

const Code: React.FC<{ children: string }> = ({ children }) => (
  <pre className="overflow-x-auto rounded-lg border border-edge bg-sunken px-3 py-2 font-mono text-xs text-ink">{children}</pre>
);

const Problem: React.FC<{ symptom: string; children: React.ReactNode }> = ({ symptom, children }) => (
  <div className="py-2">
    <div className="font-mono text-xs text-ink">{symptom}</div>
    <div className="mt-0.5 text-sm text-ink-soft">{children}</div>
  </div>
);

export const BackupSetupGuide: React.FC<{
  setup: BackupStatus['setup'];
  root: string;
  rootIsDefault: boolean;
}> = ({ setup, root, rootIsDefault }) => {
  const googleReady = setup.googleClientId && setup.googleClientSecret && !!setup.publicUrl;
  const origin = setup.publicUrl?.replace(/\/+$/, '') ?? 'https://takeoff.example.com';

  return (
    <details className="rounded-xl border border-edge bg-raised" data-testid="backup-setup-guide">
      <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink">
        <span className="inline-flex items-center gap-2 align-middle">
          <BookOpen size={16} className="text-accent-600" /> Setup guide — backup folder and Google Drive
        </span>
      </summary>
      <div className="space-y-6 border-t border-edge px-5 py-4">
        <p className="text-sm text-ink-soft">
          One-time setup on the server itself. The addresses and settings below are the ones this server is actually using.
        </p>

        {/* ── Backup folder ── */}
        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            Backup folder
            <StatusPill tone={rootIsDefault ? 'amber' : 'green'}>{rootIsDefault ? 'On the data disk' : 'Set'}</StatusPill>
          </h3>
          <ol className="list-decimal space-y-1 pl-5">
            <Step>Pick a folder on a <strong>different disk</strong> from the app&rsquo;s data — a second drive, a NAS share, or a USB disk that stays plugged in. A copy on the same disk is lost with it.</Step>
            <Step>Mount that folder into the container and point <code>BACKUP_PATH</code> at it. In <code>docker-compose.yml</code>:</Step>
          </ol>
          <Code>{`    volumes:
      - ./data:/app/data
      - /mnt/backups/frugalomnibuild:/backups
    environment:
      - BACKUP_PATH=/backups`}</Code>
          <ol className="list-decimal space-y-1 pl-5" start={3}>
            <Step>Restart the container (<code>docker compose up -d</code>). The amber same-disk warning above goes away once it is set.</Step>
          </ol>
        </section>

        {/* ── Google Drive ── */}
        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            Google Drive
            <StatusPill tone={googleReady ? 'green' : 'slate'}>{googleReady ? 'Configured' : 'Not configured'}</StatusPill>
          </h3>
          <p className="text-sm text-ink-soft">
            If Gmail sign-in already works on this server, use the same Google Cloud project and OAuth client: enable the
            Drive API (step 1) and add the two addresses in step 3.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <Step>
              Go to <strong>console.cloud.google.com</strong>, create or pick a project, then
              {' '}<strong>APIs &amp; Services → Library</strong> → search <strong>Google Drive API</strong> → <strong>Enable</strong>.
            </Step>
            <Step>
              <strong>Google Auth Platform → Audience</strong> (older menus: <em>OAuth consent screen</em>):
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li><strong>Internal</strong> when the Drive account is a Google Workspace account in your company. Nothing else to do.</li>
                <li>
                  <strong>External</strong> for a personal @gmail.com account — then click <strong>Publish app</strong> so the
                  status reads <strong>In production</strong>. The app only asks for the <code>drive.file</code> permission, so
                  publishing needs no review from Google.
                </li>
              </ul>
              <span className="mt-1 flex items-start gap-2 text-amber-700 dark:text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>Left in <strong>Testing</strong>, Google cancels the app&rsquo;s access after 7 days and Drive backups stop until someone reconnects.</span>
              </span>
            </Step>
            <Step>
              <strong>Clients</strong> (older menus: <em>Credentials</em>) → <strong>Create client</strong> →
              {' '}<strong>OAuth client ID</strong> → type <strong>Web application</strong>. Under
              {' '}<strong>Authorized redirect URIs</strong> add both of these:
            </Step>
          </ol>
          <div className="space-y-1.5">
            <p className="text-xs text-ink-faint">For Connect Google Drive on this page:</p>
            <CopyValue label="the backup redirect URI" value={setup.redirectUris?.backup ?? null} />
            <p className="text-xs text-ink-faint">For restoring from Drive on a fresh install:</p>
            <CopyValue label="the restore redirect URI" value={setup.redirectUris?.restore ?? null} />
          </div>
          <ol className="list-decimal space-y-1 pl-5" start={4}>
            <Step>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the server&rsquo;s environment (<code>docker-compose.yml</code>) and restart the container:</Step>
          </ol>
          <Code>{`      - APP_PUBLIC_URL=${origin}
      - GOOGLE_OAUTH_CLIENT_ID=<client id>
      - GOOGLE_OAUTH_CLIENT_SECRET=<client secret>`}</Code>
          <p className="text-xs text-ink-faint">
            <code className="font-mono">APP_PUBLIC_URL</code> is the https:// address people type to reach the app. Google refuses
            {' '}http:// addresses and bare IP addresses like 192.168.1.20 as redirect URIs.
          </p>
          {setup.publicUrl && refusedByGoogle(setup.publicUrl) && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                <strong>APP_PUBLIC_URL is {setup.publicUrl}</strong> — Google will not accept a redirect URI that is not https://.
                Put the app behind an https address first.
              </span>
            </p>
          )}
          <ol className="list-decimal space-y-1 pl-5" start={5}>
            <Step>
              Back on this page: <strong>Connect Google Drive</strong> → pick the account → allow access → <strong>Back up to Drive now</strong>.
              A <strong>FrugalOmnibuild Backups</strong> folder (or <strong>Frugal Takeoff Backups</strong> on older installs) appears in that account&rsquo;s Drive. Then turn on the Drive schedule below.
            </Step>
          </ol>
          <p className="flex items-start gap-2 rounded-lg border border-edge bg-sunken px-3 py-2 text-xs text-ink-soft">
            <KeyRound size={14} className="mt-0.5 shrink-0" />
            <span>
              Keep the client ID, client secret and project name somewhere safe besides this server, such as a password
              manager. The app can only see Drive files it created itself, and Google ties that to this OAuth client&rsquo;s
              project — a rebuilt server needs the same client ID and secret (and the same APP_PUBLIC_URL) to find these backups.
            </span>
          </p>
        </section>

        {/* ── Env vars ── */}
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-ink">Environment variables on this server</h3>
          <div className="divide-y divide-edge">
            <EnvRow name="BACKUP_PATH" set={!rootIsDefault} note={root} />
            <EnvRow name="APP_PUBLIC_URL" set={!!setup.publicUrl} note={setup.publicUrl ?? 'required for Google Drive'} />
            <EnvRow name="GOOGLE_OAUTH_CLIENT_ID" set={setup.googleClientId} />
            <EnvRow name="GOOGLE_OAUTH_CLIENT_SECRET" set={setup.googleClientSecret} />
          </div>
        </section>

        {/* ── Troubleshooting ── */}
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-ink">If connecting fails</h3>
          <div className="divide-y divide-edge">
            <Problem symptom="redirect_uri_mismatch">
              The address in Google doesn&rsquo;t exactly match the ones above — check https vs http, www, a port number, or a trailing slash.
            </Problem>
            <Problem symptom="access_denied / org_internal">
              The app is Internal and the account is outside your Workspace, or it is External, still in Testing, and the account isn&rsquo;t listed as a test user.
            </Problem>
            <Problem symptom="Google Drive API has not been used in project …">
              Step 1 was done in a different project from the OAuth client.
            </Problem>
            <Problem symptom="No refresh token returned">
              Remove the app under Google Account → Security → Third-party access, then connect again.
            </Problem>
            <Problem symptom="Reconnect needed about a week after connecting">
              The app is External and still in Testing (step 2). Publish it, then reconnect.
            </Problem>
          </div>
        </section>
      </div>
    </details>
  );
};
