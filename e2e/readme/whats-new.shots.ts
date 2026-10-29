import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { DemoManifest } from './demo-data';
import { open, readManifest, settle, signIn } from './shot';

// The pictures in the "What's new" popup for 4.7 (src/whatsNew/releases.ts),
// taken in the demo company, light and dark, and saved as WebP in
// public/whats-new/4.7/. Each sketch is drawn here with the editor's own
// tools; the drawing sheet and the issue report are rendered from the PDFs
// the app makes.
//
//   npm run screenshots:whats-new

const OUT = join('public', 'whats-new', '4.7');
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
/** What sits under the app's sidebar (and the sketch editor's header) is left out. */
const SIDEBAR = 64, SKETCH_HEADER = 52;

let m: DemoManifest;
test.beforeAll(() => { m = readManifest(); mkdirSync(OUT, { recursive: true }); });
test.describe.configure({ timeout: 180_000 });

/** Saves part of the screen (or a PNG) as public/whats-new/4.7/<name>[-dark].webp, 1200 px wide. */
async function save(source: Page | Buffer, name: string, theme: Theme = 'light', clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  let raw: Buffer;
  if (Buffer.isBuffer(source)) raw = source;
  else {
    await source.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await source.addStyleTag({ content: '[data-testid="toast-container"] { display: none !important; }' });
    raw = await source.screenshot({ animations: 'disabled', caret: 'hide', clip });
  }
  await sharp(raw).resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 86 })
    .toFile(join(OUT, `${name}${theme === 'dark' ? '-dark' : ''}.webp`));
}
const sketchArea = (page: Page) => {
  const v = page.viewportSize()!;
  return { x: SIDEBAR, y: SKETCH_HEADER, width: v.width - SIDEBAR, height: v.height - SKETCH_HEADER };
};
const appArea = (page: Page) => {
  const v = page.viewportSize()!;
  return { x: SIDEBAR, y: 0, width: v.width - SIDEBAR, height: v.height };
};

// ── Sketch helpers ────────────────────────────────────────────────────────────

