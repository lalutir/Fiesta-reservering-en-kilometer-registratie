// The Agenda views: List (the default, as it always was), Day, 3 days, Week and Month.
// First the pure date maths of public/calendar.js (DST days, month ends, the six-month window, which
// local days a reservation touches), then the real view code against the fake DOM
// (test/fake-dom.ts): the switcher, Previous / Today / Next, every view and what it leaves out.
// What the fake DOM cannot show (layout at 390 and 320 px, contrast, tap size) stays with the headless
// browser pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIEWS,
  addMonthsKey,
  calendarHash,
  clampKey,
  keyLabel,
  keysBetween,
  monthEndKey,
  monthGrid,
  monthLabel,
  monthStartKey,
  parseCalendar,
  parseKey,
  reservationDays,
  shiftKey,
  stepTarget,
  viewRange,
  weekStartKey,
  weekdayIndex,
  windowKeys,
} from '../public/calendar.js';
import { h } from '../public/dom.js';
import { S } from '../public/strings.js';
import { render } from '../public/views/agenda.js';
import { ANNA, NOW, Reply, TZ, all, makeApp, one, reservation, until, withClient, type FakeElement, type Routes } from './fake-dom.ts';
import type { Json } from './helpers.ts';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ------------------------------------------------------------ the pure maths

test('parseKey: only real calendar dates are keys', () => {
  assert.deepEqual(parseKey('2026-11-16'), { year: 2026, month: 11, day: 16 });
  assert.deepEqual(parseKey('2028-02-29'), { year: 2028, month: 2, day: 29 }, 'a leap day');
  for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-31', '2026-2-3', '20261116', '', 'garbage', null, undefined, 20261116]) {
    assert.equal(parseKey(bad), null, String(bad));
  }
});

