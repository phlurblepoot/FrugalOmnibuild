import { describe, it, expect } from 'vitest';
import { activityTarget } from './activityLink';

describe('activityTarget', () => {
  it('routes each vertical to its section', () => {
    expect(activityTarget({ type: 'invoice_created', projectId: 'p1' }, { admin: true })).toBe('/project/p1/billing');
    expect(activityTarget({ type: 'payment_recorded', projectId: 'p1' }, { admin: true })).toBe('/project/p1/billing');
    expect(activityTarget({ type: 'change_order_sent', projectId: 'p1' }, { admin: true })).toBe('/project/p1/billing');
    expect(activityTarget({ type: 'issue_resolved', projectId: 'p1' })).toBe('/project/p1/issues');
    expect(activityTarget({ type: 'rfi_answered', projectId: 'p1' })).toBe('/project/p1/rfis');
    expect(activityTarget({ type: 'daily_report_created', projectId: 'p1' })).toBe('/project/p1/daily-reports');
    expect(activityTarget({ type: 'punch_done', projectId: 'p1' })).toBe('/project/p1/punch');
    expect(activityTarget({ type: 'proposal_sent', projectId: 'p1' }, { admin: true })).toBe('/project/p1/proposal');
  });
  it('sends project-level and unknown types to the overview', () => {
    expect(activityTarget({ type: 'project_created', projectId: 'p1' })).toBe('/project/p1');
    expect(activityTarget({ type: 'status_changed', projectId: 'p1' })).toBe('/project/p1');
    expect(activityTarget({ type: 'something_new', projectId: 'p1' })).toBe('/project/p1');
  });
  it('returns null when there is nowhere to go', () => {
    expect(activityTarget({ type: 'change_order_approved', projectId: null })).toBeNull();
    expect(activityTarget({ type: 'project_deleted', projectId: 'p1' })).toBeNull();
  });
  it('gives non-admins no link for proposal entries either (ProposalsList is admin-only)', () => {
    expect(activityTarget({ type: 'proposal_sent', projectId: 'p1' })).toBeNull();
    expect(activityTarget({ type: 'proposal_accepted', projectId: 'p1' }, { admin: false })).toBeNull();
    expect(activityTarget({ type: 'proposal_sent', projectId: 'p1' }, { admin: true })).toBe('/project/p1/proposal');
  });
  it('gives non-admins no link for billing entries (section is admin-only)', () => {
    expect(activityTarget({ type: 'invoice_created', projectId: 'p1' })).toBeNull();
    expect(activityTarget({ type: 'payment_recorded', projectId: 'p1' }, { admin: false })).toBeNull();
    expect(activityTarget({ type: 'change_order_approved', projectId: 'p1' })).toBeNull();
    // non-billing sections are unaffected by role
    expect(activityTarget({ type: 'issue_created', projectId: 'p1' })).toBe('/project/p1/issues');
  });
});
