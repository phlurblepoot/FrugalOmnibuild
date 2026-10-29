import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, login, loginAsNewUser } from './fixtures/test';

// Claude reads plan sheets (docs/ai-sheet-reading-runbook.md). The e2e server
// has no Claude credentials: it runs with AI_FAKE_CLAUDE=1 (playwright.config.ts),
// which swaps the Agent SDK for a canned responder (server/ai/fakeClaude.ts).
// It names pages A-101, A-102, … "Floor Plan" (adding "(no close-up)" when the
// title-block close-up did not come with the page), and treats a token ending in
// "bad0" as a rejected sign-in. The connection is server-wide, so each test
// sets it up itself and the suite leaves it disconnected.

const GOOD = `sk-ant-oat01-${'e2e'.repeat(20)}G00d`;
const BAD = `sk-ant-oat01-${'e2e'.repeat(20)}bad0`;

const asAdmin = (token: string) => ({ Authorization: `Bearer ${token}` });

async function connectClaude(request: APIRequestContext, token: string, secret = GOOD) {
  const res = await request.put('/api/ai/claude/credential', { headers: asAdmin(token), data: { kind: 'token', secret } });
  expect(res.ok()).toBeTruthy();
}
async function disconnectClaude(request: APIRequestContext, token: string) {
  await request.delete('/api/ai/claude/credential', { headers: asAdmin(token) });
}

