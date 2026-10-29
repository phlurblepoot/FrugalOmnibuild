// src/whatsNew/versions.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION, compareVersions, releasesToShow } from './versions';
import { RELEASES } from './releases';

describe('versions', () => {
  it('compares part by part, missing parts counting as 0', () => {
    expect(compareVersions('4.6.9.7', '4.7.0')).toBe(-1);
    expect(compareVersions('4.7', '4.7.0')).toBe(0);
    expect(compareVersions('4.10.0', '4.9.9')).toBe(1);
    expect(compareVersions('5', '4.99.9.9')).toBe(1);
  });

  it('knows the version it is built from', () => {
    expect(APP_VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  });

  it('shows what is newer than the version last seen, up to the one running, newest first', () => {
    const releases = [{ version: '4.7' }, { version: '4.9' }, { version: '4.8' }];
    // Nothing saved yet (everyone, the first time): all of it since 4.6.
    expect(releasesToShow(releases, null, '4.8.0').map(r => r.version)).toEqual(['4.8', '4.7']);
    expect(releasesToShow(releases, '4.6.9.7', '4.7.0').map(r => r.version)).toEqual(['4.7']);
    // Seen already, or not out yet: nothing.
    expect(releasesToShow(releases, '4.7.0', '4.7.0')).toEqual([]);
    expect(releasesToShow(releases, '4.7.2', '4.7.3')).toEqual([]);
  });
});

describe('the 4.7 pages', () => {
  const r = RELEASES.find(x => x.version === '4.7')!;

  it('is everything since 4.6: Sketch, the takeoff canvas and the fixes, one change a page', () => {
    expect(r.pages).toHaveLength(12);
    expect(new Set(r.pages.map(p => p.id)).size).toBe(12);
    expect(r.pages.filter(p => p.area === 'Sketch')).toHaveLength(9);
    expect(r.pages.at(-1)!.kind).toBe('fixed');
  });

  it('has every picture it names, in light and (where it says so) dark', () => {
    for (const p of r.pages) {
      for (const s of p.shots) {
        expect(existsSync(join('public', 'whats-new', r.version, s.file)), s.file).toBe(true);
        if (s.dark) expect(existsSync(join('public', 'whats-new', r.version, s.file.replace('.webp', '-dark.webp'))), s.file).toBe(true);
      }
    }
  });
});
