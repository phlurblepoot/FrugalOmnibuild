import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // 'danger' paints the confirm button red for destructive actions.
  tone?: 'danger' | 'default';
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((value: boolean) => {
    setPending((p) => {
      p?.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  const danger = pending?.tone === 'danger';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {pending && (
          <motion.div
            className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-label={pending.title || 'Confirm'}
          >
            <motion.div
              className="w-full max-w-md bg-raised rounded-2xl shadow-xl border border-edge overflow-hidden"
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6">
                <div className="flex items-start gap-4">
                  {danger && (
                    <span className="shrink-0 w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center">
                      <AlertTriangle className="text-red-600 dark:text-red-400" size={20} />
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    {pending.title && (
                      <h2 className="text-lg font-bold text-ink">{pending.title}</h2>
                    )}
                    <p className="mt-1 text-sm text-ink-soft whitespace-pre-line">{pending.message}</p>
                  </div>
                </div>
              </div>
              <div className="px-6 py-4 pb-safe bg-sunken/40 flex flex-wrap justify-end gap-3">
                <button
                  onClick={() => close(false)}
                  className="px-4 py-2 rounded-xl border border-edge-strong text-sm font-medium text-ink-soft hover:bg-hover transition-all"
                >
                  {pending.cancelLabel || 'Cancel'}
                </button>
                <button
                  ref={confirmBtnRef}
                  onClick={() => close(true)}
                  className={`px-4 py-2 rounded-xl text-sm font-medium text-white transition-all ${
                    danger ? 'bg-red-600 hover:bg-red-700' : 'bg-accent-600 hover:bg-accent-700'
                  }`}
                >
                  {pending.confirmLabel || 'Confirm'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  );
};

// Promise-based confirm so call sites stay as terse as window.confirm:
//   if (!await confirm({ message: 'Delete this?' })) return;
export const useConfirm = () => useContext(ConfirmContext);
