// src/pages/project/billing/ChangeOrderEditor.test.tsx
// Same contract as InvoiceEditor's: the shared bar owns Generate/Open/Download/
// Send, and the PDF is built from the saved change order rather than the draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChangeOrder } from '../../../utils/store';
import { useTimeZone } from '../../../test/timeZone';

const h = vi.hoisted(() => ({
  getChangeOrder: vi.fn(),
  saveChangeOrder: vi.fn(),
  sendChangeOrder: vi.fn(),
  addCOPhoto: vi.fn(),
  uploadProjectFile: vi.fn(),
  pickerProps: { last: null as any },
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildChangeOrderPdf: vi.fn(),
  addCOAttachment: vi.fn(),
  removeCOAttachment: vi.fn(),
  appendAttachedPdfs: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getChangeOrder: h.getChangeOrder,
  saveChangeOrder: h.saveChangeOrder,
  sendChangeOrder: h.sendChangeOrder,
  addCOPhoto: h.addCOPhoto,
  addCOAttachment: h.addCOAttachment,
  removeCOAttachment: h.removeCOAttachment,
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

vi.mock('./changeOrderPdf', () => ({ buildChangeOrderPdf: h.buildChangeOrderPdf }));
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
import { ChangeOrderEditor } from './ChangeOrderEditor';

const co = (over: Partial<ChangeOrder> = {}): ChangeOrder => ({
  id: 'co-1', projectId: 'p1', number: '001', date: null, title: 'Extra wall',
  description: null, lumpSumAmount: 0, scheduleImpactDays: null, status: 'draft',
  version: 2, createdAt: 1, updatedAt: 10, amount: 100,
  lines: [{ description: 'framing', qty: 1, unitPrice: 100 }],
  photos: [], attachments: [], totalCents: 10000, lumpSumCents: 0,
  ...over,
});

const SAVED = co({ title: 'SERVER TITLE', version: 3, updatedAt: 20 });

// A PDF attached to the record, and what the merge helper hands back.
const ATTACHMENT = { id: 'at-1', fileId: 'a-1', sortOrder: 0, name: 'Spec sheet.pdf', mime: 'application/pdf', size: 2048 };
const MERGED = new Uint8Array([9, 9, 9]);

const onSaved = vi.fn();

const tree = (order: ChangeOrder) => (
  <MemoryRouter>
    <ToastProvider>
      <ChangeOrderEditor
        changeOrder={order}
        onClose={vi.fn()}
        onSaved={onSaved}
        projectName="Big Job"
        projectId="p1"
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (order: ChangeOrder = co()) => render(tree(order));

beforeEach(() => {
  vi.clearAllMocks();
  h.getChangeOrder.mockResolvedValue(SAVED);
  h.saveChangeOrder.mockResolvedValue({ version: 3 });
  h.sendChangeOrder.mockResolvedValue(undefined);
  h.pickerProps.last = null;
  h.addCOPhoto.mockResolvedValue(undefined);
  h.uploadProjectFile.mockResolvedValue({ fileId: 'up-photo', versioned: false });
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-7', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildChangeOrderPdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
  h.addCOAttachment.mockResolvedValue(undefined);
  h.removeCOAttachment.mockResolvedValue(undefined);
  h.appendAttachedPdfs.mockResolvedValue(MERGED);
});

describe('ChangeOrderEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF button', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save change order' })).toBeInTheDocument();
    // The photos card's uploader is now the shared picker button.
    expect(screen.getByRole('button', { name: /Add photos/i })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the change order the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Local title' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveChangeOrder).toHaveBeenCalledTimes(1));
    expect(h.saveChangeOrder.mock.calls[0][1]).toMatchObject({ title: 'Local title' });

    await waitFor(() => expect(h.buildChangeOrderPdf).toHaveBeenCalledTimes(1));
    expect(h.buildChangeOrderPdf.mock.calls[0][0].changeOrder).toBe(SAVED);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'change-order', sourceType: 'change-order', sourceId: 'co-1',
    });
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getChangeOrder.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildChangeOrderPdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('stops reading as dirty once the saved record comes back', async () => {
    // billingStore re-INSERTs change_order_lines on every save, so the same
    // line returns with a brand-new id, and a typed "500.50" comes back as the
    // number 500.5. Neither is an unsaved edit — if either reads as one, Email
    // stays disabled on "Save first" forever.
    const loaded = co({
      lines: [{ id: 'line-old', description: 'framing', qty: 1, unitPrice: 100 }],
      lumpSumAmount: 0,
    });
    const { rerender } = mount(loaded);
    fireEvent.change(screen.getByLabelText('Lump sum'), { target: { value: '500.50' } });

    rerender(tree(co({
      version: 3,
      updatedAt: 20,
      lines: [{ id: 'line-new', description: 'framing', qty: 1, unitPrice: 100 }],
      lumpSumAmount: 500.5,
    })));

    const send = await screen.findByTestId('doc-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
  });

  it('sends the generated file through sendChangeOrder', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendChangeOrder).toHaveBeenCalledTimes(1));
    expect(h.sendChangeOrder.mock.calls[0][0]).toBe('co-1');
    expect(h.sendChangeOrder.mock.calls[0][1]).toMatchObject({ to: 'gc@example.com', fileId: 'file-7' });
  });
});

