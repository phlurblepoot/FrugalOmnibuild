// src/components/ui/Modal.test.tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { Modal, __trapDepth } from './Modal';
import { ConfirmProvider } from '../ConfirmDialog';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Hi">body</Modal>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders title, body, and footer when open', () => {
    render(
      <Modal open onClose={() => {}} title="Send proposal" footer={<button>Send</button>}>
        body text
      </Modal>
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Send proposal' })).toBeInTheDocument();
    expect(screen.getByText('body text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Hi">body</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on overlay click, but the X button closes', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Hi">body</Modal>);
    fireEvent.click(screen.getByText('body'));
    fireEvent.click(screen.getByTestId('modal-overlay'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dirty: Esc and X ask first, and close only when confirmed', async () => {
    const onClose = vi.fn();
    render(
      <ConfirmProvider>
        <Modal open onClose={onClose} title="Hi" dirty>body</Modal>
      </ConfirmProvider>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await screen.findByText('Discard changes?')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Keep editing'));
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Close dialog'));
    fireEvent.click(await screen.findByText('Discard'));
    await act(async () => {});
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  // Focus management (Plan 3 Task 10 a11y pass). Before this, opening a modal
  // left focus behind it, so Tab walked the page underneath the overlay.
  describe('focus management', () => {
    it('moves focus into the dialog when it opens', async () => {
      render(
        <Modal open onClose={() => {}} title="Hi">
          <input aria-label="Name" />
        </Modal>
      );
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(document.body.contains(document.activeElement)).toBe(true);
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });

    it('leaves an already-focused field inside the dialog alone', async () => {
      render(
        <Modal open onClose={() => {}} title="Hi">
          <input aria-label="Name" autoFocus />
        </Modal>
      );
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    });

    it('wraps Tab from the last focusable back to the first', async () => {
      render(
        <Modal open onClose={() => {}} title="Hi" footer={<button>Send</button>}>
          <input aria-label="Name" />
        </Modal>
      );
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      const close = screen.getByRole('button', { name: 'Close dialog' });
      const send = screen.getByRole('button', { name: 'Send' });
      send.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(send);
    });

    // A `tabIndex={-1}` control is deliberately out of the tab order. The
    // selector only excluded it on its last clause, so `button:not([disabled])`
    // matched it anyway and the trap treated it as the modal's last stop.
    it('skips a tabIndex={-1} control when it wraps', async () => {
      render(
        <Modal open onClose={() => {}} title="Hi">
          <button>Real</button>
          <button tabIndex={-1}>Skipped</button>
        </Modal>
      );
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      const real = screen.getByRole('button', { name: 'Real' });
      const close = screen.getByRole('button', { name: 'Close dialog' });

      real.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(close);
      expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Skipped' }));
    });

    it('restores focus to the opener when it closes', async () => {
      const opener = document.createElement('button');
      document.body.appendChild(opener);
      opener.focus();
      const { rerender } = render(<Modal open onClose={() => {}} title="Hi">body</Modal>);
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(document.activeElement).not.toBe(opener);
      rerender(<Modal open={false} onClose={() => {}} title="Hi">body</Modal>);
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });
  });

  // Nested modals (a picker opened from inside another modal). Both panels are
  // portalled to document.body, so they are siblings, not ancestor/descendant:
  // before the trap stack the OUTER modal saw every Tab as "focus escaped my
  // panel" and yanked it back, so Tab inside the inner modal was unusable.
  describe('nested modals', () => {
    const Nested: React.FC<{ inner: boolean }> = ({ inner }) => (
      <>
        <Modal open onClose={() => {}} title="Outer">
          <button>Outer A</button>
          <button>Outer B</button>
        </Modal>
        <Modal open={inner} onClose={() => {}} title="Inner">
          <button>Inner X</button>
          <button>Inner Y</button>
        </Modal>
      </>
    );

    const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

    it('lets Tab move inside the inner modal without the outer one stealing focus', async () => {
      render(<Nested inner />);
      await settle();
      const outer = screen.getByRole('dialog', { name: 'Outer' });
      const inner = screen.getByRole('dialog', { name: 'Inner' });
      const innerX = within(inner).getByRole('button', { name: 'Inner X' });

      // Mid-list: the inner trap must NOT intervene at all, so the browser's
      // own Tab moves on to "Inner Y".
      innerX.focus();
      const notPrevented = fireEvent.keyDown(document, { key: 'Tab' });
      expect(notPrevented).toBe(true);
      expect(document.activeElement).toBe(innerX);
      expect(outer.contains(document.activeElement)).toBe(false);
    });

    it('wraps within the inner modal only, never into the outer one', async () => {
      render(<Nested inner />);
      await settle();
      const outer = screen.getByRole('dialog', { name: 'Outer' });
      const inner = screen.getByRole('dialog', { name: 'Inner' });
      const innerClose = within(inner).getByRole('button', { name: 'Close dialog' });
      const innerY = within(inner).getByRole('button', { name: 'Inner Y' });

      innerY.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(innerClose);
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(innerY);
      expect(outer.contains(document.activeElement)).toBe(false);
    });

    it('hands trapping back to the outer modal when the inner one closes', async () => {
      const { rerender } = render(<Nested inner />);
      await settle();
      expect(__trapDepth()).toBe(2);

      rerender(<Nested inner={false} />);
      await settle();
      // (The inner panel itself lingers for its exit animation; what matters
      // is that it no longer owns the trap.)
      expect(__trapDepth()).toBe(1);

      const outer = screen.getByRole('dialog', { name: 'Outer' });
      const outerB = within(outer).getByRole('button', { name: 'Outer B' });
      const outerClose = within(outer).getByRole('button', { name: 'Close dialog' });
      outerB.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(outerClose);
    });

    it('drops its trap even when unmounted while still open', async () => {
      const { unmount } = render(<Modal open onClose={() => {}} title="Hi">body</Modal>);
      await settle();
      expect(__trapDepth()).toBe(1);
      unmount();
      expect(__trapDepth()).toBe(0);
    });
  });
});
