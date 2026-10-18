// src/components/ui/Modal.tsx
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useDiscardGuard } from './useDiscardGuard';

const WIDTHS = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl', full: 'max-w-[95vw]' } as const;

// `:not([tabindex="-1"])` has to hang off EVERY clause, not just the last one:
// a `<button tabIndex={-1}>` is deliberately out of the tab order, and without
// the per-clause guard the `button:not([disabled])` clause matched it anyway.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].map(sel => `${sel}:not([tabindex="-1"])`).join(', ');

// Tabbable descendants in DOM order, minus the ones hidden from assistive tech.
// Deliberately cheap: no layout reads, so it stays correct under jsdom too.
const focusable = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    el => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
  );

// Every open Modal portals to document.body, so a nested modal is a SIBLING of
// the one that opened it, not a descendant — without this stack both traps see
// the same Tab, and the outer one keeps yanking focus back to its own panel.
// Only the modal on top of the stack traps; the rest stand down until it closes.
type PanelRef = { current: HTMLDivElement | null };

const trapStack: PanelRef[] = [];

// Searched from the top so an abrupt unmount of an inner modal removes ITS
// entry rather than whichever one happens to be last.
const popTrap = (ref: PanelRef): void => {
  const i = trapStack.lastIndexOf(ref);
  if (i >= 0) trapStack.splice(i, 1);
};

const pushTrap = (ref: PanelRef): void => {
  popTrap(ref);
  trapStack.push(ref);
};

const isTopTrap = (ref: PanelRef): boolean =>
  trapStack.length > 0 && trapStack[trapStack.length - 1] === ref;

/** Test-only: the trap stack is module state, so a leak across tests is real. */
export const __trapDepth = (): number => trapStack.length;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  footer?: React.ReactNode;
  width?: keyof typeof WIDTHS;
  children: React.ReactNode;
  /** Opt-in: when true, Esc and the X ask "discard changes?" before onClose runs. */
  dirty?: boolean;
}

export const Modal: React.FC<ModalProps> = ({
  open, onClose, title, footer, width = 'md', children, dirty = false,
}) => {
  const labelId = React.useId();
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  // Esc and the X go through here. Clicking the backdrop does nothing on purpose:
  // an outside click must never throw away what someone was typing.
  const requestClose = useDiscardGuard(dirty, onClose);

  // Note: the listener re-registers if `onClose` changes identity each render
  // (inline arrows). Harmless, but stable handlers via useCallback are nicer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, requestClose]);

  // Focus management: move focus into the dialog when it opens, keep Tab inside
  // it while it is open, and hand focus back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    pushTrap(panelRef);
    // The panel mounts with the animation, so focus on the next frame.
    const id = window.setTimeout(() => {
      const p = panelRef.current;
      if (!p || p.contains(document.activeElement)) return;
      (focusable(p)[0] ?? p).focus();
    }, 0);
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !isTopTrap(panelRef)) return;
      const p = panelRef.current;
      if (!p) return;
      const items = focusable(p);
      if (items.length === 0) {
        e.preventDefault();
        p.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!p.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onTab, true);
      popTrap(panelRef);
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          data-testid="modal-overlay"
          className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        >
          <motion.div
            ref={panelRef}
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-labelledby={title !== undefined ? labelId : undefined}
            className={`flex max-h-[90dvh] w-full ${WIDTHS[width]} flex-col rounded-xl border border-edge bg-raised shadow-xl`}
          >
            {title !== undefined && (
              <div className="flex shrink-0 items-center justify-between border-b border-edge px-5 py-4">
                <h2 id={labelId} className="text-base font-semibold text-ink">{title}</h2>
                <button
                  onClick={() => void requestClose()}
                  aria-label="Close dialog"
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink active:bg-hover md:min-h-0 md:min-w-0"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-edge px-5 py-4 pb-safe">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
