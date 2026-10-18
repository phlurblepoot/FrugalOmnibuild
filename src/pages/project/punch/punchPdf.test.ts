import { describe, it, expect } from 'vitest';
import { groupByArea } from './punchPdf';

describe('groupByArea', () => {
  it('groups items by area, Unassigned last, with done/total counts', () => {
    const groups = groupByArea([
      { area: 'Bath', description: 'b', done: 0 } as any,
      { area: '', description: 'u', done: 1 } as any,
      { area: 'Bath', description: 'b2', done: 1 } as any,
    ]);
    expect(groups.map(g => g.area)).toEqual(['Bath', 'Unassigned']);
    expect(groups[0].items.length).toBe(2);
    expect(groups[0].done).toBe(1);
    expect(groups[0].total).toBe(2);
  });
});
