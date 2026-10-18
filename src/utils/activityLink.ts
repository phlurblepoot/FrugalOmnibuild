// Maps an activity-feed entry to the project page it happened on, so feed
// rows can link there. Section resolution is by type PREFIX (issue_*, rfi_*,
// …) so future per-vertical event types inherit their section automatically;
// unknown types with a project still land on the project overview.
const SECTION_BY_PREFIX: [RegExp, string][] = [
  [/^(invoice_|payment_|change_order_)/, 'billing'],
  [/^issue_/, 'issues'],
  [/^rfi_/, 'rfis'],
  [/^daily_report_/, 'daily-reports'],
  [/^punch_/, 'punch'],
  [/^proposal_/, 'proposal'],
];

// Sections a non-admin cannot open at all: ProjectBilling and ProposalsList
// both bounce them straight back to the project overview, so a link there is
// a dead end rather than a destination.
const ADMIN_ONLY_SECTIONS = ['billing', 'proposal'];

export const activityTarget = (
  a: { type: string; projectId: string | null },
  opts: { admin?: boolean } = {},
): string | null => {
  // No project to land on — either a global event or the project is gone.
  if (!a.projectId || a.type === 'project_deleted') return null;
  const match = SECTION_BY_PREFIX.find(([re]) => re.test(a.type));
  // Billing and proposals are admin-only sections; a non-admin gets no link
  // rather than a dead end at the section's access gate (ProposalsList
  // redirects them straight back to the project overview).
  if (match && ADMIN_ONLY_SECTIONS.includes(match[1]) && !opts.admin) return null;
  return `/project/${a.projectId}${match ? `/${match[1]}` : ''}`;
};
