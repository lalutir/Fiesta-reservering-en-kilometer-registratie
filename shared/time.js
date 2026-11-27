// @ts-check
// Time-zone, DST and calendar-month helpers shared by the server (imported as
// ../shared/time.js) and the browser (served at /shared/time.js).
// All instants are exchanged as UTC ISO strings with milliseconds and a "Z"
// suffix (e.g. 2026-03-29T01:30:00.000Z), which sort lexicographically.
//
// DST rules: a wall-clock time inside a spring-forward gap resolves FORWARD
// (it is read with the offset that was valid before the gap), and a wall-clock
// time that occurs twice in autumn resolves to the EARLIER instant.

/** @typedef {Date | number | string} Instant */
/**
 * @typedef {object} Parts
 * @property {number} year
 * @property {number} month 1-12
 * @property {number} day 1-31
 * @property {number} hour 0-23
 * @property {number} minute 0-59
 * @property {number} second 0-59
 * @property {number} ms 0-999
 */

const DAY_MS = 86_400_000;

/** @type {Map<string, Intl.DateTimeFormat>} */
const partFormatters = new Map();

/** @param {string} tz */
function partFormatter(tz) {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partFormatters.set(tz, f);
  }
  return f;
}

/**
 * @param {string} tz
 * @returns {boolean}
 */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Instant} instant
 * @returns {number} epoch milliseconds (NaN when invalid)
 */
export function toMs(instant) {
  if (instant instanceof Date) return instant.getTime();
  if (typeof instant === 'number') return instant;
  return Date.parse(instant);
}

/**
 * @param {number} ms
 * @returns {string}
 */
function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Wall-clock parts of an instant in a time zone.
 * @param {Instant} instant
 * @param {string} tz
 * @returns {Parts}
 */
export function zonedParts(instant, tz) {
  const t = toMs(instant);
  if (!Number.isFinite(t)) throw new RangeError('Invalid instant');
  /** @type {Record<string, number>} */
  const v = {};
  for (const p of partFormatter(tz).formatToParts(new Date(t))) {
    if (p.type !== 'literal') v[p.type] = Number(p.value);
  }
  return {
    year: v['year'] ?? 0,
    month: v['month'] ?? 0,
    day: v['day'] ?? 0,
    hour: (v['hour'] ?? 0) % 24,
    minute: v['minute'] ?? 0,
    second: v['second'] ?? 0,
    ms: ((t % 1000) + 1000) % 1000,
  };
}

/**
 * Offset (wall clock minus UTC) in milliseconds at an instant.
 * @param {number} t
 * @param {string} tz
 */
function offsetAt(t, tz) {
  const p = zonedParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
  return asUtc - t;
}

/**
 * Convert a wall-clock time in a zone to the UTC instant.
 * @param {{year: number, month: number, day: number, hour?: number, minute?: number, second?: number, ms?: number}} parts
 * @param {string} tz
 * @returns {string} UTC ISO string
 */
export function localToUtc(parts, tz) {
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.ms ?? 0,
  );
  if (!Number.isFinite(wall)) throw new RangeError('Invalid wall-clock time');
  const before = offsetAt(wall - DAY_MS, tz);
  const after = offsetAt(wall + DAY_MS, tz);
  const tBefore = wall - before;
  const tAfter = wall - after;
  const okBefore = offsetAt(tBefore, tz) === before;
  const okAfter = offsetAt(tAfter, tz) === after;
  if (okBefore && okAfter) return iso(Math.min(tBefore, tAfter)); // ambiguous: earlier
  if (okBefore) return iso(tBefore);
  if (okAfter) return iso(tAfter);
  return iso(tBefore); // gap: resolve forward using the pre-gap offset
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Add calendar months keeping the wall-clock time; the day is clamped to the
 * length of the target month (31 Aug - 6 months = 28 Feb).
 * @param {Instant} instant
 * @param {number} months may be negative
 * @param {string} tz
 * @returns {string} UTC ISO string
 */
export function addCalendarMonths(instant, months, tz) {
  const p = zonedParts(instant, tz);
  const index = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12 + 12) % 12 + 1;
  const day = Math.min(p.day, daysInMonth(year, month));
  return localToUtc({ year, month, day, hour: p.hour, minute: p.minute, second: p.second, ms: p.ms }, tz);
}

