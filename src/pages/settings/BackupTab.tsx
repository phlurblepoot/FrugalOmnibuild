// src/pages/settings/BackupTab.tsx — Settings → Backup (admin only).
//
// The whole point of this screen is to answer one question at a glance: is
// there a backup, and is it recent? So the status card leads with the last
// local and Drive runs (with their error text when they failed) rather than
// with the controls, and a backup root that still sits on the data volume is
// called out in amber — copying the data onto the same disk is not a backup.
//
// Connect / Reconnect are real <a href> links, not buttons that assign
// window.location: the Drive start route answers with a 302 to Google, so a
// link is the honest element for it (middle-click, "copy link") and it keeps
// the redirect testable without jsdom navigation. Same for the snapshot
// download, which streams a zip the browser saves itself.
//
// A run in progress is polled about once a second (GET /api/backup/progress
// reads server memory only) for its bar; the change feed's backupRun event
// still carries the finish.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Cloud, DatabaseBackup, Download, HardDrive, Play, RefreshCw, Save } from 'lucide-react';
import {
  Button, Card, CardBody, CardHeader, Checkbox, Field, Input, ProgressBar, Select, Skeleton, StatusPill,
  Table, TBody, TD, TH, THead, TR, NumberInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import {
  BackupRunningError, backupDownloadUrl, backupDriveStartUrl, disconnectBackupDrive, formatBytes,
  getBackupProgress, getBackupRuns, getBackupSnapshotWarnings, getBackupSnapshots, getBackupStatus, runBackup, saveBackupSettings,
  type BackupProgress, type BackupRun, type BackupSchedule, type BackupSnapshot, type BackupSnapshotWarning, type BackupStatus,
} from '../../utils/store';
import { BackupSetupGuide } from './BackupSetupGuide';

type Target = 'local' | 'drive';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong');
const when = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleString() : '—');

// This project compiles without strictNullChecks, where TypeScript will not
// narrow the *not-connected* half of a `connected: true | false` union on its
// own. A type predicate does narrow both halves, so the Drive card can read
// `email` and `configurable` off the right variant without a cast.
type DriveState = BackupStatus['drive'];
type DriveConnected = Extract<DriveState, { connected: true }>;
const isDriveConnected = (d: DriveState): d is DriveConnected => d.connected;

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45];
const pad2 = (n: number) => String(n).padStart(2, '0');
const PROGRESS_POLL_MS = 1000;
const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

const phaseText = (p: BackupProgress): string => {
  switch (p.phase) {
    case 'database': return 'Copying the database';
    case 'scanning': return p.target === 'drive' ? 'Checking what is already in Google Drive' : 'Checking what is already in the backup folder';
    case 'files': return p.filesTotal ? `Copying new and changed files — ${p.filesDone.toLocaleString()} of ${p.filesTotal.toLocaleString()}` : 'No new or changed files to copy';
    case 'snapshot': return 'Saving the database and snapshot record';
    case 'pruning': return 'Removing snapshots past the keep limit';
    default: return 'Working';
  }
};

/** One run in flight: what it is doing, and how far along. */
const RunProgress: React.FC<{ p: BackupProgress }> = ({ p }) => (
  <div className="space-y-2 rounded-lg border border-edge bg-sunken/50 p-3" data-testid={`backup-progress-${p.target}`}>
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-sm font-medium text-ink">
        <RefreshCw size={15} className="animate-spin text-accent-600" />
        {p.target === 'local' ? 'Backing up to the backup folder…' : 'Backing up to Google Drive…'}
      </span>
      <span className="text-sm font-semibold tabular-nums text-ink">{p.percent}%</span>
    </div>
    <ProgressBar
      done={p.percent}
      total={100}
      barClassName="breathing"
      label={p.bytesTotal > 0 ? `${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}` : ''}
    />
    <p className="text-xs text-ink-soft">{phaseText(p)}</p>
  </div>
);

