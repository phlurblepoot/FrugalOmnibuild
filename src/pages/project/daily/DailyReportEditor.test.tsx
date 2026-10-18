// src/pages/project/daily/DailyReportEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// What stays the editor's job — and is what these tests pin — is handing the
// bar a `build()` that reads the SAVED report (photos included), never the
// typed-in draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DailyReport } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getDailyReport: vi.fn(),
  saveDailyReport: vi.fn(),
  sendDailyReport: vi.fn(),
  addDailyReportPhoto: vi.fn(),
  uploadProjectFile: vi.fn(),
  pickerProps: { last: null as any },
  composerProps: { last: null as any },
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildDailyReportPdf: vi.fn(),
  addDailyReportAttachment: vi.fn(),
  removeDailyReportAttachment: vi.fn(),
  appendAttachedPdfs: vi.fn(),
  getDailyWeather: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../../components/ConfirmDialog', () => ({ useConfirm: () => h.confirm }));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getDailyReport: h.getDailyReport,
  saveDailyReport: h.saveDailyReport,
  sendDailyReport: h.sendDailyReport,
  addDailyReportPhoto: h.addDailyReportPhoto,
  addDailyReportAttachment: h.addDailyReportAttachment,
  removeDailyReportAttachment: h.removeDailyReportAttachment,
  getDailyWeather: h.getDailyWeather,
  uploadProjectFile: h.uploadProjectFile,
  persistGeneratedDocument: h.persistGeneratedDocument,
  getDocumentBySource: h.getDocumentBySource,
  getDocumentsBySource: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getMailAccounts: vi.fn(async () => [{ id: 'a1', provider: 'fake', emailAddress: 'me@birchwood.test', displayName: null, isDefault: 1, status: 'ok', unreadCount: 0 }]),
  getAlwaysCc: vi.fn(async () => ''),
  getProject: vi.fn(async () => null),
  getCustomer: vi.fn(async () => undefined),
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
  getFileMeta: vi.fn(async () => null),
  getImageUrl: (id: string) => `/img/${id}`,
}));

// Stand-in picker: records the config the editor asked for and hands back one
// already-uploaded row on demand.
vi.mock('../../../components/FilePickerModal', () => ({
  FilePickerModal: (props: any) => {
    h.pickerProps.last = props;
    return (
      <div data-testid="picker">
        <button data-testid="picker-pick" onClick={() => void props.onPick?.([{ id: 'up-1', name: 'shot.png' }])}>pick</button>
      </div>
    );
  },
}));

vi.mock('./dailyReportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dailyReportPdf')>()),
  buildDailyReportPdf: h.buildDailyReportPdf,
}));
vi.mock('../../../utils/pdfAttachments', () => ({ appendAttachedPdfs: h.appendAttachedPdfs }));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

// The bar's own composer is the shared mail composer now; the stub resolves a
// SendRequest exactly as the real one does once the user hits Send.
vi.mock('../../../pages/mail/compose/MailComposer', async (orig) => ({
  ...(await orig<typeof import('../../../pages/mail/compose/MailComposer')>()),
  MailComposer: ({ open, onSend, onClose, ...rest }: any) => {
    h.composerProps.last = { open, ...rest };
    return open ? (
      <div data-testid="composer">
        <button
          data-testid="composer-send"
          onClick={() => {
            void onSend({ to: [{ addr: 'gc@example.com' }], subject: 's', html: '<p>b</p>', attachments: [] })
              .then(() => onClose())
              .catch(() => {});
          }}
        >
          send
        </button>
      </div>
    ) : null;
  },
}));

// The document bar loads the user's mailboxes (for the composer's From select)
// and the item's mail thread links (for the Sent chip). Neither is under test
// here; an empty mailbox list is the honest default.
vi.mock('../../../utils/mailApi', () => ({
  mailApi: {
    accounts: vi.fn(async () => []),
    links: vi.fn(async () => []),
    thread: vi.fn(async () => { throw new Error('not found'); }),
  },
}));

import { ToastProvider } from '../../../components/Toast';
import { DailyReportEditor } from './DailyReportEditor';

