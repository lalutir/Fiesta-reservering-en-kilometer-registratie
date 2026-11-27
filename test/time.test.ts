import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPLAY_LOCALE,
  addCalendarMonths,
  addDateKeyYears,
  addMonthKey,
  daysBetween,
  formatDateKey,
  formatLocal,
  formatMonthKey,
  isCalendarDate,
  isValidTimeZone,
  localDateKey,
  localInputToUtc,
  localToUtc,
  monthKeyOf,
  parseDateKey,
  parseMonthKey,
  startOfLocalDay,
  utcToLocalInput,
  zonedParts,
} from '../shared/time.js';

const TZ = 'Europe/Amsterdam';

test('dates are shown in Dutch for the household zone, on a 24-hour clock, and the numeric part reader is untouched', () => {
  assert.equal(DISPLAY_LOCALE, 'nl-NL');
  const at = '2026-11-16T13:05:00.000Z';
  // The exact output is pinned for the pinned runtime (Node 22.23, full ICU); the checks in test/dutch.test.ts fail loudly without ICU.
  assert.equal(formatLocal(at, TZ, 'datetime'), '16 nov 2026, 14:05');
  assert.equal(formatLocal(at, TZ, 'day'), 'maandag 16 november');
  assert.equal(formatLocal(at, TZ, 'date'), '16 nov 2026');
  assert.equal(formatLocal(at, TZ, 'time'), '14:05');
  assert.equal(formatLocal('2026-11-16T22:30:00.000Z', TZ, 'time'), '23:30', 'a 24-hour clock, not 11:30 PM');
  // Across both DST changes the clock reads the local wall time.
  assert.equal(formatLocal('2026-03-29T00:30:00.000Z', TZ, 'time'), '01:30', 'before the spring change');
  assert.equal(formatLocal('2026-03-29T01:30:00.000Z', TZ, 'time'), '03:30', 'after it: 02:30 does not exist');
  assert.equal(formatLocal('2026-10-25T00:30:00.000Z', TZ, 'time'), '02:30', 'the first 02:30 of the autumn change');
  assert.equal(formatLocal('2026-10-25T01:30:00.000Z', TZ, 'time'), '02:30', 'and the second one');
  // The parts that logic reads are numbers from the en-US formatter, whatever the display language is.
  assert.deepEqual(zonedParts(at, TZ), { year: 2026, month: 11, day: 16, hour: 14, minute: 5, second: 0, ms: 0 });
});

test('zonedParts reads wall clock in the zone', () => {
  assert.deepEqual(zonedParts('2026-07-01T10:15:30.250Z', TZ), {
    year: 2026,
    month: 7,
    day: 1,
    hour: 12,
    minute: 15,
    second: 30,
    ms: 250,
  });
  // Midnight must be hour 0, never 24.
  assert.equal(zonedParts('2026-01-01T23:00:00.000Z', TZ).hour, 0);
});

test('localToUtc: spring-forward gap resolves forward', () => {
  const out = localToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, TZ);
  assert.equal(out, '2026-03-29T01:30:00.000Z');
});

test('localToUtc: autumn ambiguity resolves to the earlier instant', () => {
  const out = localToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, TZ);
  assert.equal(out, '2026-10-25T00:30:00.000Z');
});

test('localToUtc: ordinary winter and summer times', () => {
  assert.equal(localToUtc({ year: 2026, month: 1, day: 15, hour: 9 }, TZ), '2026-01-15T08:00:00.000Z');
  assert.equal(localToUtc({ year: 2026, month: 7, day: 15, hour: 9 }, TZ), '2026-07-15T07:00:00.000Z');
});

test('localToUtc: times right around the transitions are unambiguous', () => {
  assert.equal(localToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 59 }, TZ), '2026-03-29T00:59:00.000Z');
  assert.equal(localToUtc({ year: 2026, month: 3, day: 29, hour: 3, minute: 0 }, TZ), '2026-03-29T01:00:00.000Z');
  assert.equal(localToUtc({ year: 2026, month: 10, day: 25, hour: 3, minute: 0 }, TZ), '2026-10-25T02:00:00.000Z');
  assert.equal(localToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 59 }, TZ), '2026-10-24T23:59:00.000Z');
});

