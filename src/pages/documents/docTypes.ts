// src/pages/documents/docTypes.ts
// kind -> {label, tone} for the Documents page's Type badge and Type filter.
// Mirrors the canonical kind vocabulary in server/documents.ts's KIND_LABELS
// (spec §Data model), but owns its own presentation (tone) since the server
// has no UI concerns. Custom admin-defined kinds are `custom:<id>` — their
// label lives in settings.documentTypes, not here.
import type { PillTone } from '../../components/ui';
import type { CustomDocType } from '../../utils/store';

// Re-exported so existing `from './docTypes'` imports (DocumentsPage,
// DocumentsTable, UploadDocumentsModal, Settings) keep working — store.ts
// owns the canonical shape since it's also where getDocumentTypes/
// saveDocumentTypes live.
export type { CustomDocType };

interface KindMeta { label: string; tone: PillTone; }

const KIND_META: Record<string, KindMeta> = {
  document:             { label: 'Document',          tone: 'slate' },
  spreadsheet:          { label: 'Spreadsheet',        tone: 'green' },
  photo:                { label: 'Photo',              tone: 'slate' },
  other:                { label: 'Other',              tone: 'slate' },
  proposal:             { label: 'Proposal',           tone: 'blue' },
  'proposal-photo':     { label: 'Proposal Photo',     tone: 'blue' },
  'proposal-signed':    { label: 'Signed Proposal',    tone: 'blue' },
  // Retired kind: migration 28 relabels every legacy 'printout' row to
  // takeoff-print/takeoff-export, but a database that hasn't run it yet (or a
  // row that migration missed) would otherwise render a raw 'printout' badge.
  // Kept out of KIND_OPTIONS — nobody should be able to filter to, or re-type
  // a file into, a kind we no longer write.
  printout:             { label: 'Printout',           tone: 'slate' },
  'takeoff-print':      { label: 'Takeoff Print',      tone: 'slate' },
  'takeoff-export':     { label: 'Takeoff Export',     tone: 'green' },
  'company-document':   { label: 'Company Document',   tone: 'violet' },
  'plan-source':        { label: 'Plan Set',           tone: 'slate' },
  invoice:              { label: 'Invoice',            tone: 'emerald' },
  'change-order':       { label: 'Change Order',       tone: 'amber' },
  'change-order-photo': { label: 'Change Order Photo', tone: 'amber' },
  'lien-release':       { label: 'Lien Release',       tone: 'emerald' },
  'payapp-export':      { label: 'Pay App Export',     tone: 'emerald' },
  'payapp-pdf':         { label: 'Pay App PDF',        tone: 'emerald' },
  'issue-report':       { label: 'Issue',              tone: 'red' },
  'issue-photo':        { label: 'Issue Photo',        tone: 'red' },
  'punch-report':       { label: 'Punch Report',       tone: 'orange' },
  'punch-photo':        { label: 'Punch Photo',        tone: 'orange' },
  rfi:                  { label: 'RFI',                tone: 'violet' },
  'rfi-photo':           { label: 'RFI Photo',          tone: 'violet' },
  'rfi-response':        { label: 'RFI Response',       tone: 'violet' },
  'task-photo':          { label: 'Task Photo',         tone: 'blue' },
  'email-attachment':    { label: 'Email Attachment',   tone: 'slate' },
  'daily-report':        { label: 'Daily Report',       tone: 'violet' },
  'daily-report-photo':  { label: 'Daily Report Photo', tone: 'violet' },
  'payment-attachment':  { label: 'Payment Attachment', tone: 'emerald' },
};

// Display order for the Type filter dropdown. 'plan' and 'settings-asset' are
// never returned by GET /api/documents (spec §Server "always excluded"), so
// they have no entry here; 'printout' has a KIND_META entry (so a stray
// pre-migration row still gets a readable badge) but is never offered.
const NON_SELECTABLE_KINDS = ['printout'];

export const KIND_OPTIONS: { id: string; label: string }[] = Object.keys(KIND_META)
  .filter(id => !NON_SELECTABLE_KINDS.includes(id))
  .map(id => ({ id, label: KIND_META[id].label }));

const customLabel = (kind: string, customTypes: CustomDocType[]): string | undefined => {
  if (!kind.startsWith('custom:')) return undefined;
  const id = kind.slice('custom:'.length);
  return customTypes.find(t => t.id === id)?.label;
};

export const kindLabel = (kind: string, customTypes: CustomDocType[] = []): string =>
  customLabel(kind, customTypes) ?? KIND_META[kind]?.label ?? kind;

export const kindTone = (kind: string): PillTone =>
  kind.startsWith('custom:') ? 'violet' : (KIND_META[kind]?.tone ?? 'slate');

// Client-side mirror of server/files.ts's DIRECT_UPLOAD_KINDS/isDirectUploadKind
// (kept in sync by hand — the server module can't be imported into the client
// bundle). These are the only kinds a person can pick in the upload popup or
// re-type a file into via "Change type", and the only ones a file may ever be
// deleted outright (see documentsPolicy.ts).
export const DIRECT_UPLOAD_KINDS = ['document', 'spreadsheet', 'photo', 'other', 'company-document'] as const;

// Client mirror of server/documents.ts's DELETABLE_GENERATED_KINDS: generated
// documents with no owning record, so they are deletable (and shareable)
// straight from the Documents page even though they carry a sourceType.
export const DELETABLE_GENERATED_KINDS = ['takeoff-print', 'takeoff-export'] as const;

export const isDeletableGeneratedKind = (kind: string): boolean =>
  (DELETABLE_GENERATED_KINDS as readonly string[]).includes(kind);

export const isDirectUploadKind = (kind: string): boolean =>
  (DIRECT_UPLOAD_KINDS as readonly string[]).includes(kind) || kind.startsWith('custom:');

// The option list every "Change type" control offers (row context menu +
// bulk bar): the direct-upload kinds, then the admin-defined custom types.
// One builder so the two menus can never drift apart.
export const retypeOptions = (customTypes: CustomDocType[]): { id: string; label: string }[] => [
  ...DIRECT_UPLOAD_KINDS.map(k => ({ id: k, label: kindLabel(k) })),
  ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label })),
];
