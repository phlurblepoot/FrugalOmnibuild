// src/utils/time.ts — shared time helpers. Canonical home for logic that
// used to be duplicated across Dashboard.tsx and several card modules
// (those modules couldn't import Dashboard.tsx without a circular import
// through CardGrid; src/utils has no card imports, so it's cycle-safe).
export const DAY = 86_400_000;

export const timeAgo = (ms: number): string => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
};

// Sunday 00:00 local time of the week containing `now` — the app's weeks
// run Sun–Sat, like the Time Keeping calendar.
export const startOfWeek = (now: Date = new Date()): number => {
  const d = new Date(now);
  const dow = d.getDay(); // Sun=0 … Sat=6
  d.setHours(0, 0, 0, 0);
  return d.getTime() - dow * DAY;
};

export interface TimeEntryLike {
  clockIn: number;
  clockOut: number | null;
}

export const hoursThisWeek = (entries: TimeEntryLike[], now: number = Date.now()): number => {
  const start = startOfWeek(new Date(now));
  let ms = 0;
  for (const e of entries) {
    // An entry is charged to the week it STARTED in (a Sat→Sun overnight
    // shift counts toward last week) — intended for contractor billing.
    if (e.clockIn >= start) ms += (e.clockOut ?? now) - e.clockIn;
  }
  return ms / 3_600_000;
};

// Epoch-ms number or ISO string → locale date string; nullish → em dash.
export const fmtDate = (v: number | string | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  return new Date(v).toLocaleDateString();
};