test('localToUtc works for zones west of UTC and with fixed offsets', () => {
  // America/New_York: 2026-03-08 02:30 does not exist; resolves forward.
  assert.equal(localToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'), '2026-03-08T07:30:00.000Z');
  assert.equal(localToUtc({ year: 2026, month: 6, day: 1, hour: 12 }, 'UTC'), '2026-06-01T12:00:00.000Z');
});

test('addCalendarMonths anchors from the plan', () => {
  assert.equal(addCalendarMonths('2026-10-25T12:00:00.000Z', -6, TZ), '2026-04-25T11:00:00.000Z');
  assert.equal(addCalendarMonths('2026-03-10T09:00:00.000Z', -6, TZ), '2025-09-10T08:00:00.000Z');
  assert.equal(addCalendarMonths('2026-08-31T10:00:00.000Z', -6, TZ), '2026-02-28T11:00:00.000Z');
  assert.equal(addCalendarMonths('2026-08-31T10:00:00.000Z', 6, TZ), '2027-02-28T11:00:00.000Z');
});

test('addCalendarMonths crosses year boundaries and clamps leap days', () => {
  assert.equal(addCalendarMonths('2026-03-15T12:00:00.000Z', -6, TZ), '2025-09-15T11:00:00.000Z');
  assert.equal(addCalendarMonths('2026-11-15T12:00:00.000Z', 6, TZ), '2027-05-15T11:00:00.000Z');
  assert.equal(addCalendarMonths('2028-08-31T10:00:00.000Z', 6, TZ), '2029-02-28T11:00:00.000Z');
  assert.equal(addCalendarMonths('2027-08-31T10:00:00.000Z', 6, TZ), '2028-02-29T11:00:00.000Z');
  assert.equal(addCalendarMonths('2026-01-31T10:00:00.000Z', 1, TZ), '2026-02-28T10:00:00.000Z');
  assert.equal(addCalendarMonths('2026-01-31T10:00:00.000Z', -13, TZ), '2024-12-31T10:00:00.000Z');
});

test('addCalendarMonths keeps milliseconds and handles a landing in a DST gap', () => {
  assert.equal(addCalendarMonths('2026-10-29T01:30:00.123Z', -7, TZ), '2026-03-29T01:30:00.123Z');
});

test('localDateKey follows the zone', () => {
  assert.equal(localDateKey('2026-06-30T22:30:00.000Z', TZ), '2026-07-01');
  assert.equal(localDateKey('2026-06-30T21:59:59.999Z', TZ), '2026-06-30');
});

test('formatLocal renders in the zone', () => {
  assert.match(formatLocal('2026-03-29T12:30:00.000Z', TZ), /29 mrt 2026.*14:30/);
  assert.equal(formatLocal('2026-03-29T12:30:00.000Z', TZ, 'time'), '14:30');
  assert.match(formatLocal('2026-03-29T12:30:00.000Z', TZ, 'day'), /zondag 29 maart/);
  assert.equal(formatLocal('not a date', TZ), '');
});

test('localInputToUtc and utcToLocalInput round trip', () => {
  assert.equal(localInputToUtc('2026-07-15', '09:30', TZ), '2026-07-15T07:30:00.000Z');
  assert.deepEqual(utcToLocalInput('2026-07-15T07:30:00.000Z', TZ), { date: '2026-07-15', time: '09:30' });
  for (const iso of ['2026-01-15T08:00:00.000Z', '2026-03-29T01:30:00.000Z', '2026-12-31T23:59:00.000Z']) {
    const { date, time } = utcToLocalInput(iso, TZ);
    assert.equal(localInputToUtc(date, time, TZ), iso);
  }
});

test('localInputToUtc rejects malformed or impossible input', () => {
  assert.equal(localInputToUtc('', '09:30', TZ), null);
  assert.equal(localInputToUtc('2026-02-30', '09:30', TZ), null);
  assert.equal(localInputToUtc('2026-13-01', '09:30', TZ), null);
  assert.equal(localInputToUtc('2026-01-01', '24:00', TZ), null);
  assert.equal(localInputToUtc('2026-01-01', '9:30', TZ), null);
  assert.equal(localInputToUtc('2026-01-01', '09:60', TZ), null);
});

test('isValidTimeZone', () => {
  assert.equal(isValidTimeZone('Europe/Amsterdam'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
});

// ------------------------------------------------------------ calendar dates ('YYYY-MM-DD')

test('parseDateKey accepts exactly the days that exist, in exactly one shape', () => {
  assert.deepEqual(parseDateKey('2026-03-28'), { year: 2026, month: 3, day: 28 });
  assert.deepEqual(parseDateKey('2028-02-29'), { year: 2028, month: 2, day: 29 }, 'a leap day');
  assert.deepEqual(parseDateKey('2000-02-29'), { year: 2000, month: 2, day: 29 }, 'divisible by 400: a leap year');
  assert.deepEqual(parseDateKey('2026-12-31'), { year: 2026, month: 12, day: 31 });
  assert.deepEqual(parseDateKey('2026-04-30'), { year: 2026, month: 4, day: 30 });
  assert.deepEqual(parseDateKey('0004-02-29'), { year: 4, month: 2, day: 29 }, 'years below 100 are themselves, not 1900 plus');
  for (const bad of [
    '2027-02-29', // not a leap year
    '2100-02-29', // divisible by 100 but not 400
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-1-5',
    '26-01-05',
    '2026/01/05',
    '2026-01-05T00:00:00.000Z',
    '2026-01-05 ',
    ' 2026-01-05',
    '2026-01-05\n',
    '20260105',
    '',
    'tomorrow',
  ]) {
    assert.equal(parseDateKey(bad), null, JSON.stringify(bad));
    assert.equal(isCalendarDate(bad), false, JSON.stringify(bad));
  }
  for (const notText of [null, undefined, 20260105, {}, [], true]) assert.equal(parseDateKey(notText), null);
  assert.equal(isCalendarDate('2028-02-29'), true);
});

test('daysBetween counts calendar days, the same on a 23 and a 25 hour day', () => {
  assert.equal(daysBetween('2026-03-28', '2026-03-28'), 0);
  assert.equal(daysBetween('2026-03-28', '2026-03-29'), 1, 'the spring-forward day (23 hours in Amsterdam)');
  assert.equal(daysBetween('2026-03-29', '2026-03-30'), 1);
  assert.equal(daysBetween('2026-10-25', '2026-10-26'), 1, 'the autumn day (25 hours in Amsterdam)');
  assert.equal(daysBetween('2026-10-24', '2026-10-27'), 3);
  assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365);
  assert.equal(daysBetween('2028-01-01', '2029-01-01'), 366, 'a leap year');
  assert.equal(daysBetween('2026-03-10', '2026-03-01'), -9, 'negative: already past');
  assert.equal(daysBetween('2000-01-01', '2100-12-31'), 36_889);
  assert.throws(() => daysBetween('2026-02-30', '2026-03-01'), RangeError);
  assert.throws(() => daysBetween('2026-03-01', 'x'), RangeError);
});

test('addDateKeyYears keeps the day and clamps it to the length of the month', () => {
  assert.equal(addDateKeyYears('2026-03-28', 5), '2031-03-28');
  assert.equal(addDateKeyYears('2028-02-29', 1), '2029-02-28', '29 Feb plus a year is 28 Feb');
  assert.equal(addDateKeyYears('2028-02-29', 4), '2032-02-29', 'plus four years is a leap day again');
  assert.equal(addDateKeyYears('2026-12-31', -1), '2025-12-31');
  assert.equal(addDateKeyYears('2028-02-29', 0), '2028-02-29');
  assert.throws(() => addDateKeyYears('2026-02-30', 1), RangeError);
});

test('startOfLocalDay is local midnight, 23 and 25 hour days included', () => {
  assert.equal(startOfLocalDay('2026-06-15', TZ), '2026-06-14T22:00:00.000Z', 'summer time: UTC+2');
  assert.equal(startOfLocalDay('2026-01-15', TZ), '2026-01-14T23:00:00.000Z', 'winter time: UTC+1');
  assert.equal(startOfLocalDay('2026-03-29', TZ), '2026-03-28T23:00:00.000Z', 'the day of the spring change starts at +1');
  assert.equal(startOfLocalDay('2026-03-30', TZ), '2026-03-29T22:00:00.000Z', 'and the next one at +2: the day before it was 23 hours long');
  assert.equal(startOfLocalDay('2026-10-25', TZ), '2026-10-24T22:00:00.000Z');
  assert.equal(startOfLocalDay('2026-10-26', TZ), '2026-10-25T23:00:00.000Z', 'the 25 hour day ended at +1');
  assert.equal(startOfLocalDay('2026-06-15', 'UTC'), '2026-06-15T00:00:00.000Z');
  assert.equal(startOfLocalDay('2026-06-15', 'America/Los_Angeles'), '2026-06-15T07:00:00.000Z');
  assert.throws(() => startOfLocalDay('2026-02-30', TZ), RangeError);
});

test('formatDateKey names the same day for everybody', () => {
  assert.equal(formatDateKey('2026-03-28'), '28 mrt 2026');
  assert.equal(formatDateKey('2028-02-29'), '29 feb 2028');
  assert.equal(formatDateKey('2026-03-28', 'day'), 'zaterdag 28 maart');
  assert.equal(formatDateKey('2026-02-30'), '', 'not a date: nothing to show');
});

test('the date helpers give the same answers whatever the zone of the process is', () => {
  // Only UTC arithmetic and an explicit zone are used, never the machine's own zone.
  const saved = process.env['TZ'];
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Europe/Amsterdam']) {
      process.env['TZ'] = tz;
      assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2, tz);
      assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2, tz);
      assert.equal(formatDateKey('2026-03-28'), '28 mrt 2026', tz);
      assert.equal(startOfLocalDay('2026-03-29', TZ), '2026-03-28T23:00:00.000Z', tz);
      assert.equal(localDateKey('2026-03-27T23:30:00.000Z', TZ), '2026-03-28', tz);
    }
  } finally {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  }
});

