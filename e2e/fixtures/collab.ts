import type { Browser } from '@playwright/test';

// Shared helper for the collab-* specs: two independently-authenticated
// browser contexts (two real socket connections, same JWT) mirror two
// tabs/devices for the same user. Lifted from collab-presence.spec.ts,
// extended with the optional `blockSocket` opt collab-canvas-conflict.spec.ts
// needs to force its REST-only-refetch scenario (Fix C1) — omitting `opts`
// behaves identically to the original plain three-arg version.
export async function openAuthedContext(
  browser: Browser, token: string, user: unknown, opts: { blockSocket?: boolean } = {},
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (opts.blockSocket) {
    await page.route('**/socket.io/**', route => route.abort());
  }
  await page.addInitScript(
    ([tok, userJson]) => {
      localStorage.setItem('token', tok);
      localStorage.setItem('user', userJson);
    },
    [token, JSON.stringify(user)] as const,
  );
  return { context, page };
}
