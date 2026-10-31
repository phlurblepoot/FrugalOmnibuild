import { Project, ProjectPage, PlanSet } from '../types';

// Normalized sheet identity. Pages with the same (trimmed, lower-cased) page
// number across different plan sets are treated as revisions of one sheet.
export const sheetKey = (page: ProjectPage): string | null => {
  const n = page.pageNumber?.trim().toLowerCase();
  return n ? n : null;
};

// Durable logical-sheet identity used to group revisions. Prefers the explicit
// sheetId (backfilled by the migration); otherwise falls back to a stable key
// derived from the page number, else the page's own id (an un-keyed page is its
// own single-revision sheet). Unlike sheetKey, this NEVER returns null so every
// page belongs to exactly one logical sheet.
export const effectiveSheetId = (p: ProjectPage): string =>
  p.sheetId || (p.pageNumber?.trim().toLowerCase() ? 'pn:' + p.pageNumber.trim().toLowerCase() : 'id:' + p.id);

// Plan sets ordered oldest -> newest. Dates (ISO yyyy-mm-dd) sort
// lexicographically; createdAt breaks ties or fills in for undated sets.
export const comparePlanSets = (a: PlanSet, b: PlanSet): number => {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.createdAt - b.createdAt;
};

export const orderedPlanSets = (project: Project | null): PlanSet[] =>
  [...(project?.planSets || [])].sort(comparePlanSets);

// The sets visible "as of" a selection: the chosen set plus every older one.
// With no selection, every set is allowed.
export const allowedPlanSets = (project: Project | null, selectedPlanSetId: string): PlanSet[] => {
  const all = project?.planSets || [];
  if (!selectedPlanSetId) return all;
  const selected = all.find(ps => ps.id === selectedPlanSetId);
  if (!selected) return all;
  return all.filter(ps => comparePlanSets(ps, selected) <= 0);
};

export type RevisionStatus = 'unique' | 'current' | 'superseded';

export interface RevisionModel {
  // Pages to show after as-of filtering + revision dedup (newest sheet wins).
  visiblePages: ProjectPage[];
  // Ids of the pages in visiblePages (the current revision for the selection).
  currentPageIds: Set<string>;
  // Every revision of each sheet across ALL sets, oldest -> newest.
  revisionsBySheet: Map<string, ProjectPage[]>;
  // 1-based revision number of a page within its sheet's full history.
  revisionNumberByPageId: Map<string, number>;
  // Globally newest page id for each sheet (ignores the as-of selection).
  latestPageIdBySheet: Map<string, string>;
  status: (pageId: string) => RevisionStatus;
}

const planSetIndex = (project: Project | null): Map<string, number> => {
  const idx = new Map<string, number>();
  orderedPlanSets(project).forEach((ps, i) => idx.set(ps.id, i));
  return idx;
};

// Single source of truth for plan-set revision behavior, shared by the pages
// grid, takeoff totals, the revision strip, and the compare view.
export const computeRevisionModel = (project: Project | null, selectedPlanSetId: string): RevisionModel => {
  const empty: RevisionModel = {
    visiblePages: [],
    currentPageIds: new Set(),
    revisionsBySheet: new Map(),
    revisionNumberByPageId: new Map(),
    latestPageIdBySheet: new Map(),
    status: () => 'unique',
  };
  if (!project) return empty;

  const order = planSetIndex(project);
  const setOrder = (page: ProjectPage) => (page.planSetId ? order.get(page.planSetId) ?? -1 : -1);

  // Full revision history per sheet (keyed by durable sheetId), oldest -> newest.
  // Every page belongs to exactly one logical sheet (effectiveSheetId never null).
  const revisionsBySheet = new Map<string, ProjectPage[]>();
  for (const page of project.pages) {
    const key = effectiveSheetId(page);
    const list = revisionsBySheet.get(key) || [];
    list.push(page);
    revisionsBySheet.set(key, list);
  }
  const revisionNumberByPageId = new Map<string, number>();
  const latestPageIdBySheet = new Map<string, string>();
  for (const [key, pages] of revisionsBySheet) {
    pages.sort((a, b) => setOrder(a) - setOrder(b));
    pages.forEach((p, i) => revisionNumberByPageId.set(p.id, i + 1));
    latestPageIdBySheet.set(key, pages[pages.length - 1].id);
  }

  // As-of filtering: a page is allowed when it has no plan set (always allowed)
  // or its plan set is in the allowed (selected + older) window.
  const allowedIds = new Set(allowedPlanSets(project, selectedPlanSetId).map(ps => ps.id));
  const isAllowed = (page: ProjectPage) => !page.planSetId || allowedIds.has(page.planSetId);

  // Current page per sheet = the newest revision whose plan set is allowed by the
  // as-of selection; if none of the sheet's revisions are allowed, fall back to
  // the newest revision overall (so the sheet still surfaces). Revisions are
  // ordered oldest -> newest above, so the last allowed entry is the newest.
  const visiblePages: ProjectPage[] = [];
  for (const pages of revisionsBySheet.values()) {
    let current: ProjectPage | undefined;
    for (const p of pages) if (isAllowed(p)) current = p;
    if (!current) current = pages[pages.length - 1];
    if (current) visiblePages.push(current);
  }
  const currentPageIds = new Set(visiblePages.map(p => p.id));

  const status = (pageId: string): RevisionStatus => {
    const page = project.pages.find(p => p.id === pageId);
    if (!page) return 'unique';
    const key = effectiveSheetId(page);
    const revs = revisionsBySheet.get(key) || [];
    if (revs.length <= 1) return 'unique';
    return latestPageIdBySheet.get(key) === pageId ? 'current' : 'superseded';
  };

  return { visiblePages, currentPageIds, revisionsBySheet, revisionNumberByPageId, latestPageIdBySheet, status };
};

