// src/components/documents/PhotoDropCard.test.tsx
// The card every photo grid in the app now mounts: one AddFilesButton plus a
// drop target, wired to whatever "link this file to my record" call the owner
// passes in (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../Toast';

const h = vi.hoisted(() => ({ props: null as any }));

// Stand-in button: records the picker config it was handed and hands back two
// already-uploaded rows on click (which is what the real picker's Upload tab
// does once it has stored the files).
vi.mock('./AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.props = props;
    return (
      <button
        data-testid="add-files-button"
        disabled={props.disabled}
        title={props.title}
        onClick={() => void props.onPick([{ id: 'row-1', name: 'a.png' }, { id: 'row-2', name: 'b.png' }])}
      >
        {props.label}
      </button>
    );
  },
}));

vi.mock('../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../utils/store')>()),
  uploadProjectFile: vi.fn(async () => ({ fileId: 'up-1', versioned: false })),
  saveBinaryFile: vi.fn(async () => ({ fileId: 'saved-1' })),
  getImageUrl: (id: string) => `/img/${id}`,
}));

import { uploadProjectFile, saveBinaryFile } from '../../utils/store';
import { PhotoDropCard } from './PhotoDropCard';

const png = (name: string) => new File(['x'], name, { type: 'image/png' });

const link = vi.fn(async (_fileId: string) => {});
const onDone = vi.fn();
const onRemove = vi.fn();

const renderCard = (over: Record<string, unknown> = {}) =>
  render(
    <ToastProvider>
      <PhotoDropCard
        title="Photos"
        emptyText="No photos."
        testId="issue"
        photos={[{ id: 'ph-1', fileId: 'f-1' }]}
        upload={{ kind: 'issue-photo', projectId: 'p1', sourceType: 'issue', sourceId: 'iss-1' }}
        initialProjectIds={['p1']}
        link={link}
        onRemove={onRemove}
        onDone={onDone}
        {...over}
      />
    </ToastProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.props = null;
  link.mockResolvedValue(undefined);
});

describe('PhotoDropCard', () => {
  it('mounts one AddFilesButton configured for this record, and no bare file input', () => {
    const { container } = renderCard();

    expect(screen.getByTestId('add-files-button')).toBeInTheDocument();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(h.props).toMatchObject({
      label: 'Add photos',
      accept: 'image',
      defaultTab: 'upload',
      initialProjectIds: ['p1'],
      // Already-attached photos are hidden from the Existing tab.
      excludeFileIds: ['f-1'],
      upload: {
        kind: 'issue-photo', projectId: 'p1', sourceType: 'issue', sourceId: 'iss-1',
        accept: 'image/*',
      },
    });
    // No capture default: on a phone this opens the native photo picker
    // (camera available as a source) instead of jumping straight to the camera.
    expect(h.props.upload.capture).toBeUndefined();
  });

  it('links every picked row and then reloads the record', async () => {
    renderCard();
    fireEvent.click(screen.getByTestId('add-files-button'));

    await waitFor(() => expect(link).toHaveBeenCalledTimes(2));
    expect(link.mock.calls.map(c => c[0])).toEqual(['row-1', 'row-2']);
    expect(onDone).toHaveBeenCalled();
    // The picker already stored them — the card must not re-upload.
    expect(uploadProjectFile).not.toHaveBeenCalled();
  });

  it('uploads a dropped image into the record\'s project, links it, then reloads', async () => {
    renderCard();
    const shot = png('shot.png');
    fireEvent.drop(screen.getByTestId('issue-photo-dropzone'), {
      dataTransfer: { files: [shot, new File(['x'], 'plan.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() => expect(uploadProjectFile).toHaveBeenCalledTimes(1));
    expect(uploadProjectFile).toHaveBeenCalledWith('p1', shot, 'issue-photo', { sourceType: 'issue', sourceId: 'iss-1' });
    await waitFor(() => expect(link).toHaveBeenCalledWith('up-1'));
    expect(onDone).toHaveBeenCalled();
  });

  it('sends a drop through the global file store when the record has no project', async () => {
    renderCard({ upload: { kind: 'task-photo', customerId: 'c1', sourceType: 'task', sourceId: 't1' }, initialProjectIds: undefined });
    fireEvent.drop(screen.getByTestId('issue-photo-dropzone'), { dataTransfer: { files: [png('shot.png')] } });

    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveBinaryFile).mock.calls[0][2]).toMatchObject({
      kind: 'task-photo', customerId: 'c1', sourceType: 'task', sourceId: 't1',
    });
    expect(uploadProjectFile).not.toHaveBeenCalled();
    await waitFor(() => expect(link).toHaveBeenCalledWith('saved-1'));
  });

  it('refuses a drop while the owner says it is blocked, and says why', async () => {
    renderCard({ disabled: true, disabledMessage: 'Save your changes first' });

    expect(screen.getByTestId('add-files-button')).toBeDisabled();
    expect(screen.getByTestId('add-files-button')).toHaveAttribute('title', 'Save your changes first');

    fireEvent.drop(screen.getByTestId('issue-photo-dropzone'), { dataTransfer: { files: [png('shot.png')] } });
    await screen.findByText('Save your changes first');
    expect(uploadProjectFile).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
  });

  it('highlights while a drag is over it', () => {
    renderCard();
    const zone = screen.getByTestId('issue-photo-dropzone');
    expect(zone.className).not.toContain('ring-accent-500');
    fireEvent.dragEnter(zone, { dataTransfer: { files: [] } });
    expect(zone.className).toContain('ring-accent-500');
  });

  it('summarises a partial failure but still reloads', async () => {
    link.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('nope'));
    renderCard();
    fireEvent.click(screen.getByTestId('add-files-button'));

    await screen.findByText('Added 1 of 2 photos');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('renders the photos it was given and removes through the owner', () => {
    const { container } = renderCard({ photos: [{ id: 'ph-1', fileId: 'f-1' }, { id: 'ph-2', fileId: 'f-2' }] });
    // Thumbnails are decorative (alt="") so they carry no accessible role.
    expect(container.querySelectorAll('img')).toHaveLength(2);
    fireEvent.click(screen.getAllByTitle('Remove')[1]);
    expect(onRemove).toHaveBeenCalledWith('f-2');
  });

  it('shows the empty hint when the record has no photos', () => {
    renderCard({ photos: [] });
    expect(screen.getByText('No photos.')).toBeInTheDocument();
    expect(h.props.excludeFileIds).toEqual([]);
  });

  it('opens the lightbox at the clicked thumbnail, and a Remove click does not also open it', () => {
    const { container } = renderCard({ photos: [{ id: 'ph-1', fileId: 'f-1' }, { id: 'ph-2', fileId: 'f-2' }] });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const thumbs = container.querySelectorAll('img');
    fireEvent.click(thumbs[1]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByTitle('Remove')[0]);
    expect(onRemove).toHaveBeenCalledWith('f-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
