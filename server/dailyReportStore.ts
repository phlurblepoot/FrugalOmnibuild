// server/dailyReportStore.ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  type PdfAttachmentTable, listPdfAttachments, addPdfAttachment, updatePdfAttachment, removePdfAttachment,
} from './pdfAttachments';
import { DEFAULT_START_TIME, isStartTime } from './weather';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class DateTakenError extends Error {
  constructor(public existingId: string) { super('date_taken'); }
}
// A crew rule refused the change — the code says which (the route answers 409
// with it, and the message is fit to show as is).
export type CrewConflictCode = 'crew_name_taken' | 'crew_has_reports' | 'last_crew';
export class CrewConflictError extends Error {
  constructor(public code: CrewConflictCode, message: string) { super(message); }
}

export interface ManCountLine { type: string; count: number; }
export interface DailyWeatherHour { hour: string; tempF: number | null; condition: string; }
export interface DailyReportInput {
  crewId?: string; reportDate?: string; startTime?: string | null; jobName?: string; contractorName?: string;
  weatherSummary?: string; temperature?: string; weatherHourly?: DailyWeatherHour[];
  manCounts?: ManCountLine[]; fieldNotes?: string; issues?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseArr = (s: string | null): any[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

// Returns the id of the report already occupying (projectId, crewId,
// reportDate) — one report per date per crew — if any, excluding excludeId
// (used when a save moves a report onto a date it already occupies).
function takenBy(db: Database.Database, projectId: string, crewId: string, reportDate: string, excludeId?: string): string | undefined {
  const row = db.prepare('SELECT id FROM daily_reports WHERE projectId = ? AND crewId = ? AND reportDate = ?').get(projectId, crewId, reportDate) as any;
  return row && row.id !== excludeId ? row.id : undefined;
}

// ── Crews ────────────────────────────────────────────────────────────────
// A crew is a named tab on a project's Daily Reports page — the company's own
// crew or a sub's — and each crew is its own set of reports, one per date
// (spec docs/superpowers/specs/2026-10-06-daily-report-crews-design.md).

export const DEFAULT_CREW_NAME = 'Crew 1';
const CREW_NAME_MAX = 80;

// Trimmed and required; a crew name is unique within its project ignoring
// case (excludeId: the crew being renamed, which may change its own case).
function checkCrewName(db: Database.Database, projectId: string, name: unknown, excludeId?: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new ValidationError('A crew name is required');
  if (trimmed.length > CREW_NAME_MAX) throw new ValidationError(`A crew name can be at most ${CREW_NAME_MAX} characters`);
  const lower = trimmed.toLowerCase();
  const others = db.prepare('SELECT id, name FROM daily_report_crews WHERE projectId = ?').all(projectId) as { id: string; name: string }[];
  if (others.some(c => c.id !== excludeId && c.name.toLowerCase() === lower)) {
    throw new CrewConflictError('crew_name_taken', `There is already a crew named "${trimmed}" on this project`);
  }
  return trimmed;
}

function getCrewRow(db: Database.Database, id: string): any {
  const row = db.prepare('SELECT * FROM daily_report_crews WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Crew not found');
  return row;
}

function crewReportCount(db: Database.Database, projectId: string, crewId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM daily_reports WHERE projectId = ? AND crewId = ?').get(projectId, crewId) as any).c;
}

// A project's crews in tab order, each with its report count (a crew with
// reports can't be deleted). A project with no crew yet — a new one, or one
// that had no reports when migration 45 ran — gets "Crew 1" here, so its page
// always has a tab to file a report under. The insert is one statement that
// only fires while the project has no crew at all, so two pages opening at
// once can't make two.
export function listCrews(db: Database.Database, projectId: string): any[] {
  requireProject(db, projectId);
  const now = Date.now();
  db.prepare(`INSERT INTO daily_report_crews (id, projectId, name, sortOrder, createdAt, updatedAt)
      SELECT ?, ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM daily_report_crews WHERE projectId = ?)`)
    .run(uuidv4(), projectId, DEFAULT_CREW_NAME, now, now, projectId);
  return db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM daily_reports r WHERE r.projectId = c.projectId AND r.crewId = c.id) AS reportCount
      FROM daily_report_crews c WHERE c.projectId = ? ORDER BY c.sortOrder, c.createdAt, c.id`).all(projectId) as any[];
}

export function getCrew(db: Database.Database, id: string): any | null {
  return db.prepare('SELECT * FROM daily_report_crews WHERE id = ?').get(id) ?? null;
}

// A new crew goes at the end of the tabs.
export function createCrew(db: Database.Database, projectId: string, name: unknown): any {
  requireProject(db, projectId);
  const trimmed = checkCrewName(db, projectId, name);
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM daily_report_crews WHERE projectId = ?').get(projectId) as any).m;
  const id = uuidv4();
  const now = Date.now();
  db.prepare('INSERT INTO daily_report_crews (id, projectId, name, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, trimmed, max + 1, now, now);
  return getCrew(db, id);
}

// The crew's name is printed on each of its reports' PDFs, so a rename stamps
// their updatedAt (version left alone, as for photos below): a PDF made under
// the old name then reads out of date.
export function renameCrew(db: Database.Database, id: string, name: unknown): any {
  const crew = getCrewRow(db, id);
  const trimmed = checkCrewName(db, crew.projectId, name, id);
  if (trimmed === crew.name) return crew;
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE daily_report_crews SET name = ?, updatedAt = ? WHERE id = ?').run(trimmed, now, id);
    db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE projectId = ? AND crewId = ?').run(now, crew.projectId, id);
  });
  tx();
  return getCrew(db, id);
}

// Only an empty crew can go — reports are never deleted along with a crew —
// and never the project's last one (the page always keeps a tab).
export function deleteCrew(db: Database.Database, id: string): void {
  const crew = getCrewRow(db, id);
  if (crewReportCount(db, crew.projectId, id) > 0) {
    throw new CrewConflictError('crew_has_reports', `"${crew.name}" has daily reports, so it can't be deleted. Rename it instead, or delete its reports first.`);
  }
  const crews = (db.prepare('SELECT COUNT(*) c FROM daily_report_crews WHERE projectId = ?').get(crew.projectId) as any).c;
  if (crews <= 1) throw new CrewConflictError('last_crew', 'A project keeps at least one crew. Rename this one instead.');
  db.prepare('DELETE FROM daily_report_crews WHERE id = ?').run(id);
}

