// src/pages/mail/compose/RecipientsField.tsx — one addressee row (To / Cc / Bcc)
// in the composer: committed addresses render as pills, the trailing input takes
// free text, and typing queries the server's recipient index.
//
// Two rules shape the interaction, both learned from mail clients people
// already use:
//  - Anything that reads as an address commits: Enter, comma/semicolon, Tab,
//    blur, or a pasted list. Text that does not parse is *kept in the input*
//    and marked invalid rather than silently dropped.
//  - The suggestion list never commits on its own. Enter sends the typed text
//    unless the user has explicitly arrowed onto a suggestion, so a fast typist
//    is never redirected to whoever the server happened to rank first.
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { mailApi } from '../../../utils/mailApi';
import type { Addr, Recipient } from '../types';

export const SUGGEST_DEBOUNCE_MS = 150;

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** `Bob <bob@acme.com>` / `bob@acme.com` → Addr; anything else → null. */
export function parseAddr(raw: string): Addr | null {
  const text = (raw ?? '').trim().replace(/,$/, '').trim();
  if (!text) return null;

  const angled = text.match(/^(.*?)<([^>]+)>$/);
  if (angled) {
    const addr = angled[2].trim();
    if (!EMAIL_RE.test(addr)) return null;
    const name = angled[1].trim().replace(/^["']|["']$/g, '').trim();
    return name ? { addr, name } : { addr };
  }

  return EMAIL_RE.test(text) ? { addr: text } : null;
}

const key = (a: Addr): string => (a.addr ?? '').trim().toLowerCase();

/** Appends `extra` to `base`, skipping addresses already present. */
export function mergeAddrs(base: Addr[], extra: Addr[]): Addr[] {
  const seen = new Set(base.map(key));
  const out = [...base];
  for (const a of extra) {
    const k = key(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export interface RecipientsFieldProps {
  label: 'To' | 'Cc' | 'Bcc';
  value: Addr[];
  onChange: (v: Addr[]) => void;
  autoFocus?: boolean;
  /** Fires with the uncommitted input text so a parent can react to it —
   *  the composer uses it to enable Send for a typed-but-unconfirmed address. */
  onPendingChange?: (text: string) => void;
}

export interface RecipientsFieldHandle {
  /** Commits parseable leftover input text and returns what it committed.
   *  Called on Send so a typed address is never silently dropped. */
  commitPending: () => Addr[];
}

export const RecipientsField = React.forwardRef<RecipientsFieldHandle, RecipientsFieldProps>((
  { label, value, onChange, autoFocus, onPendingChange },
  ref,
) => {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [suggestions, setSuggestions] = useState<Recipient[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const listId = React.useId();

  const pendingCb = useRef(onPendingChange);
  pendingCb.current = onPendingChange;
  useEffect(() => { pendingCb.current?.(text); }, [text]);

  // Sources of the addresses the user picked from the index, so a customer
  // contact keeps its tint after it becomes a pill (Addr itself has no source).
  const [sources, setSources] = useState<Record<string, string>>({});

  const commit = useCallback((addrs: Addr[]): boolean => {
    const next = mergeAddrs(value, addrs);
    if (next.length !== value.length) onChange(next);
    return true;
  }, [value, onChange]);

  /** Parses the input text into addresses, or null if any part doesn't parse. */
  const parseText = (raw: string): Addr[] | null => {
    const parts = raw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return [];
    const parsed = parts.map(parseAddr);
    return parsed.some(a => a === null) ? null : (parsed as Addr[]);
  };

  /** Commits the input text; returns false (leaving the text alone) if it doesn't parse. */
  const commitText = useCallback((raw: string): boolean => {
    const parsed = parseText(raw);
    if (parsed === null) { setInvalid(true); return false; }
    if (parsed.length === 0) { setText(''); setInvalid(false); return true; }

    commit(parsed);
    setText('');
    setInvalid(false);
    setSuggestions([]);
    setHighlight(-1);
    return true;
  }, [commit]);

  useImperativeHandle(ref, () => ({
    commitPending: () => {
      const parsed = parseText(text);
      if (!parsed || parsed.length === 0) return [];
      commit(parsed);
      setText('');
      setInvalid(false);
      setSuggestions([]);
      setHighlight(-1);
      return parsed;
    },
  }), [text, commit]);

  const pick = useCallback((r: Recipient) => {
    setSources(prev => ({ ...prev, [key(r)]: r.source }));
    commit([r.name ? { addr: r.addr, name: r.name } : { addr: r.addr }]);
    setText('');
    setInvalid(false);
    setSuggestions([]);
    setHighlight(-1);
  }, [commit]);

  // Debounced lookup. The request id guards against an older, slower response
  // landing after a newer one and repainting stale suggestions.
  const reqId = useRef(0);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 1) { setSuggestions([]); setHighlight(-1); return; }

    const mine = ++reqId.current;
    const t = setTimeout(() => {
      mailApi.recipients(q)
        .then(rows => {
          if (reqId.current !== mine) return;
          setSuggestions(Array.isArray(rows) ? rows : []);
          setHighlight(-1);
        })
        .catch(() => { if (reqId.current === mine) setSuggestions([]); });
    }, SUGGEST_DEBOUNCE_MS);

    return () => clearTimeout(t);
  }, [text]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setHighlight(i => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setHighlight(i => (i <= 0 ? suggestions.length - 1 : i - 1));
      return;
    }
    if (e.key === 'Escape' && suggestions.length) {
      setSuggestions([]);
      setHighlight(-1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (highlight >= 0 && suggestions[highlight]) {
        e.preventDefault();
        pick(suggestions[highlight]);
        return;
      }
      if (!text.trim()) return;              // Tab with an empty input still moves focus.
      e.preventDefault();
      commitText(text);
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (/[,;]/.test(raw)) {
      // A separator means "that one's done" — commit the completed parts and
      // leave any trailing fragment in the input to keep typing.
      const parts = raw.split(/[,;]/);
      const tail = parts.pop() ?? '';
      const done = parts.map(s => s.trim()).filter(Boolean);
      const parsed = done.map(parseAddr);
      if (parsed.length && parsed.every(a => a !== null)) {
        commit(parsed as Addr[]);
        setText(tail);
        setInvalid(false);
        return;
      }
    }
    setText(raw);
    if (invalid) setInvalid(false);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData?.getData('text') ?? '';
    if (!/[,;]/.test(pasted)) return;
    const parts = pasted.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const good = parts.map(parseAddr).filter((a): a is Addr => a !== null);
    if (!good.length) return;
    e.preventDefault();
    commit(good);
    // Anything that didn't parse stays in the input for the user to fix
    // rather than disappearing into a pasted blob.
    const rest = parts.filter(s => parseAddr(s) === null);
    setText(rest.join(', '));
    setInvalid(rest.length > 0);
  };

  /** Contacts that came from the app's own records read differently from
   *  "someone you mailed once", so they carry the accent tint. */
  const tinted = (a: Addr): boolean => {
    const src = sources[key(a)];
    return !!src && src !== 'recent';
  };

  return (
    <div className="flex items-start gap-2 border-b border-edge py-1.5">
      <span aria-hidden="true" className="w-10 shrink-0 pt-1.5 text-xs font-medium text-ink-faint">{label}</span>

      <div className="relative min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          {value.map(a => (
            <span
              key={key(a)}
              data-testid="recipient-pill"
              className={
                'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs ' +
                (tinted(a)
                  ? 'bg-accent-100 text-accent-800 dark:bg-accent-500/20 dark:text-accent-200'
                  : 'bg-sunken text-ink')
              }
            >
              <span className="min-w-0 truncate">{a.name ? `${a.name} · ${a.addr}` : a.addr}</span>
              <button
                type="button"
                aria-label={`Remove ${a.addr}`}
                className="shrink-0 opacity-60 hover:opacity-100"
                onClick={() => onChange(value.filter(x => key(x) !== key(a)))}
              >
                <X size={12} />
              </button>
            </span>
          ))}

          <input
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-autocomplete="list"
            aria-controls={suggestions.length ? listId : undefined}
            autoFocus={autoFocus}
            value={text}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            // A blur that lands on a suggestion is handled by the option's own
            // mousedown, which fires first and clears the list.
            onBlur={() => { if (text.trim()) commitText(text); }}
            className={
              'min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-1 text-sm text-ink outline-none placeholder:text-ink-faint ' +
              (invalid ? 'text-red-600 dark:text-red-400' : '')
            }
          />
        </div>

        {suggestions.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            className="absolute left-0 top-full z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-edge bg-raised py-1 shadow-lg"
          >
            {suggestions.map((r, i) => (
              <li
                key={`${r.addr}-${i}`}
                role="option"
                aria-selected={i === highlight}
                // mousedown, not click: the input's blur would otherwise commit
                // (or discard) the typed text before the click ever lands.
                onMouseDown={e => { e.preventDefault(); pick(r); }}
                className={`cursor-pointer px-2 py-1.5 text-sm ${i === highlight ? 'bg-hover' : ''}`}
              >
                <span className="text-ink">{r.name || r.addr}</span>
                {r.name && <span className="ml-1.5 text-xs text-ink-faint">{r.addr}</span>}
                {r.role && <span className="ml-1.5 text-xs text-ink-faint">· {r.role}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
RecipientsField.displayName = 'RecipientsField';