async function newSketch(page: Page, name: string) {
  await page.goto('/tools/sketch?new=1');
  await page.getByLabel('Name').fill(name);
  await page.getByTestId('new-sketch-create').click();
  await expect(page.getByTestId('sketch-title')).toBeVisible();
  await page.waitForTimeout(400);
  const box = (await page.getByTestId('sketch-view').boundingBox())!;
  return { box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

const typed = async (page: Page, a: string, b?: string) => {
  await page.getByTestId('sketch-typed-0').fill(a);
  if (b !== undefined) await page.getByTestId('sketch-typed-1').fill(b);
  await page.getByTestId(b !== undefined ? 'sketch-typed-1' : 'sketch-typed-0').press('Enter');
};

/** A line of `length` inches at `angle`° from level, the pointer first moved `toward` the side it goes. */
const typeLine = async (page: Page, at: [number, number], length: string, angle: string, toward: [number, number]) => {
  await page.mouse.move(at[0] + toward[0], at[1] + toward[1]);
  await typed(page, length, angle);
};

const rect = async (page: Page, x: number, y: number, w: string, h: string) => {
  await page.getByTestId('sketch-tool-rect').click();
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.mouse.move(x + 60, y - 60);
  await typed(page, w, h);
};

const pull = async (page: Page, x: number, y: number, d: string) => {
  await page.getByTestId('sketch-view-front').click();
  await page.getByTestId('sketch-tool-pull').click();
  await page.mouse.click(x, y);
  await typed(page, d);
};

/** A stepped cornice profile on the Front plane, 3" × 3", its corner at (x, y). */
async function corniceProfile(page: Page, x: number, y: number) {
  await page.getByTestId('sketch-tool-line').click();
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  const at: [number, number] = [x, y];
  await typeLine(page, at, '1', '0', [200, 0]);
  await typeLine(page, at, '1', '90', [40, -200]);
  await typeLine(page, at, '1', '0', [300, -40]);
  await typeLine(page, at, '1', '90', [80, -250]);
  await typeLine(page, at, '1', '0', [300, -80]);
  await typeLine(page, at, '1', '90', [120, -300]);
  await typeLine(page, at, '3', '0', [-300, -120]);
  await typeLine(page, at, '3', '90', [-100, 200]);
}

const built = (page: Page, text: RegExp | string) =>
  expect(page.locator('.sketch-label-pull', { hasText: text }).first()).toBeVisible({ timeout: 90_000 });

const fitAndSettle = async (page: Page) => {
  await page.getByRole('button', { name: 'Fit' }).click();
  await settle(page);
};

const centre = async (label: ReturnType<Page['locator']>) => {
  const b = (await label.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** The newest Documents file of a kind, as bytes. */
async function newestDocument(page: Page, kind: string): Promise<Buffer> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const auth = { Authorization: `Bearer ${token}` };
  const docs = await (await page.request.get(`/api/documents?kinds=${kind}`, { headers: auth })).json();
  const newest = [...docs.rows].sort((a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt)[0];
  if (!newest) throw new Error(`no ${kind} document`);
  return (await page.request.get(`/api/files/${newest.id}/content`, { headers: auth })).body();
}

/** The first page of a PDF as a PNG `width` px wide, drawn by pdf.js in a blank page. */
async function pdfPage(browser: Browser, pdf: Buffer, width = 1200): Promise<Buffer> {
  const require = createRequire(import.meta.url);
  const lib = readFileSync(require.resolve('pdfjs-dist/legacy/build/pdf.min.mjs'), 'utf8');
  const worker = readFileSync(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'), 'utf8');
  const page = await browser.newPage();
  try {
    const dataUrl = await page.evaluate(async ([libSrc, workerSrc, b64, w]) => {
      const url = (src: string) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const pdfjs = await import(/* @vite-ignore */ url(libSrc as string));
      pdfjs.GlobalWorkerOptions.workerSrc = url(workerSrc as string);
      const bytes = Uint8Array.from(atob(b64 as string), c => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      const p = await doc.getPage(1);
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: (w as number) / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, viewport, canvas }).promise;
      return canvas.toDataURL('image/png');
    }, [lib, worker, pdf.toString('base64'), width] as const);
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  } finally {
    await page.close();
  }
}

/** A section print of cornice C-3 with a 12" dimension, to trace over (made here, so nothing is stored). */
const SECTION_PRINT = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <rect width="1200" height="900" fill="#f5f1e8"/>
  <text x="600" y="110" font-family="Georgia, serif" font-size="44" fill="#6b6b6b" text-anchor="middle" letter-spacing="2">CORNICE C-3 (SECTION)</text>
  <path d="M200 790 L200 210 L330 210 L330 290 A110 110 0 0 1 440 400 L540 400 L540 500 A140 140 0 0 1 680 640 L760 640 L760 700 L900 700 L900 790 Z"
    fill="none" stroke="#4b5563" stroke-width="5" stroke-linejoin="round"/>
  <g stroke="#b45353" stroke-width="3"><line x1="200" y1="830" x2="900" y2="830"/><line x1="200" y1="810" x2="200" y2="850"/><line x1="900" y1="810" x2="900" y2="850"/></g>
  <text x="550" y="880" font-family="Georgia, serif" font-size="40" fill="#b45353" text-anchor="middle">12 in.</text>
</svg>`;

// ── Sketch ────────────────────────────────────────────────────────────────────

for (const theme of THEMES) {
  test(`sketch: a cornice profile pulled into 3D (${theme}), and its drawing sheet`, async ({ page, browser }) => {
    await signIn(page, m, theme);
    const { cx, cy } = await newSketch(page, 'Cornice C-3');
    await corniceProfile(page, cx - 200, cy + 150);
    await pull(page, cx - 185, cy + 135, `-2'`);
    await built(page, `2' - 0"`);
    await page.getByTestId('sketch-view-iso').click();
    await fitAndSettle(page);
    await save(page, 'sketch', theme, sketchArea(page));
    if (theme !== 'light') return;
    // The drawing sheet: Export, Save to Documents, then its first page as a picture.
    await page.getByTestId('sketch-export').click();
    await page.getByTestId('sketch-export-format-pdf').click();
    await page.getByTestId('sketch-export-save').click();
    await expect(page.getByTestId('sketch-export-modal')).toBeHidden({ timeout: 90_000 });
    await save(await pdfPage(browser, await newestDocument(page, 'sketch-export')), 'export');
  });

  test(`sketch: lining up with what is drawn (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    const { cx, cy } = await newSketch(page, 'Panel moulding');
    const x = cx - 100, y = cy + 120;
    await page.getByTestId('sketch-tool-line').click();
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await typeLine(page, [x, y], '6', '0', [200, 0]);
    await typeLine(page, [x, y], '4', '90', [200, -200]);
    // Shift held: a dashed guide runs up from the first corner, and the line's length and angle show.
    await page.keyboard.down('Shift');
    await page.mouse.move(x + 10, y - 300);
    await page.mouse.move(x + 2, y - 320);
    await settle(page);
    await save(page, 'draw-exactly', theme, sketchArea(page));
    await page.keyboard.up('Shift');
  });

  test(`sketch: drawing on a face to cut a hole (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    const { cx, cy } = await newSketch(page, 'Block with a hole');
    await rect(page, cx - 120, cy + 80, '6', '4');
    await pull(page, cx - 100, cy + 60, `-1'`);
    await built(page, `1' - 0"`);
    // Face: the block's front face (its outline labels say where it is), then a circle on it.
    await page.getByTestId('sketch-view-iso').click();
    await settle(page);
    const w = page.locator('.sketch-label-dim', { hasText: /^6"$/ });
    const [a, b] = [await centre(w.nth(0)), await centre(w.nth(1))];
    await page.getByTestId('sketch-plane-face').click();
    await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2);
    await settle(page);
    const [a2, b2] = [await centre(w.nth(0)), await centre(w.nth(1))];
    const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
    await page.getByTestId('sketch-tool-circle').click();
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.click(mid.x, mid.y);
    await page.mouse.move(mid.x + 40, mid.y);
    await typed(page, '1');
    // Pull it in: the cut shows red through the block before it is made.
    await page.getByTestId('sketch-tool-pull').click();
    await page.mouse.click(mid.x + 3, mid.y + 3);
    await page.getByTestId('sketch-view-iso').click();
    await settle(page);
    await page.getByTestId('sketch-typed-0').fill('-10');
    await page.mouse.move(cx + 300, cy - 200);
    await settle(page);
    await save(page, 'faces', theme, sketchArea(page));
  });

  test(`sketch: a cornice run round a room and a turned column (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    const { cx: vx, cy: vy } = await newSketch(page, 'Cornice run');
    const cx = vx - 200, cy = vy + 150;
    await corniceProfile(page, cx, cy);
    // The path on Ground: back 12", across 12", forward 6".
    await page.getByTestId('sketch-plane-ground').click();
    await page.getByTestId('sketch-tool-line').click();
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy);
    await page.mouse.move(cx, cy - 200);
    await typeLine(page, [cx, cy], '12', '90', [0, -250]);
    await typeLine(page, [cx, cy], '12', '0', [300, -250]);
    await typeLine(page, [cx, cy], '6', '90', [400, 100]);
    await page.keyboard.press('Escape');
    await page.mouse.move(cx + 500, cy - 300);
    await page.keyboard.press('Enter');
    await page.getByTestId('sketch-view-front').click();
    await page.getByTestId('sketch-tool-run').click();
    await page.mouse.click(cx + 20, cy - 20);
    // The path, seen from above: its first length label sits on it.
    await page.getByTestId('sketch-view-top').click();
    await settle(page);
    const leg = await centre(page.locator('.sketch-label-dim', { hasText: `1' - 0"` }).first());
    await page.mouse.click(leg.x, leg.y);
    await expect(page.getByTestId('sketch-step-0')).toContainText('Run along a path', { timeout: 90_000 });
    // A column: a 1" × 8" strip spun round a line beside it.
    await page.getByTestId('sketch-view-front').click();
    await page.getByTestId('sketch-plane-front').click();
    const sx = cx + 600, sy = cy;
    await rect(page, sx, sy, '1', '8');
    await page.getByTestId('sketch-tool-spin').click();
    await page.mouse.click(sx + 12, sy - 40);
    await page.mouse.move(sx - 60, sy);
    await page.mouse.click(sx - 60, sy);
    await page.mouse.move(sx - 60, sy - 150);
    await page.mouse.click(sx - 60, sy - 150);
    await built(page, '⟳ 360°');
    await page.getByTestId('sketch-tool-select').click();
    await page.getByTestId('sketch-view-iso').click();
    await fitAndSettle(page);
    await save(page, 'spin-run', theme, sketchArea(page));
  });

  test(`sketch: join, copy and mirror (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    const { cx: vx, cy: vy } = await newSketch(page, 'Corbels');
    const cx = vx - 250, cy = vy + 60;
    await rect(page, cx, cy, '4', '2');
    await rect(page, cx + 100, cy, '2', '4');
    await pull(page, cx + 40, cy - 30, '-2');
    await pull(page, cx + 150, cy - 100, '-3');
    await page.getByTestId('sketch-view-front').click();
    await page.getByTestId('sketch-tool-combine').click();
    await page.mouse.click(cx + 40, cy - 30);
    await page.mouse.click(cx + 150, cy - 100);
    await expect(page.getByTestId('sketch-step-2')).toContainText('Join', { timeout: 90_000 });
    await page.getByTestId('sketch-tool-move').click();
    await page.getByTestId('sketch-copies').fill('2');
    await page.mouse.click(cx + 40, cy - 30);
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy);
    await page.mouse.move(cx + 250, cy - 10);
    await typed(page, '7', '0');
    await page.getByTestId('sketch-tool-mirror').click();
    await page.mouse.click(cx + 40, cy - 30);
    await page.mouse.move(cx - 30, cy);
    await page.mouse.click(cx - 30, cy);
    await page.mouse.move(cx - 30, cy - 120);
    await page.mouse.click(cx - 30, cy - 120);
    await expect(page.getByTestId('sketch-step-4')).toBeVisible({ timeout: 90_000 });
    await page.getByTestId('sketch-tool-select').click();
    await page.getByTestId('sketch-view-iso').click();
    await page.waitForTimeout(2500);
    await fitAndSettle(page);
    await save(page, 'solids', theme, sketchArea(page));
  });

  test(`sketch: a section print scaled to trace over (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    await newSketch(page, 'Cornice C-3 from the print');
    await page.getByTestId('sketch-add-photo').click();
    await page.getByTestId('picker-upload-input').setInputFiles({
      name: 'cornice-c3-section.png', mimeType: 'image/png', buffer: await sharp(Buffer.from(SECTION_PRINT)).png().toBuffer(),
    });
    await expect(page.getByTestId('picker-upload-panel')).toBeHidden({ timeout: 30_000 });
    await settle(page);
    // Set scale on the 12" dimension under the profile.
    const box = (await page.getByTestId('sketch-view').boundingBox())!;
    const vx = box.x + box.width / 2, vy = box.y + box.height / 2;
    const pw = box.width * 0.6, ph = pw * 0.75;
    const at = (x: number, y: number) => [vx - pw / 2 + x * (pw / 1200), vy - ph / 2 + y * (ph / 900)] as const;
    await page.getByTestId('sketch-ref-scale').click();
    const [ax, ay] = at(200, 830), [bx, by] = at(900, 830);
    await page.mouse.click(ax, ay);
    await page.mouse.move(bx, by);
    await page.mouse.click(bx, by);
    await typed(page, '12');
    await fitAndSettle(page);
    await save(page, 'photos', theme, sketchArea(page));
  });

  test(`sketch: rounding two edges (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    const { cx, cy } = await newSketch(page, 'Rounded block');
    await rect(page, cx - 150, cy + 100, '6', '3');
    await pull(page, cx - 120, cy + 80, '4');
    await built(page, '4"');
    await page.getByTestId('sketch-view-iso').click();
    await fitAndSettle(page);
    await page.getByTestId('sketch-tool-edges').click();
    const w = page.locator('.sketch-label-dim', { hasText: /^6"$/ });
    const h = page.locator('.sketch-label-dim', { hasText: /^3"$/ });
    const top = await centre(w.nth(1)), right = await centre(h.nth(0));
    await page.mouse.move(top.x + 3, top.y + 3);
    await page.mouse.click(top.x + 3, top.y + 3);
    await page.mouse.move(right.x, right.y);
    await page.mouse.click(right.x, right.y);
    await page.getByTestId('sketch-typed-0').fill('1/2');
    await page.mouse.move(cx + 400, cy + 250);
    await page.waitForTimeout(3000);
    await settle(page);
    await save(page, 'round', theme, sketchArea(page));
  });

  test(`sketch: aiming with a finger on an iPad (${theme})`, async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 1180, height: 820 } });
    const page = await ctx.newPage();
    try {
      await signIn(page, m, theme);
      const { cx, cy } = await newSketch(page, 'Window head');
      const cdp = await ctx.newCDPSession(page);
      const tap = async (x: number, y: number) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      await page.getByTestId('sketch-tool-line').tap();
      const x = cx - 150, y = cy + 100;
      await tap(x, y);
      await tap(x + 200, y);
      // A finger down and sliding: the next line follows it, its length shown above the fingertip.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + 210, y: y - 100, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 200, y: y - 160, id: 1 }] });
      await settle(page);
      // 16:10 like the other pictures, cut from the top so the bar with Back, Done and Cancel stays.
      const area = sketchArea(page), h = Math.round(area.width / 1.6);
      await save(page, 'ipad', theme, { ...area, y: area.y + area.height - h, height: h });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await ctx.close();
    }
  });
}

// ── Takeoff canvas ────────────────────────────────────────────────────────────

const floorPlan = () => `/project/${m.projects.residence}/page/${m.residence.pageFloorPlan}`;

for (const theme of THEMES) {
  test(`canvas: lengths in feet and inches (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    await open(page, floorPlan());
    await page.keyboard.press('Escape');
    await settle(page);
    await save(page, 'labels', theme, appArea(page));
  });
}

test('canvas: quick measurements (light, then dark)', async ({ page }) => {
  await signIn(page, m, 'light');
  await open(page, floorPlan());
  await page.keyboard.press('Escape');
  const box = (await page.getByTestId('canvas-surface').boundingBox())!;
  const at = async (dx: number, dy: number) => {
    await page.mouse.move(box.x + dx, box.y + dy);
    await page.mouse.click(box.x + dx, box.y + dy);
    await page.waitForTimeout(80);
  };
  await page.getByTestId('tool-quick-measure').click();
  const y0 = box.height * 0.3;
  await at(box.width * 0.2, y0);
  await at(box.width * 0.45, y0);
  await page.keyboard.press('Enter');
  await at(box.width * 0.55, y0 - 40);
  await at(box.width * 0.55, y0 + 220);
  await page.keyboard.press('Enter');
  await page.getByTestId('tool-area').click();
  await at(box.width * 0.25, y0 + 120);
  await at(box.width * 0.45, y0 + 120);
  await at(box.width * 0.45, y0 + 260);
  await at(box.width * 0.25, y0 + 260);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-measurements').getByTestId('measurement-row')).toHaveCount(3);
  await settle(page);
  await save(page, 'quick', 'light', appArea(page));
  // The same plan in dark (the sidebar's theme button).
  await page.getByRole('button', { name: 'Dark mode' }).click();
  await settle(page);
  await save(page, 'quick', 'dark', appArea(page));
});

// ── Fixes ─────────────────────────────────────────────────────────────────────

test('fixes: an issue report with its photo the right way up', async ({ page, browser }) => {
  await signIn(page, m, 'light');
  await open(page, `/project/${m.projects.dental}/issues`);
  await page.getByText('Hairline cracking at the existing corner').click();
  await page.getByTestId('doc-generate').click();
  await expect(page.getByTestId('doc-open')).toBeVisible({ timeout: 60_000 });
  const sheet = await pdfPage(browser, await newestDocument(page, 'issue-report'));
  // The top of the page: the heading and the photos.
  const meta = await sharp(sheet).metadata();
  await save(await sharp(sheet).extract({ left: 0, top: 0, width: meta.width!, height: Math.round(meta.width! * 0.56) }).png().toBuffer(), 'fix-photos');
});

for (const theme of THEMES) {
  test(`fixes: each file's type beside its name (${theme})`, async ({ page }) => {
    await signIn(page, m, theme);
    await open(page, '/documents');
    await page.getByTestId('documents-upload').click();
    const modal = page.getByTestId('documents-upload-modal');
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#9ca3af' } }).png().toBuffer();
    await modal.locator('input[type="file"]').setInputFiles([
      { name: 'A-101 Floor Plan - Permit Set Revision 3.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
      { name: 'IMG_20261028_north_elevation.jpg', mimeType: 'image/png', buffer: png },
      { name: 'Takeoff totals.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') },
    ]);
    await settle(page);
    const dialog = (await page.getByRole('dialog').boundingBox())!;
    const pad = 24;
    await save(page, 'fix-upload', theme, { x: dialog.x - pad, y: dialog.y - pad, width: dialog.width + 2 * pad, height: dialog.height + 2 * pad });
  });
}
