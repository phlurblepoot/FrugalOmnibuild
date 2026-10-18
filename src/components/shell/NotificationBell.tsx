// src/components/shell/NotificationBell.tsx — the notification bell, in the
// sidebar next to who's online (ONLYOFFICE Phase 5). A badge counts the
// unread; the panel lists the newest, and clicking one opens what it's about
// and marks it read. Like the presence popover, the panel is portaled to
// <body> because the sidebar clips.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AtSign, Bell, CheckCheck, FileQuestionMark, ListTodo, MailCheck, MessageSquareReply, Smartphone } from 'lucide-react';
import { useNotifications } from '../../context/NotificationsContext';
import { useTheme } from '../../context/ThemeContext';
import { timeAgo } from '../../utils/time';
import type { AppNotification, NotificationType } from '../../utils/store';

const ICONS: Record<NotificationType, React.FC<{ size?: number; className?: string }>> = {
  mention: AtSign,
  'comment-reply': MessageSquareReply,
  'task-assigned': ListTodo,
  'rfi-assigned': FileQuestionMark,
  'rfi-answered': MailCheck,
};

/** "9+" past nine, so the badge stays a dot-sized pill. */
export const badgeText = (n: number) => (n > 9 ? '9+' : String(n));

export const NotificationBell: React.FC<{ expanded: boolean }> = ({ expanded }) => {
  const { items, unread, markRead, markAllRead } = useNotifications();
  const { reducedMotion } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const openOne = (n: AppNotification) => {
    markRead(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const label = unread ? `Notifications (${unread} unread)` : 'Notifications';
  return (
    <>
      <button
        type="button"
        data-testid="notification-bell"
        onClick={() => setOpen(o => !o)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        className={`relative flex shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-hover hover:text-ink transition-colors ${
          expanded ? 'h-9 w-9' : 'h-9 w-full'
        }`}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            className={`absolute top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-surface ${
              expanded ? 'right-0.5' : 'right-2.5'
            }`}
          >
            {badgeText(unread)}
          </span>
        )}
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
              <motion.div
                data-testid="notification-panel"
                role="dialog"
                aria-label="Notifications"
                initial={reducedMotion ? false : { opacity: 0, y: 8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 8, scale: 0.97 }}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.15 }}
                className={`fixed bottom-24 z-[81] flex max-h-[min(32rem,calc(100dvh-8rem))] flex-col overflow-hidden rounded-2xl border border-edge glass-panel shadow-xl
                  inset-x-2 md:inset-x-auto md:w-80 ${expanded ? 'md:left-2' : 'md:left-16'}`}
              >
                <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                  <p className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    Notifications{unread ? ` — ${unread} unread` : ''}
                  </p>
                  {unread > 0 && (
                    <button
                      type="button"
                      data-testid="notification-mark-all"
                      onClick={markAllRead}
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent-600 hover:bg-hover dark:text-accent-400"
                    >
                      <CheckCheck size={13} /> Mark all read
                    </button>
                  )}
                </div>
                {items.length === 0 ? (
                  <p className="px-4 pb-4 text-sm text-ink-soft" data-testid="notification-empty">
                    Nothing yet. You'll hear here when someone @mentions you in a document, assigns you a task or an RFI,
                    or a GC answers an RFI you sent or own.
                  </p>
                ) : (
                  <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
                    {items.map(n => {
                      const Icon = ICONS[n.type] ?? Bell;
                      return (
                        <li key={n.id}>
                          <button
                            type="button"
                            data-testid="notification-item"
                            data-unread={n.readAt ? undefined : 'true'}
                            onClick={() => openOne(n)}
                            className="flex w-full items-start gap-2.5 px-4 py-2 text-left hover:bg-hover transition-colors"
                          >
                            <Icon size={15} className={`mt-0.5 shrink-0 ${n.readAt ? 'text-ink-faint' : 'text-accent-600 dark:text-accent-400'}`} />
                            <span className="min-w-0 flex-1">
                              <span className={`block text-sm ${n.readAt ? 'text-ink-soft' : 'font-semibold text-ink'}`}>{n.title}</span>
                              {n.body && <span className="block line-clamp-2 text-xs text-ink-soft">{n.body}</span>}
                              <span className="block text-[11px] text-ink-faint">{timeAgo(n.createdAt)}</span>
                            </span>
                            {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent-500" aria-label="Unread" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button
                  type="button"
                  data-testid="notification-phone-settings"
                  onClick={() => { setOpen(false); navigate('/settings?tab=preferences#phone-notifications'); }}
                  className="flex items-center gap-1.5 border-t border-edge px-4 py-2 text-left text-xs text-ink-soft hover:bg-hover hover:text-ink transition-colors"
                >
                  <Smartphone size={13} /> Get these on your phone…
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
};
