// The web app manifest's share_target (Android share sheet) and the service
// worker that catches its POST.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { webAppManifest } from './pushRoutes';

describe('manifest share_target', () => {
  const m = webAppManifest('FrugalOmnibuild') as any;

  it('posts shared files to /share-target as multipart', () => {
    expect(m.share_target).toMatchObject({ action: '/share-target', method: 'POST', enctype: 'multipart/form-data' });
    expect(m.share_target.params.files[0].name).toBe('files');
    expect(m.share_target.params.files[0].accept).toEqual(expect.arrayContaining(['application/pdf', 'image/*']));
  });

  it('is within the manifest scope', () => {
    expect(m.share_target.action.startsWith(m.scope)).toBe(true);
  });

  it('is handled by the service worker', () => {
    const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    expect(sw).toContain("'/share-target'");
    expect(sw).toContain("'share-target-v1'");
  });
});
