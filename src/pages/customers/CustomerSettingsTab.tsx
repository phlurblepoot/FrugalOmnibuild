// src/pages/customers/CustomerSettingsTab.tsx
// Feature-identical relocation of the old src/pages/CustomerDetail.tsx form:
// contact fields, role emails, notes, Merge, Delete, with the same
// customer-unassigned guards.
import React, { useCallback, useEffect, useState } from 'react';
import { GitMerge, Loader2, Save, Trash2 } from 'lucide-react';
import { Customer } from '../../types';
import { deleteCustomer, getCustomer, saveCustomer } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, Card, CardBody, CardHeader, Modal, Skeleton } from '../../components/ui';
import { CustomerForm, CustomerFormState, customerToForm, formToCustomer } from './CustomerForm';
import { MergeCustomerModal } from './MergeCustomerModal';

const UNASSIGNED_ID = 'customer-unassigned';

const DeleteCustomerModal: React.FC<{
  open: boolean;
  customerName: string;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
}> = ({ open, customerName, onClose, onConfirm, deleting }) => (
  <Modal
    open={open}
    onClose={onClose}
    title="Delete Customer"
    width="sm"
    footer={
      <>
        <Button variant="secondary" onClick={onClose} disabled={deleting}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </>
    }
  >
    <p className="text-sm text-ink-soft">
      Are you sure you want to delete <strong className="text-ink">{customerName}</strong>? This action cannot be undone.
      Projects assigned to this customer will be moved to the unassigned customer.
    </p>
  </Modal>
);

export const CustomerSettingsTab: React.FC<{
  customerId: string;
  onSaved: (c: Customer) => void;
  onDeleted: () => void;
  onMerged: (targetId: string) => void;
}> = ({ customerId, onSaved, onDeleted, onMerged }) => {
  const { toast } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [form, setForm] = useState<CustomerFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showMerge, setShowMerge] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getCustomer(customerId)
      .then(c => {
        setCustomer(c);
        setForm(customerToForm(c));
        setDirty(false);
      })
      .catch(() => toast('Failed to load customer.', { type: 'error' }))
      .finally(() => setLoading(false));
  }, [customerId, toast]);

  useEffect(() => { load(); }, [load]);

  const isUnassigned = customerId === UNASSIGNED_ID;

  const handleFormChange = (v: CustomerFormState) => {
    setForm(v);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!form || !customer) return;
    if (!form.name.trim()) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');
    setSaving(true);
    try {
      const updated = await saveCustomer({ id: customer.id, ...formToCustomer(form) });
      setCustomer(updated);
      setForm(customerToForm(updated));
      setDirty(false);
      toast('Customer saved.', { type: 'success' });
      onSaved(updated);
    } catch (err: any) {
      toast(err?.message ?? 'Failed to save customer.', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteCustomer(customerId);
      toast('Customer deleted.', { type: 'success' });
      onDeleted();
    } catch (err: any) {
      toast(err?.message ?? 'Failed to delete customer.', { type: 'error' });
    } finally {
      setDeleting(false);
      setShowDelete(false);
    }
  };

  if (loading || !customer || !form) {
    return (
      <Card><CardBody><Skeleton className="h-40 w-full" /></CardBody></Card>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader
          title="Customer Details"
          actions={
            <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              <span>{saving ? 'Saving…' : 'Save'}</span>
            </Button>
          }
        />
        <CardBody>
          <CustomerForm value={form} onChange={handleFormChange} nameError={nameError} />
        </CardBody>
      </Card>

      {!isUnassigned && (
        <Card>
          <CardHeader title="Danger Zone" />
          <CardBody className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowMerge(true)}
              title="Merge this customer into another"
            >
              <GitMerge size={14} />
              <span>Merge into another customer</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowDelete(true)}
              className="text-red-600 dark:text-red-400 hover:border-red-300 dark:hover:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Trash2 size={14} />
              <span>Delete customer</span>
            </Button>
          </CardBody>
        </Card>
      )}

      {!isUnassigned && (
        <>
          <DeleteCustomerModal
            open={showDelete}
            customerName={customer.name}
            onClose={() => setShowDelete(false)}
            onConfirm={handleDelete}
            deleting={deleting}
          />
          <MergeCustomerModal
            open={showMerge}
            currentId={customerId}
            onClose={() => setShowMerge(false)}
            onMerged={targetId => { setShowMerge(false); onMerged(targetId); }}
          />
        </>
      )}
    </div>
  );
};
