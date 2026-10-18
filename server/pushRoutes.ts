// server/pushRoutes.ts — phone push notifications (ONLYOFFICE Phase 5, added
// 2026-09-27), and the web app manifest that lets phones install the app
// (an iPhone only allows push for an app added to the Home Screen).
//
//   GET    /manifest.webmanifest        the installable app (name from Settings)
//   GET    /api/push/config             this server's public VAPID key
//   GET    /api/push/devices            my devices with push on
//   POST   /api/push/subscribe          { subscription } — turn it on for this device
//   POST   /api/push/unsubscribe        { endpoint } — turn it off for this device
//   DELETE /api/push/devices/:id        turn it off for one of my devices
//   POST   /api/push/test               send myself a test
import express from 'express';
import type Database from 'better-sqlite3';
import { PushError, type PushService } from './push';
import { deviceLabel } from './realtime/deviceLabel';

export interface PushRouteDeps {
  db: Database.Database;
  authenticateToken: express.RequestHandler;
  push: PushService;
}

/** The app as a phone installs it. Colours match the app's default accent. */
export function webAppManifest(appName: string): Record<string, unknown> {
  const name = appName.trim() || 'FrugalOmnibuild';
  const shortFallback = name === 'FrugalOmnibuild' ? 'Omnibuild' : null;
  return {
    name,
    short_name: shortFallback ?? (name.length > 12 ? name.split(/\s+/)[0].slice(0, 12) || name.slice(0, 12) : name),
    id: '/',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#2563eb',
    // Android "Share" sheet: the service worker (public/sw.js) catches this
    // POST, parks the files in the cache, and sends the app to /share-target.
    share_target: {
      action: '/share-target',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [{ name: 'files', accept: ['application/pdf', 'image/*', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.dwg', '.dxf'] }],
      },
    },
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

export function registerPushRoutes(app: express.Express, deps: PushRouteDeps): void {
  const { db, authenticateToken, push } = deps;
  const me = (req: express.Request) => String((req as any).user?.id ?? '');

  app.get('/manifest.webmanifest', (_req, res) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'appName'").get() as { value: string } | undefined;
    res.set('Content-Type', 'application/manifest+json; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(JSON.stringify(webAppManifest(row?.value ?? '')));
  });

  app.get('/api/push/config', authenticateToken, (_req, res) => {
    res.json({ publicKey: push.keys().publicKey });
  });

  app.get('/api/push/devices', authenticateToken, (req, res) => {
    res.json({ devices: push.devices(me(req)) });
  });

  app.post('/api/push/subscribe', authenticateToken, (req, res) => {
    try {
      const device = push.subscribe(me(req), req.body?.subscription ?? {}, deviceLabel(req.get('user-agent')));
      res.json({ device });
    } catch (e) {
      if (e instanceof PushError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.post('/api/push/unsubscribe', authenticateToken, (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    res.json({ removed: push.unsubscribe(me(req), endpoint) });
  });

  app.delete('/api/push/devices/:id', authenticateToken, (req, res) => {
    if (!push.removeDevice(me(req), req.params.id)) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  });

  app.post('/api/push/test', authenticateToken, async (req, res) => {
    const result = await push.send(me(req), {
      title: 'Test notification',
      body: "Phone notifications are working. You'll get one whenever the bell does.",
      link: '/dashboard',
    });
    res.json(result);
  });
}
