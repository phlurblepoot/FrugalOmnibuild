// server/reportRoutes.ts — the Reports page's API (admin-only, like all
// billing; spec docs/superpowers/specs/2026-10-06-reports-design.md). Read-only
// GETs; every filter is a query parameter:
//   projectId, customerId  — narrow to one project / one customer's projects
//   includeArchived=0      — leave archived projects out (they're in by default)
//   from, to               — payments: calendar days 'YYYY-MM-DD', inclusive
//   status                 — change orders: draft | sent | approved | rejected
import express from 'express';
import type Database from 'better-sqlite3';
import {
  openInvoicesReport, paymentsReport, changeOrdersReport, retainageReport, reportFilterOptions,
  ValidationError, type ReportFilters,
} from './reportsStore';

export interface ReportRouteDeps {
  db: Database.Database;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
}

const reportErr = (e: unknown, res: express.Response) => {
  if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
  console.error('Report error:', e);
  return res.status(500).json({ error: 'Failed to build the report' });
};

// Blank or repeated (array) parameters count as absent.
const param = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function reportFiltersFromQuery(q: express.Request['query']): ReportFilters {
  const archived = param(q.includeArchived);
  return {
    projectId: param(q.projectId),
    customerId: param(q.customerId),
    includeArchived: archived === undefined ? undefined : !(archived === '0' || archived === 'false'),
    from: param(q.from),
    to: param(q.to),
    status: param(q.status),
  };
}

export function registerReportRoutes(app: express.Express, deps: ReportRouteDeps): void {
  const { db, authenticateToken, requireAdmin } = deps;
  const gate = [authenticateToken, requireAdmin];
  const report = (path: string, build: (f: ReportFilters) => unknown) =>
    app.get(path, ...gate, (req, res) => {
      try { res.json(build(reportFiltersFromQuery(req.query))); } catch (e) { reportErr(e, res); }
    });

  // The project and customer pickers.
  app.get('/api/reports/options', ...gate, (_req, res) => {
    try { res.json(reportFilterOptions(db)); } catch (e) { reportErr(e, res); }
  });
  report('/api/reports/open-invoices', f => openInvoicesReport(db, f));
  report('/api/reports/payments', f => paymentsReport(db, f));
  report('/api/reports/change-orders', f => changeOrdersReport(db, f));
  report('/api/reports/retainage', f => retainageReport(db, f));
}
