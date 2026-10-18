// server/onlyoffice/config.ts — where the ONLYOFFICE Document Server lives and
// how it and this app reach each other, read from the environment
// (docs/onlyoffice-setup.md; checklist docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).
//
// Three addresses because three different parties make the calls: browsers
// load the editor from the public HTTPS subdomain, while the two servers talk
// to each other over the Docker network, where the public name may not even
// resolve (and a hairpin through Cloudflare would be slow and fragile).

export interface OnlyofficeConfig {
  /** What browsers load api.js from: ONLYOFFICE's own HTTPS subdomain. */
  publicUrl: string;
  /** What this server calls for commands and conversions. */
  internalUrl: string;
  /** What ONLYOFFICE calls to download files from this app and post saves back. */
  appInternalUrl: string;
  /** Shared with the Document Server's JWT_SECRET; signs everything between the two. */
  jwtSecret: string;
}

export interface OnlyofficeConfigProblem { variable: string; problem: string }

// One shape rather than a `configured: true | false` union: this project
// compiles without strictNullChecks, where the false half would not narrow.
export interface OnlyofficeConfigResult {
  config: OnlyofficeConfig | null;
  problems: OnlyofficeConfigProblem[];
}

const trimSlashes = (s: string) => s.replace(/\/+$/, '');

/** A usable http(s) base URL with no trailing slash, or null. */
function baseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return trimSlashes(u.origin + u.pathname);
  } catch {
    return null;
  }
}

export function readOnlyofficeConfig(env: NodeJS.ProcessEnv): OnlyofficeConfigResult {
  const problems: OnlyofficeConfigProblem[] = [];
  const val = (name: string) => (env[name] || '').trim();

  const url = (name: string, fallbackName?: string): string | null => {
    const own = val(name);
    const raw = own || (fallbackName ? val(fallbackName) : '');
    if (!raw) return null;
    const parsed = baseUrl(raw);
    if (!parsed) problems.push({ variable: own ? name : fallbackName!, problem: `"${raw}" is not an http:// or https:// address.` });
    return parsed;
  };

  const publicUrl = url('ONLYOFFICE_PUBLIC_URL');
  if (!val('ONLYOFFICE_PUBLIC_URL')) {
    problems.push({ variable: 'ONLYOFFICE_PUBLIC_URL', problem: 'Not set. Use the HTTPS address browsers reach ONLYOFFICE at, e.g. https://docs.example.com.' });
  }
  const internalUrl = url('ONLYOFFICE_INTERNAL_URL') ?? publicUrl;
  const appInternalUrl = url('APP_INTERNAL_URL', 'APP_PUBLIC_URL');
  if (!val('APP_INTERNAL_URL') && !val('APP_PUBLIC_URL')) {
    problems.push({ variable: 'APP_INTERNAL_URL', problem: 'Not set. Use the address ONLYOFFICE reaches this app at, e.g. http://app:3000 on a shared Docker network.' });
  }
  const jwtSecret = val('ONLYOFFICE_JWT_SECRET');
  if (!jwtSecret) {
    problems.push({ variable: 'ONLYOFFICE_JWT_SECRET', problem: 'Not set. It must equal JWT_SECRET on the ONLYOFFICE container.' });
  }

  if (problems.length || !publicUrl || !internalUrl || !appInternalUrl) return { config: null, problems };
  return { config: { publicUrl, internalUrl, appInternalUrl, jwtSecret }, problems };
}
