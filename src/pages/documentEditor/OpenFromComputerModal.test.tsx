// "Open from computer" files the upload into a project before the editor opens
// it (decision 2026-09-25), so the tests pin that: a project is required, the
// upload carries the project and its customer, and non-editor files are
// turned away before anything is uploaded.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ getProjectsSummary: vi.fn(), getDocumentTypes: vi.fn(), saveBinaryFile: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../utils/store', async (orig) => ({ ...(await orig<typeof import('../../utils/store')>()), ...h }));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast }) }));
import { OpenFromComputerModal } from './OpenFromComputerModal';

const project = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, customerId: `c-${id}`, archived: false, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  h.getProjectsSummary.mockResolvedValue([project('p1', 'Dunmore Heights'), project('p2', 'Old job', { archived: true })]);
  h.getDocumentTypes.mockResolvedValue([{ id: 'sub', label: 'Subcontract' }]);
  h.saveBinaryFile.mockResolvedValue({ fileId: 'stored-id', versioned: false });
});

const choose = (file: File) => fireEvent.change(screen.getByTestId('open-computer-input'), { target: { files: [file] } });

describe('OpenFromComputerModal', () => {
  it('uploads into the chosen project (with its customer) and hands back the stored id', async () => {
    const onUploaded = vi.fn();
    render(<OpenFromComputerModal open onClose={() => {}} onUploaded={onUploaded} />);
    const upload = screen.getByTestId('open-computer-upload');
    const file = new File(['x'], 'Scope.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    choose(file);
    expect(screen.getByTestId('open-computer-filename')).toHaveTextContent('Scope.docx');
    expect(upload).toBeDisabled(); // no project yet

    await screen.findByRole('option', { name: 'Dunmore Heights' });
    expect(screen.queryByRole('option', { name: 'Old job' })).toBeNull(); // archived projects aren't offered
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'custom:sub' } });
    fireEvent.click(upload);

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('stored-id'));
    expect(h.saveBinaryFile).toHaveBeenCalledWith(expect.any(String), file, {
      kind: 'custom:sub', name: 'Scope.docx', projectId: 'p1', customerId: 'c-p1',
    });
  });

  it('takes old formats the upload converts (Pages, .xls…), and passes on what happened', async () => {
    h.saveBinaryFile.mockResolvedValue({
      fileId: 'stored-id', versioned: false,
      conversion: { status: 'converted', from: 'pages', to: 'docx', name: 'Spec.docx' },
    });
    const onUploaded = vi.fn();
    render(<OpenFromComputerModal open onClose={() => {}} onUploaded={onUploaded} />);
    choose(new File(['x'], 'Spec.pages', { type: '' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await screen.findByRole('option', { name: 'Dunmore Heights' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByTestId('open-computer-upload'));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('stored-id'));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('"Spec.pages" was converted to .docx'), { type: 'info' });
    expect(screen.getByTestId('open-computer-input')).toHaveAttribute('accept', expect.stringContaining('.pages'));
  });

  it('guesses the type from the file', async () => {
    render(<OpenFromComputerModal open onClose={() => {}} onUploaded={() => {}} />);
    choose(new File(['x'], 'SOV.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    expect(screen.getByLabelText('Type')).toHaveValue('spreadsheet');
  });

  it('turns away files the editor cannot open, before uploading anything', () => {
    render(<OpenFromComputerModal open onClose={() => {}} onUploaded={() => {}} />);
    choose(new File(['x'], 'site.png', { type: 'image/png' }));
    expect(screen.getByRole('alert')).toHaveTextContent("isn't a file the editor opens");
    expect(screen.getByTestId('open-computer-filename')).toHaveTextContent('No file chosen');
    expect(h.saveBinaryFile).not.toHaveBeenCalled();
  });

  it('shows the upload error and lets the person try again', async () => {
    h.saveBinaryFile.mockRejectedValue(new Error('File too large'));
    render(<OpenFromComputerModal open onClose={() => {}} onUploaded={() => {}} />);
    choose(new File(['x'], 'Bid.pdf', { type: 'application/pdf' }));
    await screen.findByRole('option', { name: 'Dunmore Heights' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByTestId('open-computer-upload'));
    expect(await screen.findByRole('alert')).toHaveTextContent('File too large');
    expect(screen.getByTestId('open-computer-upload')).not.toBeDisabled();
  });
});
