// server/mail/itemSendEffects.ts  (spec §4.6 — the ONE place item "sent" side effects live)
import type Database from 'better-sqlite3';
import { logActivity } from '../activity';
import { getProposal, markSent as markProposalSent } from '../proposalStore';
import { getInvoice, setInvoiceStatus, getChangeOrder, setChangeOrderStatus } from '../billingStore';
import { getLienRelease, setLienReleaseStatus } from '../lienReleaseStore';
import { getIssue, markIssueSent } from '../issueStore';
import { getRfi, markRfiSent } from '../rfiStore';
import { getDailyReport, dailyReportActivityName } from '../dailyReportStore';
import type { EntityType } from '../realtime/changeFeed';
import { resolveChain, type ItemType } from './links';
// Verified locations: proposalStore.ts:126/311, billingStore.ts:64/199/263/339,
// issueStore.ts (getIssue, markIssueSent:112), rfiStore.ts, dailyReportStore.ts:39.

export const ADMIN_ITEM_TYPES: ItemType[] = ['proposal', 'invoice', 'changeOrder', 'lienRelease', 'payApp'];

export interface SendEffectsInput { itemType: ItemType; itemId: string; userId: string; role: string; to: string; cc?: string; threadKey: string; subject?: string }
export interface SendEffectsResult { applied: boolean; skipped?: 'role' | 'noop' | 'missing'; broadcast?: { type: EntityType; id: string; projectId?: string; version?: number } }

const pad3 = (n: number) => String(n).padStart(3, '0');

export function applySendEffects(db: Database.Database, i: SendEffectsInput): SendEffectsResult {
  if (ADMIN_ITEM_TYPES.includes(i.itemType) && i.role !== 'admin') return { applied: false, skipped: 'role' };
  switch (i.itemType) {
    case 'proposal': {
      const p = getProposal(db, i.itemId); if (!p) return { applied: false, skipped: 'missing' };
      let version = p.version;
      if (!p.legacy && p.status === 'draft') version = markProposalSent(db, p.id, { to: i.to, cc: i.cc, subject: i.subject ?? '' }).version;
      logActivity(db, { projectId: p.projectId, userId: i.userId, type: 'proposal_sent', message: `Proposal #${p.number} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'proposal', id: p.id, projectId: p.projectId, version } };
    }
    case 'invoice': {
      const inv = getInvoice(db, i.itemId); if (!inv) return { applied: false, skipped: 'missing' };
      if (inv.status !== 'sent' && inv.status !== 'paid') { try { setInvoiceStatus(db, inv.id, 'sent'); } catch { /* best effort */ } }
      logActivity(db, { projectId: inv.projectId, userId: i.userId, type: 'invoice_sent', message: `Invoice ${inv.number ?? ''} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'invoice', id: inv.id, projectId: inv.projectId, version: getInvoice(db, inv.id)?.version } };
    }
    case 'changeOrder': {
      const co = getChangeOrder(db, i.itemId); if (!co) return { applied: false, skipped: 'missing' };
      if (!['sent', 'approved', 'rejected'].includes(co.status)) { try { setChangeOrderStatus(db, co.id, 'sent'); } catch { /* best effort */ } }
      logActivity(db, { projectId: co.projectId, userId: i.userId, type: 'change_order_sent', message: `Change Order ${co.number ?? ''} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'changeOrder', id: co.id, projectId: co.projectId, version: getChangeOrder(db, co.id)?.version } };
    }
    case 'lienRelease': {
      const lr = getLienRelease(db, i.itemId); if (!lr) return { applied: false, skipped: 'missing' };
      // A voided release stays void; a sent one is not touched again (no new updatedAt).
      if (lr.status === 'draft') { try { setLienReleaseStatus(db, lr.id, 'sent'); } catch { /* best effort */ } }
      logActivity(db, { projectId: lr.projectId, userId: i.userId, type: 'lien_release_sent', message: `Lien release LR-${lr.number ?? ''} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'lienRelease', id: lr.id, projectId: lr.projectId, version: getLienRelease(db, lr.id)?.version } };
    }
    case 'issue': {
      const iss = getIssue(db, i.itemId); if (!iss) return { applied: false, skipped: 'missing' };
      try { markIssueSent(db, iss.id); } catch { /* best effort */ }
      logActivity(db, { projectId: iss.projectId, userId: i.userId, type: 'issue_sent', message: `Issue ISS-${pad3(iss.number)} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'issue', id: iss.id, projectId: iss.projectId, version: getIssue(db, iss.id)?.version } };
    }
    case 'rfi': {
      const rfi = getRfi(db, i.itemId); if (!rfi) return { applied: false, skipped: 'missing' };
      try { markRfiSent(db, rfi.id, i.userId); } catch { /* best effort */ }
      logActivity(db, { projectId: rfi.projectId, userId: i.userId, type: 'rfi_sent', message: `RFI RFI-${pad3(rfi.number)} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'rfi', id: rfi.id, projectId: rfi.projectId, version: getRfi(db, rfi.id)?.version } };
    }
    case 'dailyReport': {
      const r = getDailyReport(db, i.itemId); if (!r) return { applied: false, skipped: 'missing' };
      logActivity(db, { projectId: r.projectId, userId: i.userId, type: 'daily_report_sent', message: `Daily report ${dailyReportActivityName(r)} emailed to ${i.to}` });
      return { applied: true };
    }
    case 'punch': {
      logActivity(db, { projectId: i.itemId, userId: i.userId, type: 'punch_sent', message: `Punch list report emailed to ${i.to}` });
      return { applied: true };
    }
    case 'payApp': {
      const { projectId } = resolveChain(db, 'payApp', i.itemId);
      if (projectId === null) return { applied: false, skipped: 'missing' };
      logActivity(db, { projectId, userId: i.userId, type: 'pay_app_sent', message: `Pay application emailed to ${i.to}` });
      return { applied: true };
    }
    default: return { applied: false, skipped: 'noop' };
  }
}
