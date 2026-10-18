import React from 'react';
import { X, FileImage, Trash2, Plus, Upload, Loader2 } from 'lucide-react';
import { Project } from '../types';
import { PageNamingStep, NamingStepPage, ExistingSheet } from './PageNamingStep';
import { AiScanProgress } from '../utils/aiSheets';
import { AddFilesButton } from './documents/AddFilesButton';

export interface AddPagesProgress {
  status: string;
  current: number;
  total: number;
  currentFile: number;
  totalFiles: number;
}

export interface AddPagesModalProps {
  open: boolean;
  onClose: () => void;
  project: Project;

  addPagesStep: 'details' | 'name_pages';
  isNamingExistingPages: boolean;

  newPlanSetName: string;
  setNewPlanSetName: React.Dispatch<React.SetStateAction<string>>;
  newPlanSetDate: string;
  setNewPlanSetDate: (value: string) => void;
  newPlanSetFiles: File[];
  setNewPlanSetFiles: React.Dispatch<React.SetStateAction<File[]>>;
  removeNewPlanSetFile: (indexToRemove: number) => void;

  useExistingPlanSet: boolean;
  setUseExistingPlanSet: (value: boolean) => void;
  targetPlanSetId: string;
  setTargetPlanSetId: (value: string) => void;

  pendingPages: NamingStepPage[];
  setPendingPages: (pages: NamingStepPage[]) => void;
  pendingThumbnails: Record<string, string>;

  /** Existing logical sheets the incoming pages can be matched against — drives
   *  the Revision Review step. Only supplied for the add-set flow (not the
   *  rename-existing-pages flow). */
  reviewSheets?: ExistingSheet[];
  /** Plan set the incoming pages belong to (scopes the duplicate check). */
  reviewPlanSetId?: string;

  isAddingPages: boolean;
  addProgress: AddPagesProgress;

  fileInputRef: React.RefObject<HTMLInputElement>;

  onAddPages: (e: React.FormEvent) => void | Promise<void>;
  onConfirmAddPages: () => void | Promise<void>;
  onAiScan?: (report: (p: AiScanProgress) => void) => Promise<void>;
}

