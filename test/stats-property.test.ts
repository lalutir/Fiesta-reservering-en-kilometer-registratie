import { test } from 'node:test';
import assert from 'node:assert/strict';
import { many, run } from '../src/db.ts';
import { loadChain } from '../src/odometer.ts';
import { purge } from '../src/retention.ts';
import { computeMonths, monthSignature, statsReport, type StatsMonthDto, type StatsReport } from '../src/stats.ts';
import { addMonthKey, monthKeyOf } from '../shared/time.js';
import { createHousehold, createTestApp, insertDamage, insertDraft, insertFuel, insertReservation, insertTicket, insertUsage, type Client, type Json, type TestApp } from './helpers.ts';

// Properties of the monthly statistics over many seeded households, and the edges that the
// example tests of stats.test.ts and stats-retention.test.ts do not reach: every kind of record at
// the edge of a local month, a gap whose earlier reading the purge removes, and the read-only API.

const TZ = 'Europe/Amsterdam';
const NOW = '2026-06-15T10:00:00.000Z';
const HOUR = 3_600_000;

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

/** The month a stored instant falls in, in the household zone, worked out here and not with the code under test. */
function monthKey(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date(instant));
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ----------------------------------------------------------------------------- a random household

interface World {
  t: TestApp;
  /** The signed-in admin. */
  admin: Client;
  /** user ids; the first is the admin. */
  ids: number[];
  random: () => number;
  /** The odometer after the last drive, and the time of the last drive or fill-up: the next ones come after. */
  odometer: number;
  cursor: number;
  /** Users with an open draft (one per person). */
  drafts: Set<number>;
}

const int = (w: World, n: number): number => Math.floor(w.random() * n);
const pick = <T>(w: World, list: readonly T[]): T => list[int(w, list.length)] as T;

/**
 * Adds `count` random records at random moments in [fromMs, toMs): drives (with gaps and mismatches between
 * their readings now and then, and every kind of kilometre owner), fill-ups, tickets, reservations that tickets
 * can fall in, damage reports (some repaired) and, rarely, an open draft. Drives and fill-ups follow each other
 * in time, so the odometer chain is one line through time; nothing is placed after `toMs`.
 */
function addEvents(w: World, fromMs: number, toMs: number, count: number): void {
  const { t } = w;
  const times = Array.from({ length: count }, () => fromMs + Math.floor(w.random() * (toMs - fromMs))).sort((a, b) => a - b);
  for (const raw of times) {
    const r = w.random();
    if (r < 0.14) {
      const at = Math.max(raw, w.cursor + 60_000);
      if (at > toMs) continue;
      insertFuel(t, { userId: pick(w, w.ids), at: iso(at), millilitres: 20_000 + int(w, 30_000), totalCents: 3_000 + int(w, 9_000), odometer: w.random() < 0.8 ? w.odometer : null });
      w.cursor = at;
    } else if (r < 0.24) {
      insertTicket(t, { userId: pick(w, w.ids), at: iso(raw), amountCents: w.random() < 0.7 ? 1 + int(w, 20_000) : null });
    } else if (r < 0.31) {
      if (raw + 2 * HOUR <= toMs) insertReservation(t, { userId: pick(w, w.ids), start: iso(raw), end: iso(raw + 2 * HOUR) });
    } else if (r < 0.38) {
      const repaired = w.random() < 0.3;
      const day = iso(raw).slice(0, 10);
      insertDamage(t, { reportedBy: pick(w, w.ids), noticedOn: day, ...(repaired ? { repairedOn: day } : {}) });
    } else if (r < 0.4) {
      const userId = pick(w, w.ids);
      const at = Math.max(raw, w.cursor + HOUR);
      if (w.drafts.has(userId) || at > toMs) continue;
      insertDraft(t, { userId, start: iso(at), odometerStart: w.odometer });
      w.drafts.add(userId);
      w.cursor = at;
    } else {
      const at = Math.max(raw, w.cursor + HOUR);
      if (at + 1_800_000 > toMs) continue;
      const jump = w.random() < 0.12 ? 1 + int(w, 60) : w.random() < 0.05 ? -(1 + int(w, 30)) : 0; // a gap, or readings that contradict
      const from = Math.max(0, w.odometer + jump);
      const km = int(w, 150);
      const driver = pick(w, w.ids);
      const owner = w.random();
      const other = w.ids[(w.ids.indexOf(driver) + 1 + int(w, w.ids.length - 1)) % w.ids.length] as number;
      insertUsage(t, {
        userId: driver,
        start: iso(at),
        end: iso(at + 1_800_000),
        odometerStart: w.random() < 0.93 ? from : null,
        odometerEnd: w.random() < 0.93 ? from + km : null,
        kmFor: owner < 0.15 ? 'together' : owner < 0.3 ? 'person' : 'self',
        ...(owner >= 0.15 && owner < 0.3 ? { kmUserId: other } : {}),
      });
      w.odometer = from + km;
      w.cursor = at + 1_800_000;
    }
  }
}

