// src/pages/documents/UploadDocumentsModal.test.tsx
//
// Two invariants the labeling popup has to hold: what the Type select shows is
// what gets uploaded (including for files dropped onto the page), and a partial
// failure leaves exactly the failures behind, so pressing Upload again retries
// instead of duplicating the rows that already landed.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UploadDocumentsModal, guessKind } from './UploadDocumentsModal';
import { ToastProvider } from '../../components/Toast';

const saveBinaryFile = vi.hoisted(() => vi.fn());
vi.mock('../../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/store')>();
  return { ...actual, saveBinaryFile };
});

// A .png so its guessed type ('photo') differs from the 'document' default.
const png = (name = 'shot.png') => new File([new Uint8Array([1])], name, { type: 'image/png' });
const pdf = (name = 'plan.pdf') => new File([new Uint8Array([1])], name, { type: 'application/pdf' });

const project = { id: 'proj1', name: 'Test Project', customerId: 'cust1' } as any;
const customer = { id: 'cust2', name: 'Test Customer' } as any;

const renderModal = (initialFiles?: File[]) =>
  render(
    <ToastProvider>
      <UploadDocumentsModal
        open
        onClose={() => {}}
        onUploaded={() => {}}
        projects={[project]}
        customers={[customer]}
        customTypes={[]}
        initialFiles={initialFiles}
      />
    </ToastProvider>
  );

beforeEach(() => {
  saveBinaryFile.mockReset().mockResolvedValue({ fileId: 'f1' });
});

describe('UploadDocumentsModal', () => {
  it('opens dropped photos with the shared Type set to Photo, and uploads what the select shows', async () => {
    renderModal([png('a.png'), png('b.png')]);
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('photo');
    expect(screen.getByLabelText('Set type per file')).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /Upload \(2\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(2));
    expect(saveBinaryFile.mock.calls.map(c => c[2].kind)).toEqual(['photo', 'photo']);
  });

  it('follows the shared Type when it changes', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'document' } });

    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile.mock.calls[0][2]).toMatchObject({ kind: 'document' });
  });

  it('opens a mixed batch with per-file types guessed and the shared Type hidden', async () => {
    renderModal([pdf('plan.pdf'), png('site.png')]);
    expect(screen.getByLabelText('Set type per file')).toBeChecked();
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Type for plan.pdf') as HTMLSelectElement).value).toBe('document');
    expect((screen.getByLabelText('Type for site.png') as HTMLSelectElement).value).toBe('photo');

    fireEvent.click(screen.getByRole('button', { name: /Upload \(2\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(2));
    const kindOf = (n: string) => saveBinaryFile.mock.calls.find(c => (c[1] as File).name === n)![2].kind;
    expect(kindOf('plan.pdf')).toBe('document');
    expect(kindOf('site.png')).toBe('photo');
  });

  it('turning per-file types off shows the shared Type again and applies it to every file', async () => {
    renderModal([pdf('plan.pdf'), png('site.png')]);
    fireEvent.click(screen.getByLabelText('Set type per file'));
    expect(screen.queryByLabelText('Type for plan.pdf')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'other' } });

    fireEvent.click(screen.getByRole('button', { name: /Upload \(2\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(2));
    expect(saveBinaryFile.mock.calls.map(c => c[2].kind)).toEqual(['other', 'other']);
  });

  it('the per-file Type box takes a fixed width on wider screens instead of stretching across the row', () => {
    renderModal([pdf('plan.pdf'), png('site.png')]);
    const select = screen.getByLabelText('Type for plan.pdf');
    expect(select.parentElement).toHaveClass('sm:w-40', 'sm:shrink-0');
  });

  it('drops the succeeded chips after a partial failure so a retry cannot duplicate them', async () => {
    saveBinaryFile
      .mockResolvedValueOnce({ fileId: 'a' })
      .mockRejectedValueOnce(new Error('network'));
    renderModal([png('a.png'), png('b.png')]);

    fireEvent.click(screen.getByRole('button', { name: /Upload \(2\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(2));

    // Only the failure is left on screen — and in the batch.
    await waitFor(() => expect(screen.queryByText('a.png')).not.toBeInTheDocument());
    expect(screen.getByText('b.png')).toBeInTheDocument();

    saveBinaryFile.mockResolvedValue({ fileId: 'b' });
    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(3));
    expect((saveBinaryFile.mock.calls[2][1] as File).name).toBe('b.png');
  });

  it('selecting company-document disables the Project select and uploads carry no projectId', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj1' } });
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('proj1');

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'company-document' } });
    expect(screen.getByLabelText('Project')).toBeDisabled();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText("Company documents aren't tied to a project.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile.mock.calls[0][2]).toMatchObject({ kind: 'company-document' });
    expect(saveBinaryFile.mock.calls[0][2]).not.toHaveProperty('projectId');
  });

  it('selecting company-document disables and clears the Customer select and uploads carry no customerId', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'cust2' } });
    expect((screen.getByLabelText('Customer') as HTMLSelectElement).value).toBe('cust2');

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'company-document' } });
    expect(screen.getByLabelText('Customer')).toBeDisabled();
    expect((screen.getByLabelText('Customer') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText("Company documents aren't tied to a customer.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile.mock.calls[0][2]).toMatchObject({ kind: 'company-document' });
    expect(saveBinaryFile.mock.calls[0][2]).not.toHaveProperty('customerId');
  });

  it('re-enables the Customer select when the Type is changed away from company-document', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'company-document' } });
    expect(screen.getByLabelText('Customer')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'document' } });
    expect(screen.getByLabelText('Customer')).toBeEnabled();
  });

  it('gates projectId/customerId per entry when per-file typing mixes company-document with a project-tagged file', async () => {
    renderModal([png('shared.png'), png('company.png')]);
    fireEvent.click(screen.getByLabelText('Set type per file'));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj1' } });
    fireEvent.change(screen.getByLabelText('Type for company.png'), { target: { value: 'company-document' } });
    // Only one file opted into company-document — the batch isn't
    // company-document-only, so the Project select stays as the person set it.
    expect(screen.getByLabelText('Project')).toBeEnabled();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('proj1');

    fireEvent.click(screen.getByRole('button', { name: /Upload \(2\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(2));

    const shared = saveBinaryFile.mock.calls.find(c => (c[1] as File).name === 'shared.png')!;
    const company = saveBinaryFile.mock.calls.find(c => (c[1] as File).name === 'company.png')!;
    expect(shared[2]).toMatchObject({ kind: 'photo', projectId: 'proj1', customerId: 'cust1' });
    expect(company[2]).toMatchObject({ kind: 'company-document' });
    expect(company[2]).not.toHaveProperty('projectId');
    expect(company[2]).not.toHaveProperty('customerId');
  });

  it('re-enables the Project select when the Type is changed away from company-document', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'company-document' } });
    expect(screen.getByLabelText('Project')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'document' } });
    expect(screen.getByLabelText('Project')).toBeEnabled();
  });
});

