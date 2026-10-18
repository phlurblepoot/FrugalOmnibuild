// src/pages/settings/PhoneNotifications.tsx — User Preferences → Phone
// notifications (ONLYOFFICE Phase 5, added 2026-09-27). Turns push on or off
// for the device in hand, sends a test, and lists the person's other devices
// so one left behind can be switched off from here.
//
// On iPhone/iPad the only way in is the app added to the Home Screen and
// opened from there, so that case shows the steps instead of a button.
import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, Share, Smartphone, Trash2 } from 'lucide-react';
import { Button, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { getPushDevices, removePushDevice, sendTestPush, type PushDevice } from '../../utils/store';
import { PushSetupError, disablePush, enablePush, pushStatus, type PushStatus } from '../../utils/push';

const STATUS_TEXT: Record<PushStatus, string> = {
  on: 'On for this device. Everything the bell shows also pops up here, even with the app closed.',
  off: 'Off for this device.',
  denied: 'Notifications are blocked for this site on this device. Allow them in the browser (or phone) settings for this site, then come back.',
  unsupported: "This browser can't show notifications from the app. Chrome, Edge, Firefox and Safari can.",
  'needs-install': 'On iPhone and iPad, notifications need the app on your Home Screen:',
};

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString([], { dateStyle: 'medium' }) : 'not yet');

export const PhoneNotifications: React.FC = () => {
  const { toast } = useToast();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus(await pushStatus().catch(() => 'unsupported' as const));
    setDevices(await getPushDevices().catch(() => []));
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Arrived from the bell's "Get these on your phone…".
  useEffect(() => {
    if (status && window.location.hash === '#phone-notifications') {
      document.getElementById('phone-notifications')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  }, [status]);

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try { await fn(); } catch (e) {
      toast(e instanceof PushSetupError ? e.message : errText(e, fallback), { type: 'error' });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const test = () => run(async () => {
    const r = await sendTestPush();
    if (r.sent) toast(`Test sent to ${r.sent} device${r.sent === 1 ? '' : 's'}`, { type: 'success' });
    else toast("The test couldn't be delivered. Turn notifications off and on again on the device.", { type: 'error' });
  }, "Couldn't send the test");

  return (
    <div id="phone-notifications" className="scroll-mt-4 bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden" data-testid="phone-notifications">
      <div className="p-6 border-b border-edge flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <BellRing size={18} className="text-accent-600 dark:text-accent-400" />
            Phone notifications
          </h2>
          {status === null ? <Skeleton className="mt-1 h-4 w-64" /> : (
            <p className="text-sm text-ink-soft" data-testid="push-status" data-status={status}>{STATUS_TEXT[status]}</p>
          )}
          {status === 'needs-install' && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-soft" data-testid="push-install-steps">
              <li>In Safari, tap <Share size={13} className="inline -mt-0.5" aria-label="Share" /> Share, then <b>Add to Home Screen</b>.</li>
              <li>Open the app from the new icon and sign in.</li>
              <li>Come back to Settings → User Preferences and turn notifications on.</li>
            </ol>
          )}
        </div>
        <div className="flex gap-2">
          {status === 'off' && (
            <Button size="sm" disabled={busy} data-testid="push-enable"
              onClick={() => void run(async () => { await enablePush(); toast('Notifications are on for this device', { type: 'success' }); }, "Couldn't turn notifications on")}>
              Turn on for this device
            </Button>
          )}
          {status === 'on' && (
            <>
              <Button size="sm" variant="secondary" disabled={busy} data-testid="push-test" onClick={() => void test()}>Send a test</Button>
              <Button size="sm" variant="secondary" disabled={busy} data-testid="push-disable"
                onClick={() => void run(disablePush, "Couldn't turn notifications off")}>
                Turn off
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="px-6 py-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">Your devices with notifications on</p>
        {devices === null ? <Skeleton className="h-6 w-48" /> : devices.length === 0 ? (
          <p className="text-sm text-ink-soft" data-testid="push-devices-empty">None yet.</p>
        ) : (
          <ul className="space-y-1" data-testid="push-devices">
            {devices.map(d => (
              <li key={d.id} className="flex items-center gap-2 text-sm text-ink" data-testid="push-device">
                <Smartphone size={14} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{d.device || 'Unknown device'}</span>
                <span className="text-xs text-ink-faint">since {when(d.createdAt)} · last sent {when(d.lastUsedAt)}</span>
                <button
                  type="button"
                  className="rounded-md p-1 text-ink-soft hover:bg-hover hover:text-red-600 disabled:opacity-50"
                  aria-label={`Turn off for ${d.device || 'this device'}`}
                  title="Turn off for this device"
                  disabled={busy}
                  onClick={() => void run(() => removePushDevice(d.id), "Couldn't remove that device")}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {status === 'on' && devices?.length === 0 && (
          <p className="mt-2 text-xs text-ink-faint">This device isn't registered with the server yet. Turn it off and on again.</p>
        )}
      </div>
    </div>
  );
};