/** An admin and four members (accounts dated `created`), one of whom may be deactivated and one may be a second admin. */
async function makeWorld(seed: number, now: string, created: string, people = true): Promise<World> {
  const random = rng(seed);
  const t = await createTestApp({ now });
  const admin = await t.signIn('admin', 'admin');
  const ids = [admin.id, ...(await Promise.all(['anna', 'ben', 'carla', 'dora'].map(async (n) => (await t.signIn(n)).id)))];
  run(t.db, 'UPDATE users SET created_at = ?', created);
  if (people) {
    if (random() < 0.5) run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', ids[4] as number);
    if (random() < 0.3) run(t.db, "UPDATE users SET role = 'admin' WHERE id = ?", ids[3] as number);
  }
  return { t, admin, ids, random, odometer: 10_000, cursor: Date.parse(created), drafts: new Set() };
}

// ------------------------------------------------------------------------ the purge changes no month

const numbersOf = (m: StatsMonthDto): Json => ({ unavailable: m.unavailable, household: m.household, people: m.people });

/**
 * THE key trap of the feature, as a property: the purge deletes rows on a cutoff that rolls every day, and a month
 * can change without losing a row of its own (a fill-up whose earlier fill-up went has a shorter period, a gap
 * loses its earlier reading, an explanation goes). Whatever happens, one purge must never change the numbers of
 * a month that is over, and nothing but new records may change them between two purges.
 * Households are simulated day by day over five months with records added as the clock moves; half of them
 * are on a database that was already older than the window when the statistics arrived (legacy months).
 */
