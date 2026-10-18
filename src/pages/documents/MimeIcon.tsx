// src/pages/documents/MimeIcon.tsx
// Mime-type glyph for a document row. Lived inside DocumentsTable until the
// preview work (hover card + viewer modal) needed the same mapping at larger
// sizes — moved here so the preview components don't have to import from the
// table that renders them.
import React from 'react';
import { File, FileText, Image as ImageIcon, Presentation, Sheet } from 'lucide-react';
import { officeFormatOf } from '../../utils/officeFormats';

export const MimeIcon: React.FC<{ mime: string; size?: number; className?: string }> = ({
  mime, size = 15, className = 'shrink-0 text-ink-faint',
}) => {
  const props = { size, className };
  const documentType = officeFormatOf({ mime })?.documentType;
  if (documentType === 'cell') return <Sheet {...props} />;
  if (documentType === 'slide') return <Presentation {...props} />;
  if (documentType) return <FileText {...props} />;
  if (mime.startsWith('image/')) return <ImageIcon {...props} />;
  return <File {...props} />;
};
