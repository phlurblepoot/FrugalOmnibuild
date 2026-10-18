import type Database from 'better-sqlite3';

// Server-side port of the plan-set revision model in src/utils/planSets.ts
// (computeRevisionModel / effectiveSheetId). Lets measurement-mutating ops be
// rejected against a superseded (read-only history) page without loading the
// whole project through the client model.

// Row-level inputs deliberately mirror what a cheap query returns.
export interface PageRow {
  id: string;
  planSetId: string | null;
  pageNumber: string | null;
  attrs: string | null;
}

const normalizePageNumber = (pageNumber: string | null | undefined): string | null => {
  const n = pageNumber?.trim().toLowerCase();
  return n ? n : null;
};

// A plan set's date/createdAt, read out of its attrs JSON (decomposeProject's
// `{id, name, ...rest}` destructure puts everything else — including date and
// createdAt — there). Missing/malformed attrs degrade to no date + createdAt 0.
interface PlanSetOrderFields { date?: string; createdAt: number }

const parsePlanSetOrderFields = (attrsJson: string | null): PlanSetOrderFields => {
  let date: string | undefined;
  let createdAt = 0;
  if (attrsJson) {
    try {
      const parsed = JSON.parse(attrsJson);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.date === 'string' && parsed.date) date = parsed.date;
        if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
      }
    } catch {
      // malformed attrs JSON — fall through to the date-less/createdAt-0 default
    }
  }
  return { date, createdAt };
};

// Same comparator as src/utils/planSets.ts comparePlanSets: order by ISO date
// when both sets have one and they differ, else by createdAt. This must be
// re-derived live from attrs rather than read off the persisted sortOrder
// column: PlanSetManager lets a set's date be edited in place without moving
// it within the array (see ProjectView's plan-set update handler), so after
// such an edit sortOrder alone would go stale relative to the client, which
// re-sorts by this comparator on every read.
const comparePlanSetOrderFields = (a: PlanSetOrderFields, b: PlanSetOrderFields): number => {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.createdAt - b.createdAt;
};

// Durable logical-sheet identity, ported from planSets.ts effectiveSheetId.
// Prefers the explicit sheetId (migration 15 backfill, carried in the page's
// attrs JSON); falls back to a stable key derived from the normalized page
// number; falls back further to the page's own id. Never returns an empty
// key — every page belongs to exactly one logical sheet.
export function effectiveSheetIdFromRow(row: PageRow): string {
  if (row.attrs) {
    try {
      const parsed = JSON.parse(row.attrs);
      if (parsed && typeof parsed === 'object' && typeof parsed.sheetId === 'string' && parsed.sheetId) {
        return parsed.sheetId;
      }
    } catch {
      // malformed attrs JSON — fall through to the pageNumber/id fallback
    }
  }
  const normNum = normalizePageNumber(row.pageNumber);
  return normNum ? 'pn:' + normNum : 'id:' + row.id;
}

// A page is superseded when its logical sheet has more than one revision and
// this page is not the latest. "Latest" mirrors computeRevisionModel: pages
// are grouped by effectiveSheetId, then ordered by their plan set's rank
// (oldest -> newest; a page with no plan set, or one whose plan set can't be
// found, ranks as -1, i.e. oldest) with ties broken by the pages' own query
// order — querying with `ORDER BY sortOrder` mirrors the order the client's
// project.pages array is loaded in (see loadProject), so a stable JS sort on
// top reproduces the client's tie-break exactly. The last page in that
// ordering is the current/living revision; every earlier one is superseded.
export function isPageSuperseded(db: Database.Database, projectId: string, pageId: string): boolean {
  // Rank plan sets the same way orderedPlanSets/comparePlanSets does on the
  // client: sort by date/createdAt, falling back to the persisted sortOrder
  // (the DB load order, same role as the client's un-sorted planSets array)
  // as the stable tie-break.
  const planSetRows = db
    .prepare('SELECT id, attrs FROM plan_sets WHERE projectId = ? ORDER BY sortOrder')
    .all(projectId) as { id: string; attrs: string | null }[];
  const orderedPlanSetIds = planSetRows
    .map(ps => ({ id: ps.id, ...parsePlanSetOrderFields(ps.attrs) }))
    .sort(comparePlanSetOrderFields)
    .map(ps => ps.id);
  const rankByPlanSetId = new Map<string, number>();
  orderedPlanSetIds.forEach((id, i) => rankByPlanSetId.set(id, i));

  const pageRows = db
    .prepare('SELECT id, planSetId, pageNumber, attrs FROM pages WHERE projectId = ? ORDER BY sortOrder')
    .all(projectId) as PageRow[];

  const target = pageRows.find(r => r.id === pageId);
  if (!target) return false;

  const setOrder = (row: PageRow): number => (row.planSetId ? rankByPlanSetId.get(row.planSetId) ?? -1 : -1);

  const key = effectiveSheetIdFromRow(target);
  const revisions = pageRows.filter(r => effectiveSheetIdFromRow(r) === key);
  if (revisions.length <= 1) return false;

  const sorted = [...revisions].sort((a, b) => setOrder(a) - setOrder(b));
  const latestId = sorted[sorted.length - 1].id;
  return latestId !== pageId;
}
