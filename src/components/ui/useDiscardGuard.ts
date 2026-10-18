// src/components/ui/useDiscardGuard.ts
import React from 'react';
import { useConfirm } from '../ConfirmDialog';

/**
 * Wraps a close handler: when `dirty`, asks "discard changes?" first and only
 * calls `onClose` on a yes. Not dirty, it closes straight away. `Modal` uses it
 * for Esc and the X when given `dirty`; a form's footer Close / Cancel button
 * should use it too so every way of closing asks the same question.
 */
export function useDiscardGuard(dirty: boolean, onClose: () => void): () => Promise<void> {
  const confirm = useConfirm();
  const asking = React.useRef(false);
  return React.useCallback(async () => {
    if (!dirty) { onClose(); return; }
    if (asking.current) return;
    asking.current = true;
    try {
      const ok = await confirm({
        title: 'Discard changes?',
        message: 'You have unsaved changes. Close without saving?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
      if (ok) onClose();
    } finally {
      asking.current = false;
    }
  }, [dirty, onClose, confirm]);
}
