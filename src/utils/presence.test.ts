import { describe, it, expect } from 'vitest';
import { groupSessionsByUser, humanizeSection, describeLocation, lerp1D, lerpStep, isCursorIdle } from './presence';
import type { SessionView } from '../context/CollaborationContext';

const sess = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'noah', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome', location: null, editing: null, cursor: null, lastActive: 1,
  ...over,
});

describe('groupSessionsByUser', () => {
  it('groups by user, excludes my own session, sorts others alphabetically with me last', () => {
    const groups = groupSessionsByUser([
      sess({ sessionId: 'me', userId: 'u1', name: 'noah' }),
      sess({ sessionId: 'me2', userId: 'u1', name: 'noah', device: 'iPad · Safari' }),
      sess({ sessionId: 'z1', userId: 'u3', name: 'zoe' }),
      sess({ sessionId: 'a1', userId: 'u2', name: 'amy' }),
      sess({ sessionId: 'a2', userId: 'u2', name: 'amy', device: 'Mac · Safari' }),
    ], 'me');
    expect(groups.map(g => g.name)).toEqual(['amy', 'zoe', 'noah']);
    expect(groups[0].sessions).toHaveLength(2);
    expect(groups[2].isMe).toBe(true);
    expect(groups[2].sessions.map(s => s.sessionId)).toEqual(['me2']); // my own session excluded
  });

  it('omits the me-group when I have no other sessions', () => {
    const groups = groupSessionsByUser([
      sess({ sessionId: 'me', userId: 'u1' }),
      sess({ sessionId: 'b', userId: 'u2', name: 'amy' }),
    ], 'me');
    expect(groups.map(g => g.name)).toEqual(['amy']);
  });

  it('handles null mySessionId (socket not yet connected)', () => {
    const groups = groupSessionsByUser([sess({ sessionId: 'x', userId: 'u2', name: 'amy' })], null);
    expect(groups).toHaveLength(1);
    expect(groups[0].isMe).toBe(false);
  });
});

describe('humanizeSection', () => {
  it.each([
    ['billing', 'Billing'], ['rfis', 'RFIs'], ['punch', 'Punch List'],
    ['page', 'Canvas'], ['overview', 'Overview'], ['issues', 'Issues'],
    ['takeoff', 'Takeoff'], ['proposal', 'Proposal'], ['weird', 'Weird'], [undefined, 'Overview'],
  ])('%s -> %s', (input, expected) => expect(humanizeSection(input as any)).toBe(expected));
});

describe('describeLocation', () => {
  const names = { p1: 'Dunmore Heights' };
  it('null -> Online', () => expect(describeLocation(null, names)).toBe('Online'));
  it('canvas with label', () => expect(describeLocation(
    { path: '/project/p1/page/pg1', projectId: 'p1', section: 'page', pageId: 'pg1', label: 'Level 06' }, names))
    .toBe('Dunmore Heights · Level 06'));
  it('canvas without label', () => expect(describeLocation(
    { path: '/project/p1/page/pg1', projectId: 'p1', section: 'page', pageId: 'pg1' }, names))
    .toBe('Dunmore Heights · Canvas'));
  it('project section', () => expect(describeLocation(
    { path: '/project/p1/billing', projectId: 'p1', section: 'billing' }, names))
    .toBe('Dunmore Heights · Billing'));
  it('unknown project name degrades', () => expect(describeLocation(
    { path: '/project/pX/issues', projectId: 'pX', section: 'issues' }, names))
    .toBe('A project · Issues'));
  it.each([
    ['/dashboard', 'Dashboard'], ['/projects', 'Projects'], ['/tasks', 'Tasks'],
    ['/documents', 'Documents'], ['/customers', 'Customers'], ['/customers/c1', 'Customers'],
    ['/time', 'Time'], ['/settings', 'Settings'], ['/tools/edit', 'Document editor'],
    ['/whatever', 'Online'],
  ])('%s -> %s', (path, expected) => expect(describeLocation({ path }, names)).toBe(expected));
});

describe('lerp1D', () => {
  it('moves partway toward the target by `factor`', () => {
    expect(lerp1D(0, 100, 0.25)).toBe(25);
    expect(lerp1D(25, 100, 0.25)).toBe(43.75);
  });
  it('converges monotonically toward the target across repeated steps', () => {
    let v = 0;
    const steps = [0];
    for (let i = 0; i < 20; i++) { v = lerp1D(v, 100, 0.25); steps.push(v); }
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    expect(v).toBeCloseTo(100, 0);
  });
  it('snaps to target once within snapDistance', () => {
    expect(lerp1D(99.7, 100, 0.25, 0.5)).toBe(100);
    expect(lerp1D(100, 100, 0.25, 0.5)).toBe(100);
  });
  it('handles a target below current the same way', () => {
    expect(lerp1D(100, 0, 0.25)).toBe(75);
    expect(lerp1D(0.3, 0, 0.25, 0.5)).toBe(0);
  });
});

describe('lerpStep', () => {
  it('eases both axes independently toward the target', () => {
    expect(lerpStep({ x: 0, y: 0 }, { x: 100, y: -40 }, 0.25)).toEqual({ x: 25, y: -10 });
  });
  it('snaps once both axes are within snapDistance', () => {
    expect(lerpStep({ x: 99.8, y: 200.1 }, { x: 100, y: 200 }, 0.25, 0.5)).toEqual({ x: 100, y: 200 });
  });
  it('is a no-op once current equals target', () => {
    expect(lerpStep({ x: 50, y: 50 }, { x: 50, y: 50 }, 0.25, 0.5)).toEqual({ x: 50, y: 50 });
  });
});

describe('isCursorIdle', () => {
  it('is not idle within the threshold', () => {
    expect(isCursorIdle(1000, 1000 + 29_000)).toBe(false);
  });
  it('is idle once past the threshold', () => {
    expect(isCursorIdle(1000, 1000 + 30_001)).toBe(true);
  });
  it('respects a custom threshold', () => {
    expect(isCursorIdle(1000, 1000 + 6_000, 5_000)).toBe(true);
    expect(isCursorIdle(1000, 1000 + 4_000, 5_000)).toBe(false);
  });
  it('treats a missing lastActive as active (never wrongly hides a live cursor)', () => {
    expect(isCursorIdle(undefined, Date.now())).toBe(false);
  });
});