// Build the measurements + scale to seed a NEW revision of a sheet from its
// current living page. Returns fresh-id copies of every measurement (the caller
// assigns them to the new page) plus cloned scale calibration so the new
// revision starts populated and never empty. The source (prior) page keeps its
// own measurements — it becomes positionally superseded → read-only history.
export function carryForwardFrom(currentPage: ProjectPage, newId: () => string) {
  return {
    measurements: currentPage.measurements.map(m => ({
      ...m,
      id: newId(),
      segments: m.segments ? m.segments.map(s => ({ ...s })) : m.segments,
    })),
    scaleConfig: currentPage.scaleConfig ? { ...currentPage.scaleConfig } : null,
    scaleRegions: currentPage.scaleRegions ? currentPage.scaleRegions.map(r => ({ ...r })) : currentPage.scaleRegions,
    isMultiRegion: currentPage.isMultiRegion,
  };
}

// Summary of what a plan set introduced relative to earlier sets: how many
// sheet numbers are brand new vs. revisions of an existing sheet.
export const summarizePlanSet = (project: Project | null, setId: string): { newCount: number; revisedCount: number; total: number } => {
  if (!project) return { newCount: 0, revisedCount: 0, total: 0 };
  const order = planSetIndex(project);
  const thisOrder = order.get(setId) ?? -1;
  const earlierSheets = new Set<string>();
  for (const page of project.pages) {
    const key = sheetKey(page);
    if (!key || !page.planSetId) continue;
    if ((order.get(page.planSetId) ?? -1) < thisOrder) earlierSheets.add(key);
  }
  let newCount = 0;
  let revisedCount = 0;
  const seen = new Set<string>();
  for (const page of project.pages) {
    if (page.planSetId !== setId) continue;
    const key = sheetKey(page);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (earlierSheets.has(key)) revisedCount++; else newCount++;
  }
  return { newCount, revisedCount, total: seen.size };
};

export interface MoveToSheetOptions {
  /** Replace the page's takeoffs with a copy of the target sheet's current
   *  revision's (only applied when the page becomes the target's newest). */
  replaceTakeoffs?: boolean;
}

/**
 * Fixes a wrong sheet match: makes `pageId` a revision of the sheet `target`
 * (an effectiveSheetId), or, with `target` null, its own separate sheet.
 * A legacy target sheet (grouped by page number, no stored sheetId) gets a
 * real sheetId stamped on all its pages first so the grouping is durable.
 * Takeoffs stay with the page unless `replaceTakeoffs` asks for a copy of the
 * target's current revision (what uploading it as a revision would have done).
 */
export function moveToSheet(
  project: Project,
  pageId: string,
  target: string | null,
  newId: () => string,
  opts: MoveToSheetOptions = {},
): Project {
  const page = project.pages.find(p => p.id === pageId);
  if (!page) return project;
  if (target === null) {
    return { ...project, pages: project.pages.map(p => (p.id === pageId ? { ...p, sheetId: newId() } : p)) };
  }
  if (target === effectiveSheetId(page)) return project;

  const others = project.pages.filter(p => p.id !== pageId);
  const model = computeRevisionModel({ ...project, pages: others }, '');
  const targetPages = model.revisionsBySheet.get(target) || [];
  if (!targetPages.length) return project;
  const realId = targetPages.find(p => p.sheetId)?.sheetId || (target.startsWith('pn:') || target.startsWith('id:') ? newId() : target);
  const targetIds = new Set(targetPages.map(p => p.id));

  // The target's current revision, before this page joins it.
  const source = targetPages[targetPages.length - 1];
  const order = planSetIndex(project);
  const rank = (p: ProjectPage) => (p.planSetId ? order.get(p.planSetId) ?? -1 : -1);
  const becomesNewest = rank(page) >= rank(source);
  const copy = opts.replaceTakeoffs && becomesNewest ? carryForwardFrom(source, newId) : null;

  return {
    ...project,
    pages: project.pages.map(p => {
      if (p.id === pageId) {
        return copy
          ? { ...p, sheetId: realId, measurements: copy.measurements, scaleConfig: copy.scaleConfig, scaleRegions: copy.scaleRegions, isMultiRegion: copy.isMultiRegion }
          : { ...p, sheetId: realId };
      }
      if (targetIds.has(p.id) && p.sheetId !== realId) return { ...p, sheetId: realId };
      return p;
    }),
  };
}

/** Whether `pageId` would be the newest revision of sheet `target` if moved there. */
export function wouldBeNewestIn(project: Project, pageId: string, target: string): boolean {
  const page = project.pages.find(p => p.id === pageId);
  if (!page) return false;
  const model = computeRevisionModel({ ...project, pages: project.pages.filter(p => p.id !== pageId) }, '');
  const pages = model.revisionsBySheet.get(target) || [];
  if (!pages.length) return true;
  const order = planSetIndex(project);
  const rank = (p: ProjectPage) => (p.planSetId ? order.get(p.planSetId) ?? -1 : -1);
  return rank(page) >= rank(pages[pages.length - 1]);
}
