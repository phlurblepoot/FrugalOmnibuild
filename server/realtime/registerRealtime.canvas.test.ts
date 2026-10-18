import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { ENTITY_CHANGED, type EntityChangedEvent } from './changeFeed';
import { startRealtimeServer, connectClient, makeToken, waitFor, emitWithAck } from './testHarness';

const PROJECT_PATH = '/project/pr1/page/pg1';

function seedDb(dir: string) {
  const db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  createProject(db, {
    id: 'pr1',
    name: 'P',
    createdAt: 1,
    takeoffs: [{ id: 't1', name: 'Drywall', type: 'area', color: '#ff0000' }],
    pages: [
      { id: 'pg1', pageNumber: 'A-1', measurements: [] },
      { id: 'pg2', pageNumber: 'A-2', measurements: [] },
    ],
  });
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
  return db;
}

describe('canvas socket layer: measurement-op + canvas-join', () => {
  let db: Database.Database;
  let dir: string;
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;

  beforeEach(async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-canvas-'));
    db = seedDb(dir);
    srv = await startRealtimeServer({ db });
  });

  afterEach(async () => {
    await srv.close();
  });

  async function joinedClient(username: string, path = PROJECT_PATH, projectId = 'pr1', pageId = 'pg1') {
    const c = connectClient(srv.port, makeToken({ id: username, username }));
    const snap = await waitFor<{ selfId: string }>(c, 'sessions-snapshot');
    c.emit('set-location', { path, projectId, pageId });
    await new Promise((r) => setTimeout(r, 100));
    return { c, selfId: snap.selfId };
  }

  it('case 1: sender in project room can add a measurement; ack ok + broadcast to others + row persisted', async () => {
    const a = await joinedClient('a');
    const b = await joinedClient('b');
    const applied = waitFor<any>(b.c, 'measurement-applied');

    const ack = await emitWithAck<any>(a.c, 'measurement-op', {
      pageId: 'pg1',
      projectId: 'pr1',
      action: 'add',
      measurement: { id: 'm1', type: 'area', points: [{ x: 0, y: 0 }] },
      clientTabId: 'tab-A',
    });
    expect(ack).toEqual({ ok: true, version: 2 });

    const evt = await applied;
    expect(evt).toEqual({
      pageId: 'pg1',
      action: 'add',
      measurement: { id: 'm1', type: 'area', points: [{ x: 0, y: 0 }] },
      version: 2,
      bySessionId: 'tab-A',
    });

    const row = db.prepare('SELECT * FROM measurements WHERE id = ?').get('m1');
    expect(row).toBeTruthy();

    a.c.close(); b.c.close();
  });

  it('case 2: cross-page op — sender on page A can operate on page B in the same project', async () => {
    const a = await joinedClient('a', PROJECT_PATH, 'pr1', 'pg1');
    const ack = await emitWithAck<any>(a.c, 'measurement-op', {
      pageId: 'pg2',
      projectId: 'pr1',
      action: 'add',
      measurement: { id: 'm2', type: 'area', points: [{ x: 1, y: 1 }] },
    });
    expect(ack.ok).toBe(true);
    expect(ack.version).toBe(2);
    a.c.close();
  });

  it('case 2b: malformed envelope (missing pageId) — ack invalid_request, distinct from applyMeasurementOp\'s invalid_measurement', async () => {
    const a = await joinedClient('a');
    const ack = await emitWithAck<any>(a.c, 'measurement-op', {
      projectId: 'pr1',
      action: 'add',
      measurement: { id: 'm2b', type: 'area', points: [{ x: 1, y: 1 }] },
    });
    expect(ack).toEqual({ ok: false, error: 'invalid_request' });
    a.c.close();
  });

  it('case 2c: well-formed envelope but invalid measurement shape — ack invalid_measurement (from applyMeasurementOp)', async () => {
    const a = await joinedClient('a');
    const ack = await emitWithAck<any>(a.c, 'measurement-op', {
      pageId: 'pg1',
      projectId: 'pr1',
      action: 'add',
      measurement: { id: 'm2c' /* missing type/points */ },
    });
    expect(ack).toEqual({ ok: false, error: 'invalid_measurement' });
    a.c.close();
  });

  it('case 3: sender not in the project — ack not_in_project, no broadcast, no row', async () => {
    const outsider = connectClient(srv.port, makeToken({ id: 'x', username: 'x' }));
    await waitFor(outsider, 'sessions-snapshot');
    outsider.emit('set-location', { path: '/dashboard' });
    await new Promise((r) => setTimeout(r, 100));

    const b = await joinedClient('b');
    let sawApplied = false;
    b.c.on('measurement-applied', () => { sawApplied = true; });

    const ack = await emitWithAck<any>(outsider, 'measurement-op', {
      pageId: 'pg1',
      projectId: 'pr1',
      action: 'add',
      measurement: { id: 'm3', type: 'area', points: [{ x: 0, y: 0 }] },
    });
    expect(ack).toEqual({ ok: false, error: 'not_in_project' });

    await new Promise((r) => setTimeout(r, 200));
    expect(sawApplied).toBe(false);
    expect(db.prepare('SELECT * FROM measurements WHERE id = ?').get('m3')).toBeUndefined();

    outsider.close(); b.c.close();
  });

  it('case 4: superseded page — ack page_superseded', async () => {
    const a = await joinedClient('a', '/project/pr3/page/old', 'pr3', 'old');
    const ack = await emitWithAck<any>(a.c, 'measurement-op', {
      pageId: 'old',
      projectId: 'pr3',
      action: 'add',
      measurement: { id: 'm4', type: 'area', points: [{ x: 0, y: 0 }] },
    });
    expect(ack).toEqual({ ok: false, error: 'page_superseded' });
    a.c.close();
  });

  it('case 5: canvas-join returns hydrated measurements (parsed points, spread attrs) + version', async () => {
    db.prepare(`
      INSERT INTO measurements (id, pageId, projectId, takeoffId, type, name, color, points, sortOrder, attrs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('m5', 'pg1', 'pr1', 't1', 'area', 'Lobby', '#ff0000', JSON.stringify([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 0, JSON.stringify({ heights: [9], isTwoSided: true }));

    const a = await joinedClient('a');
    const ack = await emitWithAck<any>(a.c, 'canvas-join', { pageId: 'pg1', projectId: 'pr1' });
    expect(ack.ok).toBe(true);
    expect(ack.version).toBe(1);
    expect(ack.measurements).toHaveLength(1);
    expect(ack.measurements[0]).toMatchObject({
      id: 'm5',
      type: 'area',
      name: 'Lobby',
      color: '#ff0000',
      takeoffId: 't1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      heights: [9],
      isTwoSided: true,
    });
    expect(Array.isArray(ack.measurements[0].points)).toBe(true);

    a.c.close();
  });

  it('case 6: legacy measurement-update no longer relays as measurement-sync', async () => {
    const a = await joinedClient('a');
    const b = await joinedClient('b');
    let received = false;
    b.c.on('measurement-sync', () => { received = true; });
    a.c.emit('measurement-update', { pageId: PROJECT_PATH, action: 'add', measurement: { id: 'm6' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toBe(false);
    a.c.close(); b.c.close();
  });

  it('case 7: a third client observes entity-changed {type:"project"} after a successful op', async () => {
    // Needs a real broadcastChange wired at registerRealtime-call time
    // (server.ts's exact contract: createChangeFeed(io) built and passed into
    // opts). io isn't known until startRealtimeServer resolves, so the
    // broadcastChange passed in closes over a ref set right after — no op
    // fires before that assignment lands.
    await srv.close();
    let ioRef: import('socket.io').Server;
    const broadcastChange = (ev: EntityChangedEvent) => ioRef.emit(ENTITY_CHANGED, ev);
    srv = await startRealtimeServer({ db, broadcastChange });
    ioRef = srv.io;

    const a = await joinedClient('a');
    const c = connectClient(srv.port, makeToken({ id: 'c', username: 'c' }));
    await waitFor(c, 'sessions-snapshot');

    const changed = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const ack = await emitWithAck<any>(a.c, 'measurement-op', {
      pageId: 'pg1',
      projectId: 'pr1',
      action: 'add',
      measurement: { id: 'm7', type: 'area', points: [{ x: 0, y: 0 }] },
      clientTabId: 'tab-Z',
    });
    expect(ack.ok).toBe(true);

    const evt = await changed;
    expect(evt).toMatchObject({
      type: 'project',
      id: 'pr1',
      projectId: 'pr1',
      action: 'updated',
      bySessionId: 'tab-Z',
    });
    expect(evt.version).toBe(ack.version);

    a.c.close(); c.close();
  });
});
