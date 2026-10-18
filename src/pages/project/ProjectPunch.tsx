// src/pages/project/ProjectPunch.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CheckSquare, Plus, ImageIcon } from 'lucide-react';
import {
  PunchItem, PunchListItem, getPunchItems, getPunchItem, createPunchItem, setPunchDone, getSettings, sendPunchReport,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import {
  Button, Card, CardBody, EmptyState, Field, Input, ProgressBar, Skeleton,
} from '../../components/ui';
import { DocumentActionsBar } from '../../components/documents/DocumentActionsBar';
import { PunchItemEditor } from './punch/PunchItemEditor';
import { EditingChip } from '../../components/EditingChip';
import { buildPunchPdf } from './punch/punchPdf';
import { hexToRgb, invertImageDataUrl } from '../../utils/documentLetterhead';
import { useProjectOutlet } from './ProjectLayout';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useItemEmailDefaults } from '../../hooks/useItemEmailDefaults';
import { itemSendPayload } from '../../utils/itemSend';
import { useReveal } from '../../hooks/useReveal';

const UNASSIGNED = 'Unassigned';

interface AreaGroup { area: string; label: string; items: PunchListItem[]; }

// Reveals an area-group Card on scroll (Wave 3 Task 11). A dedicated
// component (not an inline hook call in .map) so each group gets its own
// IntersectionObserver — hooks can't be called a variable number of times
// per render.
const RevealGroup: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const ref = useReveal<HTMLDivElement>();
  return <div ref={ref}>{children}</div>;
};

