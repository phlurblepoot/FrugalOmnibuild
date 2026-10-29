// src/whatsNew/versions.ts
// Which "What's new" releases someone should see: those newer than the last
// version they saw, up to the version the app is running.

declare const __APP_VERSION__: string;
/** The running app's version (package.json), set at build time. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** Nobody's version was kept before 4.7, so someone with none saved is taken to have seen 4.6.0. */
export const UNTRACKED_VERSION = '4.6.0';

/** Compares versions such as 4.6.9.7 and 4.7.0 part by part; a missing part counts as 0 (4.7 = 4.7.0). */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

/** The releases to show, newest first: after `lastSeen` (or 4.6.0 when none is saved), up to `current`. */
export const releasesToShow = <R extends { version: string }>(releases: R[], lastSeen: string | null, current: string): R[] =>
  releases
    .filter(r => compareVersions(r.version, lastSeen ?? UNTRACKED_VERSION) > 0 && compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
