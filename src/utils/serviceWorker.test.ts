// public/sw.js — the service worker — run against a stand-in worker scope:
// a push shows the notification (icon, badge, tag, link) and sets the app
// icon's count; a tap brings an open window forward and hands it the link, or
// opens the app on the link when none is open.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'sw.js'), 'utf8');

type Listener = (e: any) => void;
let listeners: Record<string, Listener>;
let scope: any;
let windows: { url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[];

beforeEach(() => {
  listeners = {};
  windows = [];
  scope = {
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    location: { origin: 'https://takeoff.example.com' },
    registration: { showNotification: vi.fn(async () => {}) },
    navigator: { setAppBadge: vi.fn(async () => {}) },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
  };
  new Function('self', SOURCE)(scope);
});

/** Fires an event and waits for what it handed to waitUntil. */
async function fire(type: string, event: Record<string, unknown>) {
  let pending: Promise<unknown> = Promise.resolve();
  listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } });
  await pending;
}

describe('service worker', () => {
  it('shows a pushed notification and puts the unread count on the icon', async () => {
    const payload = { id: 'n1', title: 'maria assigned you a task', body: 'Patch soffit', link: '/tasks?open=t1', unread: 4 };
    await fire('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
    expect(scope.registration.showNotification).toHaveBeenCalledWith('maria assigned you a task', {
      body: 'Patch soffit', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', tag: 'n1',
      data: { link: '/tasks?open=t1', id: 'n1' },
    });
    expect(scope.navigator.setAppBadge).toHaveBeenCalledWith(4);
  });

  it('still shows something for an odd message, and never links outside the app', async () => {
    await fire('push', { data: { json: () => { throw new Error('not json'); }, text: () => 'plain words' } });
    expect(scope.registration.showNotification).toHaveBeenLastCalledWith('plain words', expect.objectContaining({ data: { link: '/', id: null } }));
    await fire('push', { data: { json: () => ({ title: 'x', link: 'https://evil.example/' }), text: () => '' } });
    expect(scope.registration.showNotification.mock.calls[1][1].data.link).toBe('/');
  });

  it('a tap brings the open app forward and hands it the link', async () => {
    const win = { url: 'https://takeoff.example.com/dashboard', focus: vi.fn(async () => {}), postMessage: vi.fn() };
    windows.push({ url: 'https://elsewhere.example/', focus: vi.fn(), postMessage: vi.fn() }, win);
    const notification = { close: vi.fn(), data: { link: '/project/p1/rfis?open=r1', id: 'n2' } };
    await fire('notificationclick', { notification });
    expect(notification.close).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.postMessage).toHaveBeenCalledWith({ type: 'open-notification', link: '/project/p1/rfis?open=r1', id: 'n2' });
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a tap with the app closed opens it on the link, marked as from that notification', async () => {
    await fire('notificationclick', { notification: { close: vi.fn(), data: { link: '/tasks?open=t1', id: 'n3' } } });
    expect(scope.clients.openWindow).toHaveBeenCalledWith('https://takeoff.example.com/tasks?open=t1&fromNotification=n3');
  });
});
