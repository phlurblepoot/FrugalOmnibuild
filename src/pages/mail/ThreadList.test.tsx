// src/pages/mail/ThreadList.test.tsx — the middle pane on its own: the
// debounced search box, the rows, the paging footer, and the two empty states
// (including the "search the whole mailbox" fallback for mail older than the
// local index).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ThreadListRow } from './types';

const h = vi.hoisted(() => ({ searchServer: vi.fn(), refreshAccount: vi.fn(), toast: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: { searchServer: h.searchServer, refreshAccount: h.refreshAccount } }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

import {
  ROW_HEIGHT_LINKED_PX, ROW_HEIGHT_PX, ThreadList, VIRTUALIZE_THRESHOLD, rowHeightPx, rowOffsets, visibleRowRange,
} from './ThreadList';

const row = (over: Partial<ThreadListRow> = {}): ThreadListRow => ({
  threadKey: 'tk-1', subject: 'Roof detail', firstDate: '2026-08-27T12:00:00.000Z',
  lastDate: '2026-08-27T12:00:00.000Z', messageCount: 2, unreadCount: 1, hasAttachments: 0, isStarred: 0,
  participants: [{ addr: 'bob@acme.com', name: 'Bob Smith' }], folderIds: ['f-inbox'],
  snippet: 'Please review the attached detail', links: [], ...over,
});

type Props = React.ComponentProps<typeof ThreadList>;

const props = (over: Partial<Props> = {}): Props => ({
  accountId: 'a1',
  threads: [row()],
  loading: false,
  hasMore: false,
  onLoadMore: vi.fn(),
  indexedSince: null,
  onLoadOlder: vi.fn(),
  q: '',
  onQueryChange: vi.fn(),
  selectedKey: null,
  ownAddresses: ['noah@birchwoodplaster.example'],
  onOpen: vi.fn(),
  onToggleStar: vi.fn(),
  onReload: vi.fn(),
  onServerResults: vi.fn(),
  serverResultCount: null,
  onClearServerResults: vi.fn(),
  ...over,
});

const searchBox = () => screen.getByPlaceholderText('Search mail…');

beforeEach(() => {
  vi.clearAllMocks();
  h.searchServer.mockResolvedValue({ count: 0, threadKeys: [] });
  h.refreshAccount.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ThreadList', () => {
  it('renders a row per thread', () => {
    render(<ThreadList {...props({ threads: [row(), row({ threadKey: 'tk-2', subject: 'Stucco mock-up' })] })} />);
    expect(screen.getAllByTestId('mail-thread-row')).toHaveLength(2);
    expect(screen.getByText('Roof detail')).toBeInTheDocument();
    expect(screen.getByText('Stucco mock-up')).toBeInTheDocument();
  });

  // Typing stays local; the committed query (which drives a fetch and the URL)
  // only moves once the user pauses.
  it('debounces typing before it commits the query', () => {
    vi.useFakeTimers();
    const onQueryChange = vi.fn();
    render(<ThreadList {...props({ onQueryChange })} />);

    fireEvent.change(searchBox(), { target: { value: 'roo' } });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.change(searchBox(), { target: { value: 'roof' } });
    act(() => { vi.advanceTimersByTime(299); });
    expect(onQueryChange).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith('roof');
  });

  it('pages further back through the index with Load more', () => {
    const onLoadMore = vi.fn();
    render(<ThreadList {...props({ hasMore: true, onLoadMore })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('offers to backfill older mail once the index has been paged to its end', () => {
    const onLoadOlder = vi.fn();
    render(<ThreadList {...props({ hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z', onLoadOlder })} />);
    // (The formatted date is the machine's local rendering of the ISO stamp,
    // so the assertion stays on the label rather than a timezone-dependent day.)
    expect(screen.getByText(/Showing mail since/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load older mail/i }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty folder from an empty search', () => {
    const { rerender } = render(<ThreadList {...props({ threads: [] })} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Search the whole mailbox/i })).toBeNull();

    rerender(<ThreadList {...props({ threads: [], q: 'shingle' })} />);
    expect(screen.getByText('No matching mail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Search the whole mailbox/i })).toBeInTheDocument();
  });

  // Manual "check for mail now": the route only nudges the sync worker, so the
  // list is re-queried after a settle delay rather than off the 202 itself.
  it('asks the server to sync and reloads the list once it has had a moment', async () => {
    vi.useFakeTimers();
    const onReload = vi.fn();
    render(<ThreadList {...props({ onReload })} />);

    fireEvent.click(screen.getByTestId('mail-refresh'));
    await act(async () => {});
    expect(h.refreshAccount).toHaveBeenCalledWith('a1');
    // Still spinning, and still not reloaded, until the settle delay is up.
    expect(screen.getByTestId('mail-refresh')).toBeDisabled();
    expect(onReload).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mail-refresh')).not.toBeDisabled();
  });

  // src/main.tsx wraps the app in StrictMode, so in dev every component mounts,
  // unmounts and remounts. A cleanup-only alive ref would be left false from
  // that first teardown and the spinner would never settle again.
  it('still settles the refresh under StrictMode\'s mount/unmount/remount', async () => {
    vi.useFakeTimers();
    const onReload = vi.fn();
    render(<React.StrictMode><ThreadList {...props({ onReload })} /></React.StrictMode>);

    fireEvent.click(screen.getByTestId('mail-refresh'));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mail-refresh')).not.toBeDisabled();
  });

  it('reports a failed refresh instead of reloading', async () => {
    const onReload = vi.fn();
    h.refreshAccount.mockRejectedValue(new Error('nope'));
    render(<ThreadList {...props({ onReload })} />);

    fireEvent.click(screen.getByTestId('mail-refresh'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Could not check for new mail.', { type: 'error' }));
    expect(onReload).not.toHaveBeenCalled();
  });

  // The provider search files its hits and names the conversations they landed
  // in. Those hits are typically archived and typically matched on body text,
  // so re-running the LOCAL query would show nothing — the keys are what the
  // list has to be handed. (That mismatch is why "search the whole mailbox"
  // reported finds and then displayed an empty list.)
  it('hands a server search\'s thread keys to the list rather than re-running the local query', async () => {
    h.searchServer.mockResolvedValue({ count: 3, threadKeys: ['tk-9', 'tk-8'] });
    const onServerResults = vi.fn();
    const onReload = vi.fn();
    render(<ThreadList {...props({ threads: [], q: 'shingle', onServerResults, onReload })} />);

    fireEvent.click(screen.getByRole('button', { name: /Search the whole mailbox/i }));
    await waitFor(() => expect(h.searchServer).toHaveBeenCalledWith('a1', 'shingle'));
    await waitFor(() => expect(onServerResults).toHaveBeenCalledWith(['tk-9', 'tk-8']));
    expect(h.toast).toHaveBeenCalledWith('Found 3 messages on the server.');
    expect(onReload).not.toHaveBeenCalled();
  });

  it('falls back to a plain reload when the mailbox search matched nothing', async () => {
    h.searchServer.mockResolvedValue({ count: 0, threadKeys: [] });
    const onServerResults = vi.fn();
    const onReload = vi.fn();
    render(<ThreadList {...props({ threads: [], q: 'shingle', onServerResults, onReload })} />);

    fireEvent.click(screen.getByRole('button', { name: /Search the whole mailbox/i }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(onServerResults).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('No matching mail on the server.');
  });

  it('shows the mailbox search working and does not fire it twice', async () => {
    type Hits = { count: number; threadKeys: string[] };
    let finish: (r: Hits) => void = () => {};
    h.searchServer.mockReturnValue(new Promise<Hits>(r => { finish = r; }));
    render(<ThreadList {...props({ threads: [], q: 'shingle' })} />);

    const button = screen.getByRole('button', { name: /Search the whole mailbox/i });
    fireEvent.click(button);
    const busy = await screen.findByRole('button', { name: 'Searching…' });
    expect(busy).toBeDisabled();

    fireEvent.click(busy);
    await act(async () => { finish({ count: 0, threadKeys: [] }); });
    expect(h.searchServer).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith('No matching mail on the server.');
  });

  // Local results are not all results: Gmail matches body text and archived
  // mail the local index never sees, so the escape hatch has to stay reachable
  // when the local query DID match something.
  it('offers the mailbox search alongside local results too', () => {
    render(<ThreadList {...props({ q: 'shingle' })} />);
    expect(screen.getByRole('button', { name: /Search the whole mailbox/i })).toBeInTheDocument();
  });

  describe('server-results mode', () => {
    it('banners the result count and clears back to the normal list', () => {
      const onClearServerResults = vi.fn();
      render(<ThreadList {...props({ q: 'shingle', serverResultCount: 4, onClearServerResults })} />);

      const banner = screen.getByTestId('mail-server-results-banner');
      expect(banner).toHaveTextContent('Showing 4 results from the full mailbox');
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(onClearServerResults).toHaveBeenCalledTimes(1);
    });

    it('singularises one result', () => {
      render(<ThreadList {...props({ q: 'shingle', serverResultCount: 1 })} />);
      expect(screen.getByTestId('mail-server-results-banner')).toHaveTextContent('Showing 1 result from the full mailbox');
    });

    it('drops the folder-scoped footer and the search-again button while it is showing', () => {
      render(<ThreadList {...props({ q: 'shingle', serverResultCount: 2, indexedSince: '2026-02-01T00:00:00.000Z' })} />);
      expect(screen.queryByText(/Showing mail since/)).toBeNull();
      expect(screen.queryByRole('button', { name: /Search the whole mailbox/i })).toBeNull();
    });

    it('shows no banner in the normal folder view', () => {
      render(<ThreadList {...props()} />);
      expect(screen.queryByTestId('mail-server-results-banner')).toBeNull();
    });
  });

  // Piece 2: hand-rolled windowing for big folders (>150 rows). No
  // react-window — see ThreadList.tsx's header comment.
  //
  // Row height is two-tier (rowHeightPx / ROW_HEIGHT_LINKED_PX for a thread
  // with link chips), so the slice math works off `rowOffsets` — real
  // per-row cumulative heights — rather than a uniform estimate. All-plain
  // (no links) fixtures below reduce to the same numbers a single ROW_HEIGHT_PX
  // would have produced, which is what proves the general (offsets-based)
  // math didn't change behavior for the common case; the "mixed heights"
  // block below is what actually exercises the two-tier part.
  describe('rowHeightPx / rowOffsets', () => {
    it('is the plain height for a thread with no links, and the taller one for a thread with any', () => {
      expect(rowHeightPx(row({ links: [] }))).toBe(ROW_HEIGHT_PX);
      expect(rowHeightPx(row({ links: [{ id: 'l1', itemType: 'rfi', itemId: 'r1', label: 'RFI-001' } as any] }))).toBe(ROW_HEIGHT_LINKED_PX);
    });

    it('sums per-row heights, not a uniform one, for a mix of plain and linked rows', () => {
      const linked = { id: 'l1', itemType: 'rfi', itemId: 'r1', label: 'RFI-001' } as any;
      const rows = [
        row({ threadKey: 'a', links: [] }),
        row({ threadKey: 'b', links: [] }),
        row({ threadKey: 'c', links: [linked] }),
        row({ threadKey: 'd', links: [] }),
      ];
      expect(rowOffsets(rows)).toEqual([
        0,
        ROW_HEIGHT_PX,
        ROW_HEIGHT_PX * 2,
        ROW_HEIGHT_PX * 2 + ROW_HEIGHT_LINKED_PX,
        ROW_HEIGHT_PX * 2 + ROW_HEIGHT_LINKED_PX + ROW_HEIGHT_PX,
      ]);
    });
  });

  describe('visibleRowRange (slice math)', () => {
    const uniformOffsets = (n: number, h: number = ROW_HEIGHT_PX): number[] =>
      Array.from({ length: n + 1 }, (_, i) => i * h);

    it('renders everything when the viewport or row count is not yet known', () => {
      expect(visibleRowRange(uniformOffsets(500), 0, 0)).toEqual({ start: 0, end: 500 });
      expect(visibleRowRange(uniformOffsets(0), 0, 800)).toEqual({ start: 0, end: 0 });
    });

    it('starts at row 0 with overscan clamped, not negative, at the top of the list', () => {
      const { start, end } = visibleRowRange(uniformOffsets(500), 0, 760, 8);
      expect(start).toBe(0);
      // 760px / 76px = 10 rows on screen, + 8 rows of trailing overscan.
      expect(end).toBe(18);
    });

    it('slides the window forward as scrollTop increases', () => {
      // 50 rows scrolled past (50 * 76 = 3800), minus 8 rows of leading overscan.
      const { start, end } = visibleRowRange(uniformOffsets(500), 3800, 760, 8);
      expect(start).toBe(42);
      expect(end).toBe(68);
    });

    it('clamps the end of the window to the row count near the bottom of the list', () => {
      const { start, end } = visibleRowRange(uniformOffsets(60), 3800, 760, 8);
      expect(start).toBe(42);
      expect(end).toBe(60);
    });

    it('uses the real constants the component windows with', () => {
      const { start, end } = visibleRowRange(uniformOffsets(1000), 0, ROW_HEIGHT_PX * 10);
      expect(start).toBe(0);
      expect(end).toBe(18); // 10 rows on screen + 8 overscan, default overscan.
    });

    // Review finding 2 (fix round 1): a folder heavy with link chips renders
    // taller rows than ROW_HEIGHT_PX — using that as a uniform estimate would
    // undercount how far the user has actually scrolled (dividing a real
    // scrollTop by too-small a row height overshoots the row index) and skip
    // rows that are still on screen. These fixed offsets stand in for 5 rows
    // that are ALL linked (96px each: 0, 96, 192, 288, 384, 480).
    describe('mixed/linked heights at a scroll boundary', () => {
      const linkedOffsets = [0, 96, 192, 288, 384, 480];

      it('locates the true first-on-screen row from real offsets, not a uniform-height guess', () => {
        // scrollTop=380 sits inside row 3's true span (288..384) — a naive
        // 76px/row estimate would compute floor(380/76)=5 and skip rows 3-4
        // even though they are still (partly) visible.
        const { start, end } = visibleRowRange(linkedOffsets, 380, 96, 0);
        expect(start).toBe(3);
        expect(end).toBe(5);
      });

      it('keeps overscan in ROWS, applied after the true index is found', () => {
        const { start, end } = visibleRowRange(linkedOffsets, 380, 96, 2);
        expect(start).toBe(1); // 3 - 2
        expect(end).toBe(5);   // clamped to rowCount
      });
    });
  });

  describe('windowing threshold and scroll behavior', () => {
    const manyRows = (n: number): ThreadListRow[] =>
      Array.from({ length: n }, (_, i) => row({ threadKey: `tk-${i}`, subject: `Thread ${i}` }));

    it('renders every row directly at or below the threshold — no spacers', () => {
      const threads = manyRows(VIRTUALIZE_THRESHOLD);
      render(<ThreadList {...props({ threads })} />);
      expect(screen.getAllByTestId('mail-thread-row')).toHaveLength(VIRTUALIZE_THRESHOLD);
      expect(screen.queryByTestId('mail-list-top-spacer')).toBeNull();
      expect(screen.queryByTestId('mail-list-bottom-spacer')).toBeNull();
    });

    it('windows the list once past the threshold — fewer rows in the DOM than in the folder', () => {
      const threads = manyRows(VIRTUALIZE_THRESHOLD + 1);
      render(<ThreadList {...props({ threads })} />);
      const rendered = screen.getAllByTestId('mail-thread-row').length;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(threads.length);
      // The very first row is inside the initial (scrollTop 0) window…
      expect(screen.getByText('Thread 0')).toBeInTheDocument();
      // …but a row deep in the folder is not yet mounted.
      expect(screen.queryByText(`Thread ${threads.length - 1}`)).toBeNull();
      expect(screen.getByTestId('mail-list-bottom-spacer')).toBeInTheDocument();
    });

    it('shifts which rows are mounted as the list scrolls, and preserves selection/unread state', () => {
      const threads = manyRows(300);
      const { container } = render(<ThreadList {...props({ threads, selectedKey: 'tk-0' })} />);

      expect(screen.getByText('Thread 0')).toBeInTheDocument();
      const firstRow = screen.getAllByTestId('mail-thread-row')[0];
      expect(firstRow).toHaveAttribute('data-selected', 'true');
      expect(firstRow).toHaveAttribute('data-unread', 'true');

      const scrollEl = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      fireEvent.scroll(scrollEl, { target: { scrollTop: 3800 } });

      // The top of the folder has scrolled out of the window…
      expect(screen.queryByText('Thread 0')).toBeNull();
      // …and a row from around the new scroll position has mounted in.
      expect(screen.getByText('Thread 55')).toBeInTheDocument();
      expect(screen.getByTestId('mail-list-top-spacer')).toBeInTheDocument();
    });

    // Review finding 2: a folder where every OTHER row carries a link chip
    // (taller) still windows correctly end to end — no NaN/undefined spacer
    // heights, DOM count still well below the folder size.
    it('windows correctly through the real component when rows alternate plain/linked height', () => {
      const linked = { id: 'l1', itemType: 'rfi', itemId: 'r1', label: 'RFI-001' } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const threads = manyRows(300).map((r, i) => (i % 2 === 0 ? { ...r, links: [linked] } : r));
      const { container } = render(<ThreadList {...props({ threads })} />);

      const rendered = screen.getAllByTestId('mail-thread-row').length;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(threads.length);

      const topSpacer = screen.queryByTestId('mail-list-top-spacer');
      const bottomSpacer = screen.getByTestId('mail-list-bottom-spacer');
      if (topSpacer) expect(Number(topSpacer.getAttribute('style')?.match(/height:\s*(\d+)/)?.[1])).toBeGreaterThanOrEqual(0);
      expect(Number(bottomSpacer.getAttribute('style')?.match(/height:\s*(\d+)/)?.[1])).toBeGreaterThan(0);

      // Scroll past a run of taller (linked) rows and confirm the window still
      // shifts sanely — no crash, still fewer rows than the folder.
      const scrollEl = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      fireEvent.scroll(scrollEl, { target: { scrollTop: 6000 } });
      const afterScroll = screen.getAllByTestId('mail-thread-row').length;
      expect(afterScroll).toBeGreaterThan(0);
      expect(afterScroll).toBeLessThan(threads.length);
    });
  });
});
