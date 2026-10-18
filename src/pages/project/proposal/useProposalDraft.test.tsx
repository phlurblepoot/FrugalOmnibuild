// src/pages/project/proposal/useProposalDraft.test.tsx
// The editor's state engine, tested without the editor: load + re-derive,
// save (version, nulls, dirty), and the two ways a save can bounce — the
// proposal was locked (sent) or someone else saved first.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/Toast';
import type { Proposal, ProposalLine, ProposalSaveInput } from '../../../utils/store';

const line = (o: Partial<ProposalLine> = {}): ProposalLine => ({
  id: 'l1', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'Mobilization',
  amountCents: 1000000, derivedAmountCents: null, measurementSummary: null, isAlternate: false, ...o,
} as ProposalLine);

const makeProposal = (o: Partial<Proposal> = {}): Proposal => ({
  id: 'p1', projectId: 'proj1', number: 2, revisedFromId: null, revisedFromNumber: null,
  status: 'draft', legacy: false, title: 'Stucco package', validUntil: null,
  fontFamily: 'helvetica', coverNotes: 'Hello', terms: 'Net 30',
  inclusions: ['Scaffolding'], exclusions: ['Paint'], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: true, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 3, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 1000000, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
  lines: [line()], photos: [], attachments: [], ...o,
} as Proposal);

// A takeoff with no measurements left: everything derived from it is now $0.
const project = {
  id: 'proj1', name: 'Test', pages: [], planSets: [],
  takeoffs: [{ id: 't1', name: 'Stucco', color: '#000', type: 'area', unit: 'sqft', costPerUnit: 4 }],
};

const getProposal = vi.fn(async () => makeProposal());
const getProject = vi.fn(async (_id: string) => project);
const saveProposal = vi.fn(async (_id: string, _input: ProposalSaveInput) => ({ version: 4, updatedAt: 500 }));

vi.mock('../../../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/store')>('../../../utils/store');
  return {
    ...actual,
    getProposal,
    getProject,
    getUserPreferences: vi.fn(async () => ({})),
    saveProposal,
    saveUserPreferences: vi.fn(async () => {}),
  };
});

const { ConflictError, ProposalLockedError } = await import('../../../utils/store');
const { useProposalDraft } = await import('./useProposalDraft');

const wrapper = ({ children }: { children: React.ReactNode }) => <ToastProvider>{children}</ToastProvider>;
const mount = async () => {
  const view = renderHook(() => useProposalDraft('proj1', 'p1'), { wrapper });
  await waitFor(() => expect(view.result.current.draft).not.toBeNull());
  return view;
};

