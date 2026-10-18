// src/pages/project/issues/IssueEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// What stays the editor's job — and is what these tests pin — is handing the
// bar a `build()` that reads the SAVED issue (photos included), never the
// typed-in draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Issue } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getIssue: vi.fn(),
  saveIssue: vi.fn(),
  sendIssue: vi.fn(),
  addIssuePhoto: vi.fn(),
  uploadProjectFile: vi.fn(),
  pickerProps: { last: null as any },
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildIssuePdf: vi.fn(),
  addIssueAttachment: vi.fn(),
  removeIssueAttachment: vi.fn(),
  appendAttachedPdfs: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getIssue: h.getIssue,
  saveIssue: h.saveIssue,
  sendIssue: h.sendIssue,
  addIssuePhoto: h.addIssuePhoto,
  addIssueAttachment: h.addIssueAttachment,
  removeIssueAttachment: h.removeIssueAttachment,
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

vi.mock('./issuePdf', () => ({ buildIssuePdf: h.buildIssuePdf }));
vi.mock('../../../utils/pdfAttachments', () => ({ appendAttachedPdfs: h.appendAttachedPdfs }));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

// The bar's own composer is the shared mail composer now; the stub resolves a
// SendRequest exactly as the real one does once the user hits Send.
vi.mock('../../../pages/mail/compose/MailComposer', async (orig) => ({
  ...(await orig<typeof import('../../../pages/mail/compose/MailComposer')>()),
  MailComposer: ({ open, onSend, onClose }: any) =>
    open ? (
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
    ) : null,
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
import { IssueEditor } from './IssueEditor';

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 'iss-1', projectId: 'p1', number: 7, title: 'Cracked stucco',
  description: 'North wall', status: 'open', version: 2, sentAt: null,
  createdAt: 1, updatedAt: 10, photos: [], attachments: [],
  ...over,
});

// What the server hands back after the save — deliberately different from the
// prop so "built from saved state" is falsifiable.
const SAVED = issue({ title: 'SERVER TITLE', version: 3, updatedAt: 20, photos: [{ id: 'ph-1', fileId: 'f-photo', sortOrder: 0 }] });

// A PDF attached to the record, and what the merge helper hands back.
const ATTACHMENT = { id: 'at-1', fileId: 'a-1', sortOrder: 0, name: 'Spec sheet.pdf', mime: 'application/pdf', size: 2048 };
const MERGED = new Uint8Array([9, 9, 9]);

const onSaved = vi.fn();

const tree = (iss: Issue) => (
  <MemoryRouter>
    <ToastProvider>
      <IssueEditor
        issue={iss}
        projectId="p1"
        projectName="Big Job"
        contractor="GC Inc"
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (iss: Issue = issue()) => render(tree(iss));

beforeEach(() => {
  vi.clearAllMocks();
  h.getIssue.mockResolvedValue(SAVED);
  h.saveIssue.mockResolvedValue({ version: 3 });
  h.sendIssue.mockResolvedValue(undefined);
  h.pickerProps.last = null;
  h.addIssuePhoto.mockResolvedValue(undefined);
  h.uploadProjectFile.mockResolvedValue({ fileId: 'up-photo', versioned: false });
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildIssuePdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
  h.addIssueAttachment.mockResolvedValue(undefined);
  h.removeIssueAttachment.mockResolvedValue(undefined);
  h.appendAttachedPdfs.mockResolvedValue(MERGED);
});

describe('IssueEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF / Send report buttons', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send report/i })).toBeNull();
    // Close/Save stay the editor's own.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the issue the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed title' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveIssue).toHaveBeenCalledTimes(1));
    expect(h.saveIssue.mock.calls[0][1]).toMatchObject({ title: 'Typed title' });

    await waitFor(() => expect(h.buildIssuePdf).toHaveBeenCalledTimes(1));
    // Not the prop and not the local draft — the saved record, photos and all.
    expect(h.buildIssuePdf.mock.calls[0][0].issue).toBe(SAVED);
    expect(h.buildIssuePdf.mock.calls[0][0].photoDataUrls).toHaveLength(1);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'issue-report', name: 'ISS-007.pdf',
      sourceType: 'issue', sourceId: 'iss-1',
    });
    // The parent refreshes without re-keying the editor, so the bar survives
    // its own save-then-generate flow.
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getIssue.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildIssuePdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('keeps Email available while dirty, and stops re-saving once the record comes back', async () => {
    const { rerender } = mount();
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    // A pending edit no longer blocks Email — the bar saves first (spec §2).
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed title' } });
    const dirtySend = screen.getByTestId('doc-send');
    expect(dirtySend).toBeEnabled();
    expect(dirtySend).not.toHaveAttribute('title', 'Save first');

    rerender(tree(issue({ title: 'Typed title', version: 3, updatedAt: 20 })));

    // The round-tripped record must read as clean: if it still looked dirty,
    // every send would fire a redundant save of the record it just loaded.
    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));
    await waitFor(() => expect(h.sendIssue).toHaveBeenCalled());
    expect(h.saveIssue).not.toHaveBeenCalled();
  });

  it('sends the generated file through sendIssue', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendIssue).toHaveBeenCalledTimes(1));
    expect(h.sendIssue.mock.calls[0][0]).toBe('iss-1');
    expect(h.sendIssue.mock.calls[0][1]).toMatchObject({ to: 'gc@example.com', fileId: 'file-9' });
  });
});

