// src/pages/customers/CustomerPane.tsx
// Right pane of the customers split view: header (name, contact/phone,
// [+ Project], admin-outstanding slot) + Overview/Projects/Tasks/Billing/
// Settings tabs with ?tab= persistence. Tab-host pattern mirrors
// src/pages/project/ProjectBilling.tsx.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Phone, Plus, User } from 'lucide-react';
import { Customer } from '../../types';
import { CustomerOverview, getCustomerOverview } from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { useToast } from '../../components/Toast';
import { Button, Skeleton } from '../../components/ui';
import { CardGrid } from '../../cards';
import { CustomerProjectsTab } from './CustomerProjectsTab';
import { CustomerTasksTab } from './CustomerTasksTab';
import { CustomerBillingTab } from './CustomerBillingTab';
import { CustomerSettingsTab } from './CustomerSettingsTab';

// Same localStorage-role check used app-wide for admin gating (Sidebar's
// PROJECT_NAV filter, ProjectBilling's full-section gate).
const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

type CustomerTab = 'overview' | 'projects' | 'tasks' | 'billing' | 'settings';

// Billing is hidden entirely for non-admins — both the tab bar entry and its
// content — mirroring how Sidebar's PROJECT_NAV hides Billing/Settings.
const ALL_CUSTOMER_TABS: { value: CustomerTab; label: string; adminOnly?: boolean }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'projects', label: 'Projects' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'billing', label: 'Billing', adminOnly: true },
  { value: 'settings', label: 'Settings' },
];

export const CustomerPane: React.FC<{
  customerId: string;
  onBack: () => void;
  onDeleted: () => void;
  onMerged: (targetId: string) => void;
}> = ({ customerId, onBack, onDeleted, onMerged }) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const admin = isAdmin();
  const customerTabs = ALL_CUSTOMER_TABS.filter(t => !t.adminOnly || admin);
  const customerTabValues = customerTabs.map(t => t.value) as readonly string[];

  const tabParam = searchParams.get('tab');
  const activeTab: CustomerTab = customerTabValues.includes(tabParam ?? '')
    ? (tabParam as CustomerTab)
    : 'overview';
  const setActiveTab = (tab: CustomerTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  const load = useCallback(() => {
    setLoading(true);
    getCustomerOverview(customerId)
      .then(setOverview)
      .catch(() => toast('Failed to load customer.', { type: 'error' }))
      .finally(() => setLoading(false));
  }, [customerId, toast]);

  useEffect(() => { load(); }, [load]);

  const handleSaved = (c: Customer) => {
    setOverview(prev => (prev ? { ...prev, customer: c } : prev));
  };

  if (loading || !overview) {
    return (
      <div data-testid="customer-pane" className="flex h-full flex-col p-4 sm:p-6">
        <Skeleton className="mb-4 h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { customer } = overview;

  return (
    <div data-testid="customer-pane" className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-edge bg-surface px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={onBack}
              className="flex items-center justify-center rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink md:hidden"
              aria-label="Back to Customers"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-ink" title={customer.name}>
                {customer.name}
              </h1>
              {(customer.contactName || customer.phone) && (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 truncate text-sm text-ink-soft">
                  {customer.contactName && (
                    <span className="flex items-center gap-1"><User size={12} className="shrink-0" />{customer.contactName}</span>
                  )}
                  {customer.phone && (
                    <span className="flex items-center gap-1"><Phone size={12} className="shrink-0" />{customer.phone}</span>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div data-testid="customer-outstanding-slot">
              {overview.billing !== undefined && overview.billing.outstandingCents > 0 && (
                <span className="text-sm font-semibold text-ink" title="Outstanding balance">
                  {formatMoney(overview.billing.outstandingCents)} outstanding
                </span>
              )}
            </div>
            <Button size="sm" onClick={() => navigate(`/new?customerId=${customer.id}`)}>
              <Plus size={15} />
              <span>Project</span>
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <nav aria-label="Customer sections" className="-mx-4 mt-4 flex gap-1 overflow-x-auto px-4 no-scrollbar sm:-mx-6 sm:px-6">
          {customerTabs.map(tab => (
            <button
              key={tab.value}
              data-testid={`customer-tab-${tab.value}`}
              onClick={() => setActiveTab(tab.value)}
              className={`flex items-center gap-1.5 shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab.value ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Active section */}
      <div key={activeTab} className="anim-tab-in flex-1 px-4 py-6 sm:px-6">
        {activeTab === 'overview' && (
          <CardGrid page="customer" ctx={{ isAdmin: admin, customerId: customer.id }} key={customer.id} />
        )}
        {activeTab === 'projects' && <CustomerProjectsTab projects={overview.projects} />}
        {activeTab === 'tasks' && <CustomerTasksTab customerId={customer.id} />}
        {activeTab === 'billing' && admin && <CustomerBillingTab billing={overview.billing} />}
        {activeTab === 'settings' && (
          <CustomerSettingsTab
            customerId={customer.id}
            onSaved={handleSaved}
            onDeleted={onDeleted}
            onMerged={onMerged}
          />
        )}
      </div>
    </div>
  );
};
