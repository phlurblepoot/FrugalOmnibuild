// src/components/documents/AddFilesButton.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { AddFilesButton } from './AddFilesButton';

const h = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('../FilePickerModal', () => ({
  FilePickerModal: (props: Record<string, unknown>) => {
    h.props = props;
    return <div data-testid="picker" />;
  },
}));

beforeEach(() => { h.props = null; });

describe('AddFilesButton', () => {
  it('renders a labelled button and mounts nothing until it is pressed', () => {
    render(<AddFilesButton label="Add photos" accept="image" onPick={() => {}} />);
    expect(screen.getByRole('button', { name: /Add photos/ })).toBeInTheDocument();
    expect(screen.queryByTestId('picker')).toBeNull();
  });

  it('opens the picker with every prop it was given', () => {
    const onPick = vi.fn();
    const onPickBlobs = vi.fn();
    const upload = { kind: 'photo', projectId: 'p1', sourceType: 'issue', sourceId: 'i1' };
    render(
      <AddFilesButton
        label="Attach files" accept="pdf" multi={false} upload={upload} defaultTab="upload"
        initialProjectIds={['p1']} excludeFileIds={['f1']} returnBlobs
        onPick={onPick} onPickBlobs={onPickBlobs}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Attach files/ }));

    expect(screen.getByTestId('picker')).toBeInTheDocument();
    expect(h.props).toMatchObject({
      open: true, accept: 'pdf', multi: false, upload, defaultTab: 'upload',
      initialProjectIds: ['p1'], excludeFileIds: ['f1'], returnBlobs: true,
      onPick, onPickBlobs, title: 'Attach files',
    });
  });

  it('passes onPickFiles through for a picker that stages uploads instead of storing them', () => {
    const onPickFiles = vi.fn();
    render(<AddFilesButton label="Attach" accept="image-pdf" upload={{ kind: 'payment-attachment', projectId: 'p1' }} onPick={() => {}} onPickFiles={onPickFiles} />);
    fireEvent.click(screen.getByRole('button', { name: /Attach/ }));
    expect(h.props).toMatchObject({ accept: 'image-pdf', onPickFiles });
  });

  it('defaults to multi-select', () => {
    render(<AddFilesButton label="Add files" accept="any" onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Add files/ }));
    expect(h.props!.multi).toBe(true);
  });

  it('unmounts the picker when it closes itself', () => {
    render(<AddFilesButton label="Add files" accept="any" onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Add files/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add files/ })); // still open, not a toggle
    expect(screen.getByTestId('picker')).toBeInTheDocument();

    act(() => (h.props!.onClose as () => void)());
    expect(screen.queryByTestId('picker')).toBeNull();
  });

  it('honours disabled', () => {
    render(<AddFilesButton label="Add files" accept="any" disabled onPick={() => {}} />);
    const btn = screen.getByRole('button', { name: /Add files/ });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(screen.queryByTestId('picker')).toBeNull();
  });
});