test('shiftKey: plain calendar days across month, year and leap ends, and across the DST changes', () => {
  assert.equal(shiftKey('2026-01-31', 1), '2026-02-01');
  assert.equal(shiftKey('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftKey('2028-02-28', 1), '2028-02-29', 'leap day');
  assert.equal(shiftKey('2028-02-28', 2), '2028-03-01');
  assert.equal(shiftKey('2026-03-28', 1), '2026-03-29');
  assert.equal(shiftKey('2026-03-28', 2), '2026-03-30', 'the 23-hour day is still one day');
  assert.equal(shiftKey('2026-10-24', 2), '2026-10-26', 'and so is the 25-hour day');
  assert.equal(shiftKey('2026-11-16', 0), '2026-11-16');
  assert.equal(shiftKey('2026-11-16', 366), '2027-11-17');
  assert.throws(() => shiftKey('2026-02-30', 1), RangeError);
});

test('weeks start on Monday', () => {
  assert.equal(weekdayIndex('2026-11-16'), 0, 'a Monday');
  assert.equal(weekdayIndex('2026-11-22'), 6, 'a Sunday');
  assert.equal(weekStartKey('2026-11-16'), '2026-11-16');
  assert.equal(weekStartKey('2026-11-18'), '2026-11-16');
  assert.equal(weekStartKey('2026-11-22'), '2026-11-16', 'Sunday belongs to the week before it');
  assert.equal(weekStartKey('2026-01-01'), '2025-12-29', 'across the year');
  assert.equal(weekStartKey('2026-03-29'), '2026-03-23', 'the Sunday of the spring DST change');
});

test('month start and end, also in a leap year and in December', () => {
  assert.equal(monthStartKey('2026-11-16'), '2026-11-01');
  assert.equal(monthEndKey('2026-11-16'), '2026-11-30');
  assert.equal(monthEndKey('2028-02-15'), '2028-02-29');
  assert.equal(monthEndKey('2027-02-01'), '2027-02-28');
  assert.equal(monthEndKey('2026-12-10'), '2026-12-31');
  assert.equal(monthStartKey('2026-12-31'), '2026-12-01');
});

test('addMonthsKey: the same day in another month, moved back to the last day when it does not exist there', () => {
  assert.equal(addMonthsKey('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsKey('2028-01-31', 1), '2028-02-29', 'leap year');
  assert.equal(addMonthsKey('2026-12-15', 1), '2027-01-15', 'over the year end');
  assert.equal(addMonthsKey('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonthsKey('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonthsKey('2026-03-31', 12), '2027-03-31');
  assert.equal(addMonthsKey('2026-08-31', -6), '2026-02-28');
  assert.equal(addMonthsKey('2026-11-16', 0), '2026-11-16');
});

test('keysBetween: both ends included, empty when backwards', () => {
  assert.deepEqual(keysBetween('2026-11-29', '2026-12-01'), ['2026-11-29', '2026-11-30', '2026-12-01']);
  assert.deepEqual(keysBetween('2026-11-16', '2026-11-16'), ['2026-11-16']);
  assert.deepEqual(keysBetween('2026-11-17', '2026-11-16'), []);
});

test('viewRange: day, 3 days (the day and the two after it), week (maandag to zondag) and the whole month', () => {
  assert.deepEqual(viewRange('day', '2026-11-18'), { from: '2026-11-18', to: '2026-11-18' });
  assert.deepEqual(viewRange('3days', '2026-11-18'), { from: '2026-11-18', to: '2026-11-20' });
  assert.deepEqual(viewRange('3days', '2026-11-29'), { from: '2026-11-29', to: '2026-12-01' }, 'over a month end');
  assert.deepEqual(viewRange('week', '2026-11-18'), { from: '2026-11-16', to: '2026-11-22' });
  assert.deepEqual(viewRange('week', '2026-11-22'), { from: '2026-11-16', to: '2026-11-22' });
  assert.deepEqual(viewRange('week', '2026-03-29'), { from: '2026-03-23', to: '2026-03-29' }, 'the 23-hour zondag is the last day of its week');
  assert.deepEqual(viewRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(viewRange('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
});

test('monthGrid: rows of seven, maandag first, from the maandag on or before the 1st to the zondag on or after the last day', () => {
  const nov = monthGrid('2026-11-16');
  assert.equal(nov.length, 6, 'the 1st is a zondag and the 30th a maandag');
  assert.equal(nov[0]?.[0], '2026-10-26');
  assert.equal(nov[5]?.[6], '2026-12-06');
  const feb = monthGrid('2027-02-10');
  assert.equal(feb.length, 4, 'the 1st is a maandag and the 28th a zondag: exactly four rows');
  assert.equal(feb[0]?.[0], '2027-02-01');
  assert.equal(feb[3]?.[6], '2027-02-28');
  assert.equal(monthGrid('2026-02-10').length, 5);
  for (const rows of [nov, feb, monthGrid('2028-02-29'), monthGrid('2026-03-29'), monthGrid('2026-10-25')]) {
    for (const row of rows) {
      assert.equal(row.length, 7);
      assert.equal(weekdayIndex(row[0] as string), 0, 'every row starts on a Monday');
    }
    const flat = rows.flat();
    assert.deepEqual(flat, keysBetween(flat[0] as string, flat[flat.length - 1] as string), 'no day is missing or repeated, also over the DST changes');
  }
});

test('windowKeys: the first and last local day of the six-month window', () => {
  assert.deepEqual(windowKeys('2026-06-15T10:00:00.000Z', TZ, 6), { min: '2025-12-15', max: '2026-12-15' });
  assert.deepEqual(windowKeys('2026-08-31T10:00:00.000Z', TZ, 6), { min: '2026-02-28', max: '2027-02-28' }, 'a month end is clamped like the server does');
  // 22:30 UTC is already the next day in Amsterdam in summer.
  assert.deepEqual(windowKeys('2026-06-15T22:30:00.000Z', TZ, 6), { min: '2025-12-16', max: '2026-12-16' }, 'the local day, not the UTC day');
});

const WIN = { min: '2025-12-15', max: '2026-12-15' };
const TODAY = '2026-06-15';
const q = (s: string): URLSearchParams => new URLSearchParams(s);

test('parseCalendar: unknown view falls back to the list, a bad or missing date to today, a date outside the window to the nearest day inside', () => {
  assert.deepEqual(parseCalendar(q(''), TODAY, WIN), { view: 'list', anchor: TODAY });
  assert.deepEqual(parseCalendar(null, TODAY, WIN), { view: 'list', anchor: TODAY });
  assert.deepEqual(parseCalendar(undefined, TODAY, WIN), { view: 'list', anchor: TODAY });
  assert.deepEqual(parseCalendar(q('view=bogus&date=2026-07-01'), TODAY, WIN), { view: 'list', anchor: '2026-07-01' });
  assert.deepEqual(parseCalendar(q('view=WEEK'), TODAY, WIN), { view: 'list', anchor: TODAY }, 'case matters');
  for (const view of ['day', '3days', 'week', 'month']) {
    assert.deepEqual(parseCalendar(q(`view=${view}&date=2026-07-01`), TODAY, WIN), { view, anchor: '2026-07-01' }, view);
    assert.deepEqual(parseCalendar(q(`view=${view}`), TODAY, WIN), { view, anchor: TODAY }, `${view} without a date is today`);
  }
  for (const bad of ['garbage', '2026-02-30', '2026-13-01', '16-11-2026', '', '2026-1-1', '2026-07-01T10:00']) {
    assert.deepEqual(parseCalendar(q(`view=week&date=${encodeURIComponent(bad)}`), TODAY, WIN), { view: 'week', anchor: TODAY }, `date=${bad}`);
  }
  assert.deepEqual(parseCalendar(q('view=day&date=1999-01-01'), TODAY, WIN), { view: 'day', anchor: '2025-12-15' }, 'before the window');
  assert.deepEqual(parseCalendar(q('view=day&date=2100-01-01'), TODAY, WIN), { view: 'day', anchor: '2026-12-15' }, 'after the window');
  assert.deepEqual(parseCalendar(q('view=day&date=2025-12-15'), TODAY, WIN), { view: 'day', anchor: '2025-12-15' }, 'the first day is inside');
  assert.deepEqual(parseCalendar(q('view=day&date=2026-12-15'), TODAY, WIN), { view: 'day', anchor: '2026-12-15' }, 'the last day is inside');
  assert.deepEqual([...VIEWS], ['list', 'day', '3days', 'week', 'month']);
  assert.equal(clampKey('2026-01-01', WIN), '2026-01-01');
});

test('stepTarget: one day, three days, seven days or one month per step', () => {
  assert.deepEqual(stepTarget('day', '2026-06-15', 1, WIN), { key: '2026-06-16', disabled: false });
  assert.deepEqual(stepTarget('day', '2026-06-15', -1, WIN), { key: '2026-06-14', disabled: false });
  assert.deepEqual(stepTarget('3days', '2026-06-15', 1, WIN), { key: '2026-06-18', disabled: false });
  assert.deepEqual(stepTarget('3days', '2026-06-15', -1, WIN), { key: '2026-06-12', disabled: false });
  assert.deepEqual(stepTarget('week', '2026-06-17', 1, WIN), { key: '2026-06-24', disabled: false });
  assert.deepEqual(stepTarget('week', '2026-06-17', -1, WIN), { key: '2026-06-10', disabled: false });
  assert.deepEqual(stepTarget('month', '2026-06-15', 1, WIN), { key: '2026-07-15', disabled: false });
  assert.deepEqual(stepTarget('month', '2026-03-31', -1, WIN), { key: '2026-02-28', disabled: false }, 'the day is moved back to the end of a shorter month');
});

test('stepTarget: disabled when the period it leads to is completely outside the window, clamped when it is only partly outside', () => {
  // Days.
  assert.equal(stepTarget('day', '2025-12-15', -1, WIN).disabled, true, 'before the first day');
  assert.equal(stepTarget('day', '2025-12-16', -1, WIN).disabled, false);
  assert.equal(stepTarget('day', '2026-12-15', 1, WIN).disabled, true, 'after the last day');
  assert.equal(stepTarget('day', '2026-12-14', 1, WIN).disabled, false);
  // 3 days: stepping back from the second day still shows the first.
  assert.equal(stepTarget('3days', '2025-12-15', -1, WIN).disabled, true);
  assert.deepEqual(stepTarget('3days', '2025-12-17', -1, WIN), { key: '2025-12-15', disabled: false }, 'the range 12-14..12-16 still has two days inside');
  assert.deepEqual(stepTarget('3days', '2025-12-16', -1, WIN), { key: '2025-12-15', disabled: false }, 'lands on the first day, not before it');
  assert.equal(stepTarget('3days', '2026-12-14', 1, WIN).disabled, true, 'the next three days start after the last day');
  assert.deepEqual(stepTarget('3days', '2026-12-12', 1, WIN), { key: '2026-12-15', disabled: false }, 'the days 15 to 17 start on the last day');
  // Weeks: 2025-12-15 is a Monday and 2026-12-15 a Tuesday.
  assert.equal(stepTarget('week', '2025-12-15', -1, WIN).disabled, true);
  assert.deepEqual(stepTarget('week', '2025-12-22', -1, WIN), { key: '2025-12-15', disabled: false });
  assert.equal(stepTarget('week', '2026-12-15', 1, WIN).disabled, true, 'the next week starts on the 21st');
  assert.equal(stepTarget('week', '2026-12-08', 1, WIN).disabled, false, 'the week of the 14th is partly inside');
  // Months: the window ends on the 15th, so December 2026 is the last month and December 2025 the first.
  assert.equal(stepTarget('month', '2025-12-20', -1, WIN).disabled, true);
  assert.deepEqual(stepTarget('month', '2026-01-10', -1, WIN), { key: '2025-12-15', disabled: false }, 'december 2025 is partly inside');
  assert.equal(stepTarget('month', '2026-12-10', 1, WIN).disabled, true);
  assert.deepEqual(stepTarget('month', '2026-11-20', 1, WIN), { key: '2026-12-15', disabled: false }, 'december 2026 is partly inside; lands on the last day');
});

test('calendarHash: the list has no date, the others carry view and date', () => {
  assert.equal(calendarHash('list', '2026-06-15'), '#/');
  assert.equal(calendarHash('day', '2026-06-15'), '#/?view=day&date=2026-06-15');
  assert.equal(calendarHash('3days', '2026-06-15'), '#/?view=3days&date=2026-06-15');
  assert.equal(calendarHash('week', '2026-06-15'), '#/?view=week&date=2026-06-15');
  assert.equal(calendarHash('month', '2026-06-15'), '#/?view=month&date=2026-06-15');
  // What it writes, parseCalendar reads back.
  const back = parseCalendar(new URLSearchParams(calendarHash('week', '2026-06-17').split('?')[1]), TODAY, WIN);
  assert.deepEqual(back, { view: 'week', anchor: '2026-06-17' });
});

const span = (start: string, end: string) => ({ start, end });
const days = (r: { start: string; end: string }, from = '2020-01-01', to = '2030-12-31'): string[] => reservationDays(r, TZ, from, to);

test('reservationDays: every local day a reservation touches, and an end at exactly midnight does not touch the next day', () => {
  assert.deepEqual(days(span('2026-06-15T08:00:00.000Z', '2026-06-15T10:00:00.000Z')), ['2026-06-15']);
  assert.deepEqual(days(span('2026-06-15T20:00:00.000Z', '2026-06-16T08:00:00.000Z')), ['2026-06-15', '2026-06-16'], '22:00 to 10:00 local');
  assert.deepEqual(days(span('2026-06-15T20:00:00.000Z', '2026-06-15T22:00:00.000Z')), ['2026-06-15'], 'ends at 00:00 local on the 16th: still only the 15th');
  assert.deepEqual(days(span('2026-06-15T20:00:00.000Z', '2026-06-15T22:00:00.001Z')), ['2026-06-15', '2026-06-16'], 'a millisecond later it touches the 16th');
  assert.deepEqual(days(span('2026-06-15T10:00:00.000Z', '2026-06-18T10:00:00.000Z')), ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18']);
  // The local day, not the UTC day: 23:30 UTC is already the next day in Amsterdam in summer.
  assert.deepEqual(days(span('2026-06-15T23:30:00.000Z', '2026-06-16T00:30:00.000Z')), ['2026-06-16']);
});

test('reservationDays on the DST days: the 23-hour and the 25-hour day are one day each', () => {
  // 2026-03-29: clocks go forward at 02:00, so the local day lasts 23 hours (23:00Z the day before to 22:00Z).
  assert.deepEqual(days(span('2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z')), ['2026-03-29'], 'exactly the whole 23-hour day');
  assert.deepEqual(days(span('2026-03-28T22:00:00.000Z', '2026-03-29T22:00:00.000Z')), ['2026-03-28', '2026-03-29'], 'from 23:00 on the 28th to midnight');
  assert.deepEqual(days(span('2026-03-29T00:30:00.000Z', '2026-03-29T02:30:00.000Z')), ['2026-03-29'], 'across the gap (01:30 local to 04:30 local)');
  assert.deepEqual(days(span('2026-03-29T21:00:00.000Z', '2026-03-29T22:30:00.000Z')), ['2026-03-29', '2026-03-30']);
  // 2026-10-25: clocks go back at 03:00, so the local day lasts 25 hours (22:00Z the day before to 23:00Z).
  assert.deepEqual(days(span('2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z')), ['2026-10-25'], 'exactly the whole 25-hour day');
  assert.deepEqual(days(span('2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.001Z')), ['2026-10-25', '2026-10-26']);
  assert.deepEqual(days(span('2026-10-25T00:30:00.000Z', '2026-10-25T03:30:00.000Z')), ['2026-10-25'], 'across the repeated hour');
});

test('reservationDays is clipped to the range it is asked for, so a very long reservation never walks its whole span', () => {
  const long = span('2026-01-10T10:00:00.000Z', '2026-12-20T10:00:00.000Z');
  assert.deepEqual(days(long, '2026-06-14', '2026-06-20'), keysBetween('2026-06-14', '2026-06-20'), 'every day of the range');
  assert.deepEqual(days(long, '2026-01-01', '2026-01-10'), ['2026-01-10'], 'only the first day touches the range');
  assert.deepEqual(days(long, '2026-12-20', '2026-12-31'), ['2026-12-20']);
  assert.deepEqual(days(long, '2027-01-01', '2027-01-31'), [], 'after it ends');
  assert.deepEqual(days(long, '2025-12-01', '2026-01-09'), [], 'before it starts');
  // A reservation that "ends" in the year 2100 (nothing stops the data from saying so) is still cheap.
  const forever = span('2026-06-10T10:00:00.000Z', '2100-01-01T10:00:00.000Z');
  const started = Date.now();
  assert.equal(days(forever, '2026-06-15', '2026-06-21').length, 7);
  assert.ok(Date.now() - started < 1000, 'bounded by the visible range, not by the span');
  assert.deepEqual(days(span('2026-06-15T10:00:00.000Z', 'not a date'), '2026-06-01', '2026-06-30'), ['2026-06-15'], 'a broken end still shows the start day');
});

test('labels: a date key as text, independent of the household time zone', () => {
  assert.equal(keyLabel('2026-11-16', 'day'), 'maandag 16 november');
  assert.equal(keyLabel('2026-11-16', 'date'), '16 nov 2026');
  assert.equal(keyLabel('2026-03-29', 'day'), 'zondag 29 maart', 'the DST day has its own name');
  assert.equal(monthLabel('2026-11-16'), 'november 2026');
  assert.equal(monthLabel('2028-02-29'), 'februari 2028');
});

// ------------------------------------------------------------ the views

const at = (iso: string): string => new Date(iso).toISOString();
const item = (id: number, who: string, start: string, end: string, over: Json = {}): Json =>
  reservation({ id, userId: 10 + id, userName: who, createdBy: 10 + id, createdByName: who, start: at(start), end: at(end), ...over });

// NOW is Monday 15 June 2026, 12:00 in Amsterdam; the window runs from 2025-12-15 to 2026-12-15.
const ITEMS: Json[] = [
  reservation({ id: 1 }), // Anna, today 12:20 - 15:00 (confirmed)
  item(2, 'Ben', '2026-06-16T20:00:00.000Z', '2026-06-17T06:00:00.000Z'), // 22:00 on the 16th to 08:00 on the 17th
  item(3, 'Carla', '2026-06-18T08:00:00.000Z', '2026-06-18T10:00:00.000Z', { status: 'pending', suggestion: true, createdBy: ANNA.id, createdByName: 'Anna', can: { edit: false, cancel: true, approve: false, decline: false } }),
  item(4, 'Dora', '2026-06-16T08:00:00.000Z', '2026-06-16T10:00:00.000Z', { status: 'declined' }),
  item(5, 'Eva', '2026-06-17T08:00:00.000Z', '2026-06-17T10:00:00.000Z', { status: 'expired' }),
  item(6, 'Femke', '2026-06-20T08:00:00.000Z', '2026-06-23T08:00:00.000Z'), // 20 to 23 June
];

const routes = (items: Json[] = ITEMS, extra: Routes = {}): Routes => ({ 'GET /api/reservations': () => ({ items }), ...extra });
const show = async (query: string, me = makeApp(ANNA)) => ({ me, el: await render(me.app, { query: new URLSearchParams(query) }) });

const texts = (root: unknown, selector: string): string[] => all(root, selector).map((e) => e.textContent);
const cardsOf = (root: unknown, who: string): FakeElement[] => all(root, 'article.reservation').filter((c) => one(c, '.what').textContent === who);
const attr = (e: FakeElement, name: string): string | null => e.getAttribute(name);
const button = (root: unknown, label: string): FakeElement => {
  const found = all(root, 'button').find((b) => b.textContent === label);
  assert.ok(found, `no button "${label}"`);
  return found;
};
const shape = (root: unknown): string =>
  (root as FakeElement).descendants().map((e) => `${e.tagName}.${e.className}|${attr(e, 'aria-pressed')}|${attr(e, 'aria-label')}|${attr(e, 'aria-current')}|${e.disabled}|${e.textContent}`).join('\n');

test('no view in the address: the list, exactly as before, with the switcher above it', async () => {
  const past = item(8, 'Gerrit', '2026-06-10T08:00:00.000Z', '2026-06-10T10:00:00.000Z');
  await withClient({ now: NOW, routes: routes([...ITEMS, past]) }, async ({ dom }) => {
    for (const query of ['', 'view=list', 'view=nonsense', 'view=weekly&date=garbage&x=1']) {
      const { el } = await show(query);
      const page = dom.mount(el);
      assert.deepEqual(texts(page, 'h2'), [S.agenda.upcoming], `"${query}": one heading, the list's own`);
      assert.equal(all(page, '.cal-nav').length, 0, 'no Previous / Next in the list');
      assert.equal(all(page, '.cal-grid').length, 0);
      // The groups per day of what is coming (Anna's today, Ben's from the 16th, Carla, Femke), the Earlier box and the window note.
      assert.deepEqual(texts(page, 'section.day h3'), ['maandag 15 juni', 'dinsdag 16 juni', 'donderdag 18 juni', 'zaterdag 20 juni', 'woensdag 10 juni'], 'what is coming, then the Earlier box');
      assert.deepEqual(texts(page, 'details.earlier summary'), [`${S.agenda.past} (1)`]);
      assert.equal(one(page, 'details.earlier').querySelectorAll('article.reservation').length, 1);
      assert.equal(one(page, 'p.hint.center').textContent, S.agenda.windowNote(6));
      assert.equal(all(page, 'article.reservation').length, 5, 'the declined and the expired suggestion are not in the agenda');
      assert.ok(one(page, '.view-switch') === page.children[0], 'the switcher comes first');
      assert.equal(page.children[1]?.textContent, S.agenda.upcoming, 'and the list follows as before');
      dom.body.replaceChildren();
    }
  });
});

test('the list: the empty state and the window note are unchanged', async () => {
  await withClient({ now: NOW, routes: routes([]) }, async ({ dom }) => {
    const { el } = await show('');
    const page = dom.mount(el);
    assert.equal(one(page, '.empty p').textContent, S.agenda.nothingUpcoming);
    assert.equal(one(page, '.empty a').textContent, S.agenda.reserveCta);
    assert.equal(one(page, '.empty a').getAttribute('href'), '#/reserve');
    assert.equal(one(page, 'p.hint.center').textContent, S.agenda.windowNote(6));
    assert.equal(all(page, 'details.earlier').length, 0);
  });
});

test('the switcher: five labelled buttons in order, the current one marked with aria-pressed "true", the others "false"', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const order = ['list', 'day', '3days', 'week', 'month'];
    const labels = ['Lijst', 'Dag', '3 dagen', 'Week', 'Maand'];
    for (const [i, view] of order.entries()) {
      const { el } = await show(view === 'list' ? '' : `view=${view}&date=2026-06-17`);
      const page = dom.mount(el);
      const group = one(page, '.view-switch');
      assert.equal(attr(group, 'role'), 'group');
      assert.equal(attr(group, 'aria-label'), S.agenda.viewSwitchLabel);
      const buttons = all(group, 'button');
      assert.deepEqual(buttons.map((b) => b.textContent), labels);
      assert.deepEqual(buttons.map((b) => b.textContent), order.map((v) => S.agenda.views[v as keyof typeof S.agenda.views]));
      // h() would drop false and write true as an empty string: the attribute must be the words.
      assert.deepEqual(buttons.map((b) => attr(b, 'aria-pressed')), order.map((_, j) => (j === i ? 'true' : 'false')), view);
      assert.ok(buttons.every((b) => attr(b, 'type') === 'button'));
      dom.body.replaceChildren();
    }
  });
});

test('the switcher keeps the day: List opens #/, the others #/?view=..&date=..', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const week = await show('view=week&date=2026-06-17');
    const page = dom.mount(week.el);
    for (const [label, hash] of [
      ['Lijst', '#/'],
      ['Dag', '#/?view=day&date=2026-06-17'],
      ['3 dagen', '#/?view=3days&date=2026-06-17'],
      ['Week', '#/?view=week&date=2026-06-17'],
      ['Maand', '#/?view=month&date=2026-06-17'],
    ] as const) {
      await button(one(page, '.view-switch'), label).fire('click');
      assert.equal(week.me.navigated.at(-1), hash, label);
    }
    // From the list there is no date: today.
    const list = await show('');
    await button(one(list.el, '.view-switch'), 'Week').fire('click');
    assert.deepEqual(list.me.navigated, ['#/?view=week&date=2026-06-15']);
  });
});

test('Day: one day with its reservations, who, the time and whether it is confirmed, with the same actions as the list', async () => {
  await withClient({ now: NOW, routes: routes([...ITEMS], { 'DELETE /api/reservations/2': () => new Reply({}, 204) }) }, async ({ dom }) => {
    const { me, el } = await show('view=day&date=2026-06-16');
    const page = dom.mount(el);
    assert.deepEqual(texts(page, 'h2'), ['dinsdag 16 juni']);
    assert.equal(one(page, 'h2').className, 'cal-title');
    assert.equal(all(page, 'section.cal-day').length, 1);
    assert.equal(all(page, 'h3').length, 0, 'the single heading is the h2');
    const cards = all(page, 'article.reservation');
    assert.deepEqual(cards.map((c) => one(c, '.what').textContent), ['Ben'], 'Dora was declined and is not shown');
    const card = cards[0] as FakeElement;
    assert.equal(one(card, '.badge-status').textContent, S.status.confirmed, 'said in words, not only in a colour');
    assert.match(one(card, '.when').textContent, /22:00/);
    assert.match(one(card, '.when').textContent, /08:00/);
    // The same actions as in the list.
    assert.ok(all(card, 'a').some((a) => a.textContent === S.edit && attr(a, 'href') === '#/reserve/2'));
    await button(card, S.agenda.cancelReservation).fire('click');
    await until(() => me.toasts.length > 0, 'the cancel to be reported');
    assert.deepEqual(me.toasts, [{ message: S.agenda.cancelled, isError: false }]);
    assert.deepEqual(dom.confirms, [S.agenda.confirmCancel]);
    assert.equal(me.refreshes(), 1, 'the list is reloaded after an action');
  });
});

test('Day: today is named, an empty day says so, and Previous / Today / Next step one day', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const today = await show('view=day&date=2026-06-15');
    const page = dom.mount(today.el);
    assert.deepEqual(texts(page, 'h2'), [S.agenda.dayHeading('maandag 15 juni', true)]);
    assert.equal(cardsOf(page, S.meHead).length, 1, 'Anna sees her own as "me", like in the list');
    assert.deepEqual(texts(page, '.cal-nav button'), [S.agenda.prev, S.agenda.today, S.agenda.next]);
    assert.deepEqual(all(page, '.cal-nav button').map((b) => attr(b, 'aria-label')), [S.agenda.stepLabel.prev.day, null, S.agenda.stepLabel.next.day]);
    await button(page, S.agenda.prev).fire('click');
    await button(page, S.agenda.today).fire('click');
    await button(page, S.agenda.next).fire('click');
    assert.deepEqual(today.me.navigated, ['#/?view=day&date=2026-06-14', '#/?view=day&date=2026-06-15', '#/?view=day&date=2026-06-16']);

    const empty = await show('view=day&date=2026-06-19');
    const quiet = dom.mount(empty.el);
    assert.equal(all(quiet, 'article.reservation').length, 0);
    assert.deepEqual(texts(quiet, 'section.cal-day p.hint'), [S.agenda.nothingThisDay]);
    assert.equal(texts(quiet, 'h2')[0], 'vrijdag 19 juni', 'not today: no "(vandaag)"');
  });
});

