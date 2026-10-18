import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import type { DemoManifest } from './demo-data';

// Shared helpers for the *.shots.ts specs: sign in, open a screen, wait for it
// to settle, hide moving parts, and save a compressed PNG in docs/screenshots.

export const OUT_DIR = join('docs', 'screenshots');

export function readManifest(): DemoManifest {
  const dir = process.env.DEMO_DATA_DIR ?? '.demo-data';
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as DemoManifest;
}

let session: { token: string; user: unknown } | undefined;

/** Signs in through the API and puts the session (and theme) in localStorage before any page loads. */
export async function signIn(page: Page, m: DemoManifest, theme: 'light' | 'dark' = 'light'): Promise<void> {
  const recent = [m.projects.dental, m.projects.residence, m.projects.townhomes, m.projects.gym];
  // One sign-in for the whole run: the login route is rate limited.
  if (!session) {
    const res = await page.request.post('/api/auth/login', { data: m.login });
    if (!res.ok()) throw new Error(`demo login failed: ${res.status()}`);
    session = (await res.json()) as { token: string; user: unknown };
  }
  const body = session;
  // The app keeps the theme in the account's preferences and they win over localStorage, so set them here.
  const prefs = await page.request.put('/api/user-preferences', {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { 'theme-mode': theme, 'theme-ambience': 'off', 'theme-motion': 'reduced' },
  });
  if (!prefs.ok()) throw new Error(`demo preferences failed: ${prefs.status()}`);
  await page.addInitScript(
    ([token, user, mode, recents]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
      localStorage.setItem('theme-mode', mode);
      // A steady look from run to run: no time-of-day tint, no motion.
      localStorage.setItem('theme-ambience', 'off');
      localStorage.setItem('theme-motion', 'reduced');
      // The Recent row on the Projects page reads this list.
      localStorage.setItem('recentProjects', recents);
    },
    [body.token, JSON.stringify(body.user), theme, JSON.stringify(recent.map((id, i) => ({ id, name: '', at: Date.now() - i * 60_000 })))] as const,
  );
}

const QUIET_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
  [data-testid="toast"], [role="status"][class*="toast" i], .toast, .Toastify { display: none !important; }
`;

/** The demo data is stamped with the seed time, so feeds say "just now". Say "today" instead. */
async function softenTimes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue ?? '';
      if (/just now|^\s*now\s*$/i.test(t)) n.nodeValue = t.replace(/just now/i, 'today').replace(/^(\s*)now(\s*)$/i, '$1today$2');
    }
  });
}

export async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: QUIET_CSS });
  await page.evaluate(() => document.fonts.ready);
  // Images and canvases that are still loading.
  await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && (i.naturalWidth > 0 || !i.src)), undefined, { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600);
}

/** Opens a path and waits for it to settle. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await settle(page);
}

/** Saves the current page as docs/screenshots/<name>.png, palette-compressed. */
export async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await softenTimes(page);
  // No focus ring left on whatever the app focused when a dialog opened.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const raw = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await sharp(raw)
    .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10, colours: 256 })
    .toFile(join(OUT_DIR, `${name}.png`));
}
