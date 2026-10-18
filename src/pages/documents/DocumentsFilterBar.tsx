// src/pages/documents/DocumentsFilterBar.tsx
import React, { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Checkbox, Input } from '../../components/ui';
import { MultiSelectDropdown, MultiSelectOption } from './MultiSelectDropdown';

const SEARCH_DEBOUNCE_MS = 300;

export const DocumentsFilterBar: React.FC<{
  q: string;
  onQChange: (q: string) => void;
  projectOptions: MultiSelectOption[];
  projectIds: string[];
  onProjectIdsChange: (ids: string[]) => void;
  customerOptions: MultiSelectOption[];
  customerIds: string[];
  onCustomerIdsChange: (ids: string[]) => void;
  kindOptions: MultiSelectOption[];
  kinds: string[];
  onKindsChange: (ids: string[]) => void;
  archived: boolean;
  onArchivedChange: (archived: boolean) => void;
  // Admin-only exclusive view (spec docs/superpowers/specs/2026-08-17-documents-clutter-design.md);
  // the toggle itself isn't rendered at all for a non-admin, matching the
  // Billing-kind gating pattern used elsewhere in the app.
  hideProjectFilter?: boolean;
  isAdmin: boolean;
  unassigned: boolean;
  onUnassignedChange: (unassigned: boolean) => void;
}> = ({
  q, onQChange, projectOptions, projectIds, onProjectIdsChange,
  customerOptions, customerIds, onCustomerIdsChange,
  kindOptions, kinds, onKindsChange, archived, onArchivedChange,
  isAdmin, unassigned, onUnassignedChange, hideProjectFilter,
}) => {
  // Local box tracks keystrokes instantly; the URL-driven `q` (and therefore
  // the fetch) only updates after a pause, so typing never fights re-renders.
  const [text, setText] = useState(q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Follow external changes to `q` (e.g. a fresh deep link) without fighting
  // the user's own typing — this only fires when the URL value itself moves.
  useEffect(() => { setText(q); }, [q]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleType = (v: string) => {
    setText(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onQChange(v), SEARCH_DEBOUNCE_MS);
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
        <Input
          value={text}
          onChange={e => handleType(e.target.value)}
          placeholder="Search documents…"
          aria-label="Search documents"
          className="h-9 w-56 pl-8"
        />
      </div>
      {!hideProjectFilter && (
        <MultiSelectDropdown
          label="Project" testId="doc-filter-project" emptyLabel="All projects"
          options={projectOptions} selected={projectIds} onChange={onProjectIdsChange}
        />
      )}
      <MultiSelectDropdown
        label="Customer" testId="doc-filter-customer" emptyLabel="All customers"
        options={customerOptions} selected={customerIds} onChange={onCustomerIdsChange}
      />
      <MultiSelectDropdown
        label="Type" testId="doc-filter-type" emptyLabel="All types"
        options={kindOptions} selected={kinds} onChange={onKindsChange}
      />
      <Checkbox
        data-testid="doc-filter-archived"
        label="Archived"
        checked={archived}
        onChange={e => onArchivedChange(e.target.checked)}
      />
      {isAdmin && (
        <Checkbox
          data-testid="doc-filter-unassigned"
          label="Unassigned"
          checked={unassigned}
          onChange={e => onUnassignedChange(e.target.checked)}
        />
      )}
    </div>
  );
};
