// src/pages/mail/LinkPickerModal.tsx — "+ Link" in ThreadView's link strip
// opens this: pick a Customer, a Project, or drill into a specific item
// (project → type → item) and link the current thread to it via
// mailApi.createLink. Mirrors the Field/Select cascading-picker convention
// from UploadDocumentsModal (Type/Project/Customer) and the open-gated list
// loading from SaveAttachmentsModal.
import React, { useEffect, useMemo, useState } from 'react';
import { Customer } from '../../types';
import {
  ProjectSummary, getChangeOrders, getCustomers, getDailyReports, getInvoices,
  getIssues, getPayApps, getProposals, getProjectsSummary, getRfis, getTasks,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { Button, Field, Modal, Select } from '../../components/ui';
import { itemTypeLabel } from './mailFormat';
import type { ItemType } from './types';

type Mode = 'customer' | 'project' | 'item';

const TABS: { mode: Mode; label: string }[] = [
  { mode: 'customer', label: 'Customer' },
  { mode: 'project', label: 'Project' },
  { mode: 'item', label: 'Item' },
];

/** The linkable item types minus 'project'/'customer' — those two have their
 *  own top-level tabs instead of living behind the project→type→item drill. */
const DRILL_TYPES: ItemType[] = [
  'proposal', 'invoice', 'changeOrder', 'payApp', 'issue', 'rfi', 'dailyReport', 'punch', 'task',
];

interface PickableItem { id: string; label: string; }

// One row-fetch + one label formatter per drillable item type, scoped to a
// project. Mirrors server/mail/links.ts' LABEL_RESOLVERS table in spirit
// (kept independent — this is a picker list, not required to match the
// server's resolved label byte-for-byte; the chip that appears after linking
// shows the real server label).
const ITEM_FETCHERS: Partial<Record<ItemType, (projectId: string) => Promise<PickableItem[]>>> = {
  proposal: async projectId => (await getProposals(projectId)).map(
    p => ({ id: p.id, label: `Proposal #${p.number}${p.title ? ` — ${p.title}` : ''}` })
  ),
  invoice: async projectId => (await getInvoices(projectId)).map(
    i => ({ id: i.id, label: `Invoice ${i.number && i.number.trim() ? i.number.trim() : '(no number)'}` })
  ),
  changeOrder: async projectId => (await getChangeOrders(projectId)).map(
    c => ({ id: c.id, label: `CO-${c.number ?? '?'}${c.title ? ` — ${c.title}` : ''}` })
  ),
  payApp: async projectId => (await getPayApps(projectId)).map(
    a => ({ id: a.id, label: `Pay App #${a.number}` })
  ),
  issue: async projectId => (await getIssues(projectId)).map(
    i => ({ id: i.id, label: `ISS-${String(i.number).padStart(3, '0')}${i.title ? ` — ${i.title}` : ''}` })
  ),
  rfi: async projectId => (await getRfis(projectId)).map(
    r => ({ id: r.id, label: `RFI-${String(r.number).padStart(3, '0')}${r.title ? ` — ${r.title}` : ''}` })
  ),
  // One date can hold a report per crew, so the crew is part of the label.
  dailyReport: async projectId => (await getDailyReports(projectId)).map(
    d => ({ id: d.id, label: `Daily Report — ${d.reportDate}${d.crewName ? ` — ${d.crewName}` : ''}` })
  ),
  task: async projectId => (await getTasks({ projectId })).map(
    t => ({ id: t.id, label: t.title || '(untitled)' })
  ),
  // 'punch' has no per-item table — a project's punch list is linked as a
  // single unit (itemId = the projectId itself, same convention the app uses
  // elsewhere for punch's Document Actions bar; see server resolveChain,
  // which treats itemType 'punch' the same way it treats 'project'). No
  // fetcher here: the picker skips the item-list step for this type.
};

export const LinkPickerModal: React.FC<{
  open: boolean;
  onClose: () => void;
  threadKey: string;
  /** Called after a successful link — the caller (ThreadView) reloads the strip. */
  onLinked: () => void;
}> = ({ open, onClose, threadKey, onLinked }) => {
  const { toast } = useToast();

  const [mode, setMode] = useState<Mode>('customer');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customerId, setCustomerId] = useState('');
  // Shared between the Project tab and the Item drill's project-select step —
  // both are "pick a project", and keeping the last pick handy across a tab
  // switch is a convenience, not a bug.
  const [projectId, setProjectId] = useState('');
  const [itemType, setItemType] = useState<ItemType | ''>('');
  const [itemId, setItemId] = useState('');
  const [items, setItems] = useState<PickableItem[] | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Gated on `open` — same reasoning as SaveAttachmentsModal: don't pay for
  // two list requests every time a caller keeps this mounted while closed.
  useEffect(() => {
    if (!open) return;
    getCustomers().then(setCustomers).catch(() => setCustomers([]));
    getProjectsSummary().then(setProjects).catch(() => setProjects([]));
  }, [open]);

  // A fresh open starts from a clean slate — the previous pick (possibly a
  // just-completed link) must not linger into the next open.
  useEffect(() => {
    if (!open) return;
    setMode('customer');
    setCustomerId('');
    setProjectId('');
    setItemType('');
    setItemId('');
    setItems(null);
  }, [open]);

  // Item drill: once a project + non-punch type are both picked, load that
  // type's rows scoped to the project.
  useEffect(() => {
    if (mode !== 'item' || !projectId || !itemType || itemType === 'punch') {
      setItems(null);
      return;
    }
    const fetcher = ITEM_FETCHERS[itemType];
    if (!fetcher) { setItems([]); return; }
    let cancelled = false;
    setItemsLoading(true);
    setItems(null);
    fetcher(projectId)
      .then(rows => { if (!cancelled) setItems(rows); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setItemsLoading(false); });
    return () => { cancelled = true; };
  }, [mode, projectId, itemType]);

  const changeDrillProject = (v: string) => {
    setProjectId(v);
    setItemType('');
    setItemId('');
  };
  const changeDrillType = (v: string) => {
    setItemType(v as ItemType | '');
    setItemId('');
  };

  const canConfirm = useMemo(() => {
    if (mode === 'customer') return !!customerId;
    if (mode === 'project') return !!projectId;
    if (!projectId || !itemType) return false;
    if (itemType === 'punch') return true;
    return !!itemId;
  }, [mode, customerId, projectId, itemType, itemId]);

  const handleConfirm = async () => {
    if (!canConfirm || saving) return;
    const payload: { itemType: ItemType; itemId: string } =
      mode === 'customer' ? { itemType: 'customer', itemId: customerId } :
      mode === 'project' ? { itemType: 'project', itemId: projectId } :
      { itemType: itemType as ItemType, itemId: itemType === 'punch' ? projectId : itemId };
    setSaving(true);
    try {
      await mailApi.createLink({ threadKey, ...payload });
      onLinked();
      onClose();
    } catch {
      toast('Could not link this conversation.', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link conversation"
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!canConfirm || saving}>
            {saving ? 'Linking…' : 'Link'}
          </Button>
        </>
      }
    >
      <div data-testid="link-picker-modal" className="space-y-4">
        <div role="tablist" className="flex w-fit gap-1 rounded-xl bg-sunken p-1">
          {TABS.map(t => (
            <button
              key={t.mode}
              type="button"
              role="tab"
              aria-selected={mode === t.mode}
              onClick={() => setMode(t.mode)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === t.mode ? 'bg-raised text-ink shadow-sm' : 'text-ink-faint hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {mode === 'customer' && (
          <Field label="Customer" htmlFor="link-customer">
            <Select id="link-customer" value={customerId} onChange={e => setCustomerId(e.target.value)}>
              <option value="">— select a customer —</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}

        {mode === 'project' && (
          <Field label="Project" htmlFor="link-project">
            <Select id="link-project" value={projectId} onChange={e => setProjectId(e.target.value)}>
              <option value="">— select a project —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}

        {mode === 'item' && (
          <div className="space-y-4">
            <Field label="Project" htmlFor="link-item-project">
              <Select id="link-item-project" value={projectId} onChange={e => changeDrillProject(e.target.value)}>
                <option value="">— select a project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>

            {projectId && (
              <Field label="Type" htmlFor="link-item-type">
                <Select id="link-item-type" value={itemType} onChange={e => changeDrillType(e.target.value)}>
                  <option value="">— select a type —</option>
                  {DRILL_TYPES.map(t => <option key={t} value={t}>{itemTypeLabel(t)}</option>)}
                </Select>
              </Field>
            )}

            {projectId && itemType === 'punch' && (
              <p className="text-xs text-ink-faint">Links to this project's punch list.</p>
            )}

            {projectId && itemType && itemType !== 'punch' && (
              <Field label={itemTypeLabel(itemType)} htmlFor="link-item-id">
                {itemsLoading ? (
                  <p className="text-xs text-ink-faint">Loading…</p>
                ) : (
                  <Select id="link-item-id" value={itemId} onChange={e => setItemId(e.target.value)} disabled={!items || items.length === 0}>
                    <option value="">{items && items.length === 0 ? '— none found —' : `— select ${itemTypeLabel(itemType).toLowerCase()} —`}</option>
                    {(items ?? []).map(i => <option key={i.id} value={i.id}>{i.label}</option>)}
                  </Select>
                )}
              </Field>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
