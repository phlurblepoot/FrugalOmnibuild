// server/onlyoffice/routes.ts — ONLYOFFICE routes: the admin connection check
// behind Settings → Document Editor (here, with the one-off test file the
// Document Server downloads during it), and the editor itself: opening files
// and saving them back (editorRoutes.ts), version history and restore
// (historyRoutes.ts), inserting images and saving copies (extrasRoutes.ts).
//
// The check proves both directions, because either can be broken on its own:
//   1. this app → ONLYOFFICE: the command service's `version` call. It fails
//      on a wrong ONLYOFFICE_INTERNAL_URL, a missing shared Docker network, or
//      a JWT secret that differs between the two containers.
//   2. ONLYOFFICE → this app: a tiny conversion whose input ONLYOFFICE must
//      download from APP_INTERNAL_URL. It fails on a wrong APP_INTERNAL_URL or
//      a Document Server still refusing private addresses
//      (ALLOW_PRIVATE_IP_ADDRESS). The editor needs exactly this path to open
//      files and to send saves back.
// The third check, whether the browser can load the editor from
// ONLYOFFICE_PUBLIC_URL, can only run in the browser; the Settings tab does it.
import express from 'express';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { BroadcastChange } from '../realtime/changeFeed';
import { registerOnlyofficeEditorRoutes } from './editorRoutes';
import { registerOnlyofficeHistoryRoutes } from './historyRoutes';
import { registerOnlyofficeExtrasRoutes } from './extrasRoutes';
import { registerOnlyofficeMentionRoutes } from './mentionRoutes';
import { registerShareViewerRoute } from './viewers';
import type { Notifier } from '../notifications';
import { EditorSessions, FileQueue, ForcesaveWaiters } from './sessions';
import { createOnlyofficeServices, type OnlyofficeServices } from './services';
import { registerOnlyofficeConversionRoutes } from './conversionRoutes';
import { readOnlyofficeConfig, type OnlyofficeConfigProblem } from './config';
import { OnlyofficeError, convert, getVersion } from './client';

export interface OnlyofficeRouteDeps {
  env: NodeJS.ProcessEnv;
  /** The app's own JWT secret; link tokens use a key derived from it. */
  appJwtSecret: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  db: Database.Database;
  dataDir: string;
  broadcastChange: BroadcastChange;
  fetch?: typeof fetch;
  /** How long a restore waits for ONLYOFFICE to save the open file (tests shorten it). */
  forcesaveTimeoutMs?: number;
  /** Shared with the upload route (server.ts); made here when not given. */
  services?: OnlyofficeServices;
  /** The notification bell: @mentions in comments tell the person mentioned. */
  notifier?: Notifier;
}

export type CheckStatus = 'ok' | 'failed' | 'skipped';
export interface ConnectionCheck { status: CheckStatus; message: string }

export interface OnlyofficeStatus {
  configured: boolean;
  problems: OnlyofficeConfigProblem[];
  publicUrl: string | null;
  internalUrl: string | null;
  appInternalUrl: string | null;
  version: string | null;
  checks: { appToOnlyoffice: ConnectionCheck; onlyofficeToApp: ConnectionCheck };
}

const SELFTEST_TTL_SECONDS = 120;
const SELFTEST_BODY = 'FrugalOmnibuild ONLYOFFICE connection test\n';
const selftestSubject = (id: string) => `selftest:${id}`;

