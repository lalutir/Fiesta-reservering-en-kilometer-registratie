import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { many, one, run } from '../src/db.ts';
import { HOUSEHOLD, TOTAL_FIELDS, columnOf, computeMonths, emptyTotals, entryOf, parseStatsRange, statsReport, type StatsMonthDto, type StatsReport } from '../src/stats.ts';
import { createHousehold, createTestApp, insertApk, insertDamage, insertFuel, insertReservation, insertTicket, insertUsage, insertDraft, type Client, type Household, type Json } from './helpers.ts';

const TZ = 'Europe/Amsterdam';
const NOW = '2026-06-15T10:00:00.000Z';

const get = async (c: Client, query = ''): Promise<StatsReport> => {
  const res = await c.get(`/api/stats${query}`);
  assert.equal(res.status, 200, res.text);
  return res.body as StatsReport;
};
const monthOf = (r: StatsReport, key: string): StatsMonthDto => {
  const m = r.months.find((x) => x.month === key);
  assert.ok(m, `month ${key} is in the report`);
  return m;
};
const personOf = (m: StatsMonthDto, userId: number): Json => m.people.find((p) => p.userId === userId);

/**
 * An admin and three members, signed in, whose accounts are dated shortly before the months the tests use, so
 * that those months count as months of a household that existed (a quiet one reads zero, not "not available").
 */
async function household(now = NOW, created = '2026-01-02T08:00:00.000Z'): Promise<Household> {
  const h = await createHousehold({ now });
  run(h.t.db, 'UPDATE users SET created_at = ?', created);
  return h;
}

/** A drive of `km` kilometres (readings start..start+km) in one go; the end is an hour after the start. */
function drive(h: Household, userId: number, start: string, from: number, km: number, over: { kmFor?: 'self' | 'person' | 'together'; kmUserId?: number } = {}): number {
  return insertUsage(h.t, { userId, start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), odometerStart: from, odometerEnd: from + km, ...over });
}

// ============================================================================ the API

