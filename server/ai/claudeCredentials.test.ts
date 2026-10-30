import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MailCrypto } from '../mail/crypto';
import { createClaudeCredentialStore, validateSecret, DEFAULT_CLAUDE_MODEL } from './claudeCredentials';

const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(40) + 'WXYZ';
const KEY = 'sk-ant-api03-' + 'y'.repeat(40) + 'ABCD';
let dir: string;
const crypto = new MailCrypto(Buffer.alloc(32, 9));
const mk = (env: NodeJS.ProcessEnv = {}) => createClaudeCredentialStore({ dataDir: dir, crypto, env });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-claude-')); });

describe('createClaudeCredentialStore', () => {
  it('starts disconnected on the default model, with the config dir in the data folder', () => {
    const s = mk();
    expect(s.summary()).toEqual({ connected: false, source: null, last4: null, connectedAt: null, model: DEFAULT_CLAUDE_MODEL });
    expect(s.resolve()).toBeNull();
    expect(s.configDir).toBe(path.join(dir, 'claude'));
  });

  it('seals a subscription token: the file never holds it, and resolve hands it to the SDK as CLAUDE_CODE_OAUTH_TOKEN', () => {
    const s = mk();
    s.setSecret('token', `  ${TOKEN}\n`);
    const raw = fs.readFileSync(path.join(dir, 'claude-ai.json'), 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('xxxxxxxx');
    expect((fs.statSync(path.join(dir, 'claude-ai.json')).mode & 0o777).toString(8)).toBe('600');
    expect(s.resolve()).toEqual({ source: 'token', env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    expect(s.summary()).toMatchObject({ connected: true, source: 'token', last4: 'WXYZ' });
    expect(JSON.stringify(s.summary())).not.toContain(TOKEN);
  });

  it('an API key goes to the SDK as ANTHROPIC_API_KEY', () => {
    const s = mk();
    s.setSecret('apiKey', KEY);
    expect(s.resolve()).toEqual({ source: 'apiKey', env: { ANTHROPIC_API_KEY: KEY } });
    expect(s.summary().last4).toBe('ABCD');
  });

  it('a pasted secret wins over the container env, which wins over a claude login', () => {
    fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude', '.credentials.json'), '{}');
    expect(mk().resolve()).toEqual({ source: 'login', env: {} });
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    expect(mk(env).resolve()).toEqual({ source: 'env', env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    expect(mk(env).summary()).toMatchObject({ source: 'env', last4: 'WXYZ' });
    const s = mk(env);
    s.setSecret('apiKey', KEY);
    expect(s.resolve()?.source).toBe('apiKey');
  });

  it('honours CLAUDE_CONFIG_DIR for the login sign-in', () => {
    const cfg = path.join(dir, 'elsewhere');
    expect(mk({ CLAUDE_CONFIG_DIR: cfg }).configDir).toBe(cfg);
  });

  it('disconnect forgets the secret but keeps the model', () => {
    const s = mk();
    s.setModel('claude-haiku-5-5');
    s.setSecret('token', TOKEN);
    s.clearSecret();
    expect(s.resolve()).toBeNull();
    expect(s.getModel()).toBe('claude-haiku-5-5');
  });

  it('a secret sealed under another key reads as not connected', () => {
    mk().setSecret('token', TOKEN);
    const other = createClaudeCredentialStore({ dataDir: dir, crypto: new MailCrypto(Buffer.alloc(32, 1)), env: {} });
    expect(other.resolve()).toBeNull();
    expect(other.summary().connected).toBe(false);
  });

  it('ignores an unknown stored model', () => {
    fs.writeFileSync(path.join(dir, 'claude-ai.json'), JSON.stringify({ model: 'gpt-x' }));
    expect(mk().getModel()).toBe(DEFAULT_CLAUDE_MODEL);
  });
});

describe('validateSecret', () => {
  it('accepts the right kind', () => {
    expect(validateSecret('token', TOKEN)).toBeNull();
    expect(validateSecret('apiKey', KEY)).toBeNull();
  });
  it('rejects empty, spaced, short, foreign and swapped secrets', () => {
    expect(validateSecret('token', '  ')).toMatch(/setup-token/);
    expect(validateSecret('token', 'sk-ant-oat01 abc def ghi jkl mno')).toMatch(/spaces/);
    expect(validateSecret('apiKey', 'sk-ant-1')).toMatch(/short/);
    expect(validateSecret('apiKey', 'sk-proj-' + 'z'.repeat(40))).toMatch(/sk-ant-/);
    expect(validateSecret('token', KEY)).toMatch(/API key/);
    expect(validateSecret('apiKey', TOKEN)).toMatch(/Claude Code token/);
  });
});
