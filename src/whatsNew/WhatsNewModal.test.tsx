// src/whatsNew/WhatsNewModal.test.tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WhatsNewModal, shotUrl } from './WhatsNewModal';
import type { WhatsNewRelease } from './releases';

const release: WhatsNewRelease = {
  version: '4.7',
  intro: { title: 'Welcome to 4.7', body: 'A quick tour.' },
  pages: [
    { id: 'a', kind: 'new', area: 'Sketch', title: 'Round edges', body: 'Press [[E]].', points: ['Type the size.'], shots: [{ file: 'round.webp', dark: true, caption: 'Rounding' }], action: { label: 'Open Sketch', to: '/tools/sketch' } },
    { id: 'b', kind: 'improved', area: 'Takeoff canvas', title: 'Feet and inches', points: ['Labels along lines.'], shots: [{ file: 'labels.webp', caption: 'Labels' }] },
    { id: 'c', kind: 'fixed', area: 'All over the app', title: 'Fixes', points: ['Photos upright.'], shots: [] },
  ],
};

const show = (onClose = vi.fn()) => {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/dashboard" element={<WhatsNewModal open releases={[release]} onClose={onClose} />} />
        <Route path="/tools/sketch" element={<p>Sketch page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
};

describe('WhatsNewModal', () => {
  it('opens on a welcome page listing every change, and jumps to one', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Welcome to 4.7' })).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-back')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Feet and inches' }));
    expect(screen.getByRole('heading', { name: 'Feet and inches' })).toBeInTheDocument();
    expect(screen.getByText('Improved')).toBeInTheDocument();
  });

  it('pages with Next, Back, the dots and the arrow keys; Done on the last page closes it', () => {
    const onClose = show();
    fireEvent.click(screen.getByTestId('whats-new-next'));
    expect(screen.getByRole('heading', { name: 'Round edges' })).toBeInTheDocument();
    expect(screen.getByText('E').tagName).toBe('KBD');
    expect(screen.getByRole('img', { name: 'Rounding' })).toHaveAttribute('src', '/whats-new/4.7/round.webp');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'Feet and inches' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByRole('heading', { name: 'Round edges' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(screen.getByRole('heading', { name: 'Fixes' })).toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-skip')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('whats-new-next'));
    expect(screen.getByTestId('whats-new-next')).toHaveTextContent('Done');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Skip closes it; a page\'s button goes there and closes it', () => {
    const onClose = show();
    fireEvent.click(screen.getByTestId('whats-new-skip'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('whats-new-next'));
    fireEvent.click(screen.getByTestId('whats-new-action'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Sketch page')).toBeInTheDocument();
  });

  it('shows the dark picture in dark mode where there is one', () => {
    expect(shotUrl('4.7', { file: 'round.webp', dark: true, caption: '' }, true)).toBe('/whats-new/4.7/round-dark.webp');
    expect(shotUrl('4.7', { file: 'labels.webp', caption: '' }, true)).toBe('/whats-new/4.7/labels.webp');
  });
});