test('GET /api/stats: anonymous is refused, every signed-in user gets the same body, and the shape is the documented one', async () => {
  const h = await household();
  try {
    assert.equal((await h.t.client().get('/api/stats')).status, 401);
    drive(h, h.anna.id, '2026-05-10T08:00:00.000Z', 1000, 100);
    insertFuel(h.t, { userId: h.anna.id, at: '2026-05-11T08:00:00.000Z', odometer: 1100 });
    const [a, b, c, d] = await Promise.all([get(h.admin), get(h.anna), get(h.ben), get(h.carla)]);
    assert.deepEqual(b, a, 'the same body for a member and the admin');
    assert.deepEqual(c, a);
    assert.deepEqual(d, a);
    assert.equal(a.version, 1);
    assert.equal(a.timeZone, TZ);
    assert.equal(a.windowMonths, 6);
    assert.equal(a.retentionMonths, 24);
    assert.equal(a.current, '2026-06');
    assert.deepEqual(a.range, { from: '2025-07', to: '2026-06' }, 'omitted: the last twelve months');
    assert.equal(a.months.length, 12);
    assert.deepEqual(a.months.map((m) => m.month), ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    assert.deepEqual(a.users, [
      { id: 1, name: 'Admin', active: true },
      { id: 2, name: 'Anna', active: true },
      { id: 3, name: 'Ben', active: true },
      { id: 4, name: 'Carla', active: true },
    ]);
    assert.deepEqual(Object.keys(a).sort(), ['current', 'months', 'range', 'retentionMonths', 'timeZone', 'users', 'version', 'windowMonths']);
    const may = monthOf(a, '2026-05');
    assert.deepEqual(Object.keys(may).sort(), ['frozen', 'household', 'incomplete', 'month', 'people', 'provisional', 'unavailable']);
    assert.deepEqual(Object.keys(may.household as object).sort(), [...TOTAL_FIELDS, 'totalKm', 'pricePerLitreMillis', 'costPerKmMillis', 'consumptionHundredths'].sort());
    assert.equal(may.provisional, false);
    assert.equal(monthOf(a, '2026-06').provisional, true, 'the current month is provisional');
    assert.ok(!('role' in (a.users[0] as object)), 'nothing that depends on who asks, and no roles');
  } finally {
    await h.t.close();
  }
});

test('GET /api/stats: a bad range is a 422 with a code per field, and nothing is clamped silently', async () => {
  const h = await household();
  try {
    const bad = async (query: string, fields: Record<string, string>): Promise<void> => {
      const res = await h.anna.get(`/api/stats${query}`);
      assert.equal(res.status, 422, query);
      assert.equal(res.body.error.code, 'validation_failed', query);
      assert.deepEqual({ ...res.body.error.fields }, fields, query);
    };
    await bad('?from=2026-13', { from: 'invalid_month' });
    await bad('?from=2026-1', { from: 'invalid_month' });
    await bad('?from=abc&to=2026-6', { from: 'invalid_month', to: 'invalid_month' });
    await bad('?to=2026-07', { to: 'in_future' });
    await bad('?from=2026-05&to=2026-03', { from: 'after_to' });
    await bad('?from=2026-07', { from: 'after_to' });
    await bad('?from=2024-06', { from: 'outside_retention' });
    await bad('?from=2024-06&to=2026-06', { from: 'outside_retention' });
    await bad('?to=2024-06', { to: 'outside_retention' });
    await bad('?from=2026-13&to=2026-14', { from: 'invalid_month', to: 'invalid_month' });
    await bad('?from=2026-07&to=2026-07', { to: 'in_future' });

    // The edges of what is allowed.
    const full = await get(h.anna, '?from=2024-07&to=2026-06');
    assert.equal(full.months.length, 24, 'the current month and the 23 before it');
    assert.deepEqual(await get(h.anna, '?from=2026-06&to=2026-06').then((r) => r.months.map((m) => m.month)), ['2026-06']);
    assert.deepEqual(await get(h.anna, '?to=2026-03').then((r) => r.range), { from: '2025-04', to: '2026-03' }, 'only `to`: twelve months ending in it');
    assert.deepEqual(await get(h.anna, '?to=2024-09').then((r) => r.range), { from: '2024-07', to: '2024-09' }, 'the default start is never older than what is kept');
    assert.deepEqual(await get(h.anna, '?from=2026-01').then((r) => r.range), { from: '2026-01', to: '2026-06' });
    assert.deepEqual(await get(h.anna, '?from=&to=').then((r) => r.range), { from: '2025-07', to: '2026-06' }, 'empty values count as absent');
  } finally {
    await h.t.close();
  }
});

test('the range follows STATS_RETENTION_MONTHS, with the month after the zone and the clock: parseStatsRange', () => {
  const q = (s: string): URLSearchParams => new URLSearchParams(s);
  const now = new Date('2026-06-30T22:30:00.000Z'); // already 1 July in Amsterdam
  assert.deepEqual(parseStatsRange(q(''), now, TZ, 24), { from: '2025-08', to: '2026-07' });
  assert.deepEqual(parseStatsRange(q(''), now, 'UTC', 24), { from: '2025-07', to: '2026-06' });
  assert.deepEqual(parseStatsRange(q(''), now, TZ, 6), { from: '2026-02', to: '2026-07' }, 'six months kept: the default range shrinks to it');
  assert.throws(() => parseStatsRange(q('from=2026-01'), now, TZ, 6), (err: Error & { fields?: Record<string, string> }) => err.fields?.['from'] === 'outside_retention');
  assert.deepEqual(parseStatsRange(q('from=2026-02'), now, TZ, 6), { from: '2026-02', to: '2026-07' });
  assert.deepEqual(parseStatsRange(q('from=2026-02&to=2026-02'), now, TZ, 6), { from: '2026-02', to: '2026-02' });
  // docs/STATS-API.md: a repeated parameter uses its first value, and an unknown one is ignored.
  assert.deepEqual(parseStatsRange(q('from=2026-03&from=2026-05&to=2026-04&to=2026-06&x=1'), now, TZ, 6), { from: '2026-03', to: '2026-04' });
  assert.deepEqual(parseStatsRange(q('from=2026-03&from=nope'), now, TZ, 6), { from: '2026-03', to: '2026-07' }, 'only the first value is read, so a later bad one is never seen');
});

test('GET /api/stats writes nothing: no row of any table changes, and no stored month appears', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-05-10T08:00:00.000Z', 1000, 100);
    insertFuel(h.t, { userId: h.anna.id, at: '2026-05-11T08:00:00.000Z', odometer: 1100 });
    insertTicket(h.t, { userId: h.anna.id, at: '2026-05-10T08:30:00.000Z', amountCents: 9000 });
    insertDamage(h.t, { reportedBy: h.ben.id });
    await get(h.anna); // anything the first call may settle (a session refresh) happens now
    const changes = (): number => one<{ n: number }>(h.t.db, 'SELECT total_changes() AS n')?.n as number;
    const dump = (): string =>
      JSON.stringify(['users', 'sessions', 'usage', 'fuel', 'tickets', 'damage_reports', 'meta', 'stats_months', 'stats_totals'].map((t) => many(h.t.db, `SELECT * FROM ${t}`)));
    const before = [changes(), dump()];
    await get(h.anna);
    await get(h.admin, '?from=2024-07&to=2026-06');
    assert.deepEqual([changes(), dump()], before, 'two reads later, nothing in the database moved');
    assert.deepEqual(many(h.t.db, 'SELECT month FROM stats_months'), []);
    assert.equal(one<{ v: string }>(h.t.db, "SELECT value AS v FROM meta WHERE key = 'stats_first_month'"), undefined, 'not even the baseline is stored by a read');
  } finally {
    await h.t.close();
  }
});

