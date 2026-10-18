// src/pages/project/billing/AiaSettingsForm.tsx
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AiaPayApp, AiaSettings, AiaSovLine, resolveRetainageMode, saveAiaSettings } from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Button, Card, CardBody, Field, Input, NumberInput, Textarea } from '../../../components/ui';

const numOrUndefined = (v: string): number | undefined => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

export const AiaSettingsForm: React.FC<{
  projectId: string;
  settings: AiaSettings;
  sovLines: AiaSovLine[];
  /** Existing pay applications — only their count matters here: switching the
   *  retainage mode recomputes every one of them, so the save is confirmed. */
  payApps: AiaPayApp[];
  onSaved: (s: AiaSettings) => void;
  defaultOpen?: boolean;
}> = ({ projectId, settings, sovLines, payApps, onSaved, defaultOpen = false }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [retainagePercent, setRetainagePercent] = useState(
    settings.retainagePercent != null ? String(settings.retainagePercent) : '10');
  // No stored mode yet (legacy project): infer from whether any SOV line
  // already carries a per-line rate, so the toggle doesn't silently flip a
  // per-line project to uniform the moment someone opens this form.
  const [retainageMode, setRetainageMode] = useState<'uniform' | 'perLine'>(
    resolveRetainageMode(settings.retainageMode, sovLines));
  // The mode as last persisted — the baseline the confirm compares against, so
  // toggling away and back again isn't treated as a change.
  const [savedMode, setSavedMode] = useState<'uniform' | 'perLine'>(
    resolveRetainageMode(settings.retainageMode, sovLines));
  const [ownerName, setOwnerName] = useState(settings.ownerName ?? '');
  const [ownerAddress, setOwnerAddress] = useState(settings.ownerAddress ?? '');
  const [architectName, setArchitectName] = useState(settings.architectName ?? '');
  const [architectAddress, setArchitectAddress] = useState(settings.architectAddress ?? '');
  const [contractDate, setContractDate] = useState(settings.contractDate ?? '');
  const [ownerProjectNumber, setOwnerProjectNumber] = useState(settings.ownerProjectNumber ?? '');
  const [architectProjectNumber, setArchitectProjectNumber] = useState(settings.architectProjectNumber ?? '');
  const [contractFor, setContractFor] = useState(settings.contractFor ?? '');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(defaultOpen);

  const handleSave = async () => {
    // Flipping the mode re-derives retainage on EVERY existing application —
    // finalized ones included, and the billing rollups move with them — so it
    // is confirmed whenever there is anything to recompute.
    if (retainageMode !== savedMode && payApps.length > 0) {
      const ok = await confirm({
        title: 'Change retainage mode?',
        message: `Changing the retainage mode recalculates retainage on ${payApps.length} existing application(s), including finalized ones. Continue?`,
        confirmLabel: 'Change mode',
      });
      if (!ok) return;
    }
    setSaving(true);
    const next: AiaSettings = {
      ...settings,
      retainagePercent: numOrUndefined(retainagePercent) ?? 10,
      retainageMode,
      ownerName: ownerName || undefined,
      ownerAddress: ownerAddress || undefined,
      architectName: architectName || undefined,
      architectAddress: architectAddress || undefined,
      contractDate: contractDate || undefined,
      ownerProjectNumber: ownerProjectNumber || undefined,
      architectProjectNumber: architectProjectNumber || undefined,
      contractFor: contractFor || undefined,
    };
    try {
      await saveAiaSettings(projectId, next);
      setSavedMode(retainageMode);
      toast('AIA settings saved', { type: 'success' });
      onSaved(next);
    } catch {
      toast('Failed to save AIA settings', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="aia-settings-body"
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-ink-soft" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-ink-soft" aria-hidden="true" />
          )}
          <div>
            <h3 className="text-sm font-semibold text-ink">AIA settings</h3>
            <p className="text-xs text-ink-soft">Owner, architect &amp; retainage — set once</p>
          </div>
        </div>
      </button>
      {open && (
      <CardBody id="aia-settings-body" className="border-t border-edge">
        <div className="mb-3">
          <Field label="Retainage %" htmlFor="aia-ret" hint="Per-line reveals a retainage column on the Schedule of Values; pay applications follow this choice.">
            <NumberInput allowEmpty id="aia-ret" value={retainagePercent} onChange={e => setRetainagePercent(e.target.value)} placeholder="10" className="max-w-xs" />
          </Field>
          <div className="mt-2 inline-flex rounded-lg border border-edge p-0.5">
            <button
              type="button"
              onClick={() => setRetainageMode('uniform')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${retainageMode === 'uniform' ? 'bg-accent-600 text-white' : 'text-ink-faint hover:text-ink'}`}
              aria-pressed={retainageMode === 'uniform'}
            >
              Uniform rate
            </button>
            <button
              type="button"
              onClick={() => setRetainageMode('perLine')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${retainageMode === 'perLine' ? 'bg-accent-600 text-white' : 'text-ink-faint hover:text-ink'}`}
              aria-pressed={retainageMode === 'perLine'}
            >
              Per-line rates
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Owner name" htmlFor="aia-owner">
            <Input id="aia-owner" value={ownerName} onChange={e => setOwnerName(e.target.value)} />
          </Field>
          <Field label="Owner address" htmlFor="aia-owner-addr">
            <Input id="aia-owner-addr" value={ownerAddress} onChange={e => setOwnerAddress(e.target.value)} />
          </Field>
          <Field label="Architect name" htmlFor="aia-arch">
            <Input id="aia-arch" value={architectName} onChange={e => setArchitectName(e.target.value)} />
          </Field>
          <Field label="Architect address" htmlFor="aia-arch-addr">
            <Input id="aia-arch-addr" value={architectAddress} onChange={e => setArchitectAddress(e.target.value)} />
          </Field>
          <Field label="Contract date" htmlFor="aia-contract-date">
            <Input id="aia-contract-date" type="date" value={contractDate} onChange={e => setContractDate(e.target.value)} />
          </Field>
          <Field label="Owner project number" htmlFor="aia-owner-pn">
            <Input id="aia-owner-pn" value={ownerProjectNumber} onChange={e => setOwnerProjectNumber(e.target.value)} />
          </Field>
          <Field label="Architect project number" htmlFor="aia-arch-pn">
            <Input id="aia-arch-pn" value={architectProjectNumber} onChange={e => setArchitectProjectNumber(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Contract for" htmlFor="aia-contract-for">
            <Textarea id="aia-contract-for" rows={2} value={contractFor} onChange={e => setContractFor(e.target.value)}
              placeholder="Description of the work covered by this contract" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
        </div>
      </CardBody>
      )}
    </Card>
  );
};