/** A two-page plan set whose pages carry their own text ("SHEET ONE …"). */
async function planPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['SHEET ONE FOUNDATION', 'SHEET TWO FRAMING']) {
    const p = doc.addPage([792, 612]);
    p.drawText(label, { x: 60, y: 520, size: 28, font });
    p.drawText(label.split(' ').slice(-1)[0] + ' PLAN', { x: 560, y: 40, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

/** New Project → upload the PDF → the Name Pages step. */
async function uploadToNamingStep(page: Page, name: string) {
  await page.goto('/new');
  await page.getByLabel('Project Name').fill(name);
  await page.locator('input[type=file][accept="application/pdf"]').setInputFiles({ name: 'plans.pdf', mimeType: 'application/pdf', buffer: await planPdf() });
  await page.getByRole('button', { name: 'Next Step' }).click();
  await expect(page.getByRole('heading', { name: 'Name Pages' })).toBeVisible({ timeout: 30_000 });
}

test.afterAll(async ({ request }) => {
  const { token } = await login(request);
  await disconnectClaude(request, token);
});

test('admin connects Claude with a token, tests it, sees only the last 4, and disconnects', async ({ authedPage: page, request }) => {
  const { token } = await login(request);
  await disconnectClaude(request, token);
  await page.goto('/settings');
  const card = page.getByTestId('claude-ai-card');
  await expect(card.getByText('Not connected')).toBeVisible();
  await expect(card.getByText(/sent to Anthropic/)).toBeVisible();

  // A rejected token: connected, but Test connection says why it fails.
  await card.getByLabel('Claude Code token').fill(BAD);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();
  await expect(card.getByTestId('claude-connection-detail')).toContainText('ending in bad0');
  await card.getByRole('button', { name: 'Test connection' }).click();
  await expect(card.getByRole('status')).toContainText('Claude sign-in failed');

  // Disconnect asks first.
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: 'Disconnect' }).last().click();
  await expect(card.getByText('Not connected')).toBeVisible();

  // A good token, then pick a cheaper model.
  await card.getByLabel('Claude Code token').fill(GOOD);
  await card.getByRole('button', { name: 'Connect' }).click();
  await card.getByRole('button', { name: 'Test connection' }).click();
  await expect(card.getByRole('status')).toHaveText('Claude answered (Opus 5.5).');
  await card.getByLabel('Model').selectOption('claude-haiku-5-5');
  await card.getByRole('button', { name: 'Test connection' }).click();
  await expect(card.getByRole('status')).toHaveText('Claude answered (Haiku 5.5).');

  // The secret never comes back, to the page or the API.
  await expect(page.locator('body')).not.toContainText(GOOD.slice(0, 24));
  const conn = await request.get('/api/ai/claude', { headers: asAdmin(token) });
  expect(await conn.text()).not.toContain(GOOD.slice(0, 24));
  expect(await conn.json()).toMatchObject({ connected: true, source: 'token', last4: 'G00d', model: 'claude-haiku-5-5' });
  await request.put('/api/ai/claude/model', { headers: asAdmin(token), data: { model: 'claude-opus-5-5' } });
});

test('the API-key option shows the rough cost per sheet', async ({ authedPage: page, request }) => {
  const { token } = await login(request);
  await disconnectClaude(request, token);
  await page.goto('/settings');
  const card = page.getByTestId('claude-ai-card');
  await card.getByRole('radio', { name: 'API key' }).click();
  await expect(card.getByText(/3¢ on Opus, 1.5¢ on Sonnet, 0.1¢ on Haiku/)).toBeVisible();
});

test('a non-admin sees the status but cannot reach the connection', async ({ page, request }) => {
  const { token } = await login(request);
  await connectClaude(request, token);
  const crew = await loginAsNewUser(request, token);
  for (const [method, url] of [['get', '/api/ai/claude'], ['post', '/api/ai/claude/test']] as const) {
    expect((await request[method](url, { headers: asAdmin(crew.token) })).status()).toBe(403);
  }
  expect((await request.put('/api/ai/claude/credential', { headers: asAdmin(crew.token), data: { kind: 'token', secret: BAD } })).status()).toBe(403);

  await page.addInitScript(([t, u]) => { localStorage.setItem('token', t); localStorage.setItem('user', u); }, [crew.token, JSON.stringify(crew.user)] as const);
  await page.goto('/settings');
  const card = page.getByTestId('claude-ai-card');
  await expect(card.getByText(/Claude reads your plan sheets/)).toBeVisible();
  await expect(card.getByText('Claude connection')).toHaveCount(0);
});

test('AI Scan names uploaded pages with Claude', async ({ authedPage: page, request }) => {
  const { token } = await login(request);
  await connectClaude(request, token);
  await uploadToNamingStep(page, `AI named ${Date.now()}`);

  await page.getByRole('button', { name: 'AI Scan' }).click();
  await expect(page.getByText(/Claude read 2 of 2 pages/)).toBeVisible();
  const numbers = page.getByPlaceholder('e.g. A-101');
  await expect(numbers.first()).toHaveValue(/^A-1\d\d$/);
  const values = await numbers.evaluateAll(els => els.map(e => (e as HTMLInputElement).value));
  expect(new Set(values).size).toBe(values.length);
  await expect(page.getByPlaceholder('e.g. Floor Plan').first()).toHaveValue('Floor Plan');

  await page.getByRole('button', { name: /^Finish/ }).click();
  await expect(page).toHaveURL(/\/project\//, { timeout: 30_000 });
  await expect(page.getByText(/A-1\d\d/).first()).toBeVisible();
});

test('with Claude off, uploads still work: pages keep their names and their PDF text, and AI Scan says why', async ({ authedPage: page, request }) => {
  const { token } = await login(request);
  await disconnectClaude(request, token);
  await uploadToNamingStep(page, `AI off ${Date.now()}`);

  await page.getByRole('button', { name: 'AI Scan' }).click();
  await expect(page.getByText(/Claude is not connected/)).toBeVisible();
  await expect(page.getByPlaceholder('e.g. A-101').first()).toHaveValue('1');

  await page.getByRole('button', { name: /^Finish/ }).click();
  await expect(page).toHaveURL(/\/project\//, { timeout: 30_000 });
  const projectId = page.url().match(/\/project\/([^/?#]+)/)![1];
  await page.goto(`/project/${projectId}/takeoff`);
  await expect(page.getByTestId('page-row')).toHaveCount(2);
  // The PDF's own text was read at upload: searching it finds the page.
  await page.getByTestId('page-search').fill('FRAMING');
  await expect(page.getByTestId('page-row')).toHaveCount(1);
});