test('an empty young household: months before the household existed are not available, the quiet months since are zero', async () => {
  const h = await createHousehold({ now: NOW });
  try {
    const r = await get(h.anna);
    const flags = r.months.map((m) => [m.month, m.unavailable] as const);
    assert.deepEqual(flags.filter(([, u]) => u).map(([m]) => m), ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'], 'the users were created in June 2026');
    const june = monthOf(r, '2026-06');
    assert.equal(june.unavailable, false);
    assert.equal(june.provisional, true);
    assert.deepEqual(june.household, entryOf(emptyTotals()), 'an empty month of a household that exists reads zero, not "unavailable"');
    assert.equal(june.household?.pricePerLitreMillis, null);
    assert.deepEqual(june.people, []);
    const gone = monthOf(r, '2026-05');
    assert.equal(gone.household, null);
    assert.deepEqual(gone.people, []);
    assert.equal(gone.incomplete, false, 'nothing is known, so nothing is called incomplete');
  } finally {
    await h.t.close();
  }
});

// ===================================================================== attribution

test('a drive belongs to the month it started in, in the household zone: the edges sit at local midnight', async () => {
  const h = await household('2026-11-20T10:00:00.000Z', '2025-11-01T08:00:00.000Z');
  try {
    const at = (start: string, km: number): number => drive(h, h.anna.id, start, 0, km);
    at('2026-03-31T21:59:59.999Z', 1); // 23:59:59.999 on 31 March in Amsterdam (CEST)
    at('2026-03-31T22:00:00.000Z', 2); // 00:00 on 1 April
    at('2026-10-31T22:59:59.999Z', 4); // 23:59:59.999 on 31 October (CET)
    at('2026-10-31T23:00:00.000Z', 8); // 00:00 on 1 November
    const r = await get(h.anna, '?from=2026-03&to=2026-11');
    const km = (key: string): number => (personOf(monthOf(r, key), h.anna.id)?.km as number | undefined) ?? 0;
    assert.deepEqual([km('2026-03'), km('2026-04'), km('2026-10'), km('2026-11')], [1, 2, 4, 8]);
    assert.deepEqual(['2026-03', '2026-04', '2026-10', '2026-11'].map((k) => personOf(monthOf(r, k), h.anna.id).trips), [1, 1, 1, 1]);
  } finally {
    await h.t.close();
  }
});

test('the 23-hour and the 25-hour day are one day of their month like any other', async () => {
  const h = await household('2026-11-20T10:00:00.000Z', '2025-11-01T08:00:00.000Z');
  try {
    drive(h, h.anna.id, '2026-03-28T23:30:00.000Z', 0, 5); // 00:30 on the short day (29 March)
    drive(h, h.anna.id, '2026-03-29T21:30:00.000Z', 5, 6); // 23:30 the same day, after the clocks went forward
    drive(h, h.anna.id, '2026-10-24T22:30:00.000Z', 11, 7); // 00:30 on the long day (25 October)
    drive(h, h.anna.id, '2026-10-25T22:30:00.000Z', 18, 9); // 23:30 the same day, after the clocks went back
    const r = await get(h.anna, '?from=2026-03&to=2026-10');
    assert.equal(personOf(monthOf(r, '2026-03'), h.anna.id).km, 11);
    assert.equal(personOf(monthOf(r, '2026-10'), h.anna.id).km, 16);
  } finally {
    await h.t.close();
  }
});

test('a drive that spans midnight of the 1st counts in the month it started in, whole', async () => {
  const h = await household();
  try {
    insertUsage(h.t, { userId: h.anna.id, start: '2026-03-31T20:00:00.000Z', end: '2026-04-01T04:00:00.000Z', odometerStart: 100, odometerEnd: 400 });
    const r = await get(h.anna, '?from=2026-03&to=2026-04');
    assert.equal(personOf(monthOf(r, '2026-03'), h.anna.id).km, 300);
    assert.equal(monthOf(r, '2026-04').household?.km, 0, 'nothing is split over the two months');
    assert.equal(monthOf(r, '2026-03').household?.trips, 1);
  } finally {
    await h.t.close();
  }
});

test('the zone of the household decides the month: a zone east of UTC moves the drive to the next month', async () => {
  const t = await createTestApp({ now: NOW, env: { HOUSEHOLD_TZ: 'Pacific/Auckland' } });
  try {
    const admin = await t.signIn('admin', 'admin');
    const anna = await t.signIn('anna');
    run(t.db, 'UPDATE users SET created_at = ?', '2026-01-02T08:00:00.000Z');
    // 31 March 23:00 UTC is 1 April 12:00 in Auckland (NZDT, UTC+13 until the clocks go back in April).
    insertUsage(t, { userId: anna.id, start: '2026-03-31T23:00:00.000Z', end: '2026-04-01T00:00:00.000Z', odometerStart: 0, odometerEnd: 12 });
    const r = await get(admin, '?from=2026-03&to=2026-04');
    assert.equal(r.timeZone, 'Pacific/Auckland');
    assert.equal(monthOf(r, '2026-03').household?.km, 0);
    assert.equal(monthOf(r, '2026-04').household?.km, 12);
  } finally {
    await t.close();
  }
});

test('kilometres follow whose they are: own, somebody else\'s, together; trips follow the driver; drafts never count; readings are optional for a trip', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-04-02T08:00:00.000Z', 1000, 100); // anna, her own
    drive(h, h.anna.id, '2026-04-03T08:00:00.000Z', 1100, 50, { kmFor: 'person', kmUserId: h.ben.id }); // anna drives, ben's kilometres
    drive(h, h.ben.id, '2026-04-04T08:00:00.000Z', 1150, 20, { kmFor: 'together' }); // ben drives, together
    drive(h, h.admin.id, '2026-04-05T08:00:00.000Z', 1170, 10); // the admin's own kilometres still count as kilometres
    insertUsage(h.t, { userId: h.carla.id, start: '2026-04-06T08:00:00.000Z', end: '2026-04-06T09:00:00.000Z' }); // an old drive without readings: a trip, no kilometres
    insertUsage(h.t, { userId: h.carla.id, start: '2026-04-07T08:00:00.000Z', end: '2026-04-07T09:00:00.000Z', odometerStart: 1180 }); // half a reading: no kilometres
    insertDraft(h.t, { userId: h.carla.id, start: '2026-04-08T08:00:00.000Z', odometerStart: 1180 }); // not finished: not a trip
    const r = await get(h.anna, '?from=2026-04&to=2026-04');
    const april = monthOf(r, '2026-04');
    assert.deepEqual(
      april.people.map((p) => [p.userId, p.trips, p.km]),
      [[h.admin.id, 1, 10], [h.anna.id, 2, 100], [h.ben.id, 1, 50], [h.carla.id, 2, 0]],
      'a drive for ben is anna\'s trip and ben\'s kilometres',
    );
    assert.equal(april.household?.togetherKm, 20, 'together kilometres sit on the household');
    assert.ok(april.people.every((p) => p.togetherKm === 0));
    assert.equal(april.household?.km, 160);
    assert.equal(april.household?.totalKm, 180);
    assert.equal(april.household?.trips, 6, 'six finished drives; the draft is none');
  } finally {
    await h.t.close();
  }
});