describe('useProposalDraft', () => {
  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify({ role: 'admin' }));
    getProposal.mockClear();
    getProject.mockClear();
    saveProposal.mockClear();
    getProposal.mockImplementation(async () => makeProposal());
  });

  it('loads the proposal and flattens its nullable columns for the form', async () => {
    const { result } = await mount();
    expect(result.current.draft).toMatchObject({ title: 'Stucco package', validUntil: '', coverNotes: 'Hello' });
    expect(result.current.dirty).toBe(false);
    expect(result.current.readOnly).toBe(false);
    expect(result.current.totals?.totalCents).toBe(1000000);
  });

  it('re-derives takeoff lines against today\'s takeoffs, which makes the draft dirty', async () => {
    getProposal.mockImplementation(async () => makeProposal({
      lines: [line({ id: 'l2', kind: 'takeoff', takeoffId: 't1', amountCents: 500000, derivedAmountCents: 500000, measurementSummary: '5,000.00 sq ft' })],
    }));
    const { result } = await mount();
    // The takeoff has no measurements left, so the line is worth nothing now.
    expect(result.current.draft?.lines[0].amountCents).toBe(0);
    expect(result.current.dirty).toBe(true);
    expect(result.current.missingTakeoffIds).toEqual([]);
  });

  it('flags a line whose takeoff was deleted instead of zeroing it', async () => {
    getProposal.mockImplementation(async () => makeProposal({
      lines: [line({ id: 'l3', kind: 'takeoff', takeoffId: 'gone', amountCents: 500000, derivedAmountCents: 500000 })],
    }));
    const { result } = await mount();
    expect(result.current.missingTakeoffIds).toEqual(['gone']);
    expect(result.current.draft?.lines[0].amountCents).toBe(500000);
  });

  it('a sent proposal is read-only and refuses to save', async () => {
    getProposal.mockImplementation(async () => makeProposal({ status: 'sent', sentAt: 1 }));
    const { result } = await mount();
    expect(result.current.readOnly).toBe(true);
    await act(async () => { expect(await result.current.save()).toBe(false); });
    expect(saveProposal).not.toHaveBeenCalled();
  });

  it('saves the edited draft at the loaded version, puts the nulls back, and clears dirty', async () => {
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'New notes', title: '  ' }));
    expect(result.current.dirty).toBe(true);

    await act(async () => { expect(await result.current.save()).toBe(true); });
    expect(saveProposal).toHaveBeenCalledTimes(1);
    expect(saveProposal.mock.calls[0][0]).toBe('p1');
    expect(saveProposal.mock.calls[0][1]).toMatchObject({
      version: 3, coverNotes: 'New notes', title: null, validUntil: null,
      lines: [{ kind: 'manual', description: 'Mobilization', amountCents: 1000000 }],
    });
    // Ids/sort order are the server's to assign — array order is the print order.
    expect(saveProposal.mock.calls[0][1].lines[0]).not.toHaveProperty('id');
    expect(result.current.dirty).toBe(false);
    // The bumped version is adopted, so the next save doesn't 409 against itself.
    expect(result.current.proposal?.version).toBe(4);
    // …and so is updatedAt: the document bar compares a generated PDF's
    // createdAt against it, so a stale one would call an old PDF current.
    expect(result.current.proposal?.updatedAt).toBe(500);
  });

  it('a save requested while one is in flight waits on it instead of bouncing', async () => {
    let release = () => {};
    saveProposal.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve({ version: 4, updatedAt: 500 }); }));
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'New notes' }));

    // The Save button starts the write; the document bar's save-then-generate
    // asks for one a moment later. Returning false for the second would make
    // the bar report a failure that never happened.
    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => { first = result.current.save(); second = result.current.save(); });
    await act(async () => { release(); });

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // Nothing changed between the two calls, so one write covers both.
    expect(saveProposal).toHaveBeenCalledTimes(1);
    expect(result.current.dirty).toBe(false);
  });

  it('chains a second write when the draft moved on while the first was in flight', async () => {
    let release = () => {};
    saveProposal.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve({ version: 4, updatedAt: 500 }); }));
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'A' }));

    let first: Promise<boolean> = Promise.resolve(false);
    act(() => { first = result.current.save(); });
    // The estimator keeps typing while A is going out, then the document bar
    // asks to save before generating. Resolving that with A's write would let
    // it render a PDF carrying B against a record that only holds A.
    act(() => result.current.patchDraft({ coverNotes: 'A+B' }));
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => { second = result.current.save(); });

    await act(async () => { release(); });
    expect(await first).toBe(true);
    expect(await second).toBe(true);

    expect(saveProposal).toHaveBeenCalledTimes(2);
    expect(saveProposal.mock.calls[0][1]).toMatchObject({ version: 3, coverNotes: 'A' });
    // The chained write quotes the version the first one just produced, not the
    // one it superseded, and carries the text on screen.
    expect(saveProposal.mock.calls[1][1]).toMatchObject({ version: 4, coverNotes: 'A+B' });
    expect(result.current.dirty).toBe(false);
  });

  it('a draft edited mid-flight stays dirty when nothing saves it after', async () => {
    let release = () => {};
    saveProposal.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve({ version: 4, updatedAt: 500 }); }));
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'A' }));
    let first: Promise<boolean> = Promise.resolve(false);
    act(() => { first = result.current.save(); });
    act(() => result.current.patchDraft({ coverNotes: 'A+B' }));

    await act(async () => { release(); });
    expect(await first).toBe(true);
    // The write carried A; B is still only on screen, so "Saved" would be a lie.
    expect(saveProposal).toHaveBeenCalledTimes(1);
    expect(result.current.dirty).toBe(true);
  });

  it('stays dirty when the chained write fails', async () => {
    let release = () => {};
    saveProposal
      .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ version: 4, updatedAt: 500 }); }))
      .mockRejectedValueOnce(new Error('offline'));
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'A' }));
    let first: Promise<boolean> = Promise.resolve(false);
    act(() => { first = result.current.save(); });
    act(() => result.current.patchDraft({ coverNotes: 'A+B' }));
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => { second = result.current.save(); });

    await act(async () => { release(); });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(saveProposal).toHaveBeenCalledTimes(2);
    expect(result.current.dirty).toBe(true);
    expect(await screen.findByText(/Failed to save the proposal/)).toBeInTheDocument();
  });

  it('a stale save reloads the version that won', async () => {
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'mine' }));
    saveProposal.mockRejectedValueOnce(new ConflictError('p1'));

    await act(async () => { expect(await result.current.save()).toBe(false); });
    expect(await screen.findByText(/Someone else saved first/)).toBeInTheDocument();
    await waitFor(() => expect(getProposal).toHaveBeenCalledTimes(2));
  });

  it('a save against a locked (already sent) proposal says so and reloads it', async () => {
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'too late' }));
    saveProposal.mockRejectedValueOnce(new ProposalLockedError());

    await act(async () => { expect(await result.current.save()).toBe(false); });
    expect(await screen.findByText(/no longer a draft/)).toBeInTheDocument();
    await waitFor(() => expect(getProposal).toHaveBeenCalledTimes(2));
  });

  it('refreshMedia picks up new photos without discarding the unsaved draft', async () => {
    const { result } = await mount();
    act(() => result.current.patchDraft({ coverNotes: 'half-typed notes' }));
    expect(result.current.dirty).toBe(true);

    // The photo card just uploaded a photo; the server now returns it (and a
    // bumped version, defensively — addPhoto doesn't bump today).
    getProposal.mockImplementation(async () => makeProposal({
      version: 7,
      photos: [{ id: 'pp1', fileId: 'ph1', sortOrder: 0, caption: null }],
      photoCount: 1,
      coverNotes: 'Hello', // the SERVER's stale text — must not win
    }));
    act(() => result.current.refreshMedia());

    await waitFor(() => expect(result.current.proposal?.photos).toHaveLength(1));
    expect(result.current.draft?.coverNotes).toBe('half-typed notes');
    expect(result.current.dirty).toBe(true);
    // and the next save goes out at the refreshed version, not the stale one
    await act(async () => { expect(await result.current.save()).toBe(true); });
    expect(saveProposal.mock.calls[0][1]).toMatchObject({ version: 7, coverNotes: 'half-typed notes' });
  });

  it('refreshMedia leaves a pristine draft alone too (it never touches draft/dirty)', async () => {
    const { result } = await mount();
    expect(result.current.dirty).toBe(false);
    getProposal.mockImplementation(async () => makeProposal({ attachmentCount: 1 }));
    act(() => result.current.refreshMedia());
    await waitFor(() => expect(result.current.proposal?.attachmentCount).toBe(1));
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft?.coverNotes).toBe('Hello');
  });

  it('keeps the saved lines and warns when the project (and so the takeoffs) will not load', async () => {
    getProposal.mockImplementation(async () => makeProposal({
      lines: [line({ id: 'l2', kind: 'takeoff', takeoffId: 't1', amountCents: 500000, derivedAmountCents: 500000 })],
    }));
    getProject.mockRejectedValueOnce(new Error('offline'));
    const { result } = await mount();
    expect(result.current.draft?.lines[0].amountCents).toBe(500000);
    expect(result.current.missingTakeoffIds).toEqual([]);
    expect(result.current.dirty).toBe(false);
    expect(await screen.findByText(/amounts not refreshed/)).toBeInTheDocument();
  });
});
