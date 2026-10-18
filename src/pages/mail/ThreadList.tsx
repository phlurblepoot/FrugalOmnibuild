// src/pages/mail/ThreadList.tsx — middle pane: search box, thread rows, and a
// footer that either pages further back through what is indexed or offers to
// backfill older mail from the provider.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, RefreshCw, Search } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { ThreadRow } from './ThreadRow';
import type { ThreadListRow } from './types';

const SEARCH_DEBOUNCE_MS = 300;

// ── Piece 2: hand-rolled windowing ──────────────────────────────────────────
// No react-window (repo minimalism per the spec) — below VIRTUALIZE_THRESHOLD
// rows every row renders exactly as it always has (this is the common case:
// most folders never come close to 150 threads), so there is zero windowing
// overhead for the vast majority of mailboxes. Past the threshold, only the
// rows within the scroll viewport (plus overscan) render; two spacer divs
// (whose combined height is exactly what the unrendered rows would have
// taken) keep the scrollbar the correct length and the "Load older mail"
// footer / sentinel at the correct scroll position.
//
// Row height is two-tier rather than a single uniform estimate: a row with
// link chips (ThreadRow.tsx renders an extra flex-wrap chip row for any
// thread with links — common, since sending from an item auto-links it) is
// reliably taller than one without, by enough (~20px) that treating every
// row as ROW_HEIGHT_PX undercounts a heavily-linked folder's real height and
// drifts the spacers out of sync with the actual scroll position. Both
// heights are still constants, not measured — deterministic and exact for
// slice math without a ResizeObserver per row — because every OTHER thing
// that could vary a row's height (subject, snippet, participants) is
// `truncate`d to one line; only the link-chips row is structural.
export const VIRTUALIZE_THRESHOLD = 150;
export const ROW_HEIGHT_PX = 76;
export const ROW_HEIGHT_LINKED_PX = 96;
const OVERSCAN_ROWS = 8;

export const rowHeightPx = (row: ThreadListRow): number => (row.links.length > 0 ? ROW_HEIGHT_LINKED_PX : ROW_HEIGHT_PX);

/** Cumulative pixel offsets for `rows`: `offsets[i]` is row i's top, and
 *  `offsets[rows.length]` is the folder's total rendered height. The single
 *  source of truth both the slice math and the spacer heights read from, so
 *  they can never disagree with each other. */
export function rowOffsets(rows: ThreadListRow[]): number[] {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + rowHeightPx(rows[i]);
  return offsets;
}

export interface VisibleRange { start: number; end: number }

/** Pure slice math: which row indices [start, end) should be in the DOM for a
 *  given scroll position and viewport height, given `offsets` (see
 *  `rowOffsets`) rather than a uniform row height — a linear scan (a handful
 *  of comparisons even for hundreds of rows) rather than division, since
 *  rows are no longer all the same size. Exported for direct unit testing
 *  rather than only exercising it through a rendered scroll event. */
export function visibleRowRange(
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number = OVERSCAN_ROWS,
): VisibleRange {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0 || viewportHeight <= 0) return { start: 0, end: rowCount };
  const scrollBottom = scrollTop + viewportHeight;
  // First row whose bottom edge is past the top of the viewport…
  let first = 0;
  while (first < rowCount && offsets[first + 1] <= scrollTop) first++;
  // …and the first row past it whose top edge is at/beyond the viewport's
  // bottom edge — i.e. the last on-screen row is `last - 1`.
  let last = first;
  while (last < rowCount && offsets[last] < scrollBottom) last++;
  return { start: Math.max(0, first - overscan), end: Math.min(rowCount, last + overscan) };
}
/** The refresh route answers 202 as soon as the sync worker has been nudged —
 *  the sync itself is still running. Give it a moment before re-querying so the
 *  first reload has something new in it; the live `mailThread` broadcasts the
 *  sync fires cover anything that lands after. */
const REFRESH_SETTLE_MS = 1500;

