// src/components/CommandPalette.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { CommandPalette } from './CommandPalette';
import { ToastProvider } from './Toast';

const searchAll = vi.hoisted(() => vi.fn());
const getMyTimeEntries = vi.hoisted(() => vi.fn());
const clockIn = vi.hoisted(() => vi.fn());
const clockOut = vi.hoisted(() => vi.fn());

vi.mock('../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/store')>();
  return { ...actual, searchAll, getMyTimeEntries, clockIn, clockOut };
});

let reducedMotion = false;
vi.mock('../context/ThemeContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context/ThemeContext')>();
  return { ...actual, useTheme: () => ({ reducedMotion }) };
});

const renderPalette = (path = '/dashboard') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <CommandPalette />
      </ToastProvider>
    </MemoryRouter>
  );

const openPalette = () => fireEvent.keyDown(window, { key: 'k', metaKey: true });

beforeEach(() => {
  localStorage.clear();
  searchAll.mockReset().mockResolvedValue([]);
  getMyTimeEntries.mockReset().mockResolvedValue([]);
  clockIn.mockReset();
  clockOut.mockReset();
  reducedMotion = false;
});

describe('CommandPalette grouping', () => {
  it('shows a "This project" group and an "Actions" group with headers, in one flat selection order', () => {
    renderPalette('/project/p1');
    openPalette();

    // Contextual (project) actions come first, then static actions.
    const headers = screen.getAllByText(/^(Recent|This project|Actions|Search results)$/);
    expect(headers.map(h => h.textContent)).toEqual(['This project', 'Actions']);

    const buttons = screen.getAllByRole('button');
    const overview = screen.getByRole('button', { name: /Project overview/ });
    const dashboard = screen.getByRole('button', { name: /^Dashboard$/ });
    expect(buttons.indexOf(overview)).toBeLessThan(buttons.indexOf(dashboard));
  });

  it('arrow-nav crosses a group boundary seamlessly and Enter fires the right item', async () => {
    const { unmount } = renderPalette('/project/p1');
    openPalette();

    const buttons = screen.getAllByRole('button');
    // Move selection down to the last item of the "This project" group and
    // one more into "Actions" — the flat index must simply keep incrementing.
    const contextualCount = 14; // matches contextualActions in CommandPalette.tsx (non-admin)
    for (let i = 0; i < contextualCount; i++) {
      fireEvent.keyDown(window, { key: 'ArrowDown' });
    }
    // Selected item should now be the first static action ("New project").
    const selected = screen.getAllByRole('button').find(b => b.className.includes('bg-accent-50'));
    expect(selected?.textContent).toContain('New project');

    fireEvent.keyDown(window, { key: 'Enter' });
    // Palette closes on Enter (query resets); dialog should be gone once its
    // exit animation settles.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
    unmount();
    void buttons;
  });

  it('does not show a "This project" group outside a project route', () => {
    renderPalette('/dashboard');
    openPalette();
    expect(screen.queryByText('This project')).not.toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  // M5: arrow-nav can move selection past the visible window of the
  // internally-scrolling results pane; the newly-selected row needs to
  // bring itself into view.
  it('scrolls the newly-selected row into view on arrow-nav', () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      renderPalette('/dashboard');
      openPalette();
      scrollIntoView.mockClear(); // drop the initial-selection call
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

describe('CommandPalette layering', () => {
  // I2: other Escape-capturing layers (Lightbox) check for this attribute
  // to know the palette is on top and let Escape bubble through instead of
  // closing themselves. See src/components/Lightbox.tsx.
  it('marks its dialog root with data-palette-open while open, and clears it once closed', async () => {
    renderPalette('/dashboard');
    expect(document.querySelector('[data-palette-open]')).not.toBeInTheDocument();
    openPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveAttribute('data-palette-open', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('[data-palette-open]')).not.toBeInTheDocument());
  });

  // Residual to I2: the keyboard-shortcuts help overlay (opened via '?',
  // independent of the search dialog's `open` state) is its OWN z-[400]
  // palette-family surface and must carry the same marker — an earlier pass
  // only put it on the search dialog, so a Lightbox open behind the help
  // overlay would still close itself instead of the help overlay on Escape.
  it('marks the keyboard-shortcuts help overlay with data-palette-open too, and clears it once closed', async () => {
    renderPalette('/dashboard');
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveAttribute('data-palette-open', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('[data-palette-open]')).not.toBeInTheDocument());
  });
});

describe('CommandPalette recents', () => {
  it('shows a Recent group resolved from palette-recents when the query is empty', () => {
    localStorage.setItem('palette-recents', JSON.stringify([{ id: 'a:tasks', title: 'Tasks', at: Date.now() }]));
    renderPalette('/dashboard');
    openPalette();

    const headers = screen.getAllByText(/^(Recent|Actions|Search results)$/);
    expect(headers[0].textContent).toBe('Recent');
    // The recent entry duplicates into the top group; there should now be two
    // "Tasks" buttons (Recent + Actions).
    expect(screen.getAllByRole('button', { name: /^Tasks$/ })).toHaveLength(2);
  });

  it('ignores a recent id that no longer resolves to an action', () => {
    localStorage.setItem('palette-recents', JSON.stringify([{ id: 'a:does-not-exist', title: 'Ghost', at: Date.now() }]));
    renderPalette('/dashboard');
    openPalette();
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
    expect(screen.queryByText('Ghost')).not.toBeInTheDocument();
  });

  it('guards a corrupt palette-recents value instead of throwing', () => {
    localStorage.setItem('palette-recents', 'not json');
    expect(() => { renderPalette('/dashboard'); openPalette(); }).not.toThrow();
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
  });

  it('records an executed action into palette-recents, most-recent-first, deduped', () => {
    renderPalette('/dashboard');
    openPalette();
    fireEvent.click(screen.getByRole('button', { name: /^Dashboard$/ }));

    const stored = JSON.parse(localStorage.getItem('palette-recents') || '[]');
    expect(stored[0]).toMatchObject({ id: 'a:home', title: 'Dashboard' });

    // Running the same action again should not duplicate it. It now also
    // appears in the Recent group, so pick any matching button.
    openPalette();
    fireEvent.click(screen.getAllByRole('button', { name: /^Dashboard$/ })[0]);
    const stored2 = JSON.parse(localStorage.getItem('palette-recents') || '[]');
    expect(stored2.filter((r: { id: string }) => r.id === 'a:home')).toHaveLength(1);
  });

  it('hides the Recent group once a search query is typed', () => {
    localStorage.setItem('palette-recents', JSON.stringify([{ id: 'a:tasks', title: 'Tasks', at: Date.now() }]));
    renderPalette('/dashboard');
    openPalette();
    expect(screen.getByText('Recent')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'settings' } });
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
  });
});

describe('CommandPalette reduced motion', () => {
  it('applies the cascade class and --i style to rows by default', () => {
    renderPalette('/dashboard');
    openPalette();
    const dashboardBtn = screen.getByRole('button', { name: /^Dashboard$/ });
    expect(dashboardBtn.className).toContain('palette-row-cascade');
    expect(dashboardBtn.style.getPropertyValue('--i')).not.toBe('');
  });

  it('skips the cascade class and --i style when reducedMotion is on', () => {
    reducedMotion = true;
    renderPalette('/dashboard');
    openPalette();
    const dashboardBtn = screen.getByRole('button', { name: /^Dashboard$/ });
    expect(dashboardBtn.className).not.toContain('palette-row-cascade');
    expect(dashboardBtn.style.getPropertyValue('--i')).toBe('');
  });
});

describe('CommandPalette help overlay', () => {
  it('expands to include canvas shortcuts alongside the global ones', () => {
    renderPalette('/dashboard');
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('On the canvas')).toBeInTheDocument();
    expect(screen.getByText('Undo')).toBeInTheDocument();
    expect(screen.getByText('Paste measurement')).toBeInTheDocument();
    // Existing global shortcuts remain.
    expect(screen.getByText('Open command palette / search')).toBeInTheDocument();
  });
});

