// src/pages/documents/NewDocumentModal.test.tsx — "New document": pick a type,
// a blank or a template of that type, a name, a document type and a project,
// then it is created and opens in the editor.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { NewDocumentModal } from './NewDocumentModal';

const h = vi.hoisted(() => ({
  createNewDocument: vi.fn(),
  listDocumentTemplates: vi.fn(),
  getProjectsSummary: vi.fn(),
  getDocumentTypes: vi.fn(),
}));
vi.mock('../../utils/store', async (orig) => ({ ...(await orig<typeof import('../../utils/store')>()), ...h }));

const Editor: React.FC = () => <div data-testid="editor">{useLocation().search}</div>;
const renderModal = (props: Partial<React.ComponentProps<typeof NewDocumentModal>> = {}) => {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/documents']}>
      <Routes>
        <Route path="/documents" element={<NewDocumentModal open onClose={onClose} {...props} />} />
        <Route path="/tools/edit" element={<Editor />} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createNewDocument.mockResolvedValue({ fileId: 'new-1', name: 'Letter.docx' });
  h.listDocumentTemplates.mockResolvedValue([
    { id: 't-letter', name: 'Letterhead.docx', ext: 'docx', mime: 'x', size: 1, createdAt: 1, createdBy: null },
    { id: 't-sheet', name: 'Estimate.xlsx', ext: 'xlsx', mime: 'x', size: 1, createdAt: 1, createdBy: null },
  ]);
  h.getProjectsSummary.mockResolvedValue([
    { id: 'p1', name: 'Maple', archived: false }, { id: 'p2', name: 'Oak', archived: false }, { id: 'p3', name: 'Old', archived: true },
  ]);
  h.getDocumentTypes.mockResolvedValue([{ id: 'sub', label: 'Submittal' }]);
});

const templateOptions = () => [...(screen.getByLabelText('Start from') as HTMLSelectElement).options].map(o => o.text);

describe('NewDocumentModal', () => {
  it('offers only the templates of the chosen type, and follows the type with the document type', async () => {
    renderModal();
    await waitFor(() => expect(templateOptions()).toEqual(['Blank', 'Letterhead.docx']));
    expect(screen.getByLabelText('Document type')).toHaveValue('document');

    fireEvent.click(screen.getByRole('radio', { name: /Excel spreadsheet/ }));
    expect(templateOptions()).toEqual(['Blank', 'Estimate.xlsx']);
    expect(screen.getByLabelText('Document type')).toHaveValue('spreadsheet');
    fireEvent.click(screen.getByRole('radio', { name: /PDF form/ }));
    expect(templateOptions()).toEqual(['Blank']);
  });

  it('needs a project, lists only open ones, and creates then opens the editor', async () => {
    const { onClose } = renderModal();
    await waitFor(() => expect(screen.getByLabelText('Project').querySelectorAll('option')).toHaveLength(3)); // choose + 2 open
    expect(screen.getByTestId('new-document-create')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 't-letter' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Site letter' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p2' } });
    fireEvent.change(screen.getByLabelText('Document type'), { target: { value: 'custom:sub' } });
    fireEvent.click(screen.getByTestId('new-document-create'));

    await waitFor(() => expect(h.createNewDocument).toHaveBeenCalledWith({
      type: 'docx', templateId: 't-letter', name: 'Site letter', projectId: 'p2', kind: 'custom:sub',
    }));
    expect(await screen.findByTestId('editor')).toHaveTextContent('?fileId=new-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('starts on the type and project it was opened with', async () => {
    renderModal({ initialType: 'xlsx', initialProjectId: 'p1' });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('p1'));
    expect(screen.getByRole('radio', { name: /Excel spreadsheet/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('new-document-create'));
    await waitFor(() => expect(h.createNewDocument).toHaveBeenCalledWith({ type: 'xlsx', name: 'Untitled', kind: 'spreadsheet', projectId: 'p1' }));
  });

  it('files a company document in no project', async () => {
    renderModal();
    await waitFor(() => expect(templateOptions()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Document type'), { target: { value: 'company-document' } });
    expect(screen.getByLabelText('Project')).toBeDisabled();
    fireEvent.click(screen.getByTestId('new-document-create'));
    await waitFor(() => expect(h.createNewDocument).toHaveBeenCalledWith({ type: 'docx', name: 'Untitled', kind: 'company-document' }));
  });

  it('shows why creating failed and stays open', async () => {
    h.createNewDocument.mockRejectedValue(new Error('That template no longer exists.'));
    renderModal({ initialProjectId: 'p1' });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('p1'));
    fireEvent.click(screen.getByTestId('new-document-create'));
    expect(await screen.findByRole('alert')).toHaveTextContent('That template no longer exists.');
    expect(screen.queryByTestId('editor')).toBeNull();
  });
});