// ------------------------------------------------------------ calendar months (statistics)

test("a month is the household's local calendar month: the edges sit at local midnight, also on the 23 and 25 hour days", () => {
  // 31 March 23:59:59.999 local is still March; the next millisecond is April (CEST has been on since the 29th).
  assert.equal(monthKeyOf('2026-03-31T21:59:59.999Z', TZ), '2026-03');
  assert.equal(monthKeyOf('2026-03-31T22:00:00.000Z', TZ), '2026-04');
  // 31 October 23:59:59.999 local is CET (UTC+1): the autumn edge sits an hour later in UTC.
  assert.equal(monthKeyOf('2026-10-31T22:59:59.999Z', TZ), '2026-10');
  assert.equal(monthKeyOf('2026-10-31T23:00:00.000Z', TZ), '2026-11');
  // The spring-forward day (23 hours) and the fall-back day (25 hours) are inside one month each.
  assert.equal(monthKeyOf('2026-03-29T00:30:00.000Z', TZ), '2026-03');
  assert.equal(monthKeyOf('2026-10-25T01:30:00.000Z', TZ), '2026-10');
  // Year rollover.
  assert.equal(monthKeyOf('2026-12-31T22:59:59.999Z', TZ), '2026-12');
  assert.equal(monthKeyOf('2026-12-31T23:00:00.000Z', TZ), '2027-01');
});