// startTime is 'HH:MM' (24-hour) or null — null on reports made before
// migration 44, and when someone clears it.
function checkStartTime(v: unknown): string | null {
  if (v === null) return null;
  if (!isStartTime(v)) throw new ValidationError('startTime is malformed (HH:MM)');
  return v;
}

// A new report's start time when none is given: the crew's previous report's
// — the latest of that crew's reports dated before it that has a start time;
// failing that (a day filled in before the crew's first report), the crew's
// latest-dated one that has one; else 6 AM, which is the original fixed
// weather window. Other crews' reports never count: a sub's crew can start at
// another hour.
export function previousStartTime(db: Database.Database, projectId: string, crewId: string, reportDate: string): string {
  const row = db.prepare(`SELECT startTime FROM daily_reports
      WHERE projectId = ? AND crewId = ? AND startTime IS NOT NULL
      ORDER BY reportDate < ? DESC, reportDate DESC LIMIT 1`).get(projectId, crewId, reportDate) as any;
  return row?.startTime ?? DEFAULT_START_TIME;
}

function photoCount(db: Database.Database, dailyReportId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM daily_report_photos WHERE dailyReportId = ?').get(dailyReportId) as any).c;
}

// Every read carries the crew's name next to its id: a date alone no longer
// names a report. NULL only for a report whose crew is gone — a deleted
// project's (project delete removes its crews but never removed its reports).
const REPORT_SELECT = `SELECT r.*, c.name AS crewName FROM daily_reports r
  LEFT JOIN daily_report_crews c ON c.id = r.crewId`;

