// src/components/canvas/MultiplierModal.test.tsx
// The editor behind the sidebar's Multiplier action: whole numbers 1–999 save,
// anything else is refused with a hint; Enter saves, Escape cancels.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MultiplierModal } from './MultiplierModal';

const renderModal = (multiplier = 1) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<MultiplierModal measurementName="Level 2 floor" multiplier={multiplier} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose, input: screen.getByTestId('multiplier-input') as HTMLInputElement };
};

describe('MultiplierModal', () => {
  it('starts at the current multiplier and names the measurement', () => {
    const { input } = renderModal(4);
    expect(input.value).toBe('4');
    expect(screen.getByTestId('multiplier-modal')).toHaveTextContent('Level 2 floor');
  });

  it('saves a whole number', () => {
    const { onSave, input } = renderModal();
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('btn-save-multiplier'));
    expect(onSave).toHaveBeenCalledWith(4);
  });

  it('1 saves too: it counts the measurement once', () => {
    const { onSave } = renderModal(3);
    fireEvent.change(screen.getByTestId('multiplier-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('btn-save-multiplier'));
    expect(onSave).toHaveBeenCalledWith(1);
  });

  it('refuses 0, fractions and anything over 999', () => {
    const { onSave, input } = renderModal();
    for (const bad of ['0', '2.5', '1000', '']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(screen.getByTestId('btn-save-multiplier')).toBeDisabled();
      expect(screen.getByText('Enter a whole number from 1 to 999.')).toBeInTheDocument();
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Enter saves; Escape and Cancel close without saving', () => {
    const { onSave, onClose, input } = renderModal();
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith(12);
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
