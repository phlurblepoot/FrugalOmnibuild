// server/routes.changefeed.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import { createChangeFeed, ENTITY_CHANGED, type EntityChangedEvent } from './realtime/changeFeed';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './realtime/testHarness';

// Collects `count` events off a socket (for routes that broadcast more than
// once per request, e.g. a customer merge deleting sources + updating target).
function collectEvents<T = unknown>(socket: { on: (event: string, cb: (e: T) => void) => void; off: (event: string, cb: (e: T) => void) => void }, event: string, count: number): Promise<T[]> {
  return new Promise((resolve) => {
    const events: T[] = [];
    const handler = (e: T) => {
      events.push(e);
      if (events.length >= count) {
        socket.off(event, handler);
        resolve(events);
      }
    };
    socket.on(event, handler);
  });
}

describe('route mutations broadcast entity-changed', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  let app: express.Express;
  let db: ReturnType<typeof openDb>;
  let dataDir: string;

  beforeEach(async () => {
    srv = await startRealtimeServer();
    db = openDb(':memory:');
    dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'));
    runMigrations(db, dataDir, migrations, { dbFile: ':memory:', vacuum: false });
    app = express();
    app.use(express.json());
    registerDataRoutes(app, {
      db, dataDir, dbFile: ':memory:',
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'test', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => ({ id: 'u1', username: 'test', role: 'admin' }),
      broadcastChange: createChangeFeed(srv.io),
    });
  });
  afterEach(async () => { await srv.close(); db.close(); fsSync.rmSync(dataDir, { recursive: true, force: true }); });

  async function connectedClient() {
    const c = connectClient(srv.port, makeToken());
    await waitFor(c, 'sessions-snapshot');
    return c;
  }

  it('POST /api/projects/:id/issues broadcasts issue created with projectId and session meta', async () => {
    await request(app).post('/api/projects').send({ id: 'p1', name: 'P1', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p1/issues')
      .set('X-Session-Id', 'tab-A').send({ title: 'crack' }).expect(200);
    const e = await evt;
    expect(e.type).toBe('issue');
    expect(e.id).toBe(res.body.id);
    expect(e.projectId).toBe('p1');
    expect(e.action).toBe('created');
    expect(e.bySessionId).toBe('tab-A');
    expect(e.byUserId).toBe('u1');
    c.close();
  });

  it('PATCH /api/issues/:id (status) broadcasts a bumped version, not the pre-mutation one', async () => {
    await request(app).post('/api/projects').send({ id: 'p1c', name: 'P1c', pages: [], takeoffs: [] }).expect(200);
    const created = await request(app).post('/api/projects/p1c/issues').send({ title: 'crack' }).expect(200);
    const beforeVersion = (await request(app).get(`/api/issues/${created.body.id}`).expect(200)).body.version;
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).patch(`/api/issues/${created.body.id}`).send({ status: 'resolved' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'issue', id: created.body.id, projectId: 'p1c', action: 'updated' });
    expect(typeof e.version).toBe('number');
    expect(e.version).toBeGreaterThan(beforeVersion);
    c.close();
  });

  it('DELETE /api/issues/:id captures projectId BEFORE deleting', async () => {
    await request(app).post('/api/projects').send({ id: 'p1', name: 'P1', pages: [], takeoffs: [] }).expect(200);
    const created = await request(app).post('/api/projects/p1/issues').send({ title: 'x' }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete(`/api/issues/${created.body.id}`).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'issue', id: created.body.id, projectId: 'p1', action: 'deleted' });
    c.close();
  });

  it('PUT /api/projects/:id broadcasts project updated with the new version', async () => {
    await request(app).post('/api/projects').send({ id: 'p2', name: 'P2', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).put('/api/projects/p2').send({ id: 'p2', name: 'P2 renamed', pages: [], takeoffs: [], version: 1 }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p2', action: 'updated' });
    expect(typeof e.version).toBe('number');
    c.close();
  });

  it('POST /api/projects broadcasts project created', async () => {
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post('/api/projects').send({ id: 'p3', name: 'P3', pages: [], takeoffs: [] }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p3', projectId: 'p3', action: 'created', version: 1 });
    c.close();
  });

  it('DELETE /api/projects/:id broadcasts project deleted', async () => {
    await request(app).post('/api/projects').send({ id: 'p4', name: 'P4', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete('/api/projects/p4').expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p4', action: 'deleted' });
    c.close();
  });

  it('PATCH /api/projects/:id broadcasts project updated', async () => {
    const created = await request(app).post('/api/projects').send({ id: 'p5', name: 'P5', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).patch('/api/projects/p5').send({ version: created.body.version, status: 'in_progress' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p5', action: 'updated' });
    c.close();
  });

  it('POST /api/projects/:id/rfis broadcasts rfi created', async () => {
    await request(app).post('/api/projects').send({ id: 'p6', name: 'P6', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p6/rfis').send({ title: 'question' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'rfi', id: res.body.id, projectId: 'p6', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/punch broadcasts punch created', async () => {
    await request(app).post('/api/projects').send({ id: 'p7', name: 'P7', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p7/punch').send({ description: 'fix trim' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'punch', id: res.body.id, projectId: 'p7', action: 'created' });
    c.close();
  });

  it('PATCH /api/punch/:id (done) broadcasts punch updated', async () => {
    await request(app).post('/api/projects').send({ id: 'p7b', name: 'P7b', pages: [], takeoffs: [] }).expect(200);
    const created = await request(app).post('/api/projects/p7b/punch').send({ description: 'fix trim' }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).patch(`/api/punch/${created.body.id}`).send({ done: true }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'punch', id: created.body.id, projectId: 'p7b', action: 'updated' });
    c.close();
  });

  it('POST /api/projects/:id/invoices broadcasts invoice created (admin)', async () => {
    await request(app).post('/api/projects').send({ id: 'p8', name: 'P8', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p8/invoices').send({ number: 'INV-1', lines: [] }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'invoice', id: res.body.id, projectId: 'p8', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/payments broadcasts payment created against an invoice', async () => {
    await request(app).post('/api/projects').send({ id: 'p9', name: 'P9', pages: [], takeoffs: [] }).expect(200);
    const inv = await request(app).post('/api/projects/p9/invoices').send({ number: 'INV-9', lines: [{ description: 'work', qty: 1, unitPrice: 100 }] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p9/payments')
      .send({ targetType: 'invoice', targetId: inv.body.id, amount: 50 }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'payment', id: res.body.id, projectId: 'p9', action: 'created' });
    c.close();
  });

  it('DELETE /api/payments/:id resolves projectId via the invoice target before deleting', async () => {
    await request(app).post('/api/projects').send({ id: 'p10', name: 'P10', pages: [], takeoffs: [] }).expect(200);
    const inv = await request(app).post('/api/projects/p10/invoices').send({ number: 'INV-10', lines: [{ description: 'work', qty: 1, unitPrice: 100 }] }).expect(200);
    const pay = await request(app).post('/api/projects/p10/payments')
      .send({ targetType: 'invoice', targetId: inv.body.id, amount: 25 }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'payment', id: pay.body.id, projectId: 'p10', action: 'deleted' });
    c.close();
  });

  it('PUT /api/payments/:id and its attachment routes broadcast payment updated with the target\'s project', async () => {
    await request(app).post('/api/projects').send({ id: 'p10b', name: 'P10b', pages: [], takeoffs: [] }).expect(200);
    const inv = await request(app).post('/api/projects/p10b/invoices').send({ number: 'INV-10b', lines: [] }).expect(200);
    const pay = await request(app).post('/api/projects/p10b/payments')
      .send({ targetType: 'invoice', targetId: inv.body.id, amount: 25 }).expect(200);
    await request(app).post('/api/files/chk?projectId=p10b&kind=payment-attachment&name=Check.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('jpg')).expect(200);
    const c = await connectedClient();
    const evts = collectEvents<EntityChangedEvent>(c, ENTITY_CHANGED, 3);
    await request(app).put(`/api/payments/${pay.body.id}`).send({ amount: 30 }).expect(200);
    await request(app).post(`/api/payments/${pay.body.id}/attachments`).send({ fileId: 'chk' }).expect(200);
    await request(app).delete(`/api/payments/${pay.body.id}/attachments/chk`).expect(200);
    for (const e of await evts) {
      expect(e).toMatchObject({ type: 'payment', id: pay.body.id, projectId: 'p10b', action: 'updated' });
    }
    c.close();
  });

  // A payment that settles an invoice marks it paid (and deleting it puts it
  // back to sent); the invoice's own screens hear about it. The automatic
  // change leaves the version alone, so the event carries none.
  it('a payment that moves an invoice\'s status also broadcasts the invoice, without a version', async () => {
    await request(app).post('/api/projects').send({ id: 'p10c', name: 'P10c', pages: [], takeoffs: [] }).expect(200);
    const inv = await request(app).post('/api/projects/p10c/invoices')
      .send({ number: 'INV-10c', status: 'sent', lines: [{ description: 'work', qty: 1, unitPrice: 100 }] }).expect(200);
    const c = await connectedClient();

    let evts = collectEvents<EntityChangedEvent>(c, ENTITY_CHANGED, 2);
    const pay = await request(app).post('/api/projects/p10c/payments')
      .send({ targetType: 'invoice', targetId: inv.body.id, amount: 100 }).expect(200);
    expect(pay.body).toEqual({ id: expect.any(String) });
    let [paymentEvt, invoiceEvt] = await evts;
    expect(paymentEvt).toMatchObject({ type: 'payment', id: pay.body.id, action: 'created' });
    expect(invoiceEvt).toMatchObject({ type: 'invoice', id: inv.body.id, projectId: 'p10c', action: 'updated' });
    expect(invoiceEvt.version).toBeUndefined();
    expect((await request(app).get(`/api/invoices/${inv.body.id}`)).body.status).toBe('paid');

    evts = collectEvents<EntityChangedEvent>(c, ENTITY_CHANGED, 2);
    await request(app).put(`/api/payments/${pay.body.id}`).send({ amount: 60 }).expect(200);
    [paymentEvt, invoiceEvt] = await evts;
    expect(paymentEvt).toMatchObject({ type: 'payment', action: 'updated' });
    expect(invoiceEvt).toMatchObject({ type: 'invoice', id: inv.body.id, projectId: 'p10c', action: 'updated' });
    expect((await request(app).get(`/api/invoices/${inv.body.id}`)).body.status).toBe('sent');

    // A note edit moves no status: only its payment event goes out (then the
    // amount edit that pays it again sends both).
    const threeEvts = collectEvents<EntityChangedEvent>(c, ENTITY_CHANGED, 3);
    await request(app).put(`/api/payments/${pay.body.id}`).send({ note: 'check 1042' }).expect(200);
    await request(app).put(`/api/payments/${pay.body.id}`).send({ amount: 100 }).expect(200);
    expect((await threeEvts).map(e => e.type)).toEqual(['payment', 'payment', 'invoice']);

    evts = collectEvents<EntityChangedEvent>(c, ENTITY_CHANGED, 2);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    [paymentEvt, invoiceEvt] = await evts;
    expect(paymentEvt).toMatchObject({ type: 'payment', action: 'deleted', projectId: 'p10c' });
    expect(invoiceEvt).toMatchObject({ type: 'invoice', id: inv.body.id, projectId: 'p10c', action: 'updated' });
    expect((await request(app).get(`/api/invoices/${inv.body.id}`)).body.status).toBe('sent');
    c.close();
  });

  it('POST /api/projects/:id/change-orders broadcasts changeOrder created', async () => {
    await request(app).post('/api/projects').send({ id: 'p11', name: 'P11', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p11/change-orders').send({ number: 'CO-1', title: 'extra work' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'changeOrder', id: res.body.id, projectId: 'p11', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/aia/sov broadcasts aiaSov created', async () => {
    await request(app).post('/api/projects').send({ id: 'p12', name: 'P12', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p12/aia/sov').send({ description: 'sitework', scheduledValueCents: 10000 }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'aiaSov', id: res.body.id, projectId: 'p12', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/aia/pay-apps broadcasts aiaPayApp created', async () => {
    await request(app).post('/api/projects').send({ id: 'p13', name: 'P13', pages: [], takeoffs: [] }).expect(200);
    await request(app).post('/api/projects/p13/aia/sov').send({ description: 'sitework', scheduledValueCents: 10000 }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p13/aia/pay-apps').send({}).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'aiaPayApp', id: res.body.id, projectId: 'p13', action: 'created' });
    c.close();
  });

  // Photo add/remove on issues, RFIs, and punch items does NOT bump the
  // parent row's version — so the broadcast must omit version entirely.
  // Including the row's (unchanged) version would let a version-dedupe
  // client skip the event, since it looks identical to the last-seen version.
  const PNG = 'data:image/png;base64,' + Buffer.from('pngbytes').toString('base64');

  it('POST /api/issues/:id/photos broadcasts issue updated WITHOUT a version', async () => {
    await request(app).post('/api/projects').send({ id: 'p14', name: 'P14', pages: [], takeoffs: [] }).expect(200);
    const iss = await request(app).post('/api/projects/p14/issues').send({ title: 'crack' }).expect(200);
    await request(app).post('/api/images').send({ id: 'f14', data: PNG }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/issues/${iss.body.id}/photos`).send({ fileId: 'f14' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'issue', id: iss.body.id, projectId: 'p14', action: 'updated' });
    expect(e.version).toBeUndefined();
    c.close();
  });

  it('POST /api/rfis/:id/photos broadcasts rfi updated WITHOUT a version', async () => {
    await request(app).post('/api/projects').send({ id: 'p15', name: 'P15', pages: [], takeoffs: [] }).expect(200);
    const rfi = await request(app).post('/api/projects/p15/rfis').send({ title: 'question' }).expect(200);
    await request(app).post('/api/images').send({ id: 'f15', data: PNG }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/rfis/${rfi.body.id}/photos`).send({ fileId: 'f15' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'rfi', id: rfi.body.id, projectId: 'p15', action: 'updated' });
    expect(e.version).toBeUndefined();
    c.close();
  });

  it('POST /api/punch/:id/photos broadcasts punch updated WITHOUT a version', async () => {
    await request(app).post('/api/projects').send({ id: 'p16', name: 'P16', pages: [], takeoffs: [] }).expect(200);
    const item = await request(app).post('/api/projects/p16/punch').send({ description: 'fix trim' }).expect(200);
    await request(app).post('/api/images').send({ id: 'f16', data: PNG }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/punch/${item.body.id}/photos`).send({ fileId: 'f16' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'punch', id: item.body.id, projectId: 'p16', action: 'updated' });
    expect(e.version).toBeUndefined();
    c.close();
  });

  it('POST /api/change-orders/:id/photos still broadcasts a version (its store DOES bump it)', async () => {
    await request(app).post('/api/projects').send({ id: 'p17', name: 'P17', pages: [], takeoffs: [] }).expect(200);
    const co = await request(app).post('/api/projects/p17/change-orders').send({ number: 'CO-2', title: 'extra work' }).expect(200);
    await request(app).post('/api/images').send({ id: 'f17', data: PNG }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/change-orders/${co.body.id}/photos`).send({ fileId: 'f17' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'changeOrder', id: co.body.id, projectId: 'p17', action: 'updated' });
    expect(typeof e.version).toBe('number');
    c.close();
  });

  it('POST/DELETE /api/invoices/:id/photos and /attachments are admin-gated and broadcast a version', async () => {
    await request(app).post('/api/projects').send({ id: 'p18', name: 'P18', pages: [], takeoffs: [] }).expect(200);
    const inv = await request(app).post('/api/projects/p18/invoices').send({ number: 'INV-18', lines: [] }).expect(200);
    await request(app).post('/api/images').send({ id: 'f18', data: PNG }).expect(200);

    const c = await connectedClient();
    let evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/invoices/${inv.body.id}/photos`).send({ fileId: 'f18' }).expect(200);
    let e = await evt;
    expect(e).toMatchObject({ type: 'invoice', id: inv.body.id, projectId: 'p18', action: 'updated' });
    expect(typeof e.version).toBe('number');

    evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete(`/api/invoices/${inv.body.id}/photos/f18`).expect(200);
    e = await evt;
    expect(e).toMatchObject({ type: 'invoice', id: inv.body.id, projectId: 'p18', action: 'updated' });
    c.close();
  });

  // PDF attachments (migration 42) follow the same rule as each record's photos.
  const uploadPdf = (id: string) => request(app).post(`/api/files/${id}?kind=document&name=${id}.pdf`)
    .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4')).expect(200);

  it('POST /api/issues/:id/attachments broadcasts issue updated WITHOUT a version', async () => {
    await request(app).post('/api/projects').send({ id: 'p19', name: 'P19', pages: [], takeoffs: [] }).expect(200);
    const iss = await request(app).post('/api/projects/p19/issues').send({ title: 'crack' }).expect(200);
    await uploadPdf('f19');
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/issues/${iss.body.id}/attachments`).send({ fileId: 'f19' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'issue', id: iss.body.id, projectId: 'p19', action: 'updated' });
    expect(e.version).toBeUndefined();
    c.close();
  });

  it('POST /api/rfis/:id/attachments broadcasts rfi updated WITHOUT a version', async () => {
    await request(app).post('/api/projects').send({ id: 'p20', name: 'P20', pages: [], takeoffs: [] }).expect(200);
    const rfi = await request(app).post('/api/projects/p20/rfis').send({ title: 'question' }).expect(200);
    await uploadPdf('f20');
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/rfis/${rfi.body.id}/attachments`).send({ fileId: 'f20' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'rfi', id: rfi.body.id, projectId: 'p20', action: 'updated' });
    expect(e.version).toBeUndefined();
    c.close();
  });

  it('POST/DELETE /api/change-orders/:id/attachments broadcast a version (its store DOES bump it)', async () => {
    await request(app).post('/api/projects').send({ id: 'p21', name: 'P21', pages: [], takeoffs: [] }).expect(200);
    const co = await request(app).post('/api/projects/p21/change-orders').send({ number: 'CO-3' }).expect(200);
    await uploadPdf('f21');
    const c = await connectedClient();
    let evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post(`/api/change-orders/${co.body.id}/attachments`).send({ fileId: 'f21' }).expect(200);
    let e = await evt;
    expect(e).toMatchObject({ type: 'changeOrder', id: co.body.id, projectId: 'p21', action: 'updated' });
    expect(typeof e.version).toBe('number');

    evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete(`/api/change-orders/${co.body.id}/attachments/f21`).expect(200);
    e = await evt;
    expect(e).toMatchObject({ type: 'changeOrder', id: co.body.id, projectId: 'p21', action: 'updated' });
    expect(typeof e.version).toBe('number');
    c.close();
  });

  it('POST /api/tasks broadcasts task created (projectId omitted when unscoped)', async () => {
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/tasks').set('X-Session-Id', 'tab-B').send({ title: 'call supplier' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'task', id: res.body.id, action: 'created', bySessionId: 'tab-B' });
    expect(e.projectId).toBeUndefined();
    c.close();
  });

  it('POST /api/customers broadcasts customer created', async () => {
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/customers').send({ name: 'Acme' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'customer', action: 'created' });
    c.close();
  });

  it('POST /api/images broadcasts file created', async () => {
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post('/api/images').send({ id: 'img-merge-test', data: PNG }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'file', id: 'img-merge-test', action: 'created' });
    c.close();
  });

  it('POST /api/customers/merge broadcasts source deleted + target updated', async () => {
    await request(app).post('/api/customers').send({ id: 'cust-a', name: 'A' }).expect(200);
    await request(app).post('/api/customers').send({ id: 'cust-b', name: 'B' }).expect(200);
    const c = await connectedClient();
    const events = collectEvents<EntityChangedEvent>(c, ENTITY_CHANGED, 2);
    await request(app).post('/api/customers/merge').send({ targetId: 'cust-a', sourceIds: ['cust-b'] }).expect(200);
    const es = await events;
    expect(es).toContainEqual(expect.objectContaining({ type: 'customer', id: 'cust-b', action: 'deleted' }));
    expect(es).toContainEqual(expect.objectContaining({ type: 'customer', id: 'cust-a', action: 'updated' }));
    c.close();
  });
});
