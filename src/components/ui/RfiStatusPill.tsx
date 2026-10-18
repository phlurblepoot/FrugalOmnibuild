import React from 'react';
import { StatusPill, PillTone } from './StatusPill';

export const RFI_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  open:     { label: 'Open',     tone: 'amber' },
  sent:     { label: 'Sent',     tone: 'blue' },
  answered: { label: 'Answered', tone: 'emerald' },
  closed:   { label: 'Closed',   tone: 'slate' },
};

export const RfiStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) => {
  const entry = status != null && Object.hasOwn(RFI_STATUS_META, status) ? RFI_STATUS_META[status] : null;
  const m = entry ?? { label: status || 'Unknown', tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone} className={className}>{m.label}</StatusPill>;
};
