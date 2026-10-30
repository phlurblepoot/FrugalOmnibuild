import { describe, it, expect } from 'vitest';
import { handleStatus, handleReadSheet, handleMatchSheet, handleWarmup, handleTranscribeRegion, cleanSetContext } from './handlers';
import type { AiRunner, SheetRead, SheetMatch, TranscribeResult } from './types';

const okRead: SheetRead = { sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', confidence: 0.9 };
const okMatch: SheetMatch = { matchSheetId: 's2', confidence: 0.8 };
const okTranscribe: TranscribeResult = { text: 'A-101', confidence: 0.85 };

const fakeRunner = (over: Partial<AiRunner> = {}): AiRunner => ({
  configured: () => true,
  state: () => Promise.resolve('ready'),
  warmup: () => {},
  info: () => ({ model: 'fake', device: 'cloud' }),
  readSheet: () => Promise.resolve(okRead),
  matchSheet: () => Promise.resolve(okMatch),
  transcribeRegion: () => Promise.resolve(okTranscribe),
  ...over,
});

const loadImage = (id: string) => (id === 'img1' ? Buffer.from('jpeg') : null);

describe('handleStatus', () => {
  it('reports availability + info + ready state', async () => {
    expect(await handleStatus(fakeRunner())).toEqual({ status: 200, body: { available: true, state: 'ready', model: 'fake', device: 'cloud', provider: 'claude', lastError: null } });
  });
  it('reports idle state when configured but not yet loaded', async () => {
    const r = await handleStatus(fakeRunner({ state: () => Promise.resolve('idle') }));
    expect(r.body).toMatchObject({ available: true, state: 'idle' });
  });
  it('reports "off" when the runner is disabled (configured false)', async () => {
    const r = await handleStatus(fakeRunner({ configured: () => false, state: () => Promise.resolve('off') }));
    expect(r.body).toMatchObject({ available: false, state: 'off' });
  });
});

describe('handleReadSheet', () => {
  it('503 when runner not configured', async () => {
    const r = await handleReadSheet(fakeRunner({ configured: () => false }), loadImage, { imageId: 'img1' });
    expect(r.status).toBe(503);
  });
  it('reads from a stored imageId', async () => {
    const r = await handleReadSheet(fakeRunner(), loadImage, { imageId: 'img1', embeddedText: 'x' });
    expect(r).toEqual({ status: 200, body: okRead });
  });
  it('reads from inline base64 when no id', async () => {
    const b64 = Buffer.from('jpeg').toString('base64');
    const r = await handleReadSheet(fakeRunner(), loadImage, { imageBase64: `data:image/jpeg;base64,${b64}` });
    expect(r.status).toBe(200);
  });
  it('400 when neither image source is provided', async () => {
    const r = await handleReadSheet(fakeRunner(), loadImage, {});
    expect(r.status).toBe(400);
  });
  it('404 when the imageId is unknown', async () => {
    const r = await handleReadSheet(fakeRunner(), loadImage, { imageId: 'nope' });
    expect(r.status).toBe(404);
  });
  it('passes up to four detail images, the layout text and a cleaned set context along', async () => {
    let got: any;
    const runner = fakeRunner({ readSheet: (input) => { got = input; return Promise.resolve(okRead); } });
    const b64 = (t: string) => Buffer.from(t).toString('base64');
    await handleReadSheet(runner, loadImage, {
      imageId: 'img1',
      detailBase64s: [b64('q1'), b64('q2'), 42 as any, b64('q3'), b64('q4'), b64('q5')],
      layoutText: '[x 50%, y 90%, size 30] A-1',
      setContext: { notes: '  right strip  ', sheets: [{ number: 'A-1', title: 'Plan' }, { nope: true }, 'x'] },
    });
    expect(got.details.map((d: Buffer) => d.toString())).toEqual(['q1', 'q2', 'q3']);
    expect(got.layoutText).toBe('[x 50%, y 90%, size 30] A-1');
    expect(got.setContext).toEqual({ notes: 'right strip', sheets: [{ number: 'A-1', title: 'Plan' }] });
  });
  it('502 with the runner\'s message and code when Claude fails', async () => {
    const err = Object.assign(new Error('Claude usage or rate limit reached.'), { code: 'rate_limit' });
    const r = await handleReadSheet(fakeRunner({ readSheet: () => Promise.reject(err) }), loadImage, { imageId: 'img1' });
    expect(r).toEqual({ status: 502, body: { error: 'Claude usage or rate limit reached.', code: 'rate_limit' } });
  });
  it('502 when the model throws', async () => {
    const r = await handleReadSheet(fakeRunner({ readSheet: () => Promise.reject(new Error('boom')) }), loadImage, { imageId: 'img1' });
    expect(r.status).toBe(502);
  });
});

describe('handleMatchSheet', () => {
  it('503 when not configured', async () => {
    const r = await handleMatchSheet(fakeRunner({ configured: () => false }), { page: okRead, existingSheets: [] });
    expect(r.status).toBe(503);
  });
  it('400 when page missing', async () => {
    const r = await handleMatchSheet(fakeRunner(), { existingSheets: [] } as any);
    expect(r.status).toBe(400);
  });
  it('returns the match', async () => {
    const r = await handleMatchSheet(fakeRunner(), { page: okRead, existingSheets: [{ sheetId: 's2', number: 'A-201', title: 'x' }] });
    expect(r).toEqual({ status: 200, body: okMatch });
  });
});

describe('handleTranscribeRegion', () => {
  const b64 = Buffer.from('jpeg').toString('base64');

  it('503 when runner not configured', async () => {
    const r = await handleTranscribeRegion(fakeRunner({ configured: () => false }), { imageBase64: b64, mode: 'number' });
    expect(r.status).toBe(503);
  });
  it('400 when imageBase64 missing', async () => {
    const r = await handleTranscribeRegion(fakeRunner(), { mode: 'number' });
    expect(r.status).toBe(400);
  });
  it('400 when imageBase64 undecodable', async () => {
    // '!!!' is truthy (so it doesn't short-circuit on the missing-imageBase64
    // guard) but contains no valid base64 characters, decoding to an empty
    // Buffer — this exercises the actual "bad imageBase64" 400 branch.
    const r = await handleTranscribeRegion(fakeRunner(), { imageBase64: '!!!', mode: 'number' });
    expect(r.status).toBe(400);
  });
  it("400 when mode is not 'number'/'description'", async () => {
    const r = await handleTranscribeRegion(fakeRunner(), { imageBase64: b64, mode: 'bogus' as any });
    expect(r.status).toBe(400);
  });
  it('200 happy path passes decoded Buffer + mode to the runner and returns its result', async () => {
    let seen: any = null;
    const runner = fakeRunner({ transcribeRegion: (input) => { seen = input; return Promise.resolve(okTranscribe); } });
    const r = await handleTranscribeRegion(runner, { imageBase64: b64, mode: 'description' });
    expect(r).toEqual({ status: 200, body: okTranscribe });
    expect(seen.mode).toBe('description');
    expect(Buffer.isBuffer(seen.image)).toBe(true);
    expect(seen.image.toString()).toBe('jpeg');
  });
  it('502 when the runner throws', async () => {
    const r = await handleTranscribeRegion(fakeRunner({ transcribeRegion: () => Promise.reject(new Error('boom')) }), { imageBase64: b64, mode: 'number' });
    expect(r.status).toBe(502);
  });
});

describe('handleWarmup', () => {
  it('calls warmup and returns ok + state', async () => {
    let warmedUp = false;
    const runner = fakeRunner({ warmup: () => { warmedUp = true; } });
    const r = await handleWarmup(runner, { idleTimeoutMs: 60000 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, state: 'ready' });
    expect(warmedUp).toBe(true);
  });
  it('503 when not configured', async () => {
    const r = await handleWarmup(fakeRunner({ configured: () => false }), {});
    expect(r.status).toBe(503);
  });
});

describe('cleanSetContext', () => {
  it('drops anything malformed and caps sizes', () => {
    expect(cleanSetContext(undefined)).toBeUndefined();
    expect(cleanSetContext('notes')).toBeUndefined();
    expect(cleanSetContext({ notes: '   ', sheets: [] })).toBeUndefined();
    const many = Array.from({ length: 60 }, (_, i) => ({ number: `A-${i}`, title: 'x'.repeat(300) }));
    const c = cleanSetContext({ notes: 'n'.repeat(5000), sheets: many })!;
    expect(c.notes).toHaveLength(1000);
    expect(c.sheets).toHaveLength(40);
    expect(c.sheets![0].number).toBe('A-20');
    expect(c.sheets![0].title).toHaveLength(100);
  });
});
