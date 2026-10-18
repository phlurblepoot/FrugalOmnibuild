import { test, expect, seedProjectWithPage } from './fixtures/test';
import type { Page, APIRequestContext } from '@playwright/test';
import { loginAsNewUser } from './fixtures/seed';

// The notification bell (ONLYOFFICE Phase 5) in a real browser: a teammate
// assigns you something and the bell rings live over the socket; opening the
// notification takes you to it and clears the badge. Also the phone layout,
// where the bell lives in the drawer and the menu button shows a dot. @mentions
// need a running ONLYOFFICE, so they're covered by the unit tests and the
// stand-in smoke run recorded in the checklist.

async function signInAs(page: Page, session: { token: string; user: unknown }) {
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', user);
  }, [session.token, JSON.stringify(session.user)] as const);
}

async function newTeammate(page: Page, request: APIRequestContext, adminToken: string) {
  const session = await loginAsNewUser(request, adminToken);
  await signInAs(page, session);
  return session.user as { id: string; username: string };
}

test('a task assigned to you rings the bell live, and opening it goes to the task', async ({ page, request, apiToken }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const me = await newTeammate(page, request, apiToken.token);
  await page.goto('/dashboard');
  const bell = page.getByTestId('notification-bell');
  await expect(bell).toBeVisible();
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);

  const task = await (await request.post('/api/tasks', { headers: auth, data: { title: 'Patch the lobby soffit', assigneeUserId: me.id } })).json();
  await expect(page.getByTestId('notification-badge')).toHaveText('1');

  await bell.click();
  const item = page.getByTestId('notification-item').first();
  await expect(item).toContainText('assigned you a task');
  await expect(item).toContainText('Patch the lobby soffit');
  await item.click();
  await expect(page).toHaveURL(/\/tasks/);
  await expect(page.getByRole('dialog', { name: 'Task' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Patch the lobby soffit');
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
  const list = await (await request.get('/api/notifications', { headers: { Authorization: `Bearer ${(await page.evaluate(() => localStorage.getItem('token')))!}` } })).json();
  expect(list.unread).toBe(0);
  expect(list.items[0].link).toBe(`/tasks?open=${task.id}`);
});

test('an RFI assigned to you opens from the bell', async ({ page, request, apiToken }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  const me = await newTeammate(page, request, apiToken.token);
  const rfi = await (await request.post(`/api/projects/${projectId}/rfis`, { headers: auth, data: { title: 'Corridor ceiling height?', assigneeUserId: me.id } })).json();

  await page.goto('/dashboard');
  await expect(page.getByTestId('notification-badge')).toHaveText('1');
  await page.getByTestId('notification-bell').click();
  await page.getByTestId('notification-item').filter({ hasText: `RFI-${String(rfi.number).padStart(3, '0')}` }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${projectId}/rfis`));
  const dialog = page.getByRole('dialog', { name: `RFI-${String(rfi.number).padStart(3, '0')}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Assigned to')).toHaveValue(me.id);
});

test('on a phone the menu button shows unread, and the bell is in the drawer', async ({ page, request, apiToken }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const me = await newTeammate(page, request, apiToken.token);
  await request.post('/api/tasks', { headers: auth, data: { title: 'One', assigneeUserId: me.id } });
  await request.post('/api/tasks', { headers: auth, data: { title: 'Two', assigneeUserId: me.id } });

  await page.goto('/dashboard');
  await expect(page.getByTestId('mobile-notification-dot')).toBeVisible();
  await page.getByRole('button', { name: /Open navigation/ }).click();
  await expect(page.getByTestId('notification-badge')).toHaveText('2');
  await page.getByTestId('notification-bell').click();
  await expect(page.getByTestId('notification-item')).toHaveCount(2);
  const panel = page.getByTestId('notification-panel');
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.getByTestId('notification-mark-all').click();
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mobile-notification-dot')).toHaveCount(0);
});

test('the bell sits beside who is online, expanded and collapsed', async ({ authedPage }) => {
  await authedPage.goto('/dashboard');
  const bell = authedPage.getByTestId('notification-bell');
  const presence = authedPage.getByTestId('sidebar-presence');
  await expect(bell).toBeVisible();
  const [b, p] = [(await bell.boundingBox())!, (await presence.boundingBox())!];
  expect(Math.abs((b.y + b.height / 2) - (p.y + p.height / 2))).toBeLessThan(6); // same row
  await authedPage.screenshot({ path: 'test-results/notification-bell.png' });

  await authedPage.evaluate(() => localStorage.setItem('sideDockState', 'collapsed'));
  await authedPage.reload();
  await expect(bell).toBeVisible();
  const [bc, pc] = [(await bell.boundingBox())!, (await presence.boundingBox())!];
  expect(bc.y).toBeGreaterThan(pc.y); // stacked under it on the thin rail
  expect(bc.x + bc.width).toBeLessThanOrEqual(64);
});