const report = (over: Partial<DailyReport> = {}): DailyReport => ({
  id: 'dr-1', projectId: 'p1', crewId: 'crew-1', crewName: 'Crew 1', reportDate: '2026-08-26', startTime: '06:00', jobName: 'Big Job',
  contractorName: 'GC Inc', weatherSummary: 'Sunny', temperature: '78F',
  weatherHourly: [{ hour: '9am', tempF: 78, condition: 'Sunny' }],
  manCounts: [{ type: 'Plasterer', count: 3 }], fieldNotes: 'All quiet', issues: '',
  // version 2 (not 1) so the mount effect doesn't auto-fetch weather.
  createdBy: null, createdAt: 1, updatedAt: 10, version: 2, photos: [], attachments: [],
  ...over,
});

// What the server hands back after the save — deliberately different from the
// prop so "built from saved state" is falsifiable.
const SAVED = report({ jobName: 'SERVER JOB', version: 3, updatedAt: 20, photos: [{ id: 'ph-1', fileId: 'f-photo', sortOrder: 0 }] });

// A PDF attached to the record, and what the merge helper hands back.
const ATTACHMENT = { id: 'at-1', fileId: 'a-1', sortOrder: 0, name: 'Spec sheet.pdf', mime: 'application/pdf', size: 2048 };
const MERGED = new Uint8Array([9, 9, 9]);

// What the weather endpoint hands back — distinguishable from the fixture's.
const FETCHED = { hourly: [{ hour: '8 AM', tempF: 70, condition: 'Clear' }], summary: 'Clear', temperature: '70–82°F' };

const onSaved = vi.fn();

