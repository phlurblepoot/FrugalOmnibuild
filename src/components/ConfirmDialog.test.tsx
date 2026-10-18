// src/components/ConfirmDialog.test.tsx — the confirm dialog only closes from its own buttons or Esc.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfirmProvider, useConfirm } from './ConfirmDialog';

const Opener: React.FC<{ onResult: (v: boolean) => void }> = ({ onResult }) => {
  const confirm = useConfirm();
  return <button onClick={async () => onResult(await confirm({ title: 'Sure?', message: 'Really?' }))}>ask</button>;
};

describe('ConfirmDialog', () => {
  it('ignores a backdrop click but still cancels on Esc', async () => {
    const results: boolean[] = [];
    render(<ConfirmProvider><Opener onResult={v => results.push(v)} /></ConfirmProvider>);
    fireEvent.click(screen.getByText('ask'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(results).toEqual([]);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(results).toEqual([false]));
  });
});
