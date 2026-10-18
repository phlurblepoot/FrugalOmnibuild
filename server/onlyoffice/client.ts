// server/onlyoffice/client.ts — calls from this app to the Document Server:
// the command service (`/command`) and the conversion service (`/converter`).
//
// Every request is signed with the shared secret twice: as `token` in the body
// (ONLYOFFICE's recommended form) and as a Bearer header whose payload wraps
// the parameters (the older form). Sending both keeps working whichever form
// the server is set up to check.
import jwt from 'jsonwebtoken';
import type { OnlyofficeConfig } from './config';

export type OnlyofficeErrorCode =
  | 'unreachable'      // network error, DNS failure, refused, timed out
  | 'bad-response'     // reached something, but not a Document Server answer
  | 'secret-mismatch'  // the Document Server rejected our signature
  | 'download-failed'  // the Document Server could not fetch the file from us
  | 'failed';          // any other error code it returned

export class OnlyofficeError extends Error {
  constructor(readonly code: OnlyofficeErrorCode, message: string, readonly serverError?: number) {
    super(message);
    this.name = 'OnlyofficeError';
  }
}

type Fetch = typeof fetch;

/** Why a fetch never got an answer, in the words an admin can act on. */
function networkReason(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timed out';
  return err?.cause?.code || err?.cause?.message || err?.message || 'network error';
}

async function postSigned(
  cfg: OnlyofficeConfig, fetchImpl: Fetch, path: string, params: Record<string, unknown>, timeoutMs: number,
): Promise<any> {
  const url = `${cfg.internalUrl}${path}`;
  const bodyToken = jwt.sign(params, cfg.jwtSecret, { algorithm: 'HS256' });
  const headerToken = jwt.sign({ payload: params }, cfg.jwtSecret, { algorithm: 'HS256' });
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${headerToken}` },
      body: JSON.stringify({ ...params, token: bodyToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new OnlyofficeError('unreachable', `Couldn't reach ONLYOFFICE at ${cfg.internalUrl} (${networkReason(e)}).`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new OnlyofficeError('bad-response', `ONLYOFFICE at ${cfg.internalUrl} answered HTTP ${res.status} for ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OnlyofficeError('bad-response', `${url} did not answer like an ONLYOFFICE Document Server.`);
  }
}

const SECRET_MISMATCH =
  'ONLYOFFICE rejected this app\'s signature: ONLYOFFICE_JWT_SECRET here must equal JWT_SECRET on the ONLYOFFICE container.';

/** The Document Server's version, e.g. "9.4.0.1". Proves reachability and the shared secret. */
export async function getVersion(cfg: OnlyofficeConfig, fetchImpl: Fetch, timeoutMs = 8000): Promise<string> {
  const body = await postSigned(cfg, fetchImpl, '/command', { c: 'version' }, timeoutMs);
  if (body?.error === 6) throw new OnlyofficeError('secret-mismatch', SECRET_MISMATCH, 6);
  if (body?.error !== 0 || typeof body?.version !== 'string') {
    throw new OnlyofficeError('failed', `ONLYOFFICE's command service returned error ${body?.error ?? 'unknown'}.`, body?.error);
  }
  return body.version;
}

export interface ConvertRequest {
  /** Input format, e.g. "xlsx". */
  filetype: string;
  /** Output format, e.g. "pdf". */
  outputtype: string;
  /** Unique per conversion: ONLYOFFICE caches results by key. */
  key: string;
  title: string;
  /** Where the Document Server downloads the input from; must be reachable from it. */
  url: string;
  /** Number and date formats for spreadsheet → PDF, e.g. "en-US". */
  region?: string;
  /** Page setup for spreadsheet → PDF. */
  spreadsheetLayout?: Record<string, unknown>;
  /** Image output: the first page as a picture (ONLYOFFICE's `thumbnail`). */
  thumbnail?: { aspect?: 0 | 1 | 2; first?: boolean; width?: number; height?: number };
}

