import { getAuthHeaders, getSettings } from './store';
import { composePageName } from './sheetNaming';

export interface SheetRead { sheetNumber: string; sheetTitle: string; discipline?: string; confidence: number; }
export interface SheetMatch { matchSheetId: string | null; confidence: number; reason?: string; }
export interface AiStatus { available: boolean; model: string; device: string; state?: 'off' | 'idle' | 'loading' | 'ready'; }
export interface ExistingSheetRef { sheetId: string; number: string; title: string; }

export type AiScanPhase = 'loading' | 'scanning' | 'done';
export interface AiScanProgress { phase: AiScanPhase; done?: number; total?: number; }

/** Minimal shape of a review page the apply helpers touch. */
export interface AiPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  detectionConfidence?: 'high' | 'low';
  matchSheetId?: string;
  aiConfidence?: number;
}

let statusCache: AiStatus | null = null;

let statusCacheAt = 0;
const STATUS_TTL_MS = 15000;

export async function getAiStatus(force = false): Promise<AiStatus> {
  // Short-lived cache: a stale "unavailable" (e.g. cached while the model was
  // still loading) must not stick forever, or imports would skip the AI even
  // after it becomes ready. Re-fetch when forced or once the TTL elapses.
  if (statusCache && !force && (Date.now() - statusCacheAt) < STATUS_TTL_MS) return statusCache;
  try {
    const res = await fetch('/api/ai/status', { headers: getAuthHeaders() });
    statusCache = res.ok ? await res.json() : { available: false, model: 'n/a', device: 'none' };
  } catch {
    statusCache = { available: false, model: 'n/a', device: 'none' };
  }
  statusCacheAt = Date.now();
  return statusCache!;
}

export async function warmupAi(idleTimeoutMs?: number): Promise<void> {
  try {
    await fetch('/api/ai/warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ idleTimeoutMs }),
    });
  } catch { /* ignore */ }
}

export async function getAiIdleTimeoutMs(): Promise<number> {
  try {
    const settings = await getSettings();
    const minutes = parseFloat(settings['aiIdleTimeoutMinutes'] ?? '');
    if (!isNaN(minutes)) return minutes * 60000;
  } catch { /* ignore */ }
  return 300000; // default 5 minutes
}

/** Poll until state === 'ready' (true) or 'off' / timeout (false). */
export async function waitForAiReady(onTick?: () => void, timeoutMs = 900000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getAiStatus(true);
    if (status.state === 'ready') return true;
    if (status.state === 'off') return false;
    if (onTick) onTick();
    await new Promise<void>(r => setTimeout(r, 1500));
  }
  return false;
}

export async function readSheet(input: { imageId?: string; imageBase64?: string; embeddedText?: string; idleTimeoutMs?: number }): Promise<SheetRead | null> {
  try {
    const res = await fetch('/api/ai/read-sheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

export async function matchSheet(input: { page: SheetRead; existingSheets: ExistingSheetRef[]; idleTimeoutMs?: number }): Promise<SheetMatch | null> {
  try {
    const res = await fetch('/api/ai/match-sheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

export interface TranscribeResult { text: string; confidence: number; }

/** Read a small cropped region (a page-number or description box) with the
 *  local vision model. Used by the naming modal's AI engine toggle as an
 *  alternative to the Text/OCR extract path for a single user-drawn region. */
export async function transcribeRegion(input: { imageBase64: string; mode: 'number' | 'description'; idleTimeoutMs?: number }): Promise<TranscribeResult | null> {
  try {
    const res = await fetch('/api/ai/transcribe-region', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Run thunks with a bounded concurrency, preserving result order. */
export async function runWithConcurrency<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** Local per-user toggle (server AI_ENABLED is the master switch). */
export function aiAutoNameEnabled(): boolean {
  return localStorage.getItem('aiAutoName') !== 'false';
}
export function setAiAutoNameEnabled(on: boolean): void {
  localStorage.setItem('aiAutoName', on ? 'true' : 'false');
}

/** Apply a read to a page (pure). Empty reads leave the page untouched. */
export function applyReadToPage<T extends AiPage>(page: T, read: SheetRead): T {
  if (!read.sheetNumber && !read.sheetTitle) return page;
  const pageNumber = read.sheetNumber || page.pageNumber || '';
  const description = read.sheetTitle || page.description || '';
  const name = composePageName(pageNumber, description, page.name);
  return {
    ...page,
    pageNumber,
    description,
    name,
    aiConfidence: read.confidence,
    detectionConfidence: read.confidence >= 0.5 && !!read.sheetNumber ? 'high' : 'low',
  };
}

/** Apply a match to a page (pure). Below 0.5 confidence leaves matchSheetId as-is. */
export function applyMatchToPage<T extends AiPage>(page: T, match: SheetMatch): T {
  if (match.confidence < 0.5) return page;
  return { ...page, matchSheetId: match.matchSheetId ?? '' };
}
