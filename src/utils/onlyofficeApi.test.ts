import { describe, it, expect, beforeEach } from 'vitest';
import { checkEditorScript, docsApiUrl, loadDocsApi } from './onlyofficeApi';

// jsdom never fetches <script src>, so each test plays the browser: it finds
// the tag the loader appended and fires the event the real load would.
const lastScript = (publicUrl: string) =>
  [...document.head.querySelectorAll('script')].reverse().find(s => s.src === docsApiUrl(publicUrl)) as HTMLScriptElement | undefined;

const fakeDocsApi = () => {
  window.DocsAPI = { DocEditor: Object.assign(function DocEditor() {}, { version: () => '9.4.0.1' }) as any };
};

beforeEach(() => {
  delete window.DocsAPI;
  document.head.querySelectorAll('script').forEach(s => s.remove());
});

describe('checkEditorScript', () => {
  it('fails fast on an http:// editor address when the app is on HTTPS, without loading anything', async () => {
    const r = await checkEditorScript('http://docs.example.com', 'https:');
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/HTTPS/);
    expect(lastScript('http://docs.example.com')).toBeUndefined();
  });

  it('reports success with the editor version once api.js loads', async () => {
    const url = 'https://ok.example.com';
    const pending = checkEditorScript(url, 'https:');
    fakeDocsApi();
    lastScript(url)!.dispatchEvent(new Event('load'));
    const r = await pending;
    expect(r).toEqual({ status: 'ok', message: `Your browser loaded the editor from ${url} (ONLYOFFICE 9.4.0.1).` });
  });

  it('names the api.js address and the things to check when the request fails', async () => {
    const url = 'https://down.example.com';
    const pending = checkEditorScript(url, 'https:');
    lastScript(url)!.dispatchEvent(new Event('error'));
    const r = await pending;
    expect(r.status).toBe('failed');
    expect(r.message).toContain(`${url}/web-apps/apps/api/documents/api.js`);
    expect(r.message).toContain('Nginx Proxy Manager');
  });

  it('fails when something answers but it is not the ONLYOFFICE script', async () => {
    const url = 'https://wrong.example.com';
    const pending = checkEditorScript(url, 'https:');
    lastScript(url)!.dispatchEvent(new Event('load'));
    expect((await pending).message).toMatch(/isn't ONLYOFFICE's editor script/);
  });
});

describe('loadDocsApi', () => {
  it('loads once per address, but retries after a failure', async () => {
    const url = 'https://retry.example.com';
    const first = loadDocsApi(url);
    lastScript(url)!.dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow('the request failed');
    expect(lastScript(url)).toBeUndefined();

    const second = loadDocsApi(url);
    expect(loadDocsApi(url)).toBe(second);
    fakeDocsApi();
    lastScript(url)!.dispatchEvent(new Event('load'));
    await expect(second).resolves.toBeUndefined();
    expect(loadDocsApi(url)).toBe(second);
  });
});
