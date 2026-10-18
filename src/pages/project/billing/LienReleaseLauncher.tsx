// src/pages/project/billing/LienReleaseLauncher.tsx
// Everything that starts or opens a release of lien outside the Lien Releases
// tab's own list: the host that keeps an editor in step with its record, the
// four-variant menu, and the buttons the pay app editor, invoice editor and
// payments list put on screen (spec §6.1).
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileSignature } from 'lucide-react';
import {
  LienRelease, LienReleasePrefill, LienReleasePrefillQuery,
  getLienRelease, getLienReleasePrefill, getProject,
} from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { Button } from '../../../components/ui';
import { LienReleaseEditor, draftFromPrefill } from './LienReleaseEditor';

export const LIEN_VARIANTS: { paymentType: 'progress' | 'final'; conditional: boolean; label: string }[] = [
  { paymentType: 'progress', conditional: true, label: 'Conditional, progress payment' },
  { paymentType: 'progress', conditional: false, label: 'Unconditional, progress payment' },
  { paymentType: 'final', conditional: true, label: 'Conditional, final payment' },
  { paymentType: 'final', conditional: false, label: 'Unconditional, final payment' },
];

export const lienVariantLabel = (r: Pick<LienRelease, 'paymentType' | 'conditional'>): string =>
  `${r.conditional ? 'Conditional' : 'Unconditional'} ${r.paymentType}`;

/** A release being edited: stored (has an id) or a draft not saved yet. */
export interface HostedRelease { release: LienRelease; source?: LienReleasePrefill['source'] }

/** Keeps one editor in step with its record, the way the change order list does:
 *  a save that asks to stay mounted must not re-key the editor mid document-bar flow. */
export const LienReleaseHost: React.FC<{
  projectId: string;
  initial: HostedRelease;
  onClose: () => void;
  onChanged?: () => void;
}> = ({ projectId, initial, onClose, onChanged }) => {
  const { toast } = useToast();
  const [state, setState] = useState<HostedRelease>(initial);
  const [seq, setSeq] = useState(0);
  const [projectName, setProjectName] = useState('');
  useEffect(() => {
    let live = true;
    getProject(projectId).then(p => { if (live) setProjectName(p?.name ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);

  const open = async (id: string) => {
    try {
      const fresh = await getLienRelease(id);
      setState({ release: fresh });
      setSeq(n => n + 1);
      onChanged?.();
    } catch { toast('Failed to open release', { type: 'error' }); onClose(); }
  };

  return (
    <LienReleaseEditor
      key={`${state.release.id || 'new'}:${seq}`}
      release={state.release}
      initialSource={state.source}
      projectId={projectId}
      projectName={projectName}
      onClose={onClose}
      onCreated={open}
      onOpenOther={open}
      onSaved={async (opts) => {
        const id = state.release.id;
        try {
          const fresh = await getLienRelease(id);
          setState(s => ({ ...s, release: fresh }));
          if (!opts?.keepMounted && fresh.version !== state.release.version) setSeq(n => n + 1);
        } catch { onClose(); }
        onChanged?.();
      }}
    />
  );
};

/** Builds the unsaved draft the server's prefill describes. */
export async function buildLienDraft(projectId: string, query: LienReleasePrefillQuery): Promise<HostedRelease> {
  const prefill = await getLienReleasePrefill(projectId, query);
  return { release: draftFromPrefill(projectId, prefill), source: prefill.source };
}

/** The button the editors and lists show. With `variant` set it starts that
 *  release directly; otherwise it opens the four-variant menu. */
export const LienReleaseLauncher: React.FC<{
  projectId: string;
  /** Start from this pay app or invoice. */
  source?: { sourceType: 'payapp' | 'invoice'; sourceId: string };
  /** Start from this recorded payment (Billing -> Payments). */
  paymentId?: string;
  /** Skip the menu: always this variant. */
  variant?: { paymentType: 'progress' | 'final'; conditional: boolean };
  label?: string;
  size?: 'sm' | 'md';
  buttonVariant?: 'primary' | 'secondary' | 'ghost';
  testId?: string;
  /** Which way the menu opens: up from a modal footer, down from a page header. */
  menuDirection?: 'up' | 'down';
  onChanged?: () => void;
}> = ({ projectId, source, paymentId, variant, label = 'Release of lien', size = 'sm', buttonVariant = 'secondary', testId = 'lien-release-launcher', menuDirection = 'up', onChanged }) => {
  const { toast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hosted, setHosted] = useState<HostedRelease | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menuOpen]);

  const start = async (v?: { paymentType: 'progress' | 'final'; conditional: boolean }) => {
    setMenuOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      setHosted(await buildLienDraft(projectId, {
        ...(paymentId ? { paymentId } : source ?? {}),
        ...(v ? { paymentType: v.paymentType, conditional: v.conditional } : {}),
      }));
    } catch (e) {
      toast((e instanceof Error && e.message) || 'Could not start the release', { type: 'error' });
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="relative inline-block" ref={wrap}>
        <Button
          variant={buttonVariant} size={size} data-testid={testId} disabled={busy}
          aria-haspopup={variant ? undefined : 'menu'} aria-expanded={variant ? undefined : menuOpen}
          onClick={() => (variant ? void start(variant) : setMenuOpen(o => !o))}
        >
          <FileSignature size={14} />{label}{!variant && <ChevronDown size={13} />}
        </Button>
        {menuOpen && !variant && (
          <div role="menu" className={`absolute left-0 z-50 w-64 ${menuDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} rounded-lg border border-edge bg-raised py-1 shadow-lg`}>
            {LIEN_VARIANTS.map(v => (
              <button
                key={`${v.paymentType}-${v.conditional}`} role="menuitem" type="button"
                className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-hover"
                onClick={() => void start(v)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {hosted && (
        <LienReleaseHost projectId={projectId} initial={hosted} onClose={() => setHosted(null)} onChanged={onChanged} />
      )}
    </>
  );
};
