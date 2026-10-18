// src/pages/customers/MergeCustomerModal.tsx
// Extracted from the old src/pages/CustomerDetail.tsx.
import React, { useEffect, useState } from 'react';
import { Customer } from '../../types';
import { getCustomers, mergeCustomers } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, Field, Modal, Select } from '../../components/ui';

const UNASSIGNED_ID = 'customer-unassigned';

export const MergeCustomerModal: React.FC<{
  open: boolean;
  currentId: string;
  onClose: () => void;
  onMerged: (targetId: string) => void;
}> = ({ open, currentId, onClose, onMerged }) => {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [targetId, setTargetId] = useState('');
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!open) return;
    getCustomers()
      .then((list: Customer[]) => {
        // Exclude self and the unassigned placeholder as merge targets
        const eligible = (Array.isArray(list) ? list : []).filter(
          c => c.id !== currentId && c.id !== UNASSIGNED_ID,
        );
        setCustomers(eligible);
        setTargetId(eligible[0]?.id ?? '');
      })
      .catch(() => {});
  }, [open, currentId]);

  const handleMerge = async () => {
    if (!targetId) return;
    setMerging(true);
    try {
      await mergeCustomers(targetId, [currentId]);
      toast('Customers merged.', { type: 'success' });
      onMerged(targetId);
    } catch (err: any) {
      toast(err?.message ?? 'Merge failed.', { type: 'error' });
    } finally {
      setMerging(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge into Another Customer"
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={merging}>Cancel</Button>
          <Button onClick={handleMerge} disabled={merging || !targetId}>
            {merging ? 'Merging…' : 'Merge'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          All projects assigned to this customer will be reassigned to the target, and this customer record will be deleted.
        </p>
        {customers.length === 0 ? (
          <p className="text-sm text-ink-faint">No other customers available to merge into.</p>
        ) : (
          <Field label="Merge into" htmlFor="merge-target">
            <Select
              id="merge-target"
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
            >
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
};
