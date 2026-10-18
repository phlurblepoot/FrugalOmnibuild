// Gets the demo run ready: an empty data folder and a fresh production build.
// Called by the web server command in playwright.readme.config.ts, before the
// server starts. Set DEMO_SKIP_BUILD=1 to reuse the existing dist/ while
// working on the seed.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const dir = process.env.DEMO_DATA_DIR ?? '.demo-data';
rmSync(dir, { recursive: true, force: true });
console.log(`[demo] cleared ${dir}`);

if (process.env.DEMO_SKIP_BUILD) {
  console.log('[demo] DEMO_SKIP_BUILD set, reusing dist/');
} else {
  const r = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
