import { describe, it, expect } from 'vitest';
import { roleForTemplate, resolveRecipient } from './recipients';
import type { CustomerRoleEmails } from '../types';

describe('roleForTemplate', () => {
  it('maps templates to roles', () => {
    expect(roleForTemplate('proposal')).toBe('estimating');
    expect(roleForTemplate('invoice')).toBe('accounting');
    expect(roleForTemplate('changeOrder')).toBe('accounting');
    expect(roleForTemplate('issue')).toBe('pm');
    expect(roleForTemplate('punch')).toBe('pm');
  });
});

describe('resolveRecipient', () => {
  const cust: CustomerRoleEmails = {
    estimating: { to: 'est@c.com' },
    accounting: { to: 'ap@c.com' },
    general: { to: 'info@c.com' },
  };

  it('prefers the project override for the role (to field)', () => {
    const proj: CustomerRoleEmails = { estimating: { to: 'proj@x.com' } };
    expect(resolveRecipient('proposal', proj, cust).to).toBe('proj@x.com');
  });

  it('falls back to the customer role when project has no override', () => {
    expect(resolveRecipient('proposal', {}, cust).to).toBe('est@c.com');
  });

  it('falls back to project general, then customer general', () => {
    const projGeneral: CustomerRoleEmails = { general: { to: 'pg@x.com' } };
    expect(resolveRecipient('issue', projGeneral, cust).to).toBe('pg@x.com');
    expect(resolveRecipient('issue', undefined, cust).to).toBe('info@c.com');
  });

  it('returns empty strings when nothing is set', () => {
    expect(resolveRecipient('invoice', undefined, undefined)).toEqual({ to: '', cc: '', bcc: '' });
  });

  it('resolves cc and bcc independently from to', () => {
    const proj: CustomerRoleEmails = {
      accounting: { to: 'ap@proj.com', cc: 'cc@proj.com', bcc: 'bcc@proj.com' },
    };
    const result = resolveRecipient('invoice', proj, cust);
    expect(result.to).toBe('ap@proj.com');
    expect(result.cc).toBe('cc@proj.com');
    expect(result.bcc).toBe('bcc@proj.com');
  });

  it('cc/bcc fall back independently through the chain', () => {
    // project has to only; customer has cc; general has bcc
    const proj: CustomerRoleEmails = {
      accounting: { to: 'to@proj.com' },
    };
    const custWithCc: CustomerRoleEmails = {
      accounting: { to: 'ap@c.com', cc: 'cc@c.com' },
      general: { to: 'info@c.com', bcc: 'bcc@gen.com' },
    };
    const result = resolveRecipient('invoice', proj, custWithCc);
    expect(result.to).toBe('to@proj.com');
    expect(result.cc).toBe('cc@c.com');
    // no bcc on accounting role anywhere → falls to general.bcc on customer
    expect(result.bcc).toBe('bcc@gen.com');
  });

  it('legacy-string tolerance: a role value that is a plain string resolves as to', () => {
    // Simulates old data where emails[role] was stored as a bare string.
    const legacyCust = {
      estimating: 'est@legacy.com' as any,
      general: 'info@legacy.com' as any,
    } as CustomerRoleEmails;
    const result = resolveRecipient('proposal', undefined, legacyCust);
    expect(result.to).toBe('est@legacy.com');
    expect(result.cc).toBe('');
    expect(result.bcc).toBe('');
  });
});