export const AddPagesModal: React.FC<AddPagesModalProps> = ({
  open,
  onClose,
  project,
  addPagesStep,
  isNamingExistingPages,
  newPlanSetName,
  setNewPlanSetName,
  newPlanSetDate,
  setNewPlanSetDate,
  newPlanSetFiles,
  setNewPlanSetFiles,
  removeNewPlanSetFile,
  useExistingPlanSet,
  setUseExistingPlanSet,
  targetPlanSetId,
  setTargetPlanSetId,
  pendingPages,
  setPendingPages,
  pendingThumbnails,
  reviewSheets,
  reviewPlanSetId,
  isAddingPages,
  addProgress,
  fileInputRef,
  onAddPages,
  onConfirmAddPages,
  onAiScan,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className={`bg-raised rounded-2xl shadow-xl w-full ${addPagesStep === 'name_pages' ? 'max-w-4xl' : 'max-w-md'} overflow-hidden flex flex-col max-h-[90vh]`}>
        <div className="p-6 border-b border-edge flex justify-between items-center">
          <div>
            <h3 className="text-xl font-bold text-ink">
              {addPagesStep === 'details' ? 'Add New Plan Set' : 'Name Pages'}
            </h3>
            <p className="text-sm text-ink-soft mt-1">
              {addPagesStep === 'details' ? 'Upload a revised or new set of blueprints' : 'Review and rename the imported pages'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-ink-faint hover:text-ink-soft transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {addPagesStep === 'details' ? (
          <form onSubmit={onAddPages} className="flex flex-col overflow-hidden">
            <div className="p-6 space-y-5 overflow-y-auto">
              <div className="flex items-center gap-4 p-1 bg-sunken rounded-lg w-fit mb-2">
                <button
                  type="button"
                  onClick={() => setUseExistingPlanSet(false)}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${!useExistingPlanSet ? 'bg-white text-accent-600 shadow-sm' : 'text-ink-soft hover:text-ink'}`}
                >
                  New Plan Set
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUseExistingPlanSet(true);
                    if (project.planSets && project.planSets.length > 0 && !targetPlanSetId) {
                      setTargetPlanSetId(project.planSets[0].id);
                    }
                  }}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${useExistingPlanSet ? 'bg-white text-accent-600 shadow-sm' : 'text-ink-soft hover:text-ink'}`}
                >
                  Existing Plan Set
                </button>
              </div>

              {useExistingPlanSet ? (
                <div>
                  <label className="block text-sm font-medium text-ink-soft mb-1.5">Select Plan Set</label>
                  <select
                    value={targetPlanSetId}
                    onChange={(e) => setTargetPlanSetId(e.target.value)}
                    className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white"
                    required
                  >
                    {project.planSets?.map(ps => (
                      <option key={ps.id} value={ps.id}>{ps.name} ({new Date(ps.date).toLocaleDateString()})</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-ink-soft mb-1.5">Plan Set Name</label>
                    <input
                      type="text"
                      value={newPlanSetName}
                      onChange={(e) => setNewPlanSetName(e.target.value)}
                      className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                      placeholder="e.g. Revised Floor Plan"
                      required={!useExistingPlanSet}
                      disabled={isAddingPages}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-soft mb-1.5">Plan Set Date</label>
                    <input
                      type="date"
                      value={newPlanSetDate}
                      onChange={(e) => setNewPlanSetDate(e.target.value)}
                      className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                      required={!useExistingPlanSet}
                      disabled={isAddingPages}
                    />
                  </div>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-ink-soft mb-1.5">Blueprint PDFs</label>
                <div
                  className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
                    newPlanSetFiles.length > 0 ? 'border-accent-300 bg-accent-50' : 'border-edge-strong hover:border-accent-400 bg-sunken hover:bg-hover cursor-pointer'
                  }`}
                  onClick={() => !isAddingPages && newPlanSetFiles.length === 0 && fileInputRef.current?.click()}
                >
                  {newPlanSetFiles.length > 0 ? (
                    <div className="flex flex-col items-center w-full">
                      <div className="w-full space-y-2 mb-3">
                        {newPlanSetFiles.map((file, index) => (
                          <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-raised p-2 rounded-lg border border-accent-200 shadow-sm">
                            <div className="flex items-center gap-2 overflow-hidden">
                              <FileImage size={16} className="text-accent-500 shrink-0" />
                              <div className="text-left overflow-hidden">
                                <p className="text-xs font-medium text-ink truncate" title={file.name}>{file.name}</p>
                              </div>
                            </div>
                            {!isAddingPages && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); removeNewPlanSetFile(index); }}
                                className="p-1 text-ink-faint hover:text-red-500 hover:bg-red-50 rounded-md transition-colors shrink-0"
                                title="Remove file"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {!isAddingPages && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                          className="mt-1 text-sm text-accent-600 hover:text-accent-700 font-medium flex items-center gap-1"
                        >
                          <Plus size={14} /> Add more PDFs
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <Upload size={32} className="text-ink-faint mb-2" />
                      <p className="text-sm font-medium text-ink">Click to select PDFs</p>
                    </div>
                  )}
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => {
                    const selectedFiles = Array.from(e.target.files || []);
                    if (selectedFiles.length > 0) {
                      setNewPlanSetFiles(prev => [...prev, ...selectedFiles]);
                      if (!newPlanSetName) {
                        setNewPlanSetName(selectedFiles[0].name.replace('.pdf', ''));
                      }
                    }
                  }}
                  accept="application/pdf"
                  className="hidden"
                  multiple
                  required={newPlanSetFiles.length === 0}
                  disabled={isAddingPages}
                />
                {/* A revision that already lives in Documents (an emailed set,
                    a saved printout) skips the download-then-re-upload round
                    trip: the picker hands back bytes, and everything
                    downstream still just sees File[]. */}
                <div className="mt-2 flex justify-center">
                  <AddFilesButton
                    label="Choose from documents"
                    accept="pdf"
                    size="sm"
                    returnBlobs
                    initialProjectIds={[project.id]}
                    disabled={isAddingPages}
                    onPickBlobs={picked => {
                      const files = picked.map(p => new File([p.blob], p.row.name ?? 'plan.pdf', { type: 'application/pdf' }));
                      if (files.length === 0) return;
                      setNewPlanSetFiles(prev => [...prev, ...files]);
                      setNewPlanSetName(prev => prev || files[0].name.replace(/\.pdf$/i, ''));
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isAddingPages}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-sunken rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={(!newPlanSetName && !useExistingPlanSet) || (useExistingPlanSet && !targetPlanSetId) || newPlanSetFiles.length === 0 || isAddingPages}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
              >
                {isAddingPages ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {addProgress.status ? `${addProgress.status} ` : 'Adding '}
                    {addProgress.totalFiles > 1 ? `File ${addProgress.currentFile}/${addProgress.totalFiles} ` : ''}
                    {addProgress.total > 0 ? `(${addProgress.current}/${addProgress.total})` : '...'}
                  </>
                ) : (
                  'Next Step'
                )}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <PageNamingStep
              pendingPages={pendingPages}
              setPendingPages={setPendingPages}
              pendingThumbnails={pendingThumbnails}
              onConfirm={onConfirmAddPages}
              isConfirming={isAddingPages}
              confirmLabel={isNamingExistingPages ? 'Save Changes' : 'Add Pages'}
              title={isNamingExistingPages ? 'Name Pages' : 'Revision Review'}
              subtitle={isNamingExistingPages
                ? 'Review and rename the imported pages.'
                : 'Confirm each incoming page: name it, match it to an existing sheet (or mark New), and resolve duplicates before committing.'}
              existingSheets={isNamingExistingPages ? undefined : reviewSheets}
              planSetId={isNamingExistingPages ? undefined : reviewPlanSetId}
              onAiScan={onAiScan}
            />
          </div>
        )}
      </div>
    </div>
  );
};
