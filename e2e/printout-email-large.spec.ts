import { test, expect } from './fixtures/test';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

// Real-plan-set proof for the transport fix + email shrink. Gated on the big
// local fixture so CI never pays the 60MB cost — run it locally as the
// real-browser proof (house rule for canvas-adjacent changes).
const BIG_PDF = process.env.BIG_PLAN_PDF ?? 'docs/large-plan-set.pdf';

test.skip(!existsSync(BIG_PDF), 'big plan-set fixture not present');
test.setTimeout(600_000);

test('email-mode printout of a 60MB plan set lands under the 18MB target', async ({
  authedPage,
  apiToken,
  request,
}) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };

  const pdfBytes = readFileSync(BIG_PDF);

  // Read the fixture's real page geometry with pdf-lib instead of hardcoding —
  // this fixture happens to use a center-origin MediaBox (e.g.
  // [-1512, -1080.12, 3024, 2160.24]), exactly the case pdfOverlayTransform.ts
  // exists to handle correctly.
  const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pageCount = srcDoc.getPageCount();
  const firstPage = srcDoc.getPage(0);
  const pageWidthPt = firstPage.getWidth();
  const pageHeightPt = firstPage.getHeight();

  // 1. Upload the source PDF via the raw streaming endpoint (the transport fix
  //    under test — base64-in-JSON would die at the server's JSON body cap for
  //    a file this size).
  const srcFileId = randomUUID();
  const upload = await request.post(`/api/files/${srcFileId}`, {
    headers: { ...auth, 'Content-Type': 'application/pdf' },
    data: pdfBytes,
  });
  expect(upload.ok()).toBeTruthy();

  // 2. Seed a project whose pages all reference the source PDF (vector path),
  //    one page per source page, each carrying a length measurement wired to a
  //    single takeoff so Print picks up every page. Points were captured
  //    against a page rendered at pdf.js's 2.0x scale, so imageWidth/Height
  //    are 2x the real PDF page size in points.
  const projectId = randomUUID();
  const takeoffId = randomUUID();
  const imageWidth = 2 * pageWidthPt;
  const imageHeight = 2 * pageHeightPt;

  const pages = Array.from({ length: pageCount }, (_, i) => {
    const pageNum = i + 1;
    return {
      id: randomUUID(),
      name: `Sheet ${pageNum}`,
      imageId: '',
      imageWidth,
      imageHeight,
      sourcePdfFileId: srcFileId,
      sourcePdfPageNum: pageNum,
      measurements: [
        {
          id: randomUUID(),
          type: 'length',
          name: `Wall ${pageNum}`,
          color: '#3b82f6',
          takeoffId,
          points: [
            { x: 200, y: 200 },
            { x: 800, y: 200 },
          ],
        },
      ],
      scaleConfig: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' },
    };
  });

  const project = {
    id: projectId,
    name: `E2E Email-Quality Large Project ${projectId.slice(0, 8)}`,
    createdAt: Date.now(),
    takeoffs: [
      { id: takeoffId, name: 'Perimeter Wall', color: '#3b82f6', type: 'length', unit: 'ft', costPerUnit: 5 },
    ],
    pages,
    version: 1,
    status: 'bidding',
  };

  const projRes = await request.post('/api/projects', { headers: auth, data: project });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  // 3. Print with Email-ready quality (UI), wait for the proposal page. This is
  //    a ~63MB vector printout (40 copied source pages), forcing shrinkPdfToBudget
  //    to actually re-render pages to JPEGs to hit the 18MB target.
  await authedPage.goto(`/project/${projectId}/takeoff?tab=takeoffs`);
  await expect(authedPage.getByTestId('takeoffs-table')).toBeVisible();

  const row = authedPage.getByTestId('takeoffs-table').getByTestId('takeoff-row').first();
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();

  await authedPage.getByTestId('print-quality-select').selectOption('email');
  await authedPage.getByTestId('btn-print').click();

  // Print saves a `takeoff-print` document and lands on the filtered Documents
  // view (spec 2026-08-28-proposal-rework Task 9 — project.printouts[] is gone).
  await expect(authedPage).toHaveURL(
    new RegExp(`/documents\\?projectIds=${projectId}&kinds=takeoff-print(,|%2C)takeoff-export`),
    { timeout: 480_000 },
  );
  await expect(authedPage.getByText(/^Takeoff Print – /).first()).toBeVisible({ timeout: 15_000 });

  // 4. Fetch the recorded print's raw bytes and assert the budget.
  const docsRes = await request.get(
    `/api/documents?projectIds=${projectId}&kinds=takeoff-print`, { headers: auth });
  expect(docsRes.ok()).toBeTruthy();
  const rows = (await docsRes.json()).rows as { id: string }[];
  expect(rows.length).toBeGreaterThan(0);

  const head = await request.head(`/api/images/${rows[0].id}/raw`, { headers: auth });
  expect(head.ok()).toBeTruthy();
  const size = Number(head.headers()['content-length']);
  expect(size).toBeLessThanOrEqual(18 * 1024 * 1024);
  expect(size).toBeGreaterThan(1024 * 1024); // sanity: real content, not an empty/failed save
});
