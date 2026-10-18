// src/pages/project/billing/AiaScheduleOfValues.tsx
import React, { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Plus, Trash2, Check, X, Pencil, Upload, HelpCircle, Download,
  ArrowUp, ArrowDown, Heading, Minus, Scissors, Lock, Unlock,
} from 'lucide-react';
import {
  AiaSettings, AiaSovLine, getSov, createSovLine, saveSovLine, deleteSovLine,
  seedSov, syncChangeOrders, getProject, computeSovSeedFromEstimate, resolveRetainageMode,
  getSovLock, lockSov, unlockSov, reorderSov, SovLockState, SovLineType, lineTypeOf,
} from '../../../utils/store';
import { formatMoney, dollarsToCents, centsToDollars } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { exportAiaXlsx, sanitizeFilename } from './aiaExcel';
import { resolveAiaExportEnv, buildBlankSovContext } from './aiaExportShared';
import { SplitSovLineModal } from './SplitSovLineModal';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, NumberInput, Select, Skeleton,
  StatusPill, Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { AddFilesButton } from '../../../components/documents/AddFilesButton';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';

const isCo = (l: AiaSovLine) => !!l.isChangeOrder;

// Row icon buttons carry a short tooltip plus a longer aria-label: the tooltip
// is what the user hovers, the label is what a screen reader (and a role query)
// reads, and keeping them distinct stops "Delete" the row action from being
// confused with "Delete" the confirm-dialog button.
const ICON_BTN = 'rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent';

