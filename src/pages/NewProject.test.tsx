// src/pages/NewProject.test.tsx
//
// Starting a project from a plan set that is already filed under Documents —
// the same picker the rest of the app uses, sitting beside the disk upload
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';

const h = vi.hoisted(() => ({ pickers: new Map<string, any>() }));

vi.mock('../components/documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickers.set(props.label, props);
    return <button data-testid={`picker-${props.label}`}>{props.label}</button>;
  },
}));
vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  getCustomers: vi.fn(async () => []),
}));

import { NewProject } from './NewProject';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1', name: 'Dunmore Heights.pdf', mime: 'application/pdf', size: 10,
  kind: 'other', createdAt: 0, versionNumber: 1, archived: false,
  projectId: null, projectName: null, customerId: null, customerName: null, source: null,
  ...over,
});

const mount = () => render(
  <MemoryRouter>
    <ToastProvider><NewProject /></ToastProvider>
  </MemoryRouter>
);

beforeEach(() => { h.pickers.clear(); });

describe('NewProject — pick an existing document', () => {
  it('offers an unscoped documents picker for PDFs', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Choose from documents');
    expect(props).toBeTruthy();
    expect(props.accept).toBe('pdf');
    expect(props.returnBlobs).toBe(true);
    // No project exists yet, so nothing to scope the picker to.
    expect(props.initialProjectIds).toBeUndefined();
  });

  it('a picked document becomes a File in the pending upload list and seeds the name', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Choose from documents');
    await act(async () => {
      await props.onPickBlobs([{ row: row(), blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }) }]);
    });
    expect(screen.getByTitle('Dunmore Heights.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Project Name')).toHaveValue('Dunmore Heights');
  });
});
