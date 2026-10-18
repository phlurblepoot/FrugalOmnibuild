// src/components/AddPagesModal.test.tsx
//
// Adding a revision to a plan set has always meant browsing the local disk for
// the PDF. A set that was already filed under Documents (a printout, an
// emailed revision) can now be pulled straight in — the picker hands back the
// bytes and the split pipeline downstream never learns the difference
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Project } from '../types';

const h = vi.hoisted(() => ({ pickers: new Map<string, any>() }));

vi.mock('./documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickers.set(props.label, props);
    return <button data-testid={`picker-${props.label}`}>{props.label}</button>;
  },
}));

import { AddPagesModal } from './AddPagesModal';

const project = { id: 'p1', name: 'Test', planSets: [] } as unknown as Project;

const Harness: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [planSetName, setPlanSetName] = useState('');
  return (
    <AddPagesModal
      open
      onClose={() => {}}
      project={project}
      addPagesStep="details"
      isNamingExistingPages={false}
      newPlanSetName={planSetName}
      setNewPlanSetName={setPlanSetName}
      newPlanSetDate="2026-08-29"
      setNewPlanSetDate={() => {}}
      newPlanSetFiles={files}
      setNewPlanSetFiles={setFiles}
      removeNewPlanSetFile={i => setFiles(prev => prev.filter((_, n) => n !== i))}
      useExistingPlanSet={false}
      setUseExistingPlanSet={() => {}}
      targetPlanSetId=""
      setTargetPlanSetId={() => {}}
      pendingPages={[]}
      setPendingPages={() => {}}
      pendingThumbnails={{}}
      isAddingPages={false}
      addProgress={{ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 }}
      fileInputRef={React.createRef<HTMLInputElement>()}
      onAddPages={() => {}}
      onConfirmAddPages={() => {}}
    />
  );
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1', name: 'A-100 Rev 2.pdf', mime: 'application/pdf', size: 10,
  kind: 'other', createdAt: 0, versionNumber: 1, archived: false,
  projectId: 'p1', projectName: 'Test', customerId: null, customerName: null, source: null,
  ...over,
});

beforeEach(() => { h.pickers.clear(); });

describe('AddPagesModal — pick an existing document', () => {
  it('offers a documents picker alongside the native file input', () => {
    render(<Harness />);
    const props = h.pickers.get('Choose from documents');
    expect(props).toBeTruthy();
    expect(props.accept).toBe('pdf');
    expect(props.returnBlobs).toBe(true);
    // Scoped to this project by default — but the picker lets you widen it.
    expect(props.initialProjectIds).toEqual(['p1']);
    // The native input stays: uploading a brand-new set is still the main path.
    expect(screen.getByTestId('picker-Choose from documents')).toBeInTheDocument();
  });

  it('a picked document becomes a File in the pending plan-set list', async () => {
    render(<Harness />);
    const props = h.pickers.get('Choose from documents');
    await act(async () => {
      await props.onPickBlobs([{ row: row(), blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }) }]);
    });
    expect(screen.getByTitle('A-100 Rev 2.pdf')).toBeInTheDocument();
    // ...and it seeds the plan-set name the same way choosing from disk does.
    expect(screen.getByDisplayValue('A-100 Rev 2')).toBeInTheDocument();
  });

  it('falls back to a filename when the document row has none', async () => {
    render(<Harness />);
    const props = h.pickers.get('Choose from documents');
    await act(async () => {
      await props.onPickBlobs([{ row: row({ name: null }), blob: new Blob(['%PDF-1.4']) }]);
    });
    expect(screen.getByTitle('plan.pdf')).toBeInTheDocument();
  });
});
