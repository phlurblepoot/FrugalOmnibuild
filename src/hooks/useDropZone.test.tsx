// src/hooks/useDropZone.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDropZone } from './useDropZone';

const file = (name: string, type: string) => new File(['x'], name, { type });
const evt = (files: File[] = []) => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  dataTransfer: { files },
}) as never;

describe('useDropZone', () => {
  it('marks the zone active while a drag is over it', () => {
    const { result } = renderHook(() => useDropZone(vi.fn()));
    expect(result.current.dragActive).toBe(false);

    act(() => result.current.dropProps.onDragOver(evt()));
    expect(result.current.dragActive).toBe(true);

    act(() => result.current.dropProps.onDragLeave(evt()));
    expect(result.current.dragActive).toBe(false);
  });

  it('drops only the files the accept filter allows', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone(onFiles, { accept: 'pdf' }));
    const pdf = file('plan.pdf', 'application/pdf');

    act(() => result.current.dropProps.onDragEnter(evt()));
    act(() => result.current.dropProps.onDrop(evt([pdf, file('shot.png', 'image/png')])));

    expect(onFiles).toHaveBeenCalledWith([pdf]);
    expect(result.current.dragActive).toBe(false);
  });

  it('accepts every image for accept="image" and anything for accept="any"', () => {
    const onImages = vi.fn();
    const png = file('a.png', 'image/png');
    const { result: img } = renderHook(() => useDropZone(onImages, { accept: 'image' }));
    act(() => img.current.dropProps.onDrop(evt([png, file('plan.pdf', 'application/pdf')])));
    expect(onImages).toHaveBeenCalledWith([png]);

    const onAny = vi.fn();
    const { result: any } = renderHook(() => useDropZone(onAny));
    act(() => any.current.dropProps.onDrop(evt([png, file('plan.pdf', 'application/pdf')])));
    expect(onAny.mock.calls[0][0]).toHaveLength(2);
  });

  // A payment's check photo or remittance PDF (migration 43).
  it('accepts photos and PDFs, and nothing else, for accept="image-pdf"', () => {
    const onFiles = vi.fn();
    const png = file('check.png', 'image/png');
    const pdf = file('remit.pdf', 'application/pdf');
    const untyped = file('ach.PDF', '');
    const { result } = renderHook(() => useDropZone(onFiles, { accept: 'image-pdf' }));
    act(() => result.current.dropProps.onDrop(evt([png, file('ledger.csv', 'text/csv'), pdf, untyped, file('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')])));
    expect(onFiles).toHaveBeenCalledWith([png, pdf, untyped]);
  });

  // A drop of only the wrong type is a no-op, not an empty-array callback the
  // consumer has to guard against.
  it('does not call back when nothing survives the filter', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone(onFiles, { accept: 'pdf' }));
    act(() => result.current.dropProps.onDrop(evt([file('shot.png', 'image/png')])));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('is inert when disabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDropZone(onFiles, { disabled: true }));

    act(() => result.current.dropProps.onDragEnter(evt()));
    act(() => result.current.dropProps.onDragOver(evt()));
    expect(result.current.dragActive).toBe(false);

    act(() => result.current.dropProps.onDrop(evt([file('plan.pdf', 'application/pdf')])));
    expect(onFiles).not.toHaveBeenCalled();
  });
});