const tree = (r: DailyReport) => (
  <MemoryRouter>
    <ToastProvider>
      <DailyReportEditor
        report={r}
        projectId="p1"
        projectName="Big Job"
        contractor="GC Inc"
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (r: DailyReport = report()) => render(tree(r));

beforeEach(() => {
  vi.clearAllMocks();
  h.getDailyReport.mockResolvedValue(SAVED);
  h.saveDailyReport.mockResolvedValue({ version: 3 });
  h.sendDailyReport.mockResolvedValue(undefined);
  h.pickerProps.last = null;
  h.addDailyReportPhoto.mockResolvedValue(undefined);
  h.uploadProjectFile.mockResolvedValue({ fileId: 'up-photo', versioned: false });
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildDailyReportPdf.mockReturnValue(new Uint8Array([1, 2, 3]).buffer);
  h.addDailyReportAttachment.mockResolvedValue(undefined);
  h.removeDailyReportAttachment.mockResolvedValue(undefined);
  h.appendAttachedPdfs.mockResolvedValue(MERGED);
  h.getDailyWeather.mockResolvedValue(FETCHED);
  h.confirm.mockResolvedValue(true);
});

// Each crew is its own set of reports, so the editor names the crew.
describe('DailyReportEditor — crew', () => {
  it('shows the report\'s crew in the title', async () => {
    mount(report({ crewName: 'Smith Drywall' }));
    expect(await screen.findByText('Daily Report — Aug 26, 2026 — Smith Drywall')).toBeInTheDocument();
  });

  it('names the crew in the email\'s subject and body and in the PDF\'s file name', async () => {
    mount(report({ crewName: 'Smith Drywall' }));
    fireEvent.click(await screen.findByTestId('doc-send'));
    await screen.findByTestId('composer');
    const { initial, primaryAttachment } = h.composerProps.last;
    expect(initial.subject).toBe('Daily Report — Aug 26, 2026 — Smith Drywall — Big Job');
    expect(initial.html).toContain('the daily report for Aug 26, 2026 (Smith Drywall) on Big Job');
    expect(primaryAttachment.name).toBe('DailyReport-Big-Job-Smith-Drywall-2026-08-26.pdf');
  });

  it('says which crew already has a report on the date it was moved to', async () => {
    const { DateTakenError } = await import('../../../utils/store');
    h.saveDailyReport.mockRejectedValue(new DateTakenError('dr-2'));
    mount(report({ crewName: 'Smith Drywall' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-27' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Smith Drywall already has a report for this date.')).toBeInTheDocument();
  });
});

describe('DailyReportEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF / Send… buttons', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send…/i })).toBeNull();
    // Close/Save stay the editor's own.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the report the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Job name'), { target: { value: 'Typed job' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveDailyReport).toHaveBeenCalledTimes(1));
    expect(h.saveDailyReport.mock.calls[0][1]).toMatchObject({ jobName: 'Typed job' });

    await waitFor(() => expect(h.buildDailyReportPdf).toHaveBeenCalledTimes(1));
    // Not the prop and not the local draft — the saved record, photos and all.
    expect(h.buildDailyReportPdf.mock.calls[0][0].report).toBe(SAVED);
    expect(h.buildDailyReportPdf.mock.calls[0][0].photoDataUrls).toHaveLength(1);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'daily-report', sourceType: 'dailyReport', sourceId: 'dr-1',
    });
    // The parent refreshes without re-keying the editor, so the bar survives
    // its own save-then-generate flow.
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getDailyReport.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildDailyReportPdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('keeps Email available while dirty, and stops re-saving once the record comes back', async () => {
    const { rerender } = mount();
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    // A pending edit no longer blocks Email — the bar saves first (spec §2).
    fireEvent.change(screen.getByLabelText('Job name'), { target: { value: 'Typed job' } });
    const dirtySend = screen.getByTestId('doc-send');
    expect(dirtySend).toBeEnabled();
    expect(dirtySend).not.toHaveAttribute('title', 'Save first');

    rerender(tree(report({ jobName: 'Typed job', version: 3, updatedAt: 20 })));

    // The round-tripped record must read as clean: if it still looked dirty,
    // every send would fire a redundant save of the record it just loaded.
    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));
    await waitFor(() => expect(h.sendDailyReport).toHaveBeenCalled());
    expect(h.saveDailyReport).not.toHaveBeenCalled();
  });

  it('does not stay dirty over a man-count row that only differs by the trim/blank-row normalize handleSave applies', async () => {
    // Regression: isDirty() used to compare the raw typed manCounts against
    // the raw saved record, but handleSave persists normalizeManCounts(...)
    // (trims each type, drops blank rows). A raw compare never saw those two
    // sides agree — even right after a keepMounted save handed back the
    // trimmed record — so Send stayed permanently stuck on "Save first".
    const { rerender } = mount();
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText('Trade / role'), { target: { value: 'Plasterer ' } });

    // Server hands back the save's result, normalized (trimmed) — the local
    // input still holds the untrimmed 'Plasterer ' the user typed, so a raw
    // (non-normalized) compare of the two would disagree forever.
    rerender(tree(report({ manCounts: [{ type: 'Plasterer', count: 3 }], version: 3, updatedAt: 20 })));

    // Still-dirty would mean every send re-saves the record it just loaded.
    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));
    await waitFor(() => expect(h.sendDailyReport).toHaveBeenCalled());
    expect(h.saveDailyReport).not.toHaveBeenCalled();
  });

  it('sends the generated file through sendDailyReport', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendDailyReport).toHaveBeenCalledTimes(1));
    expect(h.sendDailyReport.mock.calls[0][0]).toBe('dr-1');
    expect(h.sendDailyReport.mock.calls[0][1]).toMatchObject({ to: 'gc@example.com', fileId: 'file-9' });
  });
});