test('property: a purge never changes the numbers of a month that is over, and neither does the passing of time (10 seeded households, rolling daily purges)', async () => {
  let protectedByFreezing = 0;
  let frozenEver = 0;
  let explained = 0;
  let steps = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const legacy = seed % 2 === 0;
    const w = await makeWorld(seed, '2026-01-10T10:00:00.000Z', legacy ? '2025-01-05T08:00:00.000Z' : '2025-07-15T08:00:00.000Z');
    const { t } = w;
    try {
      addEvents(w, Date.parse('2025-07-15T09:00:00.000Z'), Date.parse('2026-01-10T10:00:00.000Z'), 40 + int(w, 40));
      let prevAfter: StatsReport | undefined;
      let prevCurrent = '';
      let clock = Date.parse('2026-01-10T10:00:00.000Z');
      while (clock <= Date.parse('2026-06-12T10:00:00.000Z')) {
        const now = new Date(clock);
        t.clock.set(now.toISOString());
        const current = monthKeyOf(now, TZ);
        const range = { from: addMonthKey(current, -23), to: current };
        const label = `seed ${seed} (${legacy ? 'legacy' : 'young'}), ${now.toISOString()}`;
        const touched = new Set<string>();

        // The records of the days since the last step, and now and then somebody explains a gap.
        if (w.random() < 0.35) {
          const gaps = loadChain(t.db, '').items.filter((i) => i.kind === 'gap');
          if (gaps.length > 0) {
            const gap = pick(w, gaps);
            run(t.db, 'INSERT OR IGNORE INTO odometer_explained (item_key, prev_at, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', gap.key, gap.prev.at, 'an outsider drove', w.ids[1] as number, now.toISOString(), now.toISOString());
            touched.add(monthKeyOf(gap.next.at, TZ));
            explained++;
          }
        }

        const before = statsReport(t.db, t.config, now, range);
        // Time alone changes nothing: a month that was over at the last step reads as it did after that step's purge.
        if (prevAfter) {
          for (const m of before.months) {
            if (m.month >= prevCurrent || touched.has(m.month)) continue;
            const was: StatsMonthDto | undefined = prevAfter.months.find((x) => x.month === m.month);
            assert.deepEqual(numbersOf(m), numbersOf(was as StatsMonthDto), `${label}: ${m.month} changed between two purges`);
          }
        }

        const liveBefore = computeMonths(t.db, TZ);
        purge(t.db, now, TZ, t.ctx.log, 6, 24);
        const liveAfter = computeMonths(t.db, TZ);
        const after = statsReport(t.db, t.config, now, range);

        for (const [i, b] of before.months.entries()) {
          const a = after.months[i] as StatsMonthDto;
          assert.equal(a.month, b.month);
          if (a.provisional) continue;
          assert.deepEqual(numbersOf(a), numbersOf(b), `${label}: the purge changed ${a.month}`);
          if (b.frozen) assert.equal(a.frozen, true, `${label}: ${a.month} was stored and must stay stored`);
          // Count the months where freezing mattered: what is left would say something else.
          if (monthSignature(liveBefore.get(a.month)) !== monthSignature(liveAfter.get(a.month))) {
            protectedByFreezing++;
            assert.equal(a.frozen, true, `${label}: ${a.month} changed under the purge and must be stored`);
          }
        }
        frozenEver += after.months.filter((m) => m.frozen).length;

        prevAfter = after;
        prevCurrent = current;
        steps++;
        // The next records are added in the days up to the next step.
        const next = clock + (3 + int(w, 8)) * 24 * HOUR;
        addEvents(w, clock + 1, next, int(w, 5));
        clock = next;
      }
    } finally {
      await t.close();
    }
  }
  console.log(`# stats purge property: ${steps} daily purges, ${protectedByFreezing} past months changed by a purge and stored in time, ${explained} gaps explained`);
  // The property is not vacuous: purges did change months, gaps were explained, and months were stored.
  assert.ok(steps > 200, `${steps} steps`);
  assert.ok(protectedByFreezing > 20, `the purge changed ${protectedByFreezing} past months that were stored in time`);
  assert.ok(frozenEver > 200 && explained > 10, `${frozenEver} stored months seen, ${explained} explanations`);
});

// -------------------------------------------------------------- the numbers equal what other screens say

