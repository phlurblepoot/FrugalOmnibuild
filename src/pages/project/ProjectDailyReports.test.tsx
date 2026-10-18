import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor as rtlWaitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import React from 'react';

const crewApi = vi.hoisted(() => ({
  getDailyReportCrews: vi.fn(),
  createDailyReportCrew: vi.fn(),
  renameDailyReportCrew: vi.fn(),
  deleteDailyReportCrew: vi.fn(),
  createDailyReport: vi.fn(),
  confirm: vi.fn(),
}));

const { fakeSocket, getDailyReports, getDailyReport, getDocumentsBySource } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket, getDailyReports: vi.fn(), getDailyReport: vi.fn(), getDocumentsBySource: vi.fn() };
});
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
// Not under test here — see ReplyFlagChip/useReplyFlags.test for that; a real
// fetch would otherwise fire (and outlive) this file's tests.
vi.mock('../../hooks/useReplyFlags', () => ({ useReplyFlags: () => new Set<string>() }));
vi.mock('../../components/ConfirmDialog', () => ({ useConfirm: () => crewApi.confirm }));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDailyReports, getDailyReport, getDocumentsBySource,
  getDailyReportCrews: crewApi.getDailyReportCrews,
  createDailyReportCrew: crewApi.createDailyReportCrew,
  renameDailyReportCrew: crewApi.renameDailyReportCrew,
  deleteDailyReportCrew: crewApi.deleteDailyReportCrew,
  createDailyReport: crewApi.createDailyReport,
  getProject: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
}));
vi.mock('../documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row, onClose }: any) => (
    <div data-testid="viewer">
      <span>{row.name}</span>
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));

// A stand-in editor that reports every mount: the list must not re-key it when
// the editor saves itself, or the document bar inside it would be torn down
// mid-flow.
const mounts = { count: 0 };
vi.mock('./daily/DailyReportEditor', () => ({
  DailyReportEditor: ({ onSaved, report }: any) => {
    React.useEffect(() => { mounts.count += 1; }, []);
    return (
      <div data-testid="editor" data-report-id={report?.id}>
        <button data-testid="save-kept" onClick={() => onSaved({ keepMounted: true })}>save kept</button>
        <button data-testid="save-plain" onClick={() => onSaved()}>save plain</button>
      </div>
    );
  },
}));
vi.mock('./ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'P1', contractor: '' } }),
}));

import { ProjectDailyReports, manCountTotal, formatReportDate } from './ProjectDailyReports';

// Shows the URL's query string, where the open crew tab lives.
const Search: React.FC = () => <div data-testid="search">{useLocation().search}</div>;

function mount(path = '/project/p1/daily') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/project/:projectId/daily" element={<><ProjectDailyReports /><Search /></>} /></Routes>
    </MemoryRouter>
  );
}

const crewRow = (over: Record<string, any> = {}) => ({
  id: 'c1', projectId: 'p1', name: 'Crew 1', sortOrder: 0, createdAt: 1, updatedAt: 1, reportCount: 0, ...over,
});

// Every test starts with one crew ("Crew 1", c1) that the default rows below belong to.
beforeEach(() => {
  for (const f of Object.values(crewApi)) f.mockReset();
  crewApi.getDailyReportCrews.mockResolvedValue([crewRow()]);
});

describe('manCountTotal', () => {
  it('sums counts', () => { expect(manCountTotal([{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }])).toBe(5); });
  it('ignores non-finite/negative counts and empty lists', () => {
    expect(manCountTotal([])).toBe(0);
    expect(manCountTotal([{ type: 'x', count: NaN as any }, { type: 'y', count: -2 }, { type: 'z', count: 3 }])).toBe(3);
  });
});
describe('formatReportDate', () => {
  it('renders YYYY-MM-DD as a readable local date without timezone drift', () => {
    expect(formatReportDate('2026-08-26')).toBe('Aug 26, 2026');   // must NOT show Aug 25 in negative-offset timezones
  });
  it('falls back to the raw string when malformed', () => { expect(formatReportDate('garbage')).toBe('garbage'); });
});

// ---------------------------------------------------------------------------
// Document status on rows + editor remounting (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md)

const listRow = (over: Record<string, any> = {}) => ({
  id: 'dr1', projectId: 'p1', crewId: 'c1', crewName: 'Crew 1', reportDate: '2026-08-26', jobName: 'Big Job', contractorName: 'GC',
  weatherSummary: 'Sunny', temperature: '78F', manCounts: [], createdBy: null,
  createdAt: 1, updatedAt: 10, version: 1, photoCount: 0,
  ...over,
});