test('the same instant is another month in a zone east or west of Amsterdam', () => {
  assert.equal(monthKeyOf('2026-03-31T22:00:00.000Z', 'Pacific/Auckland'), '2026-04');
  assert.equal(monthKeyOf('2026-03-31T22:00:00.000Z', 'America/Los_Angeles'), '2026-03');
  assert.equal(monthKeyOf('2026-03-31T18:29:00.000Z', 'Asia/Kolkata'), '2026-03');
  assert.equal(monthKeyOf('2026-03-31T18:30:00.000Z', 'Asia/Kolkata'), '2026-04', 'a half-hour zone: local midnight is not on a UTC hour');
});

test('parseMonthKey is strict and addMonthKey does calendar arithmetic', () => {
  assert.deepEqual(parseMonthKey('2026-11'), { year: 2026, month: 11 });
  assert.deepEqual(parseMonthKey('2000-01'), { year: 2000, month: 1 });
  assert.deepEqual(parseMonthKey('2100-12'), { year: 2100, month: 12 });
  for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', ' 2026-11', '2026-11 ', '1999-12', '2101-01', '', null, undefined, 202611, '2026/11']) {
    assert.equal(parseMonthKey(bad), null, String(bad));
  }
  assert.equal(addMonthKey('2026-01', -1), '2025-12');
  assert.equal(addMonthKey('2026-12', 1), '2027-01');
  assert.equal(addMonthKey('2026-11', -23), '2024-12');
  assert.equal(addMonthKey('2026-11', 0), '2026-11');
  assert.equal(addMonthKey('2026-06', 36), '2029-06');
  assert.throws(() => addMonthKey('2026-13', 1), RangeError);
});

test('a month is written in Dutch, the same in every zone', () => {
  assert.equal(formatMonthKey('2026-11'), 'november 2026');
  assert.equal(formatMonthKey('2026-03', 'short'), 'mrt 26');
  assert.equal(formatMonthKey('2026-01', 'short'), 'jan 26');
  assert.equal(formatMonthKey('2026-13'), '', 'not a month: nothing to show');
  const saved = process.env['TZ'];
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env['TZ'] = tz;
      assert.equal(formatMonthKey('2026-03'), 'maart 2026', tz);
    }
  } finally {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  }
});
