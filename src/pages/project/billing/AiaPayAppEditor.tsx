// src/pages/project/billing/AiaPayAppEditor.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AiaPayAppDetail, AiaPayAppLine, AiaG703Row, AiaG702,
  getPayApp, getProject, savePayAppLines, sendPayApp, setPayApp, lineTypeOf,
} from '../../../utils/store';
import { itemSendPayload } from '../../../utils/itemSend';
import { useGeneratedDocument } from '../../../hooks/useGeneratedDocument';
import { useItemEmailDefaults } from '../../../hooks/useItemEmailDefaults';
import { PayAppPdfControls } from './PayAppPdfControls';
import { LienReleaseLauncher } from './LienReleaseLauncher';
import { buildAiaXlsxBlob } from './aiaExcel';
import { resolveAiaExportEnv } from './aiaExportShared';
import { formatMoney, dollarsToCents, centsToDollars } from '../../../utils/money';
import { formatBillingDate } from '../../../utils/billingDates';
import { useToast } from '../../../components/Toast';
import {
  Button, Field, Input, NumberInput, Modal, Select, StatusPill, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import type { PillTone } from '../../../components/ui';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { useDiscardGuard } from '../../../components/ui/useDiscardGuard';

const STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  draft:     { label: 'Draft',     tone: 'slate' },
  finalized: { label: 'Finalized', tone: 'emerald' },
};

const STATUS_OPTIONS = ['draft', 'finalized'];

// Retainage points are floats (15 - 8.05 = 6.949999999999999). Everything the
// panel SHOWS — and the value "Release all remaining" types into the input —
// goes through this so no float residue reaches the user.
const fmtPts = (n: number): string => String(+n.toFixed(4));

// Local editable per-line state, keyed by sovLineId.
interface EditLine { percentComplete: string; storedMaterials: string }

// handleSave parses every numeric box before it persists it (a blank or
// unparseable box saves as 0), so the dirty check has to compare the same
// parsed values. A raw string compare made "5" → "5.0" — or a percentage
// retyped to the identical number — look like an unsaved edit, which made the
// document bar save before every generate.
const numOrZero = (v: string): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const normalizeLines = (edits: Record<string, EditLine>): string =>
  JSON.stringify(Object.keys(edits).sort().map(k => [
    k, numOrZero(edits[k].percentComplete), dollarsToCents(edits[k].storedMaterials),
  ]));