const FILE = { id: 'f1', name: 'DailyReport-2026-08-26.pdf', mime: 'application/pdf', size: 12, createdAt: 50, versionNumber: 1 };

describe('ProjectDailyReports — report status on rows', () => {
  beforeEach(() => {
    // These tests exercise the table, so force the List view — calendar is
    // the default but the table's row-level behavior is what's under test here.
    localStorage.setItem('dailyReports:view', 'list');
    getDailyReports.mockReset();
    getDailyReport.mockReset();
    getDocumentsBySource.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
    getDailyReports.mockResolvedValue([listRow(), listRow({ id: 'dr2', reportDate: '2026-08-27' })]);
    getDocumentsBySource.mockResolvedValue({ dr1: FILE, dr2: null });
    getDailyReport.mockResolvedValue(null);
  });

  it('shows a chip and an Open button only for the report that has a PDF', async () => {
    mount();
    await screen.findByText('Aug 26, 2026');
    await rtlWaitFor(() => expect(getDocumentsBySource).toHaveBeenCalled());
    expect(getDocumentsBySource.mock.calls[0][0]).toMatchObject({
      sourceType: 'dailyReport', kind: 'daily-report', sourceIds: ['dr1', 'dr2'],
    });

    await rtlWaitFor(() => expect(screen.getByText('PDF up to date')).toBeInTheDocument());
    expect(screen.queryByText('No PDF yet')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open PDF' })).toHaveLength(1);
  });

  it('shows each report\'s start time, and a dash for one made before start times', async () => {
    getDailyReports.mockResolvedValue([listRow({ startTime: '07:00' }), listRow({ id: 'dr2', reportDate: '2026-08-27', startTime: null })]);
    mount();
    expect(await screen.findByRole('columnheader', { name: 'Start' })).toBeInTheDocument();
    const [, row1, row2] = screen.getAllByRole('row');
    expect(row1).toHaveTextContent('7:00 AM');
    expect(row2.querySelectorAll('td')[1]).toHaveTextContent('—');
  });

  it('marks the chip out of date when the report changed after the PDF was made', async () => {
    getDocumentsBySource.mockResolvedValue({ dr1: { ...FILE, createdAt: 5 }, dr2: null });
    mount();
    await rtlWaitFor(() => expect(screen.getByText('PDF out of date')).toBeInTheDocument());
  });

  it('opens the viewer instead of the editor when Open is clicked', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open PDF' }));

    expect(await screen.findByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByText('DailyReport-2026-08-26.pdf')).toBeInTheDocument();
    expect(getDailyReport).not.toHaveBeenCalled();
  });

  it('keeps the editor mounted for its own saves and re-keys it for outside refreshes', async () => {
    getDailyReport.mockResolvedValue({ ...listRow(), photos: [] });
    mounts.count = 0;
    mount();

    fireEvent.click(await screen.findByText('Aug 26, 2026'));
    await screen.findByTestId('editor');
    await rtlWaitFor(() => expect(mounts.count).toBe(1));

    // act() flushes the reload's promises and the resulting render, so a
    // remount would already have happened by the time we count.
    await act(async () => { fireEvent.click(screen.getByTestId('save-kept')); });
    expect(getDailyReport).toHaveBeenCalledTimes(2); // open + reload
    expect(mounts.count).toBe(1);

    // A refresh that found nothing new must not throw away a typed draft.
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(1);

    // A record that actually moved on does re-key the editor.
    getDailyReport.mockResolvedValue({ ...listRow({ version: 2 }), photos: [] });
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(2);
  });
});

