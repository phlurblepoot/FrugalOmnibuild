// src/pages/documents/DocumentsBulkBar.test.tsx
// The bulk bar is presentation over documentsPolicy; this pins the "Change
// type" control: its count reflects only the re-typeable subset of the
// selection, it's disabled when that subset is empty, and the handler is
// handed ONLY the re-typeable rows (a system-kind row is never sent — the
// server would 409 it).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentsBulkBar } from './DocumentsBulkBar';
import type { DocumentRow } from '../../utils/store';

const row = (over: Partial<DocumentRow>): DocumentRow => ({
  id: 'r1', name: 'file.pdf', mime: 'application/pdf', size: 100, kind: 'document',
  createdAt: 1, versionNumber: 1, archived: false,
  projectId: null, projectName: null, customerId: null, customerName: null, source: null,
  ...over,
});

const docA = row({ id: 'a', name: 'a.pdf', kind: 'document' });
const docB = row({ id: 'b', name: 'b.jpg', kind: 'photo' });
const invoice = row({ id: 'inv', name: 'inv.pdf', kind: 'invoice', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } });

const renderBar = (selected: DocumentRow[], customTypes: { id: string; label: string }[] = []) => {
  const props = {
    selected,
    customTypes,
    archivedView: false,
    onClear: vi.fn(),
    onDownload: vi.fn(async () => {}),
    onArchive: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onChangeKind: vi.fn(async () => {}),
    onShare: vi.fn(),
  };
  render(<DocumentsBulkBar {...props} />);
  return props;
};

describe('DocumentsBulkBar change type', () => {
  it('shows "Change type (2 of 3)" and hands the handler only the re-typeable rows', async () => {
    const { onChangeKind } = renderBar([docA, docB, invoice]);
    const btn = screen.getByRole('button', { name: 'Change type (2 of 3)' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spreadsheet' }));
    expect(onChangeKind).toHaveBeenCalledTimes(1);
    expect(onChangeKind).toHaveBeenCalledWith([docA, docB], 'spreadsheet');
  });

  it('lists the direct-upload kinds plus custom types as options', () => {
    renderBar([docA], [{ id: 'warranty', label: 'Warranty' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Change type (1 of 1)' }));
    for (const label of ['Document', 'Spreadsheet', 'Photo', 'Other', 'Company Document', 'Warranty']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('menuitem', { name: 'Invoice' })).toBeNull();
  });

  it('is disabled when nothing selected is re-typeable', () => {
    const { onChangeKind } = renderBar([invoice]);
    const btn = screen.getByRole('button', { name: 'Change type (0 of 1)' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(screen.queryByRole('menuitem', { name: 'Document' })).toBeNull();
    expect(onChangeKind).not.toHaveBeenCalled();
  });
});

describe('DocumentsBulkBar share (ONLYOFFICE Phase 7)', () => {
  it('shares the whole selection under one link, whatever kinds it holds', () => {
    const { onShare } = renderBar([docA, docB, invoice]);
    fireEvent.click(screen.getByTestId('documents-bulk-share'));
    expect(onShare).toHaveBeenCalledWith([docA, docB, invoice]);
  });

  it('stops at fifty documents in one link', () => {
    renderBar(Array.from({ length: 51 }, (_, i) => row({ id: `r${i}` })));
    expect(screen.getByTestId('documents-bulk-share')).toBeDisabled();
    expect(screen.getByTestId('documents-bulk-share')).toHaveAttribute('title', 'Share up to 50 documents in one link');
  });
});

describe('DocumentsBulkBar merge PDFs', () => {
  const pdf1 = row({ id: 'p1', name: 'one.pdf' });
  const pdf2 = row({ id: 'p2', name: 'two.pdf' });
  const img = row({ id: 'im', name: 'x.jpg', mime: 'image/jpeg', kind: 'photo' });

  it('hands the handler only the selected PDFs', () => {
    const onMergePdfs = vi.fn(async () => {});
    render(
      <DocumentsBulkBar
        selected={[pdf1, img, pdf2]} customTypes={[]} archivedView={false}
        onClear={vi.fn()} onDownload={vi.fn()} onArchive={vi.fn()} onChangeKind={vi.fn()}
        onDelete={vi.fn()} onMergePdfs={onMergePdfs}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Merge PDFs (2)' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onMergePdfs).toHaveBeenCalledWith([pdf1, pdf2]);
  });

  it('is disabled with fewer than two PDFs selected', () => {
    render(
      <DocumentsBulkBar
        selected={[pdf1, img]} customTypes={[]} archivedView={false}
        onClear={vi.fn()} onDownload={vi.fn()} onArchive={vi.fn()} onChangeKind={vi.fn()}
        onDelete={vi.fn()} onMergePdfs={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Merge PDFs (1)' })).toBeDisabled();
  });
});

describe('DocumentsBulkBar append pages', () => {
  const renderAppend = (selected: DocumentRow[]) => {
    const onAppendPages = vi.fn();
    render(
      <DocumentsBulkBar
        selected={selected} customTypes={[]} archivedView={false} onClear={vi.fn()}
        onDownload={vi.fn(async () => {})} onArchive={vi.fn(async () => {})}
        onChangeKind={vi.fn(async () => {})} onDelete={vi.fn(async () => {})}
        onAppendPages={onAppendPages}
      />,
    );
    return onAppendPages;
  };

  it('opens Append pages for exactly one selected PDF', () => {
    const onAppendPages = renderAppend([docA]);
    fireEvent.click(screen.getByTestId('documents-bulk-append'));
    expect(onAppendPages).toHaveBeenCalledWith(docA);
  });

  it('is disabled for two rows or a non-PDF', () => {
    renderAppend([docA, invoice]);
    expect(screen.getByTestId('documents-bulk-append')).toBeDisabled();
  });
});