test('a deactivated user with data stays in the series and in the totals', async () => {
  const h = await household();
  try {
    drive(h, h.carla.id, '2026-04-02T08:00:00.000Z', 1000, 80);
    run(h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', h.carla.id);
    const r = await get(h.anna, '?from=2026-04&to=2026-04');
    assert.deepEqual(r.users.find((u) => u.id === h.carla.id), { id: h.carla.id, name: 'Carla', active: false });
    assert.equal(personOf(monthOf(r, '2026-04'), h.carla.id).km, 80);
    assert.equal(monthOf(r, '2026-04').household?.km, 80);
  } finally {
    await h.t.close();
  }
});

test('tickets go to the month of the offence and to who was driving; with nobody on record they are the household\'s', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-04-10T08:00:00.000Z', 1000, 30);
    insertReservation(h.t, { userId: h.ben.id, start: '2026-04-12T08:00:00.000Z', end: '2026-04-12T12:00:00.000Z' });
    insertReservation(h.t, { userId: h.carla.id, createdBy: h.anna.id, status: 'pending', start: '2026-04-14T08:00:00.000Z', end: '2026-04-14T12:00:00.000Z' });
    insertTicket(h.t, { userId: h.anna.id, at: '2026-04-10T08:30:00.000Z', amountCents: 9000 }); // inside anna's drive
    insertTicket(h.t, { userId: h.anna.id, at: '2026-04-12T10:00:00.000Z', amountCents: 5000 }); // ben's reservation
    insertTicket(h.t, { userId: h.anna.id, at: '2026-04-14T10:00:00.000Z' }); // a pending suggestion never counts: nobody, and no price
    insertTicket(h.t, { userId: h.anna.id, at: '2026-05-01T10:00:00.000Z', amountCents: 100 }); // another month
    const r = await get(h.anna, '?from=2026-04&to=2026-05');
    const april = monthOf(r, '2026-04');
    assert.deepEqual(april.people.filter((p) => p.tickets > 0).map((p) => [p.userId, p.tickets, p.ticketCents]), [[h.anna.id, 1, 9000], [h.ben.id, 1, 5000]]);
    assert.deepEqual([april.household?.tickets, april.household?.ticketCents], [3, 14_000], 'the nobody-ticket is in the household total, on no person');
    assert.deepEqual([monthOf(r, '2026-05').household?.tickets, monthOf(r, '2026-05').household?.ticketCents], [1, 100]);
    // The driver is what the tickets screen says.
    const listed = (await h.anna.get('/api/tickets')).body.items as Json[];
    const byDriver = new Map<number, number>();
    for (const t of listed.filter((x) => x.at.startsWith('2026-04'))) byDriver.set(t.driver?.id ?? HOUSEHOLD, (byDriver.get(t.driver?.id ?? HOUSEHOLD) ?? 0) + 1);
    assert.deepEqual([...byDriver].sort(), [[HOUSEHOLD, 1], [h.anna.id, 1], [h.ben.id, 1]].sort());
  } finally {
    await h.t.close();
  }
});

test('damage reports go to the month of the day they were noticed and to the person who filed them', async () => {
  const h = await household();
  try {
    insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-03-31' });
    insertDamage(h.t, { reportedBy: h.ben.id, noticedOn: '2026-04-01', noticedBy: h.carla.id });
    insertDamage(h.t, { reportedBy: h.ben.id, noticedOn: '2026-04-30', repairedOn: '2026-05-02' });
    const r = await get(h.anna, '?from=2026-03&to=2026-05');
    assert.equal(personOf(monthOf(r, '2026-03'), h.anna.id).damageReports, 1);
    assert.equal(personOf(monthOf(r, '2026-04'), h.ben.id).damageReports, 2, 'filed by ben, whoever noticed it; repaired later or not');
    assert.equal(monthOf(r, '2026-05').household?.damageReports, 0, 'the month of the repair does not count');
    assert.equal(monthOf(r, '2026-04').household?.damageReports, 2);
  } finally {
    await h.t.close();
  }
});

