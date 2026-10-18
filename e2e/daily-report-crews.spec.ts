import { test, expect, seedProjectWithPage } from './fixtures/test';

// Characterization spec for daily report crews (spec
// docs/superpowers/specs/2026-10-06-daily-report-crews-design.md): a tab per
// crew, each its own set of daily reports (one per date per crew), and the
// read-only All crews calendar showing every crew's reports.
//
// The seeded project has no address, so a new report's weather fetch stops at
// the app's own 400 no_address — no weather service is ever called.

// Today, local — the page's New report date defaults to it, and the calendar
// opens on its month.
const todayStr = () => new Date().toLocaleDateString('en-CA');

test('two crews each file a report on the same date; All crews shows both and opens either', async ({
  authedPage, apiToken, request,
}) => {
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  const today = todayStr();
  const crewTabs = authedPage.getByRole('tablist', { name: 'Crews' });

  await authedPage.goto(`/project/${projectId}/daily-reports`);
  // A project with no crew yet gets "Crew 1", open by default.
  await expect(crewTabs.getByRole('tab', { name: 'Crew 1' })).toHaveAttribute('aria-selected', 'true');

  // Crew 1's report for today.
  await authedPage.getByRole('button', { name: 'New report' }).click();
  const editor = authedPage.getByRole('dialog');
  await expect(editor.getByRole('heading', { name: /— Crew 1$/ })).toBeVisible();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toHaveCount(0);

  // Add a sub's crew: its tab opens, with its own (empty) calendar.
  await authedPage.getByRole('button', { name: 'Add crew' }).click();
  const prompt = authedPage.getByRole('dialog');
  await prompt.getByLabel('Crew name').fill('Smith Drywall');
  await prompt.getByRole('button', { name: 'Add crew' }).click();
  await expect(crewTabs.getByRole('tab', { name: 'Smith Drywall' })).toHaveAttribute('aria-selected', 'true');
  await expect(authedPage).toHaveURL(/[?&]crew=/);
  await expect(authedPage.getByTestId(`daily-calendar-day-${today}`)).not.toHaveAttribute('data-report', 'true');

  // The same date again, under the other crew — a new report, not Crew 1's.
  await authedPage.getByTestId(`daily-calendar-day-${today}`).click();
  await expect(editor.getByRole('heading', { name: /— Smith Drywall$/ })).toBeVisible();
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(authedPage.getByTestId(`daily-calendar-day-${today}`)).toHaveAttribute('data-report', 'true');

  // Crew 1 has a report, so its menu won't delete it.
  await crewTabs.getByRole('tab', { name: 'Crew 1' }).click();
  await authedPage.getByRole('button', { name: 'Crew 1 options' }).click();
  await expect(authedPage.getByRole('menuitem', { name: /Delete crew/ })).toBeDisabled();
  await authedPage.keyboard.press('Escape');

  // All crews: both reports on today's cell, nothing to create.
  await crewTabs.getByRole('tab', { name: 'All crews' }).click();
  await expect(authedPage).toHaveURL(/[?&]crew=all/);
  await expect(authedPage.getByRole('button', { name: 'New report' })).toHaveCount(0);
  const day = authedPage.getByTestId(`daily-calendar-day-${today}`);
  await expect(day.getByRole('button')).toHaveText([/^Crew 1/, /^Smith Drywall/]);

  await day.getByRole('button', { name: /Smith Drywall's daily report/ }).click();
  await expect(editor.getByRole('heading', { name: /— Smith Drywall$/ })).toBeVisible();
  // Still on All crews underneath.
  await expect(crewTabs.getByRole('tab', { name: 'All crews' })).toHaveAttribute('aria-selected', 'true');

  // The server agrees: two reports, one date, one per crew.
  const list = await (await request.get(`/api/projects/${projectId}/daily-reports`, {
    headers: { Authorization: `Bearer ${apiToken.token}` },
  })).json();
  expect(list.map((r: { reportDate: string; crewName: string }) => [r.reportDate, r.crewName]))
    .toEqual([[today, 'Crew 1'], [today, 'Smith Drywall']]);
});
