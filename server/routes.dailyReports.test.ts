// server/routes.dailyReports.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { createProject } from './projectStore';
import { listCrews } from './dailyReportStore';
import { registerDataRoutes } from './routes';
import type { EntityChangedEvent } from './realtime/changeFeed';

let db: Database.Database;
let dir: string;
let app: express.Express;
let broadcasts: EntityChangedEvent[];
let c1: string; // p1's first crew — every report is filed under a crew

const PROJECT = {
  id: 'p1', name: 'Test Project', createdAt: 1, contractor: 'GC Co',
  pages: [{ id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
  takeoffs: [],
};

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rt-daily-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  broadcasts = [];
  app = express();
  app.use(express.json({ limit: '50mb' }));
  registerDataRoutes(app, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    verifyToken: (token: string) => (token === 'good-token' ? { id: 'u1', role: 'admin' } : null),
    broadcastChange: (ev) => { broadcasts.push(ev); },
  });
  createProject(db, PROJECT);
  c1 = listCrews(db, 'p1')[0].id;
});

describe('daily reports routes', () => {
  it('GET list is empty, then returns created rows date DESC with photoCount', async () => {
    const empty = await request(app).get('/api/projects/p1/daily-reports');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' })
      .expect(200);
    await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-22', jobName: 'Job B', contractorName: 'GC Co' })
      .expect(200);

    const list = await request(app).get('/api/projects/p1/daily-reports');
    expect(list.status).toBe(200);
    expect(list.body.map((r: any) => r.reportDate)).toEqual(['2026-08-22', '2026-08-20']);
    expect(list.body[0].photoCount).toBe(0);
  });

  it('POST creates a report and broadcasts created with version 1', async () => {
    const res = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'dailyReport', action: 'created', projectId: 'p1', id: res.body.id, version: 1,
    }));
  });

  it('POST with duplicate date on same project returns 409 date_taken', async () => {
    const first = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const dup = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A2', contractorName: 'GC Co' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: 'date_taken', existingId: first.body.id });
  });

  it('GET /api/daily-reports/:id returns full row incl photos; 404 for missing', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const get = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.reportDate).toBe('2026-08-20');
    expect(get.body.photos).toEqual([]);

    const missing = await request(app).get('/api/daily-reports/nope');
    expect(missing.status).toBe(404);
  });

  it('PUT happy path bumps version and broadcasts updated with new version', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const put = await request(app).put(`/api/daily-reports/${created.body.id}`)
      .send({ version: 1, jobName: 'Job A Updated' });
    expect(put.status).toBe(200);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'dailyReport', action: 'updated', projectId: 'p1', id: created.body.id, version: 2,
    }));
  });

  it('PUT with stale version returns 409 version_conflict', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    await request(app).put(`/api/daily-reports/${created.body.id}`).send({ version: 1, jobName: 'v2' });
    const stale = await request(app).put(`/api/daily-reports/${created.body.id}`).send({ version: 1, jobName: 'stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('PUT onto a taken date returns 409 date_taken', async () => {
    await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const second = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-21', jobName: 'Job B', contractorName: 'GC Co' });
    const put = await request(app).put(`/api/daily-reports/${second.body.id}`)
      .send({ version: 1, reportDate: '2026-08-20' });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe('date_taken');
    expect(put.body.existingId).toBeTruthy();
  });

  it('DELETE removes the report and broadcasts deleted with no version', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const del = await request(app).delete(`/api/daily-reports/${created.body.id}`);
    expect(del.status).toBe(200);
    const broadcast = broadcasts.find(b => b.action === 'deleted');
    expect(broadcast).toEqual(expect.objectContaining({ type: 'dailyReport', id: created.body.id, projectId: 'p1', action: 'deleted' }));
    expect(broadcast).not.toHaveProperty('version');
    expect((await request(app).get(`/api/daily-reports/${created.body.id}`)).status).toBe(404);
  });

  it('photo add/remove broadcast updated with no version field', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const add = await request(app).post(`/api/daily-reports/${created.body.id}/photos`).send({ fileId: 'file1' });
    expect(add.status).toBe(200);
    const addBroadcast = broadcasts.find(b => b.action === 'updated' && !('version' in b));
    expect(addBroadcast).toEqual(expect.objectContaining({ type: 'dailyReport', id: created.body.id, projectId: 'p1', action: 'updated' }));
    expect(addBroadcast).not.toHaveProperty('version');

    const getAfterAdd = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(getAfterAdd.body.photos).toHaveLength(1);

    broadcasts.length = 0;
    const remove = await request(app).delete(`/api/daily-reports/${created.body.id}/photos/file1`);
    expect(remove.status).toBe(200);
    const removeBroadcast = broadcasts.find(b => b.action === 'updated');
    expect(removeBroadcast).toEqual(expect.objectContaining({ type: 'dailyReport', id: created.body.id, projectId: 'p1', action: 'updated' }));
    expect(removeBroadcast).not.toHaveProperty('version');

    const getAfterRemove = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(getAfterRemove.body.photos).toHaveLength(0);
  });
});

