// src/pages/documentEditor/InsertImagePicker.test.tsx — the photos route of
// Insert → Image → From storage: the shared file picker, images only, starting
// on the document's project. (Signatures and stamps: DocumentEditor.test.tsx.)
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InsertImagePicker } from './InsertImagePicker';

const h = vi.hoisted(() => ({ pickerProps: null as any }));
vi.mock('../../components/FilePickerModal', () => ({
  FilePickerModal: (props: any) => {
    h.pickerProps = props;
    return props.open ? <button onClick={() => props.onPick([{ id: 'ph1' }, { id: 'ph2' }])}>pick two photos</button> : null;
  },
}));
vi.mock('../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../utils/store')>()),
  listSignatures: vi.fn(async () => []),
  listCompanyStamps: vi.fn(async () => []),
}));

beforeEach(() => { h.pickerProps = null; localStorage.clear(); });

describe('InsertImagePicker', () => {
  it('browses images in Documents from the document’s project and hands back every pick', async () => {
    const onPick = vi.fn();
    render(<InsertImagePicker open onClose={() => {}} projectId="p1" onPick={onPick} />);
    expect(await screen.findByText(/No signatures yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('insert-image-photos'));
    await waitFor(() => expect(h.pickerProps.open).toBe(true));
    expect(h.pickerProps).toMatchObject({ accept: 'image', multi: true, initialProjectIds: ['p1'] });
    fireEvent.click(screen.getByText('pick two photos'));
    expect(onPick).toHaveBeenCalledWith(['ph1', 'ph2']);
  });

  it('points to where signatures and stamps are added when there are none', async () => {
    render(<InsertImagePicker open onClose={() => {}} projectId={null} onPick={() => {}} />);
    expect(await screen.findByText(/Settings → User Preferences → My signatures/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Company stamps/ }));
    expect(await screen.findByText(/Settings → Document Templates/)).toBeInTheDocument();
  });
});