/**
 * 'YYYY-MM-DD' of the local calendar day containing the instant.
 * @param {Instant} instant
 * @param {string} tz
 */
export function localDateKey(instant, tz) {
  return dateKey(zonedParts(instant, tz));
}

/** @param {Parts} p */
function dateKey(p) {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * @param {number} n
 * @param {number} [width]
 */
function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// ---- calendar dates ('YYYY-MM-DD': a day of the calendar, no time and no zone) -------------------------
// A date such as the day a dent was noticed or the APK expiry is not an instant: it means the same day
// for everybody, so it is kept as text and counted with UTC arithmetic (a day is always one step, DST
// never enters). Only "what day is it now" needs the household zone, and that is localDateKey().

/**
 * Epoch ms of midnight UTC on a calendar day. Unlike Date.UTC this takes years 0 to 99 as themselves.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
function utcDay(year, month, day) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getTime();
}

/**
 * Strictly 'YYYY-MM-DD' and a day that exists (no 2026-02-30, 2027-02-29, month 13, 2026-1-5, trailing
 * text or a time). This is the one place that decides what a calendar date is.
 * @param {unknown} text
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseDateKey(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const back = new Date(utcDay(year, month, day));
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function isCalendarDate(text) {
  return parseDateKey(text) !== null;
}

/**
 * Whole calendar days from one date to another (negative when `toKey` is earlier). Counted in UTC, so the
 * 23 and 25 hour days around a clock change are one day like any other.
 * @param {string} fromKey 'YYYY-MM-DD'
 * @param {string} toKey 'YYYY-MM-DD'
 * @returns {number}
 */
export function daysBetween(fromKey, toKey) {
  const a = parseDateKey(fromKey);
  const b = parseDateKey(toKey);
  if (!a || !b) throw new RangeError('Invalid calendar date');
  return Math.round((utcDay(b.year, b.month, b.day) - utcDay(a.year, a.month, a.day)) / DAY_MS);
}

/**
 * The same day and month `years` later, the day clamped to the length of the month (29 Feb + 1 year = 28 Feb).
 * @param {string} key 'YYYY-MM-DD'
 * @param {number} years may be negative
 * @returns {string}
 */
export function addDateKeyYears(key, years) {
  const p = parseDateKey(key);
  if (!p) throw new RangeError('Invalid calendar date');
  const year = p.year + years;
  return `${pad(year, 4)}-${pad(p.month)}-${pad(Math.min(p.day, daysInMonth(year, p.month)))}`;
}

/**
 * The UTC instant at which a calendar day begins in a zone (local 00:00; a midnight that does not exist
 * resolves forward, like any other wall-clock time here).
 * @param {string} key 'YYYY-MM-DD'
 * @param {string} tz
 * @returns {string} UTC ISO string
 */
export function startOfLocalDay(key, tz) {
  const p = parseDateKey(key);
  if (!p) throw new RangeError('Invalid calendar date');
  return localToUtc({ year: p.year, month: p.month, day: p.day }, tz);
}

/**
 * A calendar date for people ("14 mrt 2026"), the same in every zone: it is formatted at noon UTC in UTC.
 * @param {string} key 'YYYY-MM-DD'
 * @param {'date' | 'day'} [kind] 'date' = "14 mrt 2026", 'day' = "zaterdag 14 maart"
 * @returns {string} '' when the key is not a calendar date
 */
export function formatDateKey(key, kind = 'date') {
  const p = parseDateKey(key);
  if (!p) return '';
  return displayFormatter('UTC', kind).format(new Date(utcDay(p.year, p.month, p.day) + DAY_MS / 2));
}

// ---- calendar months ('YYYY-MM': a month of the household calendar, the unit of the statistics) -----------

/**
 * 'YYYY-MM' of the local calendar month that contains the instant. The month is the household's, not UTC's:
 * a drive that starts at 00:30 local time on the 1st belongs to the new month although it is still the old
 * month in UTC.
 * @param {Instant} instant
 * @param {string} tz
 * @returns {string}
 */
export function monthKeyOf(instant, tz) {
  const p = zonedParts(instant, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}`;
}

/**
 * Strictly 'YYYY-MM' with a month from 01 to 12 in the years 2000 to 2100 (the same years as every other date
 * the app accepts). This is the one place that decides what a month key is.
 * @param {unknown} text
 * @returns {{ year: number, month: number } | null}
 */
export function parseMonthKey(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [year, month] = [Number(m[1]), Number(m[2])];
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * The month `months` after (or before, when negative) a month key.
 * @param {string} key 'YYYY-MM'
 * @param {number} months
 * @returns {string}
 */
export function addMonthKey(key, months) {
  const p = parseMonthKey(key);
  if (!p) throw new RangeError('Invalid month');
  const index = p.year * 12 + (p.month - 1) + months;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12 + 12) % 12 + 1)}`;
}

/**
 * A month for people: 'long' = "november 2026", 'short' = "nov 26". The same in every zone (it is formatted at
 * noon UTC on the 15th in UTC).
 * @param {string} key 'YYYY-MM'
 * @param {'long' | 'short'} [kind]
 * @returns {string} '' when the key is not a month
 */
export function formatMonthKey(key, kind = 'long') {
  const p = parseMonthKey(key);
  if (!p) return '';
  return displayFormatter('UTC', kind === 'short' ? 'monthShort' : 'month').format(new Date(Date.UTC(p.year, p.month - 1, 15, 12)));
}

/**
 * Combine the value of an <input type="date"> and <input type="time"> that are
 * interpreted in the household zone into a UTC ISO string.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} timeStr 'HH:MM'
 * @param {string} tz
 * @returns {string | null} null when the inputs are not valid
 */
export function localInputToUtc(dateStr, timeStr, tz) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr ?? '');
  const t = /^(\d{2}):(\d{2})$/.exec(timeStr ?? '');
  if (!d || !t) return null;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute] = [Number(t[1]), Number(t[2])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59) return null;
  return localToUtc({ year, month, day, hour, minute }, tz);
}

