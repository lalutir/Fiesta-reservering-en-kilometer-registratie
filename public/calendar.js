// Calendar maths for the Agenda views (Day, 3 days, Week, Month): date keys ('YYYY-MM-DD'),
// the range a view shows, the month grid, stepping with Previous and Next, and which local days
// a reservation touches. Pure functions, no DOM and no texts, so they are tested on their own
// (test/calendar.test.ts) and the view (views/agenda.js) only has to draw.
//
// A date key is a calendar date, not an instant: adding days to it is plain calendar arithmetic,
// so a day with 23 or 25 hours (the DST changes) is still one day. Only the step from an instant
// to the key of its local day (localDateKey) needs the household time zone, and that comes from
// shared/time.js, the same file the server uses. Keys compare correctly as strings.
import { addCalendarMonths, daysInMonth, formatLocal, localDateKey } from '../shared/time.js';

/** @typedef {'list' | 'day' | '3days' | 'week' | 'month'} ViewName */
/** @typedef {{ min: string, max: string }} KeyWindow first and last day that can be shown (inclusive) */
/** @typedef {{ view: ViewName, anchor: string }} CalendarState the view and the day it is anchored on */

/** The views in the order of the switcher; List is the default and has no date. */
export const VIEWS = /** @type {const} */ (['list', 'day', '3days', 'week', 'month']);

