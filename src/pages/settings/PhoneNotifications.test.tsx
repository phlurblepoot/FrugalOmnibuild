// User Preferences → Phone notifications: the state this device is in (with
// the iPhone steps), turning it on and off, a test, and the device list.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../components/Toast';

const h = vi.hoisted(() => ({
  pushStatus: vi.fn(), enablePush: vi.fn(), disablePush: vi.fn(),
  getPushDevices: vi.fn(), removePushDevice: vi.fn(), sendTestPush: vi.fn(),
}));
vi.mock('../../utils/push', async (orig) => ({
  ...(await orig<typeof import('../../utils/push')>()),
  pushStatus: h.pushStatus, enablePush: h.enablePush, disablePush: h.disablePush,
}));
vi.mock('../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../utils/store')>()),
  getPushDevices: h.getPushDevices, removePushDevice: h.removePushDevice, sendTestPush: h.sendTestPush,
}));
import { PushSetupError } from '../../utils/push';
import { PhoneNotifications } from './PhoneNotifications';

const DEVICE = { id: 'd1', device: 'iPhone · Safari', createdAt: Date.UTC(2026, 8, 20), lastUsedAt: null };
const mount = () => render(<ToastProvider><PhoneNotifications /></ToastProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  h.getPushDevices.mockResolvedValue([]);
});

describe('PhoneNotifications', () => {
  it('shows the Home Screen steps on an iPhone browser tab, with no button', async () => {
    h.pushStatus.mockResolvedValue('needs-install');
    mount();
    expect(await screen.findByTestId('push-install-steps')).toHaveTextContent(/Add to Home Screen/);
    expect(screen.queryByTestId('push-enable')).toBeNull();
  });

  it('explains a blocked site', async () => {
    h.pushStatus.mockResolvedValue('denied');
    mount();
    expect(await screen.findByTestId('push-status')).toHaveTextContent(/blocked for this site/);
  });

  it('turns it on for this device, then offers a test and turning it off', async () => {
    h.pushStatus.mockResolvedValueOnce('off').mockResolvedValue('on');
    h.enablePush.mockResolvedValue(undefined);
    h.getPushDevices.mockResolvedValueOnce([]).mockResolvedValue([DEVICE]);
    mount();
    fireEvent.click(await screen.findByTestId('push-enable'));
    expect(await screen.findByText('Notifications are on for this device')).toBeInTheDocument();
    expect(h.enablePush).toHaveBeenCalled();
    expect(await screen.findByTestId('push-device')).toHaveTextContent('iPhone · Safari');
    expect(screen.getByTestId('push-device')).toHaveTextContent('last sent not yet');

    h.sendTestPush.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
    fireEvent.click(screen.getByTestId('push-test'));
    expect(await screen.findByText('Test sent to 1 device')).toBeInTheDocument();
  });

  it('says why it could not turn on', async () => {
    h.pushStatus.mockResolvedValue('off');
    h.enablePush.mockRejectedValue(new PushSetupError('Notifications were not allowed.'));
    mount();
    fireEvent.click(await screen.findByTestId('push-enable'));
    expect(await screen.findByText('Notifications were not allowed.')).toBeInTheDocument();
  });

  it('turns it off here, or for another device from the list', async () => {
    h.pushStatus.mockResolvedValue('on');
    h.disablePush.mockResolvedValue(undefined);
    h.getPushDevices.mockResolvedValue([DEVICE, { ...DEVICE, id: 'd2', device: 'Android · Chrome' }]);
    h.removePushDevice.mockResolvedValue(undefined);
    mount();
    fireEvent.click(await screen.findByTestId('push-disable'));
    await waitFor(() => expect(h.disablePush).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off for Android · Chrome' }));
    await waitFor(() => expect(h.removePushDevice).toHaveBeenCalledWith('d2'));
  });

  it('says when a test reached no device', async () => {
    h.pushStatus.mockResolvedValue('on');
    h.getPushDevices.mockResolvedValue([DEVICE]);
    h.sendTestPush.mockResolvedValue({ sent: 0, removed: 1, failed: 0 });
    mount();
    fireEvent.click(await screen.findByTestId('push-test'));
    expect(await screen.findByText(/couldn't be delivered/)).toBeInTheDocument();
  });
});
