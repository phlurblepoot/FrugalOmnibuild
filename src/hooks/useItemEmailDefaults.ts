// src/hooks/useItemEmailDefaults.ts
// Who an item's email goes to before anyone types anything: the recipient
// resolved from the project/customer role addresses, the sender's always-CC
// list, and the addresses the letterhead can advertise.
//
// This was seven near-identical copies (invoice, change order, issue, RFI,
// daily report, punch, proposal) — one of them already reading the wrong
// template role — so it lives here once and each editor names its template.
import { useEffect, useState } from 'react';
import { getAlwaysCc, getCustomer, getMailAccounts, getProject, getSettings, mailSendBlockedReason, pickSendableAccount } from '../utils/store';
import { resolveRecipient, type TemplateType } from '../utils/recipients';
import type { Customer } from '../types';

export interface ItemEmailDefaults {
  defaultTo: string;
  defaultCc: string;
  defaultBcc: string;
  /** The company address the letterhead uses unless the sender picks another. */
  companyEmail: string;
  headerEmailOptions: { label: string; value: string }[];
  /** Set once we know the user has no mail account to send from. */
  sendBlockedReason?: string;
}

const EMPTY: ItemEmailDefaults = {
  defaultTo: '', defaultCc: '', defaultBcc: '', companyEmail: '', headerEmailOptions: [],
};

const mergeCsv = (...lists: string[]): string =>
  Array.from(new Set(lists.flatMap(s => (s || '').split(',').map(x => x.trim()).filter(Boolean)))).join(', ');

export function useItemEmailDefaults(templateType: TemplateType, projectId?: string): ItemEmailDefaults {
  const [defaults, setDefaults] = useState<ItemEmailDefaults>(EMPTY);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [settings, mailAccounts, alwaysCc, project] = await Promise.all([
          getSettings(),
          getMailAccounts().catch(() => []),
          getAlwaysCc(),
          getProject(projectId).catch(() => null),
        ]);
        if (cancelled) return;
        let customer: Customer | undefined;
        if (project?.customerId) customer = await getCustomer(project.customerId).catch(() => undefined);
        if (cancelled) return;

        const resolved = resolveRecipient(templateType, project?.contactEmails, customer?.emails);
        const companyEmail = settings.companyEmail ?? '';
        const fromAddress = pickSendableAccount(mailAccounts)?.emailAddress ?? '';
        setDefaults({
          defaultTo: resolved.to,
          defaultCc: mergeCsv(resolved.cc, alwaysCc),
          defaultBcc: resolved.bcc,
          companyEmail,
          sendBlockedReason: mailSendBlockedReason(mailAccounts),
          headerEmailOptions: [
            companyEmail ? { label: 'Company default', value: companyEmail } : null,
            fromAddress && fromAddress !== companyEmail ? { label: 'My email', value: fromAddress } : null,
          ].filter((o): o is { label: string; value: string } => o !== null),
        });
      } catch { /* non-fatal — the composer just opens with empty fields */ }
    })();
    return () => { cancelled = true; };
  }, [templateType, projectId]);

  return defaults;
}
