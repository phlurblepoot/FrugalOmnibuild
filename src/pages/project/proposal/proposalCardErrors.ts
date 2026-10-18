// src/pages/project/proposal/proposalCardErrors.ts
// Shared error handling for the photos/attachments cards' draft-only
// mutations (ProposalPhotosCard, ProposalAttachmentsCard). A
// ProposalLockedError means the proposal was locked (sent, or
// accepted/declined/generated elsewhere) after this card loaded — every
// further draft-only write will just 409 the same way, so the message says
// so instead of a generic failure that invites a retry.
import { ProposalLockedError } from '../../../utils/store';

type ToastFn = (message: string, options?: { type?: 'success' | 'error' | 'warning' | 'info' }) => void;

const toastFor = (e: unknown, toast: ToastFn, fallbackMessage: string) => {
  if (e instanceof ProposalLockedError) {
    toast('This proposal was sent and is now locked', { type: 'warning' });
    return;
  }
  toast(fallbackMessage, { type: 'error' });
};

// Single-mutation handlers (caption edit, remove): resync only when locking
// caused the failure, so the editor reloads into read-only instead of
// leaving controls that will just 409 again on retry. An ordinary failure
// leaves the card as-is — the one write either happened or it didn't.
export const handleProposalCardError = (e: unknown, toast: ToastFn, onChanged: () => void, fallbackMessage: string) => {
  toastFor(e, toast, fallbackMessage);
  if (e instanceof ProposalLockedError) onChanged();
};

// Two-write handlers (reorder swaps two sortOrders): a partial failure can
// leave the server with duplicate sortOrder values, so the caller always
// resyncs afterward (typically from a `finally`) regardless of error type —
// this only toasts.
export const toastProposalCardError = toastFor;
