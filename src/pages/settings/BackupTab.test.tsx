// src/pages/settings/BackupTab.test.tsx
//
// Settings → Backup is the only place an admin sees whether the nightly backup
// actually ran, so the tests cover the states that matter when it did not: the
// same-disk warning (a backup on the data volume is no backup), a failed last
// run with its error, a run already in progress and how far it has got, the
// separate local/Drive schedule form round-trip, the setup guide, and what a
// snapshot's warnings actually say.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ToastProvider } from '../../components/Toast';
import { ConfirmProvider } from '../../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  getBackupStatus: vi.fn(), runBackup: vi.fn(async () => ({ runId: 'r' })), getBackupRuns: vi.fn(async () => []),
  getBackupSnapshots: vi.fn(async () => []), saveBackupSettings: vi.fn(async () => {}), disconnectBackupDrive: vi.fn(async () => {}),
  getBackupProgress: vi.fn(async () => []), getBackupSnapshotWarnings: vi.fn(async () => []),
}));
vi.mock('../../utils/store', async (orig) => ({ ...(await orig<typeof import('../../utils/store')>()), ...h }));
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }) }));
import { BackupTab } from './BackupTab';

const off = { enabled: false, hour: 2, minute: 0 };
const status = (over: Partial<any> = {}) => ({
  root: '/mnt/user/backups', rootIsDefault: false, lastRun: { local: null, drive: null }, running: null,
  totals: { snapshots: 0, objects: 0, bytes: 0 }, nextRunAt: { local: null, drive: null }, schedule: { local: off, drive: off }, keep: { local: 14, drive: 14 },
  progress: [], drive: { connected: false, configurable: true },
  setup: { publicUrl: null, googleClientId: false, googleClientSecret: false, redirectUris: null }, ...over,
});
const runningRow = { id: 'r', target: 'local', trigger: 'manual', startedAt: 1, finishedAt: null, status: 'running', snapshotId: null, objectsAdded: 0, bytesWritten: 0, warnings: [], error: null };
const mount = () => render(<ToastProvider><ConfirmProvider><BackupTab /></ConfirmProvider></ToastProvider>);
beforeEach(() => { vi.clearAllMocks(); h.getBackupStatus.mockResolvedValue(status()); });

