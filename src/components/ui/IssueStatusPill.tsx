// src/components/ui/IssueStatusPill.tsx
import React from 'react';
import { StatusPill, PillTone } from './StatusPill';

export const ISSUE_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  open:     { label: 'Open',     tone: 'amber' },
  sent:     { label: 'Sent',     tone: 'blue' },
  resolved: { label: 'Resolved', tone: 'emerald' },
};

export const IssueStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) => {
  const entry = status != null && Object.hasOwn(ISSUE_STATUS_META, status) ? ISSUE_STATUS_META[status] : null;
  const m = entry ?? { label: status || 'Unknown', tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone} className={className}>{m.label}</StatusPill>;
};