test('unaccounted kilometres are the open gaps, in the month of the later reading; an explained gap is not counted', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-03-30T08:00:00.000Z', 1000, 100); // ends at 1100
    drive(h, h.anna.id, '2026-04-02T08:00:00.000Z', 1160, 40); // starts at 1160: a gap of 60 km, in April (the later reading)
    drive(h, h.anna.id, '2026-04-20T08:00:00.000Z', 1210, 10); // 1200 -> 1210: a gap of 10 km
    drive(h, h.anna.id, '2026-05-02T08:00:00.000Z', 1000, 10); // lower than 1220: a mismatch, which is not unaccounted kilometres
    const open = await get(h.anna, '?from=2026-03&to=2026-05');
    assert.deepEqual([monthOf(open, '2026-03').household?.unaccountedKm, monthOf(open, '2026-04').household?.unaccountedKm, monthOf(open, '2026-05').household?.unaccountedKm], [0, 70, 0]);
    const items = (await h.anna.get('/api/odometer')).body.items as Json[];
    const sixty = items.find((i) => i.kind === 'gap' && i.km === 60);
    assert.ok(sixty);
    assert.equal((await h.anna.post('/api/odometer/explain', { key: sixty.key, note: 'an outsider drove' })).status, 201);
    const explained = await get(h.anna, '?from=2026-04&to=2026-04');
    assert.equal(monthOf(explained, '2026-04').household?.unaccountedKm, 10, 'the explained gap is left out, like on the Drives tab');
  } finally {
    await h.t.close();
  }
});

// ===================================================================== fuel

test('fuel: paid at the pump goes to the fueler, shares to the payers, the admin pays nothing and his kilometres are left out of the split', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-04-02T08:00:00.000Z', 1000, 60);
    drive(h, h.ben.id, '2026-04-03T08:00:00.000Z', 1060, 20);
    drive(h, h.admin.id, '2026-04-04T08:00:00.000Z', 1080, 100); // the admin drives most, and pays nothing
    drive(h, h.ben.id, '2026-04-05T08:00:00.000Z', 1180, 40, { kmFor: 'together' });
    insertFuel(h.t, { userId: h.admin.id, at: '2026-04-10T08:00:00.000Z', millilitres: 40_000, totalCents: 8000, odometer: 1220 });
    const r = await get(h.anna, '?from=2026-04&to=2026-04');
    const april = monthOf(r, '2026-04');
    assert.deepEqual(april.household && [april.household.fillUps, april.household.millilitres, april.household.paidCents, april.household.shareCents], [1, 40_000, 8000, 8000], 'the admin fuelled and is owed it all');
    assert.equal(personOf(april, h.admin.id).paidCents, 8000);
    assert.equal(personOf(april, h.admin.id).shareCents, 0, 'the admin has no share');
    // anna 60 km and ben 20 km split 80 EUR 3:1 (the together pool follows the same ratio); the admin's 100 km are left out.
    assert.equal(personOf(april, h.anna.id).shareCents, 6000);
    assert.equal(personOf(april, h.ben.id).shareCents, 2000);
    assert.equal(personOf(april, h.admin.id).km, 100, 'but his kilometres are kilometres');
    assert.equal(personOf(april, h.admin.id).costKm, 0);
    assert.equal(april.household?.costCents, 8000);
    assert.equal(april.household?.costKm, 80, 'personal kilometres that were split');
    assert.equal(april.household?.poolKm, 40, 'plus the together pool of the same period');
    // 8000 cents over 120 km = 66,667 thousandths of a euro per km, rounded: 67 per tenth of a cent... fixed scale: thousandths.
    assert.equal(april.household?.costPerKmMillis, 667);
    assert.equal(april.household?.pricePerLitreMillis, 2000);
  } finally {
    await h.t.close();
  }
});

test('fuel: nobody drove in the period, so the cost is split equally over the people who pay and the cost per kilometre is not computed', async () => {
  const h = await household();
  try {
    insertFuel(h.t, { userId: h.anna.id, at: '2026-04-10T08:00:00.000Z', millilitres: 30_000, totalCents: 9000 });
    const april = monthOf(await get(h.anna, '?from=2026-04&to=2026-04'), '2026-04');
    assert.deepEqual(april.people.map((p) => [p.userId, p.shareCents]), [[h.anna.id, 3000], [h.ben.id, 3000], [h.carla.id, 3000]], 'anna, ben and carla; not the admin');
    assert.equal(april.household?.shareCents, 9000);
    assert.equal(april.household?.costCents, 0);
    assert.equal(april.household?.costPerKmMillis, null);
  } finally {
    await h.t.close();
  }
});

test('fuel: the share of a fill-up and what goes with it belong to the month of the fill-up, also when the period reaches back into the month before', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-03-10T08:00:00.000Z', 900, 10); // the first fill-up is all hers
    insertFuel(h.t, { userId: h.anna.id, at: '2026-03-20T08:00:00.000Z', totalCents: 5000 });
    drive(h, h.ben.id, '2026-03-25T08:00:00.000Z', 1000, 50); // in March, but paid for by the April fill-up
    drive(h, h.carla.id, '2026-04-02T08:00:00.000Z', 1050, 50);
    insertFuel(h.t, { userId: h.anna.id, at: '2026-04-05T08:00:00.000Z', totalCents: 10_000 });
    const r = await get(h.anna, '?from=2026-03&to=2026-04');
    assert.equal(monthOf(r, '2026-03').household?.paidCents, 5000);
    const april = monthOf(r, '2026-04');
    assert.equal(personOf(april, h.ben.id).shareCents, 5000, 'ben drove in March, his share is in April');
    assert.equal(personOf(april, h.carla.id).shareCents, 5000);
    assert.equal(personOf(monthOf(r, '2026-03'), h.ben.id).shareCents, 0, 'nothing is owed in March: the fill-up that pays for it is April\'s');
    assert.equal(personOf(monthOf(r, '2026-03'), h.ben.id).km, 50, 'the kilometres themselves stay in March');
    assert.equal(personOf(april, h.ben.id).costKm, 50, 'the kilometres that the April share was split over');
  } finally {
    await h.t.close();
  }
});

