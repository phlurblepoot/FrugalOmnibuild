// src/pages/project/TakeoffDeleteModals.tsx
//
// The two takeoff delete-confirm dialogs extracted verbatim from ProjectView
// (Phase 5g Task 2). Behavior-preserving controlled components: ProjectView owns
// the open flags, the confirm handlers, and the close actions; this file only
// renders the dialog markup. takeoffToDelete is not read by the copy but the
// single-delete dialog only shows when one is selected, so ProjectView gates it.
import React from 'react';

interface TakeoffDeleteModalsProps {
  showDeleteAllConfirm: boolean;
  onConfirmDeleteAll: () => void;
  onCloseDeleteAll: () => void;
  showDeleteConfirm: boolean;
  onConfirmDelete: () => void;
  onCloseDelete: () => void;
}

export function TakeoffDeleteModals({
  showDeleteAllConfirm,
  onConfirmDeleteAll,
  onCloseDeleteAll,
  showDeleteConfirm,
  onConfirmDelete,
  onCloseDelete,
}: TakeoffDeleteModalsProps) {
  return (
    <>
      {showDeleteAllConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-raised rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-edge">
              <h3 className="text-lg font-semibold text-ink text-red-600">Delete All Takeoffs</h3>
            </div>
            <div className="p-6">
              <p className="text-ink-soft">
                Are you sure you want to delete ALL takeoffs in this project? This will ungroup all measurements. This action is permanent and cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                onClick={onCloseDeleteAll}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirmDeleteAll}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-raised rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-edge">
              <h3 className="text-lg font-semibold text-ink">Delete Takeoff</h3>
            </div>
            <div className="p-6">
              <p className="text-ink-soft">
                Are you sure you want to delete this takeoff? All measurements associated with it will be ungrouped. This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                onClick={onCloseDelete}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                data-testid="btn-confirm-delete"
                onClick={onConfirmDelete}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete Takeoff
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
