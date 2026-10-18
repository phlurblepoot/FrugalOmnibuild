// src/pages/project/daily/DailyReportEditor.tsx
import React, { useEffect, useRef, useState } from 'react';
import { CloudSun, Plus, Trash2 } from 'lucide-react';
import {
  DailyReport, ManCountLine, DateTakenError,
  saveDailyReport, getDailyReport, addDailyReportPhoto, removeDailyReportPhoto, getDailyWeather,
  getSettings, fetchFileBlob, sendDailyReport,
  addDailyReportAttachment, updateDailyReportAttachment, removeDailyReportAttachment,
} from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Button, Field, Input, Modal, Textarea, NumberInput } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { PhotoDropCard } from '../../../components/documents/PhotoDropCard';
import { PdfAttachmentsCard } from '../../../components/documents/PdfAttachmentsCard';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { useItemEmailDefaults } from '../../../hooks/useItemEmailDefaults';
import { itemSendPayload } from '../../../utils/itemSend';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { dailyReportTitle, formatReportDate, formatStartTime, manCountTotal, normalizeManCounts, weatherStartHour } from './dailyReportForm';
import { buildDailyReportPdf, dailyReportFileName } from './dailyReportPdf';
import { appendAttachedPdfs } from '../../../utils/pdfAttachments';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';
import { useDiscardGuard } from '../../../components/ui/useDiscardGuard';

