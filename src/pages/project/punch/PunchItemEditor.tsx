// src/pages/project/punch/PunchItemEditor.tsx
import React, { useState } from 'react';
import {
  PunchItem, savePunchItem, setPunchDone, addPunchPhoto, removePunchPhoto,
} from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import { PhotoDropCard } from '../../../components/documents/PhotoDropCard';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { useDiscardGuard } from '../../../components/ui/useDiscardGuard';

interface Props {
  item: PunchItem;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}

const STAGES: { stage: string; label: string }[] = [
  { stage: 'before', label: 'Before' },
  { stage: 'during', label: 'During' },
  { stage: 'after', label: 'After' },
];

export const PunchItemEditor: React.FC<Props> = ({ item, projectId, onClose, onSaved }) => {
  const { toast } = useToast();
  const [area, setArea] = useState(item.area ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [saving, setSaving] = useState(false);

  const dirty = area !== item.area || description !== item.description;
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({
    type: 'punch',
    id: item.id,
    isDirty: () => dirty,
    onFresh: onSaved,
  });

  const dropPhoto = async (fileId: string) => {
    try { await removePunchPhoto(item.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await savePunchItem(item.id, {
        ...item,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        area, description,
      });
      toast('Punch item saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'This item changed elsewhere — reload' : 'Save failed', { type: 'error' });
    } finally { setSaving(false); }
  };

  const toggleDone = async () => {
    if (dirty) { toast('Save your changes first', { type: 'warning' }); return; }
    try { await setPunchDone(item.id, !item.done); onSaved(); } catch { toast('Failed to update item', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} dirty={dirty} title="Punch item" width="lg"
      footer={<>
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      <div className="mb-3 flex items-center gap-2">
        <Button variant={item.done ? 'secondary' : 'primary'} size="sm" onClick={toggleDone}>
          {item.done ? 'Done' : 'Mark done'}
        </Button>
      </div>
      <Field label="Area" htmlFor="punch-area"><Input id="punch-area" value={area} onChange={e => setArea(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Description" htmlFor="punch-desc"><Textarea id="punch-desc" value={description} onChange={e => setDescription(e.target.value)} rows={4} /></Field>
      </div>
      {/* One card per stage: each owns its own picker and drop target, so a
          photo always lands on the stage it was dropped into. */}
      {STAGES.map(({ stage, label }) => (
        <PhotoDropCard
          key={stage}
          title={label}
          emptyText={`No ${label.toLowerCase()} photos.`}
          testId={`punch-${stage}`}
          photos={item.photos.filter(p => p.stage === stage)}
          upload={{ kind: 'punch-photo', projectId, sourceType: 'punch', sourceId: item.id }}
          initialProjectIds={[projectId]}
          link={fileId => addPunchPhoto(item.id, fileId, stage)}
          onRemove={dropPhoto}
          onDone={onSaved}
        />
      ))}
    </Modal>
  );
};
