import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { seedDemoCompany } from './demo-data';

// Fills the empty demo database through the REST API. Runs first in
// playwright.readme.config.ts; the screenshot specs depend on it.
test('seed the demo company', async ({ request }) => {
  test.setTimeout(180_000);
  const manifest = await seedDemoCompany(request);
  const dir = process.env.DEMO_DATA_DIR ?? '.demo-data';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
});
