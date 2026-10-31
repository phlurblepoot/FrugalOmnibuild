// The Claude runner with the Agent SDK mocked out: these tests never call Claude.
import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage, SDKUserMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeRunner, classifyClaudeError, imageMediaType, type QueryFn } from './claudeRunner';
import type { ClaudeCredentialStore, ClaudeCredential } from './claudeCredentials';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => { throw new Error('the real SDK must never run in tests'); },
}));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function store(cred: ClaudeCredential | null = { source: 'token', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret' } }): ClaudeCredentialStore {
  return {
    configDir: '/tmp/ft-claude-test',
    resolve: () => cred,
    summary: () => ({ connected: !!cred, source: cred?.source ?? null, last4: null, connectedAt: null, model: 'claude-sonnet-5-5' }),
    setSecret: () => {}, clearSecret: () => {},
    getModel: () => 'claude-sonnet-5-5', setModel: () => {},
  };
}

const result = (text: string): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, result: text } as unknown as SDKMessage);

interface Call { content: any[]; options: Options }
/** A query() stand-in that records what it was sent and yields `reply`. */
function fakeQuery(reply: (call: Call) => SDKMessage[] | Promise<SDKMessage[]>, calls: Call[] = []): QueryFn {
  return async function* ({ prompt, options }) {
    const msgs: SDKUserMessage[] = [];
    for await (const m of prompt) msgs.push(m);
    const call = { content: msgs[0].message.content as any[], options: options! };
    calls.push(call);
    for (const m of await reply(call)) yield m;
  };
}

const READ = '{"sheetNumber":"a-201","sheetTitle":"Second Floor Plan","discipline":"Architectural","confidence":0.9}';

