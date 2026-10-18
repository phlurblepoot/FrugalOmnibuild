// The notification bell (ONLYOFFICE Phase 5): the unread badge, the panel,
// opening one (marks it read, follows its link), marking all read, and live
// updates from the socket, including reads made in another tab.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AppNotification } from '../../utils/store';

type Handler = (payload: any) => void;
const h = vi.hoisted(() => ({
  getNotifications: vi.fn(), markNotificationRead: vi.fn(), markAllNotificationsRead: vi.fn(),
  socket: null as null | { on: (e: string, f: Handler) => void; off: (e: string, f: Handler) => void; emit: (e: string, p?: unknown) => void },
}));
vi.mock('../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../utils/store')>()),
  getNotifications: h.getNotifications,
  markNotificationRead: h.markNotificationRead,
  markAllNotificationsRead: h.markAllNotificationsRead,
}));
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: h.socket }) }));
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ reducedMotion: true }) }));
import { NotificationsProvider } from '../../context/NotificationsContext';
import { NotificationBell, badgeText } from './NotificationBell';

const fakeSocket = () => {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on: (e: string, f: Handler) => { if (!handlers.has(e)) handlers.set(e, new Set()); handlers.get(e)!.add(f); },
    off: (e: string, f: Handler) => { handlers.get(e)?.delete(f); },
    emit: (e: string, p?: unknown) => { for (const f of handlers.get(e) ?? []) f(p); },
  };
};

const note = (id: string, over: Partial<AppNotification> = {}): AppNotification => ({
  id, userId: 'u2', type: 'task-assigned', title: `Title ${id}`, body: null, link: `/tasks?open=${id}`,
  actorUserId: 'u1', createdAt: Date.now() - 60_000, readAt: null, ...over,
});

const mount = (url = '/dashboard') => render(
  <MemoryRouter initialEntries={[url]}>
    <NotificationsProvider>
      <Routes>
        <Route path="*" element={<><NotificationBell expanded /><RouteProbe /></>} />
      </Routes>
    </NotificationsProvider>
  </MemoryRouter>,
);
const RouteProbe: React.FC = () => {
  const { pathname, search } = useLocation();
  return <span data-testid="route">{pathname + search}</span>;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.socket = fakeSocket();
  h.markNotificationRead.mockResolvedValue(undefined);
  h.markAllNotificationsRead.mockResolvedValue(undefined);
});

