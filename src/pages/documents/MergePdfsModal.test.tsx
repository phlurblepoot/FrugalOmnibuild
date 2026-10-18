import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mergePdfFiles = vi.fn();
vi.mock('../../utils/store', () => ({
  mergePdfFiles: (...a: unknown[]) => mergePdfFiles(...a),
}));

import { MergePdfsModal } from './MergePdfsModal';
import type { DocumentRow } from '../../utils/store';

const row = (id: string, name: string, projectId: string | null, projectName: string | null): DocumentRow => ({
  id, name, mime: 'application/pdf', size: 1, kind: 'document', createdAt: 1, versionNumber: 1,
  archived: false, projectId, projectName, customerId: null, customerName: null, source: null,
});

beforeEach(() => {
  mergePdfFiles.mockReset();
  mergePdfFiles.mockResolvedValue({ fileId: 'n', name: 'x.pdf' });
});

describe('MergePdfsModal', () => {
  it('defaults the name, reorders, and sends ids in order (no project picker for one project)', async () => {
    const onDone = vi.fn(); const onClose = vi.fn();
    render(<MergePdfsModal open rows={[row('a', 'a.pdf', 'p1', 'P1'), row('b', 'b.pdf', 'p1', 'P1')]} onClose={onClose} onDone={onDone} />);
    expect(screen.getByTestId('merge-pdfs-name')).toHaveValue('a (merged)');
    expect(screen.queryByTestId('merge-pdfs-project')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move a.pdf down' }));
    expect(screen.getByTestId('merge-pdfs-name')).toHaveValue('b (merged)');
    fireEvent.click(screen.getByTestId('merge-pdfs-save'));
    await waitFor(() => expect(mergePdfFiles).toHaveBeenCalledWith(['b', 'a'], 'b (merged)', undefined));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalledWith(2, 'x.pdf');
  });

  it('asks for the project when the PDFs span projects', async () => {
    render(<MergePdfsModal open rows={[row('a', 'a.pdf', 'p1', 'P1'), row('b', 'b.pdf', 'p2', 'P2')]} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByTestId('merge-pdfs-project'), { target: { value: 'p2' } });
    fireEvent.change(screen.getByTestId('merge-pdfs-name'), { target: { value: 'Combined' } });
    fireEvent.click(screen.getByTestId('merge-pdfs-save'));
    await waitFor(() => expect(mergePdfFiles).toHaveBeenCalledWith(['a', 'b'], 'Combined', 'p2'));
  });
});
