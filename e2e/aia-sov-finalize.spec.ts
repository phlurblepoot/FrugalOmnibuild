import { test, expect, seedProjectWithPage } from './fixtures/test';

// Spec docs/superpowers/specs/2026-09-11-sov-finalize-headers-split-design.md:
// build an SOV with a header and a split, create pay app #1 (auto-lock),
// prove the lock, reopen, edit — the warned recompute.
test('SOV: header + split, first pay app locks, reopen restores editing', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const { projectId } = await seedProjectWithPage(request, token);
  const mk = async (body: Record<string, unknown>) => {
    const r = await request.post(`/api/projects/${projectId}/aia/sov`, { headers: auth, data: body });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).id as string;
  };
  const drywall = await mk({ itemNo: '1', description: 'Drywall', scheduledValueCents: 1000000 });
  const paint = await mk({ itemNo: '2', description: 'Paint', scheduledValueCents: 200000 });

  await authedPage.goto(`/project/${projectId}/billing?tab=sov`);
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/draft/i);

  // Insert a header above Paint, split Drywall 60/40.
  await authedPage.getByTestId(`sov-insert-header-${paint}`).click();
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('New section');
  await authedPage.getByTestId(`sov-split-${drywall}`).click();
  const dialog = authedPage.getByRole('dialog', { name: /split line/i });
  const descs = dialog.getByTestId('split-part-description');
  const pcts = dialog.getByTestId('split-part-percent');
  await descs.nth(0).fill('Level 1'); await pcts.nth(0).fill('60');
  await descs.nth(1).fill('Level 2'); await pcts.nth(1).fill('40');
  await dialog.getByTestId('split-submit').click();
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('Level 1');
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('$6,000.00');
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('$4,000.00');

  // First pay application → auto-lock.
  const pa = await request.post(`/api/projects/${projectId}/aia/pay-apps`, { headers: auth, data: {} });
  expect(pa.ok()).toBeTruthy();
  await authedPage.reload();
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/locked/i);
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/first pay application/i);
  // getByTitle does a case-insensitive substring match by default, and the
  // Reopen button's title ("...for editing") contains "edit" — exact:true
  // scopes this to the pencil-icon row action only.
  await expect(authedPage.getByTitle('Edit', { exact: true })).toHaveCount(0);
  await expect(authedPage.getByTestId(`sov-split-${drywall}`)).toHaveCount(0);
  await expect(authedPage.getByRole('button', { name: /sync approved change orders/i })).toBeVisible();
  // server refuses too
  const blocked = await request.post(`/api/projects/${projectId}/aia/sov`, { headers: auth, data: { description: 'X', scheduledValueCents: 1 } });
  expect(blocked.status()).toBe(409);

  // Reopen (warned) → controls are back. Scope the confirm click to the
  // confirm dialog itself: both the header action and the dialog's confirm
  // button share the accessible name "Reopen".
  await authedPage.getByTestId('sov-reopen').click();
  const reopenDialog = authedPage.getByRole('dialog', { name: /reopen schedule of values/i });
  await expect(reopenDialog.getByText(/1 pay application will recompute/i)).toBeVisible();
  await reopenDialog.getByRole('button', { name: /^reopen$/i }).click();
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/draft/i);
  await expect(authedPage.getByTitle('Edit', { exact: true }).first()).toBeVisible();

  // The G703 for pay app #1 shows the header row and both children.
  const g703 = await (await request.get(`/api/aia/pay-apps/${(await pa.json()).id}`, { headers: auth })).json();
  expect(g703.g703.map((r: any) => r.lineType)).toEqual(['header', 'item', 'item', 'header', 'item']);
});
