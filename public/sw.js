// public/sw.js — the app's service worker: phone push notifications
// (ONLYOFFICE Phase 5, added 2026-09-27). It shows what the server pushes
// (server/push.ts) and opens the right page when one is tapped.
//
// Also catches the Android share-sheet POST (bottom of this file). Otherwise
// deliberately nothing else: no caching, no offline copy, so a new release is
// never hidden behind an old one.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data && event.data.text() }; }
  const title = data.title || 'New notification';
  const shown = self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    // One per notification: a second push about the same thing replaces it.
    tag: data.id || undefined,
    data: { link: typeof data.link === 'string' && data.link.startsWith('/') ? data.link : '/', id: data.id || null },
  });
  // The number on the app icon (installed app, where supported).
  const badge = typeof data.unread === 'number' && self.navigator.setAppBadge
    ? self.navigator.setAppBadge(data.unread).catch(() => {})
    : Promise.resolve();
  event.waitUntil(Promise.all([shown, badge]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { link = '/', id = null } = event.notification.data || {};
  event.waitUntil((async () => {
    // An open window of the app: bring it forward and let it go there
    // itself (no reload), marking the notification read on the way.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open-notification', link, id });
      return;
    }
    // Otherwise open the app there; the page marks it read (?fromNotification=).
    const url = new URL(link, self.location.origin);
    if (id) url.searchParams.set('fromNotification', id);
    await self.clients.openWindow(url.href);
  })());
});

// Share into the app (Android share sheet). The manifest's share_target POSTs
// here; there is no server route for it. Park the files in the cache for the
// share page (src/pages/ShareTargetPage.tsx), then redirect to it. Keep the
// cache name in step with the page.
const SHARE_CACHE = 'share-target-v1';

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share-target') return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const cache = await caches.open(SHARE_CACHE);
      for (const key of await cache.keys()) await cache.delete(key);
      const files = form.getAll('files').filter(f => typeof f !== 'string');
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        await cache.put('/share-target/file/' + i, new Response(f, {
          headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name || 'shared-file') },
        }));
      }
      const note = { title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || '') };
      await cache.put('/share-target/meta', new Response(JSON.stringify(note), { headers: { 'Content-Type': 'application/json' } }));
    } catch { /* fall through to the page, which shows nothing to file */ }
    return Response.redirect('/share-target?shared=1', 303);
  })());
});
