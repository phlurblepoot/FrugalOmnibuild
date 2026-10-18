// Pure presence helpers shared by the online list, canvas sidebar, follow
// pill, and page-viewer dots. Render-free by design.
import type { SessionView } from '../context/CollaborationContext';

export interface UserGroup {
  userId: string;
  name: string;
  color: string;
  isMe: boolean;
  sessions: SessionView[];
}

export function groupSessionsByUser(sessions: SessionView[], mySessionId: string | null): UserGroup[] {
  const byUser = new Map<string, SessionView[]>();
  let myUserId: string | null = null;
  for (const s of sessions) {
    if (s.sessionId === mySessionId) { myUserId = s.userId; continue; }
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }
  const groups: UserGroup[] = [];
  for (const [userId, list] of byUser) {
    groups.push({
      userId,
      name: list[0].name,
      color: list[0].color,
      isMe: userId === myUserId,
      sessions: list,
    });
  }
  groups.sort((a, b) => (a.isMe === b.isMe ? a.name.localeCompare(b.name) : a.isMe ? 1 : -1));
  return groups;
}

const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview', takeoff: 'Takeoff', page: 'Canvas', billing: 'Billing',
  issues: 'Issues', rfis: 'RFIs', punch: 'Punch List', notes: 'Notes',
  time: 'Time', proposal: 'Proposal', settings: 'Settings', documents: 'Documents',
};

export function humanizeSection(section: string | undefined): string {
  if (!section) return 'Overview';
  return SECTION_LABELS[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

const PATH_LABELS: [RegExp, string][] = [
  [/^\/dashboard$/, 'Dashboard'], [/^\/projects$/, 'Projects'], [/^\/tasks$/, 'Tasks'],
  [/^\/documents$/, 'Documents'], [/^\/customers(\/|$)/, 'Customers'], [/^\/time$/, 'Time'],
  [/^\/settings$/, 'Settings'], [/^\/tools\/edit$/, 'Document editor'],
];

export function describeLocation(
  location: SessionView['location'],
  projectNames: Record<string, string>,
): string {
  if (!location) return 'Online';
  if (location.projectId) {
    const project = projectNames[location.projectId] ?? 'A project';
    if (location.pageId) return `${project} · ${location.label || 'Canvas'}`;
    return `${project} · ${humanizeSection(location.section)}`;
  }
  for (const [re, label] of PATH_LABELS) if (re.test(location.path)) return label;
  return 'Online';
}

// ─────────────────────────────────────────────────────────────────────────
// Canvas remote-cursor smoothing (PdfCanvas). Pure math only — the rAF loop
// and Konva ref plumbing live in PdfCanvas.tsx itself.
// ─────────────────────────────────────────────────────────────────────────

/** One animation frame of exponential-ish easing of a scalar toward
 * `target`. Snaps to the exact target once the remaining gap is under
 * `snapDistance`, so a cursor (or an opacity fade) settles instead of
 * creeping asymptotically forever. */
export function lerp1D(current: number, target: number, factor = 0.25, snapDistance = 0.5): number {
  const delta = target - current;
  if (Math.abs(delta) < snapDistance) return target;
  return current + delta * factor;
}

/** One animation frame of easing a 2D point toward `target` (see lerp1D).
 * Used to smooth remote presence cursors so they glide between the network's
 * throttled cursor-move samples instead of teleporting frame to frame. */
export function lerpStep(
  current: { x: number; y: number },
  target: { x: number; y: number },
  factor = 0.25,
  snapDistance = 0.5,
): { x: number; y: number } {
  return {
    x: lerp1D(current.x, target.x, factor, snapDistance),
    y: lerp1D(current.y, target.y, factor, snapDistance),
  };
}

/** A remote cursor is considered idle once its session has gone quiet for
 * longer than `thresholdMs` (default 30s) — used to fade it out on canvas.
 * Undefined `lastActive` (older/legacy session shape) is treated as active
 * so a missing timestamp never wrongly hides a live cursor. */
export function isCursorIdle(lastActive: number | undefined, now: number, thresholdMs = 30_000): boolean {
  if (lastActive == null) return false;
  return now - lastActive > thresholdMs;
}
