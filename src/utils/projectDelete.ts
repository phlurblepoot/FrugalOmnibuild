// Why a project can't be deleted, in one line (spec
// docs/superpowers/specs/2026-10-07-project-delete-guard-design.md): only a
// project with nothing in it may be deleted; anything else is archived.
import type { ProjectDataSummary } from './store';

// The server's kinds (server/projectStore.ts PROJECT_DATA_QUERIES), in the
// order a person would name them. A kind the server adds later still shows,
// last, by its own name.
const KIND_LABELS: [kind: string, one: string, many: string][] = [
  ['documents', 'document', 'documents'],
  ['planPages', 'plan page', 'plan pages'],
  ['measurements', 'measurement', 'measurements'],
  ['proposals', 'proposal', 'proposals'],
  ['invoices', 'invoice', 'invoices'],
  ['payments', 'payment', 'payments'],
  ['changeOrders', 'change order', 'change orders'],
  ['payApps', 'pay application', 'pay applications'],
  ['sovLines', 'schedule of values line', 'schedule of values lines'],
  ['rfis', 'RFI', 'RFIs'],
  ['issues', 'issue', 'issues'],
  ['punchItems', 'punch item', 'punch items'],
  ['dailyReports', 'daily report', 'daily reports'],
  ['timeEntries', 'time entry', 'time entries'],
  ['notes', 'note', 'notes'],
  ['linkedEmails', 'linked email', 'linked emails'],
  ['otherRecords', 'other record', 'other records'],
];

// How many of the kinds to name before "and more" — the line stays one line.
const NAMED_KINDS = 3;

/** "12 documents, 2 invoices and 1 RFI" — the kinds a project has, most
 *  recognizable first; past three, "… and more". */
export function describeProjectData(summary: ProjectDataSummary): string {
  const known = new Set(KIND_LABELS.map(([k]) => k));
  const parts = [
    ...KIND_LABELS.filter(([k]) => (summary[k] ?? 0) > 0)
      .map(([k, one, many]) => `${summary[k]} ${summary[k] === 1 ? one : many}`),
    ...Object.entries(summary).filter(([k, n]) => !known.has(k) && n > 0).map(([k, n]) => `${n} ${k}`),
  ];
  if (parts.length === 0) return 'records';
  if (parts.length > NAMED_KINDS) return `${parts.slice(0, NAMED_KINDS).join(', ')} and more`;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The one-line reason shown where Delete would be: "Has 12 documents and
 *  2 invoices — archive it instead." */
export function projectDeleteBlockedReason(summary: ProjectDataSummary): string {
  return `Has ${describeProjectData(summary)} — archive it instead.`;
}
