// src/utils/billingDates.ts — the calendar day an invoice, change order,
// payment or pay app date stands for, and how it is shown.
//
// The billing editors store a day picked in an <input type="date"> as the
// epoch ms of `new Date('YYYY-MM-DD')`: UTC MIDNIGHT of that day. Shown in
// local time (`new Date(ms).toLocaleDateString()`) that is the evening before
// anywhere west of UTC, so a date picked as Oct 1 read Sep 30 across the US.
// Pay app dates (periodTo, applicationDate) and report days are 'YYYY-MM-DD'
// text. Not every stored date is a picked day, though: a payment recorded
// without one is stamped Date.now() by the server, and older data carries such
// instants too — read in UTC, one from a US evening is a day late. So:
//   - 'YYYY-MM-DD' text is that day;
//   - a timestamp exactly at UTC midnight is a picked day: its UTC date;
//   - any other timestamp is a real moment: its local date.
// A date input is filled back with the same day, so opening an editor never
// moves the date. Nothing here changes what is stored. The server's reports
// (reportsStore) use it too, where "local" is the server's own zone.
import { DAY } from './time';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local Date as 'YYYY-MM-DD'. */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Today on the local calendar as 'YYYY-MM-DD' — what a new date input starts at. */
export const todayDay = (): string => ymd(new Date());

/** 'YYYY-MM-DD' as a local Date (midnight), or null. */
export function parseDay(day: string | null | undefined): Date | null {
  const m = day ? DAY_RE.exec(day) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A day in the viewer's date format; '—' when there is none. */
export const formatDay = (day: string | null | undefined): string => parseDay(day)?.toLocaleDateString() ?? '—';

/** The calendar day ('YYYY-MM-DD') a stored billing date stands for — also
 *  what its date input is filled with — or null when there is none. */
export function billingDay(date: number | string | null | undefined): string | null {
  if (date == null || date === '') return null;
  if (typeof date === 'string' && DAY_RE.test(date)) return date;
  const d = new Date(typeof date === 'number' ? date : Date.parse(date));
  const ms = d.getTime();
  if (Number.isNaN(ms)) return null;
  return ms % DAY === 0 ? d.toISOString().slice(0, 10) : ymd(d);
}

/** A stored billing date in the viewer's date format; '—' when there is none. */
export const formatBillingDate = (date: number | string | null | undefined): string => formatDay(billingDay(date));
