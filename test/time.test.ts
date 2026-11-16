import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarMonths,
  formatLocal,
  isValidTimeZone,
  localDateKey,
  localInputToUtc,
  localToUtc,
  utcToLocalInput,
  zonedParts,
} from '../shared/time.js';

const TZ = 'Europe/Amsterdam';

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
  assert.match(formatLocal('2026-03-29T12:30:00.000Z', TZ), /29 Mar 2026.*14:30/);
  assert.equal(formatLocal('2026-03-29T12:30:00.000Z', TZ, 'time'), '14:30');
  assert.match(formatLocal('2026-03-29T12:30:00.000Z', TZ, 'day'), /Sunday.*29 March/);
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
