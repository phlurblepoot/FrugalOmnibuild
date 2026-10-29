// src/pages/sketch/NewSketchModal.tsx
// Starts a sketch: a name, an optional project, and its units. The empty
// sketch is saved to Documents straight away and opened in the editor.
import React, { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Button, Field, Input, Modal, Select } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { getProjectsSummary, saveBinaryFile, type ProjectSummary } from '../../utils/store';
import { emptySketch, serializeSketch, SKETCH_EXTENSION, SKETCH_MIME, type SketchUnits } from './sketchModel';

export const NewSketchModal: React.FC<{
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
  onCreated: (fileId: string) => void;
}> = ({ open, onClose, defaultProjectId, onCreated }) => {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [units, setUnits] = useState<SketchUnits>('imperial');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setProjectId(defaultProjectId ?? '');
    setUnits('imperial');
    getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived))).catch(() => setProjects([]));
  }, [open, defaultProjectId]);

  const create = async () => {
    const title = name.trim() || 'Sketch';
    setBusy(true);
    try {
      const project = projects.find(p => p.id === projectId);
      const blob = new Blob([serializeSketch(emptySketch(units))], { type: SKETCH_MIME });
      const { fileId } = await saveBinaryFile(uuidv4(), blob, {
        kind: 'sketch',
        name: `${title}${SKETCH_EXTENSION}`,
        ...(project ? { projectId: project.id } : {}),
        ...(project?.customerId ? { customerId: project.customerId } : {}),
      });
      onCreated(fileId);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the sketch', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New sketch"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={create} disabled={busy} data-testid="new-sketch-create">{busy ? 'Creating…' : 'Create sketch'}</Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="new-sketch-modal">
        <Field label="Name" htmlFor="sketch-name">
          <Input id="sketch-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Cornice profile A" autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && !busy) void create(); }} />
        </Field>
        <Field label="Project" htmlFor="sketch-project" hint="Optional. The sketch is filed in this project's Documents.">
          <Select id="sketch-project" value={projectId} onChange={e => setProjectId(e.target.value)}>
            <option value="">— none —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-ink">Units</legend>
          <div className="flex flex-wrap gap-4 text-sm text-ink">
            <label className="inline-flex items-center gap-2">
              <input type="radio" name="sketch-units" checked={units === 'imperial'} onChange={() => setUnits('imperial')} />
              Feet and inches
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" name="sketch-units" checked={units === 'metric'} onChange={() => setUnits('metric')} />
              Millimetres
            </label>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
};