export const AiaPayAppEditor: React.FC<{
  payAppId: string;
  onClose: () => void;
  onSaved: () => void;
}> = ({ payAppId, onClose, onSaved }) => {
  const { toast } = useToast();

  const [data, setData] = useState<{ app: AiaPayAppDetail; lines: AiaPayAppLine[]; g703: AiaG703Row[]; g702: AiaG702 } | null>(null);
  const [saving, setSaving] = useState(false);

  // Emailing the pay app (ONLYOFFICE Phase 4): the same billing recipients as
  // an invoice, and its PDF ("Make PDF") pre-attached when it is current.
  const projectId = data?.app.projectId;
  const emailDefaults = useItemEmailDefaults('invoice', projectId);
  const [projectName, setProjectName] = useState('');
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    getProject(projectId).then(p => { if (live) setProjectName(p?.name ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);
  // Make PDF may regenerate the workbook itself; the document bar doesn't hear
  // about a change this tab made, so it is remounted to re-read its status.
  const [barKey, setBarKey] = useState(0);
  const pdfDoc = useGeneratedDocument({
    sourceType: 'payapp', sourceId: payAppId, kind: 'payapp-pdf', updatedAt: data?.app.updatedAt, enabled: !!data,
  });

  // Editable per-line inputs, seeded once per load (re-seeded on reload).
  const [edits, setEdits] = useState<Record<string, EditLine>>({});

  // Editable app fields.
  const [periodTo, setPeriodTo] = useState('');
  const [applicationDate, setApplicationDate] = useState('');
  const [releasedRetainagePoints, setReleasedRetainagePoints] = useState('');
  const [status, setStatus] = useState('draft');

  // Snapshot of the values `seed` last set, so `dirty` can compare current
  // (possibly hand-edited) state against what was last loaded — without
  // re-deriving the per-line seed shape from `data` on every render.
  const pristineRef = useRef<{
    edits: Record<string, EditLine>;
    periodTo: string;
    applicationDate: string;
    releasedRetainagePoints: string;
    status: string;
  }>({ edits: {}, periodTo: '', applicationDate: '', releasedRetainagePoints: '', status: 'draft' });

  const seed = useCallback((d: { app: AiaPayAppDetail; lines: AiaPayAppLine[]; g703: AiaG703Row[]; g702: AiaG702 }) => {
    const byLine: Record<string, AiaPayAppLine> = {};
    for (const l of d.lines) byLine[l.sovLineId] = l;
    const next: Record<string, EditLine> = {};
    for (const row of d.g703) {
      if (lineTypeOf(row) !== 'item') continue;
      const line = byLine[row.sovLineId];
      next[row.sovLineId] = {
        percentComplete: line ? String(line.percentComplete) : String(row.percentComplete ?? 0),
        storedMaterials: line ? String(centsToDollars(line.storedMaterialsCents)) : String(centsToDollars(row.storedCents ?? 0)),
      };
    }
    const periodToNext = d.app.periodTo ?? '';
    const applicationDateNext = d.app.applicationDate ?? '';
    const releasedRetainagePointsNext = String(d.app.releasedRetainagePoints ?? 0);
    const statusNext = d.app.status ?? 'draft';
    setEdits(next);
    setPeriodTo(periodToNext);
    setApplicationDate(applicationDateNext);
    setReleasedRetainagePoints(releasedRetainagePointsNext);
    setStatus(statusNext);
    pristineRef.current = {
      edits: next, periodTo: periodToNext, applicationDate: applicationDateNext,
      releasedRetainagePoints: releasedRetainagePointsNext, status: statusNext,
    };
  }, []);

  const load = useCallback(() => {
    getPayApp(payAppId).then(d => { setData(d); seed(d); }).catch(() => toast('Failed to load pay application', { type: 'error' }));
  }, [payAppId, seed, toast]);

  useEffect(() => { load(); }, [load]);

  // Mirrors handleSave's own rule for the release box: an unparseable value
  // is skipped there rather than saved, so it isn't an edit here either —
  // otherwise a typo would leave the editor permanently "unsaved".
  const releaseNum = releasedRetainagePoints.trim() === '' ? 0 : parseFloat(releasedRetainagePoints);
  const releaseDirty =
    Number.isFinite(releaseNum) && releaseNum !== numOrZero(pristineRef.current.releasedRetainagePoints);

  const dirty =
    periodTo !== pristineRef.current.periodTo ||
    applicationDate !== pristineRef.current.applicationDate ||
    releaseDirty ||
    status !== pristineRef.current.status ||
    normalizeLines(edits) !== normalizeLines(pristineRef.current.edits);
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({
    type: 'aiaPayApp',
    id: payAppId,
    isDirty: () => dirty,
    onFresh: load,
  });

  const isFinalized = (data?.app.status ?? status) === 'finalized';

  const setEdit = (sovLineId: string, patch: Partial<EditLine>) =>
    setEdits(prev => ({ ...prev, [sovLineId]: { ...prev[sovLineId], ...patch } }));

  // Throws rather than swallowing, so the document bar's save-first step can
  // tell a refused save from a successful one and skip generating.
  const handleSave = async () => {
    if (!data) throw new Error('Pay application not loaded');
    setSaving(true);
    try {
      // Persist app-level field changes first (date/retainage-release/status).
      const app = data.app;
      const patch: Record<string, unknown> = {};
      // A cleared box is an explicit "release nothing" (0), not a no-op —
      // otherwise parseFloat('') is NaN and the guard below silently drops the
      // patch, leaving the previous release in place. Genuine garbage still
      // parses to NaN and is still skipped.
      const releaseRaw = releasedRetainagePoints.trim();
      const releasedNum = releaseRaw === '' ? 0 : parseFloat(releaseRaw);
      if ((periodTo || null) !== (app.periodTo ?? null)) patch.periodTo = periodTo || null;
      if ((applicationDate || null) !== (app.applicationDate ?? null)) patch.applicationDate = applicationDate || null;
      if (Number.isFinite(releasedNum) && releasedNum !== (app.releasedRetainagePoints ?? 0)) patch.releasedRetainagePoints = releasedNum;
      if (status !== app.status) patch.status = status;
      // setPayApp bumps the pay app's version, so the version used for the
      // line save below must be its returned version, not the stale one this
      // component loaded with — otherwise the line save 409s against its own
      // just-applied patch. "Keep mine" adopts the remote version as the new
      // starting point instead of this component's stale loaded version.
      let version = collab.keepMineVersion !== null ? collab.keepMineVersion : app.version;
      if (Object.keys(patch).length > 0) {
        ({ version } = await setPayApp(payAppId, patch));
      }

      // Persist line edits (version-checked). Header/blank rows carry no
      // edits (seed skips them) and no inputs, so they're excluded here too.
      const lines = data.g703.filter(row => lineTypeOf(row) === 'item').map(row => {
        const e = edits[row.sovLineId];
        const pct = e ? parseFloat(e.percentComplete) : row.percentComplete;
        return {
          sovLineId: row.sovLineId,
          percentComplete: Number.isFinite(pct) ? pct : 0,
          storedMaterialsCents: e ? dollarsToCents(e.storedMaterials) : row.storedCents,
        };
      });
      await savePayAppLines(payAppId, lines, version);

      toast('Pay application saved', { type: 'success' });
      load(); // refetch + re-seed so G702/G703 + version reflect saved state
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError'
        ? 'Pay application changed elsewhere — reopen it'
        : 'Save failed', { type: 'error' });
      throw e;
    } finally {
      setSaving(false);
    }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave(); return true; } catch { return false; }
  };

  const handleFinalize = async () => {
    if (!data) return;
    try {
      await setPayApp(payAppId, { status: 'finalized' });
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse' } }));
      toast('Pay application finalized', { type: 'success' });
      load();
      onSaved();
    } catch {
      toast('Failed to finalize', { type: 'error' });
    }
  };

  // The G702/G703 workbook the document bar stores as this pay app's living
  // Excel document. Built from a FRESH read of the saved pay app — the bar
  // commits first, and re-reading here is what keeps the stored workbook from
  // disagreeing with the record it claims to represent (the server recomputes
  // D/E/G/retainage on save, so this component's loaded copy is stale the
  // moment anything changes). A failed re-read throws on purpose: the bar
  // reports it and keeps the existing document rather than quietly storing
  // pre-save numbers and marking them current.
  //
  // If the admin has configured an app-wide template (settings.aiaTemplateFileId
  // + aiaTemplateMapping) its cells are filled; otherwise the built-in
  // recreation is used, including when a configured template fails to load.
  const buildPayAppXlsx = async (): Promise<Blob> => {
    const saved = await getPayApp(payAppId);
    if (!saved?.app) throw new Error('Pay application not found');
    const env = await resolveAiaExportEnv(saved.app.projectId);
    if (env.templateLoadFailed) {
      toast('AIA template failed to load — exporting the standard G702/G703 instead', { type: 'warning' });
    }
    return buildAiaXlsxBlob({
      projectName: env.project?.name ?? 'Project',
      contractor: env.project?.contractor ?? undefined,
      company: env.company,
      aiaSettings: env.aiaSettings,
      app: saved.app,
      sovLines: env.sovLines,
      g702: saved.g702,
      g703: saved.g703,
    }, env.template);
  };

  // Light client-side preview of Total to Date (G = scheduled*% /100 + stored).
  const previewG = useMemo(() => {
    const map: Record<string, number> = {};
    if (!data) return map;
    for (const row of data.g703) {
      if (lineTypeOf(row) !== 'item') continue;
      const e = edits[row.sovLineId];
      const pct = e ? parseFloat(e.percentComplete) : row.percentComplete;
      const storedCents = e ? dollarsToCents(e.storedMaterials) : row.storedCents;
      const completed = Math.round(row.scheduledValueCents * (Number.isFinite(pct) ? pct : 0) / 100);
      map[row.sovLineId] = completed + storedCents;
    }
    return map;
  }, [data, edits]);

  const g702 = data?.g702;

  // Paid/balance for the read-only Payments section below. Derived from the
  // GET payload (data.app.payments + g702.L8) rather than a server-provided
  // field — matches the list's balance rule: drafts aren't billed yet, so
  // balance is null ("—") even though payments could technically exist.
  const payments = data?.app.payments ?? [];
  const paymentsPaidCents = useMemo(
    () => payments.reduce((a, p) => a + Math.round((Number(p.amount) || 0) * 100), 0),
    [data],
  );
  const paymentsBalanceCents = isFinalized && g702 ? g702.L8currentPaymentDueCents - paymentsPaidCents : null;

  return (
    <Modal
      open
      onClose={onClose}
      dirty={dirty}
      title={data ? `Application for payment #${data.app.number}` : 'Application for payment'}
      width="full"
      footer={<>
        {/* Mounted only once the pay app has loaded: the bar needs the record's
            project, number and updatedAt, and persisting against a half-known
            record would file the workbook under the wrong project. */}
        {data && (
          <div className="mr-auto flex flex-wrap items-center gap-2">
            <DocumentActionsBar
              key={barKey}
              source={{ sourceType: 'payapp', sourceId: data.app.id }}
              kind="payapp-export"
              format="xlsx"
              projectId={data.app.projectId}
              fileName={`Pay App #${data.app.number} — G702.xlsx`}
              build={buildPayAppXlsx}
              dirty={dirty}
              save={saveForDocument}
              updatedAt={data.app.updatedAt}
              size="sm"
              send={{
                blockedReason: emailDefaults.sendBlockedReason,
                composer: {
                  title: 'Send pay application',
                  defaultTo: emailDefaults.defaultTo || undefined,
                  defaultCc: emailDefaults.defaultCc || undefined,
                  defaultBcc: emailDefaults.defaultBcc || undefined,
                  defaultSubject: `Application for Payment #${data.app.number}${projectName ? ` — ${projectName}` : ''}`,
                  defaultBody: `Hello,\n\nPlease find attached Application for Payment #${data.app.number}${projectName ? ` for ${projectName}` : ''}.\n\nThank you.`,
                  // Its PDF rides along when it matches the pay app; an older
                  // one would disagree with the workbook.
                  extraAttachments: pdfDoc.file && pdfDoc.upToDate
                    ? [{ fileId: pdfDoc.file.id, name: pdfDoc.file.name ?? `Pay App #${data.app.number}.pdf`, size: pdfDoc.file.size }]
                    : undefined,
                },
                sendFn: (fileId, req) => sendPayApp(data.app.id, { ...itemSendPayload(req), fileId }),
              }}
            />
            <LienReleaseLauncher projectId={data.app.projectId} source={{ sourceType: 'payapp', sourceId: data.app.id }} testId="payapp-lien-release" />
          </div>
        )}
        {data && (
          <PayAppPdfControls
            payAppId={data.app.id}
            projectId={data.app.projectId}
            pdf={pdfDoc}
            dirty={dirty}
            save={saveForDocument}
            buildWorkbook={buildPayAppXlsx}
            workbookName={`Pay App #${data.app.number} — G702.xlsx`}
            onWorkbookChanged={() => setBarKey(k => k + 1)}
          />
        )}
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        {!isFinalized && (
          <Button variant="secondary" onClick={handleFinalize} disabled={saving}>Finalize</Button>
        )}
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving || isFinalized}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      {!data ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-9" />)}</div>
      ) : (
        <div className="space-y-5">
          {/* Application fields */}
          <div className="flex items-center gap-2">
            <StatusPill tone={STATUS_META[status]?.tone ?? 'slate'}>{STATUS_META[status]?.label ?? status}</StatusPill>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Period to" htmlFor="pa-period"><Input id="pa-period" type="date" value={periodTo} onChange={e => setPeriodTo(e.target.value)} disabled={isFinalized} /></Field>
            <Field label="Application date" htmlFor="pa-date"><Input id="pa-date" type="date" value={applicationDate} onChange={e => setApplicationDate(e.target.value)} disabled={isFinalized} /></Field>
            <Field label="Status" htmlFor="pa-status">
              <Select id="pa-status" value={status} onChange={e => setStatus(e.target.value)} disabled={isFinalized}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_META[s]?.label ?? s}</option>)}
              </Select>
            </Field>
          </div>

          {/* Retainage panel — rates are read-only facts snapshotted from
              settings/SOV at app creation; the only editable control here is
              how many points to release on this application. */}
          <div className="rounded-lg border border-edge p-4">
            <h4 className="mb-2 text-sm font-semibold text-ink">Retainage</h4>
            <p className="mb-3 text-sm text-ink-soft">
              {data.g702.retainage.mode === 'perLine'
                ? <>Per-line rates (see Schedule of Values) · Released {fmtPts(data.g702.retainage.cumulativeReleasedPoints)}%</>
                : <>Base {fmtPts(data.g702.retainage.baseWorkPercent)}% · Released {fmtPts(data.g702.retainage.cumulativeReleasedPoints)}% · Effective {fmtPts(data.g702.retainage.effectiveWorkPercent ?? 0)}%</>}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Release retainage on this application (% points)" htmlFor="pa-release">
                <NumberInput allowEmpty
                  id="pa-release"
                  value={releasedRetainagePoints}
                  onChange={e => setReleasedRetainagePoints(e.target.value)}
                  disabled={isFinalized}
                  min={0}
                  max={data.g702.retainage.remainingPoints}
                  step="any"
                />
              </Field>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setReleasedRetainagePoints(fmtPts(data.g702.retainage.remainingPoints))}
                disabled={isFinalized}
              >
                Release all remaining ({fmtPts(data.g702.retainage.remainingPoints)}%)
              </Button>
            </div>
          </div>

          {/* G703 grid + G702 summary side-by-side on wide layouts */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          {/* G703 continuation sheet */}
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">G703 continuation sheet</h4>
              <span className="text-xs text-ink-faint">Save to recalc D / E / G / retainage</span>
            </div>
            {/* Desktop: 10-col G703 grid. Owns its own bounded horizontal
                scroll region so a horizontal touch-swipe works on tablets
                without fighting the modal body's vertical scroll. */}
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <THead>
                  <TR>
                    <TH className="w-16">Item</TH><TH className="min-w-[14rem]">Description</TH>
                    <TH className="text-right">Scheduled (C)</TH><TH className="text-right">Previous (D)</TH><TH className="text-right">This period (E)</TH>
                    <TH className="text-right">Stored (F)</TH><TH className="text-right">% (G/C)</TH><TH className="text-right">Total to date (G)</TH>
                    <TH className="text-right">Balance</TH><TH className="text-right">Retainage</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.g703.map(row => {
                    const type = lineTypeOf(row);
                    if (type === 'header') {
                      return (
                        <TR key={row.sovLineId} data-testid={`g703-header-row-${row.sovLineId}`}>
                          <TD className="text-ink-soft">{row.itemNo || ''}</TD>
                          <TD colSpan={9} className="font-semibold text-ink">{row.description}</TD>
                        </TR>
                      );
                    }
                    if (type === 'blank') {
                      return <TR key={row.sovLineId} data-testid={`g703-blank-row-${row.sovLineId}`}><TD colSpan={10} className="h-8" /></TR>;
                    }
                    const e = edits[row.sovLineId] ?? { percentComplete: '0', storedMaterials: '0' };
                    return (
                      <TR key={row.sovLineId}>
                        <TD className="text-ink-soft">{row.itemNo || '—'}</TD>
                        <TD className="font-medium text-ink">
                          {row.description}
                          {row.isChangeOrder ? <span className="ml-2 rounded bg-hover px-1.5 py-0.5 text-xs font-normal text-ink-faint">CO</span> : null}
                        </TD>
                        <TD className="text-right tabular-nums text-ink-soft">{formatMoney(row.scheduledValueCents)}</TD>
                        <TD className="text-right tabular-nums text-ink-soft">{formatMoney(row.previousCents)}</TD>
                        <TD className="text-right tabular-nums text-ink-soft">{formatMoney(row.thisPeriodCents)}</TD>
                        <TD className="w-32">
                          <NumberInput allowEmpty
                            className="text-right tabular-nums"
                            value={e.storedMaterials}
                            onChange={ev => setEdit(row.sovLineId, { storedMaterials: ev.target.value })}
                            disabled={isFinalized}
                            placeholder="0.00"
                          />
                        </TD>
                        <TD className="w-32">
                          <NumberInput allowEmpty
                            data-testid={`pa-pct-${row.sovLineId}`}
                            className="text-right tabular-nums w-full"
                            value={e.percentComplete}
                            onChange={ev => setEdit(row.sovLineId, { percentComplete: ev.target.value })}
                            disabled={isFinalized}
                            min={0}
                            max={100}
                          />
                        </TD>
                        <TD className="text-right tabular-nums text-ink-soft">
                          {formatMoney(row.totalToDateCents)}
                          {previewG[row.sovLineId] !== row.totalToDateCents && (
                            <span className="ml-1 text-xs text-ink-faint" title="Unsaved preview">→ {formatMoney(previewG[row.sovLineId])}</span>
                          )}
                        </TD>
                        <TD className="text-right tabular-nums text-ink-soft">{formatMoney(row.balanceToFinishCents)}</TD>
                        <TD className="text-right tabular-nums text-ink-soft">{formatMoney(row.retainageCents)}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>

            {/* Phone: per-line stacked card editor. Renders the SAME g703 rows
                and binds to the SAME edits/setEdit state + previewG memo as the
                desktop table above — no parallel state and no duplicated math
                (all computed values come from row.*Cents / previewG, identical
                to the table). So the G702 summary reconciles identically. */}
            <div className="space-y-3 md:hidden">
              {data.g703.map(row => {
                const type = lineTypeOf(row);
                if (type === 'header') return <div key={row.sovLineId} data-testid={`g703-header-card-${row.sovLineId}`} className="px-1 pt-2 text-sm font-semibold text-ink">{row.description}</div>;
                if (type === 'blank') return <div key={row.sovLineId} data-testid={`g703-blank-card-${row.sovLineId}`} className="h-3" />;
                const e = edits[row.sovLineId] ?? { percentComplete: '0', storedMaterials: '0' };
                return (
                  <div key={row.sovLineId} className="rounded-lg border border-edge p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="font-medium text-ink">
                        {row.description}
                        {row.isChangeOrder ? <span className="ml-2 rounded bg-hover px-1.5 py-0.5 text-xs font-normal text-ink-faint">CO</span> : null}
                      </div>
                      <div className="shrink-0 text-xs text-ink-faint">{row.itemNo || '—'}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      <div className="text-ink-faint">Scheduled (C)</div>
                      <div className="text-right tabular-nums text-ink-soft">{formatMoney(row.scheduledValueCents)}</div>
                      <div className="text-ink-faint">Previous (D)</div>
                      <div className="text-right tabular-nums text-ink-soft">{formatMoney(row.previousCents)}</div>
                      <div className="text-ink-faint">This period (E)</div>
                      <div className="text-right tabular-nums text-ink-soft">{formatMoney(row.thisPeriodCents)}</div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Stored (F)" htmlFor={`pa-stored-${row.sovLineId}`}>
                        <NumberInput allowEmpty
                          id={`pa-stored-${row.sovLineId}`}
                          className="text-right tabular-nums"
                          value={e.storedMaterials}
                          onChange={ev => setEdit(row.sovLineId, { storedMaterials: ev.target.value })}
                          disabled={isFinalized}
                          placeholder="0.00"
                        />
                      </Field>
                      <Field label="% complete (G/C)" htmlFor={`pa-pct-${row.sovLineId}`}>
                        <NumberInput allowEmpty
                          id={`pa-pct-${row.sovLineId}`}
                          className="text-right tabular-nums"
                          value={e.percentComplete}
                          onChange={ev => setEdit(row.sovLineId, { percentComplete: ev.target.value })}
                          disabled={isFinalized}
                          min={0}
                          max={100}
                        />
                      </Field>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-edge pt-3 text-sm">
                      <div className="text-ink-faint">Total to date (G)</div>
                      <div className="text-right tabular-nums text-ink-soft">
                        {formatMoney(row.totalToDateCents)}
                        {previewG[row.sovLineId] !== row.totalToDateCents && (
                          <span className="ml-1 text-xs text-ink-faint" title="Unsaved preview">→ {formatMoney(previewG[row.sovLineId])}</span>
                        )}
                      </div>
                      <div className="text-ink-faint">Balance</div>
                      <div className="text-right tabular-nums text-ink-soft">{formatMoney(row.balanceToFinishCents)}</div>
                      <div className="text-ink-faint">Retainage</div>
                      <div className="text-right tabular-nums text-ink-soft">{formatMoney(row.retainageCents)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* G702 summary */}
          {g702 && (
            <div className="h-fit rounded-lg border border-edge p-4">
              <h4 className="mb-3 text-sm font-semibold text-ink">G702 application summary</h4>
              <dl className="space-y-1.5 text-sm">
                <Row label="1. Original contract sum" value={g702.L1originalContractCents} />
                <Row label="2. Net change by change orders" value={g702.L2changeOrdersCents} />
                <Row label="3. Contract sum to date" value={g702.L3contractSumToDateCents} bold />
                <Row label="4. Total completed & stored to date" value={g702.L4totalCompletedStoredCents} />
                <Row label="5a. Retainage (completed work)" value={g702.L5aRetainageWorkCents} sub />
                <Row label="5b. Retainage (stored material)" value={g702.L5bRetainageStoredCents} sub />
                <Row label="5. Total retainage" value={g702.L5retainageCents} />
                <Row label="6. Total earned less retainage" value={g702.L6earnedLessRetainageCents} />
                <Row label="7. Less previous certificates for payment" value={g702.L7lessPreviousCents} />
                <div className="my-2 border-t border-edge" />
                <div className="flex items-center justify-between text-base">
                  <dt className="font-semibold text-ink">8. Current payment due</dt>
                  <dd className="font-bold text-ink">{formatMoney(g702.L8currentPaymentDueCents)}</dd>
                </div>
                <div className="my-2 border-t border-edge" />
                <Row label="9. Balance to finish, plus retainage" value={g702.L9balanceToFinishCents} />
              </dl>

              <div className="mt-4 border-t border-edge pt-3">
                <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Change order summary</h5>
                <dl className="space-y-1.5 text-sm">
                  <Row label="Additions" value={g702.changeOrders.additionsCents} />
                  <Row label="Deductions" value={g702.changeOrders.deductionsCents} />
                  <Row label="Net change by change orders" value={g702.changeOrders.netCents} bold />
                </dl>
              </div>
            </div>
          )}
          </div>

          {/* Payments — read-only; recording/deleting happens in the
              project's Payments tab. */}
          <div className="rounded-lg border border-edge p-4">
            <h4 className="mb-3 text-sm font-semibold text-ink">Payments</h4>
            {payments.length === 0 ? (
              <p className="text-sm text-ink-faint">No payments recorded. Record payments in the Billing → Payments tab.</p>
            ) : (
              <Table>
                <THead><TR><TH>Date</TH><TH>Note</TH><TH className="text-right">Amount</TH></TR></THead>
                <TBody>
                  {payments.map(p => (
                    <TR key={p.id}>
                      <TD className="text-ink-soft">{formatBillingDate(p.date)}</TD>
                      <TD className="text-ink-faint">{p.note || '—'}</TD>
                      <TD className="text-right tabular-nums text-ink-soft">{formatMoney(Math.round((Number(p.amount) || 0) * 100))}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <p className="mt-3 text-sm text-ink-soft">
              Paid <span className="font-semibold text-ink">{formatMoney(paymentsPaidCents)}</span>
              {' · '}
              Balance <span className="font-semibold text-ink">{paymentsBalanceCents == null ? '—' : formatMoney(paymentsBalanceCents)}</span>
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
};

const Row: React.FC<{ label: string; value: number; bold?: boolean; sub?: boolean }> = ({ label, value, bold, sub }) => (
  <div className={`flex items-center justify-between ${sub ? 'pl-4' : ''}`}>
    <dt className={bold ? 'font-medium text-ink' : 'text-ink-soft'}>{label}</dt>
    <dd className={bold ? 'font-semibold text-ink' : 'text-ink-soft'}>{formatMoney(value)}</dd>
  </div>
);