const sinceLabel = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const ThreadList: React.FC<{
  accountId: string | null;
  threads: ThreadListRow[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  indexedSince: string | null;
  onLoadOlder: () => void;
  q: string;
  onQueryChange: (q: string) => void;
  selectedKey: string | null;
  ownAddresses: string[];
  onOpen: (row: ThreadListRow) => void;
  onToggleStar: (row: ThreadListRow) => void;
  /** Re-runs the list query — used after a manual refresh. */
  onReload: () => void;
  /** Hands the conversations a whole-mailbox search filed to the list, which
   *  then shows exactly those instead of the current folder. */
  onServerResults: (threadKeys: string[]) => void;
  /** How many conversations that search is showing — null when the list is in
   *  its normal folder mode. */
  serverResultCount: number | null;
  onClearServerResults: () => void;
}> = ({
  accountId, threads, loading, hasMore, onLoadMore, indexedSince, onLoadOlder,
  q, onQueryChange, selectedKey, ownAddresses, onOpen, onToggleStar, onReload,
  onServerResults, serverResultCount, onClearServerResults,
}) => {
  const { toast } = useToast();
  // The input is local so typing stays responsive; the URL only learns about
  // it after the debounce. `lastQ` keeps an external change (navigation, a
  // cleared search) from stomping on characters typed since.
  const [text, setText] = useState(q);
  const lastQ = useRef(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (q === lastQ.current) return;
    lastQ.current = q;
    setText(q);
  }, [q]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handleType = useCallback((value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastQ.current = value;
      onQueryChange(value);
    }, SEARCH_DEBOUNCE_MS);
  }, [onQueryChange]);

  // The local index only reaches back to `indexedSince` and only ever matched
  // subject/from/snippet, so a search that finds nothing here may still match
  // older mail — or body text — on the provider. The hits are filed locally,
  // but showing them means asking for them BY KEY: they are usually archived,
  // so the active folder filter would hide them, and they usually matched on
  // body text the local LIKE still cannot see.
  const [searchingServer, setSearchingServer] = useState(false);
  const runServerSearch = useCallback(async () => {
    const term = q.trim();
    if (!accountId || !term || searchingServer) return;
    setSearchingServer(true);
    try {
      const { count, threadKeys } = await mailApi.searchServer(accountId, term);
      if (threadKeys?.length) {
        toast(`Found ${count} message${count === 1 ? '' : 's'} on the server.`);
        onServerResults(threadKeys);
      } else {
        toast('No matching mail on the server.');
        onReload();
      }
    } catch {
      toast('Could not search the mailbox.', { type: 'error' });
    } finally {
      setSearchingServer(false);
    }
  }, [accountId, q, searchingServer, toast, onReload, onServerResults]);

  const searchWholeMailbox = (
    <Button variant="secondary" size="sm" onClick={runServerSearch} disabled={searchingServer || !accountId}>
      {searchingServer ? 'Searching…' : 'Search the whole mailbox'}
    </Button>
  );

  // "Check for mail now". The server only pokes the scheduler, so the spinner
  // has to outlast the request itself — hence the settle delay before the
  // reload. Live `mailThread` events keep the list honest either way.
  const [refreshing, setRefreshing] = useState(false);
  const aliveRef = useRef(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set on the way IN as well as cleared on the way out: StrictMode (which
  // src/main.tsx wraps the app in) mounts, unmounts and remounts in dev, so a
  // cleanup-only ref would be left false for the component's whole life and
  // the refresh spinner would never settle.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const runRefresh = useCallback(async () => {
    if (!accountId || refreshing) return;
    setRefreshing(true);
    try {
      await mailApi.refreshAccount(accountId);
      await new Promise<void>(resolve => { refreshTimer.current = setTimeout(resolve, REFRESH_SETTLE_MS); });
      if (!aliveRef.current) return;
      onReload();
    } catch {
      if (aliveRef.current) toast('Could not check for new mail.', { type: 'error' });
    } finally {
      if (aliveRef.current) setRefreshing(false);
    }
  }, [accountId, refreshing, onReload, toast]);

  // Auto-page when the sentinel scrolls into view; the button below it stays
  // as the keyboard/no-IntersectionObserver path.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  useEffect(() => {
    const el = sentinel.current;
    if (!hasMore || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) loadMoreRef.current(); },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, threads.length]);

  // Piece 2: windowing state, scoped to the scrollable rows container. Only
  // tracked (and only paid for) once the folder is actually big enough to
  // need it — see the `virtualize` guard below, which never even attaches
  // the scroll listener otherwise.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const virtualize = threads.length > VIRTUALIZE_THRESHOLD;

  useEffect(() => {
    if (!virtualize) return;
    const el = scrollRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height;
      if (h) setViewportHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [virtualize]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // Recomputed only when the row SET changes (not on every scroll) — scroll
  // position is read separately below, off the same offsets array.
  const offsets = useMemo(() => (virtualize ? rowOffsets(threads) : null), [virtualize, threads]);

  const { visibleThreads, topSpacerPx, bottomSpacerPx } = useMemo(() => {
    if (!virtualize || !offsets) return { visibleThreads: threads, topSpacerPx: 0, bottomSpacerPx: 0 };
    // A viewport height of 0 (not yet measured — no ResizeObserver, or the
    // very first render) falls back to rendering everything up to a generous
    // window rather than nothing, so the list is never blank while it waits.
    const { start, end } = visibleRowRange(offsets, scrollTop, viewportHeight || ROW_HEIGHT_PX * 20);
    return {
      visibleThreads: threads.slice(start, end),
      topSpacerPx: offsets[start],
      bottomSpacerPx: Math.max(0, offsets[offsets.length - 1] - offsets[end]),
    };
  }, [virtualize, offsets, threads, scrollTop, viewportHeight]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-edge p-3">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            placeholder="Search mail…"
            value={text}
            onChange={e => handleType(e.target.value)}
            className="w-full rounded-lg border border-edge bg-raised py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent-400 focus:ring-2 focus:ring-accent-500/25 focus-visible:outline-none"
          />
        </div>
        <button
          type="button"
          data-testid="mail-refresh"
          aria-label="Check for new mail"
          title="Check for new mail"
          onClick={runRefresh}
          disabled={refreshing || !accountId}
          className="shrink-0 rounded-lg border border-edge p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
        </button>
      </div>

      {serverResultCount !== null && (
        <div
          data-testid="mail-server-results-banner"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-edge bg-accent-500/10 px-3 py-2 text-xs text-ink-soft"
        >
          <span>
            Showing {serverResultCount} result{serverResultCount === 1 ? '' : 's'} from the full mailbox
          </span>
          <button
            type="button"
            onClick={onClearServerResults}
            className="font-medium text-accent-600 hover:underline dark:text-accent-400"
          >
            Clear
          </button>
        </div>
      )}

      <div ref={scrollRef} onScroll={virtualize ? handleScroll : undefined} className="min-h-0 flex-1 overflow-y-auto">
        {loading && threads.length === 0 ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : threads.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Inbox size={20} />}
              title={q ? 'No matching mail' : 'Nothing here'}
              description={
                q
                  ? 'Nothing matches in the mail indexed on this device.'
                  : 'This folder has no conversations yet.'
              }
              action={q && serverResultCount === null ? searchWholeMailbox : undefined}
            />
          </div>
        ) : (
          <>
            {topSpacerPx > 0 && <div data-testid="mail-list-top-spacer" style={{ height: topSpacerPx }} aria-hidden="true" />}
            {visibleThreads.map(row => (
              <ThreadRow
                key={row.threadKey}
                row={row}
                selected={row.threadKey === selectedKey}
                ownAddresses={ownAddresses}
                onOpen={() => onOpen(row)}
                onToggleStar={() => onToggleStar(row)}
              />
            ))}
            {bottomSpacerPx > 0 && <div data-testid="mail-list-bottom-spacer" style={{ height: bottomSpacerPx }} aria-hidden="true" />}
          </>
        )}

        <div ref={sentinel} />

        {/* Reachable even when the local index DID match: Gmail sees body text
            and archived mail the local query never will, so "some results" is
            not "all results". */}
        {q && threads.length > 0 && serverResultCount === null && (
          <div className="px-3 pb-1 text-center">{searchWholeMailbox}</div>
        )}

        <div className="px-3 py-4 text-center text-xs text-ink-faint">
          {hasMore ? (
            <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            indexedSince && serverResultCount === null && (
              <>
                <span>Showing mail since {sinceLabel(indexedSince)}</span>
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  onClick={onLoadOlder}
                  className="font-medium text-accent-600 hover:underline dark:text-accent-400"
                >
                  Load older mail
                </button>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
};
