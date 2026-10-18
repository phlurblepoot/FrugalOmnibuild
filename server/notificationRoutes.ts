// server/notificationRoutes.ts — the bell's API (ONLYOFFICE Phase 5). Everyone
// sees only their own notifications.
//
//   GET  /api/notifications              { items, unread }
//   POST /api/notifications/:id/read     mark one read
//   POST /api/notifications/read-all     mark them all read
import express from 'express';
import type { Notifier } from './notifications';

export interface NotificationRouteDeps {
  authenticateToken: express.RequestHandler;
  notifier: Notifier;
}

export function registerNotificationRoutes(app: express.Express, deps: NotificationRouteDeps): void {
  const { authenticateToken, notifier } = deps;
  const me = (req: express.Request) => String((req as any).user?.id ?? '');

  app.get('/api/notifications', authenticateToken, (req, res) => {
    const limit = Number(req.query.limit);
    res.json(notifier.list(me(req), Number.isFinite(limit) && limit > 0 ? limit : undefined));
  });

  app.post('/api/notifications/read-all', authenticateToken, (req, res) => {
    res.json({ marked: notifier.markAllRead(me(req)) });
  });

  app.post('/api/notifications/:id/read', authenticateToken, (req, res) => {
    if (!notifier.markRead(me(req), req.params.id)) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  });
}
