import type { Page } from '@playwright/test';
import { test, expect, login, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// ─────────────────────────────────────────────────────────────────────────────
// Task 12 acceptance proof (2026-09-05 UI rehaul, Wave 3): presence cursor
// personality on the canvas. Two independently-authenticated browser
// contexts (same idiom as collab-canvas-sync.spec.ts) prove that context A's
// mouse movement on the canvas produces a live, MOVING remote-cursor Group
// on context B's canvas — the RemoteCursor component (PdfCanvas.tsx) tags
// its Konva Group with name="remote-cursor" specifically so this kind of
// proof (and any future one) can find it without depending on internals.
//
// This does not assert on the lerp math itself (that's unit-tested in
// src/utils/presence.test.ts — lerpStep/lerp1D/isCursorIdle) — it proves the
// smoothed cursor actually renders and moves end-to-end over the real
// socket + Konva pipeline, with zero changes to the cursor-move
// emit/protocol/throttle.
// ─────────────────────────────────────────────────────────────────────────────

interface Box { x: number; y: number; width: number; height: number; }

async function surfaceBox(page: Page): Promise<Box> {
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error('canvas-surface has no bounding box');
  return box;
}

async function gotoCanvas(page: Page, projectId: string, pageId: string) {
  await page.goto(`/project/${projectId}/page/${pageId}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
  await page.waitForTimeout(400);
}

/** Reads the first `.remote-cursor` Konva Group's absolute position + name
 * tag text straight off the live stage (same `window.Konva.stages[0]` idiom
 * as collab-canvas-sync.spec.ts's `imagePointToScreen`). */
async function readRemoteCursor(page: Page): Promise<{ x: number; y: number; name: string } | null> {
  return page.evaluate(() => {
    const K = (window as any).Konva;
    const stage = K?.stages?.[0];
    if (!stage) return null;
    const node = stage.findOne('.remote-cursor');
    if (!node) return null;
    const text = node.findOne('Text');
    return { x: node.x(), y: node.y(), name: text ? text.text() : '' };
  });
}

test.describe('Task 12: presence cursor personality', () => {
  test('a remote cursor renders, is named, and glides between mouse positions on another session', async ({
    browser, request,
  }) => {
    test.setTimeout(45_000);
    const { token, user } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });

    // Same idiom as collab-canvas-sync.spec.ts: two sessions for the same
    // authenticated user mirror two open tabs/devices, each with its own
    // socket connection and session id — exactly what the cursor layer's
    // `u.id !== currentUserId` filter is built to distinguish.
    const a = await openAuthedContext(browser, token, user);
    const b = await openAuthedContext(browser, token, user);

    try {
      await gotoCanvas(a.page, projectId, pageId);
      await gotoCanvas(b.page, projectId, pageId);

      const boxA = await surfaceBox(a.page);
      const cy = boxA.height / 2;

      // First position: move A's mouse onto the canvas so a cursor-move
      // event fires, and wait for B to render the remote cursor.
      const p1 = { dx: boxA.width / 2 - 150, dy: cy - 60 };
      await a.page.mouse.move(boxA.x + p1.dx, boxA.y + p1.dy);
      await a.page.mouse.move(boxA.x + p1.dx + 3, boxA.y + p1.dy + 3); // clears the >=2px send threshold

      await b.page.waitForFunction(() => {
        const K = (window as any).Konva;
        const stage = K?.stages?.[0];
        return !!stage?.findOne('.remote-cursor');
      }, { timeout: 15_000 });
      // Let B's rAF lerp loop settle toward the first target before sampling.
      await b.page.waitForTimeout(500);

      const sample1 = await readRemoteCursor(b.page);
      expect(sample1).not.toBeNull();
      // The name tag must show A's actual username (session name derives
      // from the verified JWT's `username`, per server/realtime/types.ts).
      expect(sample1!.name).toBe(user.username);
      await b.page.screenshot({ path: '.superpowers/t12-cursor-1.png' });

      // Second position: move A's mouse well away from the first spot.
      const p2 = { dx: boxA.width / 2 + 180, dy: cy + 120 };
      await a.page.mouse.move(boxA.x + p2.dx, boxA.y + p2.dy);
      await a.page.mouse.move(boxA.x + p2.dx + 3, boxA.y + p2.dy + 3);
      // Give the socket round-trip + several rAF frames to move and settle.
      await b.page.waitForTimeout(600);

      const sample2 = await readRemoteCursor(b.page);
      expect(sample2).not.toBeNull();
      await b.page.screenshot({ path: '.superpowers/t12-cursor-2.png' });

      // The cursor Group must actually have MOVED between the two samples —
      // the core smoothed-cursor proof.
      expect(sample2!.x !== sample1!.x || sample2!.y !== sample1!.y).toBe(true);
      // And it should have moved toward the second target's neighborhood,
      // not to some unrelated point (rules out a stuck/garbage position).
      expect(sample2!.x).toBeGreaterThan(sample1!.x);
      expect(sample2!.y).toBeGreaterThan(sample1!.y);
    } finally {
      await a.context.close().catch(() => {});
      await b.context.close().catch(() => {});
    }
  });
});