describe('photo card', () => {
  it('adds a picked photo through the shared picker and reloads', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add photos/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addCOPhoto).toHaveBeenCalledWith('co-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({
      accept: 'image', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'change-order-photo', projectId: 'p1', sourceType: 'change-order', sourceId: 'co-1' },
    });
  });

  it('uploads a dropped photo, links it, then reloads', async () => {
    mount();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(await screen.findByTestId('change-order-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'change-order-photo', { sourceType: 'change-order', sourceId: 'co-1' },
    ));
    await waitFor(() => expect(h.addCOPhoto).toHaveBeenCalledWith('co-1', 'up-photo'));
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
describe('ChangeOrderEditor — PDF attachments', () => {
  it('adds a picked PDF through the shared picker and reloads', async () => {
    mount();
    expect(await screen.findByText('No attachments.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addCOAttachment).toHaveBeenCalledWith('co-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    // Global, like the invoice's: an attachment is often filed elsewhere.
    expect(h.pickerProps.last).toMatchObject({
      accept: 'pdf', defaultTab: 'upload', initialProjectIds: [],
      upload: { kind: 'document', projectId: 'p1' },
    });
  });

  it('lists an existing attachment and removes it through the API', async () => {
    mount(co({ attachments: [ATTACHMENT] }));
    expect(await screen.findByText('Spec sheet.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
    await waitFor(() => expect(h.removeCOAttachment).toHaveBeenCalledWith('co-1', 'a-1'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('appends the saved change order\'s attachments to the bytes it built, and stores the result', async () => {
    h.getChangeOrder.mockResolvedValue({ ...SAVED, attachments: [ATTACHMENT] });
    mount();
    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.appendAttachedPdfs).toHaveBeenCalledTimes(1));
    expect(h.appendAttachedPdfs.mock.calls[0][0]).toBe(h.buildChangeOrderPdf.mock.results[0].value);
    expect(h.appendAttachedPdfs.mock.calls[0][1]).toEqual([ATTACHMENT]);
    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    const stored = h.persistGeneratedDocument.mock.calls[0][0] as Blob;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(MERGED);
  });

  it('emails that same merged file', async () => {
    h.getChangeOrder.mockResolvedValue({ ...SAVED, attachments: [ATTACHMENT] });
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendChangeOrder).toHaveBeenCalledTimes(1));
    expect(h.appendAttachedPdfs).toHaveBeenCalledTimes(1);
    const stored = h.persistGeneratedDocument.mock.calls[0][0] as Blob;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(MERGED);
    expect(h.sendChangeOrder.mock.calls[0][1]).toMatchObject({ fileId: 'file-7' });
  });
});

describe('ChangeOrderEditor — dates west of UTC', () => {
  useTimeZone('America/Los_Angeles');

  it('opens on the day that was picked, and saves a new one the way it always has', async () => {
    mount(co({ date: new Date('2026-10-01').getTime() }));
    expect(await screen.findByLabelText('Date')).toHaveValue('2026-10-01');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save change order' }));
    await waitFor(() => expect(h.saveChangeOrder).toHaveBeenCalledTimes(1));
    expect(h.saveChangeOrder.mock.calls[0][1]).toMatchObject({ date: new Date('2026-10-05').getTime() });
  });

  it('opens an older date stamped with a time of day on its local day', async () => {
    mount(co({ date: Date.UTC(2026, 9, 7, 3, 30) })); // Oct 6, 8:30pm in Los Angeles
    expect(await screen.findByLabelText('Date')).toHaveValue('2026-10-06');
  });
});