test('3 days: the day and the two after it, a reservation over midnight on both its days, a suggestion marked as waiting', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const { me, el } = await show('view=3days&date=2026-06-16');
    const page = dom.mount(el);
    assert.deepEqual(texts(page, 'h2'), [S.agenda.range('16 jun 2026', '18 jun 2026')]);
    assert.deepEqual(texts(page, 'section.cal-day h3'), ['dinsdag 16 juni', 'woensdag 17 juni', 'donderdag 18 juni']);
    const sections = all(page, 'section.cal-day');
    const who = (s: FakeElement): string[] => all(s, '.what').map((e) => e.textContent);
    assert.deepEqual(sections.map(who), [['Ben'], ['Ben'], ['Carla']], 'Dora (declined) and Eva (expired) are not shown');
    // The suggestion says it is waiting, in words, and offers what the list offers (withdraw, because Anna made it).
    const carla = cardsOf(page, 'Carla')[0] as FakeElement;
    assert.equal(one(carla, '.badge-status').textContent, S.status.pending);
    assert.ok(all(carla, 'button').some((b) => b.textContent === S.agenda.withdraw));
    assert.equal(one(carla, '.sub').textContent, S.agenda.suggestedFor('Carla'));

    assert.deepEqual(texts(page, '.cal-nav button'), [S.agenda.prev, S.agenda.today, S.agenda.next]);
    await button(page, S.agenda.prev).fire('click');
    await button(page, S.agenda.next).fire('click');
    await button(page, S.agenda.today).fire('click');
    assert.deepEqual(me.navigated, ['#/?view=3days&date=2026-06-13', '#/?view=3days&date=2026-06-19', '#/?view=3days&date=2026-06-15']);
  });
});