export const DailyReportEditor: React.FC<{
  report: DailyReport;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
}> = ({ report, projectId, projectName, onClose, onSaved }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [reportDate, setReportDate] = useState(report.reportDate);
  // '' = no start time (a report made before they existed): weather 6 AM–6 PM.
  const [startTime, setStartTime] = useState(report.startTime ?? '');
  const [jobName, setJobName] = useState(report.jobName ?? '');
  const [contractorName, setContractorName] = useState(report.contractorName ?? '');
  const [weatherSummary, setWeatherSummary] = useState(report.weatherSummary ?? '');
  const [temperature, setTemperature] = useState(report.temperature ?? '');
  const [weatherHourly, setWeatherHourly] = useState(report.weatherHourly ?? []);
  const [manCounts, setManCounts] = useState<ManCountLine[]>(report.manCounts ?? []);
  const [fieldNotes, setFieldNotes] = useState(report.fieldNotes ?? '');
  const [issues, setIssues] = useState(report.issues ?? '');
  const [saving, setSaving] = useState(false);
  const [fetchingWeather, setFetchingWeather] = useState(false);
  const [weatherNote, setWeatherNote] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);

  const isDirty = () =>
    reportDate !== report.reportDate ||
    (startTime || null) !== (report.startTime ?? null) ||
    jobName.trim() !== (report.jobName ?? '') ||
    contractorName.trim() !== (report.contractorName ?? '') ||
    weatherSummary !== (report.weatherSummary ?? '') ||
    temperature !== (report.temperature ?? '') ||
    JSON.stringify(weatherHourly) !== JSON.stringify(report.weatherHourly ?? []) ||
    // Compared post-normalize on both sides: handleSave persists
    // normalizeManCounts(manCounts) (trims each type, drops blank rows), so
    // comparing the raw typed state against the raw saved record left a
    // trailing-space/blank-row edit permanently "dirty" even right after a
    // save round-tripped it — Send stayed stuck on "Save first" forever.
    JSON.stringify(normalizeManCounts(manCounts)) !== JSON.stringify(normalizeManCounts(report.manCounts ?? [])) ||
    fieldNotes !== (report.fieldNotes ?? '') ||
    issues !== (report.issues ?? '');

  const dirty = isDirty();
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({ type: 'dailyReport', id: report.id, isDirty, onFresh: onSaved });

  // Email defaults: resolved recipient, always-CC, header-email options.
  // recipients.ts has no 'dailyReport' template role — its TemplateType is a
  // fixed union, so we use the closest general fallback ('rfi', which maps to
  // the 'pm' role) rather than widen the union for one caller.
  const emailDefaults = useItemEmailDefaults('rfi', projectId);

  // The start time the weather on screen was fetched for (assumed to be the
  // saved one on open) — or, while a fetch is in flight, the one it is
  // fetching for — and the start time last committed in the field: a change
  // asks about the weather once, and only when its window moves.
  const weatherStartRef = useRef(report.startTime ?? '');
  const fetchingStartRef = useRef('');
  const committedStartRef = useRef(report.startTime ?? '');
  // Only the latest fetch lands: a start-time change can supersede one still
  // in flight (the new-report auto-fetch).
  const weatherReqRef = useRef(0);

  const fetchWeather = async (opts?: { silent?: boolean; start?: string }) => {
    const start = opts?.start ?? startTime;
    const req = ++weatherReqRef.current;
    fetchingStartRef.current = start;
    setFetchingWeather(true);
    setWeatherNote(null);
    try {
      const w = await getDailyWeather(projectId, reportDate, start || null);
      if (req !== weatherReqRef.current) return;
      setWeatherHourly(w.hourly);
      setWeatherSummary(w.summary);
      setTemperature(w.temperature);
      weatherStartRef.current = start;
    } catch (e) {
      if (req !== weatherReqRef.current) return;
      if (e instanceof Error && e.message === 'no_address') {
        setWeatherNote('Add a project address to auto-fill weather.');
      } else if (!opts?.silent) {
        toast('Weather unavailable — enter it manually', { type: 'warning' });
      }
    } finally {
      if (req === weatherReqRef.current) setFetchingWeather(false);
    }
  };

  // Runs when the start time field is left (a time input fires change on
  // every keystroke, so asking on change would interrupt the typing). Weather
  // already on the report is only replaced if the user says so; with none yet
  // there is nothing to ask about, except a fetch still in flight, which is
  // simply redone for the new start.
  const commitStartTime = async () => {
    const next = startTime;
    if (next === committedStartRef.current) return;
    committedStartRef.current = next;
    const current = fetchingWeather ? fetchingStartRef.current : weatherStartRef.current;
    if (weatherStartHour(next) === weatherStartHour(current)) return;
    if (fetchingWeather) { void fetchWeather({ silent: true, start: next }); return; }
    if (weatherHourly.length === 0) return;
    const yes = await confirm({
      title: 'Update the weather?',
      message: `Update the weather to match the new start time${next ? ` (${formatStartTime(next)})` : ''}? Keep current leaves the weather on this report as it is.`,
      confirmLabel: 'Update weather',
      cancelLabel: 'Keep current',
    });
    if (yes) await fetchWeather({ start: next });
  };

  // Auto-fetch once for a brand-new report only — never clobber saved data
  // on reopen of an existing one.
  useEffect(() => {
    if (report.weatherHourly.length === 0 && report.version === 1) {
      fetchWeather({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateManCount = (i: number, patch: Partial<ManCountLine>) => {
    setManCounts(cur => cur.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  };
  const addManCountLine = () => setManCounts(cur => [...cur, { type: '', count: 1 }]);
  const removeManCountLine = (i: number) => setManCounts(cur => cur.filter((_, idx) => idx !== i));

  const dropPhoto = async (fileId: string) => {
    try { await removeDailyReportPhoto(report.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // Built from the SAVED report, never the typed-in draft: the bar commits
  // first, so re-reading the record here is what keeps a generated report and
  // the report it claims to represent from drifting apart (photos included —
  // an upload that landed after this editor mounted is on the saved record,
  // not on the prop). A failed re-read throws on purpose — the bar then
  // reports the failure and keeps the existing document, rather than quietly
  // storing pre-save bytes and marking them current.
  const buildDailyReportBytes = async (headerEmail?: string): Promise<Uint8Array | ArrayBuffer> => {
    const saved = await getDailyReport(report.id);
    if (!saved) throw new Error('Daily report not found');
    const settings = await getSettings();
    let logoDataUrl: string | undefined = settings.logoUrl || undefined;
    if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    }
    if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
      logoDataUrl = await invertImageDataUrl(logoDataUrl);
    }
    // fetch each photo as a dataURL (authenticated content endpoint)
    const photoDataUrls: string[] = [];
    for (const p of saved.photos) {
      try {
        const blob = await fetchFileBlob(p.fileId);
        photoDataUrls.push(await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); }));
      } catch { /* skip */ }
    }
    const bytes = buildDailyReportPdf({
      report: saved,
      photoDataUrls,
      letterhead: {
        brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
        company: {
          name: settings.companyName || settings.appName,
          phone: settings.companyPhone,
          email: headerEmail ?? settings.companyEmail,
          address: settings.companyAddress,
        },
        logoDataUrl,
      },
      headerEmail: headerEmail || undefined,
    });
    // Attached PDFs go last, after the photo pages, in attachment order.
    return appendAttachedPdfs(bytes, saved.attachments);
  };

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    // Thrown rather than returned so the document bar's save-first step can
    // tell a refused save from a successful one.
    setDateError(null);
    if (!reportDate) {
      setDateError('Enter a date for this report.');
      throw new Error('Enter a date for this report.');
    }
    setSaving(true);
    try {
      await saveDailyReport(report.id, {
        version: collab.keepMineVersion ?? report.version,
        reportDate,
        startTime: startTime || null,
        jobName: jobName.trim(),
        contractorName: contractorName.trim(),
        weatherSummary,
        temperature,
        weatherHourly,
        manCounts: normalizeManCounts(manCounts),
        fieldNotes,
        issues,
      });
      toast('Saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      if (e instanceof DateTakenError) {
        setDateError(report.crewName ? `${report.crewName} already has a report for this date.` : 'A report for this date already exists.');
      } else if (e instanceof Error && e.name === 'ConflictError') {
        toast('Report changed elsewhere — reopen it', { type: 'error' });
      } else {
        toast('Save failed', { type: 'error' });
      }
      throw e;
    } finally {
      setSaving(false);
    }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  return (
    // The title names the crew: each crew is its own set of reports.
    <Modal open onClose={onClose} dirty={dirty} title={dailyReportTitle(report)} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'dailyReport', sourceId: report.id }}
            kind="daily-report"
            format="pdf"
            projectId={projectId}
            fileName={dailyReportFileName(report, projectName)}
            build={async ({ headerEmail }) => new Blob([await buildDailyReportBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={report.updatedAt}
            size="sm"
            send={{
              blockedReason: emailDefaults.sendBlockedReason,
              composer: {
                title: 'Send daily report',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `${dailyReportTitle(report)} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached the daily report for ${formatReportDate(report.reportDate)}${report.crewName ? ` (${report.crewName})` : ''} on ${projectName}.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, req) => {
                const result = await sendDailyReport(report.id, { ...itemSendPayload(req), fileId });
                onSaved({ keepMounted: true });
                return result;
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <Field label="Job name" htmlFor="dr-job"><Input id="dr-job" value={jobName} onChange={e => setJobName(e.target.value)} /></Field>
        <Field label="Contractor" htmlFor="dr-contractor"><Input id="dr-contractor" value={contractorName} onChange={e => setContractorName(e.target.value)} /></Field>
        <Field label="Date" htmlFor="dr-date" error={dateError ?? undefined}>
          <Input id="dr-date" type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} />
        </Field>
        <Field label="Start time" htmlFor="dr-start">
          <Input id="dr-start" type="time" value={startTime} onChange={e => setStartTime(e.target.value)} onBlur={() => { void commitStartTime(); }} />
        </Field>
      </div>

      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Weather</h4>
          <Button variant="secondary" size="sm" onClick={() => fetchWeather()} disabled={fetchingWeather}>
            <CloudSun size={14} />{fetchingWeather ? 'Fetching…' : weatherHourly.length > 0 ? 'Refresh weather' : 'Fetch weather'}
          </Button>
        </div>
        {weatherNote && <p className="mb-2 text-xs text-ink-faint">{weatherNote}</p>}
        {weatherHourly.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
            {weatherHourly.map((h, i) => (
              <div key={i} className="flex shrink-0 flex-col items-center rounded-md border border-edge px-2 py-1 text-xs">
                <span className="text-ink-faint">{h.hour}</span>
                <span className="font-medium text-ink">{h.tempF != null ? `${h.tempF}°` : '—'}</span>
                <span className="text-ink-faint">{h.condition}</span>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Weather" htmlFor="dr-weather-summary"><Input id="dr-weather-summary" value={weatherSummary} onChange={e => setWeatherSummary(e.target.value)} /></Field>
          <Field label="Temperature" htmlFor="dr-temp"><Input id="dr-temp" value={temperature} onChange={e => setTemperature(e.target.value)} /></Field>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-edge pt-3 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-semibold text-ink">Man count</h4>
          <div className="space-y-2">
            {manCounts.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Input value={l.type} onChange={e => updateManCount(i, { type: e.target.value })} placeholder="Trade / role" />
                </div>
                {/* Wrapper (not className) constrains the width: the Input base
                    classes start with w-full, which in this flex row out-muscled
                    a passed w-20 and made the count box the WIDE one. */}
                <div className="w-20 flex-none">
                  <NumberInput min={0} value={l.count} onChange={e => updateManCount(i, { count: Number(e.target.value) })} />
                </div>
                <button onClick={() => removeManCountLine(i)} title="Remove" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-2" onClick={addManCountLine}><Plus size={14} />Add line</Button>
          <p className="mt-2 text-xs text-ink-faint">Total: {manCountTotal(normalizeManCounts(manCounts))} men</p>
        </div>
        <Field label="Field notes" htmlFor="dr-notes">
          <Textarea id="dr-notes" value={fieldNotes} onChange={e => setFieldNotes(e.target.value)} rows={10} />
        </Field>
      </div>

      <div className="mt-4 border-t border-edge pt-3">
        <Field label="Issues" htmlFor="dr-issues">
          <Textarea id="dr-issues" value={issues} onChange={e => setIssues(e.target.value)} rows={3} />
        </Field>
      </div>

      {/* Adding a photo stamps the report server-side, which re-keys this
          editor — hence the same save-first gate the status actions use. */}
      <PhotoDropCard
        title="Photos"
        emptyText="No photos. Add before/during/after shots from the field."
        testId="daily"
        photos={report.photos}
        upload={{ kind: 'daily-report-photo', projectId, sourceType: 'dailyReport', sourceId: report.id }}
        initialProjectIds={[projectId]}
        link={fileId => addDailyReportPhoto(report.id, fileId)}
        onRemove={dropPhoto}
        onDone={onSaved}
        disabled={dirty}
        disabledMessage="Save your changes first"
      />
      <PdfAttachmentsCard
        attachments={report.attachments}
        projectId={projectId}
        documentName="daily report"
        testId="daily"
        link={fileId => addDailyReportAttachment(report.id, fileId)}
        update={(fileId, patch) => updateDailyReportAttachment(report.id, fileId, patch)}
        remove={fileId => removeDailyReportAttachment(report.id, fileId)}
        onChanged={onSaved}
        disabled={dirty}
        disabledMessage="Save your changes first"
      />

    </Modal>
  );
};
