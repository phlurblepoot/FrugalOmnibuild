// The demo company: everything the README screenshots show, filled in through
// the app's own REST API on a fresh, empty database. Nothing here comes from a
// real business: "Cedar Point Plastering" in "Riverton" is made up, as are the
// people, customers, projects, addresses (123 Example St), example.com emails
// and 555 phone numbers.
//
// Used by e2e/readme/seed.setup.ts. Kept apart from the normal e2e suite: its
// own folder, its own config (playwright.readme.config.ts), its own port and
// data folder.
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import {
  ELEV, ELEV_DOOR, ELEV_WINDOWS, HOUSE, IMAGE_H, IMAGE_W, PX_PER_FT, ROOMS,
  buildPlanSet, elevPoint, logoDataUrl, pageSetPdf, planPoint, simpleDocPdf, sitePhoto, summarySpreadsheet,
  type PhotoKind,
} from './demo-assets';

// ---------------------------------------------------------------------------
// Fixed demo identity. The password is for the throwaway local demo only.
// ---------------------------------------------------------------------------

export const DEMO_PASSWORD = 'demo-password-1';

export const DEMO_USERS = [
  { username: 'dana.whitfield', role: 'admin', title: 'Owner and estimator' },
  { username: 'marcus.lee', role: 'user', title: 'Field supervisor' },
  { username: 'priya.shah', role: 'user', title: 'Project coordinator' },
] as const;