test('Week: Monday to Sunday, a long reservation on each of its days, empty days say so, today is named', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const { me, el } = await show('view=week&date=2026-06-17');
    const page = dom.mount(el);
    assert.deepEqual(texts(page, 'h2'), [S.agenda.range('15 jun 2026', '21 jun 2026')]);
    assert.deepEqual(texts(page, 'section.cal-day h3'), [
      S.agenda.dayHeading('maandag 15 juni', true),
      'dinsdag 16 juni',
      'woensdag 17 juni',
      'donderdag 18 juni',
      'vrijdag 19 juni',
      'zaterdag 20 juni',
      'zondag 21 juni',
    ]);
    assert.ok(one(page, 'section.cal-day').className.split(' ').includes('today'));
    const perDay = all(page, 'section.cal-day').map((s) => all(s, '.what').map((e) => e.textContent));
    assert.deepEqual(perDay, [[S.meHead], ['Ben'], ['Ben'], ['Carla'], [], ['Femke'], ['Femke']], 'Femke\'s 20 to 23 juni shows on the 20th and 21st, the rest of the week stops at zondag');
    assert.deepEqual(texts(page, 'section.cal-day p.hint'), [S.agenda.nothingThisDay], 'only Friday is empty');
    // Every day Ben's reservation touches offers its actions again.
    assert.equal(cardsOf(page, 'Ben').length, 2);
    assert.ok(cardsOf(page, 'Ben').every((c) => all(c, 'a').some((a) => attr(a, 'href') === '#/reserve/2')));

    assert.deepEqual(all(page, '.cal-nav button').map((b) => attr(b, 'aria-label')), [S.agenda.stepLabel.prev.week, null, S.agenda.stepLabel.next.week]);
    await button(page, S.agenda.prev).fire('click');
    await button(page, S.agenda.next).fire('click');
    assert.deepEqual(me.navigated, ['#/?view=week&date=2026-06-10', '#/?view=week&date=2026-06-24']);
  });
});

