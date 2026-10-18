// src/utils/push.ts — phone push notifications on this device (ONLYOFFICE
// Phase 5, added 2026-09-27): registering the service worker (public/sw.js),
// telling what this browser can do, and turning push on or off.
//
// iPhone and iPad allow push only for the app added to the Home Screen and
// opened from there (iOS 16.4+); in a Safari tab the pieces simply aren't
// there, so that case gets its own status with the steps to follow.
import { getPushConfig, removePushSubscription, savePushSubscription } from './store';

export type PushStatus =
  | 'unsupported'    // this browser can't do push at all
  | 'needs-install'  // iPhone/iPad: add to Home Screen, open from there
  | 'denied'         // blocked in the browser's settings for this site
  | 'off'
  | 'on';

export const isIos = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = (): boolean =>
  (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined'
  && 'PushManager' in window && 'Notification' in window;

/** Registers the service worker; null where there's none to have. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  try { return (await currentSubscription()) ? 'on' : 'off'; } catch { return 'off'; }
}

/** The key as the Push API wants it. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i]);

export class PushSetupError extends Error {}

/** Turns push on for this device. Call straight from a tap: browsers only
 *  ask for permission in answer to one. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new PushSetupError("This browser can't show notifications from the app.");
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushSetupError(permission === 'denied'
      ? 'Notifications are blocked for this site. Allow them in the browser settings, then try again.'
      : 'Notifications were not allowed.');
  }
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const key = urlBase64ToUint8Array((await getPushConfig()).publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Made for another server key (e.g. a restored backup): start over.
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await savePushSubscription(sub.toJSON());
}

/** Turns push off for this device. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await removePushSubscription(endpoint);
}

/** The number on the installed app's icon, where the platform has one. */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (count > 0) void nav.setAppBadge?.(count)?.catch?.(() => {});
    else void nav.clearAppBadge?.()?.catch?.(() => {});
  } catch { /* not available */ }
}
