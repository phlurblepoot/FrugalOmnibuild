import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// package.json's `version` is the app version: server.ts reads it into
// APP_VERSION, every snapshot manifest records it, and the restore screen
// shows it next to each backup. It sat at 0.0.0 while the changelog said
// 3.3.0, so every snapshot ever taken claimed to come from version 0.0.0.
// The Settings changelog is the human-facing list; these two must agree.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('app version', () => {
  it('package.json matches the newest CHANGELOG entry in Settings.tsx', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const settings = fs.readFileSync(path.join(root, 'src', 'pages', 'Settings.tsx'), 'utf8');
    const newest = /version:\s*'([\d.]+)'/.exec(settings)?.[1];
    expect(newest).toBeDefined();
    expect(pkg.version).toBe(newest);
  });
});
