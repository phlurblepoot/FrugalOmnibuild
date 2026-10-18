// src/pages/TasksPage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ListChecks, Plus } from 'lucide-react';
import {
  Task, TaskListItem, AssignableUser, ProjectSummary,
  getTasks, getTask, createTask, setTaskStatus, getAssignableUsers,
  getProjectsSummary, getCustomers,
} from '../utils/store';
import { useToast } from '../components/Toast';
import { Button, Card, CardBody, Field, Input, Select } from '../components/ui';
import { TaskListPanel } from '../components/tasks/TaskListPanel';
import { TaskEditor } from './tasks/TaskEditor';
import { useLiveQuery } from '../hooks/useLiveQuery';

export const TasksPage: React.FC = () => {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<Task | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newDue, setNewDue] = useState('');
  const [newProjectId, setNewProjectId] = useState<string>('');
  const [newCustomerId, setNewCustomerId] = useState<string>('');

  const [searchParams, setSearchParams] = useSearchParams();

  const reload = () => {
    const projectId = searchParams.get('projectId') || undefined;
    const customerId = searchParams.get('customerId') || undefined;
    getTasks({ projectId, customerId }).then(setTasks).catch(() => setTasks([]));
    getAssignableUsers().then(setUsers).catch(() => setUsers([]));
    getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived))).catch(() => setProjects([]));
    getCustomers().then((cs: any[]) => setCustomers(cs.map(c => ({ id: c.id, name: c.name })))).catch(() => setCustomers([]));
  };
  useLiveQuery(reload, { types: ['task'] });

  // Re-fetch when the project/customer scope in the URL changes.
  useEffect(() => {
    const projectId = searchParams.get('projectId') || undefined;
    const customerId = searchParams.get('customerId') || undefined;
    getTasks({ projectId, customerId }).then(setTasks).catch(() => setTasks([]));
  }, [searchParams.get('projectId'), searchParams.get('customerId')]);

  // Focus the create-form input when arriving via the command palette's "New task" action.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      const el = document.getElementById('new-task-title') as HTMLInputElement | null;
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('new'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Open a specific task's editor when arriving via CreateFromThreadMenu
  // (mail Task 3) — same one-shot query-param convention as ?new=1 above.
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    openTask(openId);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('open'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const list = tasks ?? [];

  const scopeProjectId = searchParams.get('projectId') || '';
  const scopeCustomerId = searchParams.get('customerId') || '';
  const scopeProjectName = projects.find(p => p.id === scopeProjectId)?.name;
  const scopeCustomerName = customers.find(c => c.id === scopeCustomerId)?.name;

  const setScope = (key: 'projectId' | 'customerId', value: string) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      // project and customer scope are mutually exclusive in the filter bar
      p.delete('projectId'); p.delete('customerId');
      if (value) p.set(key, value);
      return p;
    }, { replace: true });
  };

  useEffect(() => {
    setNewProjectId(scopeProjectId);
    setNewCustomerId(scopeProjectId ? '' : scopeCustomerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProjectId, scopeCustomerId]);

  // Distinct, non-empty category names for the create-form datalist.
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const t of list) { const c = t.category.trim(); if (c) seen.add(c); }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [list]);

  const openTask = async (id: string) => {
    try { setEditing(await getTask(id)); } catch { toast('Failed to open task', { type: 'error' }); }
  };

  const toggleDone = async (t: TaskListItem) => {
    try { await setTaskStatus(t.id, t.status === 'done' ? 'todo' : 'done'); reload(); }
    catch { toast('Failed to update task', { type: 'error' }); }
  };

  const addTask = async () => {
    if (!newTitle.trim()) { toast('Enter a title', { type: 'warning' }); return; }
    try {
      await createTask({
        category: newCategory.trim(),
        title: newTitle.trim(),
        assigneeUserId: newAssignee || null,
        dueDate: newDue || null,
        projectId: newProjectId || null,
        customerId: newProjectId ? null : (newCustomerId || null), // project derives its own customer server-side
      });
      setNewCategory('');
      setNewTitle('');
      setNewAssignee('');
      setNewDue('');
      reload();
    } catch { toast('Failed to create task', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center gap-2">
        <ListChecks size={22} className="text-accent-600 dark:text-accent-400" />
        <h1 className="text-xl font-bold text-ink">Tasks</h1>
      </div>

      {(scopeProjectName || scopeCustomerName) && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-lg bg-accent-50 px-3 py-2 text-sm dark:bg-accent-950/30">
          <span className="text-ink-soft">
            Showing tasks for <span className="font-semibold text-ink">{scopeProjectName ?? scopeCustomerName}</span>
          </span>
          <button type="button" onClick={() => setScope('projectId', '')}
            className="shrink-0 text-xs font-medium text-accent-600 hover:underline">Clear</button>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-end gap-2">
        <Field label="Project" htmlFor="filter-project">
          <Select id="filter-project" value={scopeProjectId} onChange={e => setScope('projectId', e.target.value)} className="w-48">
            <option value="">All projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Customer" htmlFor="filter-customer">
          <Select id="filter-customer" value={scopeCustomerId} onChange={e => setScope('customerId', e.target.value)} className="w-48">
            <option value="">All customers</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>

      {/* Create form */}
      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Category" htmlFor="new-task-category">
              <Input id="new-task-category" list="task-categories" value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                placeholder="e.g. Office" className="w-40" />
              <datalist id="task-categories">
                {categoryOptions.map(c => <option key={c} value={c} />)}
              </datalist>
            </Field>
            <Field label="Task" htmlFor="new-task-title">
              <Input id="new-task-title" value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTask(); }}
                placeholder="What needs doing?" className="w-72" />
            </Field>
            <Field label="Assignee" htmlFor="new-task-assignee">
              <Select id="new-task-assignee" value={newAssignee}
                onChange={e => setNewAssignee(e.target.value)} className="w-40">
                <option value="">Unassigned</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </Select>
            </Field>
            <Field label="Due" htmlFor="new-task-due">
              <Input id="new-task-due" type="date" value={newDue}
                onChange={e => setNewDue(e.target.value)} className="w-40" />
            </Field>
            <Field label="Project" htmlFor="new-task-project">
              <Select id="new-task-project" value={newProjectId}
                onChange={e => { setNewProjectId(e.target.value); setNewCustomerId(''); }} className="w-44">
                <option value="">— none —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Customer" htmlFor="new-task-customer">
              <Select id="new-task-customer" value={newProjectId ? (projects.find(p => p.id === newProjectId)?.customerId ?? '') : newCustomerId}
                disabled={!!newProjectId}
                onChange={e => setNewCustomerId(e.target.value)} className="w-44">
                <option value="">— none —</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Button onClick={addTask} disabled={!newTitle.trim()}><Plus size={15} />Add</Button>
          </div>
        </CardBody>
      </Card>

      <TaskListPanel tasks={tasks} onToggleDone={toggleDone} onOpenTask={openTask} />

      {editing && (
        <TaskEditor
          key={`${editing.id}:${editing.version}`}
          task={editing}
          users={users}
          projects={projects}
          customers={customers}
          onClose={() => setEditing(null)}
          onSaved={async () => { try { setEditing(await getTask(editing.id)); } catch { setEditing(null); } reload(); }}
        />
      )}
    </div>
  );
};