describe('NotificationBell', () => {
  it('keeps a live one that lands while the list is still loading (seen in e2e)', async () => {
    // The list asked for before the task existed answers after its live event.
    let answer!: (r: unknown) => void;
    h.getNotifications
      .mockReturnValueOnce(new Promise(r => { answer = r; }))
      .mockResolvedValue({ items: [note('t1')], unread: 1 });
    mount();
    act(() => h.socket!.emit('notification', { kind: 'new', notification: note('t1') }));
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('1');
    await act(async () => { answer({ items: [], unread: 0 }); });
    await waitFor(() => expect(h.getNotifications).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(await screen.findByTestId('notification-item')).toHaveTextContent('Title t1');
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');
  });

  it('uses only the newest of two loads, whichever answers last', async () => {
    let first!: (r: unknown) => void;
    h.getNotifications
      .mockReturnValueOnce(new Promise(r => { first = r; }))
      .mockResolvedValueOnce({ items: [note('new')], unread: 1 });
    mount();
    act(() => h.socket!.emit('connect'));
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('1');
    await act(async () => { first({ items: [], unread: 0 }); });
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.getByTestId('notification-item')).toHaveTextContent('Title new');
  });

  it('shows the unread count from the server, and the list with the unread marked', async () => {
    h.getNotifications.mockResolvedValue({ items: [note('a'), note('b', { readAt: 1 })], unread: 12 });
    mount();
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('9+');
    expect(screen.getByTestId('notification-bell')).toHaveAccessibleName('Notifications (12 unread)');
    fireEvent.click(screen.getByTestId('notification-bell'));
    const items = screen.getAllByTestId('notification-item');
    expect(items.map(i => i.getAttribute('data-unread'))).toEqual(['true', null]);
    expect(items[0]).toHaveTextContent('Title a');
    expect(items[0]).toHaveTextContent('1m ago');
  });

  it('opens one: marks it read and goes where it points', async () => {
    h.getNotifications.mockResolvedValue({ items: [note('a', { link: '/project/p1/rfis?open=r1' })], unread: 1 });
    mount();
    await screen.findByTestId('notification-badge');
    fireEvent.click(screen.getByTestId('notification-bell'));
    fireEvent.click(screen.getByTestId('notification-item'));
    expect(h.markNotificationRead).toHaveBeenCalledWith('a');
    expect(screen.queryByTestId('notification-badge')).toBeNull();
    expect(screen.getByTestId('route')).toHaveTextContent('/project/p1/rfis?open=r1');
    await waitFor(() => expect(screen.queryByTestId('notification-panel')).toBeNull());
  });

  it('marks everything read', async () => {
    h.getNotifications.mockResolvedValue({ items: [note('a'), note('b')], unread: 2 });
    mount();
    await screen.findByTestId('notification-badge');
    fireEvent.click(screen.getByTestId('notification-bell'));
    fireEvent.click(screen.getByTestId('notification-mark-all'));
    expect(h.markAllNotificationsRead).toHaveBeenCalled();
    expect(screen.queryByTestId('notification-badge')).toBeNull();
    expect(screen.getAllByTestId('notification-item').every(i => !i.getAttribute('data-unread'))).toBe(true);
  });

  it('takes new ones and reads from other tabs live, and reloads after a reconnect', async () => {
    h.getNotifications.mockResolvedValue({ items: [], unread: 0 });
    mount();
    await waitFor(() => expect(h.getNotifications).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('notification-badge')).toBeNull();

    act(() => { h.socket!.emit('notification', { kind: 'new', notification: note('n1', { type: 'mention', title: 'maria mentioned you in Scope.docx' }) }); });
    act(() => { h.socket!.emit('notification', { kind: 'new', notification: note('n1') }); }); // the same one twice
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.getAllByTestId('notification-item')).toHaveLength(1);
    expect(screen.getByText('maria mentioned you in Scope.docx')).toBeInTheDocument();

    act(() => { h.socket!.emit('notification', { kind: 'read', ids: ['n1'] }); });
    expect(screen.queryByTestId('notification-badge')).toBeNull();

    h.getNotifications.mockResolvedValue({ items: [note('n2')], unread: 1 });
    act(() => { h.socket!.emit('connect'); });
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('1');
  });

  it('explains what will show up when there is nothing yet, and loads nothing while signed out', async () => {
    h.getNotifications.mockResolvedValue({ items: [], unread: 0 });
    mount();
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(await screen.findByTestId('notification-empty')).toHaveTextContent(/@mentions you in a document/);

    h.socket = null;
    h.getNotifications.mockClear();
    mount();
    expect(h.getNotifications).not.toHaveBeenCalled();
  });

  it('keeps the badge small', () => {
    expect([badgeText(1), badgeText(9), badgeText(10)]).toEqual(['1', '9', '9+']);
  });

  describe('phone push taps (public/sw.js)', () => {
    let sw: EventTarget;
    beforeEach(() => {
      sw = new EventTarget();
      Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: sw });
    });

    it('with the app open: goes to the link and marks it read', async () => {
      h.getNotifications.mockResolvedValue({ items: [note('a')], unread: 1 });
      mount();
      await screen.findByTestId('notification-badge');
      act(() => { sw.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'open-notification', link: '/tasks?open=a', id: 'a' } })); });
      expect(screen.getByTestId('route')).toHaveTextContent('/tasks?open=a');
      expect(h.markNotificationRead).toHaveBeenCalledWith('a');
      expect(screen.queryByTestId('notification-badge')).toBeNull();
    });

    it('opened fresh from one: marks it read and tidies the address', async () => {
      h.getNotifications.mockResolvedValue({ items: [], unread: 1 });
      mount('/tasks?open=t1&fromNotification=b');
      await waitFor(() => expect(h.markNotificationRead).toHaveBeenCalledWith('b'));
      expect(screen.getByTestId('route')).toHaveTextContent(/^\/tasks\?open=t1$/);
    });

    it('keeps the number on the app icon in step', async () => {
      const setAppBadge = vi.fn(async () => {});
      const clearAppBadge = vi.fn(async () => {});
      Object.assign(window.navigator, { setAppBadge, clearAppBadge });
      h.getNotifications.mockResolvedValue({ items: [note('a'), note('b')], unread: 2 });
      mount();
      await waitFor(() => expect(setAppBadge).toHaveBeenLastCalledWith(2));
      fireEvent.click(screen.getByTestId('notification-bell'));
      fireEvent.click(screen.getByTestId('notification-mark-all'));
      await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
      delete (window.navigator as any).setAppBadge;
      delete (window.navigator as any).clearAppBadge;
    });
  });
});
