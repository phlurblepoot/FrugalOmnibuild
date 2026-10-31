import type { MailCrypto } from '../mail/crypto';
import { createClaudeCredentialStore, type ClaudeCredentialStore } from './claudeCredentials';
import { createClaudeRunner, type ClaudeRunner } from './claudeRunner';
import { createFakeClaudeQuery } from './fakeClaude';
import { createUsageStore, type UsageStore } from './usageStore';

export interface AiSetup { store: ClaudeCredentialStore; runner: ClaudeRunner; usage: UsageStore; }

let singleton: AiSetup | null = null;

/** Build (once) the Claude sheet reader. It is always present; it reports
 *  itself unconfigured until an admin connects Claude in Settings (or the
 *  container carries a credential), and page naming falls back to the PDF's
 *  text and OCR meanwhile. AI_FAKE_CLAUDE=1 (e2e only) swaps the Agent SDK for
 *  a canned responder so tests never call Claude. */
export function getAiSetup(opts: { dataDir: string; crypto: Pick<MailCrypto, 'seal' | 'open'>; env?: NodeJS.ProcessEnv; version?: string }): AiSetup {
  if (singleton) return singleton;
  const env = opts.env ?? process.env;
  const store = createClaudeCredentialStore({ dataDir: opts.dataDir, crypto: opts.crypto, env });
  const fake = env.AI_FAKE_CLAUDE === '1';
  if (fake) console.warn('[ai] AI_FAKE_CLAUDE=1: Claude is faked (tests only)');
  const usage = createUsageStore(opts.dataDir);
  const runner = createClaudeRunner({
    store,
    usage,
    env,
    queryFn: fake ? createFakeClaudeQuery() : undefined,
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 120_000),
    clientApp: `frugalomnibuild/${opts.version ?? 'dev'}`,
  });
  singleton = { store, runner, usage };
  return singleton;
}
