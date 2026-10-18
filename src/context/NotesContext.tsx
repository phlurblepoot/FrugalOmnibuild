import React, { createContext, useContext, useState } from 'react';

interface NotesContextType {
  isOpen: boolean;
  projectId: string | null;
  openNotes: (projectId: string) => void;
  closeNotes: () => void;
}

const NotesContext = createContext<NotesContextType | undefined>(undefined);

export const NotesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);

  const openNotes = (id: string) => {
    setProjectId(id);
    setIsOpen(true);
  };

  const closeNotes = () => {
    setIsOpen(false);
  };

  return (
    <NotesContext.Provider value={{ isOpen, projectId, openNotes, closeNotes }}>
      {children}
    </NotesContext.Provider>
  );
};

export const useNotes = () => {
  const context = useContext(NotesContext);
  if (context === undefined) {
    throw new Error('useNotes must be used within a NotesProvider');
  }
  return context;
};