describe('photo card', () => {
  it('adds a picked photo through the shared picker and reloads', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add photos/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addDailyReportPhoto).toHaveBeenCalledWith('dr-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({
      accept: 'image', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'daily-report-photo', projectId: 'p1', sourceType: 'dailyReport', sourceId: 'dr-1' },
    });
  });

  it('uploads a dropped photo, links it, then reloads', async () => {
    mount();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(await screen.findByTestId('daily-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'daily-report-photo', { sourceType: 'dailyReport', sourceId: 'dr-1' },
    ));
    await waitFor(() => expect(h.addDailyReportPhoto).toHaveBeenCalledWith('dr-1', 'up-photo'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('has no bare file input left', async () => {
    mount();
    await screen.findByRole('button', { name: /Add photos/i });
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  // Adding a photo stamps the report server-side, which re-keys the editor and
  // would discard whatever is in the form.
  it('refuses a photo while the form is dirty, and says why', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Job name'), { target: { value: 'Typed job' } });
    expect(screen.getByRole('button', { name: /Add photos/i })).toBeDisabled();

    fireEvent.drop(screen.getByTestId('daily-photo-dropzone'), {
      dataTransfer: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
    });
    await screen.findByText('Save your changes first');
    expect(h.uploadProjectFile).not.toHaveBeenCalled();
  });
});

// PDF attachments (spec docs/superpowers/specs/2026-10-06-pdf-attachments-design.md):
// the shared card the invoice uses, and the attached PDFs' pages appended to
// the generated document after its own pages and photos.
describe('DailyReportEditor — PDF attachments', () => {
  it('adds a picked PDF through the shared picker and reloads', async () => {
    mount();
    expect(await screen.findByText('No attachments.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addDailyReportAttachment).toHaveBeenCalledWith('dr-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    // Global, like the invoice's: an attachment is often filed elsewhere.
    expect(h.pickerProps.last).toMatchObject({
      accept: 'pdf', defaultTab: 'upload', initialProjectIds: [],
      upload: { kind: 'document', projectId: 'p1' },
    });
  });

  it('lists an existing attachment and removes it through the API', async () => {
    mount(report({ attachments: [ATTACHMENT] }));
    expect(await screen.findByText('Spec sheet.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
    await waitFor(() => expect(h.removeDailyReportAttachment).toHaveBeenCalledWith('dr-1', 'a-1'));
    expect(onSaved).toHaveBeenCalled();
  });

  // Same save-first gate as the photo card above.
  it('refuses a PDF while the form is dirty, and says why', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Job name'), { target: { value: 'Typed job' } });
    const add = screen.getByRole('button', { name: /Add PDFs/i });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'Save your changes first');
  });

  it('appends the saved report\'s attachments to the bytes it built, and stores the result', async () => {
    h.getDailyReport.mockResolvedValue({ ...SAVED, attachments: [ATTACHMENT] });
    mount();
    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.appendAttachedPdfs).toHaveBeenCalledTimes(1));
    expect(h.appendAttachedPdfs.mock.calls[0][0]).toBe(h.buildDailyReportPdf.mock.results[0].value);
    expect(h.appendAttachedPdfs.mock.calls[0][1]).toEqual([ATTACHMENT]);
    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    const stored = h.persistGeneratedDocument.mock.calls[0][0] as Blob;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(MERGED);
  });

  it('emails that same merged file', async () => {
    h.getDailyReport.mockResolvedValue({ ...SAVED, attachments: [ATTACHMENT] });
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendDailyReport).toHaveBeenCalledTimes(1));
    expect(h.appendAttachedPdfs).toHaveBeenCalledTimes(1);
    const stored = h.persistGeneratedDocument.mock.calls[0][0] as Blob;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(MERGED);
    expect(h.sendDailyReport.mock.calls[0][1]).toMatchObject({ fileId: 'file-9' });
  });
});

// Start time (spec docs/superpowers/specs/2026-10-06-daily-report-start-time-design.md):
// the weather covers the start time through 12 hours later; changing the
// start on a report that has weather asks before replacing it.
describe('DailyReportEditor — start time', () => {
  const startField = () => screen.getByLabelText('Start time') as HTMLInputElement;
  const setStart = (value: string) => {
    fireEvent.change(startField(), { target: { value } });
    fireEvent.blur(startField());
  };

  it('shows the start time next to the date and saves a change', async () => {
    mount(report({ startTime: '07:00' }));
    expect(await screen.findByLabelText('Date')).toHaveValue('2026-08-26');
    expect(startField()).toHaveAttribute('type', 'time');
    expect(startField().value).toBe('07:00');

    fireEvent.change(startField(), { target: { value: '07:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.saveDailyReport).toHaveBeenCalledTimes(1));
    expect(h.saveDailyReport.mock.calls[0][1]).toMatchObject({ startTime: '07:15' });
  });

  it('a report from before start times shows an empty field and saves none', async () => {
    mount(report({ startTime: null }));
    expect(startField().value).toBe('');
    fireEvent.change(screen.getByLabelText('Job name'), { target: { value: 'Typed job' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.saveDailyReport).toHaveBeenCalledTimes(1));
    expect(h.saveDailyReport.mock.calls[0][1]).toMatchObject({ startTime: null });
  });

  it('auto-fetches a new report\'s weather for its start time', async () => {
    mount(report({ version: 1, weatherHourly: [], startTime: '07:00' }));
    await waitFor(() => expect(h.getDailyWeather).toHaveBeenCalledWith('p1', '2026-08-26', '07:00'));
    expect(await screen.findByText('8 AM')).toBeInTheDocument();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('Refresh weather fetches for the start time in the field', async () => {
    mount(report({ startTime: '06:00' }));
    fireEvent.change(startField(), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /Refresh weather/ }));
    await waitFor(() => expect(h.getDailyWeather).toHaveBeenCalledWith('p1', '2026-08-26', '09:00'));
  });

  it('asks before replacing the weather when the start time changes, and refetches for it on yes', async () => {
    mount(report({ startTime: '06:00' }));
    setStart('08:00');

    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Update the weather?',
      message: expect.stringContaining('Update the weather to match the new start time (8:00 AM)?'),
    });
    await waitFor(() => expect(h.getDailyWeather).toHaveBeenCalledWith('p1', '2026-08-26', '08:00'));
    expect(await screen.findByText('8 AM')).toBeInTheDocument();
    expect(screen.queryByText('9am')).toBeNull();
    expect(screen.getByLabelText('Weather')).toHaveValue('Clear');
    expect(screen.getByLabelText('Temperature')).toHaveValue('70–82°F');
  });

  it('keeps the stored weather on no, and does not ask again until the start time changes again', async () => {
    h.confirm.mockResolvedValue(false);
    mount(report({ startTime: '06:00' }));
    setStart('08:00');
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));

    expect(h.getDailyWeather).not.toHaveBeenCalled();
    expect(screen.getByText('9am')).toBeInTheDocument();
    expect(screen.getByLabelText('Weather')).toHaveValue('Sunny');

    fireEvent.blur(startField());
    setStart('08:00');
    await act(async () => {});
    expect(h.confirm).toHaveBeenCalledTimes(1);

    setStart('10:00');
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(2));
  });

  it('does not ask when the start stays in the same hour, or when the report has no weather', async () => {
    const { unmount } = mount(report({ startTime: '06:00' }));
    setStart('06:45'); // same 6 AM–6 PM window
    await act(async () => {});
    expect(h.confirm).not.toHaveBeenCalled();
    unmount();

    mount(report({ startTime: '06:00', weatherHourly: [], weatherSummary: '', temperature: '' }));
    setStart('09:00');
    await act(async () => {});
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.getDailyWeather).not.toHaveBeenCalled();
  });

  it('a start time change while a new report\'s weather is still loading refetches for the new start without asking', async () => {
    let finishFirst: (w: typeof FETCHED) => void = () => {};
    h.getDailyWeather.mockReturnValueOnce(new Promise(r => { finishFirst = r; }));
    mount(report({ version: 1, weatherHourly: [], startTime: '06:00' }));
    await waitFor(() => expect(h.getDailyWeather).toHaveBeenCalledWith('p1', '2026-08-26', '06:00'));

    setStart('18:00');
    await waitFor(() => expect(h.getDailyWeather).toHaveBeenLastCalledWith('p1', '2026-08-26', '18:00'));
    expect(await screen.findByText('8 AM')).toBeInTheDocument();
    expect(h.confirm).not.toHaveBeenCalled();

    // The superseded fetch landing late must not overwrite the newer weather.
    await act(async () => { finishFirst({ hourly: [{ hour: '6 AM', tempF: 50, condition: 'Fog' }], summary: 'Fog', temperature: '50°F' }); });
    expect(screen.queryByText('Fog')).toBeNull();
    expect(screen.getByLabelText('Weather')).toHaveValue('Clear');
  });
});