test('property: tickets, the fuel split details, unaccounted kilometres and damage reports equal the Tickets, Fuel and Drives screens, and household = the rows (25 seeded households)', async () => {
  for (let seed = 101; seed <= 125; seed++) {
    const w = await makeWorld(seed, NOW, '2025-12-20T08:00:00.000Z');
    const { t } = w;
    try {
      const { admin } = w;
      addEvents(w, Date.parse('2026-01-01T06:00:00.000Z'), Date.parse('2026-06-14T12:00:00.000Z'), 50 + int(w, 70));
      // Some gaps explained through the API, like on the Drives screen.
      for (const item of ((await admin.get('/api/odometer')).body.items as Json[]).filter((i) => i.kind === 'gap')) {
        if (w.random() < 0.4) assert.equal((await admin.post('/api/odometer/explain', { key: item.key, note: 'an outsider drove' })).status, 201);
      }

      const res = await admin.get('/api/stats?from=2026-01&to=2026-06');
      assert.equal(res.status, 200, res.text);
      const report = res.body as StatsReport;
      const tickets = (await admin.get('/api/tickets')).body.items as Json[];
      const fills = [...((await admin.get('/api/fuel')).body.items as Json[])].reverse(); // oldest first
      const gaps = ((await admin.get('/api/odometer')).body.items as Json[]).filter((i) => i.kind === 'gap' && i.explained === null);
      const damage = many<{ noticed_on: string; reported_by: number }>(t.db, 'SELECT noticed_on, reported_by FROM damage_reports');

      for (const m of report.months) {
        const label = `seed ${seed}, ${m.month}`;
        const person = (id: number): Json => m.people.find((p) => p.userId === id);
        const hh = m.household as NonNullable<StatsMonthDto['household']>;

        // Tickets: the driver the Tickets screen names, or the household when nobody is on record.
        for (const id of w.ids) {
          const mine = tickets.filter((x) => monthKey(x.at) === m.month && (x.driver?.id ?? 0) === id);
          assert.equal(person(id)?.tickets ?? 0, mine.length, `${label}: tickets of user ${id}`);
          assert.equal(person(id)?.ticketCents ?? 0, mine.reduce((n, x) => n + ((x.amountCents as number | null) ?? 0), 0), `${label}: ticket euros of user ${id}`);
        }
        const inMonth = tickets.filter((x) => monthKey(x.at) === m.month);
        assert.equal(hh.tickets, inMonth.length, `${label}: tickets of the household`);
        assert.equal(hh.ticketCents, inMonth.reduce((n, x) => n + ((x.amountCents as number | null) ?? 0), 0), `${label}: ticket euros of the household`);

        // Fuel: the kilometres the shares were split over, the pool, and the consumption between fill-ups.
        const items = fills.filter((f) => monthKey(f.at) === m.month);
        for (const id of w.ids) {
          const shares = items.flatMap((f) => (f.shares as Json[]).filter((s) => s.userId === id && s.km > 0));
          assert.equal(person(id)?.costCents ?? 0, shares.reduce((n, s) => n + s.cents, 0), `${label}: cost cents of user ${id}`);
          assert.equal(person(id)?.costKm ?? 0, shares.reduce((n, s) => n + s.km, 0), `${label}: cost kilometres of user ${id}`);
          assert.equal(person(id)?.paidCents ?? 0, items.filter((f) => f.userId === id).reduce((n, f) => n + f.totalCents, 0), `${label}: paid at the pump by user ${id}`);
        }
        assert.equal(hh.poolKm, items.filter((f) => !f.equalSplit).reduce((n, f) => n + f.togetherKm, 0), `${label}: the together pool`);
        let consumptionMl = 0;
        let consumptionKm = 0;
        fills.forEach((f, i) => {
          const prev = fills[i - 1];
          if (monthKey(f.at) === m.month && prev && prev.odometer !== null && f.odometer !== null && f.odometer > prev.odometer) {
            consumptionMl += f.millilitres;
            consumptionKm += f.odometer - prev.odometer;
          }
        });
        assert.deepEqual([hh.consumptionMl, hh.consumptionKm], [consumptionMl, consumptionKm], `${label}: consumption`);

        // Unaccounted kilometres: the open gaps of the Drives screen, in the month of their later reading.
        assert.equal(hh.unaccountedKm, gaps.filter((g) => monthKey(g.next.at) === m.month).reduce((n, g) => n + g.km, 0), `${label}: unaccounted kilometres`);

        // Damage reports: by the day noticed, to whoever filed them.
        for (const id of w.ids) {
          assert.equal(person(id)?.damageReports ?? 0, damage.filter((d) => d.noticed_on.startsWith(m.month) && d.reported_by === id).length, `${label}: damage reports of user ${id}`);
        }

        // The household is the sum of the rows. These components live on people only; these on the household row only.
        const sum = (f: string): number => m.people.reduce((n, p) => n + ((p as Json)[f] as number), 0);
        for (const f of ['trips', 'km', 'fillUps', 'millilitres', 'paidCents', 'shareCents', 'costCents', 'costKm', 'damageReports'] as const) {
          assert.equal(hh[f], sum(f), `${label}: household ${f} is the sum of the people`);
        }
        for (const f of ['togetherKm', 'poolKm', 'consumptionMl', 'consumptionKm', 'unaccountedKm'] as const) {
          assert.equal(sum(f), 0, `${label}: ${f} is on the household row, never on a person`);
        }
        assert.ok(hh.tickets >= sum('tickets') && hh.ticketCents >= sum('ticketCents'), `${label}: tickets without a driver only add to the household`);
        // Every ratio is a whole number or null, and null exactly when its denominator is zero.
        assert.equal(hh.pricePerLitreMillis === null, hh.millilitres === 0, `${label}: price per litre`);
        assert.equal(hh.costPerKmMillis === null, hh.costKm + hh.poolKm === 0, `${label}: cost per km`);
        assert.equal(hh.consumptionHundredths === null, hh.consumptionKm === 0, `${label}: consumption`);
      }
    } finally {
      await t.close();
    }
  }
});

