// src/pages/tasks/TaskEditor.tsx
import React, { useState } from 'react';
import {
  Task, AssignableUser, ProjectSummary, saveTask, setTaskStatus, addTaskPhoto, removeTaskPhoto,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Modal, Select, Textarea } from '../../components/ui';
import { PhotoDropCard } from '../../components/documents/PhotoDropCard';
import { useCollabEditing } from '../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../components/EditPresenceBanner';
import { useDiscardGuard } from '../../components/ui/useDiscardGuard';

interface Props {
  task: Task;
  users: AssignableUser[];
  projects: ProjectSummary[];
  customers: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}

const STATUSES: { value: string; label: string }[] = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

const STAGES: { stage: string; label: string }[] = [
  { stage: 'before', label: 'Before' },
  { stage: 'in_progress', label: 'In progress' },
  { stage: 'after', label: 'After' },
];

export const TaskEditor: React.FC<Props> = ({ task, users, projects, customers, onClose, onSaved }) => {
  const { toast } = useToast();
  const [category, setCategory] = useState(task.category ?? '');
  const [title, setTitle] = useState(task.title ?? '');
  const [notes, setNotes] = useState(task.notes ?? '');
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(task.assigneeUserId ?? null);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [projectId, setProjectId] = useState<string | null>(task.projectId ?? null);
  const [customerId, setCustomerId] = useState<string | null>(task.customerId ?? null);

  // Selecting a project locks the customer to that project's customer.
  const onProjectChange = (next: string) => {
    if (next) {
      const p = projects.find(pr => pr.id === next);
      setProjectId(next);
      setCustomerId(p?.customerId ?? null);
    } else {
      setProjectId(null);
      setCustomerId(null); // clearing the project clears its derived customer; user can set one directly
    }
  };
  const [saving, setSaving] = useState(false);

  // A task carries a customer of its own only when it has no project, matching
  // how the server derives customer from the project when one is set — and
  // what decides whether a new photo goes through the project upload or
  // straight into the global file store.
  const photoUpload = {
    kind: 'task-photo',
    sourceType: 'task',
    sourceId: task.id,
    ...(task.projectId ? { projectId: task.projectId } : task.customerId ? { customerId: task.customerId } : {}),
  };

  const dirty =
    category !== (task.category ?? '') ||
    title !== (task.title ?? '') ||
    notes !== (task.notes ?? '') ||
    assigneeUserId !== (task.assigneeUserId ?? null) ||
    dueDate !== (task.dueDate ?? '') ||
    projectId !== (task.projectId ?? null) ||
    customerId !== (task.customerId ?? null);
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({
    type: 'task',
    id: task.id,
    isDirty: () => dirty,
    onFresh: onSaved,   // parent refetches the task and (via key remount) resets this form
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveTask(task.id, {
        ...task,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        category, title, notes, assigneeUserId, dueDate: dueDate || null, projectId, customerId,
      });
      toast('Task saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'This task changed elsewhere — reload' : 'Save failed', { type: 'error' });
    } finally { setSaving(false); }
  };

  const changeStatus = async (next: string) => {
    if (next === task.status) return;
    if (dirty) { toast('Save your changes first', { type: 'warning' }); return; }
    try { await setTaskStatus(task.id, next); onSaved(); } catch { toast('Failed to update status', { type: 'error' }); }
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeTaskPhoto(task.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} dirty={dirty} title="Task" width="lg"
      footer={<>
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      <div className="mb-3">
        <Field label="Status" htmlFor="task-status">
          <Select id="task-status" value={task.status} onChange={e => changeStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Title" htmlFor="task-title"><Input id="task-title" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Category" htmlFor="task-category"><Input id="task-category" value={category} onChange={e => setCategory(e.target.value)} /></Field>
      </div>
      <div className="mt-3">
        <Field label="Assignee" htmlFor="task-assignee">
          <Select id="task-assignee" value={assigneeUserId ?? ''} onChange={e => setAssigneeUserId(e.target.value || null)}>
            <option value="">Unassigned</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Project" htmlFor="task-project">
          <Select id="task-project" value={projectId ?? ''} onChange={e => onProjectChange(e.target.value)}>
            <option value="">— none —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Customer" htmlFor="task-customer">
          <Select id="task-customer" value={customerId ?? ''} disabled={!!projectId}
            onChange={e => setCustomerId(e.target.value || null)}>
            <option value="">— none —</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {projectId && <p className="mt-1 text-xs text-ink-faint">Set by the selected project.</p>}
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Due date" htmlFor="task-due"><Input id="task-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></Field>
      </div>
      <div className="mt-3">
        <Field label="Notes" htmlFor="task-notes"><Textarea id="task-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={4} /></Field>
      </div>
      {/* One card per stage: each owns its own picker and drop target, so a
          photo always lands on the stage it was dropped into. */}
      {STAGES.map(({ stage, label }) => (
        <PhotoDropCard
          key={stage}
          title={label}
          emptyText={`No ${label.toLowerCase()} photos.`}
          testId={`task-${stage}`}
          photos={task.photos.filter(p => p.stage === stage)}
          upload={photoUpload}
          initialProjectIds={task.projectId ? [task.projectId] : undefined}
          link={fileId => addTaskPhoto(task.id, fileId, stage)}
          onRemove={dropPhoto}
          onDone={onSaved}
        />
      ))}
    </Modal>
  );
};
