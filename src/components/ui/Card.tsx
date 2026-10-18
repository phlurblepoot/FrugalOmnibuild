// src/components/ui/Card.tsx
import React from 'react';

// Flat raised surface — data surfaces never get glass or glow (spec §5 rule 4).
export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = '', ...rest }) => (
  <div className={`rounded-xl border border-edge bg-raised ${className}`} {...rest} />
);

export const CardHeader: React.FC<{
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}> = ({ title, actions, className = '' }) => (
  <div className={`flex items-center justify-between gap-3 border-b border-edge px-5 py-4 ${className}`}>
    <h3 className="text-sm font-semibold text-ink">{title}</h3>
    {actions}
  </div>
);

export const CardBody: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = '', ...rest }) => (
  <div className={`px-5 py-4 ${className}`} {...rest} />
);
