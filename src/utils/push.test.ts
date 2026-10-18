// Phone push on this device: what the browser can do (including the iPhone
// "add to Home Screen first" case), turning it on (permission, subscribe with
// the server's key, register with the server) and off.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ getPushConfig: vi.fn(), savePushSubscription: vi.fn(), removePushSubscription: vi.fn() }));
vi.mock('./store', () => h);
import { PushSetupError, disablePush, enablePush, pushStatus, setAppBadge, urlBase64ToUint8Array } from './push';

// A 65-byte P-256 public key, base64url, like the server's.
const KEY = 'BPx3b2Z7cJ3eJt1bL6yq6W3jQx0c1l0n8j2N3m4o5p6q7r8s9t0u1v2w3x4y5z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0';
const keyBytes = urlBase64ToUint8Array(KEY);

interface Fake { permission: NotificationPermission; request: NotificationPermission; sub: any; subscribed: any[] }
let fake: Fake;
const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');

function fakeSubscription(key: Uint8Array) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    options: { applicationServerKey: key.buffer.slice(0) },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => { fake.sub = null; return true; }),
  };
}

function installBrowser(opts: { push?: boolean } = {}) {
  const pushManager = {
    getSubscription: vi.fn(async () => fake.sub),
    subscribe: vi.fn(async (o: { applicationServerKey: Uint8Array }) => {
      fake.subscribed.push(o);
      fake.sub = fakeSubscription(o.applicationServerKey);
      return fake.sub;
    }),
  };
  const reg = { pushManager };
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: { register: vi.fn(async () => reg), getRegistration: vi.fn(async () => reg), ready: Promise.resolve(reg) },
  });
  if (opts.push === false) {
    delete (window as any).PushManager;
    delete (window as any).Notification;
  } else {
    (window as any).PushManager = function PushManager() {};
    (window as any).Notification = {
      get permission() { return fake.permission; },
      requestPermission: vi.fn(async () => { fake.permission = fake.request; return fake.request; }),
    };
  }
  return pushManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = { permission: 'default', request: 'granted', sub: null, subscribed: [] };
  h.getPushConfig.mockResolvedValue({ publicKey: KEY });
  h.savePushSubscription.mockResolvedValue({ id: 'd1' });
  h.removePushSubscription.mockResolvedValue(undefined);
});
afterEach(() => {
  delete (window as any).PushManager;
  delete (window as any).Notification;
  if (ua) Object.defineProperty(window.navigator, 'userAgent', ua);
});

describe('pushStatus', () => {
  it('knows an iPhone Safari tab needs the Home Screen app, and other browsers without push just can\'t', async () => {
    installBrowser({ push: false });
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1' });
    expect(await pushStatus()).toBe('needs-install');
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64) SomeOldBrowser' });
    expect(await pushStatus()).toBe('unsupported');
  });

  it('reads blocked, off and on', async () => {
    installBrowser();
    fake.permission = 'denied';
    expect(await pushStatus()).toBe('denied');
    fake.permission = 'granted';
    expect(await pushStatus()).toBe('off');
    fake.sub = fakeSubscription(keyBytes);
    expect(await pushStatus()).toBe('on');
  });
});

describe('enablePush / disablePush', () => {
  it('asks permission, subscribes with the server key, and registers the device', async () => {
    const pm = installBrowser();
    await enablePush();
    expect((window as any).Notification.requestPermission).toHaveBeenCalled();
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.subscribed[0].userVisibleOnly).toBe(true);
    expect(Array.from(fake.subscribed[0].applicationServerKey)).toEqual(Array.from(keyBytes));
    expect(h.savePushSubscription).toHaveBeenCalledWith({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('says so when notifications are refused', async () => {
    installBrowser();
    fake.request = 'denied';
    await expect(enablePush()).rejects.toThrow(PushSetupError);
    await expect(enablePush()).rejects.toThrow(/blocked for this site/);
    expect(h.savePushSubscription).not.toHaveBeenCalled();
  });

  it('starts over when the subscription was made for another server key', async () => {
    const pm = installBrowser();
    const stale = fakeSubscription(new Uint8Array(65).fill(7));
    fake.sub = stale;
    await enablePush();
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pm.subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps a matching subscription as it is', async () => {
    const pm = installBrowser();
    fake.sub = fakeSubscription(keyBytes);
    await enablePush();
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(h.savePushSubscription).toHaveBeenCalled();
  });

  it('turns off: unsubscribes and tells the server', async () => {
    installBrowser();
    fake.sub = fakeSubscription(keyBytes);
    const sub = fake.sub;
    await disablePush();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(h.removePushSubscription).toHaveBeenCalledWith('https://fcm.googleapis.com/fcm/send/abc');
  });
});

describe('helpers', () => {
  it('decodes the server key', () => {
    expect(keyBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(urlBase64ToUint8Array('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
  });

  it('puts the unread count on the app icon where it can', () => {
    const set = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    Object.assign(window.navigator, { setAppBadge: set, clearAppBadge: clear });
    setAppBadge(3);
    setAppBadge(0);
    expect(set).toHaveBeenCalledWith(3);
    expect(clear).toHaveBeenCalled();
    delete (window.navigator as any).setAppBadge;
    delete (window.navigator as any).clearAppBadge;
    expect(() => setAppBadge(2)).not.toThrow();
  });
});
