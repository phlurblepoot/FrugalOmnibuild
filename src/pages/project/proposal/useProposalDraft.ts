// src/pages/project/proposal/useProposalDraft.ts
// The proposal editor's state engine: load → re-derive against today's
// takeoffs → edit → save (with version/lock/conflict handling), plus the
// per-user text histories that seed the next proposal. ProposalEditor.tsx is
// left as a layout host over this hook.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ConflictError, ProposalLockedError,
  getProject, getProposal, getUserPreferences, saveProposal, saveUserPreferences,
  type PaymentScheduleRow, type Proposal, type ProposalLine,
} from '../../../utils/store';
import type { Project } from '../../../types';
import { computeRevisionModel } from '../../../utils/planSets';
import { useToast } from '../../../components/Toast';
import { useCollabEditing, type CollabEditingState } from '../../../hooks/useCollabEditing';
import { computeTakeoffTotals, normalizeHighlightQuality, type HighlightQuality, type TakeoffTotals } from './proposalGenerator';
import { proposalTotals, rederiveLines } from './proposalMath';
import { parseHistory, pushHistory } from './proposalTextHistory';
import { PREF_KEYS, parseLineLibrary, pushLineLibrary, type ManualLineMemory } from './proposalPrefs';
import type { ProposalOptionsValue } from './ProposalOptionsCard';

export const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

// The editable shape. Nullable server columns are flattened to '' here so
// every input stays controlled; save() puts the nulls back.
export interface Draft {
  title: string;
  validUntil: string;
  fontFamily: NonNullable<Proposal['fontFamily']>;
  coverNotes: string;
  terms: string;
  inclusions: string[];
  exclusions: string[];
  paymentSchedule: PaymentScheduleRow[] | null;
  showGrandTotal: boolean;
  includeCostDetail: boolean;
  includeSignature: boolean;
  highlightQuality: HighlightQuality;
  lines: ProposalLine[];
}

const draftFrom = (p: Proposal, lines: ProposalLine[]): Draft => ({
  title: p.title ?? '',
  validUntil: p.validUntil ?? '',
  fontFamily: p.fontFamily ?? 'helvetica',
  coverNotes: p.coverNotes ?? '',
  terms: p.terms ?? '',
  inclusions: p.inclusions ?? [],
  exclusions: p.exclusions ?? [],
  paymentSchedule: p.paymentSchedule,
  showGrandTotal: p.showGrandTotal,
  includeCostDetail: p.includeCostDetail,
  includeSignature: p.includeSignature,
  highlightQuality: normalizeHighlightQuality(p.highlightQuality),
  lines,
});

// A line the re-derive touched: the takeoff moved under the proposal since it
// was last saved, so the draft is dirty before the estimator types anything.
const linesDiffer = (a: ProposalLine[], b: ProposalLine[]) =>
  a.length !== b.length || a.some((l, i) =>
    l.amountCents !== b[i].amountCents ||
    l.derivedAmountCents !== b[i].derivedAmountCents ||
    l.measurementSummary !== b[i].measurementSummary);

export interface ProposalDraftState {
  project: Project | null;
  proposal: Proposal | null;
  draft: Draft | null;
  missingTakeoffIds: string[];
  dirty: boolean;
  saving: boolean;
  loadFailed: boolean;
  /** Sent/accepted/declined or imported — a historical record, not editable. */
  readOnly: boolean;
  takeoffTotals: TakeoffTotals[];
  totals: ReturnType<typeof proposalTotals> | null;
  notesHistory: string[];
  termsHistory: string[];
  inclusionsHistory: string[];
  exclusionsHistory: string[];
  lineLibrary: ManualLineMemory[];
  collab: CollabEditingState;
  patchDraft: (patch: Partial<Draft>) => void;
  applyOptions: (patch: Partial<ProposalOptionsValue>) => void;
  /**
   * Writes the draft. Resolves true only when the server took it; false when
   * the save did not happen at all — nothing editable (no draft / read-only)
   * or the server rejected it (lock/conflict, which also reloads). Called while
   * a write is already in flight it waits for that write instead of bouncing —
   * and if the draft moved on while it was going out, sends one more so the
   * record matches the screen. That is what lets the document bar's
   * save-then-generate trust that the PDF it renders is the PDF on file.
   */
  save: () => Promise<boolean>;
  reload: () => void;
  /**
   * Re-fetches the server-owned parts of the proposal the photo/attachment
   * cards mutate — photos, attachments, version — WITHOUT touching `draft` or
   * `dirty`. Adding a photo must never throw away unsaved cover notes or price
   * lines (photos and attachments aren't part of Draft at all), so this is
   * what those cards call instead of reload().
   */
  refreshMedia: () => void;
}