describe('BackupTab', () => {
  it('shows the root, the same-disk warning only when default, and Connect Google Drive when configurable', async () => {
    mount();
    // On the status card (the setup guide's env list repeats it).
    expect((await screen.findAllByText('/mnt/user/backups')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/same disk as the data/i)).toBeNull();
    expect(screen.getByRole('link', { name: /connect google drive/i })).toBeInTheDocument();
    h.getBackupStatus.mockResolvedValue(status({ rootIsDefault: true, drive: { connected: true, email: 'me@x.com', needsReconnect: false } }));
    mount();
    expect(await screen.findByText(/same disk as the data/i)).toBeInTheDocument();
    expect(screen.getByText(/connected as me@x.com/i)).toBeInTheDocument();
  });

  it('Back up now calls runBackup(local) and is disabled while a run is in progress', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^back up now$/i }));
    await waitFor(() => expect(h.runBackup).toHaveBeenCalledWith('local'));
    h.getBackupStatus.mockResolvedValue(status({ running: runningRow }));
    mount();
    await screen.findByText(/backing up/i);
    expect(screen.getAllByRole('button', { name: /^back up now$/i }).at(-1)).toBeDisabled();
  });

  it('a run in progress shows a bar with its percentage, follows the polled progress, and reloads when it finishes', async () => {
    const at = (over: object) => ({ runId: 'r', target: 'drive', trigger: 'manual', phase: 'files', percent: 42, filesDone: 3, filesTotal: 10, bytesDone: 42 * 1024 * 1024, bytesTotal: 100 * 1024 * 1024, ...over });
    h.getBackupStatus.mockResolvedValue(status({ running: { ...runningRow, target: 'drive' }, progress: [at({})] }));
    h.getBackupProgress.mockResolvedValueOnce([at({ percent: 77, filesDone: 8 })]).mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/backing up to google drive/i)).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText(/3 of 10/)).toBeInTheDocument();
    expect(await screen.findByText('77%', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/8 of 10/)).toBeInTheDocument();
    // Nothing left in flight: the tab loads the finished state.
    h.getBackupStatus.mockResolvedValue(status());
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull(), { timeout: 3000 });
  });

  it('shows the last error and lists snapshots with a download link', async () => {
    h.getBackupStatus.mockResolvedValue(status({ lastRun: { local: { id: 'r', target: 'local', trigger: 'schedule', startedAt: 1, finishedAt: 2, status: 'error', snapshotId: null, objectsAdded: 0, bytesWritten: 0, warnings: [], error: 'disk full' }, drive: null } }));
    h.getBackupSnapshots.mockResolvedValue([{ id: '20260912-020000', createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, counts: { files: 12, bytes: 5000 }, warnings: 0 }]);
    mount();
    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(await screen.findByText('20260912-020000')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download zip/i })).toHaveAttribute('href', expect.stringContaining('/api/backup/snapshots/20260912-020000/download'));
  });

  it('saves separate local and Drive schedules and keep counts', async () => {
    h.getBackupStatus.mockResolvedValue(status({ nextRunAt: { local: new Date(2026, 8, 25, 2, 0).getTime(), drive: null } }));
    mount();
    expect(await screen.findByText(/next local backup/i)).toBeInTheDocument();
    expect(screen.getByText(/next drive backup/i).textContent).toMatch(/not scheduled/i);
    fireEvent.click(screen.getByLabelText(/back up locally every day/i));
    fireEvent.change(screen.getByLabelText(/keep local/i), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText(/back up to drive every day/i));
    fireEvent.change(screen.getByLabelText('Drive hour'), { target: { value: '23' } });
    fireEvent.change(screen.getByLabelText('Drive minute'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: /save schedule/i }));
    await waitFor(() => expect(h.saveBackupSettings).toHaveBeenCalledWith({
      schedule: { local: { enabled: true, hour: 2, minute: 0 }, drive: { enabled: true, hour: 23, minute: 45 } },
      keep: { local: 30, drive: 14 },
    }));
  });

  it('says the Drive schedule waits for a connection', async () => {
    h.getBackupStatus.mockResolvedValue(status({ drive: { connected: false, configurable: false } }));
    mount();
    expect(await screen.findByText(/runs once google drive is connected/i)).toBeInTheDocument();
    h.getBackupStatus.mockResolvedValue(status({ drive: { connected: true, email: 'me@x.com', needsReconnect: false } }));
    mount();
    await screen.findAllByText(/connected as me@x.com/i);
    expect(screen.getAllByText(/runs once google drive is connected/i)).toHaveLength(1); // only the first mount's
  });

  it('the setup guide is collapsed, and shows this server\'s own redirect URIs and settings', async () => {
    h.getBackupStatus.mockResolvedValue(status({
      rootIsDefault: true,
      setup: {
        publicUrl: 'https://takeoff.example.com', googleClientId: true, googleClientSecret: false,
        redirectUris: { backup: 'https://takeoff.example.com/api/backup/drive/callback', restore: 'https://takeoff.example.com/api/setup/restore/drive/callback' },
      },
    }));
    mount();
    const guide = await screen.findByTestId('backup-setup-guide');
    expect(guide).not.toHaveAttribute('open');
    expect(guide.textContent).toMatch(/setup guide/i);
    expect(screen.getByText('https://takeoff.example.com/api/backup/drive/callback')).toBeInTheDocument();
    expect(screen.getByText('https://takeoff.example.com/api/setup/restore/drive/callback')).toBeInTheDocument();
    expect(guide.textContent).toMatch(/Publish app/);
    expect(within(screen.getByTestId('env-GOOGLE_OAUTH_CLIENT_ID')).getByText('set')).toBeInTheDocument();
    expect(within(screen.getByTestId('env-GOOGLE_OAUTH_CLIENT_SECRET')).getByText('not set')).toBeInTheDocument();
    expect(within(screen.getByTestId('env-BACKUP_PATH')).getByText('not set')).toBeInTheDocument();
  });

  it('the setup guide warns when APP_PUBLIC_URL is an address Google will refuse', async () => {
    h.getBackupStatus.mockResolvedValue(status({
      setup: { publicUrl: 'http://192.168.1.20:3000', googleClientId: true, googleClientSecret: true, redirectUris: { backup: 'http://192.168.1.20:3000/api/backup/drive/callback', restore: 'http://192.168.1.20:3000/api/setup/restore/drive/callback' } },
    }));
    mount();
    expect(await screen.findByText(/will not accept a redirect URI that is not https/i)).toBeInTheDocument();
  });

  it("a snapshot's warnings open to say which file and why, fetched from the snapshot shown", async () => {
    h.getBackupSnapshots.mockResolvedValue([{ id: '20260924-020000', createdAt: 1, appVersion: '3.3.0', schemaVersion: 36, counts: { files: 12, bytes: 5000 }, warnings: 1 }]);
    h.getBackupSnapshotWarnings.mockResolvedValue([{ message: 'file f-gone skipped: not on disk', fileId: 'f-gone', fileName: 'plans.pdf', projectName: 'Main St Remodel' }]);
    mount();
    const toggle = await screen.findByRole('button', { name: /1 warning/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(await screen.findByText('plans.pdf — Main St Remodel')).toBeInTheDocument();
    expect(screen.getByText(/contents are missing from the server's file storage/i)).toBeInTheDocument();
    expect(screen.getByText('file f-gone skipped: not on disk')).toBeInTheDocument();
    expect(h.getBackupSnapshotWarnings).toHaveBeenCalledWith('local', '20260924-020000');
    fireEvent.click(screen.getByRole('button', { name: /1 warning/i }));
    expect(screen.queryByText('plans.pdf — Main St Remodel')).toBeNull();
  });

  // Regression: the local/Drive toggle changes only which list is fetched, and
  // useLiveQuery re-runs its loader on socket events and filter changes alone —
  // so the toggle has to refetch on its own or the Drive tab shows local rows.
  it('the Drive toggle refetches the snapshot list from Drive', async () => {
    mount();
    await waitFor(() => expect(h.getBackupSnapshots).toHaveBeenCalledWith('local'));
    fireEvent.click(screen.getByRole('button', { name: /drive/i }));
    await waitFor(() => expect(h.getBackupSnapshots).toHaveBeenCalledWith('drive'));
  });
});
