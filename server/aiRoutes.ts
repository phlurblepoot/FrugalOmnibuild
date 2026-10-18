import type express from 'express';
import { readFileContent } from './fileStore';
import { handleStatus, handleReadSheet, handleMatchSheet, handleWarmup, handleTranscribeRegion } from './ai/handlers';
import type { AiRunner } from './ai/types';

export interface AiRouteDeps {
  dataDir: string;
  authenticateToken: express.RequestHandler;
  runner: AiRunner;
}

export function registerAiRoutes(app: express.Express, deps: AiRouteDeps): void {
  const { dataDir, authenticateToken, runner } = deps;
  const loadImage = (id: string) => readFileContent(dataDir, id);

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
}