export function registerOnlyofficeRoutes(app: express.Express, deps: OnlyofficeRouteDeps): void {
  const { authenticateToken, requireAdmin } = deps;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const services = deps.services ?? createOnlyofficeServices({
    env: deps.env, appJwtSecret: deps.appJwtSecret, db: deps.db, dataDir: deps.dataDir, fetch: fetchImpl,
  });
  const tokens = services.tokens;
  // Test ids the Document Server actually downloaded, so a failed conversion
  // can still say whether it reached us. Entries live only for one check.
  const selftestHits = new Set<string>();

  // Shared by saving and restoring: both change the same files and decide
  // what to do from the session state the other left.
  const editor = {
    env: deps.env, db: deps.db, dataDir: deps.dataDir, tokens, authenticateToken,
    broadcastChange: deps.broadcastChange, fetch: fetchImpl,
    sessions: new EditorSessions(deps.db), queue: new FileQueue(), waiters: new ForcesaveWaiters(),
  };
  // A save changes the first page: queue a fresh thumbnail.
  registerOnlyofficeEditorRoutes(app, { ...editor, onSaved: fileId => services.thumbnails.enqueue(fileId) });
  registerOnlyofficeHistoryRoutes(app, { ...editor, forcesaveTimeoutMs: deps.forcesaveTimeoutMs });
  registerOnlyofficeExtrasRoutes(app, editor);
  registerOnlyofficeMentionRoutes(app, { db: deps.db, authenticateToken, notifier: deps.notifier });
  registerShareViewerRoute(app, { env: deps.env, db: deps.db });
  registerOnlyofficeConversionRoutes(app, {
    db: deps.db, authenticateToken, requireAdmin, broadcastChange: deps.broadcastChange, services,
  });

  // Public by necessity (the Document Server has no user session), but only
  // with a two-minute token for this one test id, and it serves a fixed
  // string, never a stored file.
  app.get('/api/onlyoffice/selftest/:id', (req, res) => {
    const id = req.params.id;
    if (!tokens.verify(String(req.query.t || ''), selftestSubject(id))) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    selftestHits.add(id);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(SELFTEST_BODY);
  });

  app.get('/api/onlyoffice/status', authenticateToken, requireAdmin, async (_req, res) => {
    const { config, problems } = readOnlyofficeConfig(deps.env);
    const skipped = (message: string): ConnectionCheck => ({ status: 'skipped', message });
    const status: OnlyofficeStatus = {
      configured: !!config,
      problems,
      publicUrl: config?.publicUrl ?? null,
      internalUrl: config?.internalUrl ?? null,
      appInternalUrl: config?.appInternalUrl ?? null,
      version: null,
      checks: {
        appToOnlyoffice: skipped('Finish the setup above first.'),
        onlyofficeToApp: skipped('Finish the setup above first.'),
      },
    };
    if (!config) return res.json(status);

    try {
      status.version = await getVersion(config, fetchImpl);
      status.checks.appToOnlyoffice = {
        status: 'ok',
        message: `Connected to ONLYOFFICE ${status.version} at ${config.internalUrl}, and the shared secret matches.`,
      };
    } catch (e) {
      status.checks.appToOnlyoffice = { status: 'failed', message: appToOnlyofficeMessage(e, config.internalUrl) };
      status.checks.onlyofficeToApp = skipped('Needs the connection above to work first.');
      return res.json(status);
    }

    const id = randomUUID();
    const url = `${config.appInternalUrl}/api/onlyoffice/selftest/${id}?t=${encodeURIComponent(tokens.sign(selftestSubject(id), SELFTEST_TTL_SECONDS))}`;
    try {
      await convert(config, fetchImpl, { filetype: 'txt', outputtype: 'docx', key: `selftest-${id}`, title: 'connection-test.txt', url }, 30_000);
      status.checks.onlyofficeToApp = {
        status: 'ok',
        message: `ONLYOFFICE downloaded a test file from this app at ${config.appInternalUrl}.`,
      };
    } catch (e) {
      status.checks.onlyofficeToApp = {
        status: 'failed',
        message: onlyofficeToAppMessage(e, config.appInternalUrl, selftestHits.has(id)),
      };
    } finally {
      selftestHits.delete(id);
    }
    res.json(status);
  });
}

function appToOnlyofficeMessage(e: unknown, internalUrl: string): string {
  if (e instanceof OnlyofficeError) {
    if (e.code === 'unreachable') {
      return `${e.message} Check ONLYOFFICE_INTERNAL_URL, and that the ONLYOFFICE container is running on the same Docker network as this app.`;
    }
    if (e.code === 'bad-response') {
      return `${e.message} Check that ONLYOFFICE_INTERNAL_URL points at the ONLYOFFICE container itself.`;
    }
    return e.message;
  }
  return `Unexpected error talking to ONLYOFFICE at ${internalUrl}.`;
}

function onlyofficeToAppMessage(e: unknown, appInternalUrl: string, reachedUs: boolean): string {
  if (e instanceof OnlyofficeError && e.code === 'download-failed' && !reachedUs) {
    return `ONLYOFFICE couldn't download a test file from this app at ${appInternalUrl}. `
      + 'Check APP_INTERNAL_URL, and that the ONLYOFFICE container has ALLOW_PRIVATE_IP_ADDRESS=true.';
  }
  if (reachedUs) {
    const why = e instanceof Error ? e.message : 'an unexpected error';
    return `ONLYOFFICE reached this app at ${appInternalUrl}, but the test conversion still failed: ${why}`;
  }
  if (e instanceof OnlyofficeError) return e.message;
  return `Unexpected error while ONLYOFFICE contacted this app at ${appInternalUrl}.`;
}