test('Week over the DST changes: no day is skipped or doubled and a reservation across the 23-hour day shows on both its days', async () => {
  const across = item(20, 'Gijs', '2026-03-28T22:00:00.000Z', '2026-03-29T22:00:00.000Z'); // 23:00 on the 28th to 00:00 on the 30th
  const autumn = item(21, 'Hanne', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'); // exactly the 25-hour day
  await withClient({ now: NOW, routes: routes([across, autumn]) }, async ({ dom }) => {
    const spring = dom.mount((await show('view=week&date=2026-03-29')).el);
    assert.deepEqual(texts(spring, 'section.cal-day h3').map((t) => t.replace(/ \(vandaag\)$/, '')), [
      'maandag 23 maart',
      'dinsdag 24 maart',
      'woensdag 25 maart',
      'donderdag 26 maart',
      'vrijdag 27 maart',
      'zaterdag 28 maart',
      'zondag 29 maart',
    ]);
    assert.deepEqual(all(spring, 'section.cal-day').map((s) => all(s, '.what').length), [0, 0, 0, 0, 0, 1, 1], 'on the 28th and the 29th, not on the 30th');
    const threeDays = dom.mount((await show('view=3days&date=2026-03-28')).el);
    assert.deepEqual(texts(threeDays, 'section.cal-day h3'), ['zaterdag 28 maart', 'zondag 29 maart', 'maandag 30 maart']);

    const fall = dom.mount((await show('view=day&date=2026-10-25')).el);
    assert.deepEqual(texts(fall, 'h2'), ['zondag 25 oktober']);
    assert.equal(cardsOf(fall, 'Hanne').length, 1, 'the whole 25-hour day is one day');
    const next = dom.mount((await show('view=day&date=2026-10-26')).el);
    assert.equal(all(next, 'article.reservation').length, 0, 'and not the day after');
  });
});

test('Month: weekday headings, a Monday-first grid with the neighbouring days muted, today marked, a count per day', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const { me, el } = await show('view=month&date=2026-06-18');
    const page = dom.mount(el);
    assert.deepEqual(texts(page, 'h2'), ['juni 2026']);
    const heads = all(page, '.cal-head');
    assert.deepEqual(heads.map((e) => e.textContent), ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo']);
    assert.ok(heads.every((e) => attr(e, 'aria-hidden') === 'true'), 'the cells carry the weekday in their label');

    const cells = all(page, 'button.cal-cell');
    assert.equal(cells.length, 35, 'juni 2026 starts on a maandag and ends on a dinsdag: five rows');
    const cell = (label: string): FakeElement => {
      const found = cells.find((c) => (attr(c, 'aria-label') ?? '').startsWith(`${label},`));
      assert.ok(found, `no cell "${label}"`);
      return found;
    };
    assert.deepEqual(cells.filter((c) => c.className.split(' ').includes('out')).length, 5, '1 to 5 juli belong to the next month');
    assert.ok(cell('woensdag 1 juli').className.split(' ').includes('out'));
    assert.ok(!cell('maandag 1 juni').className.split(' ').includes('out'));

    const today = cell('maandag 15 juni');
    assert.ok(today.className.split(' ').includes('today'));
    assert.equal(attr(today, 'aria-current'), 'date');
    assert.equal(cells.filter((c) => attr(c, 'aria-current') !== null).length, 1, 'only today');
    assert.equal(attr(today, 'aria-label'), S.agenda.cellLabel('maandag 15 juni', true, 1, 0));

    // Counts: declined and expired suggestions are not counted; Ben's night counts for the 16th and the 17th.
    const count = (label: string): string => one(cell(label), '.cal-count').textContent;
    assert.equal(count('dinsdag 16 juni'), '1');
    assert.equal(count('woensdag 17 juni'), '1');
    assert.equal(attr(cell('dinsdag 16 juni'), 'aria-label'), S.agenda.cellLabel('dinsdag 16 juni', false, 1, 0));
    assert.equal(all(cell('vrijdag 19 juni'), '.cal-count').length, 0, 'an empty day has no count');
    assert.equal(attr(cell('vrijdag 19 juni'), 'aria-label'), S.agenda.cellLabel('vrijdag 19 juni', false, 0, 0));
    assert.deepEqual(['zaterdag 20 juni', 'zondag 21 juni', 'maandag 22 juni', 'dinsdag 23 juni'].map(count), ['1', '1', '1', '1'], 'Femke\'s four days');

    // A waiting suggestion is marked on its day, in the label and by the class (the dashed edge is CSS).
    const waiting = cell('donderdag 18 juni');
    assert.ok(waiting.className.split(' ').includes('has-pending'));
    assert.equal(attr(waiting, 'aria-label'), S.agenda.cellLabel('donderdag 18 juni', false, 1, 1));
    assert.match(attr(waiting, 'aria-label') as string, /1 wacht op een antwoord/);
    assert.ok(!cell('dinsdag 16 juni').className.split(' ').includes('has-pending'));
    assert.ok(all(page, 'p.hint').some((p) => p.textContent === S.agenda.monthHint));

    // A day opens the Day view.
    await waiting.fire('click');
    assert.deepEqual(me.navigated, ['#/?view=day&date=2026-06-18']);
    assert.equal(cells.filter((c) => c.disabled).length, 0, 'the whole month is inside the window');
  });
});