test('fuel: consumption comes from consecutive readings only, in the month of the later fill-up', async () => {
  const h = await household();
  try {
    const fill = (at: string, ml: number, odometer: number | null): number => insertFuel(h.t, { userId: h.anna.id, at, millilitres: ml, odometer });
    fill('2026-02-01T08:00:00.000Z', 40_000, 10_000); // the first one has nothing before it
    fill('2026-03-01T08:00:00.000Z', 36_000, 10_600); // 36 L over 600 km: 6.00 L/100 km, in March
    fill('2026-04-01T08:00:00.000Z', 30_000, null); // a legacy fill-up without a reading: no interval
    fill('2026-05-01T08:00:00.000Z', 35_000, 11_300); // the one before has no reading: unknown, skipped
    fill('2026-05-10T08:00:00.000Z', 20_000, 11_300); // zero kilometres: skipped
    fill('2026-05-20T08:00:00.000Z', 10_000, 11_100); // the odometer went down: skipped
    fill('2026-06-01T08:00:00.000Z', 45_000, 11_900); // 45 L over 800 km (previous 11_100): 5.625, rounded half up to 5.63
    const r = await get(h.anna, '?from=2026-02&to=2026-06');
    const hh = (k: string): StatsMonthDto['household'] => monthOf(r, k).household;
    assert.deepEqual([hh('2026-02')?.consumptionMl, hh('2026-02')?.consumptionKm, hh('2026-02')?.consumptionHundredths], [0, 0, null]);
    assert.deepEqual([hh('2026-03')?.consumptionMl, hh('2026-03')?.consumptionKm, hh('2026-03')?.consumptionHundredths], [36_000, 600, 600]);
    assert.deepEqual([hh('2026-04')?.consumptionKm, hh('2026-05')?.consumptionKm], [0, 0]);
    assert.deepEqual([hh('2026-06')?.consumptionMl, hh('2026-06')?.consumptionKm, hh('2026-06')?.consumptionHundredths], [45_000, 800, 563]);
    assert.ok(monthOf(r, '2026-03').people.every((p) => p.consumptionKm === 0 && p.consumptionHundredths === null), 'consumption is the household\'s');
  } finally {
    await h.t.close();
  }
});

test('the ratios are whole numbers with a fixed scale, rounded half up, and null when there is nothing to divide by', () => {
  const t = emptyTotals();
  assert.deepEqual([entryOf(t).pricePerLitreMillis, entryOf(t).costPerKmMillis, entryOf(t).consumptionHundredths], [null, null, null]);
  // 7000 cents for 38,5 L: 181,818 cents per litre... 1,818 EUR/L = 1818 thousandths.
  assert.equal(entryOf({ ...t, paidCents: 7000, millilitres: 38_500 }).pricePerLitreMillis, 1818);
  assert.equal(entryOf({ ...t, paidCents: 1, millilitres: 2000 }).pricePerLitreMillis, 5, '0,5 cent a litre: 5 thousandths');
  assert.equal(entryOf({ ...t, costCents: 1000, costKm: 150, poolKm: 50 }).costPerKmMillis, 50, '10 EUR over 200 km: 0,050 EUR/km');
  assert.equal(entryOf({ ...t, costCents: 1, costKm: 3 }).costPerKmMillis, 3, '1 cent over 3 km: 3,33 thousandths, rounded');
  assert.equal(entryOf({ ...t, costCents: 5, costKm: 0, poolKm: 0 }).costPerKmMillis, null);
  assert.equal(entryOf({ ...t, consumptionMl: 40_000, consumptionKm: 500 }).consumptionHundredths, 800, '40 L over 500 km is 8,00 L/100 km');
  assert.equal(entryOf({ ...t, km: 10, togetherKm: 5 }).totalKm, 15);
  for (const key of ['pricePerLitreMillis', 'costPerKmMillis', 'consumptionHundredths'] as const) {
    const v = entryOf({ ...t, paidCents: 12_345, millilitres: 6_789, costCents: 4_321, costKm: 77, consumptionMl: 3_333, consumptionKm: 41 })[key];
    assert.ok(Number.isInteger(v), `${key} is an integer`);
  }
});

test('the components in the code and the columns of the stored table are the same list', async () => {
  const t = await createTestApp();
  try {
    const columns = many<{ name: string }>(t.db, 'PRAGMA table_info(stats_totals)').map((c) => c.name);
    assert.deepEqual(columns, ['month', 'user_id', ...TOTAL_FIELDS.map(columnOf)]);
    assert.equal(columnOf('togetherKm'), 'together_km');
    assert.equal(columnOf('unaccountedKm'), 'unaccounted_km');
    assert.equal(new Set(TOTAL_FIELDS).size, TOTAL_FIELDS.length);
  } finally {
    await t.close();
  }
});

// =============================== the numbers equal what the screens say (the Fuel tab and the Drives tab)

