import { getAuthHeaders } from './store';
import { composePageName } from './sheetNaming';

export interface SheetRead {
  sheetNumber: string;
  sheetTitle: string;
  discipline?: string;
  confidence: number;
  /** Claude's notes on this set's layout, passed to its next reads. */
  setNotes?: string;
}

/** What earlier reads of a set taught, sent with each later read of it. */
export interface SetContext { notes?: string; sheets: Array<{ number: string; title: string }>; }

/** Remembers one scan's reads so each later page is read knowing the set's
 *  layout and the sheets before it. A cover or other odd sheet brings back
 *  empty notes, which leave the last useful ones in place. */
export function createSetMemory() {
  let notes = '';
  const sheets: SetContext['sheets'] = [];
  return {
    context(): SetContext | undefined {
      return notes || sheets.length ? { notes: notes || undefined, sheets: sheets.slice(-40) } : undefined;
    },
    learn(read: SheetRead): void {
      if (read.setNotes?.trim()) notes = read.setNotes.trim();
      if (read.sheetNumber || read.sheetTitle) sheets.push({ number: read.sheetNumber, title: read.sheetTitle });
    },
  };
}
export interface SheetMatch { matchSheetId: string | null; confidence: number; reason?: string; }
export interface AiStatus {
  available: boolean;
  model: string;
  device: string;
  state?: 'off' | 'idle' | 'loading' | 'ready';
  provider?: 'claude';
  /** Why the last Claude call failed (sign-in, usage limit, …), if it did. */
  lastError?: { code: string; message: string; at: string } | null;
}
export interface ExistingSheetRef { sheetId: string; number: string; title: string; }

export type AiScanPhase = 'loading' | 'scanning' | 'done';
export interface AiScanProgress { phase: AiScanPhase; done?: number; total?: number; }

/** The full-size images Claude reads a page from: the whole sheet, and the
 *  sheet in quarters at twice the detail (see utils/pdf.ts AiSheetImages). */
export interface AiPageImages { page: string; details: string[]; }

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
  // Short-lived cache: a stale "unavailable" (cached before an admin connected
  // Claude) must not stick, or the AI Scan would keep saying "not connected".
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

/** The last AI call's failure, in words for the person (null after a success). */
let lastAiError: string | null = null;
export function getLastAiError(): string | null { return lastAiError; }

async function postAi<T>(path: string, input: unknown): Promise<T | null> {
  try {
    const res = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      lastAiError = res.status === 503
        ? 'Claude is not connected. An admin can connect it in Settings › User Preferences.'
        : (body?.error || `AI request failed (${res.status}).`);
      return null;
    }
    lastAiError = null;
    return body as T;
  } catch {
    lastAiError = 'Could not reach the server.';
    return null;
  }
}

export function readSheet(input: { imageId?: string; imageBase64?: string; detailBase64s?: string[]; layoutText?: string; embeddedText?: string; setContext?: SetContext }): Promise<SheetRead | null> {
  return postAi<SheetRead>('/api/ai/read-sheet', input);
}

export function matchSheet(input: { page: SheetRead; existingSheets: ExistingSheetRef[] }): Promise<SheetMatch | null> {
  return postAi<SheetMatch>('/api/ai/match-sheet', input);
}

export interface TranscribeResult { text: string; confidence: number; }

/** Read a small cropped region (a page-number or description box) with Claude.
 *  Used by the naming modal's AI engine toggle as an alternative to the
 *  Text/OCR extract path for a single user-drawn region. */
export function transcribeRegion(input: { imageBase64: string; mode: 'number' | 'description' }): Promise<TranscribeResult | null> {
  return postAi<TranscribeResult>('/api/ai/transcribe-region', input);
}

/** Says why the AI Scan can't start, or null when Claude is connected. */
export async function aiScanBlocker(): Promise<string | null> {
  const status = await getAiStatus(true);
  return status.available ? null : 'Claude is not connected. An admin can connect it in Settings › User Preferences; meanwhile, name pages with Extract (text/OCR).';
}

/** One toast-ready line for the end of an AI Scan. When reads failed, it says
 *  why (sign-in, usage limit, …) and that the pages keep their current names. */
export function aiScanSummary(hits: number, total: number, noImage = 0): { message: string; type: 'success' | 'warning' | 'error' } {
  const pages = `${total} page${total === 1 ? '' : 's'}`;
  if (hits === total) return { message: `Claude read ${hits} of ${pages}.`, type: 'success' };
  const missing = noImage ? ` ${noImage} page${noImage === 1 ? ' has' : 's have'} no full-size image to send.` : '';
  const why = `${missing}${lastAiError && noImage < total - hits ? ` ${lastAiError}` : ''}`;
  const keep = ' The other pages keep their names; you can use Extract (text/OCR) for them.';
  return { message: `Claude read ${hits} of ${pages}.${why}${hits ? keep : ''}`, type: hits ? 'warning' : 'error' };
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

/** Local per-user toggle; the server's Claude connection is the master switch. */
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

// --- Claude connection (admin only; Settings › User Preferences). The server
// never sends the token or key back — only where it came from and its last 4.

export type ClaudeSource = 'token' | 'apiKey' | 'env' | 'login';
export interface ClaudeModelOption { id: string; label: string; centsPerSheet: number; }
export interface ClaudeConnection {
  connected: boolean;
  source: ClaudeSource | null;
  last4: string | null;
  connectedAt: string | null;
  model: string;
  models: ClaudeModelOption[];
}
export type ClaudeTestResult = { ok: true; model: string } | { ok: false; code: string; error: string };

async function claudeAdmin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/ai/claude${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  statusCache = null; // the connection changed; re-read status next time
  return data as T;
}

export const claudeApi = {
  get: () => claudeAdmin<ClaudeConnection>('GET', ''),
  connect: (kind: 'token' | 'apiKey', secret: string) => claudeAdmin<ClaudeConnection>('PUT', '/credential', { kind, secret }),
  disconnect: () => claudeAdmin<ClaudeConnection>('DELETE', '/credential'),
  setModel: (model: string) => claudeAdmin<ClaudeConnection>('PUT', '/model', { model }),
  test: () => claudeAdmin<ClaudeTestResult>('POST', '/test'),
};
