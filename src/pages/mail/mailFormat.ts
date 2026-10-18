// src/pages/mail/mailFormat.ts — pure display formatting for the mail UI.
// Locale is pinned to en-US on purpose: these strings are asserted in tests
// and the app is single-locale, so a host locale change must not move them.
import type { Addr, ItemType } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `10:42 AM` today · `Aug 27` earlier this year · `8/27/25` otherwise. */
export function formatMailDate(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();

  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameYear) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

const MAX_NAMES = 3;

/** First names of everyone on the thread, with the account owner shown as "me". */
export function participantsLabel(participants: Addr[], ownAddresses: string[]): string {
  const own = new Set(ownAddresses.map(a => a.trim().toLowerCase()));
  const names: string[] = [];

  for (const p of participants) {
    const addr = (p.addr ?? '').trim();
    const label = own.has(addr.toLowerCase())
      ? 'me'
      : firstName(p.name) || addr.split('@')[0] || addr;
    if (label && !names.includes(label)) names.push(label);
  }

  if (names.length === 0) return '(unknown)';
  if (names.length <= MAX_NAMES) return names.join(', ');
  return `${names.slice(0, MAX_NAMES).join(', ')}…`;
}

function firstName(name?: string): string {
  const clean = (name ?? '').replace(/^["']|["']$/g, '').trim();
  if (!clean) return '';
  // "Smith, Bob" (some providers) → Bob; otherwise the leading word.
  if (clean.includes(',')) return clean.split(',')[1]?.trim().split(/\s+/)[0] ?? clean;
  return clean.split(/\s+/)[0];
}

const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  proposal: 'Proposal',
  invoice: 'Invoice',
  changeOrder: 'Change Order',
  lienRelease: 'Lien Release',
  payApp: 'Pay App',
  issue: 'Issue',
  rfi: 'RFI',
  dailyReport: 'Daily Report',
  punch: 'Punch',
  task: 'Task',
  project: 'Project',
  customer: 'Customer',
};

/** Human label for a linked app item ("rfi" → "RFI"). Unknown types echo back. */
export function itemTypeLabel(itemType: string): string {
  return ITEM_TYPE_LABELS[itemType as ItemType] ?? itemType;
}
