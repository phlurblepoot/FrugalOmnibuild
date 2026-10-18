// src/pages/customers/CustomerTasksTab.tsx
// Customer-scoped task list — same list UI as TasksPage (via TaskListPanel)
// but pre-filtered to this customer, with no create-form or scope selectors
// (task creation still happens on the global /tasks page, deep-linkable via
// the Overview tab's attention rows).
import React, { useEffect, useState } from 'react';
import {
  Task, TaskListItem, AssignableUser, ProjectSummary,
  getTasks, getTask, setTaskStatus, getAssignableUsers, getProjectsSummary, getCustomers,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import { TaskListPanel } from '../../components/tasks/TaskListPanel';
import { TaskEditor } from '../tasks/TaskEditor';

export const CustomerTasksTab: React.FC<{ customerId: string }> = ({ customerId }) => {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<Task | null>(null);

  const reload = () => {
    getTasks({ customerId }).then(setTasks).catch(() => setTasks([]));
  };

  useEffect(() => {
    setTasks(null);
    reload();
    getAssignableUsers().then(setUsers).catch(() => setUsers([]));
    getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived))).catch(() => setProjects([]));
    getCustomers().then((cs: any[]) => setCustomers(cs.map(c => ({ id: c.id, name: c.name })))).catch(() => setCustomers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const openTask = async (id: string) => {
    try { setEditing(await getTask(id)); } catch { toast('Failed to open task', { type: 'error' }); }
  };

  const toggleDone = async (t: TaskListItem) => {
    try { await setTaskStatus(t.id, t.status === 'done' ? 'todo' : 'done'); reload(); }
    catch { toast('Failed to update task', { type: 'error' }); }
  };

  return (
    <>
      <TaskListPanel
        tasks={tasks}
        onToggleDone={toggleDone}
        onOpenTask={openTask}
        emptyDescription="Tasks tied to this customer or its projects show up here."
      />
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
    </>
  );
};
