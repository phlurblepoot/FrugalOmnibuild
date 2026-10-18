// src/components/ui/Table.tsx
import React from 'react';

// Flat data table (spec §5 rule 4: tables never get glass or glow).
// Compose: <Table><THead><TR><TH/>…</TR></THead><TBody><TR><TD/>…</TBody></Table>
export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  className = '',
  ...rest
}) => (
  <div className="overflow-x-auto">
    {/* sticky thead would require max-h-* + overflow-y-auto added here */}
    <table className={`w-full text-sm text-ink ${className}`} {...rest} />
  </div>
);

export const THead: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className = '',
  ...rest
}) => (
  <thead
    className={`bg-sunken text-left text-xs font-semibold uppercase tracking-wider text-ink-soft ${className}`}
    {...rest}
  />
);

export const TBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className = '',
  ...rest
}) => <tbody className={`divide-y divide-edge ${className}`} {...rest} />;

export const TR: React.FC<React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }> = ({
  interactive = false,
  className = '',
  ...rest
}) => (
  <tr
    className={`${interactive ? 'cursor-pointer transition-colors hover:bg-hover ' : ''}${className}`}
    {...rest}
  />
);

export const TH: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({
  className = '',
  ...rest
}) => <th className={`px-4 py-3 ${className}`} {...rest} />;

export const TD: React.FC<React.TdHTMLAttributes<HTMLTableCellElement>> = ({
  className = '',
  ...rest
}) => <td className={`px-4 py-3 ${className}`} {...rest} />;