describe('CommandPalette search results group', () => {
  it('adds a "Search results" group once results resolve', async () => {
    searchAll.mockResolvedValue([{ type: 'project', id: 'pr1', title: 'Birchwood Job', projectId: 'pr1' }]);
    renderPalette('/dashboard');
    openPalette();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'birchwood' } });

    await waitFor(() => expect(screen.getByText('Search results')).toBeInTheDocument());
    expect(screen.getByText('Birchwood Job')).toBeInTheDocument();
  });
});

describe('CommandPalette — new documents (ONLYOFFICE Phase 3)', () => {
  const LocationProbe: React.FC = () => {
    const loc = useLocation();
    return <div data-testid="location">{loc.pathname + loc.search}</div>;
  };
  const renderWithProbe = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <CommandPalette />
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>
    );

  it('opens the New document dialog on the type picked, in the project you are in', () => {
    renderWithProbe('/project/p1');
    openPalette();
    fireEvent.click(screen.getByRole('button', { name: /New spreadsheet/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/documents?projectIds=p1&new=xlsx');
  });

  it('keeps the Documents page filters it was opened from', () => {
    renderWithProbe('/documents?projectIds=p2');
    openPalette();
    fireEvent.click(screen.getByRole('button', { name: /New PDF form/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/documents?projectIds=p2&new=pdf');
    openPalette();
    fireEvent.click(screen.getByRole('button', { name: /New Word document/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('new=docx');
  });
});

// The Reports page is admin-only, like billing (spec
// docs/superpowers/specs/2026-10-06-reports-design.md).
describe('CommandPalette — Reports', () => {
  const LocationProbe: React.FC = () => {
    const loc = useLocation();
    return <div data-testid="location">{loc.pathname}{loc.search}</div>;
  };

  it('offers Reports to admins and opens the page', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'noah', role: 'admin' }));
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <ToastProvider><CommandPalette /><LocationProbe /></ToastProvider>
      </MemoryRouter>
    );
    openPalette();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'rep' } });
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/reports');
  });

  it('does not offer Reports to anyone else', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'crew', role: 'user' }));
    renderPalette();
    openPalette();
    expect(screen.queryByRole('button', { name: /^Reports/ })).not.toBeInTheDocument();
  });
});
