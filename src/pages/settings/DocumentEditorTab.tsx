// src/pages/settings/DocumentEditorTab.tsx — Settings → Document Editor (admin only).
//
// ONLYOFFICE runs as its own container, and the editor only works when three
// separate connections do: the browser to ONLYOFFICE (through Cloudflare and
// Nginx Proxy Manager), this app to ONLYOFFICE, and ONLYOFFICE back to this app
// (to open files and send saves back). Each can break on its own, so this tab
// checks all three and says, in each failure message, which setting to fix.
// The server makes the two server-to-server checks; the browser check can only
// run here.
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FileText, RefreshCw } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, StatusPill, type PillTone } from '../../components/ui';
import { getOnlyofficeStatus, type OnlyofficeCheck, type OnlyofficeStatus } from '../../utils/store';
import { checkEditorScript } from '../../utils/onlyofficeApi';

type RowState = OnlyofficeCheck | { status: 'checking'; message: string };

const PILL: Record<RowState['status'], { label: string; tone: PillTone }> = {
  checking: { label: 'Checking…', tone: 'blue' },
  ok:       { label: 'Working',   tone: 'green' },
  failed:   { label: 'Problem',   tone: 'red' },
  skipped:  { label: 'Skipped',   tone: 'slate' },
};

const CHECKING: RowState = { status: 'checking', message: '' };

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong');

const CheckRow: React.FC<{ title: string; state: RowState }> = ({ title, state }) => (
  <li className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-start sm:gap-4" data-testid="oo-check">
    <div className="w-24 shrink-0"><StatusPill tone={PILL[state.status].tone}>{PILL[state.status].label}</StatusPill></div>
    <div className="min-w-0">
      <div className="text-sm font-medium text-ink">{title}</div>
      {state.message && <p className="mt-0.5 break-words text-sm text-ink-soft">{state.message}</p>}
    </div>
  </li>
);

const Setting: React.FC<{ label: string; variable: string; value: string | null }> = ({ label, variable, value }) => (
  <div className="min-w-0">
    <dt className="text-xs text-ink-faint">{label} <code className="text-[11px]">{variable}</code></dt>
    <dd className="break-all text-sm text-ink">{value || '—'}</dd>
  </div>
);

export const DocumentEditorTab: React.FC = () => {
  const [status, setStatus] = useState<OnlyofficeStatus | null>(null);
  const [browser, setBrowser] = useState<RowState>(CHECKING);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setChecking(true);
    setError(null);
    setStatus(null);
    setBrowser(CHECKING);
    try {
      const s = await getOnlyofficeStatus();
      setStatus(s);
      setBrowser(s.configured && s.publicUrl
        ? await checkEditorScript(s.publicUrl)
        : { status: 'skipped', message: 'Finish the setup above first.' });
    } catch (e) {
      setError(errText(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void run(); }, [run]);

  const serverRow = (pick: (s: OnlyofficeStatus) => OnlyofficeCheck): RowState => (status ? pick(status) : CHECKING);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><FileText size={18} className="text-accent-600" /> Document editor (ONLYOFFICE)</span>}
        />
        <CardBody className="space-y-4">
          <p className="text-sm text-ink-soft">
            PDFs, Word files and spreadsheets are edited in ONLYOFFICE, which runs as its own container next to this app.
            The addresses below come from the app container's environment; the step-by-step setup is in
            {' '}<code className="text-xs">docs/onlyoffice-setup.md</code>.
          </p>
          {status && !status.configured && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
              <div className="flex items-center gap-2 font-medium"><AlertTriangle size={16} /> ONLYOFFICE isn't set up yet</div>
              <p className="mt-1">Set these on the app container, then restart it:</p>
              <ul className="mt-2 space-y-1">
                {status.problems.map(p => (
                  <li key={p.variable}><code className="font-semibold">{p.variable}</code> — {p.problem}</li>
                ))}
              </ul>
            </div>
          )}
          {status?.configured && (
            <dl className="grid gap-3 sm:grid-cols-2">
              <Setting label="Browsers load the editor from" variable="ONLYOFFICE_PUBLIC_URL" value={status.publicUrl} />
              <Setting label="This app reaches ONLYOFFICE at" variable="ONLYOFFICE_INTERNAL_URL" value={status.internalUrl} />
              <Setting label="ONLYOFFICE reaches this app at" variable="APP_INTERNAL_URL" value={status.appInternalUrl} />
              <div className="min-w-0">
                <dt className="text-xs text-ink-faint">ONLYOFFICE version</dt>
                <dd className="text-sm text-ink">{status.version || '—'}</dd>
              </div>
            </dl>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Connection checks"
          actions={
            <Button variant="secondary" size="sm" disabled={checking} onClick={() => void run()}>
              <RefreshCw size={15} className={checking ? 'animate-spin' : ''} /> Check again
            </Button>
          }
        />
        <CardBody>
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400">Couldn't run the checks: {error}</p>
          ) : (
            <ul className="divide-y divide-edge">
              <CheckRow title="Your browser can load the editor" state={browser} />
              <CheckRow title="This app can reach ONLYOFFICE" state={serverRow(s => s.checks.appToOnlyoffice)} />
              <CheckRow title="ONLYOFFICE can reach this app" state={serverRow(s => s.checks.onlyofficeToApp)} />
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
