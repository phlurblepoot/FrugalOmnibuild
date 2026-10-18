// src/pages/RestorePage.tsx — the fresh-install restore screen (/restore).
//
// This is the one screen that runs on an empty server, before there is any
// data to protect: a new container, a replaced disk, a move to another
// machine. It answers one question — which backup do we put back — and then
// it waits for the server to come back up, because the restore ends with the
// process exiting so the container restarts onto the restored database.
//
// It refuses to do anything once the server has data. The server enforces that
// too (every setup route 409s when the install is not fresh); the check here
// is so the screen says why instead of failing at the last click.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, Cloud, DatabaseBackup, HardDrive, Loader2, Lock, RefreshCw, Upload, User,
} from 'lucide-react';
import {
  Button, Card, CardBody, CardHeader, Field, Input, ProgressBar, Skeleton,
  StatusPill, Table, TBody, TD, TH, THead, TR,
} from '../components/ui';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  endMediaSession, formatBytes, getRestoreDriveSnapshots, getRestoreSources, getSetupStateStrict, restoreDriveStartUrl,
  RestoreRunningError, restoreSnapshot, uploadRestoreZip, type BackupSnapshot,
} from '../utils/store';

// The bootstrap admin a fresh install ships with. Only that account may
// restore (server/backup/restore.ts DEFAULT_ADMIN_ID), so the screen asks for
// those credentials itself rather than bouncing through the login page.
const SETUP_ADMIN_ID = 'admin-id-123';
const POLL_MS = 2000;
// The container has to stop, restart and open the restored database. Five
// minutes is generous for that and still short enough that a server which is
// never coming back stops pretending it might.
const GIVE_UP_MS = 5 * 60 * 1000;
const BACK_TO_LOGIN_MS = 1500;

type Phase = 'loading' | 'unreachable' | 'not-fresh' | 'pick' | 'restoring' | 'restarting' | 'done' | 'gone';
type Source = 'local' | 'upload' | 'drive';

type Sources = Awaited<ReturnType<typeof getRestoreSources>>;
interface Picked { source: Source; snapshot: BackupSnapshot; uploadId?: string }

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong');
const when = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleString() : '—');
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const isSetupAdmin = (): boolean => {
  if (!localStorage.getItem('token')) return false;
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')?.id === SETUP_ADMIN_ID;
  } catch {
    return false;
  }
};

const SOURCE_TABS: { key: Source; label: string; icon: React.ReactNode }[] = [
  { key: 'local', label: 'Backup folder', icon: <HardDrive size={15} /> },
  { key: 'upload', label: 'Upload a snapshot zip', icon: <Upload size={15} /> },
  { key: 'drive', label: 'Google Drive', icon: <Cloud size={15} /> },
];

