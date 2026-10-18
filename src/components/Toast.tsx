import React, { createContext, useCallback, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, CheckCircle, Info, X, XCircle } from 'lucide-react';

type ToastType = 'info' | 'success' | 'warning' | 'error';

interface ToastOptions {
  type?: ToastType;
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

let counter = 0;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, options: ToastOptions = {}) => {
    const id = ++counter;
    const type = options.type ?? 'info';
    const duration = options.duration ?? 3000;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);

  const dismiss = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

  // Portalled to <body> and stacked above every overlay in the app. Rendered
  // inline at z-[200] it lost to the Modal overlay's z-[250] (and to
  // ConfirmDialog's z-[300], the command palette's z-[400], NotesBoard's
  // z-[9999]) — both live in the root stacking context, so the higher z-index
  // simply won and a toast fired from inside a dialog was invisible behind it.
  // A toast is the last thing that should ever be covered, so it sits on top
  // of that whole ladder.
  const layer = (
    <div
      data-testid="toast-container"
      className="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 pointer-events-none"
    >
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.18 }}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium max-w-sm ${
              t.type === 'success' ? 'bg-green-600 text-white' :
              t.type === 'warning' ? 'bg-amber-500 text-white' :
              t.type === 'error'   ? 'bg-red-600 text-white' :
                                     'bg-black/90 text-white'
            }`}
          >
            {t.type === 'success' && <CheckCircle size={16} className="shrink-0" />}
            {t.type === 'warning' && <AlertCircle size={16} className="shrink-0" />}
            {t.type === 'error'   && <XCircle size={16} className="shrink-0" />}
            {t.type === 'info'    && <Info size={16} className="shrink-0" />}
            <span className="flex-1">{t.message}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="shrink-0 opacity-70 hover:opacity-100">
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {typeof document === 'undefined' ? layer : createPortal(layer, document.body)}
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
