// src/pages/project/billing/InvoiceEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// What stays the editor's job — and is what these tests pin — is handing the
// bar a `build()` that reads the SAVED invoice, never the typed-in draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Invoice, Payment } from '../../../utils/store';
import { useTimeZone } from '../../../test/timeZone';

const h = vi.hoisted(() => ({
  getInvoice: vi.fn(),
  saveInvoice: vi.fn(),
  sendInvoice: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildInvoicePdf: vi.fn(),
  appendAttachedPdfs: vi.fn(),
  addInvoicePhoto: vi.fn(),
  removeInvoicePhoto: vi.fn(),
  addInvoiceAttachment: vi.fn(),
  updateInvoiceAttachment: vi.fn(),
  removeInvoiceAttachment: vi.fn(),
  pickerProps: { last: null as any },
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getInvoice: h.getInvoice,
  saveInvoice: h.saveInvoice,
  sendInvoice: h.sendInvoice,
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
  addInvoicePhoto: h.addInvoicePhoto,
  removeInvoicePhoto: h.removeInvoicePhoto,
  addInvoiceAttachment: h.addInvoiceAttachment,
  updateInvoiceAttachment: h.updateInvoiceAttachment,
  removeInvoiceAttachment: h.removeInvoiceAttachment,
}));

// Stand-in picker: records the config the editor asked for and hands back one
// already-uploaded row on demand (mirrors ChangeOrderEditor.test.tsx).
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

vi.mock('./invoicePdf', () => ({ buildInvoicePdf: h.buildInvoicePdf }));
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
            void onSend({ to: [{ addr: 'client@example.com' }], subject: 's', html: '<p>b</p>', attachments: [] })
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
import { InvoiceEditor } from './InvoiceEditor';

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'inv-1', projectId: 'p1', number: 'INV-1', date: null, status: 'draft',
  terms: null, notes: null, version: 2, createdAt: 1, updatedAt: 10,
  lines: [{ description: 'work', qty: 1, unitPrice: 100 }],
  payments: [], photos: [], attachments: [], totalCents: 10000, paidCents: 0, balanceCents: 10000,
  ...over,
});

// What the server hands back after the save — deliberately different from the
// prop so "built from saved state" is falsifiable.
const SAVED = invoice({ number: 'SERVER-9', version: 3, updatedAt: 20 });

const onSaved = vi.fn();

const tree = (inv: Invoice) => (
  <MemoryRouter>
    <ToastProvider>
      <InvoiceEditor
        invoice={inv}
        onClose={vi.fn()}
        onSaved={onSaved}
        projectName="Big Job"
        projectId="p1"
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (inv: Invoice = invoice()) => render(tree(inv));

beforeEach(() => {
  vi.clearAllMocks();
  h.getInvoice.mockResolvedValue(SAVED);
  h.saveInvoice.mockResolvedValue({ version: 3 });
  h.sendInvoice.mockResolvedValue(undefined);
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildInvoicePdf.mockReturnValue(new Uint8Array([1, 2, 3]));
  h.appendAttachedPdfs.mockImplementation(async (base: Uint8Array) => base);
  h.pickerProps.last = null;
  h.addInvoicePhoto.mockResolvedValue(undefined);
  h.removeInvoicePhoto.mockResolvedValue(undefined);
  h.addInvoiceAttachment.mockResolvedValue(undefined);
  h.updateInvoiceAttachment.mockResolvedValue(undefined);
  h.removeInvoiceAttachment.mockResolvedValue(undefined);
});

describe('InvoiceEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF button', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    // Close/Save stay the editor's own.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save invoice' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the invoice the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Number'), { target: { value: 'INV-2' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveInvoice).toHaveBeenCalledTimes(1));
    expect(h.saveInvoice.mock.calls[0][1]).toMatchObject({ number: 'INV-2' });

    await waitFor(() => expect(h.buildInvoicePdf).toHaveBeenCalledTimes(1));
    // Not the prop (INV-1) and not the local draft (INV-2) — the saved record.
    expect(h.buildInvoicePdf.mock.calls[0][0].invoice).toBe(SAVED);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-1',
    });
    // The parent refreshes without re-keying the editor, so the bar survives
    // its own save-then-generate flow.
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getInvoice.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildInvoicePdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('stops reading as dirty when the saved record comes back with re-minted line ids', async () => {
    // billingStore re-INSERTs invoice_lines on every save, so the same line
    // returns with a brand-new id — which must not read as an unsaved edit, or
    // Email stays disabled on "Save first" forever.
    const loaded = invoice({ lines: [{ id: 'line-old', description: 'work', qty: 1, unitPrice: 100 }] });
    const { rerender } = mount(loaded);
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    rerender(tree(invoice({
      version: 3,
      updatedAt: 20,
      lines: [{ id: 'line-new', description: 'work', qty: 1, unitPrice: 100 }],
    })));

    const send = screen.getByTestId('doc-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
  });

  it('sends the generated file through sendInvoice', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendInvoice).toHaveBeenCalledTimes(1));
    expect(h.sendInvoice.mock.calls[0][0]).toBe('inv-1');
    expect(h.sendInvoice.mock.calls[0][1]).toMatchObject({ to: 'client@example.com', fileId: 'file-9' });
  });
});

