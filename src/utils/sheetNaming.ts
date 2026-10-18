export interface NumberedRow { id: string; planSetId?: string; pageNumber?: string | null; }
const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();

/** Ids of rows whose page number collides with another row in the SAME plan set.
 *  Blank page numbers are exempt. */
export function findDuplicatePageNumbers(rows: NumberedRow[]): string[] {
  const seen = new Map<string, string[]>(); // `${set} ${num}` -> ids
  for (const r of rows) {
    const num = norm(r.pageNumber);
    if (!num) continue;
    const key = (r.planSetId ?? '') + ' ' + num;
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(r.id);
  }
  const out: string[] = [];
  for (const ids of seen.values()) if (ids.length > 1) out.push(...ids);
  return out;
}

/** Next free "Base (n)" given a set of already-taken (normalized) page numbers. */
export function suffixPageNumber(base: string, takenNormalized: Set<string>): string {
  let n = 2;
  while (takenNormalized.has(norm(`${base} (${n})`))) n++;
  return `${base} (${n})`;
}

/** First safe placeholder page number to start a batch of new uploads at,
 *  scoped to one plan set. A purely count-based seed (existing page count + 1)
 *  starts too low whenever the set already has gaps or a large numeric page
 *  number: a set holding a single page named "10" seeds the next placeholder
 *  at 2, so a 9-page batch counts 2..10 and the LAST one collides with the
 *  existing "10". Scanning for the actual max numeric page number already in
 *  the set and starting one past it guarantees a fresh placeholder can never
 *  equal an existing number in the set — non-numeric names (e.g. "A-101")
 *  can't collide with a numeric placeholder by construction, so they're
 *  ignored by the scan. */
export function nextPlaceholderStart(pages: NumberedRow[], planSetId?: string): number {
  let max = 0;
  for (const p of pages) {
    if ((p.planSetId ?? undefined) !== (planSetId ?? undefined)) continue;
    const n = (p.pageNumber ?? '').trim();
    if (/^\d+$/.test(n)) {
      const v = parseInt(n, 10);
      if (v > max) max = v;
    }
  }
  return max + 1;
}

/** The one canonical display-name formula: "NUM - DESC", else whichever
 *  part exists, else the fallback. Previously duplicated at 6 call sites. */
export function composePageName(
  pageNumber?: string | null,
  description?: string | null,
  fallback = '',
): string {
  const num = (pageNumber ?? '').trim();
  const desc = (description ?? '').trim();
  return num && desc ? `${num} - ${desc}` : num || desc || fallback;
}