// ------------------------------------------------------------------------------- the edges of a month

test('every kind of record sits in the month of its local midnight: fill-ups, tickets, damage reports and the later reading of a gap (CEST and CET edges)', async () => {
  const h = await createHousehold({ now: '2026-11-20T10:00:00.000Z' });
  try {
    run(h.t.db, 'UPDATE users SET created_at = ?', '2025-11-01T08:00:00.000Z');
    const { t, anna } = h;
    // 23:59:59.999 on the last day, and 00:00:00.000 on the first, in summer time (31 March) and in winter time (31 October).
    const edges = [
      ['2026-03-31T21:59:59.999Z', '2026-03'],
      ['2026-03-31T22:00:00.000Z', '2026-04'],
      ['2026-10-31T22:59:59.999Z', '2026-10'],
      ['2026-10-31T23:00:00.000Z', '2026-11'],
    ] as const;
    edges.forEach(([at], i) => {
      insertFuel(t, { userId: anna.id, at, millilitres: 10_000, totalCents: 1000 * (i + 1) });
      insertTicket(t, { userId: anna.id, at, amountCents: 100 * (i + 1) });
    });
    // A calendar date has no zone: the day is the month.
    for (const noticedOn of ['2026-03-31', '2026-04-01', '2026-10-31', '2026-11-01']) insertDamage(t, { reportedBy: anna.id, noticedOn });
    const r = (await anna.get('/api/stats?from=2026-03&to=2026-11')).body as StatsReport;
    const hh = (key: string): NonNullable<StatsMonthDto['household']> => (r.months.find((m) => m.month === key) as StatsMonthDto).household as NonNullable<StatsMonthDto['household']>;
    assert.deepEqual(['2026-03', '2026-04', '2026-10', '2026-11'].map((k) => hh(k).paidCents), [1000, 2000, 3000, 4000], 'fill-ups');
    assert.deepEqual(['2026-03', '2026-04', '2026-10', '2026-11'].map((k) => [hh(k).tickets, hh(k).ticketCents]), [[1, 100], [1, 200], [1, 300], [1, 400]], 'tickets');
    assert.deepEqual(['2026-03', '2026-04', '2026-10', '2026-11'].map((k) => hh(k).damageReports), [1, 1, 1, 1], 'damage reports');
    // (The months in between are quiet; this household is on an old database, so some of them read "not available" and the rest zero.)
    const between = r.months.filter((m) => !['2026-03', '2026-04', '2026-10', '2026-11'].includes(m.month));
    assert.equal(between.length, 5);
    assert.ok(between.every((m) => (m.household?.fillUps ?? 0) + (m.household?.tickets ?? 0) + (m.household?.damageReports ?? 0) === 0), 'nothing leaks into the months between');

    // A gap belongs to the month of its LATER reading: the fill-up one millisecond before midnight, and the drive at midnight.
    run(t.db, 'DELETE FROM fuel');
    insertUsage(t, { userId: anna.id, start: '2026-03-20T08:00:00.000Z', end: '2026-03-20T09:00:00.000Z', odometerStart: 100, odometerEnd: 200 });
    insertUsage(t, { userId: anna.id, start: '2026-03-31T20:00:00.000Z', end: '2026-03-31T21:00:00.000Z', odometerStart: 200, odometerEnd: 260 });
    insertFuel(t, { userId: anna.id, at: '2026-03-31T21:59:59.999Z', odometer: 300 }); // 40 km unaccounted, 23:59:59.999 on 31 March
    insertUsage(t, { userId: anna.id, start: '2026-03-31T22:00:00.000Z', end: '2026-03-31T23:00:00.000Z', odometerStart: 350, odometerEnd: 360 }); // 50 km unaccounted, 00:00 on 1 April
    const g = (await anna.get('/api/stats?from=2026-03&to=2026-04')).body as StatsReport;
    assert.deepEqual(g.months.map((m) => [m.month, m.household?.unaccountedKm]), [['2026-03', 40], ['2026-04', 50]]);
  } finally {
    await h.t.close();
  }
});

