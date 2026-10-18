// src/pages/project/punch/PunchItemEditor.test.tsx
// Punch photos are staged (before / during / after) and each stage is its own
// card, so what matters is that a photo lands on the stage it was added from —
// through the shared picker or a drag-drop
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PunchItem } from '../../../utils/store';

const h = vi.hoisted(() => ({
  addPunchPhoto: vi.fn(),
  removePunchPhoto: vi.fn(),
  uploadProjectFile: vi.fn(),
  pickerProps: { last: null as any },
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  addPunchPhoto: h.addPunchPhoto,
  removePunchPhoto: h.removePunchPhoto,
  uploadProjectFile: h.uploadProjectFile,
  getImageUrl: (id: string) => `/img/${id}`,
}));

// Stand-in picker: records the config the editor asked for and hands back one
// already-uploaded row on demand.
vi.mock('../../../components/FilePickerModal', () => ({
  FilePickerModal: (props: any) => {
    h.pickerProps.last = props;
    return (
      <div data-testid="picker">
        <button data-testid="picker-pick" onClick={() => void props.onPick?.([{ id: 'up-1', name: 'shot.png' }])}>pick</button>
      </div>
    );
  },
}));

import { ToastProvider } from '../../../components/Toast';
import { PunchItemEditor } from './PunchItemEditor';

const item = (over: Partial<PunchItem> = {}): PunchItem => ({
  id: 'pi-1', projectId: 'p1', area: 'Kitchen', description: 'Patch ceiling',
  done: false, sortOrder: 0, version: 1, createdAt: 1, photos: [],
  ...over,
} as PunchItem);

const onSaved = vi.fn();

const mount = (it: PunchItem = item()) => render(
  <ToastProvider>
    <PunchItemEditor item={it} projectId="p1" onClose={vi.fn()} onSaved={onSaved} />
  </ToastProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.pickerProps.last = null;
  h.addPunchPhoto.mockResolvedValue(undefined);
  h.uploadProjectFile.mockResolvedValue({ fileId: 'up-photo', versioned: false });
});

describe('PunchItemEditor photo cards', () => {
  it('gives every stage its own picker button and no bare file input', () => {
    mount();
    expect(screen.getAllByRole('button', { name: /Add photos/i })).toHaveLength(3);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it('adds a picked photo to the stage it was picked from', async () => {
    mount();
    // Index 1 = the "During" stage.
    fireEvent.click(screen.getAllByRole('button', { name: /Add photos/i })[1]);
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addPunchPhoto).toHaveBeenCalledWith('pi-1', 'up-1', 'during'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({
      accept: 'image', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'punch-photo', projectId: 'p1', sourceType: 'punch', sourceId: 'pi-1' },
    });
  });

  it('uploads a photo dropped on a stage, links it to that stage, then reloads', async () => {
    mount();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('punch-after-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'punch-photo', { sourceType: 'punch', sourceId: 'pi-1' },
    ));
    await waitFor(() => expect(h.addPunchPhoto).toHaveBeenCalledWith('pi-1', 'up-photo', 'after'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows each stage its own photos', () => {
    mount(item({ photos: [
      { id: 'ph-1', fileId: 'f-1', stage: 'before', sortOrder: 0 },
      { id: 'ph-2', fileId: 'f-2', stage: 'after', sortOrder: 0 },
    ] } as Partial<PunchItem>));
    expect(screen.getByTestId('punch-before-photo-dropzone').querySelectorAll('img')).toHaveLength(1);
    expect(screen.getByTestId('punch-during-photo-dropzone').querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByTestId('punch-after-photo-dropzone').querySelectorAll('img')).toHaveLength(1);
  });
});
