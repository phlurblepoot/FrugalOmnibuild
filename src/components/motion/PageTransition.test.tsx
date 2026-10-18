import React, { useEffect, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, RouterProvider, createMemoryRouter, useSearchParams } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { PageTransition, pageKey } from './PageTransition';

describe('pageKey', () => {
  it('keys on the first two path segments so section/tab changes do not re-enter', () => {
    expect(pageKey('/dashboard')).toBe('dashboard');
    expect(pageKey('/project/abc/billing')).toBe('project/abc');
    expect(pageKey('/project/abc/issues')).toBe('project/abc');
    expect(pageKey('/')).toBe('root');
  });

  it('canvas routes share the project key (no page transition into canvas)', () => {
    expect(pageKey('/project/abc/page/p1')).toBe('project/abc');
  });
});

describe('PageTransition', () => {
  it('renders children', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <PageTransition><p>content</p></PageTransition>
        </MemoryRouter>
      </ThemeProvider>
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('renders children without a motion wrapper when reduced motion is on', () => {
    localStorage.setItem('theme-motion', 'reduced');
    const { container } = render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <PageTransition><p data-testid="c">content</p></PageTransition>
        </MemoryRouter>
      </ThemeProvider>
    );
    // With reduced motion the child is a direct child of the fragment (no wrapper div).
    expect(container.querySelector('[data-page-transition]')).toBeNull();
    localStorage.removeItem('theme-motion');
  });
});

describe('PageTransition between pages', () => {
  // A page like the RFI list: on arrival it reads the one-shot ?open=, strips
  // it, and opens that record once it has loaded.
  let mounts = 0;
  const Arriving: React.FC = () => {
    const [params, setParams] = useSearchParams();
    const [opened, setOpened] = useState<string | null>(null);
    useEffect(() => { mounts += 1; }, []);
    useEffect(() => {
      const id = params.get('open');
      if (!id) return;
      setTimeout(() => setOpened(id), 10);
      setParams({}, { replace: true });
    }, [params, setParams]);
    return <p>{opened ? `editing ${opened}` : 'list'}</p>;
  };
  const Layout: React.FC = () => <PageTransition><Outlet /></PageTransition>;

  it('mounts the page being entered once, so what it opens on arrival stays open (mail → RFI)', async () => {
    mounts = 0;
    const router = createMemoryRouter([{
      element: <Layout />,
      children: [{ path: '/mail', element: <p>mail</p> }, { path: '/rfis', element: <Arriving /> }],
    }], { initialEntries: ['/mail'] });
    render(<ThemeProvider><RouterProvider router={router} /></ThemeProvider>);
    expect(screen.getByText('mail')).toBeInTheDocument();
    await act(async () => { await router.navigate('/rfis?open=r1'); });
    expect(await screen.findByText('editing r1', {}, { timeout: 2000 })).toBeInTheDocument();
    // Past the exit fade: still open, and the page mounted only once.
    await new Promise(r => setTimeout(r, 400));
    await waitFor(() => expect(screen.getByText('editing r1')).toBeInTheDocument());
    expect(screen.queryByText('mail')).toBeNull();
    expect(mounts).toBe(1);
  });
});