// How the activity feed names a report: its date and, since one date can
// hold a report per crew, its crew — "2026-08-26 (Crew 1)".
export function dailyReportActivityName(r: { reportDate?: string | null; crewName?: string | null } | null | undefined): string {
  const date = r?.reportDate ?? '';
  return r?.crewName ? `${date} (${r.crewName})` : date;
}

export function getDailyReport(db: Database.Database, id: string): any | null {
  const row = db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM daily_report_photos WHERE dailyReportId = ? ORDER BY sortOrder')
    .all(id) as any[];
  const attachments = listPdfAttachments(db, DAILY_REPORT_ATTACHMENTS, id);
  return { ...row, weatherHourly: parseArr(row.weatherHourly), manCounts: parseArr(row.manCounts), photos, attachments };
}

// Newest date first; one date's reports (one per crew) in tab order. crewId
// narrows the list to that crew's own reports.
export function listDailyReports(db: Database.Database, projectId: string, crewId?: string): any[] {
  const rows = db.prepare(`${REPORT_SELECT}
      WHERE r.projectId = ?${crewId !== undefined ? ' AND r.crewId = ?' : ''}
      ORDER BY r.reportDate DESC, c.sortOrder, c.createdAt, r.id`)
    .all(...(crewId !== undefined ? [projectId, crewId] : [projectId])) as any[];
  return rows.map(r => {
    const { weatherHourly, fieldNotes, issues, ...summary } = r;
    return { ...summary, manCounts: parseArr(r.manCounts), photoCount: photoCount(db, r.id) };
  });
}

