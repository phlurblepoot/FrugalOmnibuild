import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  getSetupState: vi.fn(async () => ({ fresh: true })),
  // The restart poll uses the strict read, which throws while the server is
  // down instead of reporting a swallowed error as "not fresh".
  getSetupStateStrict: vi.fn(async () => ({ fresh: true })),
  getRestoreSources: vi.fn(async () => ({ root: '/bk', local: [{ id: '20260912-020000', createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, counts: { files: 3, bytes: 900 }, warnings: 0 }], drive: { configurable: false, connected: false, email: null } })),
  uploadRestoreZip: vi.fn(), getRestoreDriveSnapshots: vi.fn(async () => []), restoreSnapshot: vi.fn(async () => ({ restarting: true, files: 3, bytes: 900 })),
}));
vi.mock('../utils/store', async (orig) => ({ ...(await orig<typeof import('../utils/store')>()), ...h }));
import { RestorePage } from './RestorePage';

const mount = () => render(<MemoryRouter><ToastProvider><ConfirmProvider><RestorePage /></ConfirmProvider></ToastProvider></MemoryRouter>);
// clearAllMocks only clears recorded calls. mockReset also drops the
// implementation and any *unconsumed* once-answers, which a test that fails
// early would otherwise leave queued for the next one — so the two setup reads
// are reset and re-armed with their "fresh install" defaults here.
beforeEach(() => {
  vi.clearAllMocks();
  h.getSetupState.mockReset().mockResolvedValue({ fresh: true });
  h.getSetupStateStrict.mockReset().mockResolvedValue({ fresh: true });
  localStorage.setItem('token', 't');
  localStorage.setItem('user', JSON.stringify({ id: 'admin-id-123', username: 'admin', role: 'admin' }));
});

// A test that fails before its own useRealTimers() would otherwise leave fake
// timers armed for the next one, turning one failure into several.
afterEach(() => { vi.useRealTimers(); });

/** Pick the one local snapshot and confirm, leaving the page in `restarting`. */
const pickAndConfirm = async () => {
  fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
  fireEvent.click(screen.getByTestId('restore-confirm'));
  fireEvent.click(await screen.findByRole('button', { name: /^restore$/i })); // confirm dialog
  await waitFor(() => expect(h.restoreSnapshot).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restarting/i));
};