describe('daily report PDF attachment routes', () => {
  // Same freshness rule as the photos above: updatedAt moves so the generated
  // PDF reads out of date, version does not, so no version is broadcast.
  it('add/reorder/remove broadcast updated with no version field; GET lists them in order', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: c1, reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    for (const id of ['spec1', 'spec2']) {
      await request(app).post(`/api/files/${id}?projectId=p1&kind=document&name=${id}.pdf`)
        .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4'));
    }
    db.prepare('UPDATE daily_reports SET updatedAt = 1 WHERE id = ?').run(created.body.id);
    broadcasts.length = 0;

    await request(app).post(`/api/daily-reports/${created.body.id}/attachments`).send({ fileId: 'spec1' }).expect(200);
    await request(app).post(`/api/daily-reports/${created.body.id}/attachments`).send({ fileId: 'spec2' }).expect(200);
    await request(app).patch(`/api/daily-reports/${created.body.id}/attachments/spec2`).send({ sortOrder: -1 }).expect(200);
    let get = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(get.body.attachments.map((a: any) => a.fileId)).toEqual(['spec2', 'spec1']);
    expect(get.body.version).toBe(1);
    expect(get.body.updatedAt).toBeGreaterThan(1);

    await request(app).delete(`/api/daily-reports/${created.body.id}/attachments/spec2`).expect(200);
    get = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(get.body.attachments.map((a: any) => a.fileId)).toEqual(['spec1']);

    expect(broadcasts).toHaveLength(4);
    for (const b of broadcasts) {
      expect(b).toEqual(expect.objectContaining({ type: 'dailyReport', id: created.body.id, projectId: 'p1', action: 'updated' }));
      expect(b).not.toHaveProperty('version');
    }
  });

  it('refuses a non-PDF with 400 and a missing report with 404', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20' });
    await request(app).post('/api/files/img1?projectId=p1&kind=photo&name=p.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('img'));
    expect((await request(app).post(`/api/daily-reports/${created.body.id}/attachments`).send({ fileId: 'img1' })).status).toBe(400);
    expect((await request(app).post('/api/daily-reports/nope/attachments').send({ fileId: 'img1' })).status).toBe(404);
  });
});

describe('GET /api/projects/:id/daily-weather', () => {
  it('returns 400 no_address when the project has no address', async () => {
    const res = await request(app).get('/api/projects/p1/daily-weather').query({ date: '2026-08-20' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no_address' });
  });

  it('returns 400 bad_date for a missing or malformed date', async () => {
    const missing = await request(app).get('/api/projects/p1/daily-weather');
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'bad_date' });

    const malformed = await request(app).get('/api/projects/p1/daily-weather').query({ date: 'not-a-date' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'bad_date' });
  });

  it('returns 400 bad_start for a malformed start time', async () => {
    for (const start of ['7:00', '24:00', '12:60', 'noon', '']) {
      const res = await request(app).get('/api/projects/p1/daily-weather').query({ date: '2026-08-20', start });
      expect(res.status, start).toBe(400);
      expect(res.body, start).toEqual({ error: 'bad_start' });
    }
  });

  describe('with an address (Nominatim and Open-Meteo mocked)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    // Geocodes are cached per address, so each test uses its own.
    const stubUpstream = () => {
      db.prepare('UPDATE projects SET address = ? WHERE id = ?').run(`1 Main St ${Math.random()}`, 'p1');
      const time: string[] = []; const temperature_2m: number[] = []; const weather_code: number[] = [];
      for (const date of ['2026-08-20', '2026-08-21']) {
        for (let h = 0; h < 24; h++) { time.push(`${date}T${String(h).padStart(2, '0')}:00`); temperature_2m.push(60 + h); weather_code.push(0); }
      }
      const fetchMock = vi.fn(async (url: string) => url.includes('nominatim')
        ? { ok: true, json: async () => [{ lat: '26.05', lon: '-80.14' }] }
        : { ok: true, json: async () => ({ hourly: { time, temperature_2m, weather_code } }) });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };

    it('without a start, covers 6 AM to 6 PM of the date', async () => {
      const fetchMock = stubUpstream();
      const res = await request(app).get('/api/projects/p1/daily-weather').query({ date: '2026-08-20' });
      expect(res.status).toBe(200);
      expect(res.body.hourly).toHaveLength(13);
      expect(res.body.hourly[0].hour).toBe('6 AM');
      expect(res.body.hourly[12].hour).toBe('6 PM');
      expect(fetchMock.mock.calls[1][0]).toContain('start_date=2026-08-20&end_date=2026-08-20');
    });

    it('covers the given start through 12 hours later, into the next day when it runs past midnight', async () => {
      const fetchMock = stubUpstream();
      const res = await request(app).get('/api/projects/p1/daily-weather').query({ date: '2026-08-20', start: '19:00' });
      expect(res.status).toBe(200);
      expect(res.body.hourly).toHaveLength(13);
      expect(res.body.hourly[0].hour).toBe('7 PM');
      expect(res.body.hourly[12].hour).toBe('7 AM +1');
      expect(res.body.summary).toBe('Clear');
      expect(fetchMock.mock.calls[1][0]).toContain('start_date=2026-08-20&end_date=2026-08-21');
    });
  });
});

