// src/pages/settings/DocumentTemplatesTab.test.tsx — Settings → Document
// Templates: templates (upload, letterhead, rename keeping the extension,
// open in the editor, delete) and company stamps.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { DocumentTemplatesTab } from './DocumentTemplatesTab';

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  listDocumentTemplates: vi.fn(), uploadDocumentTemplate: vi.fn(), addLetterheadTemplate: vi.fn(),
  renameDocumentTemplate: vi.fn(), deleteDocumentTemplate: vi.fn(),
  listCompanyStamps: vi.fn(), uploadCompanyStamp: vi.fn(), renameCompanyStamp: vi.fn(), deleteCompanyStamp: vi.fn(),
}));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock('../../utils/store', async (orig) => {
  const { toast: _t, ...store } = h;
  return { ...(await orig<typeof import('../../utils/store')>()), ...store };
});

const item = (id: string, name: string, ext?: string) => ({ id, name, ext, mime: 'x', size: 1, createdAt: 1, createdBy: 'u1' });
const Editor: React.FC = () => <div data-testid="editor">{useLocation().search}</div>;
const renderTab = () => render(
  <MemoryRouter initialEntries={['/settings']}>
    <ConfirmProvider>
      <Routes>
        <Route path="/settings" element={<DocumentTemplatesTab />} />
        <Route path="/tools/edit" element={<Editor />} />
      </Routes>
    </ConfirmProvider>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  h.listDocumentTemplates.mockResolvedValue([item('t1', 'Proposal.docx', 'docx')]);
  h.listCompanyStamps.mockResolvedValue([item('s1', 'APPROVED')]);
  for (const fn of [h.uploadDocumentTemplate, h.addLetterheadTemplate, h.renameDocumentTemplate, h.deleteDocumentTemplate, h.renameCompanyStamp, h.deleteCompanyStamp]) {
    fn.mockResolvedValue({});
  }
});

describe('DocumentTemplatesTab', () => {
  it('lists templates and stamps', async () => {
    renderTab();
    expect(await screen.findByText('Proposal.docx')).toBeInTheDocument();
    expect(screen.getByText('Word document')).toBeInTheDocument();
    expect(screen.getByAltText('APPROVED')).toHaveAttribute('src', '/api/images/s1/raw');
  });

  it('uploads a template', async () => {
    renderTab();
    await screen.findByText('Proposal.docx');
    const file = new File(['x'], 'Invoice.xlsx');
    fireEvent.change(screen.getByTestId('templates-upload-input'), { target: { files: [file] } });
    await waitFor(() => expect(h.uploadDocumentTemplate).toHaveBeenCalledWith(file));
    expect(h.listDocumentTemplates).toHaveBeenCalledTimes(2);
  });

  it('offers the company letterhead until it has been added', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('templates-add-letterhead'));
    await waitFor(() => expect(h.addLetterheadTemplate).toHaveBeenCalled());

    h.listDocumentTemplates.mockResolvedValue([item('t2', 'Letterhead.docx', 'docx')]);
    renderTab();
    await screen.findByText('Letterhead.docx');
    expect(screen.queryAllByTestId('templates-add-letterhead')).toHaveLength(1); // only the first render's
  });

  it('renames a template, keeping its extension', async () => {
    renderTab();
    await screen.findByText('Proposal.docx');
    fireEvent.click(screen.getByTestId('template-rename'));
    expect(screen.getByTestId('template-name-input')).toHaveValue('Proposal');
    expect(screen.getByText('.docx')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('template-name-input'), { target: { value: 'Bid proposal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.renameDocumentTemplate).toHaveBeenCalledWith('t1', 'Bid proposal'));
  });

  it('opens a template in the editor', async () => {
    renderTab();
    await screen.findByText('Proposal.docx');
    fireEvent.click(screen.getByRole('button', { name: /Open in editor/ }));
    expect(await screen.findByTestId('editor')).toHaveTextContent('?fileId=t1');
  });

  it('deletes a template and a stamp after a confirm', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Proposal.docx' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.deleteDocumentTemplate).toHaveBeenCalledWith('t1'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete APPROVED' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.deleteCompanyStamp).toHaveBeenCalledWith('s1'));
  });
});