const DAY_MS = 86_400_000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @param {number} n @param {number} [width] */
const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * Split a date key into numbers. Null when it is not a real calendar date (2026-02-30, garbage).
 * @param {unknown} key
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseKey(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/**
 * parseKey for a key that has to be valid.
 * @param {string} key
 */
function requireKey(key) {
  const p = parseKey(key);
  if (!p) throw new RangeError(`Not a date key: ${key}`);
  return p;
}

/** @param {number} year @param {number} month 1-12 @param {number} day */
const keyOf = (year, month, day) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/**
 * The key `days` calendar days after (or before, when negative) a valid key.
 * @param {string} key
 * @param {number} days
 * @returns {string}
 */
export function shiftKey(key, days) {
  const p = requireKey(key);
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * DAY_MS);
  return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Monday is 0 and Sunday is 6 (weeks start on Monday).
 * @param {string} key
 */
export function weekdayIndex(key) {
  const p = requireKey(key);
  return (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
}

/** The Monday of the week that holds the key. @param {string} key */
export function weekStartKey(key) {
  return shiftKey(key, -weekdayIndex(key));
}

/** The first day of the month that holds the key. @param {string} key */
export function monthStartKey(key) {
  const p = requireKey(key);
  return keyOf(p.year, p.month, 1);
}

/** The last day of the month that holds the key. @param {string} key */
export function monthEndKey(key) {
  const p = requireKey(key);
  return keyOf(p.year, p.month, daysInMonth(p.year, p.month));
}

/**
 * The same day in another month; a day that does not exist there is moved back to the last
 * day of that month (31 Jan + 1 month = 28 Feb, or 29 Feb in a leap year).
 * @param {string} key
 * @param {number} months may be negative
 */
export function addMonthsKey(key, months) {
  const p = requireKey(key);
  const index = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (((index % 12) + 12) % 12) + 1;
  return keyOf(year, month, Math.min(p.day, daysInMonth(year, month)));
}

/**
 * Every key from `from` to `to`, both included (empty when `to` is before `from`).
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function keysBetween(from, to) {
  /** @type {string[]} */
  const out = [];
  for (let key = from; key <= to; key = shiftKey(key, 1)) out.push(key);
  return out;
}

/**
 * The first and last day a view shows when it is anchored on a day. Month is the whole calendar month
 * (the grid also shows the days of the neighbouring months around it, see monthGrid).
 * @param {Exclude<ViewName, 'list'>} view
 * @param {string} anchor
 * @returns {{ from: string, to: string }}
 */
export function viewRange(view, anchor) {
  switch (view) {
    case 'day':
      return { from: anchor, to: anchor };
    case '3days':
      return { from: anchor, to: shiftKey(anchor, 2) };
    case 'week': {
      const from = weekStartKey(anchor);
      return { from, to: shiftKey(from, 6) };
    }
    case 'month':
      return { from: monthStartKey(anchor), to: monthEndKey(anchor) };
  }
}

/**
 * The weeks of the month grid: rows of 7 keys, Monday first, from the Monday on or before the 1st to
 * the Sunday on or after the last day. 4 to 6 rows.
 * @param {string} anchor any day of the month
 * @returns {string[][]}
 */
export function monthGrid(anchor) {
  const first = weekStartKey(monthStartKey(anchor));
  const last = shiftKey(weekStartKey(monthEndKey(anchor)), 6);
  const days = keysBetween(first, last);
  /** @type {string[][]} */
  const rows = [];
  for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
  return rows;
}

/**
 * The first and last local day of the window (six months back and ahead) in the household zone.
 * @param {Date | number | string} now
 * @param {string} tz
 * @param {number} months
 * @returns {KeyWindow}
 */
export function windowKeys(now, tz, months) {
  return { min: localDateKey(addCalendarMonths(now, -months, tz), tz), max: localDateKey(addCalendarMonths(now, months, tz), tz) };
}

/** @param {string} key @param {KeyWindow} win */
export const clampKey = (key, win) => (key < win.min ? win.min : key > win.max ? win.max : key);

/**
 * The view and day from the hash query (#/?view=week&date=2026-11-16). Anything unknown or malformed
 * falls back: no or an unknown view is the list, no or a malformed date is today, a date outside the
 * window is moved to the nearest day inside it.
 * @param {URLSearchParams | null | undefined} query
 * @param {string} today key of the local day of now
 * @param {KeyWindow} win
 * @returns {CalendarState}
 */
export function parseCalendar(query, today, win) {
  const asked = query?.get('view') ?? '';
  const view = /** @type {ViewName} */ (VIEWS.find((v) => v === asked) ?? 'list');
  const date = query?.get('date') ?? '';
  const anchor = parseKey(date) ? date : today;
  return { view, anchor: clampKey(anchor, win) };
}

/**
 * Where Previous (-1) or Next (+1) goes from here, and whether there is anything to see there: a step is
 * disabled when the period it leads to lies completely outside the window. A step that only partly
 * lies outside is allowed and lands on the nearest day of the window.
 * @param {Exclude<ViewName, 'list'>} view
 * @param {string} anchor
 * @param {-1 | 1} direction
 * @param {KeyWindow} win
 * @returns {{ key: string, disabled: boolean }}
 */
export function stepTarget(view, anchor, direction, win) {
  const raw = view === 'month' ? addMonthsKey(anchor, direction) : shiftKey(anchor, direction * (view === 'day' ? 1 : view === '3days' ? 3 : 7));
  const range = viewRange(view, raw);
  const disabled = direction < 0 ? range.to < win.min : range.from > win.max;
  return { key: clampKey(raw, win), disabled };
}

/**
 * The hash for a view and day. The list has no date.
 * @param {ViewName} view
 * @param {string} anchor
 */
export function calendarHash(view, anchor) {
  return view === 'list' ? '#/' : `#/?view=${view}&date=${anchor}`;
}

/**
 * The local days a reservation touches, limited to [fromKey, toKey]. It ends at `end`, so the last
 * moment it occupies is a millisecond earlier: a reservation that ends exactly at midnight does not
 * count for the next day. Only the visible range is walked, however long the reservation is.
 * @param {{ start: string, end: string }} r
 * @param {string} tz
 * @param {string} fromKey
 * @param {string} toKey
 * @returns {string[]}
 */
export function reservationDays(r, tz, fromKey, toKey) {
  const first = localDateKey(r.start, tz);
  const lastMoment = Date.parse(r.end) - 1;
  const lastKey = Number.isFinite(lastMoment) ? localDateKey(lastMoment, tz) : first;
  const last = lastKey < first ? first : lastKey;
  return keysBetween(first < fromKey ? fromKey : first, last > toKey ? toKey : last);
}

/** A calendar date as an instant that is the same date in every zone (noon UTC), for labels. @param {string} key */
function noon(key) {
  const p = requireKey(key);
  return Date.UTC(p.year, p.month - 1, p.day, 12);
}

/**
 * A date key as text: 'day' is "Monday 16 November", 'date' is "16 Nov 2026".
 * @param {string} key
 * @param {'day' | 'date'} kind
 */
export function keyLabel(key, kind) {
  return formatLocal(noon(key), 'UTC', kind);
}

const monthFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });

/** "November 2026" for the month that holds the key. @param {string} key */
export function monthLabel(key) {
  return monthFormatter.format(new Date(noon(key)));
}