/** A warning, said in terms of the file it is about and what to do next. The
 *  raw message stays underneath — it is what the server log says too. */
const WarningItem: React.FC<{ w: BackupSnapshotWarning }> = ({ w }) => {
  const what = w.fileName
    ? `${w.fileName}${w.projectName ? ` — ${w.projectName}` : ''}`
    : w.fileId ? 'A file that is no longer in the app' : 'Backup warning';
  const why = /skipped: not on disk/.test(w.message)
    ? "The app lists this file, but its contents are missing from the server's file storage, so there was nothing to back up. Try opening it in the app — if it won't open there either, upload it again."
    : /hash did not match/.test(w.message)
      ? 'The file on disk did not match what the app has on record — it may have been changing while the backup ran — so it was left out of this snapshot. The next backup tries it again.'
      : null;
  return (
    <li className="flex items-start gap-2">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium text-ink">{what}</div>
        {why && <div className="text-ink-soft">{why}</div>}
        <code className="block break-all font-mono text-xs text-ink-faint">{w.message}</code>
      </div>
    </li>
  );
};

/** The daily time and keep count for one target. */
const SchedulePanel: React.FC<{
  title: React.ReactNode; checkboxLabel: string; prefix: 'Local' | 'Drive';
  schedule: BackupSchedule; onSchedule: (s: BackupSchedule) => void;
  keepId: string; keepLabel: string; keepHint: string; keep: number; onKeep: (n: number) => void;
  note?: string;
}> = ({ title, checkboxLabel, prefix, schedule, onSchedule, keepId, keepLabel, keepHint, keep, onKeep, note }) => (
  <div className="space-y-3 rounded-lg border border-edge p-4">
    <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">{title}</h3>
    <div className="flex flex-wrap items-center gap-3">
      <Checkbox label={checkboxLabel} checked={schedule.enabled} onChange={e => onSchedule({ ...schedule, enabled: e.target.checked })} />
      <div className="flex items-center gap-2">
        <Select aria-label={`${prefix} hour`} className="w-auto" value={String(schedule.hour)} onChange={e => onSchedule({ ...schedule, hour: Number(e.target.value) })}>
          {HOURS.map(h => <option key={h} value={h}>{pad2(h)}</option>)}
        </Select>
        <span className="text-ink-soft">:</span>
        <Select aria-label={`${prefix} minute`} className="w-auto" value={String(schedule.minute)} onChange={e => onSchedule({ ...schedule, minute: Number(e.target.value) })}>
          {MINUTES.map(m => <option key={m} value={m}>{pad2(m)}</option>)}
        </Select>
      </div>
    </div>
    {note && <p className="text-xs text-ink-faint">{note}</p>}
    <Field label={keepLabel} htmlFor={keepId} hint={keepHint}>
      <NumberInput id={keepId} min={1} value={keep} onChange={e => onKeep(Number(e.target.value))} />
    </Field>
  </div>
);

/** One finished run, as it reads on the status card. A failure shows its error
 *  text verbatim — it is usually the whole diagnosis ("disk full"). */
const LastRunLine: React.FC<{ label: string; run: BackupRun | null }> = ({ label, run }) => (
  <div className="flex flex-wrap items-center gap-2 text-sm">
    <span className="w-24 shrink-0 text-ink-soft">{label}</span>
    {!run ? (
      <span className="text-ink-faint">Never run</span>
    ) : (
      <>
        <StatusPill tone={run.status === 'ok' ? 'green' : 'red'}>{run.status === 'ok' ? 'OK' : 'Failed'}</StatusPill>
        <span className="text-ink">{when(run.finishedAt ?? run.startedAt)}</span>
        {run.status === 'ok' && (
          <span className="text-ink-soft">
            {run.objectsAdded.toLocaleString()} new file{run.objectsAdded === 1 ? '' : 's'} · {formatBytes(run.bytesWritten)}
          </span>
        )}
        {run.error && <span className="text-red-600 dark:text-red-400">{run.error}</span>}
      </>
    )}
  </div>
);