/**
 * Split an instant into the values for date and time inputs in a zone.
 * @param {Instant} instant
 * @param {string} tz
 * @returns {{date: string, time: string}}
 */
export function utcToLocalInput(instant, tz) {
  const p = zonedParts(instant, tz);
  return { date: dateKey(p), time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/**
 * The language of every date and time shown to people (the interface is Dutch only): 24-hour clock, lower-case
 * weekday and month names ("maandag 16 november", "16 nov 2026, 14:05"). The en-US formatters above only read
 * numeric parts and must not follow this. Used by the browser calendar as well.
 */
export const DISPLAY_LOCALE = 'nl-NL';

/** @type {Map<string, Intl.DateTimeFormat>} */
const displayFormatters = new Map();

/**
 * @param {string} tz
 * @param {'datetime' | 'date' | 'time' | 'day' | 'month' | 'monthShort'} kind
 */
function displayFormatter(tz, kind) {
  const key = `${tz}|${kind}`;
  let f = displayFormatters.get(key);
  if (!f) {
    /** @type {Intl.DateTimeFormatOptions} */
    const o = { timeZone: tz, hourCycle: 'h23' };
    if (kind === 'datetime') Object.assign(o, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    else if (kind === 'date') Object.assign(o, { day: 'numeric', month: 'short', year: 'numeric' });
    else if (kind === 'day') Object.assign(o, { weekday: 'long', day: 'numeric', month: 'long' });
    else if (kind === 'month') Object.assign(o, { month: 'long', year: 'numeric' });
    else if (kind === 'monthShort') Object.assign(o, { month: 'short', year: '2-digit' });
    else Object.assign(o, { hour: '2-digit', minute: '2-digit' });
    f = new Intl.DateTimeFormat(DISPLAY_LOCALE, o);
    displayFormatters.set(key, f);
  }
  return f;
}

/**
 * Human readable local time. kind: 'datetime' (default), 'date', 'time', 'day'.
 * @param {Instant} instant
 * @param {string} tz
 * @param {'datetime' | 'date' | 'time' | 'day'} [kind]
 * @returns {string}
 */
export function formatLocal(instant, tz, kind = 'datetime') {
  const t = toMs(instant);
  if (!Number.isFinite(t)) return '';
  return displayFormatter(tz, kind).format(new Date(t));
}
