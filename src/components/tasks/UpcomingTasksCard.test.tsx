import { describe, it, expect } from 'vitest';
import { upcomingTaskItems } from './UpcomingTasksCard';

const mk = (id: string, dueDate: string | null, status = 'todo') =>
  ({ id, title: id, dueDate, status } as any);

describe('upcomingTaskItems', () => {
  it('keeps only dated, not-done tasks, sorted soonest first', () => {
    const out = upcomingTaskItems([
      mk('c', '2026-08-01'),
      mk('a', '2026-06-01'),
      mk('nodate', null),
      mk('done', '2026-05-01', 'done'),
      mk('b', '2026-07-01'),
    ]);
    expect(out.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('limits to the given count', () => {
    const items = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'].map((d, i) => mk(`t${i}`, d));
    expect(upcomingTaskItems(items, 2).map(t => t.id)).toEqual(['t0', 't1']);
  });
});