describe('RestorePage', () => {
  it('lists local snapshots, shows a summary on pick, and after confirm polls until the server is back then routes to login', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupStateStrict
      .mockResolvedValueOnce({ fresh: true })            // the mount gate
      .mockRejectedValueOnce(new Error('down'))          // poll: still down
      .mockRejectedValueOnce(new Error('down'))          // poll: still down
      .mockResolvedValueOnce({ fresh: false });          // poll: back, restored
    mount();
    fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
    expect(screen.getByText(/3 files/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restore-confirm'));
    fireEvent.click(await screen.findByRole('button', { name: /^restore$/i })); // confirm dialog
    await waitFor(() => expect(h.restoreSnapshot).toHaveBeenCalledWith({ source: 'local', snapshotId: '20260912-020000' }));
    // restore-progress carries every progress phase, so wait for this one's text.
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restarting/i));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restored/i));
    // The fresh-install admin's session does not exist on the restored server.
    expect(localStorage.getItem('token')).toBeNull();
    vi.useRealTimers();
  });

  it('keeps waiting while the server answers that it is still fresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupStateStrict
      .mockResolvedValueOnce({ fresh: true })            // the mount gate
      .mockResolvedValueOnce({ fresh: true })            // poll: answered, db not swapped yet
      .mockResolvedValueOnce({ fresh: true })            // poll: same again
      .mockResolvedValueOnce({ fresh: false });          // poll: back, restored
    mount();
    await pickAndConfirm();
    // Two answers in, the database has not been swapped yet — still restarting.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restarting/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restored/i));
    vi.useRealTimers();
  });

  it('gives up after five minutes of a server that never comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupStateStrict.mockRejectedValue(new Error('down')).mockResolvedValueOnce({ fresh: true }); // the mount gate, then nothing but silence
    mount();
    await pickAndConfirm();
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60 * 1000); });
    expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restarting/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(90 * 1000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/has not come back/i));
    vi.useRealTimers();
  });

  it('offers a retry when the server cannot be reached, instead of claiming it has data', async () => {
    h.getSetupStateStrict.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mount();
    expect(await screen.findByText(/can't reach the server/i)).toBeInTheDocument();
    expect(screen.queryByText(/already has data/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByTestId('restore-source-local')).toBeInTheDocument();
    expect(await screen.findByTestId('restore-snapshot-20260912-020000')).toBeInTheDocument();
  });

  it('names the unpacking step while the restore request is still in flight', async () => {
    let release: (v: unknown) => void = () => {};
    h.restoreSnapshot.mockImplementationOnce(() => new Promise(r => { release = r; }));
    mount();
    fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
    fireEvent.click(screen.getByTestId('restore-confirm'));
    fireEvent.click(await screen.findByRole('button', { name: /^restore$/i }));
    expect(await screen.findByTestId('restore-progress')).toHaveTextContent(/unpacking/i);
    await act(async () => { release({ restarting: true, files: 3, bytes: 900 }); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restarting/i));
  });

  it('keeps the progress screen when the server says a restore is already running', async () => {
    const { RestoreRunningError } = await import('../utils/store');
    h.restoreSnapshot.mockRejectedValueOnce(new RestoreRunningError());
    mount();
    fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
    fireEvent.click(screen.getByTestId('restore-confirm'));
    fireEvent.click(await screen.findByRole('button', { name: /^restore$/i }));
    await waitFor(() => expect(h.restoreSnapshot).toHaveBeenCalled());
    // Still working, not an error: no toast and no drop back to the picker.
    expect(screen.getByTestId('restore-progress')).toHaveTextContent(/unpacking/i);
    expect(screen.queryByTestId('restore-source-local')).toBeNull();
    expect(screen.queryByText(/a restore is already running/i)).toBeNull();
  });

  it('refuses a dropped file that is not a zip', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('restore-source-upload'));
    const zone = screen.getByTestId('restore-upload-input').closest('label') as HTMLLabelElement;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'site-photo.jpg')] } });
    expect(await screen.findByText(/please drop a snapshot \.zip/i)).toBeInTheDocument();
    expect(h.uploadRestoreZip).not.toHaveBeenCalled();
  });

  it('refuses to render when the install is not fresh', async () => {
    h.getSetupStateStrict.mockResolvedValue({ fresh: false });
    mount();
    expect(await screen.findByText(/already has data/i)).toBeInTheDocument();
  });

  it('upload source shows progress and the uploaded summary', async () => {
    h.uploadRestoreZip.mockImplementation(async (_f: File, onP: (n: number) => void) => { onP(50); return { uploadId: 'u1', snapshotId: '20260901-000000', summary: { id: '20260901-000000', createdAt: 1, appVersion: '3.1.0', schemaVersion: 35, counts: { files: 7, bytes: 1 }, warnings: 1 } }; });
    mount();
    fireEvent.click(await screen.findByTestId('restore-source-upload'));
    const input = screen.getByTestId('restore-upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['zip'], 's.zip')] } });
    expect(await screen.findByText(/7 files/)).toBeInTheDocument();
    expect(screen.getByText(/1 warning/)).toBeInTheDocument();
  });

  // Regression test for the AnimatePresence route-transition remount: shortly
  // after this screen enters, PageTransition's mode="wait" AnimatePresence
  // can tear the whole page down and mount a fresh instance (its own
  // animation lifecycle, unrelated to anything below). A fresh instance must
  // still land on the authed source-picker, not an empty sign-in form, as
  // long as a valid setup-admin session is already in localStorage — this is
  // what checkFresh's re-derived `authed` (not just its useState initializer)
  // guarantees. Simulated here as a real unmount + fresh mount in the same
  // jsdom, standing in for that remount.
  it('signs in via the inline form, then survives a remount landing directly on the source picker', async () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'setup-token', user: { id: 'admin-id-123', username: 'admin', role: 'admin' } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchSpy);

    const first = mount();
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/auth/login', expect.anything()));
    expect(await screen.findByTestId('restore-source-local')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBe('setup-token');
    // The setup sign-in does not need the real Login screen's app-wide prefs
    // sync (no theme/mail/collab session to restore for this throwaway admin).
    expect(fetchSpy).not.toHaveBeenCalledWith('/api/user-preferences', expect.anything());

    first.unmount();
    mount(); // a fresh instance, token/user already in localStorage from above
    expect(await screen.findByTestId('restore-source-local')).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).toBeNull();

    vi.unstubAllGlobals();
  });
});
