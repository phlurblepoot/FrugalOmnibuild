// src/components/RoleEmailsEditor.tsx
//
// Compact tabbed editor for CustomerRoleEmails (General / Accounting /
// Estimating / Project Management). Each tab exposes To, CC, BCC inputs bound
// to the corresponding RoleEmailSet. Designed to drop into forms and cards.

import React, { useState } from 'react';
import { CustomerRoleEmails, RoleEmailSet } from '../types';
import { Field, Input } from './ui';

type RoleKey = 'general' | 'accounting' | 'estimating' | 'pm';

const TABS: { key: RoleKey; label: string }[] = [
  { key: 'general',    label: 'General' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'estimating', label: 'Estimating' },
  { key: 'pm',         label: 'Project Mgmt' },
];

interface Props {
  value: CustomerRoleEmails;
  onChange: (next: CustomerRoleEmails) => void;
  /** When true, all inputs are disabled (e.g. while a save is in flight). */
  disabled?: boolean;
}

export const RoleEmailsEditor: React.FC<Props> = ({ value, onChange, disabled }) => {
  const [activeTab, setActiveTab] = useState<RoleKey>('general');

  const set = (field: keyof RoleEmailSet) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    const prev: RoleEmailSet = value[activeTab] ?? {};
    const next: RoleEmailSet = { ...prev, [field]: text };
    onChange({ ...value, [activeTab]: next });
  };

  const roleSet: RoleEmailSet = value[activeTab] ?? {};

  return (
    <div>
      {/* Tab bar */}
      <div className="flex border-b border-edge overflow-x-auto no-scrollbar -mx-0.5 mb-3">
        {TABS.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-2 text-xs font-medium transition-colors relative whitespace-nowrap ${
              activeTab === tab.key
                ? 'text-accent-600'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            {tab.label}
            {activeTab === tab.key && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
            )}
          </button>
        ))}
      </div>

      {/* Help text */}
      <p className="text-xs text-ink-faint mb-3">
        Separate multiple addresses with commas.
      </p>

      {/* To / CC / BCC inputs */}
      <div className="space-y-3">
        <Field label="To" htmlFor={`re-${activeTab}-to`}>
          <Input
            id={`re-${activeTab}-to`}
            value={roleSet.to ?? ''}
            onChange={set('to')}
            placeholder="recipient@example.com"
            disabled={disabled}
          />
        </Field>
        <Field label="CC" htmlFor={`re-${activeTab}-cc`}>
          <Input
            id={`re-${activeTab}-cc`}
            value={roleSet.cc ?? ''}
            onChange={set('cc')}
            placeholder="cc@example.com"
            disabled={disabled}
          />
        </Field>
        <Field label="BCC" htmlFor={`re-${activeTab}-bcc`}>
          <Input
            id={`re-${activeTab}-bcc`}
            value={roleSet.bcc ?? ''}
            onChange={set('bcc')}
            placeholder="bcc@example.com"
            disabled={disabled}
          />
        </Field>
      </div>
    </div>
  );
};