export const ProjectPunch: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { summary } = useProjectOutlet();
  const { toast } = useToast();
  const [items, setItems] = useState<PunchListItem[] | null>(null);
  const [editing, setEditing] = useState<PunchItem | null>(null);
  const [newArea, setNewArea] = useState('');
  const [newDesc, setNewDesc] = useState('');

  // Email defaults: resolved recipient, always-CC, header-email options.
  const emailDefaults = useItemEmailDefaults('punch', projectId);

  const reload = () => {
    if (!projectId) return;
    getPunchItems(projectId).then(setItems).catch(() => setItems([]));
  };
  useLiveQuery(reload, { types: ['punch'], projectId });

  // Focus the create-form input when arriving via the command palette's "New punch item" action.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      const el = document.getElementById('new-punch-desc') as HTMLInputElement | null;
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('new'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const list = items ?? [];
  const done = list.filter(i => i.done).length;
  const total = list.length;

  // Distinct area names (non-empty) for the create-form datalist quick reuse.
  const areaOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const i of list) { const a = i.area.trim(); if (a) seen.add(a); }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [list]);

  // Group by area, preserving server order within each group. The server already
  // orders by (area, sortOrder); we only push the Unassigned bucket to the end.
  const groups = useMemo<AreaGroup[]>(() => {
    const map = new Map<string, AreaGroup>();
    for (const i of list) {
      const trimmed = i.area.trim();
      const key = trimmed || UNASSIGNED;
      let g = map.get(key);
      if (!g) { g = { area: key, label: trimmed || UNASSIGNED, items: [] }; map.set(key, g); }
      g.items.push(i);
    }
    const out = Array.from(map.values());
    out.sort((a, b) => {
      if (a.area === UNASSIGNED) return 1;
      if (b.area === UNASSIGNED) return -1;
      return 0; // otherwise keep first-seen (i.e. server) order
    });
    return out;
  }, [list]);

  const openItem = async (id: string) => {
    try { setEditing(await getPunchItem(id)); } catch { toast('Failed to open item', { type: 'error' }); }
  };

  const toggleDone = async (item: PunchListItem) => {
    try { await setPunchDone(item.id, !item.done); reload(); }
    catch { toast('Failed to update item', { type: 'error' }); }
  };

  const addItem = async () => {
    if (!projectId || !newDesc.trim()) { toast('Enter a description', { type: 'warning' }); return; }
    try {
      await createPunchItem(projectId, { area: newArea.trim(), description: newDesc.trim() });
      setNewArea('');
      setNewDesc('');
      reload();
    } catch { toast('Failed to create item', { type: 'error' }); }
  };

  const buildPunchDoc = async (headerEmail?: string) => {
    const projectName = summary?.name || 'project';
    const settings = await getSettings();
    let logoDataUrl: string | undefined = settings.logoUrl || undefined;
    if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    }
    if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
      logoDataUrl = await invertImageDataUrl(logoDataUrl);
    }
    return buildPunchPdf({
      items: list.map(i => ({ area: i.area, description: i.description, done: i.done })),
      projectName,
      photoDataUrls: {}, // text-only v1; param kept so photos can be added later
      letterhead: {
        brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
        company: {
          name: settings.companyName || settings.appName,
          phone: settings.companyPhone,
          email: settings.companyEmail,
          address: settings.companyAddress,
        },
        logoDataUrl,
      },
      headerEmail: headerEmail || undefined,
    });
  };

  const punchFileName = `${summary?.name || 'project'}-punch-list.pdf`;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-ink">Punch list</h1>
        <DocumentActionsBar
          source={{ sourceType: 'punch', sourceId: projectId }}
          kind="punch-report"
          format="pdf"
          projectId={projectId ?? ''}
          fileName={punchFileName}
          build={async ({ headerEmail }) => {
            const doc = await buildPunchDoc(headerEmail);
            return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' });
          }}
          dirty={false}
          save={async () => true}
          // PunchItem/PunchListItem carry no updatedAt (only createdAt), so
          // there is no clock to compare a stored report against. Saying
          // 'unknown' keeps the chip from claiming freshness it can't know and
          // makes Send always regenerate — which is what the old always-rebuild
          // Download/Send button did.
          updatedAt={null}
          staleness="unknown"
          size="sm"
          send={{
            blockedReason: (list.length === 0 ? 'No punch items' : undefined) ?? emailDefaults.sendBlockedReason,
            composer: {
              title: 'Send punch list report',
              defaultTo: emailDefaults.defaultTo || undefined,
              defaultCc: emailDefaults.defaultCc || undefined,
              defaultBcc: emailDefaults.defaultBcc || undefined,
              defaultSubject: `Punch List Report — ${summary?.name || 'Project'}`,
              defaultBody: `Hello,\n\nPlease find attached the punch list report for ${summary?.name || 'the project'}.\n\nThank you.`,
              headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
              defaultHeaderEmail: emailDefaults.companyEmail || undefined,
            },
            sendFn: async (fileId, req) => {
              if (!projectId) return;
              return await sendPunchReport(projectId, { ...itemSendPayload(req), fileId });
            },
          }}
        />
      </div>

      {total > 0 && (
        <div className="mb-5">
          <ProgressBar done={done} total={total} />
        </div>
      )}

      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Area" htmlFor="new-punch-area">
              <Input id="new-punch-area" list="punch-areas" value={newArea}
                onChange={e => setNewArea(e.target.value)}
                placeholder="e.g. Kitchen" className="w-44" />
              <datalist id="punch-areas">
                {areaOptions.map(a => <option key={a} value={a} />)}
              </datalist>
            </Field>
            <Field label="New item" htmlFor="new-punch-desc">
              <Input id="new-punch-desc" value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addItem(); }}
                placeholder="Describe the item to fix" className="w-full sm:w-auto flex-1" />
            </Field>
            <Button onClick={addItem} disabled={!newDesc.trim()}><Plus size={15} />Add</Button>
          </div>
        </CardBody>
      </Card>

      {items === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : list.length === 0 ? (
        <EmptyState icon={<CheckSquare size={22} />} title="No punch items yet"
          description="Track fix-up items by area, mark them done in the field, and send a punch report." />
      ) : (
        <div className="space-y-5">
          {groups.map(g => {
            const gDone = g.items.filter(i => i.done).length;
            return (
              <RevealGroup key={g.area}>
              <Card>
                <CardBody>
                  <div className="mb-2 flex items-center gap-3">
                    <h2 className="shrink-0 text-sm font-semibold text-ink">{g.label}</h2>
                    <ProgressBar done={gDone} total={g.items.length} className="flex-1" />
                  </div>
                  <ul className="divide-y divide-edge">
                    {g.items.map(item => (
                      <li key={item.id} className="flex items-center gap-3 py-2">
                        <input type="checkbox" checked={!!item.done}
                          onChange={() => toggleDone(item)}
                          className="size-5 shrink-0 rounded border-edge-strong accent-accent-600"
                          aria-label={item.done ? 'Mark not done' : 'Mark done'} />
                        <button type="button" onClick={() => openItem(item.id)}
                          className="flex flex-1 items-center gap-2 text-left">
                          <span className={`flex-1 text-sm ${item.done ? 'text-ink-faint line-through' : 'text-ink'}`}>
                            {item.description || '(no description)'}
                          </span>
                          <EditingChip type="punch" id={item.id} />
                          {item.photoCount > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-faint">
                              <ImageIcon size={13} />{item.photoCount}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
              </RevealGroup>
            );
          })}
        </div>
      )}

      {editing && (
        <PunchItemEditor
          key={`${editing.id}:${editing.version}`}
          item={editing}
          projectId={projectId ?? ''}
          onClose={() => setEditing(null)}
          onSaved={async () => { try { setEditing(await getPunchItem(editing.id)); } catch { setEditing(null); } reload(); }}
        />
      )}
    </div>
  );
};
