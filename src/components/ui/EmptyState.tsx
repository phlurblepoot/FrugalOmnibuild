// src/components/ui/EmptyState.tsx
import React from 'react';

export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ icon, title, description, action }) => (
  <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
    {icon && (
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-sunken text-ink-faint">
        {icon}
      </div>
    )}
    <h3 className="text-sm font-semibold text-ink">{title}</h3>
    {description && <p className="mt-1 max-w-sm text-sm text-ink-faint">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);
