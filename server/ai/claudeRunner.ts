// AiRunner backed by Claude, through the Claude Agent SDK.
//
// Each read is one single-turn query with no tools: the page image(s) and the
// prompt go in, Claude's JSON answer comes out. The SDK runs the Claude Code
// binary it bundles, so the same code path works with a Claude subscription
// token (CLAUDE_CODE_OAUTH_TOKEN), an API key (ANTHROPIC_API_KEY) or a
// `claude login` stored in CLAUDE_CONFIG_DIR — the credential store decides.
// Calls go through the single-flight queue so a 200-page set is read one page
// at a time instead of tripping rate limits.
import fs from 'fs';
import path from 'path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AiRunner, AiState, AiErrorCode, AiLastError, SheetRead, SheetMatch, ExistingSheetRef, TranscribeMode, TranscribeResult } from './types';
import type { ClaudeCredentialStore } from './claudeCredentials';
import { planLimitsFrom, usageFromModelUsage, type UsageKind, type UsageStore } from './usageStore';
import { createSingleFlightQueue } from './queue';
import { SYSTEM_PROMPT, buildReadPrompt, parseReadResponse, buildMatchPrompt, parseMatchResponse, buildTranscribePrompt, parseTranscribeResponse } from './prompt';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;
type UserContent = SDKUserMessage['message']['content'];

const QUARTERS = ['Top-left quarter', 'Top-right quarter', 'Bottom-left quarter', 'Bottom-right quarter'];

/** Environment variables the Claude Code subprocess inherits from the server. */
const PASSED_ENV = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'ANTHROPIC_BASE_URL',
];

export class ClaudeAiError extends Error {
  constructor(public readonly code: AiErrorCode, message: string) { super(message); }
}

const MESSAGES: Record<AiErrorCode, string> = {
  auth: 'Claude sign-in failed. An admin can reconnect Claude in Settings › User Preferences.',
  rate_limit: 'Claude usage or rate limit reached. Try again later; page names from the PDF and OCR still work.',
  billing: 'The Anthropic account has a billing problem (no credit left?). Check it at platform.claude.com.',
  model: 'This Claude model is not available to this account. Pick another model in Settings.',
  timeout: 'Claude took too long to answer.',
  other: 'Claude could not read the page.',
};

/** Map the SDK's error signal (an assistant `error` code and/or text) to one of ours. */
export function classifyClaudeError(apiError: string | undefined, text: string): AiErrorCode {
  switch (apiError) {
    case 'authentication_failed': case 'oauth_org_not_allowed': case 'account_on_hold':
    case 'verification_required': case 'cloud_credential_error':
      return 'auth';
    case 'rate_limit': case 'overloaded': return 'rate_limit';
    case 'billing_error': return 'billing';
    case 'model_not_found': return 'model';
  }
  if (/not logged in|invalid api key|invalid.*token|authenticat|unauthori[sz]ed|\b401\b|oauth/i.test(text)) return 'auth';
  if (/usage limit|rate limit|limit reached|\b429\b|overloaded|\b529\b/i.test(text)) return 'rate_limit';
  if (/credit balance|billing/i.test(text)) return 'billing';
  if (/model.*(not found|not available|does not exist)/i.test(text)) return 'model';
  return 'other';
}

/** JPEG and PNG are all the client sends; anything else is called JPEG. */
export function imageMediaType(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

const image = (buf: Buffer) => ({
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: imageMediaType(buf), data: buf.toString('base64') },
});
const text = (t: string) => ({ type: 'text' as const, text: t });

export interface ClaudeRunnerConfig {
  store: ClaudeCredentialStore;
  /** Injected in tests and in the e2e fake; defaults to the real SDK. */
  queryFn?: QueryFn;
  /** Per-call limit; a page read with thinking normally takes 5–20 s. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  clientApp?: string;
  /** Where each call's token use and the plan's reported limits are kept. */
  usage?: UsageStore;
}

export interface ClaudeRunner extends AiRunner {
  /** One tiny call to prove the credential and model work. */
  testConnection(): Promise<{ ok: true; model: string } | { ok: false; code: AiErrorCode; error: string }>;
}

