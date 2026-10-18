import React from 'react';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';

export interface UploadFailure {
  fileName: string;
  pageNum: number | null;
  reason: string;
}

interface Props {
  open: boolean;
  failures: UploadFailure[];
  totalProcessed: number;
  totalExpected: number;
  isRetrying: boolean;
  retryStatus: string;
  retryCurrent: number;
  retryTotal: number;
  retryFileName?: string;
  canRetry: boolean;
  onRetry: () => void;
  onClose: () => void;
}

export const UploadFailuresModal: React.FC<Props> = ({
  open,
  failures,
  totalProcessed,
  totalExpected,
  isRetrying,
  retryStatus,
  retryCurrent,
  retryTotal,
  retryFileName,
  canRetry,
  onRetry,
  onClose,
}) => {
  if (!open) return null;

  const byFile = new Map<string, UploadFailure[]>();
  failures.forEach(f => {
    const arr = byFile.get(f.fileName) ?? [];
    arr.push(f);
    byFile.set(f.fileName, arr);
  });

  const failedCount = failures.length;
  const progressPct = retryTotal > 0
    ? Math.min(100, Math.max(0, (retryCurrent / retryTotal) * 100))
    : 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4">
      <div className="bg-raised rounded-xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[85vh]">
        <div className="p-4 border-b border-edge bg-amber-50 dark:bg-amber-900/20 flex items-start gap-3">
          <AlertTriangle className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" size={22} />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-ink">
              Some pages couldn't be imported
            </h3>
            <p className="text-sm text-ink-soft mt-0.5">
              {totalProcessed} of {totalExpected} page{totalExpected === 1 ? '' : 's'} imported successfully.
            </p>
          </div>
          {!isRetrying && (
            <button
              onClick={onClose}
              className="text-ink-faint hover:text-ink flex-shrink-0"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {isRetrying ? (
            <div className="space-y-3">
              <p className="text-sm text-ink">
                Retrying failed pages{retryFileName ? ` from ${retryFileName}` : ''}…
              </p>
              <div>
                <div className="flex justify-between text-xs text-ink-soft mb-1">
                  <span className="truncate pr-2">{retryStatus || 'preparing'}</span>
                  {retryTotal > 0 && <span className="flex-shrink-0">{retryCurrent} / {retryTotal}</span>}
                </div>
                <div className="h-2 bg-sunken rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-500 transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink">
                {failedCount} {failedCount === 1 ? 'item' : 'items'} failed during upload. You can retry them now or continue without them — you'll still see the pages that imported successfully.
              </p>
              <div className="space-y-2 text-xs">
                {Array.from(byFile.entries()).map(([fileName, arr]) => {
                  const fileLevel = arr.find(a => a.pageNum == null);
                  const pageFailures = arr.filter(a => a.pageNum != null);
                  return (
                    <div
                      key={fileName}
                      className="border border-edge rounded-lg p-2.5 bg-sunken"
                    >
                      <div className="font-medium text-ink truncate" title={fileName}>
                        {fileName}
                      </div>
                      {fileLevel && (
                        <div className="mt-1 text-ink-soft">
                          Whole file failed: {fileLevel.reason}
                        </div>
                      )}
                      {pageFailures.length > 0 && (
                        <div className="mt-1 text-ink-soft">
                          Failed page{pageFailures.length === 1 ? '' : 's'}:{' '}
                          {pageFailures.map(p => p.pageNum).join(', ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-edge bg-sunken flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isRetrying}
            className="px-4 py-2 text-sm font-medium text-ink-soft hover:bg-hover active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-all"
          >
            Continue without them
          </button>
          <button
            onClick={onRetry}
            disabled={isRetrying || !canRetry || failedCount === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg flex items-center gap-2 transition-all"
          >
            <RotateCcw size={14} />
            {isRetrying ? 'Retrying…' : 'Retry failed pages'}
          </button>
        </div>
      </div>
    </div>
  );
};