test('Month: Previous and Next step one month, and stop at the edges of the window', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const mid = await show('view=month&date=2026-06-18');
    const page = dom.mount(mid.el);
    assert.deepEqual(all(page, '.cal-nav button').map((b) => attr(b, 'aria-label')), [S.agenda.stepLabel.prev.month, null, S.agenda.stepLabel.next.month]);
    await button(page, S.agenda.prev).fire('click');
    await button(page, S.agenda.next).fire('click');
    await button(page, S.agenda.today).fire('click');
    assert.deepEqual(mid.me.navigated, ['#/?view=month&date=2026-05-18', '#/?view=month&date=2026-07-18', '#/?view=month&date=2026-06-15']);

    // The last month: the window ends on 15 December 2026.
    const last = dom.mount((await show('view=month&date=2026-12-10')).el);
    assert.equal(button(last, S.agenda.next).disabled, true);
    assert.equal(button(last, S.agenda.prev).disabled, false);
    const lastCells = all(last, 'button.cal-cell');
    const lastLabel = (c: FakeElement): string => attr(c, 'aria-label') as string;
    assert.equal(lastCells.find((c) => lastLabel(c).startsWith('dinsdag 15 december,'))?.disabled, false, 'the last day is open');
    assert.equal(lastCells.find((c) => lastLabel(c).startsWith('woensdag 16 december,'))?.disabled, true, 'the day after is not');
    assert.equal(lastCells.find((c) => lastLabel(c).startsWith('donderdag 31 december,'))?.disabled, true);

    // The first month: the window starts on 15 December 2025.
    const first = dom.mount((await show('view=month&date=2025-12-20')).el);
    assert.equal(button(first, S.agenda.prev).disabled, true);
    assert.equal(button(first, S.agenda.next).disabled, false);
    const firstCells = all(first, 'button.cal-cell');
    assert.equal(firstCells.find((c) => lastLabel(c).startsWith('zondag 14 december,'))?.disabled, true);
    assert.equal(firstCells.find((c) => lastLabel(c).startsWith('maandag 15 december,'))?.disabled, false);
  });
});

test('the edges of the window for Day, 3 days and Week; a date outside it lands on the nearest day inside', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const firstDay = dom.mount((await show('view=day&date=2025-12-15')).el);
    assert.equal(button(firstDay, S.agenda.prev).disabled, true);
    assert.equal(button(firstDay, S.agenda.next).disabled, false);
    const lastDay = dom.mount((await show('view=day&date=2026-12-15')).el);
    assert.equal(button(lastDay, S.agenda.next).disabled, true);
    assert.equal(button(lastDay, S.agenda.prev).disabled, false);

    assert.deepEqual(texts(dom.mount((await show('view=day&date=2030-01-01')).el), 'h2'), ['dinsdag 15 december'], 'far ahead: the last day');
    assert.deepEqual(texts(dom.mount((await show('view=day&date=1999-01-01')).el), 'h2'), ['maandag 15 december'], 'far back: the first day');

    // A week that sticks out of the window only shows its days inside it.
    const edge = dom.mount((await show('view=week&date=2026-12-15')).el);
    assert.deepEqual(texts(edge, 'section.cal-day h3'), ['maandag 14 december', 'dinsdag 15 december']);
    assert.equal(button(edge, S.agenda.next).disabled, true);
    const threeEdge = dom.mount((await show('view=3days&date=2026-12-14')).el);
    assert.deepEqual(texts(threeEdge, 'section.cal-day h3'), ['maandag 14 december', 'dinsdag 15 december']);
    assert.equal(button(threeEdge, S.agenda.next).disabled, true);
  });
});

test('a broken address never breaks the page: it opens the list, or today', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    for (const query of ['view=%E0%A4%A', 'view=day&date=2026-02-30', 'view=week&date=', 'date=2026-06-17', 'view=month&date=99999-01-01', 'view=3days&date=2026-06-15&date=2026-06-20']) {
      const page = dom.mount((await show(query)).el);
      assert.ok(all(page, 'h2').length === 1, query);
      dom.body.replaceChildren();
    }
    const noDate = dom.mount((await show('view=day&date=2026-02-30')).el);
    assert.equal(texts(noDate, 'h2')[0], S.agenda.dayHeading('maandag 15 juni', true), 'a date that does not exist is today');
    const noView = dom.mount((await show('date=2026-06-17')).el);
    assert.deepEqual(texts(noView, 'h2'), [S.agenda.upcoming], 'a date without a view is still the list');
    // And without any route at all (a caller that does not pass one).
    const bare = dom.mount(await render(makeApp(ANNA).app));
    assert.deepEqual(texts(bare, 'h2'), [S.agenda.upcoming]);
  });
});

test('declined and expired suggestions are in none of the views', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    for (const query of ['', 'view=day&date=2026-06-16', 'view=day&date=2026-06-17', 'view=3days&date=2026-06-15', 'view=week&date=2026-06-17', 'view=month&date=2026-06-17']) {
      const page = dom.mount((await show(query)).el);
      assert.doesNotMatch(page.textContent, /Dora|Eva/, query || 'list');
      dom.body.replaceChildren();
    }
  });
});

test('the non-list views have one h2, the period, and the day sections use h3', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    for (const view of ['day', '3days', 'week', 'month']) {
      const page = dom.mount((await show(`view=${view}&date=2026-06-17`)).el);
      assert.equal(all(page, 'h2').length, 1, view);
      assert.equal(one(page, 'h2').className, 'cal-title');
      assert.equal(all(page, 'h3').length, all(page, 'section.cal-day h3').length, `${view}: every h3 is a day heading`);
      assert.equal(one(page, 'p.hint.center').textContent, S.agenda.windowNote(6), 'the window note closes every view');
      assert.equal(one(page, '.view-switch').parent, page, 'the switcher is the first thing in the page');
      dom.body.replaceChildren();
    }
  });
});

test('refreshing: the same address renders the same page, so the minute refresh and every action keep the view and the day', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    for (const query of ['', 'view=day&date=2026-06-16', 'view=3days&date=2026-06-16', 'view=week&date=2026-06-17', 'view=month&date=2026-06-17']) {
      const first = dom.mount((await show(query)).el);
      const before = shape(first);
      dom.body.replaceChildren();
      const second = dom.mount((await show(query)).el);
      assert.equal(shape(second), before, query || 'list');
      dom.body.replaceChildren();
    }
  });
});

test('the view reads the address of its own render, not what was shown before', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const week = dom.mount((await show('view=week&date=2026-06-17')).el);
    assert.equal(attr(button(one(week, '.view-switch'), 'Week'), 'aria-pressed'), 'true');
    dom.body.replaceChildren();
    const month = dom.mount((await show('view=month&date=2026-06-17')).el);
    assert.equal(attr(button(one(month, '.view-switch'), 'Week'), 'aria-pressed'), 'false');
    assert.equal(attr(button(one(month, '.view-switch'), 'Maand'), 'aria-pressed'), 'true');
  });
});

// ------------------------------------------------------------ gaps found by the test stage

