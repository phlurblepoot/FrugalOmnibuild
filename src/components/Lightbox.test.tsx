// src/components/Lightbox.test.tsx
// Net-new springy photo viewer (Wave 3 Task 9). Portalled over everything,
// including an already-open editor Modal — which is why its Escape handling
// gets its own coverage: both Lightbox and Modal listen for Escape on
// `window`, so without capture-phase + stopPropagation a single Escape press
// would close both layers at once (see the capture-phase test below).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Lightbox } from './Lightbox';
import { CommandPalette } from './CommandPalette';
import { ToastProvider } from './Toast';

let reducedMotion = false;
vi.mock('../context/ThemeContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context/ThemeContext')>();
  return { ...actual, useTheme: () => ({ reducedMotion }) };
});

const items = [
  { src: '/img/1', caption: 'First shot' },
  { src: '/img/2' },
  { src: '/img/3', caption: 'Third shot' },
];

beforeEach(() => {
  reducedMotion = false;
});

describe('Lightbox', () => {
  it('renders the item at the given index, its caption, and a counter', () => {
    render(<Lightbox items={items} index={0} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', '/img/1');
    expect(screen.getByText('First shot')).toBeInTheDocument();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
  });

  it('omits the caption bar when the current item has none', () => {
    render(<Lightbox items={items} index={1} onClose={() => {}} />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/img/2');
    expect(screen.queryByTestId('lightbox-caption')).not.toBeInTheDocument();
  });

  it('starts at the given index and portals to document.body', () => {
    const { baseElement } = render(<Lightbox items={items} index={2} onClose={() => {}} />);
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(baseElement.querySelector('[role="dialog"][aria-modal="true"]')).toBeInTheDocument();
  });

  it('navigates with the Next/Previous buttons and updates the counter', () => {
    render(<Lightbox items={items} index={0} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/img/2');
    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
  });

  it('navigates with ArrowRight/ArrowLeft keys', () => {
    render(<Lightbox items={items} index={0} onClose={() => {}} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
  });

  it('clamps at both ends instead of wrapping', () => {
    render(<Lightbox items={items} index={0} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('1 / 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    render(<Lightbox items={items} index={0} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via a backdrop click but not a click on the image', () => {
    const onClose = vi.fn();
    render(<Lightbox items={items} index={0} onClose={onClose} />);
    fireEvent.click(screen.getByRole('img'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('lightbox-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Controller ruling: capture-phase window keydown + stopPropagation, so a
  // Modal underneath (its own bubble-phase Escape listener, e.g.
  // src/components/ui/Modal.tsx) does not also close on the same press.
  // Escape is dispatched on a descendant (document.body), not window itself
  // — window is only an *ancestor* in the real app (focus lives on the
  // dialog panel/a button), and capture-vs-bubble ordering only diverges
  // when the listener's node isn't the event target.
  it('Escape closes only the lightbox — a parent bubble-phase Escape listener on window never fires', () => {
    const parentEscapeListener = vi.fn();
    window.addEventListener('keydown', parentEscapeListener); // mimics Modal.tsx
    const onClose = vi.fn();
    render(<Lightbox items={items} index={0} onClose={onClose} />);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(parentEscapeListener).not.toHaveBeenCalled();

    window.removeEventListener('keydown', parentEscapeListener);
  });

  // Fix wave I2: CommandPalette (z-400) can open ON TOP of an already-open
  // Lightbox (z-300) via ⌘K or '/'. Before the fix, the Lightbox's
  // capture-phase Escape listener would stopPropagation() and close
  // ITSELF, leaving the (visually topmost) palette open — inverted from
  // what the user sees. Real integration test (both components rendered
  // together) rather than a stand-in, so it actually exercises the
  // data-palette-open contract between the two files.
  it('Escape closes the palette first when both are open, and only closes the lightbox on a second press', async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <ToastProvider>
          <CommandPalette />
          <Lightbox items={items} index={0} onClose={onClose} />
        </ToastProvider>
      </MemoryRouter>
    );

    fireEvent.keyDown(window, { key: 'k', metaKey: true }); // open the palette
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Residual to I2: CommandPalette's keyboard-shortcuts help overlay
  // (opened via '?', independent of the search dialog's `open` state) is
  // its own z-[400] palette-family surface with its own Escape handling.
  // Mirrors the test above but through that surface instead of the search
  // dialog, to prove the data-palette-open marker covers both.
  it('Escape closes the keyboard-shortcuts help overlay first when both are open, and only closes the lightbox on a second press', async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <ToastProvider>
          <CommandPalette />
          <Lightbox items={items} index={0} onClose={onClose} />
        </ToastProvider>
      </MemoryRouter>
    );

    fireEvent.keyDown(window, { key: '?' }); // open the keyboard-shortcuts help overlay
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the spring entrance by default (not reducedMotion)', () => {
    render(<Lightbox items={items} index={0} onClose={() => {}} />);
    expect(screen.getByTestId('lightbox-frame')).toHaveAttribute('data-motion', 'spring');
  });

  it('reducedMotion renders instantly — no spring entrance on the frame', () => {
    reducedMotion = true;
    render(<Lightbox items={items} index={0} onClose={() => {}} />);
    // Behavioral, not just presence: the frame carries which entrance path it
    // took (data-motion), driven directly by the reducedMotion branch that
    // picks `entranceMotion` in Lightbox.tsx. jsdom doesn't run framer's
    // animation engine, so this is the only way to observe from the DOM
    // which of the two motion configs (spring vs instant) was actually
    // wired to the frame, without reaching into component internals.
    expect(screen.getByTestId('lightbox-frame')).toHaveAttribute('data-motion', 'instant');
  });

  it('single item still shows a 1 / 1 counter and disables both nav buttons', () => {
    render(<Lightbox items={[items[0]]} index={0} onClose={() => {}} />);
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });
});
