import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PAGE_PNG = join(__dirname, 'assets', 'test-page.png');

// Local YYYY-MM-DD offset from today — mirrors server/customerStore.ts's
// todayStr() comparison base. Using toISOString() (UTC) here would drift a
// day off local "today" depending on timezone and time of day, so a fixture
// meant to be "yesterday" could equal today's local date and never trip the
// overdue branch.
function daysFromToday(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface LoginResult {
  token: string;
  user: { id: string; username: string; role: string };
}

/**
 * Log in as the bootstrap admin/admin user and return the parsed body
 * `{ token, user: { id, username, role } }`. Throws if the response is not ok.
 */
export async function login(request: APIRequestContext): Promise<LoginResult> {
  const res = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  if (!res.ok()) {
    throw new Error(`login failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as LoginResult;
  if (!body.token || !body.user) {
    throw new Error(`login response missing token/user: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Create a genuinely distinct second user (via the admin-only POST /api/users
 * route, using an already-authenticated admin token) and log in as them.
 * Needed for realtime specs that must prove cross-account behavior (e.g.
 * Follow, which is deliberately gated off for two sessions of the SAME
 * account) — openAuthedContext alone only gives two sockets sharing one JWT.
 * Throws if user creation or the subsequent login fails.
 */
export async function loginAsNewUser(
  request: APIRequestContext, adminToken: string, opts: { role?: 'admin' | 'user' } = {},
): Promise<LoginResult> {
  const username = `e2e-${randomUUID().slice(0, 8)}`;
  const password = 'e2e-password-1234';
  const createRes = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { username, password, role: opts.role ?? 'user' },
  });
  if (!createRes.ok()) {
    throw new Error(`user creation failed: ${createRes.status()} ${await createRes.text()}`);
  }
  const res = await request.post('/api/auth/login', { data: { username, password } });
  if (!res.ok()) {
    throw new Error(`login as new user failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as LoginResult;
  if (!body.token || !body.user) {
    throw new Error(`login response missing token/user: ${JSON.stringify(body)}`);
  }
  return body;
}

export interface SeedResult {
  projectId: string;
  pageId: string;
  imageId: string;
  name: string;
}

/**
 * Seed a project with a single page backed by a 1000x800 PNG image, via the
 * REST API. Returns the generated ids. Throws if any request fails.
 */
export async function seedProjectWithPage(
  request: APIRequestContext,
  token: string,
  opts: { withScale?: boolean } = {},
): Promise<SeedResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const pageId = randomUUID();
  const imageId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Test Project ${short}`;

  // 1. Upload the page image as a data URL.
  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  const imgRes = await request.post('/api/images', {
    headers: auth,
    data: { id: imageId, data: dataUrl },
  });
  if (!imgRes.ok()) {
    throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
  }

  // 2. Create the project. createProject() validates: id (string), pages (array,
  //    each with an id), takeoffs (array). version is assigned server-side (1).
  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [],
    pages: [
      {
        id: pageId,
        name: 'Sheet 1',
        imageId,
        imageWidth: 1000,
        imageHeight: 800,
        measurements: [],
        scaleConfig: opts.withScale
          ? { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' }
          : null,
      },
    ],
    version: 1,
    status: 'bidding',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, pageId, imageId, name };
}

export interface SeedVectorPageResult {
  projectId: string;
  pageId: string;
  sourcePdfFileId: string;
  thumbnailId: string;
  name: string;
}

/**
 * Seed a project with ONE VECTOR page — `sourcePdfFileId` + `sourcePdfPageNum`
 * set, `imageId` empty — the canvas render path that fetches its source PDF
 * on demand via pdf.js instead of loading a pre-rasterized image. Used by
 * e2e/canvas-vector-load.spec.ts to prove the source PDF is fetched exactly
 * ONCE per canvas visit: the WS4 regression was an unguarded reload on the
 * socket's very first ('initial') connect event that re-ran loadData a
 * second time on every mount, restarting the source-PDF /raw fetch and
 * aborting the first in-flight one — which defeats the browser HTTP cache
 * (aborted downloads never get cached) so large plan-set PDFs re-downloaded
 * in full on every visit instead of loading instantly from cache.
 *
 * The PDF is a real 2-page pdf-lib document with a filled rectangle + text on
 * page 1 (visible content, not a blank page) — same idiom as
 * seedDocumentsPortfolio's printout fixture. A thumbnail PNG is also seeded
 * (thumbnailId, reusing the existing test-page.png fixture) so the
 * loading-placeholder UI can be asserted too.
 */
export async function seedProjectWithVectorPage(
  request: APIRequestContext,
  token: string,
): Promise<SeedVectorPageResult> {
  const auth = { Authorization: `Bearer ${token}` };
  const projectId = randomUUID();
  const pageId = randomUUID();
  const pdfFileId = randomUUID();
  const thumbnailId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Vector Page Project ${short}`;

  // Letter-size (850×1100pt) PDF; PdfCanvas renders at a base scale of 2.0×,
  // so imageWidth/imageHeight below (1700×2200) match what the real add-pages
  // flow computes for a page at this size.
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page1 = pdfDoc.addPage([850, 1100]);
  page1.drawRectangle({ x: 100, y: 800, width: 300, height: 200, color: rgb(0.2, 0.4, 0.8) });
  page1.drawText('E2E VECTOR SHEET', { x: 100, y: 1000, size: 24, font, color: rgb(0, 0, 0) });
  pdfDoc.addPage([850, 1100]);
  const pdfBytes = await pdfDoc.save();

  const pdfUploadRes = await request.post(
    `/api/files/${pdfFileId}?projectId=${projectId}&kind=plan-source&sourceType=plan-set&sourceId=${projectId}` +
    `&name=${encodeURIComponent('e2e-vector-sheet.pdf')}`,
    { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from(pdfBytes) },
  );
  if (!pdfUploadRes.ok()) throw new Error(`pdf upload failed: ${pdfUploadRes.status()} ${await pdfUploadRes.text()}`);

  // Thumbnail — same data-URL upload idiom as seedProjectWithPage's page image.
  const thumbBase64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const thumbDataUrl = `data:image/png;base64,${thumbBase64}`;
  const thumbRes = await request.post('/api/images', {
    headers: auth,
    data: { id: thumbnailId, data: thumbDataUrl },
  });
  if (!thumbRes.ok()) throw new Error(`thumbnail upload failed: ${thumbRes.status()} ${await thumbRes.text()}`);

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [],
    pages: [
      {
        id: pageId,
        name: 'Sheet 1',
        imageId: '',
        thumbnailId,
        imageWidth: 1700,
        imageHeight: 2200,
        sourcePdfFileId: pdfFileId,
        sourcePdfPageNum: 1,
        measurements: [],
        scaleConfig: null,
      },
    ],
    version: 1,
    status: 'bidding',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, pageId, sourcePdfFileId: pdfFileId, thumbnailId, name };
}

export interface SeedVectorPagesResult {
  projectId: string;
  page1Id: string;
  page2Id: string;
  sourcePdfFileId: string;
  thumbnailId: string;
  name: string;
}

/**
 * Variant of seedProjectWithVectorPage with TWO project pages
 * (sourcePdfPageNum 1 and 2) both backed by the SAME source PDF file — used by
 * e2e/canvas-vector-flip.spec.ts to prove the module-level PDF document +
 * rendered-bitmap caches (src/utils/pdfDocCache.ts) make page flips between
 * vector pages instant instead of re-parsing/re-rendering on every visit:
 * across a page-1 -> page-2 -> page-1 round trip, the source PDF's /raw URL
 * should be requested only ONCE for the whole session (the doc cache + HTTP
 * cache both help here), and the return to page 1 should paint near-instantly
 * from the rendered-bitmap cache rather than waiting on a fresh pdf.js parse
 * + render.
 */
export async function seedProjectWithVectorPages(
  request: APIRequestContext,
  token: string,
): Promise<SeedVectorPagesResult> {
  const auth = { Authorization: `Bearer ${token}` };
  const projectId = randomUUID();
  const page1Id = randomUUID();
  const page2Id = randomUUID();
  const pdfFileId = randomUUID();
  const thumbnailId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Vector Pages Project ${short}`;

  // Letter-size (850×1100pt) PDF; PdfCanvas renders at a base scale of 2.0×,
  // so imageWidth/imageHeight below (1700×2200) match what the real add-pages
  // flow computes for a page at this size.
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page1 = pdfDoc.addPage([850, 1100]);
  page1.drawRectangle({ x: 100, y: 800, width: 300, height: 200, color: rgb(0.2, 0.4, 0.8) });
  page1.drawText('E2E VECTOR SHEET 1', { x: 100, y: 1000, size: 24, font, color: rgb(0, 0, 0) });
  const page2 = pdfDoc.addPage([850, 1100]);
  page2.drawRectangle({ x: 100, y: 800, width: 300, height: 200, color: rgb(0.8, 0.3, 0.2) });
  page2.drawText('E2E VECTOR SHEET 2', { x: 100, y: 1000, size: 24, font, color: rgb(0, 0, 0) });
  const pdfBytes = await pdfDoc.save();

  const pdfUploadRes = await request.post(
    `/api/files/${pdfFileId}?projectId=${projectId}&kind=plan-source&sourceType=plan-set&sourceId=${projectId}` +
    `&name=${encodeURIComponent('e2e-vector-sheet.pdf')}`,
    { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from(pdfBytes) },
  );
  if (!pdfUploadRes.ok()) throw new Error(`pdf upload failed: ${pdfUploadRes.status()} ${await pdfUploadRes.text()}`);

  // Thumbnail — same data-URL upload idiom as seedProjectWithPage's page image.
  const thumbBase64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const thumbDataUrl = `data:image/png;base64,${thumbBase64}`;
  const thumbRes = await request.post('/api/images', {
    headers: auth,
    data: { id: thumbnailId, data: thumbDataUrl },
  });
  if (!thumbRes.ok()) throw new Error(`thumbnail upload failed: ${thumbRes.status()} ${await thumbRes.text()}`);

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [],
    pages: [
      {
        id: page1Id,
        name: 'Sheet 1',
        imageId: '',
        thumbnailId,
        imageWidth: 1700,
        imageHeight: 2200,
        sourcePdfFileId: pdfFileId,
        sourcePdfPageNum: 1,
        measurements: [],
        scaleConfig: null,
      },
      {
        id: page2Id,
        name: 'Sheet 2',
        imageId: '',
        thumbnailId,
        imageWidth: 1700,
        imageHeight: 2200,
        sourcePdfFileId: pdfFileId,
        sourcePdfPageNum: 2,
        measurements: [],
        scaleConfig: null,
      },
    ],
    version: 1,
    status: 'bidding',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, page1Id, page2Id, sourcePdfFileId: pdfFileId, thumbnailId, name };
}

export interface SeedWithTakeoffResult extends SeedResult {
  takeoffId: string;
  takeoffName: string;
  measurementId: string;
}

/**
 * Seed a project that already contains ONE takeoff plus ONE length measurement
 * wired to it on the single page. This is the minimum shape the Print path
 * needs: buildHighlightsPdf() returns null (and handlePrint records NO printout)
 * unless some current page carries a measurement whose takeoffId is in the
 * selected set. Seeding the link directly avoids drawing on the canvas (slow)
 * while still exercising the real Print → printout-in-Proposal flow.
 *
 * The seeded takeoff renders as a row on the Takeoffs tab, so the spec can
 * select it (its checkbox) and trigger Print/Excel with no UI takeoff creation.
 */
/**
 * Seed a project whose single page carries an AREA takeoff containing a LENGTH
 * measurement. This is the exact shape that surfaces the "Edit Heights"
 * affordance in the sidebar (MeasurementItem renders it only when
 * takeoffType==='area' AND measurement.type==='length' — i.e. a wall whose
 * surface area = length × height). The normal UI path to create this is a
 * drag-drop of a length measurement into an area takeoff card, which is flaky to
 * drive via Playwright; seeding it directly lets the Heights-modal spec stay
 * deterministic.
 */
export async function seedProjectWithAreaTakeoffLength(
  request: APIRequestContext,
  token: string,
): Promise<SeedWithTakeoffResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const pageId = randomUUID();
  const imageId = randomUUID();
  const takeoffId = randomUUID();
  const measurementId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Heights Project ${short}`;
  const takeoffName = `Wall Surface ${short}`;

  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  const imgRes = await request.post('/api/images', {
    headers: auth,
    data: { id: imageId, data: dataUrl },
  });
  if (!imgRes.ok()) {
    throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
  }

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [
      {
        id: takeoffId,
        name: takeoffName,
        color: '#10b981',
        type: 'area',
        unit: 'ft',
      },
    ],
    pages: [
      {
        id: pageId,
        name: 'Sheet 1',
        imageId,
        imageWidth: 1000,
        imageHeight: 800,
        measurements: [
          {
            id: measurementId,
            type: 'length',
            name: 'Wall A',
            color: '#10b981',
            takeoffId,
            points: [
              { x: 100, y: 100 },
              { x: 400, y: 100 },
            ],
          },
        ],
        scaleConfig: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' },
      },
    ],
    version: 1,
    status: 'bidding',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, pageId, imageId, name, takeoffId, takeoffName, measurementId };
}

export interface SeedTwoRevisionResult {
  projectId: string;
  name: string;
  /** The OLDER page — positionally superseded → read-only history. */
  supersededPageId: string;
  /** The NEWER page — the current, fully-editable revision. */
  currentPageId: string;
  /** The measurement id living on the superseded page. */
  supersededMeasurementId: string;
  /** The measurement id living on the current page. */
  currentMeasurementId: string;
}

/**
 * Seed a project with TWO plan sets, each contributing one page that shares the
 * same durable `sheetId`. Because they group into one logical sheet with two
 * revisions, `computeRevisionModel` marks the page from the OLDER set
 * ('superseded') and the page from the NEWER set ('current'). Each page carries
 * a single 2-point length measurement so the read-only spec can attempt to drag
 * a vertex and diff the persisted points.
 *
 * Driving the real "add plan set + revision review" UI is heavy and flaky in
 * e2e, so we construct the already-revised project shape directly via the API —
 * the same end state that flow produces. The read-only gate we're testing is
 * derived purely from this structure (2 revisions of one sheet), so this seed
 * exercises the exact code path a real revision would.
 */
export async function seedProjectWithSupersededRevision(
  request: APIRequestContext,
  token: string,
): Promise<SeedTwoRevisionResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const oldSetId = randomUUID();
  const newSetId = randomUUID();
  const sheetId = randomUUID(); // shared durable identity → one logical sheet
  const supersededPageId = randomUUID();
  const currentPageId = randomUUID();
  const oldImageId = randomUUID();
  const newImageId = randomUUID();
  const supersededMeasurementId = randomUUID();
  const currentMeasurementId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E PlanSet ReadOnly ${short}`;

  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  for (const id of [oldImageId, newImageId]) {
    const imgRes = await request.post('/api/images', {
      headers: auth,
      data: { id, data: dataUrl },
    });
    if (!imgRes.ok()) {
      throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
    }
  }

  const scaleConfig = { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' };
  // Identical starting geometry on both pages so the spec's drag math is the
  // same regardless of which page it targets.
  const points = () => [
    { x: 200, y: 200 },
    { x: 500, y: 200 },
  ];

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [],
    planSets: [
      { id: oldSetId, name: 'Rev 1', date: '2026-01-01', createdAt: Date.now() - 10_000 },
      { id: newSetId, name: 'Rev 2', date: '2026-02-01', createdAt: Date.now() },
    ],
    pages: [
      {
        id: supersededPageId,
        name: 'A-101 (Rev 1)',
        pageNumber: 'A-101',
        sheetId,
        planSetId: oldSetId,
        imageId: oldImageId,
        imageWidth: 1000,
        imageHeight: 800,
        scaleConfig,
        measurements: [
          {
            id: supersededMeasurementId,
            type: 'length',
            name: 'Wall Old',
            color: '#3b82f6',
            points: points(),
          },
        ],
      },
      {
        id: currentPageId,
        name: 'A-101 (Rev 2)',
        pageNumber: 'A-101',
        sheetId,
        planSetId: newSetId,
        imageId: newImageId,
        imageWidth: 1000,
        imageHeight: 800,
        scaleConfig,
        measurements: [
          {
            id: currentMeasurementId,
            type: 'length',
            name: 'Wall New',
            color: '#3b82f6',
            points: points(),
          },
        ],
      },
    ],
    version: 1,
    status: 'bidding',
  };

  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return {
    projectId,
    name,
    supersededPageId,
    currentPageId,
    supersededMeasurementId,
    currentMeasurementId,
  };
}

export async function seedProjectWithTakeoffMeasurement(
  request: APIRequestContext,
  token: string,
): Promise<SeedWithTakeoffResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const pageId = randomUUID();
  const imageId = randomUUID();
  const takeoffId = randomUUID();
  const measurementId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Export Project ${short}`;
  const takeoffName = `Wall Length ${short}`;

  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  const imgRes = await request.post('/api/images', {
    headers: auth,
    data: { id: imageId, data: dataUrl },
  });
  if (!imgRes.ok()) {
    throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
  }

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [
      {
        id: takeoffId,
        name: takeoffName,
        color: '#3b82f6',
        type: 'length',
        unit: 'ft',
        costPerUnit: 5,
      },
    ],
    pages: [
      {
        id: pageId,
        name: 'Sheet 1',
        imageId,
        imageWidth: 1000,
        imageHeight: 800,
        // A 2-point length measurement bound to the seeded takeoff. This is what
        // makes the page eligible for the highlights PDF.
        measurements: [
          {
            id: measurementId,
            type: 'length',
            name: 'Wall A',
            color: '#3b82f6',
            takeoffId,
            points: [
              { x: 100, y: 100 },
              { x: 400, y: 100 },
            ],
          },
        ],
        // A scale so the measurement formats to a real value; not strictly
        // required for Print to produce a printout, but keeps totals sane.
        scaleConfig: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' },
      },
    ],
    version: 1,
    status: 'bidding',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, pageId, imageId, name, takeoffId, takeoffName, measurementId };
}

export interface SeedCustomerPortfolioResult {
  customerId: string;
  customerName: string;
  biddingProjectId: string;
  biddingProjectName: string;
  bidDueDate: number;
  inProgressProjectId: string;
  inProgressProjectName: string;
  taskId: string;
  taskTitle: string;
  taskDueDate: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceAmountCents: number;
  /** Present only when `opts.withPayApp` was set. */
  payApp?: {
    payAppId: string;
    payAppNumber: number;
    sovLineId: string;
    /** Schedule-of-values line amount — becomes `billing.contractTotalCents`. */
    sovAmountCents: number;
    /** G702 L8 (current payment due) for the finalized app, net of retainage. */
    billedCents: number;
    retainagePercent: number;
    /** Sum of payments recorded against the finalized app. */
    paidCents: number;
    /** billedCents - paidCents. */
    balanceCents: number;
  };
}

/**
 * Seed a full customer "portfolio" via the REST API for the customers split
 * view: one customer with (1) a bidding project carrying a bidDueDate inside
 * the 14-day attention window, (2) an in_progress project carrying one SENT,
 * UNPAID invoice (so it surfaces as `outstanding_invoice` attention + a
 * Billing-tab ledger row), and (3) a customer-level (no projectId) task due
 * YESTERDAY, so it's already overdue by construction and shows up in both
 * taskCounts.overdue and the Needs-attention feed.
 *
 * This is the minimum shape customerOverview()/customerSummaries() need to
 * exercise every tile, attention-row type, and ledger row on the customer
 * pane in one seed — see server/customerStore.ts for the exact rollup rules
 * this mirrors (archived-project exclusion doesn't apply here; nothing here
 * is archived).
 *
 * `opts.withPayApp` additionally gives the SAME in_progress project a
 * one-line Schedule of Values and a FINALIZED pay app against it (100%
 * complete, default 10% retainage) with a partial payment recorded against
 * it, via the same API routes the AIA editor uses. This is opt-in because it
 * changes the combined Outstanding figures (customer overview tile,
 * attention rows) that other assertions of this seed's return value depend
 * on — callers that only care about the invoice leg should omit it and keep
 * their existing numbers.
 */
export async function seedCustomerWithPortfolio(
  request: APIRequestContext,
  token: string,
  opts: { withPayApp?: boolean } = {},
): Promise<SeedCustomerPortfolioResult> {
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const customerName = `E2E Portfolio Customer ${short}`;
  const custRes = await request.post('/api/customers', { headers: auth, data: { name: customerName } });
  if (!custRes.ok()) {
    throw new Error(`customer create failed: ${custRes.status()} ${await custRes.text()}`);
  }
  const customer = await custRes.json();
  const customerId = customer.id as string;

  // Bidding project, due in 5 days — inside the 14-day attention window and
  // not overdue.
  const biddingProjectId = randomUUID();
  const biddingProjectName = `E2E Portfolio Bidding ${short}`;
  const bidDueDate = Date.now() + 5 * 86400000;
  const p1Res = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: biddingProjectId,
      name: biddingProjectName,
      createdAt: Date.now(),
      customerId,
      status: 'bidding',
      bidDueDate,
      pages: [],
      takeoffs: [],
      version: 1,
    },
  });
  if (!p1Res.ok()) {
    throw new Error(`bidding project create failed: ${p1Res.status()} ${await p1Res.text()}`);
  }

  // In-progress project that will carry the sent/unpaid invoice.
  const inProgressProjectId = randomUUID();
  const inProgressProjectName = `E2E Portfolio Active ${short}`;
  const p2Res = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: inProgressProjectId,
      name: inProgressProjectName,
      createdAt: Date.now(),
      customerId,
      status: 'in_progress',
      pages: [],
      takeoffs: [],
      version: 1,
    },
  });
  if (!p2Res.ok()) {
    throw new Error(`in-progress project create failed: ${p2Res.status()} ${await p2Res.text()}`);
  }

  // A SENT invoice with one line and no payments recorded → balanceCents > 0,
  // which is what makes it show up as `outstanding_invoice` attention and a
  // Billing-tab ledger row (see server/customerStore.ts customerOverview()).
  const invoiceNumber = `INV-${short}`;
  const invoiceAmountCents = 75000; // $750.00
  const invRes = await request.post(`/api/projects/${inProgressProjectId}/invoices`, {
    headers: auth,
    data: {
      number: invoiceNumber,
      date: Date.now(),
      status: 'sent',
      lines: [{ description: 'Work performed', qty: 1, unitPrice: invoiceAmountCents / 100 }],
    },
  });
  if (!invRes.ok()) {
    throw new Error(`invoice create failed: ${invRes.status()} ${await invRes.text()}`);
  }
  const invoice = await invRes.json();

  // Customer-level task (no projectId) due yesterday — already overdue.
  // customerOverview()/customerSummaries() compare dueDate against today's
  // LOCAL date string, so this must be computed in local time (not UTC) to
  // guarantee the overdue branch regardless of time-of-day/timezone.
  const taskTitle = `E2E Portfolio Overdue Task ${short}`;
  const taskDueDate = daysFromToday(-1);
  const taskRes = await request.post('/api/tasks', {
    headers: auth,
    data: { title: taskTitle, customerId, dueDate: taskDueDate, category: 'Follow-up' },
  });
  if (!taskRes.ok()) {
    throw new Error(`task create failed: ${taskRes.status()} ${await taskRes.text()}`);
  }
  const task = await taskRes.json();

  let payApp: SeedCustomerPortfolioResult['payApp'];
  if (opts.withPayApp) {
    // One SOV line on the same in-progress project — becomes
    // billing.contractTotalCents for this project (hasSov=true path).
    const sovAmountCents = 100000; // $1,000.00
    const sovRes = await request.post(`/api/projects/${inProgressProjectId}/aia/sov`, {
      headers: auth,
      data: { description: 'Contract scope', scheduledValueCents: sovAmountCents },
    });
    if (!sovRes.ok()) {
      throw new Error(`sov line create failed: ${sovRes.status()} ${await sovRes.text()}`);
    }
    const sovLine = await sovRes.json();

    // Pay app #1 with no explicit retainage override → DEFAULT_RETAINAGE (10%).
    const payAppRes = await request.post(`/api/projects/${inProgressProjectId}/aia/pay-apps`, {
      headers: auth,
      data: { applicationDate: daysFromToday(0) },
    });
    if (!payAppRes.ok()) {
      throw new Error(`pay app create failed: ${payAppRes.status()} ${await payAppRes.text()}`);
    }
    const payAppCreated = await payAppRes.json();
    const retainagePercent = 10;

    // 100% complete, nothing stored — createPayApp already seeded a line for
    // the SOV line at 0%/0, this bumps it to 100% (version 1 → 2).
    const linesRes = await request.put(`/api/aia/pay-apps/${payAppCreated.id}/lines`, {
      headers: auth,
      data: {
        lines: [{ sovLineId: sovLine.id, percentComplete: 100, storedMaterialsCents: 0 }],
        version: 1,
      },
    });
    if (!linesRes.ok()) {
      throw new Error(`pay app lines save failed: ${linesRes.status()} ${await linesRes.text()}`);
    }

    // Finalize — the AIA analog of "sent", and what makes listBilledDocuments
    // (and therefore the customer/project Contract rollup + ledger) count it.
    const finalizeRes = await request.patch(`/api/aia/pay-apps/${payAppCreated.id}`, {
      headers: auth,
      data: { status: 'finalized' },
    });
    if (!finalizeRes.ok()) {
      throw new Error(`pay app finalize failed: ${finalizeRes.status()} ${await finalizeRes.text()}`);
    }

    // G702 L8 (current payment due) = completed-to-date less retainage, with
    // no prior app to subtract: sovAmountCents * (1 - retainagePercent/100).
    const billedCents = Math.round(sovAmountCents * (1 - retainagePercent / 100));

    // A partial payment against the finalized app — makes Amount (billed,
    // gross) and Balance (billed less paid) differ downstream, exercising
    // both columns instead of a degenerate equal-values case.
    const paidCents = 25000; // $250.00
    const balanceCents = billedCents - paidCents;
    const paymentRes = await request.post(`/api/projects/${inProgressProjectId}/payments`, {
      headers: auth,
      data: { targetType: 'payapp', targetId: payAppCreated.id, amount: paidCents / 100 },
    });
    if (!paymentRes.ok()) {
      throw new Error(`pay app payment create failed: ${paymentRes.status()} ${await paymentRes.text()}`);
    }

    payApp = {
      payAppId: payAppCreated.id,
      payAppNumber: payAppCreated.number,
      sovLineId: sovLine.id,
      sovAmountCents,
      billedCents,
      retainagePercent,
      paidCents,
      balanceCents,
    };
  }

  return {
    customerId,
    customerName,
    biddingProjectId,
    biddingProjectName,
    bidDueDate,
    inProgressProjectId,
    inProgressProjectName,
    taskId: task.id,
    taskTitle,
    taskDueDate,
    invoiceId: invoice.id,
    invoiceNumber,
    invoiceAmountCents,
    payApp,
  };
}

export interface SeedDocumentsPortfolioResult extends SeedCustomerPortfolioResult {
  issueId: string;
  issueTitle: string;
  issuePhotoFileId: string;
  invoiceFileId: string;
  invoiceFileName: string;
  payAppFileId: string;
  payAppFileName: string;
  printoutId: string;
  printoutFileId: string;
  printoutFileName: string;
  printoutPageCount: number;
}

/**
 * Extends seedCustomerWithPortfolio (with a pay app) with real DOCUMENT rows
 * for the global Documents page (unified-documents spec), via the same
 * two calls the real client flows make — no direct DB writes:
 *
 *  - an issue (any-user, field-created) with a photo uploaded + linked the
 *    way IssueEditor.tsx does it: `POST /api/files/:id?kind=issue-photo&
 *    sourceType=issue&sourceId=<issueId>` then `POST /api/issues/:id/photos`;
 *  - an invoice PDF and a pay-app export "persisted on generate" by POSTing
 *    straight to the raw file endpoint with sourceType/sourceId set, the way
 *    persistGeneratedDocument()/saveBinaryFile() do after a real client-side
 *    PDF/XLSX render — the bytes themselves don't matter here, only that the
 *    row lands with a resolvable source (real invoice/pay-app ids from the
 *    base portfolio seed) so GET /api/documents can label + link it;
 *  - a takeoff-print document, mirroring ProjectView.tsx's real handlePrint
 *    save sequence (mint a sourceId -> upload the file against it with
 *    kind=takeoff-print&sourceType=takeoff-print). Unlike invoice/change-order/
 *    proposal, a takeoff print carries no dollar figure so it stays visible
 *    to non-admins (spec §Decisions "Role visibility"). Its bytes ARE a real
 *    (pdf-lib-generated) multi-page PDF, unlike the invoice/pay-app fixtures —
 *    the document-previews viewer opens it and needs pdf.js to actually parse
 *    it and see >1 page for page-nav coverage (e2e/documents.spec.ts).
 *
 * All four resolve to real navigable `source.href` values (billing tabs /
 * issues page / takeoffs tab) since they reference the base seed's real
 * invoice/pay-app/issue ids and the takeoff-print file's own sourceId — this
 * is what makes the Documents page's Source column non-trivial to assert
 * against instead of a dangling-reference fallback.
 */
export async function seedDocumentsPortfolio(
  request: APIRequestContext,
  token: string,
): Promise<SeedDocumentsPortfolioResult> {
  const auth = { Authorization: `Bearer ${token}` };
  const portfolio = await seedCustomerWithPortfolio(request, token, { withPayApp: true });
  if (!portfolio.payApp) throw new Error('seedCustomerWithPortfolio did not return a payApp (withPayApp set)');
  // NOT portfolio.customerId.slice(0, 8) — customer ids are minted server-side
  // as `customer-${Date.now()}-${random}` (see POST /api/customers), so their
  // first 8 characters are always the literal string "customer", identical
  // across every seed call. A fresh randomUUID() is what every other seed
  // helper in this file uses for its "short" disambiguator.
  const short = randomUUID().slice(0, 8);

  // Issue + linked photo, on the same in-progress project as the invoice/pay
  // app so a single project filter picks up every seeded doc.
  const issueTitle = `E2E Doc Issue ${short}`;
  const issueRes = await request.post(`/api/projects/${portfolio.inProgressProjectId}/issues`, {
    headers: auth,
    data: { title: issueTitle, description: 'Seeded for documents e2e coverage' },
  });
  if (!issueRes.ok()) throw new Error(`issue create failed: ${issueRes.status()} ${await issueRes.text()}`);
  const issue = await issueRes.json();

  const png = readFileSync(TEST_PAGE_PNG);
  const issuePhotoFileId = randomUUID();
  const photoUploadRes = await request.post(
    `/api/files/${issuePhotoFileId}?projectId=${portfolio.inProgressProjectId}&kind=issue-photo&sourceType=issue&sourceId=${issue.id}&name=site-photo-${short}.png`,
    { headers: { ...auth, 'Content-Type': 'image/png' }, data: png },
  );
  if (!photoUploadRes.ok()) throw new Error(`issue photo upload failed: ${photoUploadRes.status()} ${await photoUploadRes.text()}`);
  const linkPhotoRes = await request.post(`/api/issues/${issue.id}/photos`, {
    headers: auth,
    data: { fileId: issuePhotoFileId },
  });
  if (!linkPhotoRes.ok()) throw new Error(`issue photo link failed: ${linkPhotoRes.status()} ${await linkPhotoRes.text()}`);

  const invoiceFileName = `Invoice-${short}.pdf`;
  const invoiceFileId = randomUUID();
  const invoiceFileRes = await request.post(
    `/api/files/${invoiceFileId}?projectId=${portfolio.inProgressProjectId}&customerId=${portfolio.customerId}` +
    `&kind=invoice&sourceType=invoice&sourceId=${portfolio.invoiceId}&name=${encodeURIComponent(invoiceFileName)}`,
    { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from('%PDF-1.4 e2e fixture invoice bytes') },
  );
  if (!invoiceFileRes.ok()) throw new Error(`invoice file upload failed: ${invoiceFileRes.status()} ${await invoiceFileRes.text()}`);

  const payAppFileName = `Pay-App-${portfolio.payApp.payAppNumber}-${short}.xlsx`;
  const payAppFileId = randomUUID();
  const payAppFileRes = await request.post(
    `/api/files/${payAppFileId}?projectId=${portfolio.inProgressProjectId}&customerId=${portfolio.customerId}` +
    `&kind=payapp-export&sourceType=payapp&sourceId=${portfolio.payApp.payAppId}&name=${encodeURIComponent(payAppFileName)}`,
    { headers: { ...auth, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, data: Buffer.from('e2e fixture xlsx bytes') },
  );
  if (!payAppFileRes.ok()) throw new Error(`pay app file upload failed: ${payAppFileRes.status()} ${await payAppFileRes.text()}`);

  // Printout — a non-billing generated kind (visible to non-admins). Mirrors
  // the Takeoffs tab's real save sequence: mint the print id first, then
  // upload the file against it (handlePrint in src/pages/ProjectView.tsx).
  const printoutId = randomUUID();
  const printoutFileName = `Takeoff Print – ${portfolio.inProgressProjectName} – 2026-01-01`;
  const printoutFileId = randomUUID();
  // A real, minimal 2-page PDF (not just bytes with a %PDF header) — the
  // document-previews viewer modal renders this with pdf.js, and 2 pages
  // exercises page-nav (e2e/documents.spec.ts).
  const printoutPageCount = 2;
  const printoutDoc = await PDFDocument.create();
  for (let i = 0; i < printoutPageCount; i++) printoutDoc.addPage([200, 200]);
  const printoutPdfBytes = await printoutDoc.save();
  // sourceType (and kind) are `takeoff-print` — the printout no longer lives
  // in project.printouts[] (removed in the proposal-rework, Task 5/9); the
  // file row itself, sourced this way, is what GET /api/documents resolves
  // via resolveTakeoffPrints (server/documents.ts).
  const printoutFileRes = await request.post(
    `/api/files/${printoutFileId}?projectId=${portfolio.inProgressProjectId}&kind=takeoff-print&sourceType=takeoff-print&sourceId=${printoutId}&name=${encodeURIComponent(printoutFileName)}`,
    { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from(printoutPdfBytes) },
  );
  if (!printoutFileRes.ok()) throw new Error(`printout file upload failed: ${printoutFileRes.status()} ${await printoutFileRes.text()}`);

  return {
    ...portfolio,
    issueId: issue.id,
    issueTitle,
    issuePhotoFileId,
    invoiceFileId,
    invoiceFileName,
    payAppFileId,
    payAppFileName,
    printoutId,
    printoutFileId,
    printoutFileName,
    printoutPageCount,
  };
}