export const AiaScheduleOfValues: React.FC<{ projectId: string; aiaSettings?: AiaSettings | null }> = ({ projectId, aiaSettings }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const baseRetainagePercent = aiaSettings?.retainagePercent ?? 10;
  const [lines, setLines] = useState<AiaSovLine[] | null>(null);
  const [lock, setLock] = useState<SovLockState | null>(null);
  // Resolved mode: absent aiaSettings.retainageMode falls back to inferring
  // from the SOV lines themselves, so a legacy per-line project keeps
  // showing its column before anyone visits AIA settings.
  const perLine = resolveRetainageMode(aiaSettings?.retainageMode, lines ?? []) === 'perLine';
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // inline edit state
  const [editId, setEditId] = useState<string | null>(null);
  const [eItemNo, setEItemNo] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eValue, setEValue] = useState('');
  const [eRetainage, setERetainage] = useState('');

  // add form
  const [nType, setNType] = useState<SovLineType>('item');
  const [nItemNo, setNItemNo] = useState('');
  const [nDesc, setNDesc] = useState('');
  const [nValue, setNValue] = useState('');
  const [nRetainage, setNRetainage] = useState('');

  const [splitTarget, setSplitTarget] = useState<AiaSovLine | null>(null);

  const loadLock = () => getSovLock(projectId).then(setLock).catch(() => setLock(null));
  const reload = () => {
    getSov(projectId).then(setLines).catch(() => setLines([]));
    loadLock();
  };
  // Lock/unlock broadcast aiaSov, so a finalize by another admin refetches
  // both the lines and the lock state here.
  useLiveQuery(reload, { types: ['aiaSov', 'changeOrder'], projectId });

  // Page-level presence only — SOV events carry per-line ids, not a single
  // entity id, and Task 6's useLiveQuery above already handles silent live
  // refresh. isDirty always false means remoteChange can never be set, so
  // the banner only ever renders its "others editing" half.
  const collab = useCollabEditing({
    type: 'aiaSov',
    id: projectId,
    isDirty: () => false,
    onFresh: reload,
  });

  const locked = !!lock?.locked;
  const contract = (lines ?? []).filter(l => !isCo(l));
  const cos = (lines ?? []).filter(isCo);

  // Every mutation funnels its error through this, so a lock raised elsewhere
  // (another admin, or the first pay app just created) is explained and the
  // controls disappear on the refetch.
  const onMutationError = (e: unknown, fallback: string) => {
    if (e instanceof Error && e.name === 'SovLockedError') {
      toast('Schedule of values is finalized', { type: 'error' });
      loadLock();
      return;
    }
    if (e instanceof Error && e.name === 'ConflictError') {
      toast('Line changed elsewhere — reload', { type: 'error' });
      return;
    }
    toast(fallback, { type: 'error' });
  };

  const finalize = async () => {
    const ok = await confirm({
      title: 'Finalize schedule of values?',
      message: "Lines can't be changed until an admin reopens it. Approved change orders can still be synced.",
      confirmLabel: 'Finalize',
    });
    if (!ok) return;
    try { setLock(await lockSov(projectId)); toast('Schedule of values finalized', { type: 'success' }); }
    catch { toast('Failed to finalize', { type: 'error' }); }
  };

  const reopen = async () => {
    const n = lock?.payAppCount ?? 0;
    const ok = await confirm({
      title: 'Reopen schedule of values?',
      tone: 'danger',
      confirmLabel: 'Reopen',
      message: `${n} pay application${n === 1 ? '' : 's'} will recompute from any values you change. Exports will be marked out of date.`,
    });
    if (!ok) return;
    try { setLock(await unlockSov(projectId)); toast('Schedule of values reopened', { type: 'warning' }); }
    catch { toast('Failed to reopen', { type: 'error' }); }
  };

  // Zero-charge SOV export — the same G702/G703 workbook (or admin template) a
  // pay-app export produces, with all billing at $0. Lets the SOV be presented
  // for approval before any pay application exists.
  const handleDownloadSov = async () => {
    if (!lines || lines.length === 0) return;
    setDownloading(true);
    try {
      const env = await resolveAiaExportEnv(projectId);
      if (env.templateLoadFailed) {
        toast('AIA template failed to load — exporting standard G702/G703 instead', { type: 'error' });
      }
      const blank = buildBlankSovContext(env.sovLines, env.aiaSettings, projectId);
      await exportAiaXlsx({
        projectName: env.project?.name ?? 'Project',
        contractor: env.project?.contractor ?? undefined,
        company: env.company,
        aiaSettings: env.aiaSettings,
        app: blank.app,
        sovLines: env.sovLines,
        g702: blank.g702,
        g703: blank.g703,
      }, env.template, `AIA-${sanitizeFilename(env.project?.name ?? 'Project')}-SOV.xlsx`);
      toast('SOV downloaded', { type: 'success' });
    } catch {
      toast('Failed to export SOV', { type: 'error' });
    } finally {
      setDownloading(false);
    }
  };

  const seedFromEstimate = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const project = await getProject(projectId);
      if (!project) { toast('Project not found', { type: 'error' }); return; }
      const seed = computeSovSeedFromEstimate(project);
      if (seed.length === 0) { toast('No estimate totals to seed from', { type: 'warning' }); return; }
      const hasOriginal = (lines ?? []).some(l => !isCo(l));
      if (hasOriginal) {
        const ok = await confirm({
          title: 'Replace schedule of values?',
          message: 'Replace the existing schedule of values from the estimate? Change-order lines are preserved.',
          confirmLabel: 'Replace',
        });
        if (!ok) return;
      }
      const { count } = await seedSov(projectId, seed);
      reload();
      toast(`Seeded ${count} line${count === 1 ? '' : 's'} from estimate`, { type: 'success' });
    } catch (e) {
      onMutationError(e, 'Failed to seed from estimate');
    } finally {
      setBusy(false);
    }
  };

  const syncCos = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const { added } = await syncChangeOrders(projectId);
      reload();
      toast(added > 0 ? `Added ${added} change-order line${added === 1 ? '' : 's'}` : 'No new change orders to sync', { type: 'success' });
    } catch {
      toast('Failed to sync change orders', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // The parse itself, over bytes — the disk upload and the documents picker
  // hand it the same ArrayBuffer, so the column A/column B contract (and the
  // replace-but-keep-change-orders confirmation) lives in exactly one place.
  const importSovBuffer = async (buf: ArrayBuffer) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) { toast('No sheet found in the file', { type: 'error' }); return; }
      const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, blankrows: false });
      const newLines: { description: string; scheduledValueCents: number }[] = [];
      for (const row of rows) {
        const description = String(row[0] ?? '').trim();
        const value = Number(String(row[1] ?? '').replace(/[$,\s]/g, ''));
        if (description === '' || !Number.isFinite(value)) continue;
        newLines.push({ description, scheduledValueCents: Math.round(value * 100) });
      }
      if (newLines.length === 0) {
        toast('No valid rows found — column A should be descriptions, column B the values', { type: 'error' });
        return;
      }
      const hasOriginal = (lines ?? []).some(l => !isCo(l));
      if (hasOriginal) {
        const ok = await confirm({
          title: 'Replace schedule of values?',
          message: `Replace the schedule of values with ${newLines.length} line${newLines.length === 1 ? '' : 's'} from the sheet? Change-order lines are kept.`,
          confirmLabel: 'Replace',
        });
        if (!ok) return;
      }
      await seedSov(projectId, newLines);
      reload();
      toast(`Imported ${newLines.length} line${newLines.length === 1 ? '' : 's'}`, { type: 'success' });
    } catch (e) {
      onMutationError(e, 'Failed to read sheet');
    } finally {
      setBusy(false);
    }
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) { input.value = ''; return; }
    try {
      await importSovBuffer(await file.arrayBuffer());
    } catch {
      toast('Failed to read sheet', { type: 'error' });
    } finally {
      input.value = '';
    }
  };

  const startEdit = (l: AiaSovLine) => {
    setEditId(l.id);
    setEItemNo(l.itemNo ?? '');
    setEDesc(l.description);
    setEValue(String(centsToDollars(l.scheduledValueCents)));
    setERetainage(l.retainagePercent != null ? String(l.retainagePercent) : '');
  };
  const cancelEdit = () => setEditId(null);

  const saveEdit = async (l: AiaSovLine) => {
    if (!eDesc.trim()) { toast('Description is required', { type: 'warning' }); return; }
    const isHeader = lineTypeOf(l) === 'header';
    const retNum = eRetainage.trim() === '' ? null : parseFloat(eRetainage);
    try {
      await saveSovLine(l.id, {
        ...l,
        itemNo: eItemNo.trim() || null,
        description: eDesc.trim(),
        // A header carries no money — saving one must never resurrect a value
        // from a stale input, so it is written back at zero.
        scheduledValueCents: isHeader ? 0 : dollarsToCents(eValue),
        retainagePercent: isHeader ? null : (retNum != null && Number.isFinite(retNum) ? retNum : null),
      });
      setEditId(null);
      reload();
      toast('Line saved', { type: 'success' });
    } catch (e) {
      onMutationError(e, 'Save failed');
    }
  };

  const removeLine = async (l: AiaSovLine) => {
    const ok = await confirm({
      title: 'Delete line?',
      message: 'This permanently removes the schedule-of-values line.',
      tone: 'danger', confirmLabel: 'Delete',
    });
    if (!ok) return;
    try { await deleteSovLine(l.id); reload(); }
    catch (e) { onMutationError(e, 'Delete failed'); }
  };

  const move = async (l: AiaSovLine, dir: -1 | 1) => {
    const ids = contract.map(x => x.id);
    const i = ids.indexOf(l.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await reorderSov(projectId, ids); reload(); }
    catch (e) { onMutationError(e, 'Failed to move line'); }
  };

  const insertAbove = async (l: AiaSovLine, lineType: 'header' | 'blank') => {
    try {
      await createSovLine(projectId, lineType === 'header'
        ? { lineType, description: 'New section', insertBeforeId: l.id }
        : { lineType, insertBeforeId: l.id });
      reload();
    } catch (e) { onMutationError(e, 'Failed to insert line'); }
  };

  const addLine = async () => {
    if (!projectId) return;
    try {
      if (nType === 'blank') {
        await createSovLine(projectId, { lineType: 'blank' });
      } else if (nType === 'header') {
        if (!nDesc.trim()) { toast('Enter a description', { type: 'warning' }); return; }
        await createSovLine(projectId, { lineType: 'header', description: nDesc.trim(), itemNo: nItemNo.trim() || null });
      } else {
        if (!nDesc.trim()) { toast('Enter a description', { type: 'warning' }); return; }
        const retNum = nRetainage.trim() === '' ? null : parseFloat(nRetainage);
        await createSovLine(projectId, {
          lineType: 'item',
          itemNo: nItemNo.trim() || null,
          description: nDesc.trim(),
          scheduledValueCents: dollarsToCents(nValue),
          retainagePercent: retNum != null && Number.isFinite(retNum) ? retNum : null,
        });
      }
      setNItemNo(''); setNDesc(''); setNValue(''); setNRetainage('');
      reload();
    } catch (e) { onMutationError(e, 'Failed to add line'); }
  };

  // Headers and blanks are layout, not money: only item lines count toward the
  // original contract sum.
  const originalCents = contract
    .filter(l => lineTypeOf(l) === 'item')
    .reduce((a, l) => a + l.scheduledValueCents, 0);
  const coCents = cos.reduce((a, l) => a + l.scheduledValueCents, 0);
  const totalCents = originalCents + coCents;

  // Money columns to the left of the action cell — a blank row spans them all.
  const bodyCols = perLine ? 4 : 3;

  const renderActions = (l: AiaSovLine, i: number) => (
    <TD>
      <div className="flex items-center gap-1">
        {lineTypeOf(l) !== 'blank' && (
          <button onClick={() => startEdit(l)} title="Edit" aria-label="Edit line"
            className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink"><Pencil size={14} /></button>
        )}
        <button onClick={() => removeLine(l)} title="Delete" aria-label="Delete line"
          className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
        <button onClick={() => move(l, -1)} disabled={i === 0} title="Move up" aria-label="Move line up"
          data-testid={`sov-move-up-${l.id}`} className={ICON_BTN}><ArrowUp size={14} /></button>
        <button onClick={() => move(l, 1)} disabled={i === contract.length - 1} title="Move down" aria-label="Move line down"
          data-testid={`sov-move-down-${l.id}`} className={ICON_BTN}><ArrowDown size={14} /></button>
        <button onClick={() => insertAbove(l, 'header')} title="Insert header above" aria-label="Insert header above"
          data-testid={`sov-insert-header-${l.id}`} className={ICON_BTN}><Heading size={14} /></button>
        <button onClick={() => insertAbove(l, 'blank')} title="Insert blank above" aria-label="Insert blank row above"
          data-testid={`sov-insert-blank-${l.id}`} className={ICON_BTN}><Minus size={14} /></button>
        {lineTypeOf(l) === 'item' && (
          <button onClick={() => setSplitTarget(l)} title="Split…" aria-label="Split line"
            data-testid={`sov-split-${l.id}`} className={ICON_BTN}><Scissors size={14} /></button>
        )}
      </div>
    </TD>
  );

  const renderRow = (l: AiaSovLine, i: number) => {
    const type = lineTypeOf(l);
    // A lock landing mid-edit (another admin finalized, or the first pay app
    // was created) drops the editor rather than leaving a Save that can only
    // fail.
    if (editId === l.id && !locked) {
      const isHeader = type === 'header';
      return (
        <TR key={l.id} data-testid={`sov-row-${l.id}`}>
          <TD className="w-24"><Input value={eItemNo} onChange={e => setEItemNo(e.target.value)} /></TD>
          <TD><Input value={eDesc} onChange={e => setEDesc(e.target.value)} /></TD>
          {isHeader ? (
            <TD className="text-ink-faint" colSpan={perLine ? 2 : 1}>—</TD>
          ) : (
            <>
              <TD className="w-32"><NumberInput allowEmpty  value={eValue} onChange={e => setEValue(e.target.value)} placeholder="0.00" /></TD>
              {perLine && <TD className="w-24"><NumberInput allowEmpty  value={eRetainage} onChange={e => setERetainage(e.target.value)} placeholder={`base ${baseRetainagePercent}%`} /></TD>}
            </>
          )}
          <TD>
            <div className="flex items-center gap-1">
              <button onClick={() => saveEdit(l)} title="Save" aria-label="Save line" className="rounded-md p-1 text-green-600 hover:bg-hover"><Check size={15} /></button>
              <button onClick={cancelEdit} title="Cancel" aria-label="Cancel editing" className="rounded-md p-1 text-ink-faint hover:bg-hover"><X size={15} /></button>
            </div>
          </TD>
        </TR>
      );
    }
    if (type === 'blank') {
      return (
        <TR key={l.id} data-testid={`sov-row-${l.id}`}>
          <TD colSpan={bodyCols} className="text-xs italic text-ink-faint">— blank —</TD>
          {!locked && renderActions(l, i)}
        </TR>
      );
    }
    if (type === 'header') {
      return (
        <TR key={l.id} data-testid={`sov-row-${l.id}`}>
          <TD className="text-ink-soft">{l.itemNo || '—'}</TD>
          <TD className="font-semibold text-ink">{l.description}</TD>
          <TD className="text-ink-faint">—</TD>
          {perLine && <TD className="text-ink-faint">—</TD>}
          {!locked && renderActions(l, i)}
        </TR>
      );
    }
    return (
      <TR key={l.id} data-testid={`sov-row-${l.id}`}>
        <TD className="text-ink-soft">{l.itemNo || '—'}</TD>
        <TD className="font-medium text-ink">{l.description}</TD>
        <TD className="text-ink-soft">{formatMoney(l.scheduledValueCents)}</TD>
        {perLine && <TD className="text-ink-soft">{l.retainagePercent != null ? `${l.retainagePercent}%` : '—'}</TD>}
        {!locked && renderActions(l, i)}
      </TR>
    );
  };

  return (
    <Card className="mb-5">
      <CardHeader title="Schedule of values"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="sov-lock-chip">
              {lock === null ? null : locked ? (
                <StatusPill tone="amber">
                  <Lock size={12} /> Locked · {lock.lockedAt ? new Date(lock.lockedAt).toLocaleDateString() : '—'} ·{' '}
                  {lock.reason === 'pay-app' ? 'first pay application' : `by ${lock.lockedByName ?? 'admin'}`}
                </StatusPill>
              ) : (
                <StatusPill tone="slate">Draft</StatusPill>
              )}
            </span>
            {lock !== null && (locked ? (
              <Button size="sm" variant="secondary" data-testid="sov-reopen" onClick={reopen}
                title="Reopen the schedule of values for editing"><Unlock size={14} />Reopen</Button>
            ) : (
              <Button size="sm" variant="secondary" data-testid="sov-finalize" onClick={finalize} disabled={busy}
                title="Finalize the schedule of values"><Lock size={14} />Finalize SOV</Button>
            ))}
            <Button size="sm" variant="secondary" onClick={handleDownloadSov}
              disabled={busy || downloading || !lines || lines.length === 0}>
              <Download size={14} />{downloading ? 'Exporting…' : 'Download SOV'}
            </Button>
            {!locked && <Button size="sm" variant="secondary" onClick={seedFromEstimate} disabled={busy}>Seed from estimate</Button>}
            <Button size="sm" variant="secondary" onClick={syncCos} disabled={busy}>Sync approved change orders</Button>
            {!locked && (
              <>
                <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={busy}><Upload size={14} />Upload sheet</Button>
                <AddFilesButton
                  label="Import from documents"
                  accept="spreadsheet"
                  multi={false}
                  returnBlobs
                  size="sm"
                  initialProjectIds={[projectId]}
                  disabled={busy}
                  title="Import a schedule of values from a workbook already on file"
                  onPickBlobs={async picked => {
                    const p = picked[0];
                    if (p) await importSovBuffer(await p.blob.arrayBuffer());
                  }}
                />
                <Button size="sm" variant="ghost" onClick={() => setShowHelp(v => !v)} aria-expanded={showHelp} aria-label="Schedule of values upload help"><HelpCircle size={16} /></Button>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUploadFile} />
              </>
            )}
          </div>
        } />
      {locked && (
        <p className="border-b border-edge px-4 py-2 text-xs text-ink-faint">
          Finalized — reopen to edit lines. Approved change orders can still be synced.
        </p>
      )}
      {showHelp && !locked && (
        <p className="border-b border-edge px-4 py-3 text-sm text-ink-faint">
          Upload an .xlsx where column A is the line description and column B is the scheduled value (in dollars). A header row is fine — it's skipped automatically. This replaces the current schedule of values (change-order lines are kept).
        </p>
      )}
      <CardBody className="p-0">
        {collab.othersEditing.length > 0 && (
          <div className="px-4 pt-4"><EditPresenceBanner state={collab} /></div>
        )}
        {lines === null ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : lines.length === 0 ? (
          <EmptyState title="No schedule of values yet"
            description="Seed from the estimate or add lines manually to build the G703." />
        ) : (
          <>
            {contract.length > 0 && (
              <div data-testid="sov-contract-section">
                <Table>
                  <THead><TR><TH>Item no.</TH><TH>Description</TH><TH>Scheduled value</TH>{perLine && <TH>Retainage %</TH>}{!locked && <TH></TH>}</TR></THead>
                  <TBody>{contract.map((l, i) => renderRow(l, i))}</TBody>
                </Table>
              </div>
            )}
            {cos.length > 0 && (
              // Change-order lines are owned by the change orders themselves —
              // they are listed here for the contract total, never edited here.
              <div data-testid="sov-co-section" className="border-t border-edge">
                <p className="px-4 pt-4 text-xs font-semibold uppercase tracking-wider text-ink-soft">Change orders</p>
                <Table>
                  <THead><TR><TH>Item no.</TH><TH>Description</TH><TH>Amount</TH></TR></THead>
                  <TBody>
                    {cos.map(l => (
                      <TR key={l.id} data-testid={`sov-row-${l.id}`}>
                        <TD className="text-ink-soft">{l.itemNo || '—'}</TD>
                        <TD className="font-medium text-ink">{l.description}</TD>
                        <TD className="text-ink-soft">{formatMoney(l.scheduledValueCents)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </>
        )}
        {!perLine && lines && lines.length > 0 && (
          <p className="border-t border-edge px-4 py-2 text-xs text-ink-faint">
            Retainage: base rate {baseRetainagePercent}% applies to all lines (change in AIA settings)
          </p>
        )}

        {/* Add line */}
        {!locked && (
          <div className="flex flex-wrap items-end gap-2 border-t border-edge p-4">
            <div className="w-full sm:w-auto">
              <Field label="Type" htmlFor="sov-type">
                <Select id="sov-type" data-testid="sov-new-type" value={nType}
                  onChange={e => setNType(e.target.value as SovLineType)} className="w-full sm:w-28">
                  <option value="item">Item</option>
                  <option value="header">Header</option>
                  <option value="blank">Blank</option>
                </Select>
              </Field>
            </div>
            {nType !== 'blank' && (
              <>
                <div className="w-full sm:w-auto"><Field label="Item no." htmlFor="sov-item"><Input id="sov-item" value={nItemNo} onChange={e => setNItemNo(e.target.value)} className="w-full sm:w-24" /></Field></div>
                <div className="w-full sm:w-auto"><Field label="Description" htmlFor="sov-desc"><Input id="sov-desc" value={nDesc} onChange={e => setNDesc(e.target.value)} className="w-full sm:w-56" /></Field></div>
              </>
            )}
            {nType === 'item' && (
              <>
                <div className="w-full sm:w-auto"><Field label="Scheduled value" htmlFor="sov-value"><NumberInput allowEmpty id="sov-value" value={nValue} onChange={e => setNValue(e.target.value)} className="w-full sm:w-32" placeholder="0.00" /></Field></div>
                {perLine && <div className="w-full sm:w-auto"><Field label="Retainage %" htmlFor="sov-ret"><NumberInput allowEmpty id="sov-ret" value={nRetainage} onChange={e => setNRetainage(e.target.value)} className="w-full sm:w-28" placeholder={`base ${baseRetainagePercent}%`} /></Field></div>}
              </>
            )}
            <Button variant="secondary" onClick={addLine} className="w-full sm:w-auto"><Plus size={14} />Add line</Button>
          </div>
        )}

        {/* Totals */}
        {lines && lines.length > 0 && (
          <div className="flex flex-wrap justify-end gap-6 border-t border-edge p-4 text-sm">
            <div className="text-ink-soft">Original <span className="ml-2 font-semibold text-ink">{formatMoney(originalCents)}</span></div>
            <div className="text-ink-soft">Change orders <span className="ml-2 font-semibold text-ink">{formatMoney(coCents)}</span></div>
            <div className="text-ink-soft">Total scheduled value <span className="ml-2 font-semibold text-ink">{formatMoney(totalCents)}</span></div>
          </div>
        )}
      </CardBody>
      <SplitSovLineModal line={splitTarget} onClose={() => setSplitTarget(null)} onSplit={reload} payAppCount={lock?.payAppCount ?? 0} />
    </Card>
  );
};