/** A small deterministic random generator (mulberry32), so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: per month, the shares, the paid cents and the fill-ups equal the Fuel screen, and the trips and kilometres equal the Drives tab (50 seeded households)', async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const random = rng(seed);
    const int = (n: number): number => Math.floor(random() * n);
    const t = await createTestApp({ now: NOW });
    try {
      const admin = await t.signIn('admin', 'admin');
      const anna = await t.signIn('anna');
      const ids = [admin.id, anna.id, (await t.signIn('ben')).id, (await t.signIn('carla')).id, (await t.signIn('dora')).id];
      // People who come and go: one deactivated user, sometimes a second admin.
      if (random() < 0.5) run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', ids[4] as number);
      if (random() < 0.3) run(t.db, "UPDATE users SET role = 'admin' WHERE id = ?", ids[3] as number);
      const start = Date.parse('2026-01-01T06:00:00.000Z');
      let odometer = 10_000;
      let cursor = start;
      const drives = 12 + int(30);
      const fills = 3 + int(8);
      const events: Array<{ at: number; fuel: boolean }> = [
        ...Array.from({ length: drives }, () => ({ at: start + int(160 * 24) * 3_600_000 + int(60) * 60_000, fuel: false })),
        ...Array.from({ length: fills }, () => ({ at: start + int(160 * 24) * 3_600_000 + 30 * 60_000, fuel: true })),
      ].sort((a, b) => a.at - b.at);
      for (const ev of events) {
        cursor = Math.max(cursor + 3_600_000, ev.at);
        const when = new Date(cursor).toISOString();
        if (ev.fuel) {
          insertFuel(t, { userId: ids[int(ids.length)] as number, at: when, millilitres: 20_000 + int(30_000), totalCents: 3_000 + int(9_000), odometer: random() < 0.8 ? odometer : null });
        } else {
          const km = int(120);
          const kind = random();
          const driver = ids[int(ids.length)] as number;
          insertUsage(t, {
            userId: driver,
            start: when,
            end: new Date(cursor + 1_800_000).toISOString(),
            odometerStart: random() < 0.9 ? odometer : null,
            odometerEnd: random() < 0.9 ? odometer + km : null,
            kmFor: kind < 0.15 ? 'together' : kind < 0.3 ? 'person' : 'self',
            ...(kind >= 0.15 && kind < 0.3 ? { kmUserId: ids[(ids.indexOf(driver) + 1) % ids.length] as number } : {}),
          });
          odometer += km;
          cursor += 1_800_000;
        }
      }
      // A draft that must not count.
      insertDraft(t, { userId: ids[1] as number, start: new Date(cursor + 7_200_000).toISOString(), odometerStart: odometer });

      const report = await get(admin, '?from=2026-01&to=2026-06');
      const fuel = (await admin.get('/api/fuel')).body.items as Json[];
      for (const m of report.months) {
        const items = fuel.filter((f) => monthKey(f.at as string) === m.month);
        const label = `seed ${seed}, ${m.month}`;
        assert.equal(m.household?.fillUps ?? 0, items.length, `${label}: fill-ups`);
        assert.equal(m.household?.paidCents ?? 0, items.reduce((n, f) => n + (f.totalCents as number), 0), `${label}: paid`);
        assert.equal(m.household?.millilitres ?? 0, items.reduce((n, f) => n + (f.millilitres as number), 0), `${label}: litres`);
        const shares = new Map<number, number>();
        for (const f of items) for (const s of f.shares as Json[]) shares.set(s.userId, (shares.get(s.userId) ?? 0) + s.cents);
        for (const id of ids) {
          assert.equal(personOf(m, id)?.shareCents ?? 0, shares.get(id) ?? 0, `${label}: share of user ${id}`);
        }
        const roles = new Map(many<{ id: number; role: string }>(t.db, 'SELECT id, role FROM users').map((u) => [u.id, u.role]));
        for (const [id, cents] of shares) if (roles.get(id) === 'admin') assert.equal(cents, 0, `${label}: an admin pays nothing`);
        assert.equal(m.household?.shareCents ?? 0, [...shares.values()].reduce((a, b) => a + b, 0), `${label}: household shares`);
      }
      // The Drives tab: trips and kilometres over the whole window are the sum of the months.
      const summary = (await admin.get('/api/usage/summary?from=2025-12-15T00:00:00.000Z&to=2026-12-15T00:00:00.000Z')).body as Json;
      const sum = (pick: (m: StatsMonthDto) => number): number => report.months.reduce((n, m) => n + pick(m), 0);
      assert.equal(sum((m) => m.household?.trips ?? 0), summary.totalTrips, `seed ${seed}: trips`);
      assert.equal(sum((m) => m.household?.totalKm ?? 0), summary.totalKm, `seed ${seed}: kilometres`);
      assert.equal(sum((m) => m.household?.togetherKm ?? 0), summary.together.km, `seed ${seed}: together kilometres`);
      for (const p of summary.items as Json[]) {
        assert.equal(sum((m) => personOf(m, p.userId)?.km ?? 0), p.km, `seed ${seed}: kilometres of user ${p.userId}`);
        assert.equal(sum((m) => personOf(m, p.userId)?.trips ?? 0), p.trips, `seed ${seed}: trips of user ${p.userId}`);
      }
    } finally {
      await t.close();
    }
  }
});

function monthKey(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date(instant));
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

// ===================================================================== source and docs

test('the statistics reuse fuelOverview and computeShares: there is no second split in stats.ts, and fuel.ts is not touched by it', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'stats.ts'), 'utf8');
  assert.match(source, /fuelOverview\(db, SYSTEM_PRINCIPAL\)/);
  assert.doesNotMatch(source, /splitCents\(|computeShares\(/, 'stats.ts never splits money itself');
  const fuelSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'fuel.ts'), 'utf8');
  assert.doesNotMatch(fuelSource, /stats\.ts|computeMonths/, 'the fuel module does not know about the statistics');
});

test('docs/STATS-API.md names every field of the real response, and every field it names exists', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-05-10T08:00:00.000Z', 1000, 100);
    const r = await get(h.anna);
    const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'STATS-API.md'), 'utf8');
    const may = monthOf(r, '2026-05');
    const real = new Set<string>([
      ...Object.keys(r),
      ...Object.keys(r.users[0] as object),
      ...Object.keys(may),
      ...Object.keys(may.household as object),
      ...Object.keys(may.people[0] as object),
      ...Object.keys(r.range),
    ]);
    for (const key of real) assert.match(doc, new RegExp(`\`${key}\``), `the document names ${key}`);
    // Every name in a table row of the field lists is real.
    const listed = [...doc.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1] as string);
    assert.ok(listed.length >= TOTAL_FIELDS.length);
    for (const key of listed) assert.ok(real.has(key), `the document names ${key}, which the response does not have`);
    for (const field of TOTAL_FIELDS) assert.ok(listed.includes(field), `the component ${field} is described`);
    // The example in the document is the shape of the real answer.
    // A checkout with CRLF line endings (windows-latest) must find it too.
    const example = /```json\r?\n([\s\S]*?)\r?\n```/.exec(doc);
    assert.ok(example, 'the document has a JSON example');
    const parsed = JSON.parse(example[1] as string) as Json;
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(r).sort(), 'the example has the keys of the response');
    assert.deepEqual(Object.keys(parsed.months[0]).sort(), Object.keys(may).sort());
    assert.deepEqual(Object.keys(parsed.months[0].household).sort(), Object.keys(may.household as object).sort());
    assert.equal(parsed.version, 1);
  } finally {
    await h.t.close();
  }
});

// ===================================================================== performance

test('performance: a household with about 3,000 drives answers GET /api/stats well inside the budget', async () => {
  const h = await household();
  try {
    const ids = [h.admin.id, h.anna.id, h.ben.id, h.carla.id];
    const base = Date.parse('2025-12-20T06:00:00.000Z');
    let odometer = 1000;
    h.t.db.exec('BEGIN');
    for (let i = 0; i < 3000; i++) {
      const start = new Date(base + i * 4_000_000).toISOString();
      const end = new Date(base + i * 4_000_000 + 1_800_000).toISOString();
      insertUsage(h.t, { userId: ids[i % 4] as number, start, end, odometerStart: odometer, odometerEnd: odometer + 7, kmFor: i % 11 === 0 ? 'together' : 'self' });
      odometer += 7 + (i % 50 === 0 ? 3 : 0); // a little gap now and then
    }
    for (let i = 0; i < 150; i++) {
      insertFuel(h.t, { userId: ids[i % 4] as number, at: new Date(base + i * 80_000_000 + 600_000).toISOString(), odometer: 1000 + i * 150 });
    }
    for (let i = 0; i < 60; i++) insertTicket(h.t, { userId: h.anna.id, at: new Date(base + i * 200_000_000).toISOString(), amountCents: 5000 });
    for (let i = 0; i < 40; i++) insertDamage(h.t, { reportedBy: ids[i % 4] as number, noticedOn: '2026-03-01' });
    h.t.db.exec('COMMIT');
    const t0 = performance.now();
    const months = computeMonths(h.t.db, TZ);
    const compute = performance.now() - t0;
    const t1 = performance.now();
    const res = await h.anna.get('/api/stats?from=2024-07&to=2026-06');
    const request = performance.now() - t1;
    assert.equal(res.status, 200);
    assert.ok(months.size > 3);
    const trips = (res.body as StatsReport).months.reduce((n, m) => n + (m.household?.trips ?? 0), 0);
    assert.equal(trips, 3000);
    console.log(`# stats performance: computeMonths ${compute.toFixed(0)} ms, GET /api/stats ${request.toFixed(0)} ms (3,000 drives, 150 fill-ups, 60 tickets, 40 damage reports)`);
    assert.ok(compute < 1500, `computeMonths took ${compute.toFixed(0)} ms (target 250, hard limit 1500)`);
    assert.ok(request < 1500, `GET /api/stats took ${request.toFixed(0)} ms (target 400, hard limit 1500)`);
  } finally {
    await h.t.close();
  }
});

test('statsReport on its own is the seam a token API can call: no request, no user', async () => {
  const h = await household();
  try {
    drive(h, h.anna.id, '2026-05-10T08:00:00.000Z', 1000, 100);
    const direct = statsReport(h.t.db, h.t.config, h.t.clock.now(), { from: '2026-05', to: '2026-06' });
    const viaHttp = await get(h.ben, '?from=2026-05&to=2026-06');
    assert.deepEqual(JSON.parse(JSON.stringify(direct)), viaHttp);
    insertApk(h.t, { userId: h.anna.id, expiresOn: '2027-01-01' }); // unrelated data does not matter
  } finally {
    await h.t.close();
  }
});
