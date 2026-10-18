import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { createProject, loadProject } from '../projectStore';
import { applyMeasurementOp, OpRejectedError, type MeasurementOp } from './measurementOps';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-measops-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  createProject(db, {
    id: 'pr1',
    name: 'P',
    createdAt: 1,
    takeoffs: [{ id: 't1', name: 'Drywall', type: 'area', color: '#ff0000' }],
    pages: [{ id: 'pg1', pageNumber: 'A-1', measurements: [] }],
  });
});

const baseOp = (overrides: Partial<MeasurementOp> = {}): MeasurementOp => ({
  projectId: 'pr1',
  pageId: 'pg1',
  action: 'add',
  measurement: { id: 'm1', type: 'area', points: [{ x: 0, y: 0 }] },
  ...overrides,
});

describe('applyMeasurementOp', () => {
  it('case 1: rejects when the page does not exist', () => {
    expect(() => applyMeasurementOp(db, baseOp({ pageId: 'nope' }))).toThrowError(
      expect.objectContaining({ reason: 'page_not_found' })
    );
  });

  it('case 1b: rejects when the page belongs to a different project', () => {
    createProject(db, { id: 'pr2', name: 'Other', createdAt: 1, takeoffs: [], pages: [] });
    expect(() => applyMeasurementOp(db, baseOp({ projectId: 'pr2' }))).toThrowError(
      expect.objectContaining({ reason: 'page_not_found' })
    );
  });

  it('case 2: rejects an op on a superseded page, but allows one on the current revision', () => {
    createProject(db, {
      id: 'pr3',
      name: 'P3',
      createdAt: 1,
      planSets: [
        { id: 's1', name: 'Set 1', createdAt: 1 },
        { id: 's2', name: 'Set 2', createdAt: 2 },
      ],
      takeoffs: [],
      pages: [
        { id: 'old', pageNumber: 'A-101', planSetId: 's1', sheetId: 'SH-A', measurements: [] },
        { id: 'new', pageNumber: 'A-101', planSetId: 's2', sheetId: 'SH-A', measurements: [] },
      ],
    });
    expect(() => applyMeasurementOp(db, baseOp({ projectId: 'pr3', pageId: 'old' }))).toThrowError(
      expect.objectContaining({ reason: 'page_superseded' })
    );
    expect(() => applyMeasurementOp(db, baseOp({ projectId: 'pr3', pageId: 'new' }))).not.toThrow();
  });

  it('case 3: add/update reject when id, type, or points are missing/malformed', () => {
    const invalidMeasurements: Record<string, unknown>[] = [
      { id: 'm1' }, // missing type + points
      { id: 'm1', type: 'area' }, // missing points
      { id: 'm1', points: [] }, // missing type
      { id: 'm1', type: 'area', points: 'nope' }, // points not an array
    ];
    for (const measurement of invalidMeasurements) {
      expect(() => applyMeasurementOp(db, baseOp({ action: 'add', measurement: measurement as any }))).toThrowError(
        expect.objectContaining({ reason: 'invalid_measurement' })
      );
      expect(() => applyMeasurementOp(db, baseOp({ action: 'update', measurement: measurement as any }))).toThrowError(
        expect.objectContaining({ reason: 'invalid_measurement' })
      );
    }
  });

  it('case 3b: delete only requires id, not type/points', () => {
    expect(() =>
      applyMeasurementOp(db, baseOp({ action: 'delete', measurement: { id: 'm1' } }))
    ).not.toThrow();
  });

  it('case 4: add assigns sortOrder = MAX(sortOrder)+1 for the page, 0 when empty', () => {
    applyMeasurementOp(db, baseOp({ measurement: { id: 'm1', type: 'area', points: [{ x: 0, y: 0 }] } }));
    expect((db.prepare('SELECT sortOrder FROM measurements WHERE id = ?').get('m1') as any).sortOrder).toBe(0);

    applyMeasurementOp(db, baseOp({ measurement: { id: 'm2', type: 'count', points: [{ x: 1, y: 1 }] } }));
    expect((db.prepare('SELECT sortOrder FROM measurements WHERE id = ?').get('m2') as any).sortOrder).toBe(1);
  });

  it('case 4b: a double-fired add for an existing id behaves as an update, preserving sortOrder', () => {
    applyMeasurementOp(
      db,
      baseOp({ measurement: { id: 'm1', type: 'area', name: 'A', points: [{ x: 0, y: 0 }] } })
    );
    applyMeasurementOp(db, baseOp({ measurement: { id: 'm2', type: 'count', points: [{ x: 1, y: 1 }] } }));
    // double-fire: another 'add' for m1, which already exists
    applyMeasurementOp(
      db,
      baseOp({ measurement: { id: 'm1', type: 'area', name: 'Renamed', points: [{ x: 5, y: 5 }] } })
    );
    const row = db.prepare('SELECT sortOrder, name FROM measurements WHERE id = ?').get('m1') as any;
    expect(row.sortOrder).toBe(0); // preserved, not bumped to 2
    expect(row.name).toBe('Renamed');
  });

  it('case 5: update rewrites the row, preserving the existing sortOrder', () => {
    applyMeasurementOp(
      db,
      baseOp({ measurement: { id: 'm1', type: 'area', name: 'A', points: [{ x: 0, y: 0 }] } })
    );
    applyMeasurementOp(
      db,
      baseOp({ action: 'update', measurement: { id: 'm1', type: 'area', name: 'B', points: [{ x: 9, y: 9 }] } })
    );
    const row = db.prepare('SELECT sortOrder, name, points FROM measurements WHERE id = ?').get('m1') as any;
    expect(row.sortOrder).toBe(0);
    expect(row.name).toBe('B');
    expect(JSON.parse(row.points)).toEqual([{ x: 9, y: 9 }]);
  });

  it('case 5b: update on a missing row behaves as add (LWW survives out-of-order delivery)', () => {
    applyMeasurementOp(
      db,
      baseOp({ action: 'update', measurement: { id: 'm9', type: 'area', points: [{ x: 1, y: 1 }] } })
    );
    const row = db.prepare('SELECT sortOrder FROM measurements WHERE id = ?').get('m9') as any;
    expect(row).toBeTruthy();
    expect(row.sortOrder).toBe(0);
  });

  it('case 6: delete removes the row by id+pageId; deleting a missing row is idempotent and still bumps version', () => {
    applyMeasurementOp(db, baseOp({ measurement: { id: 'm1', type: 'area', points: [{ x: 0, y: 0 }] } }));
    applyMeasurementOp(db, baseOp({ action: 'delete', measurement: { id: 'm1' } }));
    expect(db.prepare('SELECT * FROM measurements WHERE id = ?').get('m1')).toBeUndefined();

    const before = (db.prepare('SELECT version FROM projects WHERE id = ?').get('pr1') as any).version;
    const result = applyMeasurementOp(db, baseOp({ action: 'delete', measurement: { id: 'm1' } }));
    expect(result.version).toBe(before + 1);
  });

  it('case 7: every successful op bumps projects.version and updatedAt', () => {
    const before = db.prepare('SELECT version, updatedAt FROM projects WHERE id = ?').get('pr1') as any;
    const result = applyMeasurementOp(
      db,
      baseOp({ measurement: { id: 'm1', type: 'area', points: [{ x: 0, y: 0 }] } })
    );
    const after = db.prepare('SELECT version, updatedAt FROM projects WHERE id = ?').get('pr1') as any;
    expect(result.version).toBe(before.version + 1);
    expect(after.version).toBe(before.version + 1);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt ?? 0);
  });

  it('rejects add/update ops whose id already exists on a different page (no silent cross-page relocation)', () => {
    // Second page in the same project.
    db.prepare('INSERT INTO pages (id, projectId, pageNumber, sortOrder) VALUES (?, ?, ?, ?)').run('pg2', 'pr1', 'A-2', 1);

    applyMeasurementOp(db, baseOp({ pageId: 'pg1', measurement: { id: 'm1', type: 'area', points: [{ x: 0, y: 0 }] } }));
    const before = (db.prepare('SELECT version FROM projects WHERE id = ?').get('pr1') as any).version;

    expect(() =>
      applyMeasurementOp(
        db,
        baseOp({ action: 'add', pageId: 'pg2', measurement: { id: 'm1', type: 'count', points: [{ x: 1, y: 1 }] } })
      )
    ).toThrowError(expect.objectContaining({ reason: 'invalid_measurement' }));
    expect(() =>
      applyMeasurementOp(
        db,
        baseOp({ action: 'update', pageId: 'pg2', measurement: { id: 'm1', type: 'count', points: [{ x: 1, y: 1 }] } })
      )
    ).toThrowError(expect.objectContaining({ reason: 'invalid_measurement' }));

    // row is still on the original page, untouched
    const row = db.prepare('SELECT pageId, type FROM measurements WHERE id = ?').get('m1') as any;
    expect(row.pageId).toBe('pg1');
    expect(row.type).toBe('area');
    // version was not bumped by either rejected op
    const after = (db.prepare('SELECT version FROM projects WHERE id = ?').get('pr1') as any).version;
    expect(after).toBe(before);
  });

  it('case 8: round-trips add fields through loadProject (attrs split matches decomposeProject/loadProject)', () => {
    applyMeasurementOp(
      db,
      baseOp({
        measurement: {
          id: 'm1',
          type: 'area',
          name: 'Lobby',
          color: '#ff0000',
          takeoffId: 't1',
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          heights: [9],
          isTwoSided: true,
          segments: [{ a: 1 }],
          arcMidIndices: [2],
          regionId: 'r1',
          planSetId: 'ps1',
          multiplier: 4,
        },
      })
    );
    const project = loadProject(db, 'pr1');
    const page = project.pages.find((p: any) => p.id === 'pg1');
    const m = page.measurements.find((x: any) => x.id === 'm1');
    expect(m).toMatchObject({
      id: 'm1',
      type: 'area',
      name: 'Lobby',
      color: '#ff0000',
      takeoffId: 't1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      heights: [9],
      isTwoSided: true,
      segments: [{ a: 1 }],
      arcMidIndices: [2],
      regionId: 'r1',
      planSetId: 'ps1',
      multiplier: 4,
    });
  });

  it('an update without the multiplier (set back to ×1, or undone) clears it from the row', () => {
    const m = { id: 'm1', type: 'area', name: 'Floor', points: [{ x: 0, y: 0 }], multiplier: 3 };
    applyMeasurementOp(db, baseOp({ measurement: m }));
    const read = () => {
      const project = loadProject(db, 'pr1');
      return project.pages.find((p: any) => p.id === 'pg1').measurements.find((x: any) => x.id === 'm1');
    };
    expect(read().multiplier).toBe(3);
    // The client sends { ...m, multiplier: undefined }, which JSON drops.
    applyMeasurementOp(db, baseOp({ action: 'update', measurement: JSON.parse(JSON.stringify({ ...m, multiplier: undefined })) }));
    expect(read()).not.toHaveProperty('multiplier');
  });
});
