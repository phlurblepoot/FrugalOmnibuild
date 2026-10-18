// Sign-in redirect: `?next=` is honoured only for paths on this site.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet, useLocation } from 'react-router-dom';

vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ reducedMotion: true }) }));
vi.mock('../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSetupState: vi.fn().mockResolvedValue({ fresh: false }),
}));

import { Login, safeNext } from './Login';

const Where: React.FC = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search + l.hash}</div>;
};

const signInWith = async (next: string) => {
  render(
    <MemoryRouter initialEntries={['/login?next=' + encodeURIComponent(next)]}>
      <Routes>
        <Route element={<Outlet context={{ appName: 'App', logoUrl: '' }} />}>
          <Route path="/login" element={<Login />} />
        </Route>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText('Enter your username'), { target: { value: 'u' } });
  fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'p' } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
  return (await screen.findByTestId('where')).textContent;
};

beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: 't', user: { id: 1 } }),
  }) as any;
});

describe('Login next redirect', () => {
  it('keeps a same-site path with its query', async () => {
    expect(await signInWith('/share-target?shared=1')).toBe('/share-target?shared=1');
  });

  it.each([
    ['//evil.com'],
    ['/\\evil.com'],
    ['/\\/evil.com'],
    ['https://evil.com'],
    ['javascript:alert(1)'],
    ['/ok\nevil'],
  ])('falls back to /dashboard for %j', async (bad) => {
    expect(await signInWith(bad)).toBe('/dashboard');
    await waitFor(() => expect(localStorage.getItem('token')).toBe('t'));
  });
});

describe('safeNext', () => {
  it('rejects empty, tab and encoded-backslash-free odd values', () => {
    expect(safeNext(null)).toBe('/dashboard');
    expect(safeNext('')).toBe('/dashboard');
    expect(safeNext('/\tevil.com')).toBe('/dashboard');
    expect(safeNext('/a/b?x=1#h')).toBe('/a/b?x=1#h');
  });
});
