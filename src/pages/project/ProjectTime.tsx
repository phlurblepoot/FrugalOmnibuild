// src/pages/project/ProjectTime.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Clock, LogIn, LogOut } from 'lucide-react';
import { TimeEntryLite, clockIn, clockOut, getMyTimeEntries } from '../../utils/store';
import { hoursThisWeek } from '../Dashboard';
import { useToast } from '../../components/Toast';
import { Button, Card, CardBody, CardHeader, EmptyState, Skeleton } from '../../components/ui';

const fmtTime = (ms: number) => new Date(ms).toLocaleString();
const fmtDur = (ms: number) => `${(ms / 3_600_000).toFixed(2)}h`;

// My hours on this project. (Per-person/estimate-vs-actual breakdowns are
// Phase 4 alongside billing — this is the field-usable core.)
export const ProjectTime: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const [entries, setEntries] = useState<TimeEntryLite[] | null>(null);

  const load = () => {
    if (!projectId) return;
    getMyTimeEntries(projectId).then(setEntries).catch(() => setEntries([]));
  };
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEntry = entries?.find(e => e.clockOut === null) ?? null;
  const totalH = entries
    ? entries.reduce((ms, e) => ms + ((e.clockOut ?? Date.now()) - e.clockIn), 0) / 3_600_000
    : null;
  const weekH = entries ? hoursThisWeek(entries) : null;
  const recent = useMemo(
    () => (entries ?? []).slice().sort((a, b) => b.clockIn - a.clockIn).slice(0, 20),
    [entries]
  );

  const toggle = async () => {
    try {
      if (openEntry) {
        await clockOut();
        toast('Clocked out', { type: 'success' });
      } else {
        await clockIn(projectId);
        toast('Clocked in to this project', { type: 'success' });
      }
      load();
    } catch (e) {
      // e.g. "Already clocked in" (open entry on another project)
      toast(e instanceof Error ? e.message : 'Clock action failed', { type: 'error' });
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Time</h1>
        <Button onClick={toggle} variant={openEntry ? 'secondary' : 'primary'}>
          {openEntry ? <LogOut size={15} /> : <LogIn size={15} />}
          {openEntry ? 'Clock out' : 'Clock in'}
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="My hours — total" />
          <CardBody>
            {totalH === null ? <Skeleton className="h-9 w-24" /> : (
              <div className="flex items-baseline gap-2">
                <Clock size={18} className="self-center text-ink-faint" />
                <span className="text-2xl font-bold text-ink">{totalH.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours on this project</span>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="My hours — this week" />
          <CardBody>
            {weekH === null ? <Skeleton className="h-9 w-24" /> : (
              <div className="flex items-baseline gap-2">
                <Clock size={18} className="self-center text-ink-faint" />
                <span className="text-2xl font-bold text-ink">{weekH.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours since Sunday</span>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent entries" />
        <CardBody className="p-0">
          {entries === null ? (
            <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
          ) : recent.length === 0 ? (
            <EmptyState icon={<Clock size={20} />} title="No time logged yet" description="Clock in to start tracking hours against this project." />
          ) : (
            <ul className="divide-y divide-edge">
              {recent.map(e => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="text-ink">{fmtTime(e.clockIn)}</span>
                  <span className="text-ink-soft">
                    {e.clockOut === null ? 'open' : fmtDur(e.clockOut - e.clockIn)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
