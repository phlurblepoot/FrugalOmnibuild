import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { createProject, loadProject } from './projectStore';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-psm-'));

const upTo = (v: number) => migrations.filter(m => m.version <= v);

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = tmpDir();
  db = openDb(':memory:');
  // Bring the DB to the pre-migration-15 baseline (schema version 14).
  runMigrations(db, dir, upTo(14));
});

const meas = (id: string, takeoffId = 't1') => ({
  id, type: 'area', name: 'X', color: '#fff', takeoffId,
  points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
});

// Seed a project via the normal data layer so pages/measurements decompose
// exactly as production does, then run migration 15.
const seedAndMigrate = (project: any) => {
  createProject(db, project);
  runMigrations(db, dir, upTo(15));
};

const pageRow = (id: string) =>
  db.prepare('SELECT id, planSetId, pageNumber, attrs FROM pages WHERE id = ?').get(id) as
    { id: string; planSetId: string | null; pageNumber: string | null; attrs: string | null };

const sheetIdOf = (id: string): string | undefined => {
  const r = pageRow(id);
  if (!r?.attrs) return undefined;
  try { return JSON.parse(r.attrs).sheetId; } catch { return undefined; }
};

const measCountOnPage = (pageId: string): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM measurements WHERE pageId = ?').get(pageId) as { c: number }).c;

const totalMeas = (projectId: string): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM measurements WHERE projectId = ?').get(projectId) as { c: number }).c;

