// src/pages/customers/CustomersSplitView.tsx
// Route component for both `/customers` and `/customers/:id`: persistent
// sidebar (search, New Customer, rows) + right pane (empty state or
// CustomerPane). Below the `md` breakpoint only one of the two panels is
// visible at a time — the list, or the pane with a back button.
import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import { Customer } from '../../types';
import { CustomerSummary, getCustomersSummary } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { EmptyState } from '../../components/ui';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CustomerSidebar } from './CustomerSidebar';
import { CustomerPane } from './CustomerPane';
import { CreateCustomerModal } from './CreateCustomerModal';

const UNASSIGNED_ID = 'customer-unassigned';

export const CustomersSplitView: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getCustomersSummary()
      .then(data => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => toast('Failed to load customers.', { type: 'error' }))
      .finally(() => setLoading(false));
  }, [toast]);

  useLiveQuery(load, { types: ['customer', 'project', 'invoice', 'payment', 'aiaPayApp', 'task'] });

  // The unassigned bucket is a placeholder, not a real customer — it always
  // sorts last (and renders muted in the sidebar) regardless of alpha order.
  const sorted = useMemo(() => {
    const real = customers.filter(c => c.id !== UNASSIGNED_ID);
    const unassigned = customers.find(c => c.id === UNASSIGNED_ID);
    return unassigned ? [...real, unassigned] : real;
  }, [customers]);

  const handleCreated = (c: Customer) => {
    setShowCreate(false);
    load();
    navigate(`/customers/${c.id}`);
  };

  const handleDeleted = () => {
    load();
    navigate('/customers');
  };

  const handleMerged = (targetId: string) => {
    load();
    navigate(`/customers/${targetId}`);
  };

  return (
    <div className="flex bg-surface h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:h-dvh">
      {/* Sidebar: list-only on phone when nothing is selected; hidden on
          phone once a customer is open (md:flex keeps it visible on desktop). */}
      <div className={`w-full shrink-0 flex-col border-r border-edge md:flex md:w-72 lg:w-80 ${id ? 'hidden' : 'flex'}`}>
        <CustomerSidebar
          customers={sorted}
          loading={loading}
          selectedId={id}
          onSelect={cid => navigate(`/customers/${cid}`)}
          onCreate={() => setShowCreate(true)}
        />
      </div>

      {/* Pane: hidden on phone until a customer is selected. */}
      <div className={`min-w-0 flex-1 flex-col md:flex ${id ? 'flex' : 'hidden'}`}>
        {id ? (
          <CustomerPane
            key={id}
            customerId={id}
            onBack={() => navigate('/customers')}
            onDeleted={handleDeleted}
            onMerged={handleMerged}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <EmptyState
              icon={<Users size={22} />}
              title="Select a customer"
              description="Choose a customer from the list to view their projects, tasks, and billing."
            />
          </div>
        )}
      </div>

      <CreateCustomerModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={handleCreated} />
    </div>
  );
};
