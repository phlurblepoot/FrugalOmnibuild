// src/utils/takeoffPrintNames.ts
//
// Naming + navigation helpers for the Takeoffs tab's Print/Excel exports,
// which now save as `takeoff-print` / `takeoff-export` documents (spec
// 2026-08-28-proposal-rework Task 9) instead of appending to the removed
// project.printouts[] list. Shared between ProjectView.tsx (which saves and
// navigates) and ProjectTakeoffsTab.tsx (which renders the "Takeoff prints"
// link) so the name/URL format stays in exactly one place.
// The date is the LOCAL y-m-d, matching proposalFileName (proposalGenerator.ts)
// and migration 28's relabelling — an ISO slice would name a print made after
// 8pm Eastern with tomorrow's date, so two prints from one evening would sort
// and read as if they were made on different days.
export const takeoffPrintName = (projectName: string, kind: 'pdf' | 'excel', when: Date = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return `${kind === 'excel' ? 'Takeoff Export' : 'Takeoff Print'} – ${projectName} – ${date}`;
};

export const takeoffPrintsUrl = (projectId: string) =>
  `/project/${projectId}/documents?kinds=takeoff-print,takeoff-export`;
