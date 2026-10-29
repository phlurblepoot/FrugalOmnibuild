// src/whatsNew/WhatsNewModal.tsx
// The "What's new" popup: a welcome page listing everything in it, then one
// page per change (a screenshot, a few sentences, where to try it), paged
// with Back and Next, the dots, or the arrow keys.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Button, Modal } from '../components/ui';
import { useTheme } from '../context/ThemeContext';
import type { WhatsNewKind, WhatsNewPage, WhatsNewRelease, WhatsNewShot } from './releases';

type Entry = { type: 'welcome'; version: string } | { type: 'page'; version: string; page: WhatsNewPage };

const KIND_LABEL: Record<WhatsNewKind, string> = { new: 'New', improved: 'Improved', fixed: 'Fixed' };
const KIND_CLASS: Record<WhatsNewKind, string> = {
  new: 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300',
  improved: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  fixed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
};

/** Text with [[Key]] shown as a key. */
const rich = (text: string): React.ReactNode =>
  text.split(/\[\[(.+?)\]\]/).map((part, i) => (i % 2
    ? <kbd key={i} className="rounded border border-b-2 border-edge-strong bg-sunken px-1 font-mono text-[0.85em] font-semibold text-ink">{part}</kbd>
    : <React.Fragment key={i}>{part}</React.Fragment>));

export const shotUrl = (version: string, shot: WhatsNewShot, dark: boolean): string =>
  `/whats-new/${version}/${dark && shot.dark ? shot.file.replace(/\.(\w+)$/, '-dark.$1') : shot.file}`;

