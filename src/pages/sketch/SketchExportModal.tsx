// src/pages/sketch/SketchExportModal.tsx
// Export a sketch: a drawing sheet (PDF), a picture of the view (PNG), or a
// CAD file (DXF) of a plane's shapes or a flat view, saved to Documents or
// downloaded. The choices are remembered on this device.
import React, { useState } from 'react';
import { Download, LoaderCircle, Save } from 'lucide-react';
import { Button, Checkbox, Field, Modal, Select, Textarea } from '../../components/ui';
import { PAPERS, type Paper } from './sketchPdf';
import { ISO_SIZES, scalesFor, type IsoSize, type OrthoView, type SheetView } from './sketchViews';
import { PLANE_LABELS, type PlaneId, type SketchUnits } from './sketchModel';

export type ExportFormat = 'pdf' | 'png' | 'dxf';

export interface ExportOptions {
  format: ExportFormat;
  // Drawing sheet
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
  // Picture
  pngSize: 1 | 2 | 3;
  /** White paper (light colours, no grid), or as on screen. */
  pngPaper: boolean;
  pngLabels: boolean;
  // CAD file
  dxfWhat: 'plane' | 'view';
  dxfPlane: PlaneId;
  dxfView: OrthoView;
  dxfHidden: boolean;
}

const STORE_KEY = 'sketch-export-options';
const DEFAULTS: ExportOptions = {
  format: 'pdf',
  views: { front: true, top: true, side: true, iso: true },
  isoFrom: 'standard', isoSize: 'small', hidden: true, dims: true, paper: 'letter', scale: 'auto', notes: '',
  pngSize: 2, pngPaper: true, pngLabels: true,
  dxfWhat: 'plane', dxfPlane: 'front', dxfView: 'front', dxfHidden: false,
};
const readOptions = (): ExportOptions => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    return raw ? { ...DEFAULTS, ...raw, views: { ...DEFAULTS.views, ...raw.views }, notes: '' } : DEFAULTS;
  } catch { return DEFAULTS; }
};

const FORMATS: { id: ExportFormat; label: string; about: string }[] = [
  { id: 'pdf', label: 'Drawing sheet (PDF)', about: 'Front, Top and Right side, dimensioned and to scale (Top over Front, Side beside it), a 3D view, and a title block.' },
  { id: 'png', label: 'Picture (PNG)', about: 'The view as it is on screen now, as a picture for a message or a document.' },
  { id: 'dxf', label: 'CAD file (DXF)', about: 'For CAD or a CNC cutter: the shapes on a plane at true size (arcs and circles exact), or a flat view of the model.' },
];