/** The snapshot list, shared by the backup folder and Google Drive tabs. */
const SnapshotTable: React.FC<{
  snapshots: BackupSnapshot[];
  pickedId: string | null;
  onPick: (s: BackupSnapshot) => void;
  empty: string;
}> = ({ snapshots, pickedId, onPick, empty }) =>
  snapshots.length === 0 ? (
    <p className="px-5 py-6 text-sm text-ink-faint">{empty}</p>
  ) : (
    <Table>
      <THead>
        <TR>
          <TH>Taken</TH>
          <TH>Version</TH>
          <TH>Files</TH>
          <TH>Size</TH>
          <TH>Warnings</TH>
          <TH><span className="sr-only">Choose</span></TH>
        </TR>
      </THead>
      <TBody>
        {snapshots.map(s => (
          <TR key={s.id} className={pickedId === s.id ? 'bg-hover' : ''}>
            <TD>
              <div className="text-ink">{when(s.createdAt)}</div>
              <div className="font-mono text-xs text-ink-faint">{s.id}</div>
            </TD>
            <TD>{s.appVersion}</TD>
            <TD className="tabular-nums">{s.counts.files.toLocaleString()}</TD>
            <TD className="tabular-nums">{formatBytes(s.counts.bytes)}</TD>
            <TD>{s.warnings > 0 ? <StatusPill tone="amber">{s.warnings}</StatusPill> : <span className="text-ink-faint">0</span>}</TD>
            <TD>
              <Button
                size="sm"
                variant={pickedId === s.id ? 'primary' : 'secondary'}
                data-testid={`restore-snapshot-${s.id}`}
                onClick={() => onPick(s)}
              >
                {pickedId === s.id ? 'Chosen' : 'Choose'}
              </Button>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );

export const RestorePage: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();

  const [phase, setPhase] = useState<Phase>('loading');
  const [authed, setAuthed] = useState(isSetupAdmin);
  const [sources, setSources] = useState<Sources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('local');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [result, setResult] = useState<{ files: number; bytes: number } | null>(null);

  // Upload tab
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);

  // Drive tab. `driveConnected` can be true before `sources` says so: the
  // OAuth callback redirects back here as /restore?drive=connected, and the
  // grant it just stored is what the snapshot list will use.
  const [driveConnected, setDriveConnected] = useState(false);
  const [driveSnapshots, setDriveSnapshots] = useState<BackupSnapshot[] | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const s = await getRestoreSources();
      setSources(s);
      if (s.drive.connected) setDriveConnected(true);
      setError(null);
      setPhase('pick');
    } catch (e) {
      setError(errText(e));
      setPhase('pick');
    }
  }, []);

  // Fresh install? That gate comes first — everything else on this screen is
  // pointless (and refused by the server) once there is data to lose. It reads
  // strictly, so a server that is down or throwing 500s says exactly that and
  // offers a retry, instead of being mistaken for a server that has data.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const checkFresh = useCallback(async () => {
    setPhase('loading');
    let state: { fresh: boolean };
    try {
      state = await getSetupStateStrict();
    } catch {
      if (alive.current) setPhase('unreachable');
      return;
    }
    if (!alive.current) return;
    if (!state.fresh) { setPhase('not-fresh'); return; }
    // Re-derive from localStorage every time this runs, not just at mount:
    // a remount (PageTransition used to mount an entering page twice; see
    // PageTransition.tsx) would otherwise land a fresh instance back on
    // `authed`'s stale initial value. Syncing here means a remount lands
    // directly in the authed `pick` phase whenever a valid session already
    // exists, instead of an empty sign-in form.
    const admin = isSetupAdmin();
    setAuthed(admin);
    if (!admin) { setPhase('pick'); return; }
    await loadSources();
  }, [loadSources]);

  useEffect(() => { void checkFresh(); }, [checkFresh]);

  // Read the Drive callback's result off the URL once, then forget it so a
  // reload is not a rerun of the toast.
  const readCallback = useRef(false);
  useEffect(() => {
    if (readCallback.current) return;
    readCallback.current = true;
    const params = new URLSearchParams(location.search);
    const failed = params.get('error');
    if (failed) { setSource('drive'); toast(failed, { type: 'error' }); }
    else if (params.get('drive') === 'connected') { setSource('drive'); setDriveConnected(true); toast('Google Drive connected.', { type: 'success' }); }
  }, [location.search, toast]);

  // Drive snapshots are fetched when that tab is actually opened: the list is
  // a round trip to Google, and most restores come off the backup folder.
  useEffect(() => {
    if (source !== 'drive' || !driveConnected || driveSnapshots !== null) return;
    let cancelled = false;
    getRestoreDriveSnapshots()
      .then(s => { if (!cancelled) { setDriveSnapshots(s); setDriveError(null); } })
      .catch(e => { if (!cancelled) { setDriveSnapshots([]); setDriveError(errText(e)); } });
    return () => { cancelled = true; };
  }, [source, driveConnected, driveSnapshots]);

  // While the server is restarting onto the restored database it is simply
  // gone: a refused connection is the expected answer, not a failure. Only an
  // answer of "this install is no longer fresh" means the restore landed —
  // which is why this polls getSetupStateStrict and not getSetupState, whose
  // swallowed errors would read as a finished restore two seconds in.
  useEffect(() => {
    if (phase !== 'restarting') return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      void (async () => {
        if (cancelled) return;
        if (Date.now() - startedAt > GIVE_UP_MS) { clearInterval(timer); setPhase('gone'); return; }
        try {
          const state = await getSetupStateStrict();
          // `fresh: true` means the server answered before it swapped the
          // database in — not done yet, so keep waiting.
          if (cancelled || state.fresh) return;
          clearInterval(timer);
          // These were the fresh-install admin's, and that account no longer
          // exists on the restored database.
          endMediaSession();
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          setPhase('done');
        } catch {
          // Still down — keep polling.
        }
      })();
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(() => navigate('/login'), BACK_TO_LOGIN_MS);
    return () => clearTimeout(t);
  }, [phase, navigate]);

  const pickSnapshot = (s: BackupSnapshot, src: Source, uploadId?: string) =>
    setPicked(uploadId ? { source: src, snapshot: s, uploadId } : { source: src, snapshot: s });

  // The file input has accept=".zip", but a drop bypasses that entirely — and
  // uploading a photo to the restore endpoint just wastes the upload.
  const takeDroppedFile = (file: File | null | undefined) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { toast('Please drop a snapshot .zip', { type: 'error' }); return; }
    void takeFile(file);
  };

  const takeFile = async (file: File | null | undefined) => {
    if (!file) return;
    setUploading(true);
    setUploadPct(0);
    setPicked(null);
    try {
      const r = await uploadRestoreZip(file, setUploadPct);
      pickSnapshot(r.summary, 'upload', r.uploadId);
    } catch (e) {
      toast(errText(e), { type: 'error' });
    } finally {
      setUploading(false);
    }
  };

  const startRestore = async () => {
    if (!picked) return;
    const ok = await confirm({
      title: 'Restore from backup?',
      message: 'This replaces the empty database on this server. The server restarts when done.',
      confirmLabel: 'Restore',
      tone: 'danger',
    });
    if (!ok) return;
    setPhase('restoring');
    try {
      const r = await restoreSnapshot(
        picked.uploadId
          ? { source: picked.source, snapshotId: picked.snapshot.id, uploadId: picked.uploadId }
          : { source: picked.source, snapshotId: picked.snapshot.id }
      );
      setResult({ files: r.files, bytes: r.bytes });
      setPhase('restarting');
    } catch (e) {
      // The server already has a restore under way — a double click, or a
      // reload onto one that is still copying. Nothing has failed, so stay on
      // the progress screen rather than dropping back to the picker.
      if (e instanceof RestoreRunningError) return;
      toast(errText(e), { type: 'error' });
      setPhase('pick');
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-600 text-white shadow-lg shadow-accent-600/25">
          <DatabaseBackup size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-ink">Restore from backup</h1>
          <p className="text-sm text-ink-soft">Put an existing backup onto this empty server.</p>
        </div>
      </div>
      {children}
    </div>
  );

  if (phase === 'loading') {
    return shell(<div className="space-y-4"><Skeleton className="h-24 w-full rounded-xl" /><Skeleton className="h-48 w-full rounded-xl" /></div>);
  }

  if (phase === 'unreachable') {
    return shell(
      <Card>
        <CardBody className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-ink">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <span>Can't reach the server. Is it running?</span>
          </p>
          <p className="text-sm text-ink-soft">
            Nothing has been changed. Once the server answers, this screen will say whether it is empty enough to
            restore into.
          </p>
          <Button variant="secondary" onClick={() => void checkFresh()}><RefreshCw size={15} /> Try again</Button>
        </CardBody>
      </Card>
    );
  }

  if (phase === 'not-fresh') {
    return shell(
      <Card>
        <CardBody className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-ink">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <span>This server already has data — restore is only offered on a fresh install.</span>
          </p>
          <p className="text-sm text-ink-soft">
            Restoring over a server in use would throw that work away. To restore this backup anyway, start a new,
            empty container and run the restore there.
          </p>
          <Link to="/login" className="text-sm font-medium text-accent-600 hover:underline">Back to sign in</Link>
        </CardBody>
      </Card>
    );
  }

  if (phase === 'restoring' || phase === 'restarting' || phase === 'done' || phase === 'gone') {
    return shell(
      <Card>
        <CardBody>
          <div data-testid="restore-progress" className="space-y-3">
            {phase === 'restoring' && (
              <p className="flex items-center gap-2 text-base font-medium text-ink">
                <Loader2 size={18} className="animate-spin text-accent-600" /> Unpacking the snapshot…
              </p>
            )}
            {phase === 'restarting' && (
              <>
                <p className="flex items-center gap-2 text-base font-medium text-ink">
                  <Loader2 size={18} className="animate-spin text-accent-600" /> Restarting the server…
                </p>
                <p className="text-sm text-ink-soft">
                  The backup is in place. This page waits for the server to come back — it usually takes under a minute.
                </p>
              </>
            )}
            {phase === 'done' && (
              <p className="flex items-center gap-2 text-base font-medium text-ink">
                <CheckCircle2 size={18} className="text-green-600" /> Restored. Sign in with your usual account.
              </p>
            )}
            {phase === 'gone' && (
              <p className="flex items-start gap-2 text-base font-medium text-ink">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
                The server has not come back. Start the container again, then sign in.
              </p>
            )}
            {result && (
              <p className="text-sm text-ink-soft">
                {plural(result.files, 'file')} · {formatBytes(result.bytes)} put back.
              </p>
            )}
          </div>
        </CardBody>
      </Card>
    );
  }

  // phase === 'pick'
  if (!authed) return shell(<SetupLogin onSignedIn={() => { setAuthed(true); void loadSources(); }} />);

  const drive = sources?.drive;

  return shell(
    <div className="space-y-6">
      {error && (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            <Button variant="secondary" onClick={() => void loadSources()}><RefreshCw size={15} /> Retry</Button>
          </CardBody>
        </Card>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Where the backup is">
        {SOURCE_TABS.map(t => (
          <button
            key={t.key}
            data-testid={`restore-source-${t.key}`}
            aria-pressed={source === t.key}
            onClick={() => setSource(t.key)}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors ${
              source === t.key
                ? 'border-accent-600 bg-accent-600 text-white'
                : 'border-edge bg-raised text-ink-soft hover:bg-hover hover:text-ink'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {source === 'local' && (
        <Card>
          <CardHeader title="Snapshots in the backup folder" />
          <CardBody className="p-0">
            {sources && (
              <p className="px-5 pt-4 text-xs text-ink-faint">
                Reading <code className="font-mono">{sources.root}</code>
              </p>
            )}
            <SnapshotTable
              snapshots={sources?.local ?? []}
              pickedId={picked?.source === 'local' ? picked.snapshot.id : null}
              onPick={s => pickSnapshot(s, 'local')}
              empty="No snapshots in the backup folder. Upload a snapshot zip instead, or point BACKUP_PATH at the volume that holds them."
            />
          </CardBody>
        </Card>
      )}

      {source === 'upload' && (
        <Card>
          <CardHeader title="Upload a snapshot zip" />
          <CardBody className="space-y-4">
            <label
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); takeDroppedFile(e.dataTransfer?.files?.[0]); }}
              className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-edge-strong bg-sunken/40 px-6 py-10 text-center transition-colors hover:bg-hover"
            >
              <Upload size={22} className="text-ink-faint" />
              <span className="text-sm font-medium text-ink">Drop a snapshot zip here, or choose a file</span>
              <span className="text-xs text-ink-faint">The zip a backup was downloaded as, from Settings → Backup.</span>
              <input
                type="file"
                accept=".zip"
                data-testid="restore-upload-input"
                className="sr-only"
                onChange={e => void takeFile(e.target.files?.[0])}
              />
            </label>
            {uploading && (
              <div data-testid="restore-progress" className="space-y-1">
                <p className="text-sm text-ink-soft">Uploading…</p>
                <ProgressBar done={uploadPct} total={100} label={`${uploadPct}%`} />
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {source === 'drive' && (
        <Card>
          <CardHeader title="Snapshots in Google Drive" />
          <CardBody className="space-y-3 p-0">
            {!drive?.configurable && !driveConnected ? (
              <p className="px-5 py-6 text-sm text-ink-soft">
                Google Drive is not set up on this server. Set GOOGLE_OAUTH_CLIENT_ID / SECRET and APP_PUBLIC_URL to
                restore from Drive, or use the backup folder or a snapshot zip.
              </p>
            ) : !driveConnected ? (
              <div className="space-y-3 px-5 py-6">
                <p className="text-sm text-ink-soft">
                  Sign in to the Google account the backups were copied to. The grant lasts only until this restore is done.
                </p>
                <a
                  href={restoreDriveStartUrl()}
                  className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-edge bg-raised px-4 text-sm font-medium text-ink transition-colors hover:bg-hover md:h-9 md:min-h-0"
                >
                  <Cloud size={15} /> Connect Google Drive
                </a>
              </div>
            ) : driveSnapshots === null ? (
              <p className="px-5 py-6 text-sm text-ink-faint">Loading snapshots from Google Drive…</p>
            ) : (
              <>
                {driveError && <p className="px-5 pt-4 text-sm text-red-600 dark:text-red-400">{driveError}</p>}
                <SnapshotTable
                  snapshots={driveSnapshots}
                  pickedId={picked?.source === 'drive' ? picked.snapshot.id : null}
                  onPick={s => pickSnapshot(s, 'drive')}
                  empty="No snapshots in that Drive account."
                />
              </>
            )}
          </CardBody>
        </Card>
      )}

      {picked && (
        <Card>
          <CardHeader title="Ready to restore" />
          <CardBody className="space-y-3">
            <p className="text-sm text-ink">
              {plural(picked.snapshot.counts.files, 'file')} · {formatBytes(picked.snapshot.counts.bytes)} · v{picked.snapshot.appVersion}
            </p>
            <p className="text-sm text-ink-soft">
              Taken {when(picked.snapshot.createdAt)} · <span className="font-mono">{picked.snapshot.id}</span>
            </p>
            {picked.snapshot.warnings > 0 && (
              <p className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle size={16} /> {plural(picked.snapshot.warnings, 'warning')} when this backup was taken — some files may be missing.
              </p>
            )}
            <Button data-testid="restore-confirm" variant="danger" onClick={() => void startRestore()}>
              Restore this snapshot
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
};

/** Sign-in for the bootstrap admin. A fresh install has exactly one account
 *  (admin / admin) and the restore routes accept no other, so asking here
 *  keeps the whole restore on one screen. */
const SetupLogin: React.FC<{ onSignedIn: () => void }> = ({ onSignedIn }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      // Checked before anything is stored: a session that cannot restore has
      // no business being left behind on this screen.
      if (data.user?.id !== SETUP_ADMIN_ID) throw new Error('Only the initial admin account can restore');
      // This is the throwaway fresh-install admin, not a real session — no
      // need to sync theme/mail/collab prefs from the server or open a
      // realtime socket for it, so unlike the real Login screen this does
      // not dispatch 'app:prefs-sync'. Storing token/user and flipping local
      // state is all this screen itself needs.
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      onSignedIn();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Sign in to restore" />
      <CardBody>
        <p className="mb-4 text-sm text-ink-soft">
          A new server starts with one account: <span className="font-mono">admin</span> / <span className="font-mono">admin</span>.
          Only that account can restore a backup.
        </p>
        {error && <p className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-600 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">{error}</p>}
        <form onSubmit={submit} className="space-y-4">
          <Field label="Username" htmlFor="restore-username">
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-ink-faint"><User size={16} /></span>
              <Input id="restore-username" className="pl-9" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
            </div>
          </Field>
          <Field label="Password" htmlFor="restore-password">
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-ink-faint"><Lock size={16} /></span>
              <Input id="restore-password" className="pl-9" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
          </Field>
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : 'Sign in'}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
};