describe('ProjectDailyReports — calendar/list view toggle', () => {
  beforeEach(() => {
    getDailyReports.mockReset();
    getDailyReport.mockReset();
    getDocumentsBySource.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
    getDailyReports.mockResolvedValue([listRow()]);
    getDocumentsBySource.mockResolvedValue({ dr1: null });
    getDailyReport.mockResolvedValue(null);
    localStorage.clear();
  });

  it('defaults to the calendar view', async () => {
    mount();
    expect(await screen.findByTestId('daily-calendar')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('toggling to List shows the table and persists the choice', async () => {
    mount();
    await screen.findByTestId('daily-calendar');

    fireEvent.click(screen.getByRole('tab', { name: 'List' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-calendar')).not.toBeInTheDocument();
    expect(localStorage.getItem('dailyReports:view')).toBe('list');
  });

  it('a new mount respects a previously stored List preference', async () => {
    localStorage.setItem('dailyReports:view', 'list');
    mount();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-calendar')).not.toBeInTheDocument();
  });
});

// Crews (spec docs/superpowers/specs/2026-10-06-daily-report-crews-design.md):
// a tab per crew, each its own set of reports, plus a read-only All crews tab.
describe('ProjectDailyReports — crews', () => {
  const CREWS = [crewRow({ reportCount: 1 }), crewRow({ id: 'c2', name: 'Smith Drywall', sortOrder: 1, reportCount: 1 }), crewRow({ id: 'c3', name: 'Night crew', sortOrder: 2 })];
  const ours = listRow({ id: 'r1', reportDate: '2026-08-26' });
  const theirs = listRow({ id: 'r2', crewId: 'c2', crewName: 'Smith Drywall', reportDate: '2026-08-26', manCounts: [{ type: 'Hanger', count: 3 }] });
  const crewTabs = () => within(screen.getByRole('tablist', { name: 'Crews' })).getAllByRole('tab');

  beforeEach(() => {
    localStorage.setItem('dailyReports:view', 'list');
    getDailyReports.mockReset();
    getDailyReport.mockReset();
    getDocumentsBySource.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
    crewApi.getDailyReportCrews.mockResolvedValue(CREWS);
    getDailyReports.mockResolvedValue([ours, theirs]);
    getDocumentsBySource.mockResolvedValue({});
    getDailyReport.mockImplementation(async (id: string) => ({ ...(id === 'r2' ? theirs : ours), photos: [], attachments: [] }));
    crewApi.confirm.mockResolvedValue(true);
  });

  it('shows a tab per crew in order, then All crews; the first crew is open with only its own reports', async () => {
    mount();
    await rtlWaitFor(() => expect(crewTabs().map(t => t.textContent)).toEqual(['Crew 1', 'Smith Drywall', 'Night crew', 'All crews']));
    expect(crewTabs()[0]).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('table');
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + Crew 1's one report
    expect(screen.getByLabelText('New report — Crew 1')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Men' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Crew' })).toBeNull();
  });

  it('switching tabs shows that crew\'s reports and keeps the tab in the URL', async () => {
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'Smith Drywall' }));
    expect(screen.getByTestId('search')).toHaveTextContent('?crew=c2');
    expect(screen.getByRole('tab', { name: 'Smith Drywall' })).toHaveAttribute('aria-selected', 'true');
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('3 men');

    fireEvent.click(screen.getByRole('tab', { name: 'Night crew' }));
    expect(await screen.findByText('No daily reports for Night crew yet')).toBeInTheDocument();
  });

  it('opens the tab named in the URL, and the first crew for one that is gone', async () => {
    mount('/project/p1/daily?crew=c2');
    await rtlWaitFor(() => expect(screen.getByRole('tab', { name: 'Smith Drywall' })).toHaveAttribute('aria-selected', 'true'));
  });

  it('falls back to the first crew when the URL\'s crew is gone', async () => {
    mount('/project/p1/daily?crew=deleted');
    await rtlWaitFor(() => expect(screen.getByRole('tab', { name: 'Crew 1' })).toHaveAttribute('aria-selected', 'true'));
  });

  it('files a new report under the open crew, and opens it', async () => {
    crewApi.createDailyReport.mockResolvedValue({ id: 'r2' });
    mount('/project/p1/daily?crew=c2');
    await screen.findByLabelText('New report — Smith Drywall');
    fireEvent.change(screen.getByLabelText('New report — Smith Drywall'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'New report' }));
    await rtlWaitFor(() => expect(crewApi.createDailyReport).toHaveBeenCalledWith('p1', expect.objectContaining({ crewId: 'c2', reportDate: '2026-09-01', jobName: 'P1' })));
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-report-id', 'r2');
  });

  it('All crews lists every crew\'s reports with their crew, for viewing — no create, no delete — and opens one', async () => {
    mount('/project/p1/daily?crew=all');
    await rtlWaitFor(() => expect(screen.getByRole('tab', { name: 'All crews' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('columnheader', { name: 'Crew' })).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Crew 1');
    expect(rows[2]).toHaveTextContent('Smith Drywall');
    expect(screen.queryByRole('button', { name: 'New report' })).toBeNull();
    expect(screen.queryByTitle('Delete')).toBeNull();
    expect(screen.queryByTestId('daily-crew-menu-button')).toBeNull();

    fireEvent.click(rows[2]);
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-report-id', 'r2');
    expect(getDailyReport).toHaveBeenCalledWith('r2');
  });

  it('the All crews calendar shows each crew\'s report on a shared day and opens the clicked one', async () => {
    localStorage.setItem('dailyReports:view', 'calendar');
    const today = new Date().toLocaleDateString('en-CA');
    getDailyReports.mockResolvedValue([{ ...ours, reportDate: today }, { ...theirs, reportDate: today }]);
    mount('/project/p1/daily?crew=all');
    expect(await screen.findByTestId('daily-calendar-entry-r1')).toHaveTextContent('Crew 1');
    expect(screen.getByTestId('daily-calendar-entry-r2')).toHaveTextContent('Smith Drywall');
    fireEvent.click(screen.getByTestId('daily-calendar-entry-r2'));
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-report-id', 'r2');
  });

  it('Add crew asks for a name, adds the crew and opens its tab', async () => {
    crewApi.createDailyReportCrew.mockResolvedValue(crewRow({ id: 'c4', name: 'Acme Lath', sortOrder: 3 }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add crew' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Crew name'), { target: { value: '  Acme Lath ' } });
    crewApi.getDailyReportCrews.mockResolvedValue([...CREWS, crewRow({ id: 'c4', name: 'Acme Lath', sortOrder: 3 })]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add crew' }));

    await rtlWaitFor(() => expect(crewApi.createDailyReportCrew).toHaveBeenCalledWith('p1', 'Acme Lath'));
    await rtlWaitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('search')).toHaveTextContent('?crew=c4');
    expect(await screen.findByRole('tab', { name: 'Acme Lath' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a name the server refuses keeps the prompt open and says why; a blank one is caught first', async () => {
    crewApi.createDailyReportCrew.mockRejectedValue(new Error('There is already a crew named "crew 1" on this project'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add crew' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add crew' }));
    expect(await within(dialog).findByText('Enter a name for the crew.')).toBeInTheDocument();
    expect(crewApi.createDailyReportCrew).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Crew name'), { target: { value: 'crew 1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add crew' }));
    expect(await within(dialog).findByText('There is already a crew named "crew 1" on this project')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renames the open crew from its menu', async () => {
    crewApi.renameDailyReportCrew.mockResolvedValue(crewRow({ name: 'Our crew' }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Crew 1 options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename crew/ }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Crew name');
    expect(input).toHaveValue('Crew 1');
    fireEvent.change(input, { target: { value: 'Our crew' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await rtlWaitFor(() => expect(crewApi.renameDailyReportCrew).toHaveBeenCalledWith('c1', 'Our crew'));
  });

  it('can\'t delete a crew that has reports (and says why); deletes an empty one after asking', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Crew 1 options' }));
    expect(screen.getByRole('menuitem', { name: /Delete crew/ })).toBeDisabled();
    expect(screen.getByText('Only a crew with no reports can be deleted.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Night crew' }));
    fireEvent.click(screen.getByRole('button', { name: 'Night crew options' }));
    const del = screen.getByRole('menuitem', { name: /Delete crew/ });
    expect(del).toBeEnabled();
    crewApi.deleteDailyReportCrew.mockResolvedValue(undefined);
    fireEvent.click(del);
    await rtlWaitFor(() => expect(crewApi.deleteDailyReportCrew).toHaveBeenCalledWith('c3'));
    expect(crewApi.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete crew?', tone: 'danger' }));
    // Its tab was open: the page goes back to the first crew.
    await rtlWaitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^$/));
  });

  it('can\'t delete the project\'s only crew', async () => {
    crewApi.getDailyReportCrews.mockResolvedValue([crewRow()]);
    getDailyReports.mockResolvedValue([]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Crew 1 options' }));
    expect(screen.getByRole('menuitem', { name: /Delete crew/ })).toBeDisabled();
    expect(screen.getByText('A project keeps at least one crew.')).toBeInTheDocument();
  });

  it('a crew added elsewhere shows up without a reload', async () => {
    mount();
    await screen.findByRole('tab', { name: 'Night crew' });
    crewApi.getDailyReportCrews.mockResolvedValue([...CREWS, crewRow({ id: 'c9', name: 'Their crew', sortOrder: 9 })]);
    act(() => { fakeSocket.fire('entity-changed', { type: 'dailyReportCrew', id: 'c9', projectId: 'p1', action: 'created', bySessionId: 'other' }); });
    expect(await screen.findByRole('tab', { name: 'Their crew' }, { timeout: 2000 })).toBeInTheDocument();
  });
});
