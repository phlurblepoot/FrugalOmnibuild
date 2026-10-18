// The share-sheet landing page: shows what was shared, files it into the
// chosen project's Documents, and says so when nothing was shared.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({ getProjectsSummary: vi.fn(), uploadProjectFile: vi.fn() }));
vi.mock('../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectsSummary: h.getProjectsSummary,
  uploadProjectFile: h.uploadProjectFile,
}));

import { ShareTargetPage, SHARE_CACHE, defaultKindFor } from './ShareTargetPage';

const store = new Map<string, Response>();
const fakeCaches = {
  open: async () => ({
    keys: async () => [...store.keys()].map(k => new Request('http://localhost' + k)),
    match: async (r: string | Request) => store.get(typeof r === 'string' ? r : new URL(r.url).pathname)?.clone(),
  }),
  delete: vi.fn(async () => { store.clear(); return true; }),
};

const shareFile = (i: number, name: string) =>
  store.set('/share-target/file/' + i, new Response('pdf-bytes', { headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(name) } }));

const renderPage = () => render(<MemoryRouter><ShareTargetPage /></MemoryRouter>);

beforeEach(() => {
  store.clear();
  h.getProjectsSummary.mockReset().mockResolvedValue([
    { id: 'p1', name: 'Alpha', archived: false },
    { id: 'p2', name: 'Old job', archived: true },
  ]);
  h.uploadProjectFile.mockReset().mockResolvedValue({ fileId: 'f', versioned: false });
  fakeCaches.delete.mockClear();
  (globalThis as any).caches = fakeCaches;
  localStorage.setItem('token', 't');
});

describe('ShareTargetPage', () => {
  it('uses the cache name the service worker writes to', () => {
    expect(SHARE_CACHE).toBe('share-target-v1');
  });

  it('says so when nothing was shared', async () => {
    renderPage();
    expect(await screen.findByText(/Nothing to add/)).toBeTruthy();
  });

  it('files the shared files into the chosen project and clears the cache', async () => {
    shareFile(0, 'plans 1.pdf');
    renderPage();
    expect(await screen.findByText('plans 1.pdf')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Add to Documents' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Archived projects are not offered.
    expect(screen.queryByText('Old job')).toBeNull();
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('Added to Alpha')).toBeTruthy());
    expect(h.uploadProjectFile).toHaveBeenCalledTimes(1);
    const [pid, file, kind] = h.uploadProjectFile.mock.calls[0];
    expect([pid, (file as File).name, kind]).toEqual(['p1', 'plans 1.pdf', 'document']);
    expect(fakeCaches.delete).toHaveBeenCalledWith(SHARE_CACHE);
    expect(screen.getByRole('link', { name: 'Open Documents' }).getAttribute('href')).toBe('/project/p1/documents');
  });

  it('keeps the files and shows the error when the upload fails', async () => {
    shareFile(0, 'a.pdf');
    h.uploadProjectFile.mockRejectedValueOnce(new Error('Too big'));
    renderPage();
    await screen.findByText('a.pdf');
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Documents' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too big');
    expect(fakeCaches.delete).not.toHaveBeenCalled();
  });

  it('defaults each file to a sensible type and lets the person change it', async () => {
    store.set('/share-target/file/0', new Response('x', { headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'plan.pdf' } }));
    store.set('/share-target/file/1', new Response('x', { headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': 'wall.jpg' } }));
    store.set('/share-target/file/2', new Response('x', { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': 'bid.xlsx' } }));
    renderPage();
    await screen.findByText('plan.pdf');
    const sel = (n: string) => screen.getByLabelText('Type for ' + n) as HTMLSelectElement;
    expect([sel('plan.pdf').value, sel('wall.jpg').value, sel('bid.xlsx').value]).toEqual(['document', 'photo', 'spreadsheet']);
    fireEvent.change(sel('wall.jpg'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Documents' }));
    await screen.findByText('Added to Alpha');
    expect(h.uploadProjectFile.mock.calls.map(c => [(c[1] as File).name, c[2]])).toEqual([
      ['plan.pdf', 'document'], ['wall.jpg', 'other'], ['bid.xlsx', 'spreadsheet'],
    ]);
  });

  it('falls back to the file extension when the shared type is blank', () => {
    expect(defaultKindFor({ name: 'Bid.XLSX', type: '' })).toBe('spreadsheet');
    expect(defaultKindFor({ name: 'list.csv', type: 'text/csv' })).toBe('spreadsheet');
    expect(defaultKindFor({ name: 'letter.docx', type: '' })).toBe('document');
    expect(defaultKindFor({ name: 'IMG_1.heic', type: '' })).toBe('photo');
    expect(defaultKindFor({ name: 'site.dwg', type: 'application/octet-stream' })).toBe('other');
  });

  it('filters the project list as the person searches', async () => {
    h.getProjectsSummary.mockResolvedValue([
      { id: 'p1', name: 'Alpha', archived: false },
      { id: 'p3', name: 'Birch Street', archived: false },
    ]);
    shareFile(0, 'a.pdf');
    renderPage();
    await screen.findByText('a.pdf');
    const options = () => Array.from((screen.getByLabelText('Project') as HTMLSelectElement).options).map(o => o.text);
    expect(options()).toEqual(['Choose a project…', 'Alpha', 'Birch Street']);
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'bir' } });
    expect(options()).toEqual(['Choose a project…', 'Birch Street']);
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'zzz' } });
    expect(options()).toEqual(['No matching projects']);
  });

  it('sends a signed-out person to sign in, coming back to /share-target?shared=1', async () => {
    localStorage.removeItem('token');
    shareFile(0, 'a.pdf');
    const Where = () => { const l = useLocation(); return <p>at {l.pathname}{l.search}</p>; };
    render(
      <MemoryRouter initialEntries={['/share-target?shared=1']}>
        <Routes>
          <Route path="/share-target" element={<ShareTargetPage />} />
          <Route path="/login" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    const at = await screen.findByText(t => t.startsWith('at /login'));
    expect(decodeURIComponent(at.textContent!)).toContain('?next=/share-target?shared=1');
    // The files were not touched, so they are still waiting after sign-in.
    expect(fakeCaches.delete).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });
});