export function createClaudeRunner(cfg: ClaudeRunnerConfig): ClaudeRunner {
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  // The queue's own timeout is a backstop; ask() aborts the subprocess first.
  const queue = createSingleFlightQueue({ timeoutMs: timeoutMs + 5_000 });
  const queryFn: QueryFn = cfg.queryFn ?? (sdkQuery as QueryFn);
  const baseEnv = cfg.env ?? process.env;
  let lastError: AiLastError | null = null;

  /** The subprocess env: only what Claude Code needs to run and reach the
   *  network, plus the chosen credential. The server's own secrets (JWT, mail
   *  key, OAuth client secrets) and any other Claude credential stay out. */
  function buildEnv(credEnv: Record<string, string>): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const name of PASSED_ENV) if (baseEnv[name] !== undefined) env[name] = baseEnv[name];
    return {
      ...env,
      ...credEnv,
      CLAUDE_CONFIG_DIR: cfg.store.configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: cfg.clientApp ?? 'frugalomnibuild',
    };
  }

  async function ask(content: UserContent, kind: UsageKind): Promise<string> {
    const cred = cfg.store.resolve();
    if (!cred) throw new ClaudeAiError('auth', 'Claude is not connected. An admin can connect it in Settings.');
    const workDir = path.join(cfg.store.configDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const model = cfg.store.getModel();
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    }

    let answer: string | null = null;
    let apiError: string | undefined;
    let retryError: string | undefined;
    let failure = '';
    try {
      for await (const m of queryFn({
        prompt: prompt(),
        options: {
          model,
          systemPrompt: SYSTEM_PROMPT,
          tools: [],
          settingSources: [],
          maxTurns: 1,
          persistSession: false,
          effort: 'low',
          cwd: workDir,
          env: buildEnv(cred.env),
          abortController,
        },
      })) {
        if (m.type === 'assistant' && m.error) apiError = m.error;
        // The CLI retries 429s and 5xx on its own; remember why, in case we time out first.
        if (m.type === 'system' && m.subtype === 'api_retry') retryError = m.error;
        // Anthropic's report on the plan's limits (subscriptions only).
        if (m.type === 'rate_limit_event') {
          const plan = planLimitsFrom(m.rate_limit_info);
          if (plan) cfg.usage?.recordPlan(plan);
        }
        if (m.type === 'result') {
          // Tokens are spent whether or not the answer is usable.
          cfg.usage?.record(usageFromModelUsage(kind, model, m.modelUsage));
          if (m.subtype === 'success' && !m.is_error) answer = m.result;
          else failure = m.subtype === 'success' ? m.result : (m.errors ?? []).join('; ') || m.subtype;
        }
      }
    } catch (e: any) {
      // A single-shot query throws after an error result; keep the result's text.
      if (answer === null && !abortController.signal.aborted) failure = failure || String(e?.message ?? e);
    } finally {
      clearTimeout(timer);
    }
    if (answer === null && abortController.signal.aborted) {
      // Timed out; if the CLI was retrying a 429 or an overload, say that instead.
      const retried = retryError ? classifyClaudeError(retryError, '') : 'other';
      const code = retried === 'other' ? 'timeout' : retried;
      throw new ClaudeAiError(code, MESSAGES[code]);
    }
    if (answer !== null && !apiError) return answer;
    const code = classifyClaudeError(apiError, failure);
    console.warn(`[ai] claude call failed (${code}):`, (failure || apiError || '').slice(0, 300));
    throw new ClaudeAiError(code, MESSAGES[code]);
  }

  async function run<T>(label: string, kind: UsageKind, content: UserContent, parse: (raw: string) => T): Promise<T> {
    try {
      const raw = await queue.enqueue(() => ask(content, kind));
      console.log(`[ai] ${label} raw:`, raw.slice(0, 400));
      lastError = null;
      return parse(raw);
    } catch (e: any) {
      const err = e instanceof ClaudeAiError ? e
        : /timed out/.test(String(e?.message)) ? new ClaudeAiError('timeout', MESSAGES.timeout)
        : new ClaudeAiError('other', MESSAGES.other);
      lastError = { code: err.code, message: err.message, at: new Date().toISOString() };
      throw err;
    }
  }

  return {
    configured: () => cfg.store.resolve() !== null,
    state: async (): Promise<AiState> => (cfg.store.resolve() ? 'ready' : 'off'),
    warmup: () => {},
    info: () => ({ model: cfg.store.getModel(), device: cfg.store.resolve() ? 'cloud' : 'none' }),
    lastError: () => lastError,

    readSheet({ image: page, details = [], layoutText, embeddedText, setContext, prompt }) {
      const content: UserContent = [text('The whole sheet:'), image(page)];
      if (details.length) {
        content.push(text('The same sheet in quarters, at twice the detail, for small print:'));
        details.forEach((d, i) => content.push(text(`${QUARTERS[i] ?? `Part ${i + 1}`}:`), image(d)));
      }
      content.push(text(prompt || buildReadPrompt(embeddedText, layoutText, setContext)));
      return run('read-sheet', 'read', content, parseReadResponse);
    },

    matchSheet({ page, existing }: { page: SheetRead; existing: ExistingSheetRef[] }): Promise<SheetMatch> {
      return run('match-sheet', 'match', [text(buildMatchPrompt(page, existing))], raw => parseMatchResponse(raw, existing.map(e => e.sheetId)));
    },

    transcribeRegion({ image: crop, mode }: { image: Buffer; mode: TranscribeMode }): Promise<TranscribeResult> {
      return run('transcribe', 'transcribe', [image(crop), text(buildTranscribePrompt(mode))], parseTranscribeResponse);
    },

    async testConnection() {
      try {
        await run('test', 'test', [text('Connection check. Respond with ONLY this JSON: {"ok": true}')], raw => raw);
        return { ok: true, model: cfg.store.getModel() };
      } catch (e: any) {
        return { ok: false, code: (e as ClaudeAiError).code ?? 'other', error: String(e?.message ?? e) };
      }
    },
  };
}
