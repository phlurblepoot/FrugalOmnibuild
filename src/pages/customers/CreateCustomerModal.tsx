// src/pages/customers/CreateCustomerModal.tsx
// Extracted from the old src/pages/CustomersPage.tsx.
import React, { useCallback, useState } from 'react';
import { Customer } from '../../types';
import { saveCustomer } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, Modal } from '../../components/ui';
import { CustomerForm, CustomerFormState, EMPTY_CUSTOMER_FORM, formToCustomer } from './CustomerForm';

export const CreateCustomerModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreated: (c: Customer) => void;
}> = ({ open, onClose, onCreated }) => {
  const [form, setForm] = useState<CustomerFormState>(EMPTY_CUSTOMER_FORM);
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleClose = useCallback(() => {
    setForm(EMPTY_CUSTOMER_FORM);
    setNameError('');
    onClose();
  }, [onClose]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');
    setSaving(true);
    try {
      const created = await saveCustomer(formToCustomer(form));
      toast('Customer created.', { type: 'success' });
      setForm(EMPTY_CUSTOMER_FORM);
      onCreated(created);
    } catch (err: any) {
      toast(err?.message ?? 'Failed to create customer.', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New Customer"
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create Customer'}</Button>
        </>
      }
    >
      <CustomerForm value={form} onChange={setForm} nameError={nameError} />
    </Modal>
  );
};