export const WhatsNewModal: React.FC<{
  open: boolean;
  /** Newest first. */
  releases: WhatsNewRelease[];
  onClose: () => void;
}> = ({ open, releases, onClose }) => {
  const navigate = useNavigate();
  const { mode } = useTheme();
  const dark = mode === 'dark';
  const reduceMotion = useReducedMotion();
  const entries = useMemo<Entry[]>(() => releases.length ? [
    { type: 'welcome', version: releases[0].version },
    ...releases.flatMap(r => r.pages.map(page => ({ type: 'page' as const, version: r.version, page }))),
  ] : [], [releases]);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setIndex(0); }, [open, releases]);

  const go = (i: number) => {
    if (i < 0 || i >= entries.length || i === index) return;
    setDir(i > index ? 1 : -1);
    setIndex(i);
  };
  const last = index === entries.length - 1;
  const next = () => (last ? onClose() : go(index + 1));

  // Arrow keys page through (Esc closes, through the Modal).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = e => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
  };
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);

  // Back at the top for each page; the next page's picture loads while this one is read.
  useEffect(() => {
    const scroller = topRef.current?.closest('.overflow-y-auto');
    if (scroller) scroller.scrollTop = 0;
    const ahead = entries[index + 1];
    if (ahead?.type === 'page') for (const s of ahead.page.shots) { const img = new Image(); img.src = shotUrl(ahead.version, s, dark); }
  }, [index, entries, dark]);

  if (!entries.length) return null;
  const entry = entries[Math.min(index, entries.length - 1)];

  const welcome = () => {
    const several = releases.length > 1;
    const intro = several
      ? { title: 'What has changed since you were last here', body: `Updates ${releases.map(r => r.version).reverse().join(', ')}. Jump to anything below.` }
      : releases[0].intro;
    return (
      <div className="grid gap-4">
        <h3 className="text-2xl font-semibold tracking-tight text-ink text-balance">{intro.title}</h3>
        <p className="text-ink-soft">{intro.body}</p>
        <div className="grid gap-4" data-testid="whats-new-contents">
          {releases.map(r => {
            const areas = [...new Set(r.pages.map(p => p.area))];
            return (
              <div key={r.version} className="grid gap-3">
                {several && <p className="text-sm font-semibold text-ink">{r.version}</p>}
                {areas.map(area => (
                  <div key={area} className="grid gap-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{area}</p>
                    <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
                      {r.pages.filter(p => p.area === area).map(p => {
                        const at = entries.findIndex(e => e.type === 'page' && e.page === p);
                        return (
                          <button key={p.id} type="button" onClick={() => go(at)}
                            className="rounded-md px-2 py-1.5 text-left text-sm font-medium text-ink hover:bg-hover">
                            {p.title}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const page = (version: string, p: WhatsNewPage) => (
    <div className={`grid gap-5 lg:items-start ${p.shots.length > 1 ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'}`}>
      <div className={`grid gap-3 ${p.shots.length > 1 ? 'sm:grid-cols-2 lg:grid-cols-1' : ''}`}>
        {p.shots.map(s => (
          <figure key={s.file} className="m-0 overflow-hidden rounded-lg border border-edge bg-sunken">
            <img src={shotUrl(version, s, dark)} alt={s.caption}
              className={`block aspect-[16/10] w-full ${s.paper ? 'bg-white object-contain' : p.shots.length > 1 ? 'object-contain' : 'object-cover object-top'}`} />
            <figcaption className="border-t border-edge bg-raised px-3 py-1.5 text-xs text-ink-faint">{s.caption}</figcaption>
          </figure>
        ))}
      </div>
      <div className="grid min-w-0 content-start gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${KIND_CLASS[p.kind]}`}>{KIND_LABEL[p.kind]}</span>
          <span className="text-sm text-ink-faint">{p.area}</span>
        </div>
        <h3 className="text-xl font-semibold leading-snug tracking-tight text-ink text-balance">{p.title}</h3>
        {p.body && <p className="text-ink-soft">{rich(p.body)}</p>}
        {p.kind === 'fixed' ? (
          <ul className="grid gap-2.5">
            {p.points.map((t, i) => (
              <li key={i} className="flex items-start gap-2.5 text-ink-soft"><Check size={16} className="mt-1 shrink-0 text-green-600 dark:text-green-400" />{rich(t)}</li>
            ))}
          </ul>
        ) : (
          <ul className="grid list-disc gap-1.5 pl-5 text-ink-soft marker:text-accent-500">
            {p.points.map((t, i) => <li key={i}>{rich(t)}</li>)}
          </ul>
        )}
        {p.action && (
          <Button variant="secondary" size="sm" className="justify-self-start" data-testid="whats-new-action"
            onClick={() => { onClose(); navigate(p.action!.to); }}>
            {p.action.label}
          </Button>
        )}
        {last && <p className="text-sm text-ink-faint">That&apos;s everything. See this again any time from Settings › Changelog.</p>}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="xl"
      title={
        <span className="flex items-center gap-2">
          What&apos;s new
          <span className="rounded-md bg-accent-50 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-accent-700 dark:bg-accent-900/40 dark:text-accent-300">{entry.version}</span>
        </span>
      }
      footer={
        <div className="flex w-full items-center gap-2" data-testid="whats-new-footer">
          {!last && <Button variant="ghost" onClick={onClose} data-testid="whats-new-skip">Skip</Button>}
          <div className="hidden flex-1 flex-wrap items-center justify-center gap-1.5 sm:flex" role="group" aria-label="Pages">
            {entries.map((_, i) => (
              <button key={i} type="button" onClick={() => go(i)} aria-label={`Page ${i + 1}`} aria-current={i === index ? 'step' : undefined}
                className={`h-2 rounded-full transition-all ${i === index ? 'w-5 bg-accent-600' : 'w-2 bg-edge-strong hover:bg-ink-faint'}`} />
            ))}
          </div>
          <span className="flex-1 text-center text-sm tabular-nums text-ink-faint sm:hidden" data-testid="whats-new-count">{index + 1} of {entries.length}</span>
          <Button variant="secondary" onClick={() => go(index - 1)} disabled={index === 0} data-testid="whats-new-back">Back</Button>
          <Button onClick={next} data-testid="whats-new-next">{index === 0 ? 'Start the tour' : last ? 'Done' : 'Next'}</Button>
        </div>
      }
    >
      <div ref={topRef} data-testid="whats-new">
        <motion.div
          key={index}
          initial={reduceMotion ? false : { opacity: 0, x: dir * 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.18 }}
        >
          {entry.type === 'welcome' ? welcome() : page(entry.version, entry.page)}
        </motion.div>
      </div>
    </Modal>
  );
};
