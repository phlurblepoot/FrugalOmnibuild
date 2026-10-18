// Whole round trip: files shared while signed out -> sign-in page -> back on
// the share page with the same files still waiting -> filed into a project.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';

vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ reducedMotion: true }) }));

import { handleResponse } from '../utils/store';
import { ShareTargetPage } from './ShareTargetPage';
import { Login } from './Login';

const store = new Map<string, Response>();
const fakeCaches = {
  open: async () => ({
    keys: async () => [...store.keys()].map(k => new Request('http://localhost' + k)),
    match: async (r: string | Request) => store.get(typeof r === 'string' ? r : new URL(r.url).pathname)?.clone(),
  }),
  delete: vi.fn(async () => { store.clear(); return true; }),
};

const app = () => render(
  <MemoryRouter initialEntries={['/share-target?shared=1']}>
    <Routes>
      <Route element={<Outlet context={{ appName: 'App', logoUrl: '' }} />}>
        <Route path="/login" element={<Login />} />
        <Route path="/share-target" element={<ShareTargetPage />} />
      </Route>
    </Routes>
  </MemoryRouter>,
);

const signIn = () => {
  fireEvent.change(screen.getByPlaceholderText('Enter your username'), { target: { value: 'u' } });
  fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'p' } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
};

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  store.clear();
  localStorage.clear();
  fakeCaches.delete.mockClear();
  (globalThis as any).caches = fakeCaches;
  store.set('/share-target/file/0', new Response('pdf', { headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'plans.pdf' } }));
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (u === '/api/auth/login') return json({ token: 't', user: { id: 1 } });
    if (u.startsWith('/api/settings/setup') || u.includes('setup-state')) return json({ fresh: false });
    const auth = (init?.headers ?? {}).Authorization;
    if (u === '/api/projects/summary') return auth === 'Bearer t' ? json([{ id: 'p1', name: 'Alpha', archived: false }]) : json({ error: 'no' }, 401);
    return json({});
  }) as any;
});

describe('share while signed out', () => {
  it('signs in and lands back on the share page with the files', async () => {
    app();
    // Sent to sign in, files untouched.
    await screen.findByPlaceholderText('Enter your username');
    expect(store.size).toBe(1);
    // Nothing was asked of the server while signed out: its 401 would reload
    // /login without the return address.
    expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).startsWith('/api/projects'))).toBe(false);
    signIn();
    expect(await screen.findByText('plans.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Project')).toBeTruthy();
    expect(fakeCaches.delete).not.toHaveBeenCalled();
  });

  it('does the same when the saved sign-in has expired', async () => {
    localStorage.setItem('token', 'stale');
    app();
    await screen.findByPlaceholderText('Enter your username');
    signIn();
    expect(await screen.findByText('plans.pdf')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Project')).toBeTruthy());
    expect(store.size).toBe(1);
  });
});

describe('401 handling keeps the return address', () => {
  const at = (pathname: string) => {
    const loc = { pathname, href: pathname };
    const real = window.location;
    Object.defineProperty(window, 'location', { value: loc, configurable: true });
    return { loc, restore: () => Object.defineProperty(window, 'location', { value: real, configurable: true }) };
  };
  const expired = () => new Response('{}', { status: 401 });

  it('from the share page goes to sign-in with the share page as the way back', async () => {
    const w = at('/share-target');
    await expect(handleResponse(expired())).rejects.toThrow();
    expect(decodeURIComponent(w.loc.href)).toBe('/login?next=/share-target?shared=1');
    w.restore();
  });

  it('already on the sign-in page leaves its address alone', async () => {
    const w = at('/login');
    w.loc.href = '/login?next=%2Fshare-target%3Fshared%3D1';
    await expect(handleResponse(expired())).rejects.toThrow();
    expect(w.loc.href).toBe('/login?next=%2Fshare-target%3Fshared%3D1');
    w.restore();
  });
});
