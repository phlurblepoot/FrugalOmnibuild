import type { CustomerRoleEmails, RoleEmailSet } from '../types';

export type TemplateType = 'proposal' | 'invoice' | 'changeOrder' | 'issue' | 'punch' | 'rfi';

export interface ResolvedRecipients {
  to: string;
  cc: string;
  bcc: string;
}

export function roleForTemplate(t: TemplateType): keyof CustomerRoleEmails {
  switch (t) {
    case 'proposal': return 'estimating';
    case 'invoice':
    case 'changeOrder': return 'accounting';
    case 'issue':
    case 'punch':
    case 'rfi': return 'pm';
  }
}

/**
 * Tolerant pick: reads emails?.[role]?.[field], but if the role value happens
 * to be a legacy plain string (pre-upgrade data), treats it as { to: <string> }.
 */
function pick(
  emails: CustomerRoleEmails | undefined,
  role: keyof CustomerRoleEmails,
  field: keyof RoleEmailSet,
): string {
  if (!emails) return '';
  const roleVal = emails[role];
  if (!roleVal) return '';
  // Legacy tolerance: if the stored value is a plain string, treat it as `to`.
  if (typeof roleVal === 'string') {
    return field === 'to' ? (roleVal as string).trim() : '';
  }
  return (roleVal[field] ?? '').trim();
}

/**
 * Resolve To/CC/BCC for a given template type.
 * Precedence per field: project[role] → customer[role] → project.general → customer.general → ''.
 */
export function resolveRecipient(
  t: TemplateType,
  projectEmails: CustomerRoleEmails | undefined,
  customerEmails: CustomerRoleEmails | undefined,
): ResolvedRecipients {
  const role = roleForTemplate(t);
  const resolve = (field: keyof RoleEmailSet): string =>
    pick(projectEmails, role, field) ||
    pick(customerEmails, role, field) ||
    pick(projectEmails, 'general', field) ||
    pick(customerEmails, 'general', field) ||
    '';
  return {
    to: resolve('to'),
    cc: resolve('cc'),
    bcc: resolve('bcc'),
  };
}
