// src/pages/customers/CustomerSidebar.tsx
// Persistent customer list for the split view: search, New Customer, and
// name/contact/project-count rows. The `customer-unassigned` bucket is always
// sorted last (by the caller) and rendered muted here.
import React, { useMemo, useState } from 'react';
import { AlertCircle, Plus, Search, Users } from 'lucide-react';
import { CustomerSummary } from '../../utils/store';
import { Button, EmptyState, Skeleton, StatusPill } from '../../components/ui';

const UNASSIGNED_ID = 'customer-unassigned';

export const CustomerSidebar: React.FC<{
  customers: CustomerSummary[];
  loading: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}> = ({ customers, loading, selectedId, onSelect, onCreate }) => {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      c => c.name.toLowerCase().includes(q) || (c.contactName ?? '').toLowerCase().includes(q),
    );
  }, [customers, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-edge p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h1 className="text-base font-semibold text-ink">Customers</h1>
          <Button size="sm" onClick={onCreate}>
            <Plus size={14} />
            <span>New</span>
          </Button>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            placeholder="Search customers…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full rounded-lg border border-edge bg-raised py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent-400 focus:ring-2 focus:ring-accent-500/25 focus-visible:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" data-testid="customer-sidebar-list">
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Users size={20} />}
              title={query ? 'No matches' : 'No customers yet'}
              description={query ? 'Try a different name or contact.' : 'Add your first customer to get started.'}
            />
          </div>
        ) : (
          filtered.map(c => {
            const unassigned = c.id === UNASSIGNED_ID;
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                data-testid="customer-sidebar-row"
                data-customer-id={c.id}
                onClick={() => onSelect(c.id)}
                className={`flex w-full flex-col gap-0.5 border-b border-edge px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-hover ${
                  active ? 'bg-hover' : ''
                } ${unassigned ? 'opacity-60' : ''}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink" title={c.name}>{c.name}</span>
                  {c.overdueTaskCount > 0 && (
                    <AlertCircle size={13} className="shrink-0 text-red-500" aria-label={`${c.overdueTaskCount} overdue task(s)`} />
                  )}
                </span>
                {c.contactName && (
                  <span className="truncate text-xs text-ink-soft">{c.contactName}</span>
                )}
                <span className="flex flex-wrap items-center gap-1 text-[11px] text-ink-faint">
                  {c.projectCounts.bidding > 0 && (
                    <StatusPill tone="blue" className="px-1.5 py-0">{c.projectCounts.bidding} bidding</StatusPill>
                  )}
                  {c.projectCounts.inProgress > 0 && (
                    <StatusPill tone="amber" className="px-1.5 py-0">{c.projectCounts.inProgress} active</StatusPill>
                  )}
                  {c.projectCounts.bidding === 0 && c.projectCounts.inProgress === 0 && (
                    <span>{c.projectCounts.archived > 0 ? `${c.projectCounts.archived} archived` : 'No projects'}</span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
