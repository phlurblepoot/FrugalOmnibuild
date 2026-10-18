// src/pages/documents/documentsPolicy.ts
// Pure selection-policy helper for the Documents page's bulk bar and per-row
// actions. Client-side mirror of the server guards in server/documents.ts
// (patchDocument/deleteDocument, spec §Safe deletion tiers) — every action
// still re-validates server-side, this only decides what the UI *offers*.
//
// `deletable` needs "no sourceType" (spec: "!sourceType && direct-upload
// kind"), but the /api/documents response (DocumentRow) never exposes the
// raw sourceType/sourceId — only the resolved `source` object built from
// them. `row.source` is non-null exactly when sourceType+sourceId were both
// set AND resolveSources() recognizes the sourceType (see server/documents.ts
// SIMPLE_RESOLVERS + resolvePrintouts/resolvePunch), which today covers every
// value in the canonical sourceType vocabulary — so `!row.source` is a safe
// proxy for `!sourceType`. A future sourceType added without a matching
// resolver would (harmlessly) make its rows look deletable here; the DELETE
// call would still 409 server-side since deleteDocument checks the raw
// sourceType column directly.
import { DocumentRow } from '../../utils/store';
import { isDeletableGeneratedKind, isDirectUploadKind } from './docTypes';

export interface SelectionPolicy {
  downloadable: DocumentRow[];
  archivable: DocumentRow[];
  deletable: DocumentRow[];
  // Rows whose kind may be changed via "Change type" (row menu + bulk bar):
  // direct-upload kinds only — the server (patchDocument) refuses re-typing
  // into or out of a system kind, so those are never offered or sent.
  retypeable: DocumentRow[];
}

// A document saved out of an email is a COPY of an attachment the message
// still holds (server/files.ts CONTAINER_SOURCE_TYPES), so it's deletable
// when its kind is one a person could have picked on save — the
// direct-upload kinds or the 'email-attachment' default. Mirrors
// server/documents.ts isContainerCopy; a system kind (rfi, invoice, …)
// under the same source keeps the generated-document rule.
const CONTAINER_SOURCE_TYPES = ['mailMessage'] as const;
const isContainerCopy = (r: DocumentRow): boolean =>
  !!r.source
  && (CONTAINER_SOURCE_TYPES as readonly string[]).includes(r.source.type)
  && (isDirectUploadKind(r.kind) || r.kind === 'email-attachment');

// plan-source rows are view-only (spec: "managed in plan-set management") —
// the server doesn't block archiving them (nothing about plan-source is
// special in patchDocument), so this exclusion is enforced here only.
export const selectionPolicy = (rows: DocumentRow[]): SelectionPolicy => ({
  downloadable: rows,
  archivable: rows.filter(r => r.kind !== 'plan-source'),
  // Takeoff prints/exports are generated (so they always have a `source`) but
  // no record owns them — there is nowhere else to delete them from, so they
  // are deletable here. Mirrors server/documents.ts DELETABLE_GENERATED_KINDS.
  deletable: rows.filter(r =>
    (!r.source && isDirectUploadKind(r.kind)) || isDeletableGeneratedKind(r.kind) || isContainerCopy(r)
  ),
  retypeable: rows.filter(r => isDirectUploadKind(r.kind)),
});
