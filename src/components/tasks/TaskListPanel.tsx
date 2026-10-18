// src/components/tasks/TaskListPanel.tsx
// Filter toolbar + category-grouped task list. Extracted from TasksPage so the
// same list UI (status pills, assignee, due dates, photo counts) can be
// embedded in a scoped context (e.g. a customer's Tasks tab) without the
// page's create-form or project/customer scope selectors.
import React, { useMemo, useState } from 'react';
import { ListChecks, ImageIcon } from 'lucide-react';
import { TaskListItem } from '../../utils/store';
import { Card, CardBody, EmptyState, Skeleton } from '../ui';
import { TaskStatusPill } from '../ui/TaskStatusPill';
import { EditingChip } from '../EditingChip';
import { useReplyFlags } from '../../hooks/useReplyFlags';
import { ReplyFlagChip } from '../documents/ReplyFlagChip';
import { useReveal } from '../../hooks/useReveal';

type Filter = 'all' | 'mine' | 'todo' | 'in_progress' | 'done' | 'overdue';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'My tasks' },
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
  { key: 'overdue', label: 'Overdue' },
];

const todayISO = new Date().toISOString().slice(0, 10);
const isOverdue = (t: TaskListItem) => !!t.dueDate && t.dueDate < todayISO && t.status !== 'done';

interface CategoryGroup { key: string; label: string; items: TaskListItem[]; }
const UNCATEGORIZED = 'Uncategorized';

// Reveals a category-group Card on scroll (Wave 3 Task 11). A dedicated
// component (not an inline hook call in .map) so each group gets its own
// IntersectionObserver — hooks can't be called a variable number of times
// per render.
const RevealGroup: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const ref = useReveal<HTMLDivElement>();
  return <div ref={ref}>{children}</div>;
};

export const TaskListPanel: React.FC<{
  tasks: TaskListItem[] | null;
  onToggleDone: (t: TaskListItem) => void;
  onOpenTask: (id: string) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}> = ({
  tasks, onToggleDone, onOpenTask,
  emptyTitle = 'No tasks',
  emptyDescription = 'Create a task above to start tracking work across the company.',
}) => {
  const [filter, setFilter] = useState<Filter>('all');

  const currentUser = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
  }, []);

  const list = tasks ?? [];
  const replyFlags = useReplyFlags('task', list.map(t => t.id));

  const filtered = useMemo(() => {
    switch (filter) {
      case 'mine': return list.filter(t => t.assigneeUserId === currentUser.id);
      case 'todo': return list.filter(t => t.status === 'todo');
      case 'in_progress': return list.filter(t => t.status === 'in_progress');
      case 'done': return list.filter(t => t.status === 'done');
      case 'overdue': return list.filter(isOverdue);
      default: return list;
    }
  }, [list, filter, currentUser.id]);

  // Group by category, preserving server order within each group; Uncategorized last.
  const groups = useMemo<CategoryGroup[]>(() => {
    const map = new Map<string, CategoryGroup>();
    for (const t of filtered) {
      const trimmed = t.category.trim();
      const key = trimmed || UNCATEGORIZED;
      let g = map.get(key);
      if (!g) { g = { key, label: trimmed || UNCATEGORIZED, items: [] }; map.set(key, g); }
      g.items.push(t);
    }
    const out = Array.from(map.values());
    out.sort((a, b) => {
      if (a.key === UNCATEGORIZED) return 1;
      if (b.key === UNCATEGORIZED) return -1;
      return 0; // otherwise keep first-seen (server) order
    });
    return out;
  }, [filtered]);

  return (
    <div>
      {/* Filter toolbar */}
      <div className="mb-5 flex flex-wrap gap-1 rounded-xl bg-sunken p-1 w-fit">
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key
                ? 'bg-raised text-ink shadow-sm'
                : 'text-ink-faint hover:text-ink'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {tasks === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<ListChecks size={22} />} title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="space-y-5">
          {groups.map(g => (
            <RevealGroup key={g.key}>
            <Card>
              <CardBody>
                <h2 className="mb-2 text-sm font-semibold text-ink">{g.label}</h2>
                <ul className="divide-y divide-edge">
                  {g.items.map(t => {
                    const overdue = isOverdue(t);
                    const isDone = t.status === 'done';
                    return (
                      <li key={t.id} className="flex items-center gap-3 py-2">
                        <input type="checkbox" checked={isDone}
                          onChange={() => onToggleDone(t)}
                          className="size-4 shrink-0 rounded border-edge-strong accent-accent-600"
                          aria-label={isDone ? 'Mark not done' : 'Mark done'} />
                        <button type="button" onClick={() => onOpenTask(t.id)}
                          className="flex flex-1 flex-wrap items-center gap-2 text-left">
                          <span className={`flex-1 min-w-0 text-sm ${isDone ? 'text-ink-faint line-through' : 'text-ink'}`}>
                            {t.title || '(untitled)'}
                          </span>
                          <EditingChip type="task" id={t.id} />
                          {replyFlags.has(t.id) && <ReplyFlagChip data-testid={`task-reply-flag-${t.id}`} />}
                          <span className={`shrink-0 text-xs ${t.assigneeUsername ? 'text-ink-soft' : 'text-ink-faint'}`}>
                            {t.assigneeUsername || 'Unassigned'}
                          </span>
                          {(t.projectName || t.customerName) && (
                            <span className="shrink-0 truncate text-xs text-accent-600 dark:text-accent-400" title={t.projectName ?? t.customerName ?? ''}>
                              {t.projectName ?? t.customerName}
                            </span>
                          )}
                          <TaskStatusPill status={t.status} />
                          {t.dueDate && (
                            <span className={`shrink-0 text-xs tabular-nums ${overdue ? 'font-semibold text-red-600 dark:text-red-400' : 'text-ink-faint'}`}>
                              {t.dueDate}
                            </span>
                          )}
                          {t.photoCount > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-faint">
                              <ImageIcon size={13} />{t.photoCount}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </CardBody>
            </Card>
            </RevealGroup>
          ))}
        </div>
      )}
    </div>
  );
};
