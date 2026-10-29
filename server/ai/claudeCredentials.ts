// Where the Claude sheet reader gets its credentials and model choice.
//
// The admin pastes either a long-lived token from `claude setup-token` (their
// Claude Pro/Max subscription) or an API key from platform.claude.com. The
// secret is sealed with the same AES-256-GCM key as mail credentials
// (data/mail.key, server/mail/crypto.ts) and kept in its own file, never in the
// settings table (GET /api/settings is public). Only the last 4 characters are
// ever reported back.
//
// Two other sources are picked up when nothing was pasted, so a server set up
// by hand keeps working:
//   * env       CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY on the container;
//   * login     `docker exec -it <container> claude login` stored a sign-in in
//               CLAUDE_CONFIG_DIR (data/claude/.credentials.json).
import fs from 'fs';
import path from 'path';
import type { MailCrypto } from '../mail/crypto';

export type ClaudeSecretKind = 'token' | 'apiKey';
export type ClaudeSource = ClaudeSecretKind | 'env' | 'login';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', centsPerSheet: 3 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', centsPerSheet: 1.5 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', centsPerSheet: 0.1 },
] as const;
export type ClaudeModelId = typeof CLAUDE_MODELS[number]['id'];
export const DEFAULT_CLAUDE_MODEL: ClaudeModelId = 'claude-opus-5-5';
export const isClaudeModel = (m: unknown): m is ClaudeModelId => CLAUDE_MODELS.some(x => x.id === m);

/** The credential the runner hands to the Agent SDK, already decrypted. */
export interface ClaudeCredential {
  source: ClaudeSource;
  /** Env vars that select it (empty for `login`, which lives in the config dir). */
  env: Record<string, string>;
}

/** What the browser may see. Never contains the secret. */
export interface ClaudeConnectionSummary {
  connected: boolean;
  source: ClaudeSource | null;
  last4: string | null;
  connectedAt: string | null;
  model: ClaudeModelId;
}

interface StoredFile {
  kind?: ClaudeSecretKind;
  sealed?: string;
  last4?: string;
  connectedAt?: string;
  model?: string;
}

export interface ClaudeCredentialStore {
  configDir: string;
  resolve(): ClaudeCredential | null;
  summary(): ClaudeConnectionSummary;
  setSecret(kind: ClaudeSecretKind, secret: string): void;
  clearSecret(): void;
  getModel(): ClaudeModelId;
  setModel(model: ClaudeModelId): void;
}

/** Light shape check: a pasted secret is one token with no spaces. Formats are
 *  Anthropic's to change, so this only catches an obviously wrong paste. */
export function validateSecret(kind: ClaudeSecretKind, secret: string): string | null {
  const s = secret.trim();
  if (!s) return kind === 'token' ? 'Paste the token from `claude setup-token`.' : 'Paste an API key.';
  if (/\s/.test(s)) return 'That has spaces in it — paste just the token.';
  if (s.length < 20) return 'That is too short to be a token or key.';
  if (!s.startsWith('sk-ant-')) return kind === 'token'
    ? 'A Claude Code token starts with "sk-ant-".'
    : 'An Anthropic API key starts with "sk-ant-".';
  if (kind === 'token' && s.startsWith('sk-ant-api')) return 'That looks like an API key — choose "API key" instead.';
  if (kind === 'apiKey' && s.startsWith('sk-ant-oat')) return 'That looks like a Claude Code token — choose "Claude subscription" instead.';
  return null;
}

export function createClaudeCredentialStore(opts: {
  dataDir: string;
  crypto: Pick<MailCrypto, 'seal' | 'open'>;
  env?: NodeJS.ProcessEnv;
}): ClaudeCredentialStore {
  const env = opts.env ?? process.env;
  const file = path.join(opts.dataDir, 'claude-ai.json');
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(opts.dataDir, 'claude');

  const read = (): StoredFile => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredFile; } catch { return {}; }
  };
  const write = (data: StoredFile): void => {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };

  const fromEnv = (): ClaudeCredential | null => {
    if (env.ANTHROPIC_API_KEY) return { source: 'env', env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } };
    if (env.CLAUDE_CODE_OAUTH_TOKEN) return { source: 'env', env: { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } };
    return null;
  };
  const hasLogin = (): boolean => fs.existsSync(path.join(configDir, '.credentials.json'));

  function stored(): { kind: ClaudeSecretKind; secret: string } | null {
    const data = read();
    if (!data.sealed || !data.kind) return null;
    try {
      return { kind: data.kind, secret: opts.crypto.open<string>(data.sealed) };
    } catch {
      // mail.key was replaced; the admin has to paste the secret again.
      return null;
    }
  }

  return {
    configDir,

    resolve() {
      const s = stored();
      if (s) {
        return s.kind === 'token'
          ? { source: 'token', env: { CLAUDE_CODE_OAUTH_TOKEN: s.secret } }
          : { source: 'apiKey', env: { ANTHROPIC_API_KEY: s.secret } };
      }
      return fromEnv() ?? (hasLogin() ? { source: 'login', env: {} } : null);
    },

    summary() {
      const data = read();
      const s = stored();
      const model = isClaudeModel(data.model) ? data.model : DEFAULT_CLAUDE_MODEL;
      if (s) return { connected: true, source: s.kind, last4: data.last4 ?? null, connectedAt: data.connectedAt ?? null, model };
      const e = fromEnv();
      if (e) {
        const v = Object.values(e.env)[0];
        return { connected: true, source: 'env', last4: v.slice(-4), connectedAt: null, model };
      }
      if (hasLogin()) return { connected: true, source: 'login', last4: null, connectedAt: null, model };
      return { connected: false, source: null, last4: null, connectedAt: null, model };
    },

    setSecret(kind, secret) {
      const s = secret.trim();
      write({ ...read(), kind, sealed: opts.crypto.seal(s), last4: s.slice(-4), connectedAt: new Date().toISOString() });
    },

    clearSecret() {
      const { model } = read();
      write(model ? { model } : {});
    },

    getModel() {
      const m = read().model;
      return isClaudeModel(m) ? m : DEFAULT_CLAUDE_MODEL;
    },

    setModel(model) {
      write({ ...read(), model });
    },
  };
}
