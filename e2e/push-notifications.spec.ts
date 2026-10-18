import { test, expect } from './fixtures/test';

// Phone push notifications (ONLYOFFICE Phase 5, added 2026-09-27) in a real
// browser: the app is installable (manifest, icons), the real service worker
// registers, and turning notifications on registers this device with the
// server. Headless Chromium can't reach Google's push service, so only the
// browser's subscribe call is stood in for; delivery to a real phone is
// The owner's manual check. Encryption and sending are covered by
// server/push.test.ts.

test('the app is installable: manifest, icons and the service worker are served', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toMatch(/^application\/manifest\+json/);
  const m = await manifest.json();
  expect(m).toMatchObject({ display: 'standalone', start_url: '/dashboard' });
  for (const icon of m.icons as { src: string }[]) {
    const r = await request.get(icon.src);
    expect(r.headers()['content-type']).toBe('image/png');
  }
  const sw = await request.get('/sw.js');
  expect(sw.headers()['content-type']).toMatch(/javascript/);
  expect(await sw.text()).toContain("addEventListener('push'");
});

test('turning notifications on registers this device, and off removes it', async ({ authedPage, context }) => {
  await context.grantPermissions(['notifications']);
  // Stand in for the browser's push-service round trip only.
  await authedPage.addInitScript(() => {
    let sub: any = null;
    const fake = (key: ArrayBuffer) => ({
      endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device',
      options: { applicationServerKey: key },
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }),
      unsubscribe: async () => { sub = null; return true; },
    });
    PushManager.prototype.subscribe = async function (opts: any) {
      const k = opts.applicationServerKey;
      sub = fake(k.buffer ? k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength) : k);
      return sub;
    } as any;
    PushManager.prototype.getSubscription = async function () { return sub; } as any;
  });

  await authedPage.goto('/settings?tab=preferences#phone-notifications');
  const section = authedPage.getByTestId('phone-notifications');
  await expect(section).toBeVisible();
  // The real service worker registered from /sw.js.
  expect(await authedPage.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toMatch(/\/sw\.js$/);

  await expect(section.getByTestId('push-status')).toHaveAttribute('data-status', 'off');
  await section.getByTestId('push-enable').click();
  await expect(authedPage.getByText('Notifications are on for this device')).toBeVisible();
  await expect(section.getByTestId('push-status')).toHaveAttribute('data-status', 'on');
  await expect(section.getByTestId('push-device')).toHaveCount(1);
  await expect(section.getByTestId('push-device')).toContainText('Chrome');
  await authedPage.screenshot({ path: 'test-results/phone-notifications.png' });

  await section.getByTestId('push-disable').click();
  await expect(section.getByTestId('push-status')).toHaveAttribute('data-status', 'off');
  await expect(section.getByTestId('push-devices-empty')).toBeVisible();
});

test("the bell's panel leads to the phone settings", async ({ authedPage }) => {
  await authedPage.goto('/dashboard');
  await authedPage.getByTestId('notification-bell').click();
  await authedPage.getByTestId('notification-phone-settings').click();
  await expect(authedPage).toHaveURL(/\/settings\?tab=preferences#phone-notifications$/);
  await expect(authedPage.getByTestId('phone-notifications')).toBeInViewport();
});
