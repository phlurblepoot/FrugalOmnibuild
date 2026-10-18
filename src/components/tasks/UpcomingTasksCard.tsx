import React from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { Card, CardHeader, CardBody, EmptyState, Skeleton } from '../ui';

export interface UpcomingTaskItem {
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  projectName?: string | null;
  customerName?: string | null;
}

// Pure: dated + not-done, soonest first, capped. Dates are ISO 'YYYY-MM-DD'
// so lexical comparison equals chronological comparison.
export function upcomingTaskItems<T extends UpcomingTaskItem>(tasks: T[], limit = 5): T[] {
  return tasks
    .filter(t => !!t.dueDate && t.status !== 'done')
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0))
    .slice(0, limit);
}

const todayISO = () => new Date().toISOString().slice(0, 10);

interface Props {
  items: UpcomingTaskItem[];
  loading: boolean;
  title?: string;
  headerActions?: React.ReactNode;
  showContext?: boolean;
  emptyDescription?: string;
  to?: string; // where a row/"view" link points; defaults to /tasks
}

export const UpcomingTasksCard: React.FC<Props> = ({
  items, loading, title = 'Upcoming task deadlines', headerActions,
  showContext = false, emptyDescription = 'Tasks with due dates show up here.', to = '/tasks',
}) => {
  const today = todayISO();
  return (
    <Card>
      <CardHeader title={title} actions={headerActions ?? <CalendarClock size={15} className="text-ink-faint" />} />
      <CardBody className="p-0">
        {loading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState title="No upcoming tasks" description={emptyDescription} />
        ) : (
          <ul className="divide-y divide-edge">
            {items.map(t => {
              const overdue = !!t.dueDate && t.dueDate < today;
              const context = t.projectName ?? t.customerName;
              return (
                <li key={t.id}>
                  <Link to={to} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{t.title || '(untitled)'}</span>
                      {showContext && context && <span className="block truncate text-xs text-ink-faint">{context}</span>}
                    </span>
                    <span className={`shrink-0 text-xs font-medium tabular-nums ${overdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                      {t.dueDate}{overdue ? ' · overdue' : ''}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
};