describe('daily report start time', () => {
  it('POST without a start time copies the previous report\'s (6 AM for the first); GET and the list carry it', async () => {
    const first = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20' });
    expect((await request(app).get(`/api/daily-reports/${first.body.id}`)).body.startTime).toBe('06:00');

    await request(app).put(`/api/daily-reports/${first.body.id}`).send({ version: 1, startTime: '07:00' }).expect(200);
    const second = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-21' });
    expect((await request(app).get(`/api/daily-reports/${second.body.id}`)).body.startTime).toBe('07:00');

    const list = await request(app).get('/api/projects/p1/daily-reports');
    expect(list.body.map((r: any) => r.startTime)).toEqual(['07:00', '07:00']);
  });

  it('POST and PUT refuse a malformed start time with 400', async () => {
    const bad = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20', startTime: '7am' });
    expect(bad.status).toBe(400);
    const created = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20', startTime: '06:30' });
    expect(created.status).toBe(200);
    const put = await request(app).put(`/api/daily-reports/${created.body.id}`).send({ version: 1, startTime: '25:00' });
    expect(put.status).toBe(400);
    expect((await request(app).get(`/api/daily-reports/${created.body.id}`)).body.startTime).toBe('06:30');
  });
});

// Crews (spec docs/superpowers/specs/2026-10-06-daily-report-crews-design.md):
// each crew is its own set of daily reports, one per date.
describe('daily report crews routes', () => {
  const crews = async () => (await request(app).get('/api/projects/p1/daily-report-crews')).body;

  it('GET lists the project\'s crews in tab order with report counts; a project with none gets "Crew 1"', async () => {
    createProject(db, { ...PROJECT, id: 'p2', name: 'Fresh', pages: [] });
    const res = await request(app).get('/api/projects/p2/daily-report-crews');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ projectId: 'p2', name: 'Crew 1', reportCount: 0 })]);
    expect((await request(app).get('/api/projects/p2/daily-report-crews')).body).toHaveLength(1);
    expect((await request(app).get('/api/projects/nope/daily-report-crews')).status).toBe(404);

    await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20' }).expect(200);
    expect((await crews()).map((c: any) => [c.id, c.reportCount])).toEqual([[c1, 1]]);
  });

  it('POST adds a crew at the end and broadcasts it; a blank or duplicate name is refused', async () => {
    const res = await request(app).post('/api/projects/p1/daily-report-crews').send({ name: '  Smith Drywall ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: 'p1', name: 'Smith Drywall', sortOrder: 1 });
    expect(broadcasts).toContainEqual(expect.objectContaining({ type: 'dailyReportCrew', action: 'created', id: res.body.id, projectId: 'p1' }));
    expect((await crews()).map((c: any) => c.name)).toEqual(['Crew 1', 'Smith Drywall']);

    expect((await request(app).post('/api/projects/p1/daily-report-crews').send({ name: ' ' })).status).toBe(400);
    const dup = await request(app).post('/api/projects/p1/daily-report-crews').send({ name: 'smith drywall' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: 'There is already a crew named "smith drywall" on this project', code: 'crew_name_taken' });
    expect(broadcasts).toHaveLength(1);
  });

  it('PUT renames and broadcasts; the reports carry the new name', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20' });
    const other = (await request(app).post('/api/projects/p1/daily-report-crews').send({ name: 'Sub' })).body;
    broadcasts.length = 0;

    const res = await request(app).put(`/api/daily-report-crews/${c1}`).send({ name: 'Our crew' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Our crew');
    expect(broadcasts).toEqual([expect.objectContaining({ type: 'dailyReportCrew', action: 'updated', id: c1, projectId: 'p1' })]);
    expect((await request(app).get(`/api/daily-reports/${created.body.id}`)).body.crewName).toBe('Our crew');

    expect((await request(app).put(`/api/daily-report-crews/${other.id}`).send({ name: 'OUR CREW' })).status).toBe(409);
    expect((await request(app).put(`/api/daily-report-crews/${c1}`).send({ name: '' })).status).toBe(400);
    expect((await request(app).put('/api/daily-report-crews/nope').send({ name: 'X' })).status).toBe(404);
  });

  it('DELETE refuses a crew with reports and the last crew (409, with why), else removes it and broadcasts', async () => {
    const sub = (await request(app).post('/api/projects/p1/daily-report-crews').send({ name: 'Sub' })).body;
    const report = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: sub.id, reportDate: '2026-08-20' });
    broadcasts.length = 0;

    const busy = await request(app).delete(`/api/daily-report-crews/${sub.id}`);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('crew_has_reports');
    expect(busy.body.error).toMatch(/"Sub" has daily reports, so it can't be deleted/);

    await request(app).delete(`/api/daily-reports/${report.body.id}`).expect(200);
    broadcasts.length = 0;
    expect((await request(app).delete(`/api/daily-report-crews/${sub.id}`)).status).toBe(200);
    expect(broadcasts).toEqual([expect.objectContaining({ type: 'dailyReportCrew', action: 'deleted', id: sub.id, projectId: 'p1' })]);
    expect((await crews()).map((c: any) => c.id)).toEqual([c1]);

    const last = await request(app).delete(`/api/daily-report-crews/${c1}`);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('last_crew');
    expect((await request(app).delete('/api/daily-report-crews/nope')).status).toBe(404);
  });

  it('POST report needs a crew of that project: 400 without one, 404 for another project\'s', async () => {
    createProject(db, { ...PROJECT, id: 'p2', name: 'Other', pages: [] });
    const otherCrew = listCrews(db, 'p2')[0].id;
    const missing = await request(app).post('/api/projects/p1/daily-reports').send({ reportDate: '2026-08-20' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('crewId is required');
    const foreign = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: otherCrew, reportDate: '2026-08-20' });
    expect(foreign.status).toBe(404);
    expect((await request(app).get('/api/projects/p1/daily-reports')).body).toEqual([]);
  });

  it('one report per date per crew: two crews share a date, a crew\'s own repeat is 409 date_taken', async () => {
    const sub = (await request(app).post('/api/projects/p1/daily-report-crews').send({ name: 'Sub' })).body;
    const ours = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20' });
    const theirs = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: sub.id, reportDate: '2026-08-20' });
    expect(theirs.status).toBe(200);
    const dup = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: sub.id, reportDate: '2026-08-20' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: 'date_taken', existingId: theirs.body.id });

    expect((await request(app).get(`/api/daily-reports/${theirs.body.id}`)).body).toMatchObject({ crewId: sub.id, crewName: 'Sub' });
    const all = (await request(app).get('/api/projects/p1/daily-reports')).body;
    expect(all.map((r: any) => [r.id, r.crewName])).toEqual([[ours.body.id, 'Crew 1'], [theirs.body.id, 'Sub']]);
    const mine = (await request(app).get('/api/projects/p1/daily-reports').query({ crewId: sub.id })).body;
    expect(mine.map((r: any) => r.id)).toEqual([theirs.body.id]);
  });

  it('a new report copies its own crew\'s last start time, and the activity feed names the crew', async () => {
    const sub = (await request(app).post('/api/projects/p1/daily-report-crews').send({ name: 'Night crew' })).body;
    await request(app).post('/api/projects/p1/daily-reports').send({ crewId: c1, reportDate: '2026-08-20', startTime: '07:00' }).expect(200);
    await request(app).post('/api/projects/p1/daily-reports').send({ crewId: sub.id, reportDate: '2026-08-20', startTime: '19:00' }).expect(200);
    const next = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: sub.id, reportDate: '2026-08-21' });
    expect((await request(app).get(`/api/daily-reports/${next.body.id}`)).body.startTime).toBe('19:00');

    const messages = (db.prepare(`SELECT message FROM activity WHERE type = 'daily_report_created' ORDER BY rowid`).all() as any[]).map(r => r.message);
    expect(messages).toEqual([
      'Daily report 2026-08-20 (Crew 1) created',
      'Daily report 2026-08-20 (Night crew) created',
      'Daily report 2026-08-21 (Night crew) created',
    ]);
  });
});
