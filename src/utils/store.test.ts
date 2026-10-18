import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveRetainageMode, AiaSovLine,
  saveBinaryFile, uploadProjectFile, persistGeneratedDocument,
  restoreSnapshot, RestoreRunningError,
  computeSovSeedFromEstimate,
  startMediaSession, endMediaSession,
  deleteProject, getProjectDeleteCheck, ProjectHasDataError,
} from './store';
import type { Project } from '../types';

const line = (retainagePercent: number | null): Pick<AiaSovLine, 'retainagePercent'> => ({ retainagePercent });

describe('resolveRetainageMode', () => {
  it('returns the explicit mode when set, regardless of SOV data', () => {
    expect(resolveRetainageMode('uniform', [line(12)])).toBe('uniform');
    expect(resolveRetainageMode('perLine', [])).toBe('perLine');
  });

  it('infers perLine when the mode is absent but a line carries a per-line rate', () => {
    expect(resolveRetainageMode(undefined, [line(null), line(8)])).toBe('perLine');
  });

  it('infers uniform when the mode is absent and no line carries a per-line rate', () => {
    expect(resolveRetainageMode(undefined, [line(null), line(null)])).toBe('uniform');
  });

  it('infers uniform when the mode is absent and there are no SOV lines at all', () => {
    expect(resolveRetainageMode(undefined, [])).toBe('uniform');
  });
});

// The Schedule of Values seed prices each takeoff from computeTakeoffTotals,
// so a multiplied measurement (× N) is priced N times there too.
describe('computeSovSeedFromEstimate', () => {
  it('prices a multiplied measurement at its multiplied quantity', () => {
    const project = {
      id: 'pr', name: 'Job', createdAt: 0, planSets: [],
      takeoffs: [{ id: 't1', name: 'Base', color: '#000', type: 'length', unit: 'ft', costPerUnit: 2, pricePackage: 'Trim' }],
      pages: [{
        id: 'p1', name: 'A-1', imageId: '', imageWidth: 0, imageHeight: 0,
        scaleConfig: { pixelDistance: 1, realWorldDistance: 1, unit: 'ft' },
        measurements: [
          // 100 ft × 3 + 50 ft = 350 ft at $2.
          { id: 'm1', type: 'length', name: 'Base', color: '#000', takeoffId: 't1', multiplier: 3, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
          { id: 'm2', type: 'length', name: 'Trim', color: '#000', takeoffId: 't1', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }] },
        ],
      }],
    } as unknown as Project;
    expect(computeSovSeedFromEstimate(project)).toEqual([{ description: 'Trim', scheduledValueCents: 70000 }]);
  });
});

// The media cookie (spec docs/superpowers/specs/2026-10-07-file-link-security-design.md):
// photo and file links sign in by it, so a session from before it existed
// trades its token for one before the app's first image renders.
describe('media session', () => {
  const answer = (status: number) => ({ ok: status < 400, status }) as Response;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('trades the stored token for the media cookie', async () => {
    localStorage.setItem('token', 'tok');
    const spy = vi.fn(async () => answer(200));
    vi.stubGlobal('fetch', spy);
    await startMediaSession();
    expect(spy).toHaveBeenCalledWith('/api/auth/media-session', { method: 'POST', headers: { Authorization: 'Bearer tok' } });
  });

  it('asks nothing when no one is signed in', async () => {
    const spy = vi.fn(async () => answer(200));
    vi.stubGlobal('fetch', spy);
    await startMediaSession();
    expect(spy).not.toHaveBeenCalled();
  });

  it('lets the app start anyway when the server refuses, is unreachable or never answers', async () => {
    localStorage.setItem('token', 'tok');
    vi.stubGlobal('fetch', vi.fn(async () => answer(401)));
    await expect(startMediaSession()).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(startMediaSession()).resolves.toBeUndefined();

    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    let started = false;
    void startMediaSession(3000).then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
  });

  it('signing out has the server clear the cookie, even as the page navigates away', () => {
    const spy = vi.fn(async () => answer(200));
    vi.stubGlobal('fetch', spy);
    endMediaSession();
    expect(spy).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', keepalive: true });
  });
});

