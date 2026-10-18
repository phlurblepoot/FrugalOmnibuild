// src/pages/customers/CustomerForm.tsx
// Extracted from the old src/pages/CustomersPage.tsx — shared between the
// create modal and the customer Settings tab.
import React from 'react';
import { Customer, CustomerRoleEmails } from '../../types';
import { Field, Input, Textarea } from '../../components/ui';
import { RoleEmailsEditor } from '../../components/RoleEmailsEditor';

export interface CustomerFormState {
  name: string;
  phone: string;
  address: string;
  contactName: string;
  notes: string;
  emails: CustomerRoleEmails;
}

export const EMPTY_CUSTOMER_FORM: CustomerFormState = {
  name: '',
  phone: '',
  address: '',
  contactName: '',
  notes: '',
  emails: {},
};

export const CustomerForm: React.FC<{
  value: CustomerFormState;
  onChange: (v: CustomerFormState) => void;
  nameError?: string;
}> = ({ value, onChange, nameError }) => {
  const set = (key: keyof Omit<CustomerFormState, 'emails'>) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({ ...value, [key]: e.target.value });

  return (
    <div className="space-y-4">
      <Field label="Company / Customer Name" htmlFor="cust-name" error={nameError}>
        <Input
          id="cust-name"
          value={value.name}
          onChange={set('name')}
          placeholder="e.g. Acme Construction"
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Contact Name" htmlFor="cust-contact">
          <Input id="cust-contact" value={value.contactName} onChange={set('contactName')} placeholder="Primary contact" />
        </Field>
        <Field label="Phone" htmlFor="cust-phone">
          <Input id="cust-phone" value={value.phone} onChange={set('phone')} placeholder="(555) 000-0000" type="tel" />
        </Field>
      </div>
      <Field label="Address" htmlFor="cust-address">
        <Input id="cust-address" value={value.address} onChange={set('address')} placeholder="Street, City, State ZIP" />
      </Field>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint pt-1">Role Emails</p>
      <RoleEmailsEditor
        value={value.emails}
        onChange={next => onChange({ ...value, emails: next })}
      />
      <Field label="Notes" htmlFor="cust-notes">
        <Textarea id="cust-notes" value={value.notes} onChange={set('notes')} placeholder="Internal notes about this customer…" rows={3} />
      </Field>
    </div>
  );
};

export function formToCustomer(f: CustomerFormState): Omit<Customer, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: f.name.trim(),
    phone: f.phone.trim() || undefined,
    address: f.address.trim() || undefined,
    contactName: f.contactName.trim() || undefined,
    notes: f.notes.trim() || undefined,
    emails: f.emails,
  };
}

export function customerToForm(c: Customer): CustomerFormState {
  return {
    name: c.name,
    phone: c.phone ?? '',
    address: c.address ?? '',
    contactName: c.contactName ?? '',
    notes: c.notes ?? '',
    emails: c.emails ?? {},
  };
}