describe('createClaudeRunner', () => {
  it('reads a sheet in one tool-less turn: whole page, its four quarters, then the prompt', async () => {
    const calls: Call[] = [];
    const r = createClaudeRunner({ store: store(), queryFn: fakeQuery(() => [result(READ)], calls), env: { PATH: '/bin', ANTHROPIC_API_KEY: 'stray', HOME: '/root', MAIL_SECRET_KEY: 'mail', JWT_SECRET: 'jwt' } });
    const read = await r.readSheet({
      image: JPEG, details: [PNG, PNG, PNG, PNG], embeddedText: 'A-201 SECOND FLOOR',
      layoutText: '[x 91%, y 96%, turned 90°, size 24] A-201',
      setContext: { notes: 'Number at the foot of the right strip.', sheets: [{ number: 'A-101', title: 'First Floor Plan' }] },
    });
    expect(read).toEqual({ sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', discipline: 'Architectural', confidence: 0.9 });

    const [{ content, options }] = calls;
    expect(content.map(b => b.type)).toEqual(['text', 'image', 'text', 'text', 'image', 'text', 'image', 'text', 'image', 'text', 'image', 'text']);
    expect(content[1].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') });
    expect(content.filter(b => b.type === 'text').map(b => b.text)).toEqual(expect.arrayContaining(['Top-left quarter:', 'Bottom-right quarter:']));
    expect(content[4].source.media_type).toBe('image/png');
    const prompt = content.at(-1).text;
    expect(prompt).toContain('A-201 SECOND FLOOR');
    expect(prompt).toContain('[x 91%, y 96%, turned 90°, size 24] A-201');
    expect(prompt).toContain('Number at the foot of the right strip.');
    expect(prompt).toContain('A-101 First Floor Plan');
    expect(options).toMatchObject({
      model: 'claude-sonnet-5-5', tools: [], settingSources: [], maxTurns: 1, persistSession: false, cwd: '/tmp/ft-claude-test/work',
    });
    expect(typeof options.systemPrompt).toBe('string');
    // Only the chosen credential reaches the subprocess.
    expect(options.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret', CLAUDE_CONFIG_DIR: '/tmp/ft-claude-test', PATH: '/bin' });
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    // The server's own secrets never reach the Claude process.
    expect(options.env).not.toHaveProperty('MAIL_SECRET_KEY');
    expect(options.env).not.toHaveProperty('JWT_SECRET');
  });

  it('sends just the page when there is no title-block crop', async () => {
    const calls: Call[] = [];
    const r = createClaudeRunner({ store: store(), queryFn: fakeQuery(() => [result(READ)], calls) });
    await r.readSheet({ image: JPEG });
    expect(calls[0].content.map(b => b.type)).toEqual(['text', 'image', 'text']);
  });

  it('matches against existing sheets (text only) and keeps only known ids', async () => {
    const calls: Call[] = [];
    const r = createClaudeRunner({ store: store(), queryFn: fakeQuery(() => [result('{"matchSheetId":"s2","confidence":0.8,"reason":"same number"}')], calls) });
    const m = await r.matchSheet({ page: { sheetNumber: 'A-201', sheetTitle: 'x', confidence: 1 }, existing: [{ sheetId: 's2', number: 'A-201', title: 'x' }] });
    expect(m).toEqual({ matchSheetId: 's2', confidence: 0.8, reason: 'same number' });
    expect(calls[0].content.every(b => b.type === 'text')).toBe(true);
  });

  it('transcribes a region crop', async () => {
    const r = createClaudeRunner({ store: store(), queryFn: fakeQuery(() => [result('```json\n{"text":"A-101","confidence":0.7}\n```')]) });
    expect(await r.transcribeRegion({ image: PNG, mode: 'number' })).toEqual({ text: 'A-101', confidence: 0.7 });
  });

  it('is unconfigured and off without a credential, and says so instead of calling Claude', async () => {
    const q = vi.fn();
    const r = createClaudeRunner({ store: store(null), queryFn: q as any });
    expect(r.configured()).toBe(false);
    expect(await r.state()).toBe('off');
    expect(r.info().device).toBe('none');
    await expect(r.readSheet({ image: JPEG })).rejects.toMatchObject({ code: 'auth' });
    expect(q).not.toHaveBeenCalled();
  });

  it('is ready with a credential (nothing to load)', async () => {
    const r = createClaudeRunner({ store: store(), queryFn: fakeQuery(() => []) });
    expect(r.configured()).toBe(true);
    expect(await r.state()).toBe('ready');
    expect(r.info()).toEqual({ model: 'claude-sonnet-5-5', device: 'cloud' });
  });

  it('turns a rejected sign-in into a clear auth error, remembers it, and clears it on the next success', async () => {
    let fail = true;
    const r = createClaudeRunner({
      store: store(),
      queryFn: fakeQuery(() => fail
        ? [{ type: 'assistant', error: 'authentication_failed', message: {} } as unknown as SDKMessage,
           { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' } as unknown as SDKMessage]
        : [result(READ)]),
    });
    await expect(r.readSheet({ image: JPEG })).rejects.toMatchObject({ code: 'auth', message: expect.stringMatching(/reconnect Claude in Settings/) });
    expect(r.lastError!()).toMatchObject({ code: 'auth' });
    fail = false;
    await r.readSheet({ image: JPEG });
    expect(r.lastError!()).toBeNull();
  });

  it('reports a usage limit from the result text, and an SDK that throws after an error result', async () => {
    const r = createClaudeRunner({
      store: store(),
      queryFn: async function* () {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Claude AI usage limit reached|1761868800'] } as unknown as SDKMessage;
        throw new Error('Claude Code process exited with code 1');
      },
    });
    await expect(r.readSheet({ image: JPEG })).rejects.toMatchObject({ code: 'rate_limit' });
  });

  it('a thrown spawn failure becomes a plain error, not a crash', async () => {
    const r = createClaudeRunner({ store: store(), queryFn: async function* () { throw new Error('spawn ENOENT'); } });
    await expect(r.readSheet({ image: JPEG })).rejects.toMatchObject({ code: 'other' });
  });

  it('aborts a call that takes too long', async () => {
    const r = createClaudeRunner({
      store: store(),
      timeoutMs: 20,
      queryFn: async function* ({ options }) {
        await new Promise((_, reject) => options!.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    });
    await expect(r.readSheet({ image: JPEG })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a call that ends quietly after the abort is still a timeout', async () => {
    const r = createClaudeRunner({
      store: store(),
      timeoutMs: 20,
      queryFn: async function* ({ options }) {
        await new Promise(res => options!.abortController!.signal.addEventListener('abort', res));
      },
    });
    await expect(r.readSheet({ image: JPEG })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a call that times out while the CLI retries a 429 reports the rate limit', async () => {
    const r = createClaudeRunner({
      store: store(),
      timeoutMs: 20,
      queryFn: async function* ({ options }) {
        yield { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' } as unknown as SDKMessage;
        await new Promise((_, reject) => options!.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    });
    await expect(r.readSheet({ image: JPEG })).rejects.toMatchObject({ code: 'rate_limit' });
  });

  it('runs one call at a time (single flight)', async () => {
    let active = 0, maxActive = 0;
    const r = createClaudeRunner({
      store: store(),
      queryFn: fakeQuery(async () => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise(res => setTimeout(res, 5));
        active--;
        return [result(READ)];
      }),
    });
    await Promise.all([1, 2, 3].map(() => r.readSheet({ image: JPEG })));
    expect(maxActive).toBe(1);
  });

  it('testConnection reports ok with the model, or the reason it failed', async () => {
    expect(await createClaudeRunner({ store: store(), queryFn: fakeQuery(() => [result('{"ok":true}')]) }).testConnection())
      .toEqual({ ok: true, model: 'claude-sonnet-5-5' });
    const bad = await createClaudeRunner({
      store: store(),
      queryFn: fakeQuery(() => [{ type: 'assistant', error: 'billing_error', message: {} } as unknown as SDKMessage]),
    }).testConnection();
    expect(bad).toMatchObject({ ok: false, code: 'billing' });
  });
});

describe('usage', () => {
  it('records each call\'s token use and the plan limits Anthropic reports', async () => {
    const usage = { record: vi.fn(), recordPlan: vi.fn(), summary: vi.fn() };
    const r = createClaudeRunner({
      store: store(),
      usage,
      queryFn: fakeQuery(() => [
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: 100 } } } } as unknown as SDKMessage,
        { type: 'result', subtype: 'success', is_error: false, result: READ, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 15000, outputTokens: 400, costUSD: 0.034 } } } as unknown as SDKMessage,
      ]),
    });
    await r.readSheet({ image: JPEG });
    await r.testConnection();
    expect(usage.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'read', model: 'claude-sonnet-5-5', inputTokens: 15000, outputTokens: 400, costUsd: 0.034 }));
    expect(usage.record).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'test' }));
    expect(usage.recordPlan).toHaveBeenCalledWith(expect.objectContaining({ fiveHour: { utilization: 0.34, resetsAt: 100_000 } }));
  });

  it('records the tokens of a call whose answer was an error', async () => {
    const usage = { record: vi.fn(), recordPlan: vi.fn(), summary: vi.fn() };
    const r = createClaudeRunner({
      store: store(), usage,
      queryFn: fakeQuery(() => [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['x'], modelUsage: { m: { inputTokens: 9, outputTokens: 1, costUSD: 0.001 } } } as unknown as SDKMessage]),
    });
    await expect(r.readSheet({ image: JPEG })).rejects.toBeTruthy();
    expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 9 }));
  });
});

describe('classifyClaudeError', () => {
  it('maps SDK error codes', () => {
    expect(classifyClaudeError('authentication_failed', '')).toBe('auth');
    expect(classifyClaudeError('rate_limit', '')).toBe('rate_limit');
    expect(classifyClaudeError('billing_error', '')).toBe('billing');
    expect(classifyClaudeError('model_not_found', '')).toBe('model');
  });
  it('falls back to the text', () => {
    expect(classifyClaudeError(undefined, 'Not logged in · Please run /login')).toBe('auth');
    expect(classifyClaudeError(undefined, 'API Error: 429 rate limit')).toBe('rate_limit');
    expect(classifyClaudeError(undefined, 'Your credit balance is too low')).toBe('billing');
    expect(classifyClaudeError(undefined, 'something else')).toBe('other');
  });
});

describe('imageMediaType', () => {
  it('sniffs PNG and JPEG', () => {
    expect(imageMediaType(PNG)).toBe('image/png');
    expect(imageMediaType(JPEG)).toBe('image/jpeg');
  });
});