test('the cards in the calendar views offer what the list offers: approve and decline, the km link, edit and cancel', async () => {
  // A suggestion Ben made for Anna (she can answer it) on the 17th, next to the data every view test uses.
  const forAnna = item(30, 'Anna', '2026-06-17T08:00:00.000Z', '2026-06-17T10:00:00.000Z', {
    userId: ANNA.id,
    status: 'pending',
    suggestion: true,
    createdBy: 99,
    createdByName: 'Ben',
    can: { edit: false, cancel: false, approve: true, decline: true },
  });
  const extra: Routes = { 'POST /api/reservations/30/approve': () => ({}), 'POST /api/reservations/30/decline': () => ({}) };
  await withClient({ now: NOW, routes: routes([...ITEMS, forAnna], extra) }, async ({ dom, api }) => {
    for (const query of ['view=day&date=2026-06-17', 'view=3days&date=2026-06-17', 'view=week&date=2026-06-17']) {
      const { me, el } = await show(query);
      const page = dom.mount(el);
      const card = cardsOf(page, S.meHead).find((c) => one(c, '.badge-status').textContent === S.status.pending) as FakeElement;
      assert.ok(card, `${query}: Anna's own suggestion is shown, as "me"`);
      assert.equal(one(card, '.sub').textContent, S.agenda.suggestedBy('Ben'));
      assert.deepEqual(
        all(card, '.actions .btn').map((b) => b.textContent),
        [S.agenda.approve, S.agenda.decline],
        `${query}: the two answers, nothing else, like in the list`,
      );
      await button(card, S.agenda.approve).fire('click');
      await until(() => me.toasts.length > 0, 'the approval to be reported');
      assert.deepEqual(me.toasts, [{ message: S.agenda.approved, isError: false }], query);
      assert.equal(me.refreshes(), 1, `${query}: the page is reloaded after an answer`);
      dom.body.replaceChildren();
    }
    // Declining cannot be undone, so it asks first; saying no sends nothing.
    const { me, el } = await show('view=day&date=2026-06-17');
    const page = dom.mount(el);
    const card = cardsOf(page, S.meHead)[0] as FakeElement;
    dom.answer = false;
    await button(card, S.agenda.decline).fire('click');
    assert.deepEqual(dom.confirms.slice(-1), [S.agenda.confirmDecline]);
    assert.equal(api.calls.filter((c) => c.path.endsWith('/decline')).length, 0, 'no was no');
    dom.answer = true;
    await button(card, S.agenda.decline).fire('click');
    await until(() => me.toasts.length > 0, 'the decline to be reported');
    assert.deepEqual(me.toasts, [{ message: S.agenda.declined, isError: false }]);
    assert.equal(api.calls.filter((c) => c.path.endsWith('/decline')).length, 1);
    dom.body.replaceChildren();

    // Today's reservation of Anna starts in 20 minutes: the km button is there, as in the list.
    const today = dom.mount((await show('view=day&date=2026-06-15')).el);
    const mine = cardsOf(today, S.meHead)[0] as FakeElement;
    assert.ok(all(mine, 'a').some((a) => a.textContent === S.agenda.registerKm && attr(a, 'href') === '#/usage?res=1'));
    assert.equal(one(mine, '.km-line').textContent, S.agenda.kmMissing);
  });
});

test('the day views mark what is over as past, like the Earlier box of the list, and keep what is still to come in full', async () => {
  const yesterday = item(31, 'Gerrit', '2026-06-14T08:00:00.000Z', '2026-06-14T10:00:00.000Z');
  await withClient({ now: NOW, routes: routes([...ITEMS, yesterday]) }, async ({ dom }) => {
    const gone = dom.mount((await show('view=day&date=2026-06-14')).el);
    assert.ok(cardsOf(gone, 'Gerrit')[0]?.className.split(' ').includes('past'), 'ended before now');
    dom.body.replaceChildren();
    const now = dom.mount((await show('view=day&date=2026-06-15')).el);
    assert.ok(!(cardsOf(now, S.meHead)[0] as FakeElement).className.split(' ').includes('past'), 'not over yet');
    dom.body.replaceChildren();
    // The week of the 15th starts on Monday: it does not hold the 14th, and nothing in it is over.
    const week = dom.mount((await show('view=week&date=2026-06-15')).el);
    const flags = all(week, 'article.reservation').map((c) => [one(c, '.what').textContent, c.className.split(' ').includes('past')]);
    assert.deepEqual(flags.filter(([who]) => who === 'Gerrit'), [], 'the 14th is a zondag of the week before');
    assert.ok(flags.length > 0 && flags.every(([, past]) => past === false));
    dom.body.replaceChildren();
    // A week that does hold it: Monday the 8th to Sunday the 14th.
    const before = dom.mount((await show('view=week&date=2026-06-14')).el);
    assert.deepEqual(all(before, 'article.reservation').map((c) => [one(c, '.what').textContent, c.className.split(' ').includes('past')]), [['Gerrit', true]]);
  });
});

test('Month: reservations on the muted days of the neighbouring months are counted, and today is only marked in the month that holds it', async () => {
  // July 2026 starts on a Wednesday, so the grid begins on Monday 29 June and ends on Sunday 2 August.
  const june30 = item(32, 'Hanne', '2026-06-30T08:00:00.000Z', '2026-06-30T10:00:00.000Z');
  const aug1 = item(33, 'Iris', '2026-08-01T08:00:00.000Z', '2026-08-01T10:00:00.000Z', { status: 'pending', suggestion: true });
  await withClient({ now: NOW, routes: routes([...ITEMS, june30, aug1]) }, async ({ dom }) => {
    const page = dom.mount((await show('view=month&date=2026-07-10')).el);
    const cells = all(page, 'button.cal-cell');
    assert.equal(cells.length, 35);
    const cell = (label: string): FakeElement => cells.find((c) => (attr(c, 'aria-label') ?? '').startsWith(`${label},`)) as FakeElement;
    assert.ok(cell('dinsdag 30 juni').className.split(' ').includes('out'), '30 juni belongs to the month before');
    assert.equal(one(cell('dinsdag 30 juni'), '.cal-count').textContent, '1', 'and still shows its reservation');
    assert.ok(cell('zaterdag 1 augustus').className.split(' ').includes('out'));
    assert.ok(cell('zaterdag 1 augustus').className.split(' ').includes('has-pending'), 'also the waiting suggestion of a muted day');
    assert.equal(cells.filter((c) => c.className.split(' ').includes('today')).length, 0, 'today is in June: not marked in July');
    assert.equal(cells.filter((c) => attr(c, 'aria-current') !== null).length, 0);
    // The month that does hold today marks it once.
    dom.body.replaceChildren();
    const june = dom.mount((await show('view=month&date=2026-06-10')).el);
    assert.equal(all(june, 'button.cal-cell.today').length, 1);
    assert.equal(all(june, 'button.cal-cell.out').length, 5);
  });
});

test('Today is always there to press, also on the first and last day of the window, and brings the view back to today', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    for (const [view, date] of [
      ['day', '2025-12-15'],
      ['day', '2026-12-15'],
      ['month', '2025-12-15'],
      ['month', '2026-12-15'],
      ['week', '2026-12-15'],
    ] as const) {
      const { me, el } = await show(`view=${view}&date=${date}`);
      const page = dom.mount(el);
      const today = button(one(page, '.cal-nav'), S.agenda.today);
      assert.equal(today.disabled, false, `${view} ${date}`);
      await today.fire('click');
      assert.equal(me.navigated.at(-1), `#/?view=${view}&date=2026-06-15`, `${view} ${date}`);
      dom.body.replaceChildren();
    }
  });
});

