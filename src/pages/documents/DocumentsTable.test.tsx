// src/pages/documents/DocumentsTable.test.tsx
// Layout guard for the desktop table: a long unbreakable file name used to
// force the Name column as wide as the name, overflow the wrapper and push
// every column past the second off-screen (reported in production). The fix
// is a fixed table layout with bounded, truncating cells — this pins the
// classes that make truncation actually take effect.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DocumentsTable } from './DocumentsTable';
import type { DocumentRow } from '../../utils/store';

vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'sock-1' }),
}));

const LONG_NAME = `${'a'.repeat(200)}.pdf`;

const row = (over: Partial<DocumentRow>): DocumentRow => ({
  id: 'r1', name: 'file.pdf', mime: 'application/pdf', size: 100, kind: 'document',
  createdAt: 1, versionNumber: 1, archived: false,
  projectId: null, projectName: null, customerId: null, customerName: null, source: null,
  ...over,
});

const renderTable = (rows: DocumentRow[]) => render(
  <MemoryRouter>
    <DocumentsTable
      rows={rows}
      customTypes={[]}
      selected={new Set()}
      onToggleRow={() => {}}
      onToggleAll={() => {}}
      onArchiveRows={async () => {}}
      onDeleteRows={async () => {}}
      onChangeKind={async () => {}}
    />
  </MemoryRouter>
);

describe('DocumentsTable layout', () => {
  it('uses a fixed table layout so column widths do not follow content', () => {
    const { container } = renderTable([row({ name: LONG_NAME })]);
    const table = container.querySelector('table')!;
    expect(table).toBeTruthy();
    expect(table.className.split(/\s+/)).toContain('table-fixed');
  });

  it('truncates the name inside a bounded cell and keeps the full name in title', () => {
    const { container } = renderTable([row({ name: LONG_NAME })]);
    const table = container.querySelector('table')!;
    const nameSpan = table.querySelector(`span[title="${LONG_NAME}"]`) as HTMLElement | null;
    expect(nameSpan).toBeTruthy();
    expect(nameSpan!.textContent).toBe(LONG_NAME);
    expect(nameSpan!.className.split(/\s+/)).toContain('truncate');
    // CSS truncation needs every flex ancestor up to the cell to be allowed
    // to shrink below its content width.
    const flexWrap = nameSpan!.parentElement!;
    expect(flexWrap.className.split(/\s+/)).toContain('min-w-0');
  });

  it('truncates the project and source cells too, with the full text in title', () => {
    const longProject = `Project ${'x'.repeat(120)}`;
    const longSource = `Invoice ${'y'.repeat(120)}`;
    const { container } = renderTable([row({
      name: 'ok.pdf',
      projectName: longProject,
      kind: 'invoice',
      source: { type: 'invoice', id: 'i1', label: longSource, href: '/project/p1/billing?tab=invoices' },
    })]);
    const table = container.querySelector('table')!;
    const project = table.querySelector(`[title="${longProject}"]`) as HTMLElement | null;
    expect(project).toBeTruthy();
    expect(project!.className.split(/\s+/)).toContain('truncate');
    const source = table.querySelector(`a[title="${longSource}"]`) as HTMLAnchorElement | null;
    expect(source).toBeTruthy();
    expect(source!.getAttribute('href')).toBe('/project/p1/billing?tab=invoices');
    expect(source!.className.split(/\s+/)).toContain('truncate');
  });
});
