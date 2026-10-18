import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, seedProjectWithPage } from './fixtures/test';

// Regression spec for FilePickerModal's row checkboxes
// (src/components/FilePickerModal.tsx), driven through the proposal editor's
// Attachments card because that is where the owner hit it.
//
// The bug this pins: DocumentHoverPreview registers a CAPTURE-phase window
// `click` listener that hides the card. A checkbox's `checked` is toggled by
// the browser BEFORE the click event is dispatched, so a capture listener that
// schedules a React render runs while the DOM is already toggled — the render
// flushes in the microtask checkpoint between listeners and re-applies the
// controlled `checked={false}`, so React's own onChange plugin (which runs
// later, at the root) sees no change and the click is swallowed. The user then
// has to click 1-3 times. Hiding on `mousedown` instead moves the render
// BEFORE the toggle, so onChange sees it.
//
// The hover is therefore load-bearing: the preview must be MOUNTED (which
// happens on mouseenter, before its 350ms reveal delay) for its listener to be
// registered at all, so this test hovers the row first and waits it out.

async function seedPdf(request: APIRequestContext, token: string, projectId: string) {
  const fileId = randomUUID();
  const name = `picker-spec-${fileId.slice(0, 8)}.pdf`;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('E2E PICKER SPEC', { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  const bytes = await doc.save();

  const res = await request.post(
    `/api/files/${fileId}?projectId=${projectId}&kind=document&name=${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' }, data: Buffer.from(bytes) },
  );
  if (!res.ok()) throw new Error(`pdf seed failed: ${res.status()} ${await res.text()}`);
  return { fileId, name };
}

test('file picker: one click checks a row even while its hover preview is up', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const { projectId } = await seedProjectWithPage(request, token);
  const pdf = await seedPdf(request, token, projectId);

  const created = await request.post(`/api/projects/${projectId}/proposals`, { headers: auth, data: {} });
  if (!created.ok()) throw new Error(`proposal create failed: ${created.status()} ${await created.text()}`);
  const { id: proposalId } = await created.json();

  await authedPage.goto(`/project/${projectId}/proposal/${proposalId}`);
  const attachments = authedPage.getByTestId('proposal-attachments');
  await expect(attachments).toBeVisible();
  // One button now covers upload + reuse (AddFilesButton), and it opens on the
  // Upload tab — the Existing tab is where the row checkboxes live.
  await attachments.getByRole('button', { name: /Add PDFs/ }).click();
  await authedPage.getByRole('tab', { name: 'Existing' }).click();

  // The attachments picker opens unfiltered by project (initialProjectIds=[]),
  // and this suite shares one DB across spec files, so narrow to the seeded
  // file by name rather than assuming it is the only PDF on the server.
  const dialog = authedPage.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Search documents').fill(pdf.name);
  const row = dialog.locator('li').filter({ hasText: pdf.name });
  await expect(row).toHaveCount(1);

  // Settle before hovering. The Modal is vertically centred, so it RE-CENTRES
  // as the filtered list shrinks — hovering the row's just-measured box while
  // that is still in flight lands the cursor on the modal header instead
  // (observed: mouseenter fires, then immediately mouseleave, and the card
  // never appears). This wait is what makes the hover below stick.
  await authedPage.waitForTimeout(600);

  // Mount the hover preview and let its 350ms reveal delay elapse, so the card
  // is fully up (and its window listener registered) when the click lands.
  // Load-bearing: without the card up, there is no window listener and this
  // test would pass vacuously.
  await row.hover();
  await expect(authedPage.getByTestId('doc-hover-preview')).toBeVisible();

  const checkbox = row.getByRole('checkbox');
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(dialog.getByRole('button', { name: /Add 1 file/ })).toBeEnabled();
});
