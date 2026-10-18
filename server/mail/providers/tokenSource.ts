// Caches an OAuth access token until shortly before it expires, refreshing on
// demand and coalescing concurrent callers onto one in-flight refresh. A
// refresh failure that looks like a revoked/expired grant (Google's
// invalid_grant/invalid_client/unauthorized_client, or the matching AADSTS
// codes from Microsoft) is mapped to AuthExpiredError so callers can flag the
// account for reconnect instead of retrying forever; anything else (e.g. a
// network blip) is rethrown as-is.
import { AuthExpiredError } from './types';

const FATAL = /invalid_grant|invalid_client|unauthorized_client|AADSTS(50173|700082|70008|7000215)/i;

export interface TokenSourceOpts {
  refreshToken: string;
  refresh: (refreshToken: string) => Promise<{ accessToken: string; expiresInSec: number; refreshToken?: string }>;
  onRotate?: (newRefreshToken: string) => void;
  now?: () => number;
}

export class TokenSource {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(private opts: TokenSourceOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - 60_000) return this.token;
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const r = await this.opts.refresh(this.opts.refreshToken);
          this.token = r.accessToken;
          this.expiresAt = this.now() + r.expiresInSec * 1000;
          if (r.refreshToken && r.refreshToken !== this.opts.refreshToken) {
            this.opts.refreshToken = r.refreshToken;
            this.opts.onRotate?.(r.refreshToken);
          }
          return this.token;
        } catch (e: any) {
          if (FATAL.test(String(e?.message ?? e))) throw new AuthExpiredError(e.message);
          throw e;
        } finally {
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }
}