export const SketchExportModal: React.FC<{
  open: boolean;
  onClose: () => void;
  units: SketchUnits;
  /** Makes the file; the dialog then downloads it or saves it to Documents. */
  make: (o: ExportOptions) => Promise<{ blob: Blob; name: string }>;
  onDownload: (blob: Blob, name: string) => void;
  onSave: (blob: Blob, name: string) => Promise<void>;
}> = ({ open, onClose, units, make, onDownload, onSave }) => {
  const [o, setO] = useState<ExportOptions>(readOptions);
  const [busy, setBusy] = useState<null | 'download' | 'save'>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ExportOptions>) => setO(prev => ({ ...prev, ...patch }));
  const ready = o.format !== 'pdf' || Object.values(o.views).some(Boolean);

  const run = async (action: 'download' | 'save') => {
    setBusy(action);
    setError(null);
    try {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...o, notes: '' })); } catch { /* private mode */ }
      const { blob, name } = await make(o);
      if (action === 'download') onDownload(blob, name);
      else await onSave(blob, name);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The file could not be made.');
    } finally {
      setBusy(null);
    }
  };

  const views: [SheetView, string][] = [['front', 'Front'], ['top', 'Top'], ['side', 'Right side'], ['iso', '3D view']];
  const radio = <T extends string | number>(name: string, value: T, current: T, onPick: (v: T) => void, label: string, testid?: string) => (
    <label key={String(value)} className="inline-flex items-center gap-2 text-sm text-ink">
      <input type="radio" name={name} checked={current === value} onChange={() => onPick(value)} data-testid={testid} />
      {label}
    </label>
  );

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title="Export"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={!!busy}>Cancel</Button>
        <Button variant="secondary" onClick={() => void run('download')} disabled={!!busy || !ready} data-testid="sketch-export-download">
          {busy === 'download' ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}Download
        </Button>
        <Button onClick={() => void run('save')} disabled={!!busy || !ready} data-testid="sketch-export-save">
          {busy === 'save' ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}Save to Documents
        </Button>
      </>}
    >
      <div className="space-y-4" data-testid="sketch-export-modal">
        <div className="flex flex-wrap gap-1 rounded-lg border border-edge p-1" role="radiogroup" aria-label="Format">
          {FORMATS.map(f => (
            <button key={f.id} type="button" role="radio" aria-checked={o.format === f.id} onClick={() => set({ format: f.id })}
              data-testid={`sketch-export-format-${f.id}`}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${o.format === f.id ? 'bg-accent-600 text-white' : 'text-ink-soft hover:bg-hover'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-ink-soft">{FORMATS.find(f => f.id === o.format)!.about}</p>

        {o.format === 'pdf' && <>
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
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {radio('iso-from', 'standard', o.isoFrom, v => set({ isoFrom: v }), 'The usual angle (front, right, above)', 'sketch-export-iso-standard')}
                  {radio('iso-from', 'current', o.isoFrom, v => set({ isoFrom: v }), 'As the view is turned now', 'sketch-export-iso-current')}
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
        </>}

        {o.format === 'png' && <>
          <Field label="Size">
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {([1, 2, 3] as const).map(n => radio('png-size', n, o.pngSize, v => set({ pngSize: v }), n === 1 ? 'As on screen' : `${n}× as big`, `sketch-export-png-${n}`))}
            </div>
          </Field>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Checkbox label="On white, without the grid" checked={o.pngPaper} onChange={e => set({ pngPaper: e.target.checked })} data-testid="sketch-export-png-paper" />
            <Checkbox label="Dimensions" checked={o.pngLabels} onChange={e => set({ pngLabels: e.target.checked })} />
          </div>
        </>}

        {o.format === 'dxf' && <>
          <Field label="What to put in it">
            <div className="flex flex-col gap-2">
              {radio('dxf-what', 'plane', o.dxfWhat, v => set({ dxfWhat: v }), 'The shapes drawn on a plane, at true size (for cutting a profile)', 'sketch-export-dxf-plane')}
              {radio('dxf-what', 'view', o.dxfWhat, v => set({ dxfWhat: v }), 'A flat view of the whole model', 'sketch-export-dxf-view')}
            </div>
          </Field>
          {o.dxfWhat === 'plane' ? (
            <Field label="Plane" htmlFor="sketch-export-dxf-plane-pick">
              <Select id="sketch-export-dxf-plane-pick" value={o.dxfPlane} onChange={e => set({ dxfPlane: e.target.value as PlaneId })} className="w-40">
                {(['front', 'side', 'ground'] as PlaneId[]).map(p => <option key={p} value={p}>{PLANE_LABELS[p]}</option>)}
              </Select>
            </Field>
          ) : (
            <div className="flex flex-wrap items-end gap-5">
              <Field label="View" htmlFor="sketch-export-dxf-view-pick">
                <Select id="sketch-export-dxf-view-pick" value={o.dxfView} onChange={e => set({ dxfView: e.target.value as OrthoView })} className="w-40">
                  <option value="front">Front</option>
                  <option value="top">Top</option>
                  <option value="side">Right side</option>
                </Select>
              </Field>
              <Checkbox label="Hidden edges (on their own layer)" checked={o.dxfHidden} onChange={e => set({ dxfHidden: e.target.checked })} className="pb-2" />
            </div>
          )}
          <p className="text-xs text-ink-faint">In {units === 'metric' ? 'millimetres' : 'inches'}, at true size.</p>
        </>}

        {error && <p className="text-sm text-red-600 dark:text-red-400" data-testid="sketch-export-error">{error}</p>}
      </div>
    </Modal>
  );
};
