import React, { useEffect, useState } from 'react';
import { useNotes } from '../context/NotesContext';
import { NotesBoard } from './NotesBoard';
import { getProjectNotes, saveProjectNotes } from '../utils/store';
import { ProjectNote } from '../types';
import { X, StickyNote } from 'lucide-react';

export const NotesOverlay: React.FC = () => {
  const { isOpen, projectId, closeNotes } = useNotes();
  const [note, setNote] = useState<ProjectNote | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && projectId) {
      setLoading(true);
      getProjectNotes(projectId).then(data => {
        setNote(data);
        setLoading(false);
      }).catch(err => {
        console.error('Failed to load notes:', err);
        setLoading(false);
      });
    }
  }, [isOpen, projectId]);

  if (!isOpen || !projectId) return null;

  const handleSave = async (updatedNote: ProjectNote) => {
    try {
      await saveProjectNotes(projectId, updatedNote);
      setNote(updatedNote);
    } catch (err) {
      console.error('Failed to save notes:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 md:p-8 animate-in fade-in duration-200">
      <div className="bg-raised w-full h-full rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-edge animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge bg-sunken/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent-100 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 rounded-lg">
              <StickyNote size={20} />
            </div>
            <div>
              <h2 className="font-bold text-ink">Project Notes Board</h2>
              <p className="text-xs text-ink-soft">Freeform workspace for sketches, tables, and notes</p>
            </div>
          </div>
          <button
            onClick={closeNotes}
            className="p-2 text-ink-faint hover:text-ink-soft hover:bg-hover rounded-full transition-all"
          >
            <X size={24} />
          </button>
        </div>

        <div className="flex-1 relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-raised/80 z-20">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600"></div>
                <span className="text-sm text-ink-soft font-medium">Loading board...</span>
              </div>
            </div>
          ) : (
            <NotesBoard
              key={projectId}
              projectId={projectId}
              initialNote={note}
              onSave={handleSave}
            />
          )}
        </div>
      </div>
    </div>
  );
};
