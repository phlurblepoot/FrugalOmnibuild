// Runs the production server on the demo data folder WITHOUT clearing it, so
// you can browse the seeded demo company by hand: `npm run demo:serve`
// (build first with `npm run build`). Login details are in demo-data.ts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const dir = process.env.DEMO_DATA_DIR ?? '.demo-data';
if (!existsSync(dir)) {
  console.error(`No ${dir} folder yet. Run "npm run demo:seed" first.`);
  process.exit(1);
}
const port = process.env.DEMO_PORT ?? '3100';
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'server.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    STORAGE_PATH: dir,
    PORT: port,
    MAIL_FAKE_PROVIDER: '1',
    APP_PUBLIC_URL: `http://localhost:${port}`,
  },
});
child.on('exit', code => process.exit(code ?? 0));