/** What ONLYOFFICE's conversion error codes mean, in words a person can act on. */
const CONVERT_ERRORS: Record<number, string> = {
  [-2]: 'ONLYOFFICE ran out of time converting the file.',
  [-3]: "ONLYOFFICE couldn't convert this file (it may be damaged or in a format it can't read).",
  [-5]: 'The file is password-protected.',
  [-7]: "ONLYOFFICE couldn't read the conversion request.",
  [-9]: "ONLYOFFICE couldn't tell what to convert the file to.",
  [-10]: 'The file is larger than ONLYOFFICE will convert.',
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Converts a file and resolves with the Document Server's link to the
 *  result. Asks asynchronously and polls (re-sending the same request, as the
 *  conversion API expects) until ONLYOFFICE says it is done, so a big file
 *  never holds one HTTP request open for minutes. */
export async function convert(
  cfg: OnlyofficeConfig, fetchImpl: Fetch, req: ConvertRequest, timeoutMs = 60_000, pollMs = 1000,
): Promise<{ fileUrl: string; fileType: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1000, deadline - Date.now());
    const body = await postSigned(cfg, fetchImpl, '/converter', { async: true, ...req }, Math.min(remaining, 30_000));
    const error = typeof body?.error === 'number' ? body.error : 0;
    if (error === -8) throw new OnlyofficeError('secret-mismatch', SECRET_MISMATCH, -8);
    if (error === -4) {
      throw new OnlyofficeError('download-failed', `ONLYOFFICE couldn't download the file from ${new URL(req.url).origin}.`, -4);
    }
    if (error !== 0) {
      throw new OnlyofficeError('failed', CONVERT_ERRORS[error] ?? `ONLYOFFICE's conversion failed with error ${error}.`, error);
    }
    if (body?.endConvert === true) {
      if (typeof body?.fileUrl !== 'string') throw new OnlyofficeError('failed', 'ONLYOFFICE finished the conversion but gave no link to the result.');
      return { fileUrl: body.fileUrl, fileType: String(body.fileType || req.outputtype) };
    }
    if (Date.now() + pollMs > deadline) throw new OnlyofficeError('failed', CONVERT_ERRORS[-2], -2);
    await sleep(pollMs);
  }
}

/** Whether ONLYOFFICE still has an editing session open for this key (the
 *  command service's `info`: error 0 = known, 1 = no such document). */
export async function isSessionOpen(cfg: OnlyofficeConfig, fetchImpl: Fetch, key: string, timeoutMs = 8000): Promise<boolean> {
  const body = await postSigned(cfg, fetchImpl, '/command', { c: 'info', key }, timeoutMs);
  if (body?.error === 0) return true;
  if (body?.error === 1) return false;
  if (body?.error === 6) throw new OnlyofficeError('secret-mismatch', SECRET_MISMATCH, 6);
  throw new OnlyofficeError('failed', `ONLYOFFICE's command service returned error ${body?.error ?? 'unknown'}.`, body?.error);
}

/** The same link on the internal address, when ONLYOFFICE built it with its
 *  public one (it uses the address the browser connected on). Downloading a
 *  save over the Docker network beats a round trip out through Cloudflare. */
export function internalDownloadUrl(cfg: OnlyofficeConfig, url: string): string | null {
  let u: URL;
  let pub: URL;
  try { u = new URL(url); pub = new URL(cfg.publicUrl); } catch { return null; }
  if (u.host !== pub.host) return null;
  const prefix = pub.pathname.replace(/\/$/, '');
  const path = prefix && u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
  return `${cfg.internalUrl}${path}${u.search}`;
}

/** Downloads a file ONLYOFFICE produced (a save, a conversion result): over the
 *  internal address first, then the link exactly as ONLYOFFICE gave it. */
export async function downloadFromOnlyoffice(cfg: OnlyofficeConfig, fetchImpl: Fetch, url: string, timeoutMs = 120_000): Promise<Buffer> {
  const candidates = [internalDownloadUrl(cfg, url), url].filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
  let lastError = 'no usable link';
  for (const candidate of candidates) {
    try {
      const res = await fetchImpl(candidate, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastError = `HTTP ${res.status} from ${new URL(candidate).origin}`;
    } catch (e) {
      lastError = `${networkReason(e)} from ${new URL(candidate).origin}`;
    }
  }
  throw new OnlyofficeError('unreachable', `Couldn't download the saved file from ONLYOFFICE (${lastError}).`);
}

/** Asks ONLYOFFICE to save the session's current state now (command
 *  `forcesave`). Returns its error code: 0 = a save is on its way to the
 *  callback, 4 = nothing changed since the last save, 1 = no such session. */
export async function requestForcesave(cfg: OnlyofficeConfig, fetchImpl: Fetch, key: string, timeoutMs = 8000): Promise<number> {
  const body = await postSigned(cfg, fetchImpl, '/command', { c: 'forcesave', key, userdata: 'restore' }, timeoutMs);
  if (body?.error === 6) throw new OnlyofficeError('secret-mismatch', SECRET_MISMATCH, 6);
  if (typeof body?.error !== 'number') throw new OnlyofficeError('bad-response', 'ONLYOFFICE gave no answer to the save request.');
  return body.error;
}
