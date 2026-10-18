// src/utils/download.ts
// Browser "save this blob to disk" helper. Lived in
// src/pages/documents/DocumentsTable.tsx until DocumentActionsBar needed it
// too (spec docs/superpowers/specs/2026-08-29-document-actions-rollout) —
// DocumentsTable still re-exports it so existing imports keep working.
export const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