export function useProposalDraft(projectId?: string, proposalId?: string): ProposalDraftState {
  const { toast } = useToast();
  const admin = isAdmin();

  const [project, setProject] = useState<Project | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [missingTakeoffIds, setMissingTakeoffIds] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const [notesHistory, setNotesHistory] = useState<string[]>([]);
  const [termsHistory, setTermsHistory] = useState<string[]>([]);
  const [inclusionsHistory, setInclusionsHistory] = useState<string[]>([]);
  const [exclusionsHistory, setExclusionsHistory] = useState<string[]>([]);
  const [lineLibrary, setLineLibrary] = useState<ManualLineMemory[]>([]);

  // useCollabEditing reads dirtiness from a callback on every foreign event,
  // long after this render closed over it — a ref keeps it current.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const loadRef = useRef<() => void>(() => {});
  const load = () => {
    if (!projectId || !proposalId || !admin) return;
    Promise.all([getProposal(proposalId), getProject(projectId).catch(() => null)])
      .then(([p, proj]) => {
        setProject(proj);
        setProposal(p);
        setLoadFailed(false);
        const editable = p.status === 'draft' && !p.legacy;
        if (!editable) {
          setDraft(draftFrom(p, p.lines));
          setMissingTakeoffIds([]);
          setDirty(false);
          return;
        }
        // Without the project there are no takeoffs to compare against, and a
        // re-derive would flag EVERY takeoff line as "no longer exists" —
        // offering to delete real work because one fetch failed. Leave the
        // saved lines alone and say so instead.
        if (!proj) {
          setDraft(draftFrom(p, p.lines));
          setMissingTakeoffIds([]);
          setDirty(false);
          toast("Couldn't load takeoffs — amounts not refreshed", { type: 'warning' });
          return;
        }
        // Re-derive against the CURRENT takeoffs so a draft always prices the
        // work as it stands today; overridden lines keep their hand-set
        // amount (proposalMath.rederiveLines), and takeoffs that vanished are
        // flagged rather than silently zeroed.
        const totals = computeTakeoffTotals(proj, computeRevisionModel(proj, '').currentPageIds);
        const { lines, missingTakeoffIds: missing } = rederiveLines(p.lines, totals);
        setDraft(draftFrom(p, lines));
        setMissingTakeoffIds(missing);
        setDirty(linesDiffer(lines, p.lines));
      })
      .catch(() => setLoadFailed(true));
  };
  loadRef.current = load;
  const reload = () => loadRef.current();

  // Media-only resync (see refreshMedia in ProposalDraftState). Adopting the
  // fetched version matters if the server ever starts bumping on a photo add —
  // it doesn't today (server/proposalStore.ts addPhoto/addAttachment skip
  // bump()), but the next save would 409 against itself if it ever did.
  const refreshMedia = () => {
    if (!proposalId || !admin) return;
    getProposal(proposalId)
      .then(p => { setProposal(p); setLoadFailed(false); })
      .catch(() => { /* the card that triggered this toasts its own failure */ });
  };

  useEffect(() => { loadRef.current(); }, [projectId, proposalId]);

  useEffect(() => {
    getUserPreferences()
      .then(prefs => {
        setNotesHistory(parseHistory(prefs[PREF_KEYS.notes]));
        setTermsHistory(parseHistory(prefs[PREF_KEYS.terms]));
        setInclusionsHistory(parseHistory(prefs[PREF_KEYS.inclusions]));
        setExclusionsHistory(parseHistory(prefs[PREF_KEYS.exclusions]));
        setLineLibrary(parseLineLibrary(prefs[PREF_KEYS.lines]));
      })
      .catch(() => { /* offline — the editor just has no remembered text */ });
  }, []);

  // Presence + the "someone else saved" banner. A pristine editor silently
  // reloads; a dirty one keeps the estimator's work and offers Review & merge
  // / Keep mine rather than clobbering it.
  const collab = useCollabEditing({
    type: 'proposal',
    id: proposalId ?? '',
    isDirty: () => dirtyRef.current,
    onFresh: () => loadRef.current(),
    enabled: admin,
  });

  const takeoffTotals = useMemo(
    () => (project ? computeTakeoffTotals(project, computeRevisionModel(project, '').currentPageIds) : []),
    [project],
  );

  const readOnly = !proposal || proposal.status !== 'draft' || proposal.legacy;
  const totals = draft ? proposalTotals(draft.lines) : null;

  const patchDraft = (patch: Partial<Draft>) => {
    setDraft(d => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  // The options card speaks the server's nullable shape; the draft keeps ''.
  const applyOptions = (patch: Partial<ProposalOptionsValue>) => {
    const next: Partial<Draft> = {};
    if (patch.title !== undefined) next.title = patch.title ?? '';
    if (patch.validUntil !== undefined) next.validUntil = patch.validUntil ?? '';
    if (patch.fontFamily !== undefined) next.fontFamily = patch.fontFamily ?? 'helvetica';
    if (patch.includeCostDetail !== undefined) next.includeCostDetail = patch.includeCostDetail;
    if (patch.includeSignature !== undefined) next.includeSignature = patch.includeSignature;
    if (patch.highlightQuality !== undefined) next.highlightQuality = patch.highlightQuality;
    patchDraft(next);
  };

  // What this user just wrote becomes their defaults next time: the four text
  // histories, the manual-line library, and the document options. Never
  // throws — a preferences hiccup must not make a successful save look failed.
  const recordMemories = async (saved: Draft) => {
    try {
      const prefs = await getUserPreferences();
      const out: Record<string, string> = {};
      const text = (key: string, value: string, setter: (h: string[]) => void) => {
        const before = parseHistory(prefs[key]);
        const after = pushHistory(before, value);
        if (after !== before) { out[key] = JSON.stringify(after); setter(after); }
      };
      text(PREF_KEYS.notes, saved.coverNotes, setNotesHistory);
      text(PREF_KEYS.terms, saved.terms, setTermsHistory);
      text(PREF_KEYS.inclusions, saved.inclusions.join('\n'), setInclusionsHistory);
      text(PREF_KEYS.exclusions, saved.exclusions.join('\n'), setExclusionsHistory);

      const before = parseLineLibrary(prefs[PREF_KEYS.lines]);
      let library = before;
      for (const l of saved.lines) {
        if (l.kind === 'manual' && l.description.trim()) {
          library = pushLineLibrary(library, { description: l.description, amountCents: l.amountCents });
        }
      }
      if (library !== before) { out[PREF_KEYS.lines] = JSON.stringify(library); setLineLibrary(library); }

      out[PREF_KEYS.font] = saved.fontFamily;
      out[PREF_KEYS.quality] = saved.highlightQuality;
      out[PREF_KEYS.costDetail] = String(saved.includeCostDetail);
      out[PREF_KEYS.signature] = String(saved.includeSignature);
      out[PREF_KEYS.grandTotal] = String(saved.showGrandTotal);
      await saveUserPreferences(out);
    } catch { /* non-fatal */ }
  };

  // The Save button is no longer the only caller: the document bar saves first
  // before it generates. A second call while a write is in flight must neither
  // report a failure that never happened nor let the bar generate a PDF of text
  // that write never carried — so callers queue instead of bouncing.
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  // What the in-flight write is carrying, plus the current draft/record and the
  // version the NEXT write must quote. These are refs, not state: a chained
  // save runs in the microtask after the first resolves, long before React has
  // re-rendered, and quoting the version it just superseded would 409.
  const sentRef = useRef<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const proposalRef = useRef<Proposal | null>(null);
  const savedVersionRef = useRef<number | null>(null);
  draftRef.current = draft;
  proposalRef.current = proposal;

  const runSave = async (sent: Draft, target: Proposal, version: number): Promise<boolean> => {
    sentRef.current = sent;
    setSaving(true);
    try {
      const { version: newVersion, updatedAt } = await saveProposal(target.id, {
        version,
        title: sent.title.trim() || null,
        validUntil: sent.validUntil || null,
        fontFamily: sent.fontFamily,
        coverNotes: sent.coverNotes,
        terms: sent.terms,
        inclusions: sent.inclusions,
        exclusions: sent.exclusions,
        paymentSchedule: sent.paymentSchedule,
        showGrandTotal: sent.showGrandTotal,
        includeCostDetail: sent.includeCostDetail,
        includeSignature: sent.includeSignature,
        highlightQuality: sent.highlightQuality,
        // Ids and sort order are the server's to assign: array order IS the
        // print order.
        lines: sent.lines.map(({ id: _id, sortOrder: _sortOrder, ...rest }) => rest),
      });
      savedVersionRef.current = newVersion;
      // updatedAt matters as much as version here: it is what the document bar
      // compares a generated PDF's createdAt against, so keeping the pre-save
      // timestamp would leave a just-edited proposal claiming its old PDF is
      // still current — and Send would email that stale PDF.
      setProposal(prev => (prev ? { ...prev, version: newVersion, updatedAt } : prev));
      // Only the draft that actually went out is saved. If the estimator typed
      // while this write was in flight, the screen still holds text the server
      // has never seen, and showing "Saved" would be a lie.
      if (draftRef.current === sent) setDirty(false);
      toast('Proposal saved', { type: 'success' });
      void recordMemories(sent);
      return true;
    } catch (e) {
      if (e instanceof ProposalLockedError) {
        toast('This proposal is no longer a draft — revise it to make changes', { type: 'error' });
        load();
      } else if (e instanceof ConflictError) {
        toast('Someone else saved first — reloading their version', { type: 'error' });
        load();
      } else {
        toast('Failed to save the proposal', { type: 'error' });
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  // runSave never rejects (every failure path returns false), so neither the
  // chaining below nor the cleanup can strand an unhandled rejection.
  const track = (run: Promise<boolean>): Promise<boolean> => {
    inFlightRef.current = run;
    void run.finally(() => { if (inFlightRef.current === run) inFlightRef.current = null; });
    return run;
  };

  const save = (): Promise<boolean> => {
    const pending = inFlightRef.current;
    if (pending) {
      // Wait for the write already going out; if the draft moved on while it
      // was in flight, send ONE more so the record matches the screen before
      // the caller (the document bar) renders it. One chained write, never a
      // recursion — a further edit rides the next save.
      return track(pending.then(ok => {
        const d = draftRef.current;
        const target = proposalRef.current;
        if (!ok || !d || !target || readOnly || d === sentRef.current) return ok;
        return runSave(d, target, savedVersionRef.current ?? target.version);
      }));
    }
    if (!draft || !proposal || readOnly) return Promise.resolve(false);
    // "Keep mine" adopts the foreign version so this save overwrites it
    // deliberately instead of bouncing off a stale-version 409.
    return track(runSave(draft, proposal, collab.keepMineVersion ?? proposal.version));
  };

  return {
    project, proposal, draft, missingTakeoffIds, dirty, saving, loadFailed, readOnly,
    takeoffTotals, totals,
    notesHistory, termsHistory, inclusionsHistory, exclusionsHistory, lineLibrary,
    collab, patchDraft, applyOptions, save, reload, refreshMedia,
  };
}