test('the window follows the household setting, not a fixed six months', async () => {
  // Three months either side of 15 June 2026: 15 March to 15 September.
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const me = makeApp(ANNA);
    (me.app.session as { windowMonths: number }).windowMonths = 3;
    const view = async (query: string) => dom.mount(await render(me.app, { query: new URLSearchParams(query) }));
    const last = await view('view=day&date=2026-09-15');
    assert.equal(button(last, S.agenda.next).disabled, true);
    assert.equal(one(last, 'p.hint.center').textContent, S.agenda.windowNote(3));
    dom.body.replaceChildren();
    const first = await view('view=day&date=2026-03-15');
    assert.equal(button(first, S.agenda.prev).disabled, true);
    dom.body.replaceChildren();
    assert.deepEqual(texts(await view('view=day&date=2026-12-01'), 'h2'), ['dinsdag 15 september'], 'a day beyond three months lands on the last one');
    dom.body.replaceChildren();
    // A month cell after the last day cannot be opened, and there is no next month.
    const month = await view('view=month&date=2026-09-10');
    const sep = all(month, 'button.cal-cell');
    assert.equal(sep.find((c) => (attr(c, 'aria-label') ?? '').startsWith('dinsdag 15 september,'))?.disabled, false);
    assert.equal(sep.find((c) => (attr(c, 'aria-label') ?? '').startsWith('woensdag 16 september,'))?.disabled, true);
    assert.equal(button(month, S.agenda.next).disabled, true);
  });
});

test('no view puts a style attribute on anything (the content security policy allows none)', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    for (const query of ['', 'view=day&date=2026-06-16', 'view=3days&date=2026-06-16', 'view=week&date=2026-06-17', 'view=month&date=2026-06-17']) {
      const page = dom.mount((await show(query)).el);
      const styled = (page as FakeElement).descendants().filter((e) => attr(e, 'style') !== null);
      assert.deepEqual(styled.map((e) => e.className), [], query || 'list');
      dom.body.replaceChildren();
    }
  });
});

test('building a view never takes the focus: the minute refresh must not pull it away from what the person is doing', async () => {
  // app.js moves the focus to the period heading only after a step (landOnView); a view itself must not.
  await withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const queries = ['', 'view=day&date=2026-06-16', 'view=3days&date=2026-06-16', 'view=week&date=2026-06-17', 'view=month&date=2026-06-17'];
    for (const query of queries) {
      dom.mount((await show(query)).el);
      assert.equal(dom.focused(), null, `${query || 'list'}: nothing is focused after a plain render`);
      dom.body.replaceChildren();
    }
    // Something outside the view has the focus (the tab bar, a toast): building the view again leaves it there.
    const elsewhere = dom.mount(h('button', { type: 'button', text: 'elsewhere' }));
    elsewhere.focus();
    for (const query of queries) {
      await show(query);
      assert.equal(dom.focused(), elsewhere, `${query || 'list'}: the focus stays where it was`);
    }
    // And a press on a switcher, step or day button only changes the address (the router lands the focus afterwards).
    const page = dom.mount((await show('view=month&date=2026-06-17')).el);
    await button(one(page, '.view-switch'), 'Week').fire('click');
    await button(one(page, '.cal-nav'), S.agenda.next).fire('click');
    await (all(page, 'button.cal-cell')[10] as FakeElement).fire('click');
    assert.equal(dom.focused(), elsewhere, 'the views leave the focus to the router');
  });
});

test('no API change: every view reads the one list of reservations, once, and a press only changes the address', async () => {
  await withClient({ now: NOW, routes: routes() }, async ({ dom, api }) => {
    for (const query of ['', 'view=day&date=2026-06-16', 'view=3days&date=2026-06-16', 'view=week&date=2026-06-17', 'view=month&date=2026-06-17']) {
      const before = api.calls.length;
      const { me, el } = await show(query);
      const page = dom.mount(el);
      assert.deepEqual(
        api.calls.slice(before).map((c) => `${c.method} ${c.path}?${c.query}`),
        ['GET /api/reservations?'],
        `${query || 'list'}: one GET of the list, no range, no new endpoint`,
      );
      // Switching view, stepping and opening a day do not talk to the server: the router renders the new address.
      const quiet = api.calls.length;
      for (const label of ['Lijst', 'Dag', '3 dagen', 'Week', 'Maand']) await button(one(page, '.view-switch'), label).fire('click');
      if (query !== '') {
        for (const label of [S.agenda.prev, S.agenda.today, S.agenda.next]) await button(one(page, '.cal-nav'), label).fire('click');
      }
      assert.equal(api.calls.length, quiet, `${query || 'list'}: only the address changed`);
      // Every press of a view that is not the current one navigates; the pressed one is a segmented control's no-op (ui.test.ts).
      assert.equal(me.navigated.length >= 4, true);
      dom.body.replaceChildren();
    }
    assert.deepEqual(api.writes(), [], 'looking at the calendar writes nothing');
  });
});

test('the texts of the views read well: singular and plural, today, and what is waiting', () => {
  const day = 'maandag 15 juni';
  assert.equal(S.agenda.cellLabel(day, true, 0, 0), 'maandag 15 juni, vandaag, geen reserveringen');
  assert.equal(S.agenda.cellLabel(day, false, 1, 0), 'maandag 15 juni, 1 reservering');
  assert.equal(S.agenda.cellLabel(day, false, 3, 2), 'maandag 15 juni, 3 reserveringen, 2 wachten op een antwoord');
  assert.equal(S.agenda.cellLabel(day, true, 1, 1), 'maandag 15 juni, vandaag, 1 reservering, 1 wacht op een antwoord');
  assert.equal(S.agenda.dayHeading(day, true), 'maandag 15 juni (vandaag)');
  assert.equal(S.agenda.dayHeading(day, false), day);
  assert.equal(S.agenda.range('15 jun 2026', '21 jun 2026'), '15 jun 2026 – 21 jun 2026');
  assert.deepEqual(S.agenda.weekdays, ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'], 'weeks start on Monday');
  assert.deepEqual(Object.keys(S.agenda.views), [...VIEWS], 'one label per view, in the order of the switcher');
  for (const direction of ['prev', 'next'] as const) {
    assert.deepEqual(Object.keys(S.agenda.stepLabel[direction]), ['day', '3days', 'week', 'month'], 'a spoken name for every step');
  }
});

test('the stylesheet has a rule for every class the calendar views use, and every colour it names is defined in both themes', () => {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const selector of ['.view-switch', '.cal-title', '.cal-nav', '.cal-grid', '.cal-head', '.cal-cell', '.cal-cell.out', '.cal-cell.today', '.cal-cell.has-pending', '.cal-count', '.cal-day.today']) {
    assert.ok(css.includes(selector), `no rule for ${selector}`);
  }
  assert.match(css, /\.view-switch \.btn\[aria-pressed='true'\]/, 'the pressed state of the switcher is styled with the attribute the view sets');
  // Every var(--token) of the whole sheet is defined in :root, and the dark theme only redefines tokens the light one has.
  const defined = (block: string): Set<string> => new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
  const light = defined(/(?:^|\})\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
  // The dark theme is written twice (the phone asks for it, or the person chose Donker); test/design.test.ts keeps them equal.
  const dark = defined(/prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
  assert.ok(light.size > 15 && dark.size > 10, `found ${light.size} light and ${dark.size} dark tokens`);
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string));
  assert.deepEqual([...used].filter((t) => !light.has(t)), [], 'a colour or size used but never defined');
  assert.deepEqual([...dark].filter((t) => !light.has(t)), []);
  for (const token of ['--ok-bg', '--ok-text', '--warn-bg', '--warn-text', '--off-bg', '--primary', '--surface', '--border', '--muted', '--text']) {
    assert.ok(dark.has(token), `${token} (used by the month grid) has a dark value`);
  }
});