describe('photo card', () => {
  it('adds a picked photo through the shared picker and reloads', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add photos/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addIssuePhoto).toHaveBeenCalledWith('iss-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({
      accept: 'image', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'issue-photo', projectId: 'p1', sourceType: 'issue', sourceId: 'iss-1' },
    });
  });

  it('uploads a dropped photo, links it, then reloads', async () => {
    mount();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(await screen.findByTestId('issue-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'issue-photo', { sourceType: 'issue', sourceId: 'iss-1' },
    ));
    await waitFor(() => expect(h.addIssuePhoto).toHaveBeenCalledWith('iss-1', 'up-photo'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('has no bare file input left', async () => {
    mount();
    await screen.findByRole('button', { name: /Add photos/i });
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });
});

// PDF attachments (spec docs/superpowers/specs/2026-10-06-pdf-attachments-design.md):
// the shared card the invoice uses, and the attached PDFs' pages appended to
// the generated document after its own pages and photos.
describe('IssueEditor — PDF attachments', () => {
  it('adds a picked PDF through the shared picker and reloads', async () => {
    mount();
    expect(await screen.findByText('No attachments.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addIssueAttachment).toHaveBeenCalledWith('iss-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    // Global, like the invoice's: an attachment is often filed elsewhere.
    expect(h.pickerProps.last).toMatchObject({
      accept: 'pdf', defaultTab: 'upload', initialProjectIds: [],
      upload: { kind: 'document', projectId: 'p1' },
    });
  });

  it('lists an existing attachment and removes it through the API', async () => {
    mount(issue({ attachments: [ATTACHMENT] }));
    expect(await screen.findByText('Spec sheet.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
    await waitFor(() => expect(h.removeIssueAttachment).toHaveBeenCalledWith('iss-1', 'a-1'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('appends the saved issue\'s attachments to the bytes it built, and stores the result', async () => {
    h.getIssue.mockResolvedValue({ ...SAVED, attachments: [ATTACHMENT] });
    mount();
    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.appendAttachedPdfs).toHaveBeenCalledTimes(1));
    expect(h.appendAttachedPdfs.mock.calls[0][0]).toBe(h.buildIssuePdf.mock.results[0].value);
    expect(h.appendAttachedPdfs.mock.calls[0][1]).toEqual([ATTACHMENT]);
    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    const stored = h.persistGeneratedDocument.mock.calls[0][0] as Blob;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(MERGED);
  });

  it('emails that same merged file', async () => {
    h.getIssue.mockResolvedValue({ ...SAVED, attachments: [ATTACHMENT] });
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendIssue).toHaveBeenCalledTimes(1));
    expect(h.appendAttachedPdfs).toHaveBeenCalledTimes(1);
    const stored = h.persistGeneratedDocument.mock.calls[0][0] as Blob;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(MERGED);
    expect(h.sendIssue.mock.calls[0][1]).toMatchObject({ fileId: 'file-9' });
  });
});
