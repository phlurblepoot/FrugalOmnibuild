import { test, expect, seedProjectWithPage } from './fixtures/test';
import yauzl from 'yauzl';

/** Entry names plus the parsed manifest, read straight out of the zip bytes. */
const readSnapshotZip = (buf: Buffer): Promise<{ names: string[]; manifest: any }> =>
  new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, z) => {
      if (err || !z) return reject(err ?? new Error('cannot open zip'));
      const names: string[] = [];
      let manifest: any = null;
      z.on('error', reject);
      z.on('entry', e => {
        names.push(e.fileName);
        if (!e.fileName.endsWith('/manifest.json')) return z.readEntry();
        z.openReadStream(e, (e2, rs) => {
          if (e2 || !rs) return reject(e2 ?? new Error('bad entry'));
          const chunks: Buffer[] = [];
          rs.on('error', reject);
          rs.on('data', d => chunks.push(d as Buffer));
          rs.on('end', () => {
            try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e3) { return reject(e3); }
            z.readEntry();
          });
        });
      });
      z.on('end', () => resolve({ names, manifest }));
      z.readEntry();
    });
  });

test('Backup tab: back up now, snapshot appears, downloaded zip carries the seeded file', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);

  // A document with an id this test chose, so the manifest can be checked for
  // that exact row rather than for "some object turned up".
  const probeId = 'e2e-backup-probe-file';
  const upload = await request.post(`/api/files/${probeId}?projectId=${projectId}&kind=document&name=backup-probe.txt`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    data: Buffer.from('backup probe contents\n'),
  });
  expect(upload.ok()).toBe(true);
  const fileId: string = (await upload.json()).fileId;

  await authedPage.goto('/settings?tab=backup');
  await authedPage.getByRole('button', { name: /^back up now$/i }).click();
  const downloadLink = authedPage.getByRole('link', { name: /download zip/i });
  // A local run over an e2e-sized data dir can be done before the first poll,
  // so either the in-progress line or the finished snapshot counts as proof
  // the run started.
  await expect(authedPage.getByText(/backing up/i).or(downloadLink)).toBeVisible({ timeout: 30_000 });
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });

  const href = await downloadLink.getAttribute('href');
  const zip = await (await request.get(href!)).body();
  const { names, manifest } = await readSnapshotZip(zip);

  expect(names.some(n => n.endsWith('/manifest.json'))).toBe(true);
  expect(names.filter(n => n.startsWith('objects/')).length).toBeGreaterThan(0);
  expect(manifest).not.toBeNull();
  expect(manifest.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  const entry = manifest.files.find((f: { id: string }) => f.id === fileId);
  expect(entry, `manifest should list the uploaded document ${fileId}`).toBeTruthy();
  // …and the object it points at is actually in the archive.
  expect(names).toContain(`objects/${entry.sha256}`);
});
