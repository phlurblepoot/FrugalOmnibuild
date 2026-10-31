// The Claude connection routes: admin only, and the token/key never comes back.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MailCrypto } from './mail/crypto';
import { registerAiRoutes } from './aiRoutes';
import { createClaudeCredentialStore, type ClaudeCredentialStore } from './ai/claudeCredentials';
import { createUsageStore } from './ai/usageStore';
import type { AiRunner } from './ai/types';

const TOKEN = 'sk-ant-oat01-' + 'q'.repeat(60) + 'L4st';
let dir: string;
let store: ClaudeCredentialStore;
let testConnection: ReturnType<typeof vi.fn>;

const runner: AiRunner = {
  configured: () => store.resolve() !== null,
  state: async () => (store.resolve() ? 'ready' : 'off'),
  warmup: () => {},
  info: () => ({ model: store.getModel(), device: store.resolve() ? 'cloud' : 'none' }),
  lastError: () => null,
  readSheet: async () => ({ sheetNumber: 'A-1', sheetTitle: 'Plan', confidence: 0.9 }),
  matchSheet: async () => ({ matchSheetId: null, confidence: 0.9 }),
  transcribeRegion: async () => ({ text: 'A-1', confidence: 0.9 }),
};

function mkApp() {
  const app = express();
  app.use(express.json());
  // A header picks the role, standing in for the real JWT check.
  const authenticateToken: express.RequestHandler = (req: any, res, next) => {
    const role = req.headers['x-role'];
    if (!role) return res.status(401).json({ error: 'no token' });
    req.user = { id: 'u1', role };
    next();
  };
  const requireAdmin: express.RequestHandler = (req: any, res, next) =>
    req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });
  registerAiRoutes(app, { dataDir: dir, authenticateToken, requireAdmin, runner, claude: { store, runner: { testConnection: testConnection as any }, usage: createUsageStore(dir) } });
  return app;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-airoutes-'));
  store = createClaudeCredentialStore({ dataDir: dir, crypto: new MailCrypto(Buffer.alloc(32, 5)), env: {} });
  testConnection = vi.fn().mockResolvedValue({ ok: true, model: 'claude-opus-5-5' });
});

describe('Claude connection routes', () => {
  it('are admin only, for reads and writes alike', async () => {
    const app = mkApp();
    for (const [method, url] of [['get', '/api/ai/claude'], ['get', '/api/ai/claude/usage'], ['put', '/api/ai/claude/credential'], ['delete', '/api/ai/claude/credential'], ['put', '/api/ai/claude/model'], ['post', '/api/ai/claude/test']] as const) {
      expect((await (request(app) as any)[method](url)).status).toBe(401);
      expect((await (request(app) as any)[method](url).set('x-role', 'user').send({ kind: 'token', secret: TOKEN, model: 'claude-haiku-5-5' })).status).toBe(403);
    }
    expect(store.resolve()).toBeNull();
    expect(store.getModel()).toBe('claude-opus-5-5');
  });

  it('connecting stores the token and every answer shows only its last 4', async () => {
    const app = mkApp();
    const put = await request(app).put('/api/ai/claude/credential').set('x-role', 'admin').send({ kind: 'token', secret: TOKEN });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ connected: true, source: 'token', last4: 'L4st', model: 'claude-opus-5-5' });
    const get = await request(app).get('/api/ai/claude').set('x-role', 'admin');
    const status = await request(app).get('/api/ai/status').set('x-role', 'user');
    for (const res of [put, get, status]) expect(res.text).not.toContain(TOKEN.slice(0, 30));
    expect(status.body).toMatchObject({ available: true, state: 'ready', device: 'cloud' });
    expect(store.resolve()).toEqual({ source: 'token', env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
  });

  it('rejects a bad paste with a reason, and an unknown kind', async () => {
    const app = mkApp();
    const bad = await request(app).put('/api/ai/claude/credential').set('x-role', 'admin').send({ kind: 'token', secret: 'hello' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/short/);
    expect((await request(app).put('/api/ai/claude/credential').set('x-role', 'admin').send({ kind: 'password', secret: TOKEN })).status).toBe(400);
  });

  it('disconnect forgets it; status goes back to unavailable', async () => {
    const app = mkApp();
    await request(app).put('/api/ai/claude/credential').set('x-role', 'admin').send({ kind: 'token', secret: TOKEN });
    const del = await request(app).delete('/api/ai/claude/credential').set('x-role', 'admin');
    expect(del.body).toMatchObject({ connected: false, last4: null });
    expect((await request(app).get('/api/ai/status').set('x-role', 'user')).body).toMatchObject({ available: false, state: 'off' });
  });

  it('sets the model from the list only', async () => {
    const app = mkApp();
    expect((await request(app).put('/api/ai/claude/model').set('x-role', 'admin').send({ model: 'claude-haiku-5-5' })).body.model).toBe('claude-haiku-5-5');
    expect((await request(app).put('/api/ai/claude/model').set('x-role', 'admin').send({ model: 'gpt-4' })).status).toBe(400);
    expect(store.getModel()).toBe('claude-haiku-5-5');
  });

  it('usage reports what page scans used (admin only)', async () => {
    createUsageStore(dir).record({ kind: 'read', model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
    const res = await request(mkApp()).get('/api/ai/claude/usage').set('x-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ today: { pages: 1, inputTokens: 100 }, plan: null });
  });

  it('test connection runs only once connected', async () => {
    const app = mkApp();
    const before = await request(app).post('/api/ai/claude/test').set('x-role', 'admin');
    expect(before.body).toMatchObject({ ok: false, code: 'auth' });
    expect(testConnection).not.toHaveBeenCalled();
    await request(app).put('/api/ai/claude/credential').set('x-role', 'admin').send({ kind: 'token', secret: TOKEN });
    expect((await request(app).post('/api/ai/claude/test').set('x-role', 'admin')).body).toEqual({ ok: true, model: 'claude-opus-5-5' });
  });

  it('reading a sheet is open to any signed-in user, and 503 when Claude is not connected', async () => {
    const app = mkApp();
    const img = Buffer.from('jpeg').toString('base64');
    expect((await request(app).post('/api/ai/read-sheet').set('x-role', 'user').send({ imageBase64: img })).status).toBe(503);
    await request(app).put('/api/ai/claude/credential').set('x-role', 'admin').send({ kind: 'token', secret: TOKEN });
    const ok = await request(app).post('/api/ai/read-sheet').set('x-role', 'user').send({ imageBase64: img });
    expect(ok.body).toMatchObject({ sheetNumber: 'A-1' });
  });
});