describe('migration 15: plan-set sheet identity', () => {
  it('groups same-numbered revisions, suffixes within-set dups, keeps current living, never deletes', () => {
    // s1 (older): page A-101 [m1]; B-200 (#1); B-200 (#2)  <- within-set dup
    // s2 (newer): page A-101 carried copy [m1']
    const project = {
      id: 'pr1', name: 'P', createdAt: 1,
      planSets: [
        { id: 's1', name: 'Set 1', createdAt: 1 },
        { id: 's2', name: 'Set 2', createdAt: 2 },
      ],
      takeoffs: [{ id: 't1', name: 'Drywall', type: 'area', color: '#f00' }],
      pages: [
        { id: 'a1', pageNumber: 'A-101', planSetId: 's1', measurements: [meas('m1')] },
        { id: 'b1', pageNumber: 'B-200', planSetId: 's1', measurements: [] },
        { id: 'b2', pageNumber: 'B-200', planSetId: 's1', measurements: [] },
        { id: 'a2', pageNumber: 'A-101', planSetId: 's2', measurements: [meas('m1b')] },
      ],
    };
    const before = (() => { createProject(db, project); return totalMeas('pr1'); })();
    runMigrations(db, dir, upTo(15));

    // Both A-101 pages are revisions of one sheet -> same sheetId.
    expect(sheetIdOf('a1')).toBeTruthy();
    expect(sheetIdOf('a1')).toBe(sheetIdOf('a2'));

    // The two within-set B-200 pages become DISTINCT sheets; one is suffixed.
    expect(sheetIdOf('b1')).toBeTruthy();
    expect(sheetIdOf('b2')).toBeTruthy();
    expect(sheetIdOf('b1')).not.toBe(sheetIdOf('b2'));
    const nums = [pageRow('b1').pageNumber, pageRow('b2').pageNumber].sort();
    expect(nums).toEqual(['B-200', 'B-200 (2)']);

    // Current A-101 (newest = s2) still has its living measurements.
    expect(measCountOnPage('a2')).toBeGreaterThan(0);
    // Older revision retained as frozen history.
    expect(measCountOnPage('a1')).toBe(1);

    // NON-DESTRUCTIVE: nothing deleted; both A-101 already had measurements,
    // none empty, so no copy-forward — total preserved exactly.
    expect(totalMeas('pr1')).toBe(before);
    expect(before).toBe(2);
  });

  it('copies measurements forward when the newest revision is EMPTY (current=living)', () => {
    // s1 (older): A-101 with two measurements.
    // s2 (newer): A-101 EMPTY (today's skip-carry-forward bug) -> should be filled.
    const project = {
      id: 'pr2', name: 'P', createdAt: 1,
      planSets: [
        { id: 's1', name: 'Set 1', createdAt: 1 },
        { id: 's2', name: 'Set 2', createdAt: 2 },
      ],
      takeoffs: [{ id: 't1', name: 'Drywall', type: 'area', color: '#f00' }],
      pages: [
        { id: 'old', pageNumber: 'A-101', planSetId: 's1', measurements: [meas('m1'), meas('m2')] },
        { id: 'new', pageNumber: 'A-101', planSetId: 's2', measurements: [] },
      ],
    };
    createProject(db, project);
    const before = totalMeas('pr2');
    expect(before).toBe(2);
    expect(measCountOnPage('new')).toBe(0);

    runMigrations(db, dir, upTo(15));

    // Same sheet.
    expect(sheetIdOf('old')).toBe(sheetIdOf('new'));
    // Current (newest) page now HAS the copied measurements.
    expect(measCountOnPage('new')).toBe(2);
    // Source rows retained (frozen) — copy-forward, not move.
    expect(measCountOnPage('old')).toBe(2);
    // No loss: total grew by the copy (2 -> 4), never fewer than before.
    expect(totalMeas('pr2')).toBe(4);
    expect(totalMeas('pr2')).toBeGreaterThanOrEqual(before);

    // Copied measurements have fresh ids (no collision with sources).
    const newIds = (db.prepare('SELECT id FROM measurements WHERE pageId = ?').all('new') as { id: string }[]).map(r => r.id);
    expect(newIds).not.toContain('m1');
    expect(newIds).not.toContain('m2');
    expect(new Set(newIds).size).toBe(2);
  });

  it('blank-numbered pages each get their own sheetId (never grouped)', () => {
    const project = {
      id: 'pr3', name: 'P', createdAt: 1,
      planSets: [{ id: 's1', name: 'Set 1', createdAt: 1 }],
      takeoffs: [{ id: 't1', name: 'T', type: 'area', color: '#f00' }],
      pages: [
        { id: 'blank1', pageNumber: '', planSetId: 's1', measurements: [] },
        { id: 'blank2', pageNumber: '', planSetId: 's1', measurements: [] },
      ],
    };
    seedAndMigrate(project);
    expect(sheetIdOf('blank1')).toBeTruthy();
    expect(sheetIdOf('blank2')).toBeTruthy();
    expect(sheetIdOf('blank1')).not.toBe(sheetIdOf('blank2'));
  });

  it('round-trips the assigned sheetId through loadProject', () => {
    const project = {
      id: 'pr4', name: 'P', createdAt: 1,
      planSets: [{ id: 's1', name: 'Set 1', createdAt: 1 }],
      takeoffs: [{ id: 't1', name: 'T', type: 'area', color: '#f00' }],
      pages: [{ id: 'p1', pageNumber: 'A-101', planSetId: 's1', measurements: [] }],
    };
    seedAndMigrate(project);
    const loaded = loadProject(db, 'pr4');
    const page = loaded.pages.find((p: any) => p.id === 'p1');
    expect(page.sheetId).toBeTruthy();
    expect(page.sheetId).toBe(sheetIdOf('p1'));
  });
});

describe('decomposeProject/loadProject round-trip preserves page.sheetId', () => {
  it('a page saved with sheetId reloads with the same sheetId', () => {
    const project = {
      id: 'rt1', name: 'P', createdAt: 1,
      planSets: [],
      takeoffs: [],
      pages: [{ id: 'p1', pageNumber: 'A-101', sheetId: 'SHEET-X', measurements: [] }],
    };
    createProject(db, project);
    const loaded = loadProject(db, 'rt1');
    expect(loaded.pages[0].sheetId).toBe('SHEET-X');
  });
});
