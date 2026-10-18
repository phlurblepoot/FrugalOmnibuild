import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getDocuments = vi.fn();
const appendPdfPages = vi.fn();
vi.mock('../../utils/store', () => ({
  getDocuments: (...a: unknown[]) => getDocuments(...a),
  appendPdfPages: (...a: unknown[]) => appendPdfPages(...a),
}));

import { AppendPagesModal } from './AppendPagesModal';
import type { DocumentRow } from '../../utils/store';

const row = (id: string, name: string): DocumentRow => ({
  id, name, mime: 'application/pdf', size: 1, kind: 'document', createdAt: 1, versionNumber: 1,
  archived: false, projectId: 'p1', projectName: 'P', customerId: null, customerName: null, source: null,
});
const target = row('t', 'target.pdf');

beforeEach(() => {
  getDocuments.mockReset(); appendPdfPages.mockReset();
  getDocuments.mockResolvedValue({ rows: [target, row('a', 'a.pdf'), row('b', 'b.pdf')], total: 3 });
  appendPdfPages.mockResolvedValue({ fileId: 't', versionNumber: 2 });
});

describe('AppendPagesModal', () => {
  it('lists other PDFs, sends picked ones with pages and the chosen position', async () => {
    const onDone = vi.fn(); const onClose = vi.fn();
    render(<AppendPagesModal open target={target} onClose={onClose} onDone={onDone} />);
    await screen.findByText('a.pdf');
    expect(screen.queryByText('target.pdf', { selector: 'span' })).toBeNull();
    expect(screen.getByTestId('append-pages-save')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Add pages from b.pdf'));
    fireEvent.change(screen.getByLabelText('Pages of b.pdf'), { target: { value: '1-2' } });
    fireEvent.click(screen.getByLabelText('Add pages from a.pdf'));
    fireEvent.change(screen.getByTestId('append-pages-where'), { target: { value: 'after' } });
    fireEvent.change(screen.getByTestId('append-pages-after'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('append-pages-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(target));
    expect(appendPdfPages).toHaveBeenCalledWith(
      't', [{ id: 'b', pages: '1-2' }, { id: 'a', pages: '' }], { afterPage: 3 },
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server error and stays open', async () => {
    appendPdfPages.mockRejectedValue(new Error('Page 9 is not in the PDF (it has 2)'));
    const onClose = vi.fn();
    render(<AppendPagesModal open target={target} onClose={onClose} onDone={vi.fn()} />);
    await screen.findByText('a.pdf');
    fireEvent.click(screen.getByLabelText('Add pages from a.pdf'));
    fireEvent.click(screen.getByTestId('append-pages-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Page 9');
    expect(onClose).not.toHaveBeenCalled();
  });
});
