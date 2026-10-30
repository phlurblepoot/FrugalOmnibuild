import type express from 'express';
import { readFileContent } from './fileStore';
import { handleStatus, handleReadSheet, handleMatchSheet, handleWarmup, handleTranscribeRegion } from './ai/handlers';
import type { AiRunner } from './ai/types';
import type { ClaudeRunner } from './ai/claudeRunner';
import { CLAUDE_MODELS, isClaudeModel, validateSecret, type ClaudeCredentialStore } from './ai/claudeCredentials';

export interface AiRouteDeps {
  dataDir: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  runner: AiRunner;
  /** The Claude connection the admin manages in Settings. */
  claude: { store: ClaudeCredentialStore; runner: Pick<ClaudeRunner, 'testConnection'> };
}

export function registerAiRoutes(app: express.Express, deps: AiRouteDeps): void {
  const { dataDir, authenticateToken, requireAdmin, runner, claude } = deps;
  const loadImage = (id: string) => readFileContent(dataDir, id);
  const admin = [authenticateToken, requireAdmin];

  app.get('/api/ai/status', authenticateToken, async (_req, res) => {
    const r = await handleStatus(runner);
    res.status(r.status).json(r.body);
  });

  app.post('/api/ai/warmup', authenticateToken, async (req, res) => {
    const r = await handleWarmup(runner, req.body || {});
    res.status(r.status).json(r.body);
  });

  app.post('/api/ai/read-sheet', authenticateToken, async (req, res) => {
    const r = await handleReadSheet(runner, loadImage, req.body || {});
    res.status(r.status).json(r.body);
  });

  app.post('/api/ai/match-sheet', authenticateToken, async (req, res) => {
    const r = await handleMatchSheet(runner, req.body || {});
    res.status(r.status).json(r.body);
  });

  app.post('/api/ai/transcribe-region', authenticateToken, async (req, res) => {
    const r = await handleTranscribeRegion(runner, req.body || {});
    res.status(r.status).json(r.body);
  });

  // --- Claude connection (admin only). The token/key goes in and never comes
  // back out: every response is the summary (source, last 4, model).
  const connection = () => ({ ...claude.store.summary(), models: CLAUDE_MODELS });

  app.get('/api/ai/claude', ...admin, (_req, res) => {
    res.json(connection());
  });

  app.put('/api/ai/claude/credential', ...admin, (req, res) => {
    const { kind, secret } = req.body || {};
    if (kind !== 'token' && kind !== 'apiKey') return res.status(400).json({ error: "kind must be 'token' or 'apiKey'" });
    if (typeof secret !== 'string') return res.status(400).json({ error: 'secret required' });
    const problem = validateSecret(kind, secret);
    if (problem) return res.status(400).json({ error: problem });
    claude.store.setSecret(kind, secret);
    res.json(connection());
  });

  app.delete('/api/ai/claude/credential', ...admin, (_req, res) => {
    claude.store.clearSecret();
    res.json(connection());
  });

  app.put('/api/ai/claude/model', ...admin, (req, res) => {
    const model = req.body?.model;
    if (!isClaudeModel(model)) return res.status(400).json({ error: 'unknown model' });
    claude.store.setModel(model);
    res.json(connection());
  });

  app.post('/api/ai/claude/test', ...admin, async (_req, res) => {
    if (!claude.store.resolve()) return res.json({ ok: false, code: 'auth', error: 'Claude is not connected yet.' });
    res.json(await claude.runner.testConnection());
  });
}
