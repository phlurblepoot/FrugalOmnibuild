// src/pages/project/ProjectSettings.tsx
//
// Admin-only Project Settings section (Phase 5c). Surfaces the project metadata
// editors that previously lived inline in ProjectView (name, contractor,
// address, due date, stage) plus a Danger Zone for archive/delete. Metadata
// commits through ONE explicit Save button — per-field auto-save was removed
// after the realtime upgrade: each keystroke's save toggled `busy` (dropping
// input focus) and left the form pristine, so the collab hook's silent reload
// could swap the page out from under a typing user. Local edits keep the form
// dirty, which also holds off remote-refresh clobbering (banner instead).
// Stage reuses ProjectStageControl; archive matches ProjectsPage's
// patchProject({ archived }) toggle; delete matches deleteProject + confirm,
// and is offered only for a project with nothing in it — one with documents
// or records says why, with the Archive row right above it (spec
// 2026-10-07-project-delete-guard).
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, ShieldAlert, ThumbsDown, Trash2, Archive, ArchiveRestore } from 'lucide-react';
import { Project, Customer, CustomerRoleEmails } from '../../types';
import {
  getProject, saveProject, deleteProject, patchProject, ConflictError, getCustomers,
  getProjectDeleteCheck, ProjectHasDataError, type ProjectDataSummary,
} from '../../utils/store';
import { projectDeleteBlockedReason } from '../../utils/projectDelete';
import { AddressAutocomplete } from '../../components/AddressAutocomplete';
import { ProjectStageControl } from '../../components/ProjectStageControl';
import { RoleEmailsEditor } from '../../components/RoleEmailsEditor';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Skeleton,
  normalizeProjectStatus,
} from '../../components/ui';
import { useCollabEditing } from '../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../components/EditPresenceBanner';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProjectSettings: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const admin = isAdmin();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Local editor mirrors — kept in sync with the loaded project so inputs stay
  // controlled while the optimistic saves happen against the live `project`.
  const [name, setName] = useState('');
  const [contractor, setContractor] = useState('');
  const [address, setAddress] = useState('');
  const [dueDate, setDueDate] = useState('');

  // Customer picker
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>(undefined);

  // Project-specific contact email overrides
  const [contactEmails, setContactEmails] = useState<CustomerRoleEmails>({});

  // What's in the project, for the Delete row: undefined while asking, null
  // if the ask failed (Delete stays offered; the server still refuses one
  // with data).
  const [deleteCheck, setDeleteCheck] = useState<{ canDelete: boolean; summary: ProjectDataSummary } | null | undefined>(undefined);

  useEffect(() => {
    getCustomers()
      .then(setCustomers)
      .catch(err => console.error('Failed to load customers:', err));
  }, []);

  const reload = () => {
    if (!projectId || !admin) return;
    setLoading(true);
    getProject(projectId)
      .then(p => {
        setProject(p);
        if (p) {
          setName(p.name ?? '');
          setContractor(p.contractor ?? '');
          setAddress(p.address ?? '');
          setDueDate(p.bidDueDate ? new Date(p.bidDueDate).toISOString().split('T')[0] : '');
          setSelectedCustomerId(p.customerId ?? undefined);
          setContactEmails(p.contactEmails ?? {});
        }
      })
      .catch(() => setProject(null))
      .finally(() => setLoading(false));
    getProjectDeleteCheck(projectId)
      .then(setDeleteCheck)
      .catch(() => setDeleteCheck(null));
  };
  useEffect(reload, [projectId, admin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dirty = any local mirror differs from the loaded project. Stays true for
  // the whole editing session (fields no longer auto-save), which is what
  // keeps useCollabEditing from silently reloading under the user's cursor.
  const dirty =
    !!project && (
      name !== (project.name ?? '') ||
      contractor !== (project.contractor ?? '') ||
      address !== (project.address ?? '') ||
      dueDate !== (project.bidDueDate ? new Date(project.bidDueDate).toISOString().split('T')[0] : '') ||
      selectedCustomerId !== (project.customerId ?? undefined) ||
      JSON.stringify(contactEmails) !== JSON.stringify(project.contactEmails ?? {})
    );

  const collab = useCollabEditing({
    type: 'project',
    id: projectId ?? '',
    isDirty: () => dirty,
    onFresh: reload,
    enabled: admin,
  });

  // Admins only: never load or expose project data otherwise.
  if (!admin) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8">
        <EmptyState icon={<ShieldAlert size={22} />} title="Project settings are admin-only"
          description="Ask an administrator for access to project settings." />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[0, 1].map(i => <Skeleton key={i} className="h-40" />)}
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
        <EmptyState icon={<SettingsIcon size={22} />} title="Project not found"
          description="This project could not be loaded." />
      </div>
    );
  }

  // Selecting a customer only updates the local mirrors (contractor follows
  // the linked customer's name, matching the old auto-save behavior) — the
  // pairing commits with everything else on Save.
  const pickCustomer = (custId: string) => {
    setSelectedCustomerId(custId || undefined);
    const found = customers.find(c => c.id === custId);
    if (found) setContractor(found.name);
  };

  // ONE explicit commit for every metadata field. This is the only path that
  // persists (and therefore broadcasts) Details/contacts changes — other
  // users' pages live-refresh when this lands, not while someone is typing.
  // On failure the typed values are KEPT (no mirror rollback) so the user can
  // retry; only the optimistic `project` swap is rolled back.
  const saveAll = async () => {
    if (!project || busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast('Project name cannot be empty', { type: 'error' });
      return;
    }
    const previous = project;
    const updated: Project = {
      ...project,
      ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
      name: trimmedName,
      contractor: contractor.trim() || undefined,
      address: address.trim() || undefined,
      // Match ProjectView.handleSaveDueDate: 'YYYY-MM-DD' ↔ ms epoch.
      bidDueDate: dueDate ? new Date(dueDate).getTime() : undefined,
      customerId: selectedCustomerId,
      contactEmails,
    };
    setProject(updated);
    setBusy(true);
    try {
      await saveProject(updated);
      toast('Settings saved', { type: 'success' });
      reload();
    } catch (error) {
      setProject(previous);
      toast(error instanceof ConflictError
        ? 'Project changed elsewhere — review the banner above, then save again'
        : 'Failed to save settings. Please try again.', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Throw away local edits and re-mirror the loaded project.
  const discard = () => {
    setName(project.name ?? '');
    setContractor(project.contractor ?? '');
    setAddress(project.address ?? '');
    setDueDate(project.bidDueDate ? new Date(project.bidDueDate).toISOString().split('T')[0] : '');
    setSelectedCustomerId(project.customerId ?? undefined);
    setContactEmails(project.contactEmails ?? {});
  };

  // Stage changes commit instantly (button, not typing). While the form is
  // dirty, refresh only the underlying `project` row (version/status) without
  // resetting the field mirrors — a full reload would wipe in-progress edits.
  const onStageChanged = () => {
    if (!dirty) { reload(); return; }
    if (!projectId) return;
    getProject(projectId).then(p => { if (p) setProject(p); }).catch(() => {});
  };

  const isArchived = !!project.archived;
  // Only an open bid can be lost — an in-progress job that ends badly is an
  // archive, not a lost bid.
  const isBidding = !isArchived && normalizeProjectStatus(project.status ?? '') === 'bidding';

  // Archive toggle matches ProjectsPage.applyPatch: patchProject({ archived }).
  const toggleArchive = async () => {
    if (!project) return;
    setBusy(true);
    try {
      // Restoring clears the lost-bid marker with it — see ProjectsPage.
      await patchProject(project.id, isArchived
        ? { version: project.version ?? 1, archived: false, lostBid: false }
        : { version: project.version ?? 1, archived: true });
      toast(isArchived ? 'Project restored' : 'Project archived', { type: 'success' });
      reload();
    } catch (e) {
      toast(e instanceof ConflictError ? 'Project changed elsewhere — refresh and retry' : 'Failed to update archive state', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // A lost bid is an archive with a reason: the project leaves the board but
  // keeps a Lost badge in the Archive tab instead of looking merely tidied away.
  const markLostBid = async () => {
    if (!project) return;
    if (!await confirm({
      title: 'Mark as lost bid',
      message: 'Archive this project and record the bid as lost? You can restore it later.',
      confirmLabel: 'Mark as lost',
    })) return;
    setBusy(true);
    try {
      await patchProject(project.id, { version: project.version ?? 1, archived: true, lostBid: true });
      toast('Marked as lost bid', { type: 'success' });
      reload();
    } catch (e) {
      toast(e instanceof ConflictError ? 'Project changed elsewhere — refresh and retry' : 'Failed to mark as lost', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Delete matches ProjectsPage's deleteProject flow (confirm → delete → leave).
  const handleDelete = async () => {
    if (!project) return;
    if (!await confirm({
      title: 'Delete project',
      message: 'Delete this project and all its data? This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })) return;
    setBusy(true);
    try {
      await deleteProject(project.id);
      toast('Project deleted', { type: 'success' });
      navigate('/projects');
    } catch (e) {
      setBusy(false);
      if (!(e instanceof ProjectHasDataError)) {
        toast('Failed to delete project', { type: 'error' });
        return;
      }
      // Something landed in it since the page asked (someone uploaded,
      // say): the row now says why, and Archive is offered right here.
      setDeleteCheck({ canDelete: false, summary: e.summary });
      const reason = projectDeleteBlockedReason(e.summary);
      if (isArchived) {
        toast(`This project can't be deleted. ${reason}`, { type: 'warning' });
      } else if (await confirm({ title: "Can't delete this project", message: reason, confirmLabel: 'Archive' })) {
        await toggleArchive();
      }
    }
  };

  // Only a project with nothing in it can be deleted.
  const deleteBlocked = deleteCheck ? !deleteCheck.canDelete : false;
  const deleteBlockedReason = deleteCheck && !deleteCheck.canDelete ? projectDeleteBlockedReason(deleteCheck.summary) : '';

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Project Settings</h1>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
          <Button variant="secondary" onClick={discard} disabled={!dirty || busy}>Discard</Button>
          <Button onClick={saveAll} disabled={!dirty || busy}>Save</Button>
        </div>
      </div>
      <EditPresenceBanner state={collab} />

      {/* Metadata — edits stay local until Save commits them all at once. */}
      <Card>
        <CardHeader title="Details" />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Project name" htmlFor="ps-name">
              <Input id="ps-name" value={name} disabled={busy}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && dirty) saveAll(); }} />
            </Field>
            <Field label="Customer" htmlFor="ps-customer">
              <Select id="ps-customer" value={selectedCustomerId ?? ''} disabled={busy}
                onChange={e => pickCustomer(e.target.value)}>
                <option value="">— None —</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Address" htmlFor="ps-address">
              <AddressAutocomplete value={address} onChange={setAddress} disabled={busy} />
            </Field>
            <Field label="Bid due date" htmlFor="ps-due">
              <Input id="ps-due" type="date" value={dueDate} disabled={busy}
                onChange={e => setDueDate(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && dirty) saveAll(); }} />
            </Field>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm text-ink-soft">Stage</span>
            <ProjectStageControl
              projectId={project.id}
              version={project.version}
              status={project.status}
              onChanged={onStageChanged}
            />
          </div>

          {/* DEFERRED: contract value is a billing rollup, managed in Billing */}
        </CardBody>
      </Card>

      {/* Project-specific contact overrides */}
      <Card>
        <CardHeader title="Project contacts (override customer)" />
        <CardBody>
          <p className="text-xs text-ink-faint mb-4">
            These email addresses are used for this project only and override any emails set on the linked customer.
            Changes commit with the Save button above.
          </p>
          <RoleEmailsEditor
            value={contactEmails}
            onChange={setContactEmails}
            disabled={busy}
          />
        </CardBody>
      </Card>

      {/* Danger Zone */}
      <Card className="border-rose-300 dark:border-rose-900/50">
        <CardHeader title="Danger zone" />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">{isArchived ? 'Restore project' : 'Archive project'}</p>
              <p className="text-xs text-ink-faint">
                {isArchived
                  ? 'Move this project back into the active pipeline.'
                  : 'Hide this project from the active pipeline. It can be restored anytime.'}
              </p>
            </div>
            <Button variant="secondary" onClick={toggleArchive} disabled={busy}>
              {isArchived ? <><ArchiveRestore size={14} />Restore</> : <><Archive size={14} />Archive</>}
            </Button>
          </div>

          {isBidding && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
              <div>
                <p className="text-sm font-medium text-ink">Mark as lost bid</p>
                <p className="text-xs text-ink-faint">
                  Archive this project and flag the bid as lost. It keeps a "Lost" badge in the Archive tab.
                </p>
              </div>
              <Button variant="secondary" onClick={markLostBid} disabled={busy}>
                <ThumbsDown size={14} />Mark as lost
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4" data-testid="delete-project-row">
            <div>
              <p className="text-sm font-medium text-ink">Delete project</p>
              {deleteBlocked ? (
                <p className="text-xs text-ink-faint" data-testid="delete-blocked-reason">{deleteBlockedReason}</p>
              ) : (
                <p className="text-xs text-ink-faint">Permanently remove this project. Only a project with nothing in it can be deleted.</p>
              )}
            </div>
            {/* A blocked project's way out is the Archive row just above. */}
            <Button variant="danger" onClick={handleDelete} disabled={busy || deleteBlocked || deleteCheck === undefined}
              title={deleteBlocked ? deleteBlockedReason : undefined}>
              <Trash2 size={14} />Delete
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