// A report always belongs to one of its project's crews: crewId is required
// (listing the crews is what makes a project's first one, see listCrews).
export function createDailyReport(db: Database.Database, projectId: string, input: DailyReportInput, createdBy?: string): { id: string } {
  requireProject(db, projectId);
  if (typeof input.crewId !== 'string' || !input.crewId) throw new ValidationError('crewId is required');
  const crew = db.prepare('SELECT projectId FROM daily_report_crews WHERE id = ?').get(input.crewId) as any;
  if (!crew || crew.projectId !== projectId) throw new NotFoundError('Crew not found');
  if (!input.reportDate || !DATE_RE.test(input.reportDate)) throw new ValidationError('reportDate is required (YYYY-MM-DD)');
  const startTime = input.startTime == null
    ? previousStartTime(db, projectId, input.crewId, input.reportDate)
    : checkStartTime(input.startTime);
  const existing = takenBy(db, projectId, input.crewId, input.reportDate);
  if (existing) throw new DateTakenError(existing);
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`INSERT INTO daily_reports
      (id, projectId, crewId, reportDate, startTime, jobName, contractorName, weatherSummary, temperature,
       weatherHourly, manCounts, fieldNotes, issues, createdBy, createdAt, updatedAt, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, projectId, input.crewId, input.reportDate, startTime, input.jobName ?? '', input.contractorName ?? '',
         input.weatherSummary ?? '', input.temperature ?? '',
         JSON.stringify(input.weatherHourly ?? []), JSON.stringify(input.manCounts ?? []),
         input.fieldNotes ?? '', input.issues ?? '', createdBy ?? null, now, now);
  return { id };
}

export function saveDailyReport(db: Database.Database, id: string, input: DailyReportInput & { version?: number }): { version: number } {
  const row = db.prepare('SELECT * FROM daily_reports WHERE id = ?').get(id) as any;
  if (!row) throw new NotFoundError('Daily report not found');
  if (!Number.isInteger(input.version)) throw new ValidationError('version required');
  if (row.version !== input.version) throw new ConflictError('daily report was modified');
  if (input.reportDate !== undefined) {
    if (!DATE_RE.test(input.reportDate)) throw new ValidationError('reportDate is malformed (YYYY-MM-DD)');
    const existing = takenBy(db, row.projectId, row.crewId, input.reportDate, id);
    if (existing) throw new DateTakenError(existing);
  }
  // undefined keeps the stored start time; null clears it.
  const startTime = input.startTime === undefined ? row.startTime : checkStartTime(input.startTime);
  const newVersion = row.version + 1;
  db.prepare(`UPDATE daily_reports SET
      reportDate = ?, startTime = ?, jobName = ?, contractorName = ?, weatherSummary = ?, temperature = ?,
      weatherHourly = ?, manCounts = ?, fieldNotes = ?, issues = ?, version = ?, updatedAt = ?
      WHERE id = ?`)
    .run(
      input.reportDate ?? row.reportDate,
      startTime,
      input.jobName ?? row.jobName,
      input.contractorName ?? row.contractorName,
      input.weatherSummary ?? row.weatherSummary,
      input.temperature ?? row.temperature,
      JSON.stringify(input.weatherHourly ?? parseArr(row.weatherHourly)),
      JSON.stringify(input.manCounts ?? parseArr(row.manCounts)),
      input.fieldNotes ?? row.fieldNotes,
      input.issues ?? row.issues,
      newVersion,
      Date.now(),
      id,
    );
  return { version: newVersion };
}

export function deleteDailyReport(db: Database.Database, id: string): void {
  const row = db.prepare('SELECT id FROM daily_reports WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Daily report not found');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM daily_report_photos WHERE dailyReportId = ?').run(id);
    db.prepare('DELETE FROM daily_report_attachments WHERE dailyReportId = ?').run(id);
    db.prepare('DELETE FROM daily_reports WHERE id = ?').run(id);
  });
  tx();
}

// addPhoto/removePhoto deliberately leave `version` alone (see routes.ts —
// bumping it would poison the client's version-dedupe), but they DO stamp
// `updatedAt` so a photo change still counts as "the record moved on" for
// anything comparing against it (the document-actions freshness chip / the
// send-reuses-current-file check).
export function addPhoto(db: Database.Database, dailyReportId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM daily_reports WHERE id = ?').get(dailyReportId)) throw new NotFoundError('Daily report not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM daily_report_photos WHERE dailyReportId = ? AND fileId = ?').get(dailyReportId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM daily_report_photos WHERE dailyReportId = ?').get(dailyReportId) as any).m;
  db.prepare('INSERT INTO daily_report_photos (id, dailyReportId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), dailyReportId, fileId, max + 1, Date.now());
  db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(Date.now(), dailyReportId);
}

export function removePhoto(db: Database.Database, dailyReportId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM daily_reports WHERE id = ?').get(dailyReportId)) throw new NotFoundError('Daily report not found');
  db.prepare('DELETE FROM daily_report_photos WHERE dailyReportId = ? AND fileId = ?').run(dailyReportId, fileId);
  db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(Date.now(), dailyReportId);
}

// PDF attachments, appended to the generated daily report after its photos.
// Same freshness rule as the photos above: updatedAt moves — the clock the
// document-actions chip and Send's reuse check compare the stored PDF against
// — and version is left alone.
const DAILY_REPORT_ATTACHMENTS: PdfAttachmentTable = {
  table: 'daily_report_attachments', ownerColumn: 'dailyReportId', ownerTable: 'daily_reports',
  notFoundMessage: 'Daily report not found', noun: 'daily report',
  NotFoundError, ValidationError,
  touch: (db, dailyReportId) => { db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(Date.now(), dailyReportId); },
};

export function addAttachment(db: Database.Database, dailyReportId: string, fileId: string): void {
  addPdfAttachment(db, DAILY_REPORT_ATTACHMENTS, dailyReportId, fileId);
}

export function updateAttachment(db: Database.Database, dailyReportId: string, fileId: string, patch: { sortOrder: number }): void {
  updatePdfAttachment(db, DAILY_REPORT_ATTACHMENTS, dailyReportId, fileId, patch);
}

export function removeAttachment(db: Database.Database, dailyReportId: string, fileId: string): void {
  removePdfAttachment(db, DAILY_REPORT_ATTACHMENTS, dailyReportId, fileId);
}