// Upload attribution (spec 2026-08-17 §Data model). The server may answer an
// upload with a DIFFERENT id than the one posted: a full sourceType+sourceId+kind
// triple on a single-instance kind versions the document that source already
// owns. Callers record references, so the returned id is the only safe one.
describe('upload helpers', () => {
  const okJson = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as Response;

  const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
    const spy = vi.fn(impl);
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the server fileId, not the posted id, when the upload was versioned', async () => {
    stubFetch(async () => okJson({ success: true, fileId: 'canonical-id', versioned: true }));

    const result = await saveBinaryFile('posted-id', new Blob(['x'], { type: 'application/pdf' }), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
      sourceType: 'invoice', sourceId: 'i1',
    });

    expect(result).toEqual({ fileId: 'canonical-id', versioned: true });
  });

  it('posts the attribution as query params', async () => {
    const spy = stubFetch(async () => okJson({ success: true, fileId: 'f1', versioned: false }));

    await saveBinaryFile('posted-id', new Blob(['x']), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
      customerId: 'c1', sourceType: 'invoice', sourceId: 'i1',
    });

    const url = new URL(spy.mock.calls[0][0] as string, 'http://localhost');
    expect(url.pathname).toBe('/api/files/posted-id');
    expect(url.searchParams.get('projectId')).toBe('p1');
    expect(url.searchParams.get('kind')).toBe('invoice');
    expect(url.searchParams.get('name')).toBe('inv.pdf');
    expect(url.searchParams.get('customerId')).toBe('c1');
    expect(url.searchParams.get('sourceType')).toBe('invoice');
    expect(url.searchParams.get('sourceId')).toBe('i1');
  });

  it('uploadProjectFile also reports the server id over the one it minted', async () => {
    stubFetch(async () => okJson({ success: true, fileId: 'server-owned', versioned: true }));

    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const result = await uploadProjectFile('p1', file, 'issue-report', {
      sourceType: 'issue', sourceId: 'iss1',
    });

    expect(result.fileId).toBe('server-owned');
    expect(result.versioned).toBe(true);
  });

  it('falls back to the posted id when an older server omits fileId', async () => {
    stubFetch(async () => okJson({ success: true }));

    const result = await saveBinaryFile('posted-id', new Blob(['x']), { kind: 'settings-asset' });

    expect(result).toEqual({ fileId: 'posted-id', versioned: false });
  });

  // Download handlers wrap this call in their own try/catch so a failed persist
  // only warns and the download still proceeds. That only works if the helper
  // reports the failure instead of swallowing it.
  it('persistGeneratedDocument rethrows a rejected upload rather than swallowing it', async () => {
    stubFetch(async () => { throw new Error('network down'); });

    await expect(persistGeneratedDocument(new Blob(['x']), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
      sourceType: 'invoice', sourceId: 'i1',
    })).rejects.toThrow('network down');
  });

  it('persistGeneratedDocument rethrows when the server rejects the upload', async () => {
    stubFetch(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to save file' }),
    }) as unknown as Response);

    await expect(persistGeneratedDocument(new Blob(['x']), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
    })).rejects.toThrow('Failed to save file');
  });
});

// A restore is the one request that does all its work before answering: every
// file copied and hash-checked, then the database staged. On real data that is
// minutes. The shared one-minute request timeout used to abort it, so the
// screen reported a failure while the server was still working.
describe('restoreSnapshot', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('does not abort a restore that runs far past the default request timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => { /* the server is still restoring */ });
    }));
    void restoreSnapshot({ source: 'local', snapshotId: '20260912-020000' }).catch(() => { /* never settles */ });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(signal!.aborted).toBe(false);
  });

  it('turns the server 409 into RestoreRunningError rather than a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ error: 'A restore is already running', code: 'restore_running' }),
    }) as unknown as Response));
    await expect(restoreSnapshot({ source: 'local', snapshotId: '20260912-020000' })).rejects.toBeInstanceOf(RestoreRunningError);
  });
});

// Only a project with nothing in it can be deleted (spec
// docs/superpowers/specs/2026-10-07-project-delete-guard-design.md).
describe('project delete guard', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('turns the server 409 project_has_data into ProjectHasDataError carrying what is in it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409,
      json: async () => ({ error: 'project_has_data', message: 'This project has documents or records. Archive it instead.', summary: { documents: 12, invoices: 2 } }),
    }) as unknown as Response));
    const err = await deleteProject('p1').catch(e => e);
    expect(err).toBeInstanceOf(ProjectHasDataError);
    expect(err.summary).toEqual({ documents: 12, invoices: 2 });
  });

  it('deletes an empty project as before', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteProject('p1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('asks the server beforehand', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ canDelete: false, summary: { rfis: 1 } }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    expect(await getProjectDeleteCheck('p1')).toEqual({ canDelete: false, summary: { rfis: 1 } });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/p1/delete-check');
  });
});