export const BackupTab: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [runs, setRuns] = useState<BackupRun[] | null>(null);
  const [view, setView] = useState<Target>('local');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // Draft copies of the settings. They are adopted from the server on every
  // load until the user touches the form — a live reload landing mid-edit must
  // not silently undo what they just typed.
  const [schedule, setSchedule] = useState<BackupStatus['schedule']>({
    local: { enabled: false, hour: 2, minute: 0 }, drive: { enabled: false, hour: 2, minute: 0 },
  });
  const [keep, setKeep] = useState<BackupStatus['keep']>({ local: 14, drive: 14 });
  const formDirty = useRef(false);
  const [progress, setProgress] = useState<BackupProgress[]>([]);
  // Which snapshot's warnings are open, and what the server said about them.
  const [openWarnings, setOpenWarnings] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ id: string; items: BackupSnapshotWarning[] | null; error: string | null } | null>(null);

  // Read through a ref so `load` stays identity-stable: useLiveQuery only
  // re-runs its initial load when the *filter* changes, so a `load` that
  // changed with the toggle would never be called again anyway.
  const viewRef = useRef(view);
  viewRef.current = view;

  const load = useCallback(async () => {
    try {
      const [s, snaps] = await Promise.all([
        getBackupStatus(),
        // A snapshot list can fail on its own (Drive unreachable) without
        // taking the status card down with it.
        getBackupSnapshots(viewRef.current).catch(() => [] as BackupSnapshot[]),
      ]);
      setStatus(s);
      setProgress(s.progress ?? []);
      if (!formDirty.current) { setSchedule(s.schedule); setKeep(s.keep); }
      setSnapshots(snaps);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  // Initial load, plus a reload whenever the server finishes a run.
  useLiveQuery(load, { types: ['backupRun'] });

  // The local/Drive toggle changes only which list to show, so it refetches
  // the list alone. The first run is skipped: useLiveQuery just loaded both.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    setOpenWarnings(null);
    let cancelled = false;
    getBackupSnapshots(view)
      .then(s => { if (!cancelled) setSnapshots(s); })
      .catch(() => { if (!cancelled) setSnapshots([]); });
    return () => { cancelled = true; };
  }, [view]);

  // While a run is going its bar is polled once a second. The poll ends itself
  // once nothing is left in flight, and one more load then shows the result
  // (the backupRun event usually gets there first).
  const runningId = status?.running?.id ?? null;
  useEffect(() => {
    if (!runningId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const p = await getBackupProgress();
        if (cancelled) return;
        setProgress(p);
        if (p.length === 0) { void load(); return; }
      } catch { /* a missed poll is simply retried on the next one */ }
      if (!cancelled) timer = setTimeout(poll, PROGRESS_POLL_MS);
    };
    timer = setTimeout(poll, PROGRESS_POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runningId, load]);

  const toggleWarnings = async (id: string) => {
    if (openWarnings === id) { setOpenWarnings(null); return; }
    setOpenWarnings(id);
    setWarnings({ id, items: null, error: null });
    try {
      const items = await getBackupSnapshotWarnings(view, id);
      setWarnings(w => (w?.id === id ? { id, items, error: null } : w));
    } catch (e) {
      setWarnings(w => (w?.id === id ? { id, items: [], error: errText(e) } : w));
    }
  };

  // The Drive OAuth callback lands back here as /settings?tab=backup&drive=connected
  // (or &error=…). Read it off the URL and clear it so a reload is not a rerun
  // of the toast. window.location rather than useSearchParams: this tab is
  // mounted directly in its own tests, outside a Router.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('drive');
    const failed = params.get('error');
    if (!connected && !failed) return;
    if (failed) toast(failed, { type: 'error' });
    else if (connected === 'connected') toast('Google Drive connected.', { type: 'success' });
    params.delete('drive');
    params.delete('error');
    const q = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`);
  }, [toast]);

  const start = async (target: Target) => {
    setBusy(true);
    try {
      await runBackup(target);
      toast(target === 'local' ? 'Backup started.' : 'Drive backup started.', { type: 'success' });
      await load();
    } catch (e) {
      toast(e instanceof BackupRunningError ? 'A backup is already running' : errText(e), { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await saveBackupSettings({ schedule, keep });
      formDirty.current = false;
      toast('Backup schedule saved.', { type: 'success' });
      await load();
    } catch (e) {
      toast(errText(e), { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect Google Drive?',
      message: 'Backups stop copying off-site. Snapshots already in Drive are left alone.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await disconnectBackupDrive();
      toast('Google Drive disconnected.', { type: 'success' });
      await load();
    } catch (e) {
      toast(errText(e), { type: 'error' });
    }
  };

  // Refetched on every open rather than cached: the list is only interesting
  // right after a run, which is exactly when a cached copy would be stale.
  const openRuns = async (open: boolean) => {
    if (!open) return;
    try { setRuns(await getBackupRuns()); } catch { setRuns([]); }
  };

  if (error && !status) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button className="mt-4" variant="secondary" onClick={() => void load()}><RefreshCw size={15} /> Retry</Button>
        </CardBody>
      </Card>
    );
  }

  if (!status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const running = status.running;
  // Pulled out so the connected/not-connected union narrows once for the whole
  // Drive card (TS will not narrow a nested `status.drive.*` path across JSX).
  const drive = status.drive;
  // A run the status knows about but no progress has arrived for yet still
  // gets its panel, at 0%, rather than nothing.
  const inFlight: BackupProgress[] = progress.length ? progress : running ? [{
    runId: running.id, target: running.target, trigger: running.trigger, phase: 'database',
    percent: 0, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0,
  }] : [];
  const editSchedule = (t: 'local' | 'drive', v: BackupSchedule) => { formDirty.current = true; setSchedule(s => ({ ...s, [t]: v })); };
  const editKeep = (t: 'local' | 'drive', n: number) => { formDirty.current = true; setKeep(k => ({ ...k, [t]: n })); };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><DatabaseBackup size={18} className="text-accent-600" /> Backups</span>}
          actions={
            <button onClick={() => void load()} title="Refresh" className="rounded-lg p-2 text-ink-faint transition-colors hover:bg-hover hover:text-accent-600">
              <RefreshCw size={16} />
            </button>
          }
        />
        <CardBody className="space-y-4">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div>
            <p className="text-sm text-ink-soft">Every backup writes to</p>
            <code className="mt-1 block break-all font-mono text-sm text-ink">{status.root}</code>
            {status.rootIsDefault && (
              <p className="mt-2 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>Backups are on the same disk as the data. Set BACKUP_PATH to a different volume.</span>
              </p>
            )}
          </div>

          <div className="space-y-1.5 border-t border-edge pt-4">
            <LastRunLine label="Last local" run={status.lastRun.local} />
            <LastRunLine label="Last Drive" run={status.lastRun.drive} />
          </div>

          <div className="grid grid-cols-1 gap-3 border-t border-edge pt-4 sm:grid-cols-3">
            <div className="rounded-lg bg-sunken/50 p-3">
              <div className="text-xl font-semibold text-ink">{status.totals.snapshots.toLocaleString()}</div>
              <div className="mt-0.5 text-xs uppercase tracking-wider text-ink-soft">Snapshots</div>
            </div>
            <div className="rounded-lg bg-sunken/50 p-3">
              <div className="text-xl font-semibold text-ink">{status.totals.objects.toLocaleString()}</div>
              <div className="mt-0.5 text-xs uppercase tracking-wider text-ink-soft">Stored objects</div>
            </div>
            <div className="rounded-lg bg-sunken/50 p-3">
              <div className="text-xl font-semibold text-ink">{formatBytes(status.totals.bytes)}</div>
              <div className="mt-0.5 text-xs uppercase tracking-wider text-ink-soft">Latest snapshot</div>
            </div>
          </div>

          <div className="space-y-0.5 text-sm text-ink-soft">
            <p>Next local backup: <span className="text-ink">{status.nextRunAt.local ? when(status.nextRunAt.local) : 'Not scheduled'}</span></p>
            <p>Next Drive backup: <span className="text-ink">{status.nextRunAt.drive ? when(status.nextRunAt.drive) : 'Not scheduled'}</span></p>
          </div>

          {inFlight.map(p => <RunProgress key={p.runId} p={p} />)}

          <div className="flex flex-wrap gap-2 border-t border-edge pt-4">
            <Button disabled={busy || !!running} onClick={() => void start('local')}>
              <Play size={15} /> Back up now
            </Button>
            {isDriveConnected(drive) && (
              <Button variant="secondary" disabled={busy || !!running} onClick={() => void start('drive')}>
                <Cloud size={15} /> Back up to Drive now
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Cloud size={18} className="text-accent-600" /> Off-site copy</span>} />
        <CardBody className="space-y-3">
          {isDriveConnected(drive) ? (
            <>
              <p className="text-sm text-ink">Connected as {drive.email}</p>
              {drive.needsReconnect && (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  Google stopped accepting this connection.{' '}
                  <a href={backupDriveStartUrl()} className="font-medium underline">Reconnect</a>
                </p>
              )}
              <Button variant="secondary" onClick={() => void disconnect()}>Disconnect</Button>
            </>
          ) : drive.configurable ? (
            <>
              <p className="text-sm text-ink-soft">
                A copy in Google Drive survives the server itself — a failed disk, a lost machine, a bad restore.
              </p>
              <a
                href={backupDriveStartUrl()}
                className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-edge bg-raised px-4 text-sm font-medium text-ink transition-colors hover:bg-hover md:h-9 md:min-h-0"
              >
                <Cloud size={15} /> Connect Google Drive
              </a>
            </>
          ) : (
            <p className="text-sm text-ink-soft">
              Google Drive is not set up on this server yet. The setup guide below walks through it step by step.
            </p>
          )}
        </CardBody>
      </Card>

      <BackupSetupGuide setup={status.setup} root={status.root} rootIsDefault={status.rootIsDefault} />

      <Card>
        <CardHeader title="Schedule &amp; retention" />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SchedulePanel
              title={<><HardDrive size={15} className="text-accent-600" /> Backup folder</>}
              checkboxLabel="Back up locally every day at"
              prefix="Local"
              schedule={schedule.local}
              onSchedule={v => editSchedule('local', v)}
              keepId="backup-keep-local"
              keepLabel="Keep local snapshots"
              keepHint="Older local snapshots are pruned after each run."
              keep={keep.local}
              onKeep={n => editKeep('local', n)}
            />
            <SchedulePanel
              title={<><Cloud size={15} className="text-accent-600" /> Google Drive</>}
              checkboxLabel="Back up to Drive every day at"
              prefix="Drive"
              schedule={schedule.drive}
              onSchedule={v => editSchedule('drive', v)}
              keepId="backup-keep-drive"
              keepLabel="Keep Drive snapshots"
              keepHint="Older Drive snapshots are pruned after each Drive run."
              keep={keep.drive}
              onKeep={n => editKeep('drive', n)}
              note={isDriveConnected(drive) ? undefined : 'Runs once Google Drive is connected.'}
            />
          </div>

          <Button disabled={saving} onClick={() => void saveSettings()}>
            <Save size={15} /> Save schedule
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Snapshots"
          actions={
            <div className="inline-flex overflow-hidden rounded-lg border border-edge" role="group" aria-label="Snapshot source">
              {(['local', 'drive'] as Target[]).map(t => (
                <button
                  key={t}
                  onClick={() => setView(t)}
                  aria-pressed={view === t}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    view === t ? 'bg-accent-600 text-white' : 'bg-raised text-ink-soft hover:bg-hover'
                  }`}
                >
                  {t === 'local' ? <span className="flex items-center gap-1"><HardDrive size={13} /> Local</span>
                                 : <span className="flex items-center gap-1"><Cloud size={13} /> Drive</span>}
                </button>
              ))}
            </div>
          }
        />
        <CardBody className="p-0">
          {snapshots.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-faint">
              No {view === 'local' ? 'local' : 'Drive'} snapshots yet.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Version</TH>
                  <TH>Files</TH>
                  <TH>Size</TH>
                  <TH>Warnings</TH>
                  <TH><span className="sr-only">Download</span></TH>
                </TR>
              </THead>
              <TBody>
                {snapshots.map(s => (
                  <React.Fragment key={s.id}>
                    <TR>
                      <TD className="font-mono">{s.id}</TD>
                      <TD>{s.appVersion}</TD>
                      <TD>{s.counts.files.toLocaleString()}</TD>
                      <TD>{formatBytes(s.counts.bytes)}</TD>
                      <TD>
                        {s.warnings > 0 ? (
                          <button
                            type="button"
                            onClick={() => void toggleWarnings(s.id)}
                            aria-expanded={openWarnings === s.id}
                            title="Show what the warnings are"
                            className="inline-flex items-center gap-1 rounded-full"
                          >
                            <StatusPill tone="amber">
                              <span className="inline-flex items-center gap-1">
                                {plural(s.warnings, 'warning')}
                                <ChevronDown size={12} className={`transition-transform ${openWarnings === s.id ? 'rotate-180' : ''}`} />
                              </span>
                            </StatusPill>
                          </button>
                        ) : <span className="text-ink-faint">0</span>}
                      </TD>
                      <TD>
                        {view === 'local' && (
                          <a href={backupDownloadUrl(s.id)} download className="inline-flex items-center gap-1 text-sm font-medium text-accent-600 hover:underline">
                            <Download size={14} /> Download zip
                          </a>
                        )}
                      </TD>
                    </TR>
                    {openWarnings === s.id && (
                      <TR>
                        <TD colSpan={6} className="bg-sunken/40">
                          {!warnings?.items ? (
                            <p className="text-sm text-ink-faint">Loading…</p>
                          ) : warnings.error ? (
                            <p className="text-sm text-red-600 dark:text-red-400">{warnings.error}</p>
                          ) : warnings.items.length === 0 ? (
                            <p className="text-sm text-ink-faint">This snapshot recorded no warning text.</p>
                          ) : (
                            <ul className="space-y-3 text-sm">
                              {warnings.items.map((w, i) => <WarningItem key={i} w={w} />)}
                            </ul>
                          )}
                        </TD>
                      </TR>
                    )}
                  </React.Fragment>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <details className="rounded-xl border border-edge bg-raised" onToggle={e => void openRuns((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink">Run history</summary>
        <div className="border-t border-edge px-5 py-4">
          {runs === null ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-ink-faint">No runs recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {runs.map(r => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusPill tone={r.status === 'ok' ? 'green' : r.status === 'running' ? 'blue' : 'red'}>{r.status}</StatusPill>
                  <span className="text-ink">{when(r.startedAt)}</span>
                  <span className="text-ink-soft">{r.target} · {r.trigger}</span>
                  {r.status === 'ok' && <span className="text-ink-soft">{formatBytes(r.bytesWritten)}</span>}
                  {r.warnings.length > 0 && (
                    <span className="text-amber-700 dark:text-amber-300">
                      {plural(r.warnings.length, 'warning')}: {r.warnings.slice(0, 3).join('; ')}{r.warnings.length > 3 ? ` and ${r.warnings.length - 3} more` : ''}
                    </span>
                  )}
                  {r.error && <span className="text-red-600 dark:text-red-400">{r.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <p className="text-xs text-ink-faint">
        Restore is only offered on a fresh install — see the login page of an empty server.
      </p>
    </div>
  );
};
