// src/components/Toast.test.tsx — the toast layer's stacking contract. A toast
// fired from inside a dialog used to render behind it: the container sat
// inline at z-[200] while Modal's overlay portals to <body> at z-[250], and in
// one shared stacking context the higher z-index simply wins.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';
import { Modal } from './ui/Modal';

const Fire: React.FC<{ message?: string }> = ({ message = 'Saved' }) => {
  const { toast } = useToast();
  return <button onClick={() => toast(message, { type: 'success' })}>fire</button>;
};

const container = () => screen.getByTestId('toast-container');

describe('ToastProvider', () => {
  it('portals the toast layer to <body>, above every overlay in the app', () => {
    render(<ToastProvider><Fire /></ToastProvider>);
    const layer = container();
    // A direct child of <body>, so no ancestor can trap it in its own
    // stacking context or clip it with overflow.
    expect(layer.parentElement).toBe(document.body);
    expect(layer).toHaveClass('z-[10000]');
    // Position is unchanged.
    expect(layer).toHaveClass('fixed', 'bottom-4', 'right-4');
  });

  it('stacks a toast above an open Modal rather than behind it', () => {
    render(
      <ToastProvider>
        <Modal open onClose={() => {}} title="Save to Documents">
          <Fire message="Failed to save 1 file" />
        </Modal>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByText('Failed to save 1 file')).toBeInTheDocument();

    const zOf = (el: Element) => {
      const cls = [...el.classList].find(c => c.startsWith('z-['));
      return Number(cls!.slice(3, -1));
    };
    expect(zOf(container())).toBeGreaterThan(zOf(screen.getByTestId('modal-overlay')));
  });

  it('renders the toasts themselves inside the portalled layer', () => {
    render(<ToastProvider><Fire /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    const toastEl = screen.getByText('Saved');
    expect(container()).toContainElement(toastEl);
    // Still dismissible, and still ignoring pointer events outside a toast.
    expect(container()).toHaveClass('pointer-events-none');
    expect(container().querySelector('[aria-label="Dismiss notification"]')).not.toBeNull();
  });
});