// ------------------------------------------------------------------------ a gap that loses its earlier reading

test('a gap whose earlier reading the purge removes is stored first: the month keeps the unaccounted kilometres it showed, although the live chain has no gap any more', async () => {
  const h = await createHousehold({ now: NOW });
  try {
    const { t, anna } = h;
    run(t.db, 'UPDATE users SET created_at = ?', '2025-12-20T08:00:00.000Z');
    // The cutoff on NOW is 2025-12-15 12:00 Amsterdam time. The first drive ends before it and goes; its end reading (500) was the
    // only thing that made the next start (560) a gap of 60 km in January. January itself loses no row.
    insertUsage(t, { userId: anna.id, start: '2025-12-10T08:00:00.000Z', end: '2025-12-10T09:00:00.000Z', odometerStart: 400, odometerEnd: 500 });
    insertUsage(t, { userId: anna.id, start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T09:00:00.000Z', odometerStart: 560, odometerEnd: 600 });
    const january = async (): Promise<StatsMonthDto> => ((await anna.get('/api/stats?from=2026-01&to=2026-01')).body as StatsReport).months[0] as StatsMonthDto;
    assert.equal((await january()).household?.unaccountedKm, 60, 'live, before the purge');
    assert.equal((await january()).frozen, false);

    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log, 6, 24);
    assert.equal(result.usage, 1, 'only the December drive went');
    assert.equal(computeMonths(t.db, TZ).get('2026-01')?.get(0)?.unaccountedKm ?? 0, 0, 'what is left shows no gap: the oldest reading has no predecessor');
    const stored = await january();
    assert.equal(stored.frozen, true, 'January lost no row of its own and is stored all the same');
    assert.equal(stored.household?.unaccountedKm, 60);
    assert.equal(stored.household?.km, 40);
    assert.equal(stored.household?.trips, 1);
  } finally {
    await h.t.close();
  }
});

// ------------------------------------------------------------------------------------------ read only

test('GET /api/stats is the only way in: POST, PUT, PATCH and DELETE on it are refused and change nothing', async () => {
  const h = await createHousehold({ now: NOW });
  try {
    run(h.t.db, 'UPDATE users SET created_at = ?', '2026-01-02T08:00:00.000Z');
    insertUsage(h.t, { userId: h.anna.id, start: '2026-05-10T08:00:00.000Z', end: '2026-05-10T09:00:00.000Z', odometerStart: 1000, odometerEnd: 1100 });
    const dump = (): string => JSON.stringify(['usage', 'meta', 'stats_months', 'stats_totals'].map((table) => many(h.t.db, `SELECT * FROM ${table}`)));
    const before = dump();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const client of [h.admin, h.anna]) {
        const res = await client.request(method, '/api/stats', method === 'DELETE' ? undefined : { month: '2026-05', household: { km: 1 } });
        assert.ok(res.status === 404 || res.status === 405, `${method}: ${res.status}`);
      }
      const anonymous = await h.t.client().request(method, '/api/stats', method === 'DELETE' ? undefined : {});
      assert.ok(anonymous.status >= 400 && anonymous.status < 500, `${method} anonymous: ${anonymous.status}`);
    }
    assert.equal(dump(), before, 'nothing changed');
    // And there is no way to ask for a month to be stored or recomputed through the query either.
    const res = await h.anna.get('/api/stats?from=2026-05&to=2026-05&freeze=1&recompute=1');
    assert.equal(res.status, 200);
    assert.equal(dump(), before);
  } finally {
    await h.t.close();
  }
});