describe('UploadDocumentsModal — remote items (mail attachments)', () => {
  const remoteItems = [
    { id: 'att1', name: 'invoice.pdf', size: 2048, mime: 'application/pdf' },
    { id: 'att2', name: 'site.jpg', size: 1048576, mime: 'image/jpeg' },
  ];

  const renderRemote = (onUploadRemote = vi.fn().mockResolvedValue({ ok: 2, total: 2 })) => {
    render(
      <ToastProvider>
        <UploadDocumentsModal
          open
          onClose={() => {}}
          onUploaded={() => {}}
          projects={[project]}
          customers={[customer]}
          customTypes={[]}
          remoteItems={remoteItems}
          onUploadRemote={onUploadRemote}
        />
      </ToastProvider>
    );
    return onUploadRemote;
  };

  it('seeds chips from remoteItems showing name + size, with no dropzone', () => {
    renderRemote();
    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('site.jpg')).toBeInTheDocument();
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
    expect(screen.queryByText('Drag files here or click to browse')).not.toBeInTheDocument();
    expect(screen.queryByText('+ Add more files')).not.toBeInTheDocument();
  });

  it('titles the modal and shows the mailbox-fetch footnote in remote mode', () => {
    renderRemote();
    expect(screen.getByText('Save attachments to Documents')).toBeInTheDocument();
    expect(screen.getByText('Files are fetched from your mailbox only when you confirm.')).toBeInTheDocument();
  });

  it('shows a Save N file(s) button instead of Upload', () => {
    renderRemote();
    expect(screen.getByRole('button', { name: 'Save 2 files' })).toBeInTheDocument();
  });

  it('opens a PDF + photo with per-file types guessed and the shared Type hidden', async () => {
    const onUploadRemote = renderRemote();
    expect(screen.getByLabelText('Set type per file')).toBeChecked();
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save 2 files' }));
    await waitFor(() => expect(onUploadRemote).toHaveBeenCalledTimes(1));
    expect(onUploadRemote.mock.calls[0][0].map((i: any) => i.kind)).toEqual(['document', 'photo']);
  });

  it('removing a chip and confirming calls onUploadRemote with only the remaining item + chosen kind/project', async () => {
    const onUploadRemote = renderRemote();
    fireEvent.click(screen.getByLabelText('Remove invoice.pdf'));
    expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Type for site.jpg'), { target: { value: 'photo' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save 1 file' }));
    await waitFor(() => expect(onUploadRemote).toHaveBeenCalledTimes(1));
    expect(onUploadRemote).toHaveBeenCalledWith([
      { id: 'att2', name: 'site.jpg', kind: 'photo', projectId: 'proj1', customerId: 'cust1' },
    ]);
  });

  it('does not call saveBinaryFile in remote mode', async () => {
    const onUploadRemote = renderRemote();
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 files' }));
    await waitFor(() => expect(onUploadRemote).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile).not.toHaveBeenCalled();
  });

  it('re-seeds entries to a narrower remoteItems array while staying open (partial-failure retry), keeping prior kind/project selections', async () => {
    let currentRemoteItems = remoteItems;
    const Wrapper: React.FC = () => {
      const [items, setItems] = React.useState(currentRemoteItems);
      const onUploadRemote = vi.fn().mockImplementation(async () => {
        setItems([remoteItems[1]]); // only att2 remains, as if att1 succeeded
        return { ok: 1, total: 2 };
      });
      (Wrapper as any).onUploadRemote = onUploadRemote;
      return (
        <ToastProvider>
          <UploadDocumentsModal
            open
            onClose={() => {}}
            onUploaded={() => {}}
            projects={[project]}
            customers={[customer]}
            customTypes={[]}
            remoteItems={items}
            onUploadRemote={onUploadRemote}
          />
        </ToastProvider>
      );
    };
    render(<Wrapper />);
    fireEvent.click(screen.getByLabelText('Set type per file')); // back to one shared Type
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'photo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 files' }));

    await waitFor(() => expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument());
    expect(screen.getByText('site.jpg')).toBeInTheDocument();
    // The Type selection made before the retry-narrowing is preserved.
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('photo');
  });

  it('preserves a manually-overridden per-file kind through a partial-failure retry-narrowing re-seed', async () => {
    // invoice.pdf's guess is 'document' (guessKind), so overriding it to
    // 'other' differs from what a fresh guess would produce — if the re-seed
    // recomputed the guess instead of carrying the pick forward, this would
    // revert to 'document'. The PDF + photo batch opens with per-file types on.
    const Wrapper: React.FC = () => {
      const [items, setItems] = React.useState(remoteItems);
      const onUploadRemote = vi.fn().mockImplementation(async () => {
        setItems([remoteItems[0]]); // only invoice.pdf survives, as if site.jpg succeeded
        return { ok: 1, total: 2 };
      });
      return (
        <ToastProvider>
          <UploadDocumentsModal
            open
            onClose={() => {}}
            onUploaded={() => {}}
            projects={[project]}
            customers={[customer]}
            customTypes={[]}
            remoteItems={items}
            onUploadRemote={onUploadRemote}
          />
        </ToastProvider>
      );
    };
    render(<Wrapper />);
    fireEvent.change(screen.getByLabelText('Type for invoice.pdf'), { target: { value: 'other' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save 2 files' }));

    await waitFor(() => expect(screen.queryByText('site.jpg')).not.toBeInTheDocument());
    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    expect((screen.getByLabelText('Type for invoice.pdf') as HTMLSelectElement).value).toBe('other');
  });
});

describe('guessKind', () => {
  it('recognises photos and spreadsheets by MIME type or extension; everything else is a document', () => {
    expect(guessKind('site.jpg', 'image/jpeg')).toBe('photo');
    expect(guessKind('IMG_0042.HEIC', 'application/octet-stream')).toBe('photo');
    expect(guessKind('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(guessKind('takeoff.csv', 'application/octet-stream')).toBe('spreadsheet');
    expect(guessKind('plans.pdf', 'application/pdf')).toBe('document');
    expect(guessKind('notes.txt', 'text/plain')).toBe('document');
    expect(guessKind('archive.zip', 'application/zip')).toBe('document');
  });
});
