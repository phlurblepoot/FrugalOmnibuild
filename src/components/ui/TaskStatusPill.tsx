// src/components/ui/TaskStatusPill.tsx
import React from 'react';
import { StatusPill, PillTone } from './StatusPill';

export const TASK_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  todo:        { label: 'To do',       tone: 'slate' },
  in_progress: { label: 'In progress', tone: 'blue' },
  done:        { label: 'Done',        tone: 'emerald' },
};

export const TaskStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) => {
  const entry = status != null && Object.hasOwn(TASK_STATUS_META, status) ? TASK_STATUS_META[status] : null;
  const m = entry ?? { label: status || 'Unknown', tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone} className={className}>{m.label}</StatusPill>;
};
