// server/onlyoffice/services.ts — the ONLYOFFICE pieces other parts of the
// app call into, made once at startup and shared: the upload route converts
// old formats (Conversions), the Documents list shows thumbnails
// (Thumbnails). Both read the ONLYOFFICE settings on every use, so they do
// nothing until it is set up.
import type Database from 'better-sqlite3';
import { LinkTokens } from './tokens';
import { Conversions } from './conversions';
import { Thumbnails } from './thumbnails';

export interface OnlyofficeServices {
  tokens: LinkTokens;
  conversions: Conversions;
  thumbnails: Thumbnails;
}

export function createOnlyofficeServices(deps: {
  env: NodeJS.ProcessEnv;
  /** The app's own JWT secret; link tokens use a key derived from it. */
  appJwtSecret: string;
  db: Database.Database;
  dataDir: string;
  fetch?: typeof fetch;
}): OnlyofficeServices {
  const tokens = new LinkTokens(deps.appJwtSecret);
  const shared = { env: deps.env, db: deps.db, dataDir: deps.dataDir, tokens, fetch: deps.fetch ?? globalThis.fetch };
  return { tokens, conversions: new Conversions(shared), thumbnails: new Thumbnails(shared) };
}
