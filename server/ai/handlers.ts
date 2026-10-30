import type { AiRunner, ExistingSheetRef, SheetRead, SetContext } from './types';

export interface HandlerResult { status: number; body: unknown; }

/** Loader maps an image id to its bytes on disk (null if missing). */
export type ImageLoader = (id: string) => Buffer | null;

export async function handleStatus(runner: AiRunner): Promise<HandlerResult> {
  const state = await runner.state();
  const info = runner.info();
  return {
    status: 200,
    body: {
      available: runner.configured(), state, model: info.model, device: info.device,
      provider: 'claude', lastError: runner.lastError?.() ?? null,
    },
  };
}

/** A failed call: 502 with the runner's plain-words message and its code. */
function failure(e: any): HandlerResult {
  return { status: 502, body: { error: String(e?.message ?? e), code: e?.code ?? 'other' } };
}

/** The set context as sent by the browser, trimmed to sane sizes; anything
 *  malformed is dropped rather than refused. */
export function cleanSetContext(raw: unknown): SetContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { notes?: unknown; sheets?: unknown };
  const notes = typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim().slice(0, 1000) : undefined;
  const sheets = (Array.isArray(r.sheets) ? r.sheets : [])
    .filter((x): x is { number: unknown; title: unknown } => !!x && typeof x === 'object')
    .map(x => ({
      number: typeof x.number === 'string' ? x.number.trim().slice(0, 40) : '',
      title: typeof x.title === 'string' ? x.title.trim().slice(0, 100) : '',
    }))
    .filter(x => x.number || x.title)
    .slice(-40);
  return notes || sheets.length ? { notes, sheets } : undefined;
}

function decodeBase64Image(input: string): Buffer | null {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  try { const buf = Buffer.from(b64, 'base64'); return buf.length ? buf : null; } catch { return null; }
}

export async function handleReadSheet(
  runner: AiRunner,
  loadImage: ImageLoader,
  body: { imageId?: string; imageBase64?: string; detailBase64s?: string[]; layoutText?: string; embeddedText?: string; setContext?: unknown; prompt?: string; idleTimeoutMs?: number },
): Promise<HandlerResult> {
  if (!runner.configured()) return { status: 503, body: { error: 'ai unavailable' } };

  let image: Buffer | null = null;
  if (body.imageId) {
    image = loadImage(body.imageId);
    if (!image) return { status: 404, body: { error: 'image not found' } };
  } else if (body.imageBase64) {
    image = decodeBase64Image(body.imageBase64);
    if (!image) return { status: 400, body: { error: 'bad imageBase64' } };
  } else {
    return { status: 400, body: { error: 'imageId or imageBase64 required' } };
  }

  // At most the four quarters; anything that isn't a base64 image is dropped.
  const details = (Array.isArray(body.detailBase64s) ? body.detailBase64s : [])
    .slice(0, 4)
    .map(d => (typeof d === 'string' ? decodeBase64Image(d) : null))
    .filter((d): d is Buffer => !!d);

  try {
    const layoutText = typeof body.layoutText === 'string' ? body.layoutText : undefined;
    const setContext = cleanSetContext(body.setContext);
    const read = await runner.readSheet({ image, details, layoutText, embeddedText: body.embeddedText, setContext, prompt: body.prompt, idleTimeoutMs: body.idleTimeoutMs });
    return { status: 200, body: read };
  } catch (e: any) {
    return failure(e);
  }
}

export async function handleMatchSheet(
  runner: AiRunner,
  body: { page?: SheetRead; existingSheets?: ExistingSheetRef[]; idleTimeoutMs?: number },
): Promise<HandlerResult> {
  if (!runner.configured()) return { status: 503, body: { error: 'ai unavailable' } };
  if (!body.page) return { status: 400, body: { error: 'page required' } };
  const existing = Array.isArray(body.existingSheets) ? body.existingSheets : [];
  try {
    const match = await runner.matchSheet({ page: body.page, existing, idleTimeoutMs: body.idleTimeoutMs });
    return { status: 200, body: match };
  } catch (e: any) {
    return failure(e);
  }
}

export async function handleTranscribeRegion(
  runner: AiRunner,
  body: { imageBase64?: string; mode?: string; idleTimeoutMs?: number },
): Promise<HandlerResult> {
  if (!runner.configured()) return { status: 503, body: { error: 'ai unavailable' } };
  if (body.mode !== 'number' && body.mode !== 'description') {
    return { status: 400, body: { error: "mode must be 'number' or 'description'" } };
  }
  if (!body.imageBase64) return { status: 400, body: { error: 'imageBase64 required' } };
  const image = decodeBase64Image(body.imageBase64);
  if (!image) return { status: 400, body: { error: 'bad imageBase64' } };
  try {
    const result = await runner.transcribeRegion({ image, mode: body.mode, idleTimeoutMs: body.idleTimeoutMs });
    return { status: 200, body: result };
  } catch (e: any) {
    return failure(e);
  }
}

export async function handleWarmup(
  runner: AiRunner,
  body: { idleTimeoutMs?: number },
): Promise<HandlerResult> {
  if (!runner.configured()) return { status: 503, body: { error: 'ai unavailable' } };
  runner.warmup(body.idleTimeoutMs);
  return { status: 200, body: { ok: true, state: await runner.state() } };
}