describe('InvoiceEditor — internal notes', () => {
  it('renders the loaded notes, edits as plain text (never as HTML), and saves them', async () => {
    mount(invoice({ notes: 'Called about scope' }));
    const notesField = (await screen.findByLabelText('Notes (internal)')) as HTMLTextAreaElement;
    expect(notesField.tagName).toBe('TEXTAREA');
    expect(notesField.value).toBe('Called about scope');

    fireEvent.change(notesField, { target: { value: 'Left a voicemail <b>urgent</b>' } });
    expect(notesField.value).toBe('Left a voicemail <b>urgent</b>');
    // A plain controlled <textarea> — the markup is text content, never parsed
    // as HTML, so no <b> element is ever created from it.
    expect(document.querySelector('b')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save invoice' }));
    await waitFor(() => expect(h.saveInvoice).toHaveBeenCalledTimes(1));
    expect(h.saveInvoice.mock.calls[0][1]).toMatchObject({ notes: 'Left a voicemail <b>urgent</b>' });
  });

  it('saves notes as null when cleared', async () => {
    mount(invoice({ notes: 'existing note' }));
    const notesField = await screen.findByLabelText('Notes (internal)');

    fireEvent.change(notesField, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice' }));
    await waitFor(() => expect(h.saveInvoice).toHaveBeenCalledTimes(1));
    expect(h.saveInvoice.mock.calls[0][1]).toMatchObject({ notes: null });
  });
});

describe('InvoiceEditor — photos + attachments', () => {
  it('renders the photos card and the attachments section', async () => {
    mount();
    expect(await screen.findByRole('button', { name: /Add photos/i })).toBeInTheDocument();
    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add PDFs/i })).toBeInTheDocument();
    expect(screen.getByText('No photos. Attach reference shots for the invoice.')).toBeInTheDocument();
    expect(screen.getByText('No attachments.')).toBeInTheDocument();
  });

  it('adds a picked photo through the shared picker and reloads', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add photos/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addInvoicePhoto).toHaveBeenCalledWith('inv-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({
      accept: 'image', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'invoice-photo', projectId: 'p1', sourceType: 'invoice', sourceId: 'inv-1' },
    });
  });

  it('adds a picked PDF attachment through the shared picker and reloads', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add PDFs/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addInvoiceAttachment).toHaveBeenCalledWith('inv-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({ accept: 'pdf', defaultTab: 'upload', initialProjectIds: [] });
  });

  it('lists an existing attachment and removes it through the API', async () => {
    mount(invoice({
      attachments: [{ id: 'at1', fileId: 'a1', sortOrder: 0, name: 'Warranty.pdf', mime: 'application/pdf', size: 2048 }],
    }));
    expect(await screen.findByText('Warranty.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
    await waitFor(() => expect(h.removeInvoiceAttachment).toHaveBeenCalledWith('inv-1', 'a1'));
  });

  it('lists an existing photo and removes it through the API', async () => {
    // No line items, so the line-item table's own "Remove" button (same title)
    // isn't in the DOM to collide with the photo grid's.
    mount(invoice({ lines: [], photos: [{ id: 'ph1', fileId: 'f1', sortOrder: 0 }] }));
    expect(await screen.findByTitle('Remove')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Remove'));
    await waitFor(() => expect(h.removeInvoicePhoto).toHaveBeenCalledWith('inv-1', 'f1'));
  });

  it('builds the PDF with photo data URLs, then appends the saved invoice\'s attachments after them', async () => {
    const attachments = [{ id: 'at1', fileId: 'a1', sortOrder: 0, name: 'Warranty.pdf', mime: 'application/pdf', size: 2048 }];
    h.getInvoice.mockResolvedValue({ ...SAVED, photos: [{ id: 'ph1', fileId: 'f1', sortOrder: 0 }], attachments });
    mount();
    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.buildInvoicePdf).toHaveBeenCalledTimes(1));
    expect(h.buildInvoicePdf.mock.calls[0][0].photoDataUrls).toHaveLength(1);
    // The invoice's own bytes (photo pages included) go in first; the saved
    // record's attachments are appended to them.
    await waitFor(() => expect(h.appendAttachedPdfs).toHaveBeenCalledTimes(1));
    expect(h.appendAttachedPdfs.mock.calls[0][0]).toBe(h.buildInvoicePdf.mock.results[0].value);
    expect(h.appendAttachedPdfs.mock.calls[0][1]).toEqual(attachments);
    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
  });
});

describe('InvoiceEditor — dates west of UTC', () => {
  useTimeZone('America/Los_Angeles');

  const payment = (id: string, date: number): Payment => ({
    id, targetType: 'invoice', targetId: 'inv-1', date, amount: 50, method: 'check', note: null, createdAt: 1,
  });

  it('opens on the day that was picked, and lists its payments on their own days', async () => {
    mount(invoice({
      date: new Date('2026-10-01').getTime(),
      payments: [
        payment('pay-1', new Date('2026-10-15').getTime()),
        payment('pay-2', Date.UTC(2026, 9, 21, 3, 30)), // stamped "now": Oct 20, 8:30pm in Los Angeles
      ],
    }));
    expect(await screen.findByLabelText('Date')).toHaveValue('2026-10-01');
    expect(screen.getByText(new Date(2026, 9, 15).toLocaleDateString())).toBeInTheDocument();
    expect(screen.getByText(new Date(2026, 9, 20).toLocaleDateString())).toBeInTheDocument();
  });

  it('still stores a picked day the way it always has', async () => {
    mount(invoice({ date: new Date('2026-10-01').getTime() }));
    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-10-05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice' }));
    await waitFor(() => expect(h.saveInvoice).toHaveBeenCalledTimes(1));
    expect(h.saveInvoice.mock.calls[0][1]).toMatchObject({ date: new Date('2026-10-05').getTime() });
  });
});