export const COMPANY = {
  appName: 'FrugalOmnibuild',
  name: 'Cedar Point Plastering',
  legalName: 'Cedar Point Plastering, LLC',
  phone: '(555) 010-0142',
  email: 'office@example.com',
  address: '500 Sample Ave, Riverton, FL',
  brandColor: '#1f4d3a',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/** Local YYYY-MM-DD, offset from today. */
export function ymd(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** A timestamp (ms) at 9 AM local on the day offset from today. */
export function ts(offsetDays = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
const iso = (offsetDays: number, hour = 9, minute = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

/** Weekdays only, newest first: the last `n` working days up to and including yesterday. */
function recentWorkdays(n: number): number[] {
  const out: number[] = [];
  for (let off = -1; out.length < n; off--) {
    const day = new Date(ts(off)).getDay();
    if (day !== 0 && day !== 6) out.push(off);
  }
  return out;
}

class Api {
  constructor(private request: APIRequestContext, public token: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async finish<T>(label: string, res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
    if (!res.ok()) throw new Error(`${label} failed: ${res.status()} ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  get<T = any>(path: string): Promise<T> {
    return this.request.get(path, { headers: this.headers() }).then(r => this.finish<T>(`GET ${path}`, r));
  }
  post<T = any>(path: string, data?: unknown): Promise<T> {
    return this.request.post(path, { headers: this.headers(), data }).then(r => this.finish<T>(`POST ${path}`, r));
  }
  put<T = any>(path: string, data?: unknown): Promise<T> {
    return this.request.put(path, { headers: this.headers(), data }).then(r => this.finish<T>(`PUT ${path}`, r));
  }
  patch<T = any>(path: string, data?: unknown): Promise<T> {
    return this.request.patch(path, { headers: this.headers(), data }).then(r => this.finish<T>(`PATCH ${path}`, r));
  }
  del<T = any>(path: string): Promise<T> {
    return this.request.delete(path, { headers: this.headers() }).then(r => this.finish<T>(`DELETE ${path}`, r));
  }

  /** Upload raw bytes as a file; returns the stored file id. */
  async upload(opts: {
    bytes: Buffer; mime: string; name: string; kind: string;
    projectId?: string; customerId?: string; sourceType?: string; sourceId?: string; id?: string;
  }): Promise<string> {
    const id = opts.id ?? randomUUID();
    const q = new URLSearchParams({ kind: opts.kind, name: opts.name });
    if (opts.projectId) q.set('projectId', opts.projectId);
    if (opts.customerId) q.set('customerId', opts.customerId);
    if (opts.sourceType) q.set('sourceType', opts.sourceType);
    if (opts.sourceId) q.set('sourceId', opts.sourceId);
    const res = await this.request.post(`/api/files/${id}?${q}`, {
      headers: this.headers({ 'Content-Type': opts.mime }), data: opts.bytes,
    });
    const body = await this.finish<{ fileId: string }>(`upload ${opts.name}`, res);
    return body.fileId;
  }

  /**
   * Store the same bytes again as a new version of a generated document. A
   * document made before its record was marked sent would otherwise read
   * "PDF out of date", because sending stamps the record afterwards.
   */
  async refreshGenerated(fileId: string): Promise<void> {
    const meta = await this.get<{ mime: string; name: string; kind: string; projectId?: string | null; customerId?: string | null; sourceType?: string | null; sourceId?: string | null }>(`/api/files/${fileId}/meta`);
    const res = await this.request.get(`/api/files/${fileId}/content`, { headers: this.headers() });
    if (!res.ok()) throw new Error(`read ${meta.name} failed: ${res.status()}`);
    await this.upload({
      bytes: await res.body(), mime: meta.mime, name: meta.name, kind: meta.kind,
      projectId: meta.projectId ?? undefined, customerId: meta.customerId ?? undefined,
      sourceType: meta.sourceType ?? undefined, sourceId: meta.sourceId ?? undefined,
    });
  }

  /** Upload a PNG data URL into the images store. */
  async image(dataUrl: string, projectId?: string, kind?: string): Promise<string> {
    const id = randomUUID();
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    if (projectId) q.set('projectId', projectId);
    await this.post(`/api/images${q.size ? `?${q}` : ''}`, { id, data: dataUrl });
    return id;
  }
}

const pdfMime = 'application/pdf';
const pngMime = 'image/png';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function uploadPhoto(api: Api, kind: PhotoKind, opts: { fileKind: string; projectId: string; sourceType: string; sourceId: string; name: string }): Promise<string> {
  return api.upload({
    bytes: await sitePhoto(kind), mime: pngMime, name: opts.name, kind: opts.fileKind,
    projectId: opts.projectId, sourceType: opts.sourceType, sourceId: opts.sourceId,
  });
}

// ---------------------------------------------------------------------------
// The manifest the screenshot specs read, so they can open exact screens.
// ---------------------------------------------------------------------------

export interface DemoManifest {
  users: { dana: string; marcus: string; priya: string };
  login: { username: string; password: string };
  customers: Record<string, string>;
  projects: {
    residence: string; dental: string; townhomes: string; gym: string; summit: string; lobby: string;
  };
  residence: { pageFloorPlan: string; pageElevation: string; planFileId: string; proposalSentId: string; proposalDraftId: string };
  dental: {
    payAppIds: string[]; invoiceIds: string[]; changeOrderIds: string[]; lienReleaseIds: string[];
    rfiIds: string[]; issueIds: string[]; dailyReportIds: string[]; crewIds: string[];
    documentFileIds: Record<string, string>;
  };
  mail: { accountId: string; threadKeys: string[] };
  seededAt: string;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function seedDemoCompany(request: APIRequestContext): Promise<DemoManifest> {
  // 1. People. A fresh database holds only admin/admin; replace it with named
  // users so no screen shows a stray "admin".
  const boot = new Api(request, '');
  const first = await request.post('/api/auth/login', { data: { username: 'admin', password: 'admin' } });
  if (!first.ok()) {
    throw new Error(
      'The demo seed needs a fresh database (the default admin/admin account). ' +
      `Login failed with ${first.status()}. Run it through "npm run demo:seed", which starts from an empty folder.`,
    );
  }
  boot.token = (await first.json()).token;

  const ids: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const r = await boot.post('/api/users', { username: u.username, password: DEMO_PASSWORD, role: u.role });
    ids[u.username] = r.user.id;
  }
  const loginRes = await request.post('/api/auth/login', { data: { username: DEMO_USERS[0].username, password: DEMO_PASSWORD } });
  if (!loginRes.ok()) throw new Error(`demo admin login failed: ${loginRes.status()}`);
  const dana = new Api(request, (await loginRes.json()).token);
  const adminRow = (await dana.get<{ id: string; username: string }[]>('/api/users')).find(u => u.username === 'admin');
  if (adminRow) await dana.del(`/api/users/${adminRow.id}`);
  const danaId = ids['dana.whitfield'], marcusId = ids['marcus.lee'], priyaId = ids['priya.shah'];

  // 2. Company settings, logo, document types.
  const logo = await logoDataUrl();
  await dana.post('/api/settings', {
    appName: COMPANY.appName,
    logoUrl: logo,
    companyName: COMPANY.name,
    companyLegalName: COMPANY.legalName,
    companyEntityType: 'llc',
    companyStateOfFormation: 'Florida',
    companyPhone: COMPANY.phone,
    companyEmail: COMPANY.email,
    companyAddress: COMPANY.address,
    companyBrandColor: COMPANY.brandColor,
    invertLogoOnDocuments: 'false',
    documentTypes: JSON.stringify([{ id: 'submittal', label: 'Submittal' }, { id: 'warranty', label: 'Warranty' }]),
  });

  // 3. Customers.
  const customerSpecs = [
    { key: 'harbor', name: 'Harbor View Builders', contactName: 'Tom Becker', phone: '(555) 010-0171', address: '12 Dockside Rd, Riverton', domain: 'harborview.example.com', notes: 'General contractor. Net 30. Prefers proposals as PDF by email.' },
    { key: 'maple', name: 'Maple Ridge Homes', contactName: 'Alicia Moreno', phone: '(555) 010-0188', address: '900 Maple Ridge Pkwy, Riverton', domain: 'mapleridge.example.com', notes: 'Townhome developer. Pay apps on the 25th.' },
    { key: 'lakeside', name: 'Lakeside Dental Group', contactName: 'Dr. Naomi Park', phone: '(555) 010-0133', address: '400 Lakeview Ave, Riverton', domain: 'lakesidedental.example.com', notes: 'Owner-direct. Lien releases required with each payment.' },
    { key: 'school', name: 'Riverton School District', contactName: 'Greg Holloway', phone: '(555) 010-0120', address: '1 Education Way, Riverton', domain: 'rivertonschools.example.com', notes: 'Public bid. Prevailing wage.' },
    { key: 'summit', name: 'Summit Custom Homes', contactName: 'Elena Cruz', phone: '(555) 010-0156', address: '77 Summit Ln, Riverton', domain: 'summithomes.example.com', notes: '' },
  ];
  const customers: Record<string, string> = {};
  for (const c of customerSpecs) {
    const saved = await dana.post('/api/customers', {
      name: c.name, contactName: c.contactName, phone: c.phone, address: c.address, notes: c.notes,
      emails: {
        general: { to: `info@${c.domain}` },
        accounting: { to: `accounting@${c.domain}` },
        estimating: { to: `estimating@${c.domain}` },
        pm: { to: `${c.contactName.split(' ').pop()!.toLowerCase()}@${c.domain}` },
      },
    });
    customers[c.key] = saved.id;
  }

  // 4. The plan set (generated), uploaded once and shared by two projects' pages.
  const plan = await buildPlanSet();

  // 5. Projects.
  const P = {
    residence: randomUUID(), dental: randomUUID(), townhomes: randomUUID(),
    gym: randomUUID(), summit: randomUUID(), lobby: randomUUID(),
  };
  const customerOf = (key: string) => customerSpecs.find(c => c.key === key)!;
  const baseProject = (id: string, name: string, customerKey: string, extra: Record<string, unknown>) => ({
    id, name, createdAt: Date.now(), customerId: customers[customerKey], contractor: customerOf(customerKey).name,
    takeoffs: [], pages: [], version: 1, ...extra,
  });

  // 5a. Example Residence: bidding, with the plan set and takeoffs.
  const planFileId = randomUUID();
  await dana.upload({
    id: planFileId, bytes: plan.pdf, mime: pdfMime, name: 'Example Residence - Plan Set.pdf',
    kind: 'plan-source', projectId: P.residence, sourceType: 'plan-set', sourceId: P.residence,
  });
  const thumbs = [await dana.image(`data:image/png;base64,${plan.thumbnails[0].toString('base64')}`, P.residence, 'plan'),
                  await dana.image(`data:image/png;base64,${plan.thumbnails[1].toString('base64')}`, P.residence, 'plan')];

  const takeoffs = {
    ceiling: { id: randomUUID(), name: 'Ceiling Plaster', color: '#2563eb', type: 'area', unit: 'sf', costPerUnit: 3.1 },
    stucco: { id: randomUUID(), name: 'Exterior Stucco', color: '#d97706', type: 'area', unit: 'sf', costPerUnit: 9.5 },
    bead: { id: randomUUID(), name: 'Casing Bead', color: '#16a34a', type: 'length', unit: 'lf', costPerUnit: 2.4 },
    corner: { id: randomUUID(), name: 'Corner Bead', color: '#dc2626', type: 'count', unit: 'ea', costPerUnit: 11.5 },
  };
  const planSetId = randomUUID();
  const pageFloor = randomUUID(), pageElev = randomUUID();
  const rect = (x: number, y: number, w: number, h: number, planFn = planPoint) =>
    [planFn(x, y), planFn(x + w, y), planFn(x + w, y + h), planFn(x, y + h)];

  const roomMeasurements = ROOMS.map(r => ({
    id: randomUUID(), type: 'area', name: r.name, color: takeoffs.ceiling.color, takeoffId: takeoffs.ceiling.id,
    points: rect(r.x, r.y, r.w, r.h), planSetId,
  }));
  const perimeter = [planPoint(0, 0), planPoint(HOUSE.w, 0), planPoint(HOUSE.w, HOUSE.h), planPoint(0, HOUSE.h), planPoint(0, 0)];
  const beadMeasurements = [{
    id: randomUUID(), type: 'length', name: 'Exterior perimeter', color: takeoffs.bead.color, takeoffId: takeoffs.bead.id,
    points: perimeter, planSetId,
  }];
  const cornerPoints = [
    planPoint(0, 0), planPoint(HOUSE.w, 0), planPoint(HOUSE.w, HOUSE.h), planPoint(0, HOUSE.h),
    planPoint(20, 0), planPoint(34, 0), planPoint(0, 18), planPoint(16, 32), planPoint(26, 32), planPoint(38, 32), planPoint(48, 14), planPoint(20, 14),
  ];
  const cornerMeasurements = cornerPoints.map((p, i) => ({
    id: randomUUID(), type: 'count', name: `Corner ${i + 1}`, color: takeoffs.corner.color, takeoffId: takeoffs.corner.id,
    points: [p], planSetId,
  }));
  const windowSegments = ELEV_WINDOWS.map(w => ({
    points: [elevPoint(w.x, w.y), elevPoint(w.x + w.w, w.y), elevPoint(w.x + w.w, w.y + w.h), elevPoint(w.x, w.y + w.h)],
    subtract: true,
  }));
  const doorSegment = {
    points: [elevPoint(ELEV_DOOR.x, 0), elevPoint(ELEV_DOOR.x + ELEV_DOOR.w, 0), elevPoint(ELEV_DOOR.x + ELEV_DOOR.w, ELEV_DOOR.h), elevPoint(ELEV_DOOR.x, ELEV_DOOR.h)],
    subtract: true,
  };
  const ELEV_MULTIPLIER = 4; // front elevation stands in for all four sides
  const stuccoMeasurement = {
    id: randomUUID(), type: 'area', name: 'Walls (x4 sides)', color: takeoffs.stucco.color, takeoffId: takeoffs.stucco.id,
    points: [elevPoint(0, 0), elevPoint(ELEV.w, 0), elevPoint(ELEV.w, ELEV.wallH), elevPoint(0, ELEV.wallH)],
    segments: [...windowSegments, doorSegment], multiplier: ELEV_MULTIPLIER, planSetId,
  };

  const scale = { pixelDistance: PX_PER_FT * 10, realWorldDistance: 10, unit: 'ft' };
  const pageBase = { imageId: '', imageWidth: IMAGE_W, imageHeight: IMAGE_H, sourcePdfFileId: planFileId, scaleConfig: scale, planSetId };
  await dana.post('/api/projects', {
    ...baseProject(P.residence, 'Example Residence', 'harbor', {
      status: 'bidding', address: '123 Example St, Riverton', bidDueDate: ts(6),
      contactEmails: { pm: { to: 'becker@harborview.example.com' } },
      planSets: [{ id: planSetId, name: 'Permit set', date: ymd(-9), createdAt: ts(-9) }],
      takeoffs: Object.values(takeoffs),
      pages: [
        { ...pageBase, id: pageFloor, name: 'A-101 Floor Plan', pageNumber: 'A-101', thumbnailId: thumbs[0], sourcePdfPageNum: 1, sheetId: randomUUID(), measurements: [...roomMeasurements, ...beadMeasurements, ...cornerMeasurements] },
        { ...pageBase, id: pageElev, name: 'A-201 Elevation', pageNumber: 'A-201', thumbnailId: thumbs[1], sourcePdfPageNum: 2, sheetId: randomUUID(), measurements: [stuccoMeasurement] },
      ],
    }),
  });

  // Quantities for the proposal, computed from the same geometry.
  const ceilingSf = ROOMS.reduce((a, r) => a + r.w * r.h, 0);
  const wallSf = ELEV.w * ELEV.wallH - ELEV_WINDOWS.reduce((a, w) => a + w.w * w.h, 0) - ELEV_DOOR.w * ELEV_DOOR.h;
  const stuccoSf = wallSf * ELEV_MULTIPLIER;
  const beadLf = (HOUSE.w + HOUSE.h) * 2;
  const cornerEa = cornerPoints.length;
  // The proposal editor rounds a takeoff's price up to the next $100, so do the same here.
  const cents = (qty: number, price: number) => Math.ceil(Math.round(qty * price * 100) / 10000) * 10000;
  const nf = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

  // 5b. The other projects.
  await dana.post('/api/projects', baseProject(P.dental, 'Lakeside Dental Office Remodel', 'lakeside', {
    status: 'in_progress', address: '400 Lakeview Ave, Riverton',
    contactEmails: { accounting: { to: 'accounting@lakesidedental.example.com' } },
    aiaSettings: {
      ownerName: 'Lakeside Dental Group', ownerAddress: '400 Lakeview Ave, Riverton, FL',
      architectName: 'Example Design Group', architectAddress: '20 Studio Row, Riverton, FL',
      ownerProjectNumber: 'LDG-2026-07', architectProjectNumber: 'EDG-1142',
    },
  }));
  await dana.post('/api/projects', baseProject(P.townhomes, 'Maple Ridge Townhomes, Phase 2', 'maple', {
    status: 'in_progress', address: '900 Maple Ridge Pkwy, Riverton',
  }));
  await dana.post('/api/projects', baseProject(P.gym, 'Riverton Elementary Gym Ceiling', 'school', {
    status: 'bidding', address: '1 Education Way, Riverton', bidDueDate: ts(12),
  }));
  await dana.post('/api/projects', baseProject(P.summit, 'Summit Custom Home, Lot 14', 'summit', {
    status: 'bidding', address: '14 Summit Ln, Riverton', bidDueDate: ts(2),
  }));
  await dana.post('/api/projects', baseProject(P.lobby, 'Harbor View Lobby Refresh', 'harbor', {
    status: 'in_progress', archived: true, address: '12 Dockside Rd, Riverton',
  }));

  // Starred projects for the Favorites view.
  await dana.put('/api/user-preferences', { favoriteProjects: JSON.stringify([P.residence, P.dental, P.townhomes]) });

  // 6. Mail: one fake-provider account for Dana, so item sends and the inbox work.
  const mailDomain = 'example.com';
  const dentalPdf = await pageSetPdf('Scope of work, Lakeside Dental', 2);
  const mailSeed = await dana.post<{ accountId: string; threadKeys: string[] }>('/api/mail/_test/seed', {
    emailAddress: `dana@${mailDomain}`,
    threads: [
      {
        subject: 'Bid invitation: Example Residence stucco and plaster',
        from: { addr: 'estimating@harborview.example.com', name: 'Tom Becker' },
        messages: [{
          date: iso(-3, 8, 15),
          text: 'Dana,\n\nWe would like a number for the stucco and interior plaster on the Example Residence at 123 Example St. Plans are attached. Bids are due next week.\n\nThanks,\nTom',
          attachments: [{ name: 'Example Residence - Plans.pdf', mime: pdfMime, bytesBase64: (await pageSetPdf('Example Residence plans', 3)).toString('base64') }],
        }],
      },
      {
        subject: 'Lakeside Dental: pay app 2 question',
        from: { addr: 'drpark@lakesidedental.example.com', name: 'Naomi Park' },
        messages: [
          { date: iso(-2, 14, 5), text: 'Hi Dana, on the second pay application, can you confirm the soffit change order is included? Our accountant is asking.' },
          { date: iso(-2, 15, 40), text: 'Yes, change order 001 is on line 7 at 100 percent. I will send the conditional release with it today.' },
          { date: iso(-1, 9, 12), text: 'Perfect, thank you. Please copy accounting on the release.' },
        ],
      },
      {
        subject: 'Spring specials from Sample Supply Co.',
        from: { addr: 'news@samplesupply.example.com', name: 'Sample Supply Co.' },
        messages: [{
          date: iso(-1, 6, 30),
          text: 'Spring specials on lath, bead and basecoat. Open this email in a mail client to see the pictures.',
          html: '<div style="font-family:Arial,sans-serif;max-width:560px"><img src="https://images.example.com/banner-spring.png" alt="Spring specials banner" width="560" height="120" style="display:block"><h2>Spring specials</h2><p>Stock up on galvanized lath, casing bead and basecoat before the season starts. Contractor pricing on pallets through the end of the month.</p><p><a href="https://samplesupply.example.com/specials">See all specials</a></p></div>',
        }],
      },
      {
        subject: 'Maple Ridge Phase 2: schedule for building C',
        from: { addr: 'moreno@mapleridge.example.com', name: 'Alicia Moreno' },
        messages: [{
          date: iso(0, 7, 45),
          text: 'Dana, the framers finished building C early. Can your crew start scratch coat Monday instead of Wednesday? Let me know by end of day.',
        }],
      },
      {
        subject: 'Riverton Elementary gym ceiling: addendum 1',
        from: { addr: 'holloway@rivertonschools.example.com', name: 'Greg Holloway' },
        messages: [{
          date: iso(-4, 11, 0),
          text: 'Addendum 1 is attached. It changes the ceiling finish to a smooth skim coat and moves the bid due date. Please acknowledge receipt.',
          attachments: [{ name: 'Addendum 1.pdf', mime: pdfMime, bytesBase64: dentalPdf.toString('base64') }],
        }],
      },
      {
        subject: 'Insurance certificate request',
        from: { addr: 'accounting@summithomes.example.com', name: 'Summit Custom Homes Accounting' },
        messages: [{
          date: iso(-6, 10, 20),
          text: 'Before we can release the subcontract for Lot 14 we need a current certificate of insurance naming Summit Custom Homes as certificate holder.',
        }],
      },
    ],
  });

  // 7. Proposals. Example Residence: #1 sent to the builder, #2 a revision in draft.
  const prop1 = await dana.post(`/api/projects/${P.residence}/proposals`, {
    takeoffIds: [takeoffs.stucco.id, takeoffs.ceiling.id, takeoffs.bead.id, takeoffs.corner.id],
  });
  const proposalLines = [
    { kind: 'takeoff', takeoffId: takeoffs.stucco.id, description: 'Exterior stucco, three-coat system', qty: stuccoSf, price: 9.5, summary: `${nf(stuccoSf)} SF @ $9.50/SF` },
    { kind: 'takeoff', takeoffId: takeoffs.ceiling.id, description: 'Interior ceiling plaster, smooth finish', qty: ceilingSf, price: 3.1, summary: `${nf(ceilingSf)} SF @ $3.10/SF` },
    { kind: 'takeoff', takeoffId: takeoffs.bead.id, description: 'Casing bead at openings and perimeter', qty: beadLf, price: 2.4, summary: `${nf(beadLf)} LF @ $2.40/LF` },
    { kind: 'takeoff', takeoffId: takeoffs.corner.id, description: 'Corner bead', qty: cornerEa, price: 11.5, summary: `${cornerEa} EA @ $11.50/EA` },
  ].map(l => ({
    kind: l.kind, takeoffId: l.takeoffId, description: l.description,
    amountCents: cents(l.qty, l.price), derivedAmountCents: cents(l.qty, l.price), measurementSummary: l.summary, isAlternate: false,
  }));
  const manualLines = [
    { kind: 'manual', description: 'Scaffold erection and removal', amountCents: 240000, isAlternate: false },
    { kind: 'manual', description: 'Alternate 1: integral color finish coat in lieu of paint', amountCents: 385000, isAlternate: true },
  ];
  const proposalFields = {
    title: 'Stucco and interior plaster',
    validUntil: ymd(30),
    fontFamily: 'helvetica',
    coverNotes: 'Thank you for the opportunity to bid the Example Residence. Pricing below is based on the permit set A-101 and A-201.',
    terms: 'Payment: 30% at mobilization, 60% progress billings, 10% on completion. Net 30.',
    inclusions: ['All labor, materials and equipment', 'Three-coat stucco with sand float finish', 'Cleanup of our own debris daily'],
    exclusions: ['Painting and sealers', 'Permits and fees', 'Repair of work damaged by other trades'],
    paymentSchedule: [
      { description: 'Mobilization', percent: 30 }, { description: 'Progress billings', percent: 60 }, { description: 'Completion', percent: 10 },
    ],
    showGrandTotal: true, includeSignature: true,
  };
  await dana.put(`/api/proposals/${prop1.id}`, { ...proposalFields, version: prop1.version, lines: [...proposalLines, ...manualLines] });
  const propTotal = proposalLines.reduce((a, l) => a + l.amountCents, 0) + 240000;
  const prop1Pdf = await simpleDocPdf({
    title: 'Proposal #1: Example Residence',
    subtitle: 'Prepared for Harbor View Builders, 123 Example St, Riverton',
    rows: [
      ...proposalLines.map(l => [l.description, `$${(l.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`] as [string, string]),
      ['Scaffold erection and removal', '$2,400.00'],
      ['Total', `$${(propTotal / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`],
    ],
    paragraphs: [proposalFields.coverNotes, proposalFields.terms],
  });
  const prop1FileId = await dana.upload({
    bytes: prop1Pdf, mime: pdfMime, name: 'Proposal - Example Residence - 1.pdf', kind: 'proposal',
    projectId: P.residence, customerId: customers.harbor, sourceType: 'proposal', sourceId: prop1.id,
  });
  await dana.post(`/api/proposals/${prop1.id}/file`, { fileId: prop1FileId });
  await dana.post(`/api/proposals/${prop1.id}/send`, {
    to: 'estimating@harborview.example.com', fileId: prop1FileId, accountId: mailSeed.accountId,
    subject: 'Proposal: Example Residence stucco and plaster',
    body: 'Tom, attached is our proposal for the Example Residence. Let me know if you have questions.',
  });
  await dana.refreshGenerated(prop1FileId);
  // A revision, still being edited.
  const prop2 = await dana.post(`/api/projects/${P.residence}/proposals`, { revisedFromId: prop1.id });
  const revisedLines = [...proposalLines, ...manualLines].map(l => l.kind === 'manual' && l.isAlternate ? { ...l, amountCents: 365000 } : l);
  await dana.put(`/api/proposals/${prop2.id}`, {
    ...proposalFields, coverNotes: `${proposalFields.coverNotes} Revised to lower the color coat alternate.`,
    version: prop2.version, lines: revisedLines,
  });

  // Riverton gym: a short manual proposal, already sent.
  const gymProp = await dana.post(`/api/projects/${P.gym}/proposals`, {});
  await dana.put(`/api/proposals/${gymProp.id}`, {
    title: 'Gym ceiling skim coat', validUntil: ymd(20), showGrandTotal: true, includeSignature: true,
    terms: 'Prevailing wage rates included. Net 30.',
    version: gymProp.version,
    lines: [
      { kind: 'manual', description: 'Scaffold and lift rental', amountCents: 1850000, isAlternate: false },
      { kind: 'manual', description: 'Smooth skim coat on 6,400 SF of ceiling', amountCents: 2880000, isAlternate: false },
    ],
  });
  const gymPdf = await simpleDocPdf({
    title: 'Proposal #1: Gym Ceiling', subtitle: 'Prepared for Riverton School District',
    rows: [['Scaffold and lift rental', '$18,500.00'], ['Smooth skim coat, 6,400 SF', '$28,800.00'], ['Total', '$47,300.00']],
  });
  const gymFile = await dana.upload({
    bytes: gymPdf, mime: pdfMime, name: 'Proposal - Gym Ceiling - 1.pdf', kind: 'proposal',
    projectId: P.gym, customerId: customers.school, sourceType: 'proposal', sourceId: gymProp.id,
  });
  await dana.post(`/api/proposals/${gymProp.id}/file`, { fileId: gymFile });
  await dana.post(`/api/proposals/${gymProp.id}/send`, {
    to: 'holloway@rivertonschools.example.com', fileId: gymFile, accountId: mailSeed.accountId,
  });
  await dana.refreshGenerated(gymFile);

  // 8. Billing on the dental remodel: change orders, schedule of values, pay apps, payments, invoices.
  const dental = P.dental;
  const co1 = await dana.post(`/api/projects/${dental}/change-orders`, {
    title: 'Additional soffit plaster at reception', description: 'Owner added a curved soffit over the reception desk.',
    date: ts(-30), scheduleImpactDays: 2,
    lines: [{ description: 'Soffit framing and lath', qty: 1, unitPrice: 1150 }, { description: 'Three-coat plaster, smooth', qty: 1, unitPrice: 1300 }],
  });
  await dana.patch(`/api/change-orders/${co1.id}`, { status: 'approved' });
  const co2 = await dana.post(`/api/projects/${dental}/change-orders`, {
    title: 'Repair water-damaged wall at operatory 3', description: 'Found behind the old cabinets after demolition.',
    date: ts(-6), lumpSumAmount: 1180, scheduleImpactDays: 1, lines: [],
  });
  await dana.patch(`/api/change-orders/${co2.id}`, { status: 'sent' });
  const coPdf = await simpleDocPdf({
    title: 'Change Order 001', subtitle: 'Lakeside Dental Office Remodel',
    rows: [['Soffit framing and lath', '$1,150.00'], ['Three-coat plaster, smooth', '$1,300.00'], ['Total', '$2,450.00']],
    paragraphs: ['Owner added a curved soffit over the reception desk. Schedule impact: 2 days.'],
  });
  await dana.upload({
    bytes: coPdf, mime: pdfMime, name: 'Change Order 001 - Lakeside Dental.pdf', kind: 'change-order',
    projectId: dental, customerId: customers.lakeside, sourceType: 'change-order', sourceId: co1.id,
  });

  const sovSpec: [string, number][] = [
    ['Demolition and prep', 480000], ['Metal framing and lath', 1120000], ['Scratch and brown coat', 2460000],
    ['Skim coat finish', 1980000], ['Ceiling plaster', 1750000], ['Cleanup and punch list', 350000],
  ];
  for (const [description, scheduledValueCents] of sovSpec) {
    await dana.post(`/api/projects/${dental}/aia/sov`, { description, scheduledValueCents });
  }
  await dana.post(`/api/projects/${dental}/aia/sov/sync-change-orders`, {});
  const sov = await dana.get<{ id: string; lineType: string; description: string }[]>(`/api/projects/${dental}/aia/sov`);
  const sovItems = sov.filter(l => l.lineType === 'item');
  const percentsFor = (pcts: number[]) => sovItems.map((l, i) => ({ sovLineId: l.id, percentComplete: pcts[i] ?? 0, storedMaterialsCents: 0 }));

  const makePayApp = async (periodTo: string, applicationDate: string, pcts: number[], finalize: boolean) => {
    const app = await dana.post(`/api/projects/${dental}/aia/pay-apps`, { periodTo, applicationDate });
    const full = await dana.get(`/api/aia/pay-apps/${app.id}`);
    await dana.put(`/api/aia/pay-apps/${app.id}/lines`, { lines: percentsFor(pcts), version: full.version ?? 1 });
    if (finalize) await dana.patch(`/api/aia/pay-apps/${app.id}`, { status: 'finalized' });
    return app.id as string;
  };
  const payApp1 = await makePayApp(ymd(-45), ymd(-43), [100, 100, 60, 40, 0, 0, 0], true);
  const payApp2 = await makePayApp(ymd(-14), ymd(-12), [100, 100, 100, 85, 45, 0, 100], true);
  const payApp3 = await makePayApp(ymd(16), ymd(16), [100, 100, 100, 100, 80, 40, 100], false);

  const pay1 = await dana.post(`/api/projects/${dental}/payments`, {
    targetType: 'payapp', targetId: payApp1, amount: 34812, date: ts(-30), method: 'ACH', note: 'Pay app 1, net of 10% retainage',
  });
  const invTm = await dana.post(`/api/projects/${dental}/invoices`, {
    date: ts(-8), status: 'sent', terms: 'Net 15',
    lines: [
      { description: 'Time and material: relocate electrical boxes before lath', qty: 14, unitPrice: 62 },
      { description: 'Extra lath and bead', qty: 1, unitPrice: 465 },
    ],
  });
  for (const [id, number, rows] of [
    [invTm.id, '1001', [['Time and material, 14 hr @ $62', '$868.00'], ['Extra lath and bead', '$465.00']]],
  ] as [string, string, [string, string][]][]) {
    const bytes = await simpleDocPdf({ title: `Invoice ${number}`, subtitle: 'Lakeside Dental Office Remodel', rows });
    await dana.upload({
      bytes, mime: pdfMime, name: `Invoice ${number} - Lakeside Dental.pdf`, kind: 'invoice',
      projectId: dental, customerId: customers.lakeside, sourceType: 'invoice', sourceId: id,
    });
  }
  await dana.upload({
    bytes: await simpleDocPdf({
      title: 'Application and Certificate for Payment', subtitle: 'Pay application 2, Lakeside Dental Office Remodel',
      rows: [['Contract sum to date', '$83,850.00'], ['Total completed and stored', '$67,755.00'], ['Retainage (10%)', '$6,775.50'], ['Less previous certificates', '$34,812.00'], ['Current payment due', '$26,167.50']],
    }),
    mime: pdfMime, name: 'Pay App 2 - Lakeside Dental.pdf', kind: 'payapp-pdf',
    projectId: dental, customerId: customers.lakeside, sourceType: 'payapp', sourceId: payApp2,
  });

  // Lien releases: an unconditional one for the payment received, a conditional one for pay app 2.
  const lienIds: string[] = [];
  const lienFrom = async (query: Record<string, string>, extra: Record<string, unknown>) => {
    const q = new URLSearchParams(query);
    const prefill = await dana.get(`/api/projects/${dental}/lien-releases/prefill?${q}`);
    const { source, warnings, ...fields } = prefill;
    void source; void warnings;
    const created = await dana.post(`/api/projects/${dental}/lien-releases`, {
      ...fields, signerName: 'Dana Whitfield', signerTitle: 'Owner', ...extra,
    });
    return created.id as string;
  };
  lienIds.push(await lienFrom(
    { paymentId: pay1.id, paymentType: 'progress', conditional: 'false' },
    { throughDate: ymd(-45), releaseDate: ymd(-29) }));
  lienIds.push(await lienFrom(
    { sourceType: 'payapp', sourceId: payApp2, paymentType: 'progress', conditional: 'true' },
    { throughDate: ymd(-14), releaseDate: ymd(-1), conditionKind: 'check', checkNumber: '5107', checkMaker: 'Lakeside Dental Group' }));
  for (const [id, label, amount] of [[lienIds[0], 'Unconditional waiver and release on progress payment', '$34,812.00'], [lienIds[1], 'Conditional waiver and release on progress payment', '$26,167.50']] as const) {
    const lr = await dana.get(`/api/lien-releases/${id}`);
    const lrFile = await dana.upload({
      bytes: await simpleDocPdf({
        title: label, subtitle: `Lien release ${lr.number ?? ''}  |  Lakeside Dental Office Remodel`,
        rows: [['Lienor', lr.lienorName], ['Customer', lr.customerName], ['Owner', lr.ownerName], ['Amount', amount]],
        paragraphs: ['This is a demonstration document generated by the screenshot seed. It is not a legal form.'],
      }),
      mime: pdfMime, name: `Lien Release ${lr.number ?? ''} - Lakeside Dental.pdf`.replace('  ', ' '), kind: 'lien-release',
      projectId: dental, customerId: customers.lakeside, sourceType: 'lien-release', sourceId: id,
    });
    // The first release went out with the payment; the second is still a draft.
    if (id === lienIds[0]) {
      await dana.post(`/api/lien-releases/${id}/send`, { to: 'accounting@lakesidedental.example.com', fileId: lrFile, accountId: mailSeed.accountId });
      await dana.refreshGenerated(lrFile);
    }
  }

  // Townhomes: invoices, one overdue with a part payment.
  const thInv1 = await dana.post(`/api/projects/${P.townhomes}/invoices`, {
    date: ts(-48), status: 'sent', terms: 'Net 30',
    lines: [{ description: 'Building A: scratch and brown coat, 12 units', qty: 12, unitPrice: 1450 }],
  });
  await dana.post(`/api/projects/${P.townhomes}/payments`, {
    targetType: 'invoice', targetId: thInv1.id, amount: 9000, date: ts(-20), method: 'ACH', note: 'Partial payment',
  });
  const thInv2 = await dana.post(`/api/projects/${P.townhomes}/invoices`, {
    date: ts(-5), status: 'sent', terms: 'Net 30',
    lines: [{ description: 'Building B: lath and scratch coat, 8 units', qty: 8, unitPrice: 1380 }],
  });
  await dana.post(`/api/projects/${P.townhomes}/invoices`, {
    date: ts(0), status: 'draft', terms: 'Net 30',
    lines: [{ description: 'Building C: mobilization', qty: 1, unitPrice: 3200 }],
  });
  const thFiles: Record<string, string> = {};
  for (const [id, , rows] of [[thInv1.id, '', [['Building A, 12 units @ $1,450', '$17,400.00']]], [thInv2.id, '', [['Building B, 8 units @ $1,380', '$11,040.00']]]] as [string, string, [string, string][]][]) {
    const num = (await dana.get(`/api/invoices/${id}`)).number as string;
    thFiles[id] = await dana.upload({
      bytes: await simpleDocPdf({ title: `Invoice ${num}`, subtitle: 'Maple Ridge Townhomes, Phase 2', rows }),
      mime: pdfMime, name: `Invoice ${num} - Maple Ridge.pdf`, kind: 'invoice',
      projectId: P.townhomes, customerId: customers.maple, sourceType: 'invoice', sourceId: id,
    });
  }
  // Sending adds an item to the Sent folder of the fake mailbox.
  await dana.post(`/api/invoices/${thInv2.id}/send`, {
    to: 'accounting@mapleridge.example.com', accountId: mailSeed.accountId, fileId: thFiles[thInv2.id],
  });
  await dana.refreshGenerated(thFiles[thInv2.id]);

  // Lobby refresh (archived): a paid invoice.
  const lobbyInv = await dana.post(`/api/projects/${P.lobby}/invoices`, {
    date: ts(-120), status: 'sent', terms: 'Net 30', lines: [{ description: 'Lobby wall skim coat and ceiling repair', qty: 1, unitPrice: 7450 }],
  });
  await dana.post(`/api/projects/${P.lobby}/payments`, { targetType: 'invoice', targetId: lobbyInv.id, amount: 7450, date: ts(-95), method: 'Check', note: 'Check 3318' });

  // 9. Field records on the dental remodel.
  const crews = await dana.get<{ id: string; name: string }[]>(`/api/projects/${dental}/daily-report-crews`);
  await dana.put(`/api/daily-report-crews/${crews[0].id}`, { name: 'Plaster crew A' });
  const crewB = await dana.post(`/api/projects/${dental}/daily-report-crews`, { name: 'Lath crew (sub)' });
  const crewA = crews[0].id;
  const weather = (cond: string, lo: number, hi: number) => ({
    weatherSummary: cond, temperature: `${lo}F to ${hi}F`,
    weatherHourly: [
      { hour: '7 AM', tempF: lo, condition: cond }, { hour: '9 AM', tempF: lo + 5, condition: cond }, { hour: '11 AM', tempF: hi - 4, condition: cond },
      { hour: '1 PM', tempF: hi, condition: cond }, { hour: '3 PM', tempF: hi - 2, condition: cond },
    ],
  });
  const reportSpecs = [
    { crew: crewA, w: weather('Clear', 66, 82), men: [['Plasterer', 4], ['Laborer', 2], ['Foreman', 1]], notes: 'Finished the skim coat in the waiting room and started operatory 2. Inspector walked the ceiling framing and passed it.', issues: 'Delivery of basecoat came 90 minutes late.' },
    { crew: crewA, w: weather('Partly cloudy', 64, 80), men: [['Plasterer', 4], ['Laborer', 2], ['Foreman', 1]], notes: 'Brown coat on the corridor walls. Masked the new flooring in reception before plastering the soffit.', issues: '' },
    { crew: crewA, w: weather('Light rain', 62, 74), men: [['Plasterer', 3], ['Laborer', 2], ['Foreman', 1]], notes: 'Rain slowed the exterior patching. Crew moved inside to operatory 3 and set bead.', issues: 'Water-damaged wall found in operatory 3; change order 002 sent.' },
    { crew: crewA, w: weather('Clear', 65, 81), men: [['Plasterer', 4], ['Laborer', 3], ['Foreman', 1]], notes: 'Scratch coat on operatories 1 and 3. Cleaned up and covered work for the weekend.', issues: '' },
    { crew: crewA, w: weather('Clear', 67, 84), men: [['Plasterer', 5], ['Laborer', 2], ['Foreman', 1]], notes: 'Ceiling plaster in the hallway. Walked the job with Dr. Park and noted three touch-ups.', issues: '' },
  ];
  const days = recentWorkdays(reportSpecs.length);
  const dailyReportIds: string[] = [];
  for (let i = 0; i < reportSpecs.length; i++) {
    const s = reportSpecs[i];
    const r = await dana.post(`/api/projects/${dental}/daily-reports`, {
      crewId: s.crew, reportDate: ymd(days[i]), startTime: '07:00', jobName: 'Lakeside Dental Office Remodel', contractorName: COMPANY.name,
      ...s.w, manCounts: s.men.map(([type, count]) => ({ type, count })), fieldNotes: s.notes, issues: s.issues,
    });
    dailyReportIds.push(r.id);
  }
  const subReport = await dana.post(`/api/projects/${dental}/daily-reports`, {
    crewId: crewB.id, reportDate: ymd(days[0]), startTime: '07:30', jobName: 'Lakeside Dental Office Remodel', contractorName: 'Lath crew (sub)',
    ...weather('Clear', 66, 82), manCounts: [['Lather', 3], ['Helper', 1]].map(([type, count]) => ({ type, count })),
    fieldNotes: 'Hung lath on the last two operatory walls and the reception soffit.', issues: '',
  });
  dailyReportIds.push(subReport.id);
  const drPhoto = await uploadPhoto(dana, 'smooth', { fileKind: 'daily-report-photo', projectId: dental, sourceType: 'dailyReport', sourceId: dailyReportIds[0], name: 'waiting-room-skim.png' });
  await dana.post(`/api/daily-reports/${dailyReportIds[0]}/photos`, { fileId: drPhoto });
  const drPhoto2 = await uploadPhoto(dana, 'scaffold', { fileKind: 'daily-report-photo', projectId: dental, sourceType: 'dailyReport', sourceId: dailyReportIds[1], name: 'reception-scaffold.png' });
  await dana.post(`/api/daily-reports/${dailyReportIds[1]}/photos`, { fileId: drPhoto2 });

  // Townhomes: two daily reports (the first crew tab is created on first read).
  const thCrews = await dana.get<{ id: string }[]>(`/api/projects/${P.townhomes}/daily-report-crews`);
  for (let i = 0; i < 2; i++) {
    await dana.post(`/api/projects/${P.townhomes}/daily-reports`, {
      crewId: thCrews[0].id, reportDate: ymd(days[i]), startTime: '06:30', jobName: 'Maple Ridge Townhomes, Phase 2', contractorName: COMPANY.name,
      ...weather('Clear', 68, 85), manCounts: [{ type: 'Plasterer', count: 6 }, { type: 'Laborer', count: 3 }],
      fieldNotes: i === 0 ? 'Brown coat on building B, units 3 through 6.' : 'Scaffold moved to building C. Patched window returns on building A.', issues: '',
    });
  }

  // RFIs.
  const rfiIds: string[] = [];
  const rfiSpecs = [
    { title: 'Plaster thickness at CMU wall', question: 'Sheet A-5 shows 7/8 in. plaster over the CMU wall at the lab. Can we use a bonding agent and 5/8 in. instead?', specRef: '09 24 00', drawingRef: 'A-5', attention: 'Example Design Group', needed: ymd(5), status: 'open', assignee: priyaId },
    { title: 'Control joint locations at reception', question: 'Please confirm control joint spacing for the curved soffit over the reception desk.', specRef: '09 24 00', drawingRef: 'A-7', attention: 'Example Design Group', needed: ymd(2), status: 'sent', assignee: danaId },
    { title: 'Color of finish coat in operatories', question: 'Is the finish coat integral color or painted? The finish schedule lists both.', specRef: '09 90 00', drawingRef: 'A-9', attention: 'Dr. Naomi Park', needed: ymd(-4), status: 'answered', response: 'Painted finish. Color to be selected by the owner. Skim coat only.', assignee: marcusId },
    { title: 'Backing for wall-mounted monitors', question: 'Who provides blocking for the wall-mounted monitors in the waiting room?', specRef: '06 10 00', drawingRef: 'A-3', attention: 'Example Design Group', needed: ymd(-12), status: 'closed', response: 'Framing contractor provides blocking per revised A-3.', assignee: null },
  ];
  for (const s of rfiSpecs) {
    const r = await dana.post(`/api/projects/${dental}/rfis`, {
      title: s.title, question: s.question, specRef: s.specRef, drawingRef: s.drawingRef, attention: s.attention,
      responseNeededBy: s.needed, assigneeUserId: s.assignee ?? undefined,
    });
    rfiIds.push(r.id);
    if (s.status === 'sent') await dana.patch(`/api/rfis/${r.id}`, { status: 'sent' });
    if (s.status === 'answered' || s.status === 'closed') {
      await dana.patch(`/api/rfis/${r.id}`, { status: 'sent' });
      await dana.post(`/api/rfis/${r.id}/response`, { text: s.response });
      if (s.status === 'closed') await dana.patch(`/api/rfis/${r.id}`, { status: 'closed' });
    }
  }

  // Issues (with photos).
  const issueIds: string[] = [];
  const issueSpecs: { title: string; description: string; status: string; photo: PhotoKind }[] = [
    { title: 'Hairline cracking at the existing corner', description: 'Cracks showing at the northeast corner where new plaster meets the old wall. Needs a control joint or a cut-and-patch.', status: 'open', photo: 'crack' },
    { title: 'Floor protection damaged in corridor', description: 'Masking paper torn by another trade. Replaced before the brown coat.', status: 'resolved', photo: 'patch' },
    { title: 'Scaffold blocked by delivery pallets', description: 'Pallets stacked at the west entrance. Asked the GC to move them before Monday.', status: 'sent', photo: 'scaffold' },
  ];
  for (const s of issueSpecs) {
    const r = await dana.post(`/api/projects/${dental}/issues`, { title: s.title, description: s.description });
    issueIds.push(r.id);
    const photoId = await uploadPhoto(dana, s.photo, { fileKind: 'issue-photo', projectId: dental, sourceType: 'issue', sourceId: r.id, name: `issue-${r.number}.png` });
    await dana.post(`/api/issues/${r.id}/photos`, { fileId: photoId });
    if (s.status !== 'open') await dana.patch(`/api/issues/${r.id}`, { status: s.status });
  }

  // Punch list.
  const punchSpecs: [string, string, boolean][] = [
    ['Reception', 'Touch up soffit corner at the desk return', false],
    ['Reception', 'Sand a trowel mark above the door header', true],
    ['Waiting room', 'Fill small divots on the north wall', true],
    ['Waiting room', 'Clean plaster off the window sills', false],
    ['Operatory 1', 'Patch nail pops at the ceiling seam', false],
    ['Operatory 2', 'Re-skim the area behind the sink', false],
    ['Operatory 3', 'Match texture on the repaired wall section', false],
    ['Corridor', 'Remove masking tape residue from the baseboard', true],
  ];
  const punchIds: string[] = [];
  for (const [area, description, done] of punchSpecs) {
    const r = await dana.post(`/api/projects/${dental}/punch`, { area, description });
    punchIds.push(r.id);
    if (done) await dana.patch(`/api/punch/${r.id}`, { done: true });
  }
  const punchPhoto = await uploadPhoto(dana, 'patch', { fileKind: 'punch-photo', projectId: dental, sourceType: 'punch', sourceId: punchIds[0], name: 'reception-touch-up.png' });
  await dana.post(`/api/punch/${punchIds[0]}/photos`, { fileId: punchPhoto, stage: 'before' });

  // Townhomes: a short punch list and an issue.
  const thIssue = await dana.post(`/api/projects/${P.townhomes}/issues`, {
    title: 'Window flashing missing at unit B4', description: 'Stucco cannot be started until flashing is installed.',
  });
  await dana.patch(`/api/issues/${thIssue.id}`, { status: 'sent' });
  for (const [area, description] of [['Building A', 'Patch scaffold tie holes'], ['Building A', 'Caulk control joints at unit 3']] as const) {
    await dana.post(`/api/projects/${P.townhomes}/punch`, { area, description });
  }

  // Tasks, grouped by category like checklists.
  const taskSpecs: { category: string; title: string; notes?: string; assignee?: string; due?: string; project?: string; customer?: string; status?: string }[] = [
    { category: 'Pre-start checklist', title: 'Confirm scaffold delivery for Maple Ridge building C', assignee: marcusId, due: ymd(1), project: P.townhomes },
    { category: 'Pre-start checklist', title: 'Order basecoat and bead for Riverton gym', assignee: priyaId, due: ymd(8), project: P.gym },
    { category: 'Pre-start checklist', title: 'Collect signed subcontract from Summit', assignee: danaId, due: ymd(3), project: P.summit, status: 'in_progress' },
    { category: 'Closeout', title: 'Send final lien release for Lakeside Dental', assignee: danaId, due: ymd(12), project: P.dental },
    { category: 'Closeout', title: 'Walk the punch list with Dr. Park', assignee: marcusId, due: ymd(10), project: P.dental, status: 'in_progress' },
    { category: 'Closeout', title: 'Photograph finished soffit for the portfolio', assignee: marcusId, due: ymd(-2), project: P.dental, status: 'done' },
    { category: 'Office', title: 'Renew general liability certificate', notes: 'Summit Custom Homes asked for a new certificate holder.', assignee: priyaId, due: ymd(-1), customer: customers.summit },
    { category: 'Office', title: 'Follow up on the unpaid Maple Ridge invoice', assignee: danaId, due: ymd(2), customer: customers.maple },
    { category: 'Office', title: 'Send Harbor View the revised Example Residence proposal', assignee: danaId, due: ymd(4), project: P.residence },
    { category: 'Office', title: 'Update the price list for stucco materials', assignee: priyaId, due: ymd(14), status: 'done' },
  ];
  for (const t of taskSpecs) {
    const r = await dana.post('/api/tasks', {
      category: t.category, title: t.title, notes: t.notes, assigneeUserId: t.assignee, dueDate: t.due, projectId: t.project, customerId: t.customer,
    });
    if (t.status) await dana.patch(`/api/tasks/${r.id}`, { status: t.status });
  }

  // 10. Documents of several kinds (the global Documents page and project tabs).
  const documentFileIds: Record<string, string> = {};
  documentFileIds.scope = await dana.upload({
    bytes: await simpleDocPdf({
      title: 'Scope of work', subtitle: 'Lakeside Dental Office Remodel',
      rows: [['Area', 'Reception, waiting room, corridor, three operatories'], ['Finish', 'Three-coat plaster, smooth skim coat'], ['Schedule', 'Eight weeks from mobilization']],
      paragraphs: ['Scratch and brown coat on all new metal lath. Skim coat on new and existing gypsum surfaces. Curved soffit over the reception desk per detail 4/A-7.'],
    }),
    mime: pdfMime, name: 'Scope of Work - Lakeside Dental.pdf', kind: 'document', projectId: dental, customerId: customers.lakeside,
  });
  documentFileIds.subcontract = await dana.upload({
    bytes: await pageSetPdf('Subcontract agreement', 4), mime: pdfMime, name: 'Subcontract - Lakeside Dental.pdf', kind: 'document', projectId: dental, customerId: customers.lakeside,
  });
  documentFileIds.addendum = await dana.upload({
    bytes: await pageSetPdf('Addendum 1', 2), mime: pdfMime, name: 'Addendum 1 - Lakeside Dental.pdf', kind: 'document', projectId: dental, customerId: customers.lakeside,
  });
  documentFileIds.materials = await dana.upload({
    bytes: await summarySpreadsheet([
      ['Galvanized lath (sheets)', 180, 'ea', 9.8], ['Casing bead (10 ft)', 120, 'ea', 4.35], ['Scratch and brown coat (bags)', 260, 'bag', 14.2],
      ['Finish coat (bags)', 90, 'bag', 18.5], ['Corner bead (10 ft)', 60, 'ea', 5.1],
    ]),
    mime: xlsxMime, name: 'Material Takeoff Summary.xlsx', kind: 'spreadsheet', projectId: dental, customerId: customers.lakeside,
  });
  documentFileIds.sitePhoto = await dana.upload({
    bytes: await sitePhoto('smooth'), mime: pngMime, name: 'Waiting room - finished skim coat.png', kind: 'photo', projectId: dental,
  });
  documentFileIds.submittal = await dana.upload({
    bytes: await pageSetPdf('Basecoat product data', 3), mime: pdfMime, name: 'Submittal - Basecoat Product Data.pdf', kind: 'custom:submittal', projectId: dental, customerId: customers.lakeside,
  });
  documentFileIds.warranty = await dana.upload({
    bytes: await simpleDocPdf({ title: 'Workmanship warranty', subtitle: 'Harbor View Lobby Refresh', paragraphs: ['Cedar Point Plastering warrants its workmanship for two years from completion.'] }),
    mime: pdfMime, name: 'Warranty - Lobby Refresh.pdf', kind: 'custom:warranty', projectId: P.lobby, customerId: customers.harbor,
  });
  documentFileIds.insurance = await dana.upload({
    bytes: await simpleDocPdf({ title: 'Certificate of liability insurance', subtitle: COMPANY.legalName, rows: [['Policy', 'GL-0000-DEMO'], ['Coverage', '$1,000,000 per occurrence'], ['Expires', ymd(240)]] }),
    mime: pdfMime, name: 'Certificate of Insurance.pdf', kind: 'company-document',
  });
  documentFileIds.safety = await dana.upload({
    bytes: await pageSetPdf('Safety program', 6), mime: pdfMime, name: 'Company Safety Program.pdf', kind: 'company-document',
  });
  documentFileIds.townhomePlans = await dana.upload({
    bytes: await pageSetPdf('Townhome unit plans', 3), mime: pdfMime, name: 'Townhome Unit Plans.pdf', kind: 'document', projectId: P.townhomes, customerId: customers.maple,
  });

  const manifest: DemoManifest = {
    users: { dana: danaId, marcus: marcusId, priya: priyaId },
    login: { username: DEMO_USERS[0].username, password: DEMO_PASSWORD },
    customers,
    projects: P,
    residence: { pageFloorPlan: pageFloor, pageElevation: pageElev, planFileId, proposalSentId: prop1.id, proposalDraftId: prop2.id },
    dental: {
      payAppIds: [payApp1, payApp2, payApp3],
      invoiceIds: [invTm.id],
      changeOrderIds: [co1.id, co2.id],
      lienReleaseIds: lienIds,
      rfiIds, issueIds, dailyReportIds, crewIds: [crewA, crewB.id],
      documentFileIds,
    },
    mail: { accountId: mailSeed.accountId, threadKeys: mailSeed.threadKeys },
    seededAt: new Date().toISOString(),
  };
  return manifest;
}
