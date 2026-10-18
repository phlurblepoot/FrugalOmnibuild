// src/utils/onlyofficeApi.ts — loads ONLYOFFICE's editor script (api.js) from
// the Document Server's public address. The script defines window.DocsAPI,
// which every embedded editor is created through.
//
// Loaded once per address and cached; a failed load is forgotten so the next
// attempt (e.g. "Check again" in Settings) really retries.
import type { OnlyofficeCheck } from './store';

/** The methods this app calls on a running editor (ONLYOFFICE Docs API). */
export interface DocsEditorInstance {
  destroyEditor?: () => void;
  refreshHistory?: (data: unknown) => void;
  setHistoryData?: (data: unknown) => void;
  insertImage?: (data: unknown) => void;
  /** Answers onRequestUsers (e.g. who can be @mentioned). */
  setUsers?: (data: unknown) => void;
  /** Answers onMakeActionLink with the link to a comment. */
  setActionLink?: (link: string) => void;
}

declare global {
  interface Window {
    DocsAPI?: { DocEditor: { new (placeholderId: string, config: unknown): DocsEditorInstance; version?: () => string } };
  }
}

export const docsApiUrl = (publicUrl: string): string => `${publicUrl}/web-apps/apps/api/documents/api.js`;

const loads = new Map<string, Promise<void>>();

export function loadDocsApi(publicUrl: string, timeoutMs = 15_000): Promise<void> {
  const cached = loads.get(publicUrl);
  if (cached) return cached;
  const load = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = (reason: string) => {
      clearTimeout(timer);
      script.remove();
      loads.delete(publicUrl);
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('timed out'), timeoutMs);
    script.src = docsApiUrl(publicUrl);
    script.async = true;
    script.onload = () => {
      if (!window.DocsAPI?.DocEditor) return fail("it loaded, but it isn't ONLYOFFICE's editor script");
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => fail('the request failed');
    document.head.appendChild(script);
  });
  loads.set(publicUrl, load);
  return load;
}

/** The editor script's own version, once loaded. */
export function docsApiVersion(): string | null {
  try {
    return window.DocsAPI?.DocEditor?.version?.() ?? null;
  } catch {
    return null;
  }
}

/** Whether this browser can load the editor from `publicUrl`: the one check
 *  the server can't make for us (it sees neither Cloudflare nor the proxy the
 *  way a browser does). */
export async function checkEditorScript(publicUrl: string, pageProtocol = window.location.protocol): Promise<OnlyofficeCheck> {
  if (pageProtocol === 'https:' && publicUrl.startsWith('http:')) {
    return {
      status: 'failed',
      message: `This app is open over HTTPS, so browsers block an editor served from ${publicUrl}. `
        + 'Give ONLYOFFICE an https:// address and set ONLYOFFICE_PUBLIC_URL to it.',
    };
  }
  try {
    await loadDocsApi(publicUrl);
    const version = docsApiVersion();
    return { status: 'ok', message: `Your browser loaded the editor from ${publicUrl}${version ? ` (ONLYOFFICE ${version})` : ''}.` };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown error';
    return {
      status: 'failed',
      message: `Your browser couldn't load ${docsApiUrl(publicUrl)} (${reason}). `
        + 'Check the subdomain\'s DNS record in Cloudflare, its proxy host and SSL certificate in Nginx Proxy Manager, and that ONLYOFFICE_PUBLIC_URL matches that address.',
    };
  }
}
