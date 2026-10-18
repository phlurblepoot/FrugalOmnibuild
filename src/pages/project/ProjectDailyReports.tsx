// src/pages/project/ProjectDailyReports.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CalendarDays, Eye, Plus, Trash2, ImageIcon, MoreHorizontal, Pencil, Users } from 'lucide-react';
import { DailyReportsCalendar } from './daily/DailyReportsCalendar';
import { CrewNameModal } from './daily/CrewNameModal';
import {
  DailyReport, DailyReportCrew, DailyReportListItem, DateTakenError,
  getDailyReports, getDailyReport, createDailyReport, deleteDailyReport,
  getDailyReportCrews, createDailyReportCrew, renameDailyReportCrew, deleteDailyReportCrew,
  getProject, getSettings,
} from '../../utils/store';
import { useProjectOutlet } from './ProjectLayout';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import {
  Button, Card, CardBody, EmptyState, Field, Input, Skeleton, Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { EditingChip } from '../../components/EditingChip';
import { DailyReportEditor } from './daily/DailyReportEditor';
import { useGeneratedDocuments } from '../../hooks/useGeneratedDocument';
import { useReplyFlags } from '../../hooks/useReplyFlags';
import { DocumentStatusChip } from '../../components/documents/DocumentStatusChip';
import { ReplyFlagChip } from '../../components/documents/ReplyFlagChip';
import { useDocumentViewer } from '../../components/documents/useDocumentViewer';
// Owned by dailyReportForm.ts (a leaf module) so DailyReportEditor/dailyReportPdf
// can import them without a cycle back through this file. Re-exported here for
// existing callers of this module (including this file's own test).
import { manCountTotal, formatReportDate, formatStartTime } from './daily/dailyReportForm';
export { manCountTotal, formatReportDate };

// The ?crew= value of the read-only tab that shows every crew's reports.
export const ALL_CREWS = 'all';

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-soft transition-colors ' +
  'hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

// Each crew — the company's own or a sub's — is its own set of daily reports
// with its own calendar, one report per date; a tab per crew, in tab order,
// then "All crews", every crew's reports on one read-only calendar (spec
// docs/superpowers/specs/2026-10-06-daily-report-crews-design.md). The tab is
// in the URL (?crew=<id> | ?crew=all); none, or a crew that is gone, means the
// first crew.
export const ProjectDailyReports: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { summary } = useProjectOutlet();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Listing makes the project's first crew when it has none, so a loaded list
  // always has a tab to file under (empty only if the request failed).
  const [crews, setCrews] = useState<DailyReportCrew[] | null>(null);
  // Every crew's reports; each crew's tab shows its own share.
  const [reports, setReports] = useState<DailyReportListItem[] | null>(null);
  const [editing, setEditing] = useState<DailyReport | null>(null);
  // Bumped only when an outside change actually moved the record on, re-keying
  // the modal so it reloads (the collab "review merge" path). A refresh the
  // editor asked to survive — or one that changed nothing — leaves the user's
  // typed draft alone.
  const [editorSeq, setEditorSeq] = useState(0);
  const [reportDate, setReportDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'calendar' | 'list'>(
    () => localStorage.getItem('dailyReports:view') === 'list' ? 'list' : 'calendar'
  );
  const setViewPersist = (v: 'calendar' | 'list') => {
    setView(v);
    localStorage.setItem('dailyReports:view', v);
  };

  const [crewModal, setCrewModal] = useState<{ mode: 'add' } | { mode: 'rename'; crew: DailyReportCrew } | null>(null);
  const [crewMenuOpen, setCrewMenuOpen] = useState(false);

  const load = () => {
    if (!projectId) return;
    getDailyReportCrews(projectId).then(setCrews).catch(() => setCrews(cur => cur ?? []));
    getDailyReports(projectId).then(setReports).catch(() => setReports([]));
  };
  // A crew added, renamed or deleted elsewhere refreshes the tabs here.
  useLiveQuery(load, { types: ['dailyReport', 'dailyReportCrew'], projectId });

  const [searchParams, setSearchParams] = useSearchParams();
  const crewParam = searchParams.get('crew');
  const showAll = crewParam === ALL_CREWS;
  const crew: DailyReportCrew | null = showAll || !crews
    ? null
    : crews.find(c => c.id === crewParam) ?? crews[0] ?? null;
  const selectTab = (id: string) => {
    setCrewMenuOpen(false);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('crew', id); return p; }, { replace: true });
  };
  // How many reports a crew has, from the loaded list (so it agrees with what
  // the calendar shows); the crews list's own count until that has loaded.
  const reportCount = (c: DailyReportCrew) => reports ? reports.filter(r => r.crewId === c.id).length : c.reportCount;

  // The tab's reports: the crew's own, or on All crews everyone's.
  const visible = reports === null || (!showAll && crews === null)
    ? null
    : showAll ? reports : reports.filter(r => r.crewId === crew?.id);

  // One batched by-source lookup for the whole list: each row shows whether its
  // daily report exists and is still current.
  const rows = visible ?? [];
  const docs = useGeneratedDocuments({
    sourceType: 'dailyReport',
    kind: 'daily-report',
    sourceIds: rows.map(r => r.id),
    updatedAtById: Object.fromEntries(rows.map(r => [r.id, r.updatedAt])),
  });
  const replyFlags = useReplyFlags('dailyReport', rows.map(r => r.id));
  const viewer = useDocumentViewer();

  // Focus the create-form input when arriving via the command palette's "New
  // daily report" action — once the crews are in, since the form belongs to a
  // crew's tab.
  const crewsLoaded = crews !== null;
  useEffect(() => {
    if (crewsLoaded && searchParams.get('new') === '1') {
      const el = document.getElementById('new-daily-report-date') as HTMLInputElement | null;
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('new'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, crewsLoaded]);

  const openReport = async (id: string) => {
    try { setEditing(await getDailyReport(id)); } catch { toast('Failed to open report', { type: 'error' }); }
  };

  // Prefill source for a new report's contractor name: the project summary
  // first, else the full project record, else the company name from
  // settings — settings is only fetched if the earlier sources come up empty.
  const resolveContractorName = async (): Promise<string> => {
    if (summary?.contractor) return summary.contractor;
    if (projectId) {
      try {
        const project = await getProject(projectId);
        if (project?.contractor) return project.contractor;
      } catch { /* fall through to settings */ }
    }
    try {
      const settings = await getSettings();
      return settings.companyName ?? '';
    } catch { return ''; }
  };

  // Files under the open crew's tab; its date already taken opens that report.
  const addReportFor = async (dateStr: string) => {
    if (!projectId || !crew) return;
    if (!dateStr) { toast('Pick a date', { type: 'warning' }); return; }
    setCreating(true);
    try {
      const contractorName = await resolveContractorName();
      const r = await createDailyReport(projectId, { crewId: crew.id, reportDate: dateStr, jobName: summary?.name ?? '', contractorName });
      setEditing(await getDailyReport(r.id));
      load();
    } catch (e) {
      if (e instanceof DateTakenError) {
        await openReport(e.existingId);
      } else {
        toast('Failed to create report', { type: 'error' });
      }
    } finally {
      setCreating(false);
    }
  };

  const removeReport = async (id: string) => {
    if (!(await confirm({ title: 'Delete daily report?', message: 'This permanently removes the report.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteDailyReport(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  // The name prompt's submit: a refusal (a name already taken) throws, and the
  // prompt shows the server's reason under the field.
  const saveCrewName = async (name: string) => {
    if (!projectId || !crewModal) return;
    if (crewModal.mode === 'add') {
      const created = await createDailyReportCrew(projectId, name);
      setCrewModal(null);
      selectTab(created.id);
      toast(`Added ${created.name}`, { type: 'success' });
    } else {
      await renameDailyReportCrew(crewModal.crew.id, name);
      setCrewModal(null);
    }
    load();
  };

  // Only an empty crew can go (the menu says why otherwise), and never the
  // last one.
  const removeCrew = async (c: DailyReportCrew) => {
    setCrewMenuOpen(false);
    if (!(await confirm({ title: 'Delete crew?', message: `Delete the crew "${c.name}"? It has no daily reports.`, tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await deleteDailyReportCrew(c.id);
      if (crewParam === c.id) setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('crew'); return p; }, { replace: true });
      load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not delete the crew', { type: 'error' });
      load();
    }
  };
  const deleteBlockedReason = (c: DailyReportCrew): string | null =>
    reportCount(c) > 0 ? 'Only a crew with no reports can be deleted.'
    : (crews?.length ?? 0) <= 1 ? 'A project keeps at least one crew.'
    : null;

  // Closes the crew menu on Escape.
  useEffect(() => {
    if (!crewMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCrewMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [crewMenuOpen]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-ink">Daily Reports</h1>
        <div role="tablist" aria-label="View" data-testid="daily-view-toggle" className="flex rounded-lg border border-edge p-0.5">
          {(['calendar', 'list'] as const).map(v => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setViewPersist(v)}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                view === v ? 'bg-raised text-ink shadow-sm' : 'text-ink-faint hover:text-ink'
              }`}
            >
              {v === 'calendar' ? 'Calendar' : 'List'}
            </button>
          ))}
        </div>
      </div>

      {/* Crew tabs scroll sideways on a phone; the crew menu and Add crew sit
          outside the scroller so the menu isn't clipped by it. */}
      <div className="mb-4 flex items-center gap-2">
        <div role="tablist" aria-label="Crews" data-testid="daily-crew-tabs" className="-ml-1 flex min-w-0 flex-1 gap-1 overflow-x-auto no-scrollbar pl-1">
          {crews === null ? (
            <Skeleton className="h-8 w-40" />
          ) : (
            <>
              {crews.map(c => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={crew?.id === c.id}
                  data-testid={`daily-crew-tab-${c.id}`}
                  onClick={() => selectTab(c.id)}
                  title={c.name}
                  className={`max-w-[14rem] shrink-0 truncate rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                    crew?.id === c.id ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
                  }`}
                >
                  {c.name}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={showAll}
                data-testid="daily-crew-tab-all"
                onClick={() => selectTab(ALL_CREWS)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  showAll ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
                }`}
              >
                <Users size={14} className="shrink-0" />All crews
              </button>
            </>
          )}
        </div>
        <div className="relative flex shrink-0 items-center gap-1">
          {crew && (
            <button
              type="button"
              aria-label={`${crew.name} options`}
              aria-haspopup="menu"
              aria-expanded={crewMenuOpen}
              title="Rename or delete this crew"
              data-testid="daily-crew-menu-button"
              onClick={() => setCrewMenuOpen(o => !o)}
              className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <MoreHorizontal size={16} />
            </button>
          )}
          <Button variant="secondary" size="sm" onClick={() => { setCrewMenuOpen(false); setCrewModal({ mode: 'add' }); }}
            disabled={crews === null} aria-label="Add crew" title="Add crew">
            <Plus size={14} /><span className="hidden sm:inline">Add crew</span>
          </Button>
          {crewMenuOpen && crew && (
            <>
              <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setCrewMenuOpen(false)} />
              <div role="menu" data-testid="daily-crew-menu" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-xl border border-edge bg-raised p-1 shadow-lg">
                <button type="button" role="menuitem" className={MENU_ITEM}
                  onClick={() => { setCrewMenuOpen(false); setCrewModal({ mode: 'rename', crew }); }}>
                  <Pencil size={15} /> Rename crew…
                </button>
                <button type="button" role="menuitem" className={`${MENU_ITEM} hover:text-red-600`}
                  disabled={deleteBlockedReason(crew) !== null} onClick={() => { void removeCrew(crew); }}>
                  <Trash2 size={15} /> Delete crew
                </button>
                {deleteBlockedReason(crew) && (
                  <p className="px-3 pb-2 pt-0.5 text-xs text-ink-faint">{deleteBlockedReason(crew)}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {showAll ? (
        <p className="mb-4 text-sm text-ink-faint">Every crew's reports, for viewing. To add a report, open that crew's tab.</p>
      ) : (
        <Card className="mb-5">
          <CardBody>
            <div className="flex flex-wrap items-end gap-2">
              <Field label={crew ? `New report — ${crew.name}` : 'New report'} htmlFor="new-daily-report-date">
                <Input id="new-daily-report-date" type="date" value={reportDate} onChange={e => setReportDate(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addReportFor(reportDate); }}
                  className="w-full sm:w-auto" />
              </Field>
              <Button onClick={() => addReportFor(reportDate)} disabled={creating || !crew}><Plus size={15} />New report</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {visible === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : view === 'calendar' ? (
        <div key={view} className="anim-tab-in">
          {/* All crews is for viewing: no onCreate, so empty days start nothing. */}
          <DailyReportsCalendar reports={visible} onOpen={openReport} onCreate={showAll ? undefined : addReportFor} />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState icon={<CalendarDays size={22} />} title={showAll || !crew ? 'No daily reports yet' : `No daily reports for ${crew.name} yet`}
          description="Log crew counts, weather, and field notes for each day on site — attach photos and send a branded PDF." />
      ) : (
        <div key={view} className="anim-tab-in">
        <Table>
          <THead><TR><TH>Date</TH>{showAll && <TH>Crew</TH>}<TH>Start</TH><TH>Men</TH><TH>Weather</TH><TH>Photos</TH><TH></TH></TR></THead>
          <TBody>
            {visible.map(r => (
              <TR key={r.id} interactive onClick={() => openReport(r.id)}>
                <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">{formatReportDate(r.reportDate)}<EditingChip type="dailyReport" id={r.id} />{replyFlags.has(r.id) && <ReplyFlagChip data-testid={`daily-report-reply-flag-${r.id}`} />}</span></TD>
                {showAll && <TD className="max-w-[12rem] truncate text-ink-soft">{r.crewName || '—'}</TD>}
                <TD className="whitespace-nowrap text-ink-soft">{formatStartTime(r.startTime) || '—'}</TD>
                <TD className="text-ink-soft">{manCountTotal(r.manCounts) > 0 ? `${manCountTotal(r.manCounts)} men` : '—'}</TD>
                <TD className="max-w-[16rem] truncate text-ink-soft">{[r.weatherSummary, r.temperature].filter(Boolean).join(' ') || '—'}</TD>
                <TD className="text-ink-soft">{r.photoCount > 0 ? <span className="inline-flex items-center gap-1"><ImageIcon size={13} />{r.photoCount}</span> : '—'}</TD>
                <TD onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {docs.byId[r.id]?.file && (
                      <>
                        <DocumentStatusChip file={docs.byId[r.id].file} upToDate={docs.byId[r.id].upToDate} size="sm" />
                        <button
                          onClick={() => viewer.open(docs.byId[r.id].file!, 'daily-report', projectId ?? null)}
                          title="Open PDF" aria-label="Open PDF"
                          className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink"
                        >
                          <Eye size={14} />
                        </button>
                      </>
                    )}
                    {/* All crews is for viewing; reports are deleted from their crew's tab. */}
                    {!showAll && <button onClick={() => removeReport(r.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        </div>
      )}

      {editing && (
        <DailyReportEditor
          key={`${editing.id}:${editorSeq}`}
          report={editing}
          projectId={projectId ?? ''}
          projectName={summary?.name ?? ''}
          contractor={summary?.contractor}
          onClose={() => setEditing(null)}
          onSaved={async (opts) => {
            let fresh: DailyReport | null = null;
            try { fresh = await getDailyReport(editing.id); setEditing(fresh); } catch { setEditing(null); }
            // Remounting mid-flow would tear down the editor's document bar
            // (and its version dialog), so its own saves ask to stay mounted —
            // their local state already matches what came back. A refresh that
            // found nothing new (a failed photo upload, say) must not discard
            // what the user has typed either.
            if (!opts?.keepMounted && fresh && fresh.version !== editing.version) {
              setEditorSeq(n => n + 1);
            }
            load();
          }}
        />
      )}

      {crewModal && (
        <CrewNameModal
          title={crewModal.mode === 'add' ? 'Add crew' : `Rename ${crewModal.crew.name}`}
          confirmLabel={crewModal.mode === 'add' ? 'Add crew' : 'Rename'}
          initialName={crewModal.mode === 'rename' ? crewModal.crew.name : ''}
          onClose={() => setCrewModal(null)}
          onSubmit={saveCrewName}
        />
      )}

      {viewer.modal}
    </div>
  );
};
