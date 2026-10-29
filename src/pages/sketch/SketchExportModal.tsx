// src/pages/sketch/SketchExportModal.tsx
// Export a sketch: a drawing sheet (PDF) with the views picked here, saved to
// Documents or downloaded. The choices are remembered on this device.
import React, { useState } from 'react';
import { Download, FileText, LoaderCircle, Save } from 'lucide-react';
import { Button, Checkbox, Field, Modal, Select, Textarea } from '../../components/ui';
import { PAPERS, type Paper } from './sketchPdf';
import { ISO_SIZES, scalesFor, type IsoSize, type SheetView } from './sketchViews';
import type { SketchUnits } from './sketchModel';

export interface PdfOptions {
  views: Record<SheetView, boolean>;
  /** The 3D view from the standard angle, or as the view is turned on screen now. */
  isoFrom: 'standard' | 'current';
  /** How much of the sheet the 3D view may take; the flat views get the rest. */
  isoSize: IsoSize;
  hidden: boolean;
  dims: boolean;
  paper: Paper;
  /** 'auto' for the largest that fits, or a scale's label. */
  scale: string;
  notes: string;
}

const STORE_KEY = 'sketch-export-options';
const DEFAULTS: PdfOptions = {
  views: { front: true, top: true, side: true, iso: true },
  isoFrom: 'standard', isoSize: 'small', hidden: true, dims: true, paper: 'letter', scale: 'auto', notes: '',
};
const readOptions = (): PdfOptions => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    return raw ? { ...DEFAULTS, ...raw, views: { ...DEFAULTS.views, ...raw.views }, notes: '' } : DEFAULTS;
  } catch { return DEFAULTS; }
};

export const SketchExportModal: React.FC<{
  open: boolean;
  onClose: () => void;
  units: SketchUnits;
  /** Makes the PDF; the dialog then downloads it or saves it to Documents. */
  makePdf: (o: PdfOptions) => Promise<Blob>;
  onDownload: (blob: Blob) => void;
  onSave: (blob: Blob) => Promise<void>;
}> = ({ open, onClose, units, makePdf, onDownload, onSave }) => {
  const [o, setO] = useState<PdfOptions>(readOptions);
  const [busy, setBusy] = useState<null | 'download' | 'save'>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<PdfOptions>) => setO(prev => ({ ...prev, ...patch }));
  const anyView = Object.values(o.views).some(Boolean);

  const run = async (action: 'download' | 'save') => {
    setBusy(action);
    setError(null);
    try {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...o, notes: '' })); } catch { /* private mode */ }
      const blob = await makePdf(o);
      if (action === 'download') onDownload(blob);
      else await onSave(blob);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The drawing could not be made.');
    } finally {
      setBusy(null);
    }
  };

  const views: [SheetView, string][] = [['front', 'Front'], ['top', 'Top'], ['side', 'Right side'], ['iso', '3D view']];

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title="Export a drawing sheet"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={!!busy}>Cancel</Button>
        <Button variant="secondary" onClick={() => void run('download')} disabled={!!busy || !anyView} data-testid="sketch-export-download">
          {busy === 'download' ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}Download
        </Button>
        <Button onClick={() => void run('save')} disabled={!!busy || !anyView} data-testid="sketch-export-save">
          {busy === 'save' ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}Save to Documents
        </Button>
      </>}
    >
      <div className="space-y-4" data-testid="sketch-export-modal">
        <p className="flex items-start gap-2 text-sm text-ink-soft">
          <FileText size={16} className="mt-0.5 shrink-0" />
          A PDF sheet: Front, Top and Right side at one drawing scale (Top over Front, Side beside it), the 3D view in the corner, and a title block.
        </p>
        <Field label="Views">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {views.map(([v, label]) => (
              <Checkbox key={v} label={label} checked={o.views[v]} data-testid={`sketch-export-view-${v}`}
                onChange={e => set({ views: { ...o.views, [v]: e.target.checked } })} />
            ))}
          </div>
        </Field>
        {o.views.iso && (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field label="3D view from">
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink">
                {(['standard', 'current'] as const).map(k => (
                  <label key={k} className="inline-flex items-center gap-2">
                    <input type="radio" name="iso-from" checked={o.isoFrom === k} onChange={() => set({ isoFrom: k })} data-testid={`sketch-export-iso-${k}`} />
                    {k === 'standard' ? 'The usual angle (front, right, above)' : 'As the view is turned now'}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="3D view size" htmlFor="sketch-export-iso-size">
              <Select id="sketch-export-iso-size" value={o.isoSize} onChange={e => set({ isoSize: e.target.value as IsoSize })} data-testid="sketch-export-iso-size" className="w-32">
                {(Object.keys(ISO_SIZES) as IsoSize[]).map(k => <option key={k} value={k}>{ISO_SIZES[k].label}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Checkbox label="Dimensions" checked={o.dims} onChange={e => set({ dims: e.target.checked })} />
          <Checkbox label="Hidden edges (dashed)" checked={o.hidden} onChange={e => set({ hidden: e.target.checked })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paper (landscape)" htmlFor="sketch-export-paper">
            <Select id="sketch-export-paper" value={o.paper} onChange={e => set({ paper: e.target.value as Paper })}>
              {(Object.keys(PAPERS) as Paper[]).map(p => <option key={p} value={p}>{PAPERS[p].label}</option>)}
            </Select>
          </Field>
          <Field label="Scale" htmlFor="sketch-export-scale" hint="For Front, Top and Side. The 3D view is fitted to its corner.">
            <Select id="sketch-export-scale" value={o.scale} onChange={e => set({ scale: e.target.value })} data-testid="sketch-export-scale">
              <option value="auto">Largest that fits</option>
              {scalesFor(units).map(s => <option key={s.label} value={s.label}>{s.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Notes" htmlFor="sketch-export-notes" hint="Printed in the title block.">
          <Textarea id="sketch-export-notes" rows={2} value={o.notes} onChange={e => set({ notes: e.target.value })} data-testid="sketch-export-notes" />
        </Field>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
};
