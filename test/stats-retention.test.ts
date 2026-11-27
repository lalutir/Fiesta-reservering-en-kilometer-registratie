import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { MIGRATIONS, getMeta, many, one, openDb, run, schemaVersion } from '../src/db.ts';
import { startMaintenance, tick } from '../src/maintenance.ts';
import { backupDir, listBackups, purge } from '../src/retention.ts';
import { TOTAL_FIELDS, columnOf, computeMonths, emptyTotals, monthSignature, planFreeze, readBaseline, statsReport, type MonthRows, type Months, type StatsMonthDto, type Totals } from '../src/stats.ts';
import { itemKey, loadChain } from '../src/odometer.ts';
import { createHousehold, insertDamage, insertFuel, insertUsage, makeClock, type Client, type Household, type Json } from './helpers.ts';
import type { Db } from '../src/db.ts';

const TZ = 'Europe/Amsterdam';
const NOW = '2026-06-15T10:00:00.000Z';
const CUTOFF = '2025-12-15T11:00:00.000Z'; // the purge cutoff on NOW: six months back, Amsterdam wall clock
const SETTINGS = { tz: TZ, windowMonths: 6, statsRetentionMonths: 24 };

/** A household whose accounts are dated just after the cutoff: a young database, where nothing counts as legacy. */
async function setup(created = '2025-12-20T08:00:00.000Z'): Promise<Household> {
  const h = await createHousehold({ now: NOW });
  run(h.t.db, 'UPDATE users SET created_at = ?', created);
  return h;
}

const purgeNow = (h: Household, statsMonths = 24): ReturnType<typeof purge> => purge(h.t.db, h.t.clock.now(), TZ, h.t.ctx.log, 6, statsMonths);

/** The stored rows of one month, read straight from the table. */
function storedRows(db: Db, month: string): MonthRows {
  const rows = new Map<number, Totals>();
  for (const r of many<Record<string, number>>(db, 'SELECT * FROM stats_totals WHERE month = ? ORDER BY user_id', month)) {
    const t = emptyTotals();
    for (const f of TOTAL_FIELDS) t[f] = r[columnOf(f)] as number;
    rows.set(r['user_id'] as number, t);
  }
  return rows;
}

const frozenMonths = (db: Db): string[] => many<{ month: string }>(db, 'SELECT month FROM stats_months WHERE frozen = 1 ORDER BY month').map((r) => r.month);
const flagsOf = (db: Db, month: string): { complete: number; frozen: number } | undefined => one(db, 'SELECT complete, frozen FROM stats_months WHERE month = ?', month);

async function report(c: Client, from: string, to: string): Promise<StatsMonthDto[]> {
  const res = await c.get(`/api/stats?from=${from}&to=${to}`);
  assert.equal(res.status, 200, res.text);
  return res.body.months as StatsMonthDto[];
}

/** Anna fuelled twice, so a period exists; carla and ben drove in it. Used by the "same as just before" scenarios. */
function seedOldMonths(h: Household): void {
  const { t, anna, ben, carla } = h;
  insertUsage(t, { userId: anna.id, start: '2025-11-10T08:00:00.000Z', end: '2025-11-10T09:00:00.000Z', odometerStart: 1000, odometerEnd: 1020 });
  insertFuel(t, { userId: anna.id, at: '2025-11-12T08:00:00.000Z', millilitres: 30_000, totalCents: 5000, odometer: 1020 });
  insertUsage(t, { userId: carla.id, start: '2025-12-12T08:00:00.000Z', end: '2025-12-12T09:00:00.000Z', odometerStart: 1020, odometerEnd: 1030 });
  insertUsage(t, { userId: ben.id, start: '2025-12-20T08:00:00.000Z', end: '2025-12-20T09:00:00.000Z', odometerStart: 1030, odometerEnd: 1060 });
  insertFuel(t, { userId: anna.id, at: '2025-12-22T08:00:00.000Z', millilitres: 35_000, totalCents: 6000, odometer: 1060 });
}

// =============================================================== what a purge stores

test('the purge stores the months it changes with exactly the numbers the report gave just before it ran', async () => {
  const h = await setup();
  try {
    seedOldMonths(h);
    const live = await report(h.anna, '2025-11', '2025-12');
    assert.deepEqual(live.map((m) => [m.month, m.frozen, m.incomplete]), [['2025-11', false, false], ['2025-12', false, false]], 'live before the purge');
    assert.equal(live[0]?.household?.fillUps, 1);
    assert.ok((live[1]?.people.length ?? 0) >= 2);

    const result = purgeNow(h);
    assert.equal(result.statsFrozen, 2);
    assert.equal(result.statsDropped, 0);
    assert.deepEqual(frozenMonths(h.t.db), ['2025-11', '2025-12']);
    assert.deepEqual(many(h.t.db, "SELECT id FROM usage WHERE end_utc < '2025-12-15'"), [], 'and the rows behind them are gone');

    const frozen = await report(h.ben, '2025-11', '2025-12');
    for (const [i, m] of frozen.entries()) {
      assert.equal(m.frozen, true, m.month);
      assert.equal(m.incomplete, false, 'frozen from complete numbers');
      assert.deepEqual(m.household, live[i]?.household, `${m.month}: the household numbers are the ones from before the purge`);
      assert.deepEqual(m.people, live[i]?.people, `${m.month}: and so are the people`);
    }
    // The stored rows are the same numbers as the live ones were, not a recomputation of what is left.
    assert.ok(monthSignature(storedRows(h.t.db, '2025-12')) !== monthSignature(computeMonths(h.t.db, TZ).get('2025-12')), 'what is left would give other numbers');
  } finally {
    await h.t.close();
  }
});

test('a frozen month never changes again: not by edits, not by deleting what is left, not by running the purge more often', async () => {
  const h = await setup();
  try {
    seedOldMonths(h);
    purgeNow(h);
    const first = await report(h.anna, '2025-11', '2025-12');
    // What is left of December is edited and then deleted; a fill-up is edited; the purge runs again and again.
    run(h.t.db, 'UPDATE usage SET odometer_end = odometer_end + 500');
    run(h.t.db, 'UPDATE fuel SET total_cents = total_cents * 3');
    purgeNow(h);
    assert.deepEqual(await report(h.anna, '2025-11', '2025-12'), first, 'edited');
    run(h.t.db, 'DELETE FROM usage');
    run(h.t.db, 'DELETE FROM fuel');
    purgeNow(h);
    purgeNow(h);
    assert.deepEqual(await report(h.anna, '2025-11', '2025-12'), first, 'deleted, and purged again');
    assert.deepEqual(frozenMonths(h.t.db), ['2025-11', '2025-12']);
    assert.equal(purgeNow(h).statsFrozen, 0, 'nothing more to store');
  } finally {
    await h.t.close();
  }
});

test('a month whose own rows are untouched is frozen too when its fill-up period loses the fill-up before it', async () => {
  const h = await setup();
  try {
    const { t, anna, ben, carla } = h;
    insertUsage(t, { userId: anna.id, start: '2025-12-08T08:00:00.000Z', end: '2025-12-08T09:00:00.000Z', odometerStart: 900, odometerEnd: 910 });
    insertFuel(t, { userId: anna.id, at: '2025-12-10T08:00:00.000Z', totalCents: 3000, odometer: 910 }); // before the cutoff: goes
    insertUsage(t, { userId: carla.id, start: '2025-12-12T08:00:00.000Z', end: '2025-12-12T09:00:00.000Z', odometerStart: 910, odometerEnd: 950 }); // goes too
    insertUsage(t, { userId: ben.id, start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T09:00:00.000Z', odometerStart: 950, odometerEnd: 990 });
    insertFuel(t, { userId: anna.id, at: '2026-01-10T08:00:00.000Z', millilitres: 40_000, totalCents: 6000, odometer: 990 });
    const [january] = await report(h.anna, '2026-01', '2026-01');
    // People come out by user id (ben before carla): the two of them drove 40 km each in the period, so they split it.
    assert.deepEqual(january?.people.map((p) => [p.userId, p.shareCents]).filter(([, s]) => s !== 0), [[ben.id, 3000], [carla.id, 3000]], 'before: carla and ben split it');

    const result = purgeNow(h);
    assert.ok(result.fuel === 1 && result.usage === 2, 'the fill-up of 10 December and two drives went');
    assert.ok(frozenMonths(t.db).includes('2026-01'), 'January lost none of its own rows and is frozen all the same');
    const [after] = await report(h.anna, '2026-01', '2026-01');
    assert.equal(after?.frozen, true);
    assert.deepEqual(after?.people, january?.people, 'with the numbers from before the purge');
    assert.deepEqual(after?.household, january?.household);
    const liveNow = computeMonths(t.db, TZ).get('2026-01');
    assert.notEqual(monthSignature(liveNow), monthSignature(storedRows(t.db, '2026-01')), 'the live numbers are now other ones: ben alone pays it all');
    assert.equal(liveNow?.get(ben.id)?.shareCents, 6000);
  } finally {
    await h.t.close();
  }
});

test('a purge that deletes an explanation re-opens a gap, and the month is stored with the gap still explained', async () => {
  const h = await setup();
  try {
    const { t, anna, ben } = h;
    // Two drives that overlap (only possible in data that was edited around the rules): a gap of 200 km between their start readings.
    const a = insertUsage(t, { userId: anna.id, start: '2025-12-14T08:00:00.000Z', end: '2026-01-02T08:00:00.000Z', odometerStart: 100, odometerEnd: 500 });
    insertUsage(t, { userId: ben.id, start: '2025-12-20T08:00:00.000Z', end: '2025-12-20T09:00:00.000Z', odometerStart: 300, odometerEnd: 310 });
    const chain = loadChain(t.db, '');
    const gap = chain.items.find((i) => i.kind === 'gap' && i.km === 200);
    assert.ok(gap && gap.prev.id === a, 'the gap exists over all retained readings');
    run(t.db, 'INSERT INTO odometer_explained (item_key, prev_at, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', gap.key, gap.prev.at, 'an outsider drove', anna.id, NOW, NOW);
    assert.equal(itemKey(gap.prev, gap.next), gap.key);
    const [before] = await report(h.anna, '2025-12', '2025-12');
    assert.equal(before?.household?.unaccountedKm, 0, 'explained: not counted');

    const result = purgeNow(h);
    assert.equal(result.odometerExplained, 1, 'the explanation went with the window');
    assert.equal(computeMonths(t.db, TZ).get('2025-12')?.get(HOUSEHOLD_ROW)?.unaccountedKm, 200, 'and the gap is open now');
    const [stored] = await report(h.anna, '2025-12', '2025-12');
    assert.equal(stored?.frozen, true);
    assert.equal(stored?.household?.unaccountedKm, 0, 'the stored month still has it explained');
    assert.equal(stored?.household?.trips, 2);
  } finally {
    await h.t.close();
  }
});

const HOUSEHOLD_ROW = 0;

test('a month that has no numbers before the purge and some after it (a gap re-opened in a month with nothing else) is stored as it was: with nothing', async () => {
  const h = await setup();
  try {
    const { t, anna, ben } = h;
    // Anna's drive began before the cutoff and ends in January (so it stays); Ben's unfinished drive began in January. Their readings
    // are 100, 300 and 500: two gaps of 200 km, and the later reading of the first one is the draft in January.
    insertUsage(t, { userId: anna.id, start: '2025-12-14T08:00:00.000Z', end: '2026-01-02T08:00:00.000Z', odometerStart: 100, odometerEnd: 500 });
    run(t.db, "INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, status, created_by, created_at, updated_at) VALUES (?, '2026-01-01T08:00:00.000Z', '2026-01-01T08:00:00.000Z', 300, 'draft', ?, ?, ?)", ben.id, ben.id, NOW, NOW);
    const gaps = loadChain(t.db, '').items.filter((i) => i.kind === 'gap');
    assert.equal(gaps.length, 2);
    for (const gap of gaps) {
      run(t.db, 'INSERT INTO odometer_explained (item_key, prev_at, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', gap.key, gap.prev.at, 'an outsider drove', anna.id, NOW, NOW);
    }
    const [january] = await report(h.anna, '2026-01', '2026-01');
    assert.equal(january?.household?.unaccountedKm, 0, 'both explained: nothing unaccounted');
    assert.equal(computeMonths(t.db, TZ).get('2026-01'), undefined, 'and January has no numbers at all');

    const result = purgeNow(h);
    assert.equal(result.odometerExplained, 1, 'the explanation of the first gap went (its earlier reading is before the cutoff)');
    assert.equal(computeMonths(t.db, TZ).get('2026-01')?.get(HOUSEHOLD_ROW)?.unaccountedKm, 200, 'which re-opens it in January');
    assert.ok(frozenMonths(t.db).includes('2026-01'), 'January appears only after the purge, and is stored all the same');
    assert.equal(storedRows(t.db, '2026-01').size, 0, 'from the numbers before: none');
    const [stored] = await report(h.anna, '2026-01', '2026-01');
    assert.equal(stored?.frozen, true);
    assert.equal(stored?.household?.unaccountedKm, 0, 'January keeps what it said before the purge');
  } finally {
    await h.t.close();
  }
});

test('a month wholly before the cutoff is stored even when no row of it is deleted (an open damage report is never purged)', async () => {
  const h = await setup();
  try {
    insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2025-09-01' });
    insertDamage(h.t, { reportedBy: h.ben.id, noticedOn: '2025-09-03', repairedOn: '2025-09-05' }); // repaired long ago: purged
    insertDamage(h.t, { reportedBy: h.ben.id, noticedOn: '2023-01-10' }); // older than the statistics are kept: no total, the report stays
    const [september] = await report(h.anna, '2025-09', '2025-09');
    assert.equal(september?.household?.damageReports, 2);

    const result = purgeNow(h);
    assert.equal(result.damageReports, 1);
    assert.deepEqual(frozenMonths(h.t.db), ['2025-09'], '2023-01 is older than 24 months: not stored');
    const [stored] = await report(h.anna, '2025-09', '2025-09');
    assert.equal(stored?.frozen, true);
    assert.equal(stored?.household?.damageReports, 2, 'the repaired report that was purged is still in the stored count');
    assert.equal(computeMonths(h.t.db, TZ).get('2025-09')?.get(h.anna.id)?.damageReports, 1);
    assert.equal(many(h.t.db, 'SELECT id FROM damage_reports').length, 2, 'both open reports are still there');
  } finally {
    await h.t.close();
  }
});

test('the current month is never stored: a purge that changes it leaves a marker, and the month stays live and is flagged incomplete', async () => {
  const h = await setup();
  try {
    const { t, anna, ben } = h;
    insertFuel(t, { userId: anna.id, at: '2025-12-01T08:00:00.000Z', totalCents: 2000 }); // goes: before the cutoff
    insertUsage(t, { userId: ben.id, start: '2025-12-05T08:00:00.000Z', end: '2025-12-05T09:00:00.000Z', odometerStart: 10, odometerEnd: 60 }); // goes too
    insertUsage(t, { userId: ben.id, start: '2026-06-02T08:00:00.000Z', end: '2026-06-02T09:00:00.000Z', odometerStart: 60, odometerEnd: 90 });
    insertFuel(t, { userId: anna.id, at: '2026-06-10T08:00:00.000Z', totalCents: 9000 });
    const [june] = await report(h.anna, '2026-06', '2026-06');
    assert.equal(june?.incomplete, false);
    const before = monthSignature(computeMonths(t.db, TZ).get('2026-06'));

    purgeNow(h);
    assert.ok(monthSignature(computeMonths(t.db, TZ).get('2026-06')) !== before, 'June changed although none of its rows left');
    assert.deepEqual(flagsOf(t.db, '2026-06'), { complete: 0, frozen: 0 }, 'a marker, not a stored month');
    assert.deepEqual(many(t.db, "SELECT month FROM stats_totals WHERE month = '2026-06'"), [], 'no totals for it');
    const [after] = await report(h.anna, '2026-06', '2026-06');
    assert.equal(after?.frozen, false);
    assert.equal(after?.provisional, true);
    assert.equal(after?.incomplete, true, 'the screen can say that it is no longer what it was');
    assert.equal(after?.household?.paidCents, 9000, 'and it keeps showing live numbers');

    const status = (await h.admin.get('/api/admin/retention')).body as Json;
    assert.equal(status.counts.statsMonths, 1, 'the marker is no stored month: only December is');
    assert.equal(status.oldest.statsMonth, '2025-12');
    purgeNow(h);
    assert.deepEqual(frozenMonths(t.db), ['2025-12']);
  } finally {
    await h.t.close();
  }
});

// ============================================================ failure, retry, backup

test('when storing a month fails nothing is deleted, the failure is logged, today\'s backup is still written and the next tick retries', async () => {
  const h = await setup();
  try {
    const { t } = h;
    seedOldMonths(h);
    const rows = (): number => one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n as number;
    const usageBefore = rows();
    t.db.exec("CREATE TRIGGER boom BEFORE INSERT ON stats_totals BEGIN SELECT RAISE(ABORT, 'no room for the totals'); END");
    t.logs.length = 0;

    assert.equal(tick(t.ctx), false);
    assert.equal(rows(), usageBefore, 'the purge was one transaction: nothing was deleted without its totals');
    assert.deepEqual(frozenMonths(t.db), []);
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel')?.n, 2);
    const error = t.logs.find((l) => l['event'] === 'maintenance.error');
    assert.ok(error, 'logged');
    assert.equal(error['step'], 'purge');
    assert.match(String(error['message']), /no room for the totals/);
    assert.equal(t.logs.filter((l) => l['event'] === 'retention.purge').length, 0);
    assert.equal(listBackups(backupDir(t.dir)).length, 1, 'a failing purge does not stop the daily backup');
    assert.equal(getMeta(t.db, 'last_maintenance_day'), undefined, 'the day stays open so the next tick retries');
    assert.equal(getMeta(t.db, 'stats_first_month'), undefined, 'not even the baseline was kept: it rolled back with the rest');

    t.clock.advance(30 * 60_000);
    assert.equal(tick(t.ctx), false, 'still failing: still no deletes, and no second backup is written for the same day');
    assert.equal(listBackups(backupDir(t.dir)).length, 1);
    assert.equal(rows(), usageBefore);

    t.db.exec('DROP TRIGGER boom');
    t.clock.advance(30 * 60_000);
    assert.equal(tick(t.ctx), true);
    assert.ok(rows() < usageBefore, 'now the old drives are purged');
    assert.deepEqual(frozenMonths(t.db), ['2025-11', '2025-12'], 'with their totals stored');
    assert.equal(getMeta(t.db, 'last_maintenance_day'), '2026-06-15');
  } finally {
    await h.t.close();
  }
});

test('a purge that rolls back after the months were stored does not log that they were stored', async () => {
  const h = await setup();
  try {
    const { t } = h;
    seedOldMonths(h);
    // The statistics step succeeds; the purge record written after it is what fails, so the whole transaction rolls back.
    t.db.exec("CREATE TRIGGER boom BEFORE INSERT ON meta WHEN NEW.key = 'last_purge' BEGIN SELECT RAISE(ABORT, 'no room for the purge record'); END");
    t.logs.length = 0;
    assert.throws(() => purgeNow(h), /no room for the purge record/);
    assert.deepEqual(frozenMonths(t.db), [], 'rolled back: nothing was stored');
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n, 3, 'and nothing was deleted');
    assert.deepEqual(
      t.logs.filter((l) => l['event'] === 'retention.stats' || l['event'] === 'retention.purge'),
      [],
      'a log line says what is committed, never what was rolled back',
    );

    // Once it works, the line is there and says what the run stored.
    t.db.exec('DROP TRIGGER boom');
    const result = purgeNow(h);
    assert.ok(result.statsFrozen > 0);
    const line = t.logs.find((l) => l['event'] === 'retention.stats');
    assert.ok(line, 'logged after the commit');
    assert.deepEqual(line['frozen'], frozenMonths(t.db));
    assert.ok(t.logs.findIndex((l) => l['event'] === 'retention.stats') < t.logs.findIndex((l) => l['event'] === 'retention.purge'), 'before the purge line, as always');
  } finally {
    await h.t.close();
  }
});

test('at startup a failing purge does not stop the backup either, and the day is left open', async () => {
  const h = await setup();
  try {
    const { t } = h;
    seedOldMonths(h);
    const driveCount = (): number => one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n as number;
    const before = driveCount();
    assert.equal(before, 3);
    t.db.exec("CREATE TRIGGER boom BEFORE INSERT ON stats_months BEGIN SELECT RAISE(ABORT, 'nope'); END");
    t.logs.length = 0;
    startMaintenance(t.ctx).stop();
    assert.ok(t.logs.some((l) => l['event'] === 'maintenance.error' && l['step'] === 'purge'));
    assert.equal(listBackups(backupDir(t.dir)).length, 1);
    assert.equal(getMeta(t.db, 'last_maintenance_day'), undefined);
    assert.equal(driveCount(), before, 'nothing deleted');
  } finally {
    await h.t.close();
  }
});

// ================================================================ the retention setting

function seedStored(db: Db, month: string, frozen = 1, withTotals = true): void {
  run(db, 'INSERT INTO stats_months (month, complete, frozen) VALUES (?, ?, ?)', month, frozen, frozen);
  if (withTotals) run(db, 'INSERT INTO stats_totals (month, user_id, trips, km) VALUES (?, 1, 3, 100)', month);
}

test('totals older than STATS_RETENTION_MONTHS are deleted: the current month and the 23 before it stay (boundary), raising the setting restores nothing', async () => {
  const h = await setup();
  try {
    const { t } = h;
    seedStored(t.db, '2024-05', 0, false); // a marker that old goes quietly
    for (const m of ['2024-06', '2024-07', '2024-08', '2026-05']) seedStored(t.db, m);
    const first = purgeNow(h);
    assert.equal(first.statsDropped, 1, 'only 2024-06 is a stored month older than the 24 that are kept (2024-07 to 2026-06)');
    assert.deepEqual(many<{ month: string }>(t.db, 'SELECT month FROM stats_months ORDER BY month').map((r) => r.month), ['2024-07', '2024-08', '2026-05']);
    assert.deepEqual(many(t.db, "SELECT month FROM stats_totals WHERE month < '2024-07'"), [], 'their totals went with them');

    // Lowering it deletes at the next purge: twelve months keep 2025-07 to 2026-06.
    const lowered = purgeNow(h, 12);
    assert.equal(lowered.statsDropped, 2);
    assert.deepEqual(frozenMonths(t.db), ['2026-05']);
    // Raising it again restores nothing.
    const raised = purgeNow(h, 120);
    assert.equal(raised.statsDropped, 0);
    assert.deepEqual(frozenMonths(t.db), ['2026-05']);
    // The smallest setting keeps six months: 2026-01 to 2026-06.
    seedStored(t.db, '2025-12');
    seedStored(t.db, '2026-01');
    assert.equal(purgeNow(h, 6).statsDropped, 1);
    assert.deepEqual(frozenMonths(t.db), ['2026-01', '2026-05']);
  } finally {
    await h.t.close();
  }
});

test('the retention status counts stored months only and reports the oldest one and the setting', async () => {
  const h = await createHousehold({ now: NOW, env: { STATS_RETENTION_MONTHS: '12' } });
  try {
    const empty = (await h.admin.get('/api/admin/retention')).body as Json;
    assert.equal(empty.statsRetentionMonths, 12);
    assert.equal(empty.counts.statsMonths, 0);
    assert.equal(empty.oldest.statsMonth, null);
    // Twelve months keep 2025-07 to 2026-06, so 2025-05 is too old and 2025-09 is not.
    seedStored(h.t.db, '2025-05');
    seedStored(h.t.db, '2025-09');
    seedStored(h.t.db, '2026-02');
    seedStored(h.t.db, '2026-06', 0, false);
    const status = (await h.admin.get('/api/admin/retention')).body as Json;
    assert.equal(status.counts.statsMonths, 3, 'the marker is not a stored month');
    assert.equal(status.oldest.statsMonth, '2025-05');
    const run1 = (await h.admin.post('/api/admin/retention/run')).body as Json;
    assert.equal(run1.result.statsDropped, 1, 'the manual run uses the setting: 2025-05 is older than the 12 months that are kept');
    assert.equal(run1.status.counts.statsMonths, 2);
    assert.equal(run1.status.oldest.statsMonth, '2025-09');
  } finally {
    await h.t.close();
  }
});

// ================================================================== the first deploy

function buildV6(dir: string, created: string): string {
  const file = path.join(dir, 'car.db');
  const db = openDb(file, MIGRATIONS.slice(0, 6));
  const user = (name: string, role = 'member'): number =>
    run(db, 'INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', name, name, 'x', role, created, created).lastInsertRowid;
  const admin = user('admin', 'admin');
  const anna = user('anna');
  const ben = user('ben');
  const drive = (who: number, start: string, from: number, km: number): void => {
    run(
      db,
      "INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      who,
      start,
      new Date(Date.parse(start) + 3_600_000).toISOString(),
      from,
      from + km,
      who,
      created,
      created,
    );
  };
  // What the 6-month purge of the old version left: the cutoff month is partly gone, the oldest fill-up is in February.
  drive(anna, '2025-12-18T08:00:00.000Z', 1000, 40);
  drive(ben, '2026-01-20T08:00:00.000Z', 1040, 30);
  run(db, "INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, odometer, created_by, created_at, updated_at) VALUES (?, '2026-02-10T09:00:00.000Z', 35000, 6300, 1070, ?, ?, ?)", anna, anna, created, created);
  drive(ben, '2026-03-05T08:00:00.000Z', 1070, 50);
  run(db, "INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, odometer, created_by, created_at, updated_at) VALUES (?, '2026-03-20T09:00:00.000Z', 38000, 6800, 1120, ?, ?, ?)", ben, ben, created, created);
  run(db, "INSERT INTO damage_reports (noticed_on, reported_by, description, location, created_at, updated_at) VALUES ('2025-10-02', ?, 'A dent', 'front', ?, ?)", admin, created, created);
  db.close();
  return file;
}

test('first deploy on an old database: months that were already partly purged are stored once, flagged incomplete; earlier empty months are not available; later months are exact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-stats-v6-'));
  let opened: Db | undefined;
  try {
    const file = buildV6(dir, '2025-01-10T08:00:00.000Z');
    const db = (opened = openDb(file)); // the upgrade to v7 (and its pre-migrate-v6 copy)
    assert.equal(schemaVersion(db), 7);
    assert.ok(fs.existsSync(path.join(dir, 'backups', 'pre-migrate-v6.db')));
    const now = new Date(NOW);
    const logs: Array<Record<string, unknown>> = [];

    // Before the first purge nothing is stored, and the report already derives the same baseline without writing it.
    assert.deepEqual(many(db, 'SELECT month FROM stats_months'), []);
    const derived = readBaseline(db, now, TZ, 6);
    assert.deepEqual(derived, { firstMonth: '2025-01', legacyThrough: '2026-02' }, 'the cutoff month is December; the oldest retained fill-up is in February');
    assert.equal(getMeta(db, 'stats_first_month'), undefined);
    const live = statsReport(db, SETTINGS, now, { from: '2025-09', to: '2026-06' }).months;
    const liveFlags = (m: string): string => {
      const x = live.find((y) => y.month === m) as StatsMonthDto;
      return `${x.unavailable ? 'unavailable' : 'available'}/${x.incomplete ? 'incomplete' : 'complete'}`;
    };
    assert.equal(liveFlags('2025-11'), 'unavailable/complete');

    const result = purge(db, now, TZ, (e) => logs.push(e), 6, 24);
    assert.deepEqual(readBaseline(db, now, TZ, 6), derived, 'stored: the same values');
    assert.equal(getMeta(db, 'stats_first_month'), '2025-01');
    assert.equal(getMeta(db, 'stats_legacy_through'), '2026-02');
    // Every month up to the legacy month that has something in it: October (an open damage report), December (what the
    // old purge left of it), January (a drive, whose fuel shares are in the February fill-up) and February.
    const legacyMonths = ['2025-10', '2025-12', '2026-01', '2026-02'];
    assert.equal(result.statsFrozen, 4);
    assert.deepEqual(frozenMonths(db), legacyMonths);
    for (const month of legacyMonths) assert.deepEqual(flagsOf(db, month), { complete: 0, frozen: 1 }, `${month} was already cut short`);
    assert.deepEqual(logs.find((l) => l['event'] === 'retention.stats'), { event: 'retention.stats', frozen: legacyMonths, incomplete: legacyMonths, marked: [], dropped: 0 });

    const months = statsReport(db, SETTINGS, now, { from: '2025-09', to: '2026-06' }).months;
    const by = (m: string): StatsMonthDto => months.find((x) => x.month === m) as StatsMonthDto;
    assert.deepEqual([by('2025-09').unavailable, by('2025-09').household], [true, null], 'nothing left of September and it is before the cutoff: not zero, not available');
    assert.equal(by('2025-10').frozen, true);
    assert.equal(by('2025-10').incomplete, true);
    assert.equal(by('2025-10').household?.damageReports, 1);
    assert.equal(by('2025-11').unavailable, true);
    assert.equal(by('2025-12').household?.trips, 1, 'what is left of December');
    assert.equal(by('2025-12').incomplete, true);
    assert.equal(by('2026-01').unavailable, false, 'January has a drive: what is there is shown');
    assert.equal(by('2026-01').frozen, true);
    assert.equal(by('2026-01').incomplete, true, 'but the fill-up before the February one may have been purged: no promise that it is all');
    assert.equal(by('2026-01').household?.trips, 1);
    assert.equal(by('2026-02').household?.paidCents, 6300);
    assert.equal(by('2026-02').incomplete, true);
    // From the next month on the numbers are complete and live.
    assert.deepEqual([by('2026-03').frozen, by('2026-03').incomplete, by('2026-03').unavailable], [false, false, false]);
    assert.equal(by('2026-03').household?.paidCents, 6800);
    assert.equal(by('2026-04').unavailable, false, 'a quiet month after the cutoff is a real zero');
    assert.deepEqual(by('2026-04').household?.trips, 0);

    // A second purge changes nothing about it.
    const rows = JSON.stringify(many(db, 'SELECT * FROM stats_totals ORDER BY month, user_id'));
    const again = purge(db, now, TZ, () => undefined, 6, 24);
    assert.equal(again.statsFrozen, 0);
    assert.equal(JSON.stringify(many(db, 'SELECT * FROM stats_totals ORDER BY month, user_id')), rows);
    assert.equal(getMeta(db, 'stats_legacy_through'), '2026-02');
  } finally {
    opened?.close(); // also when an assertion failed: an open file cannot be removed on Windows
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('first deploy on a young database: nothing is flagged, a quiet month reads zero, and a month before the household existed is not available', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-stats-young-'));
  let opened: Db | undefined;
  try {
    const file = buildV6(dir, '2026-05-30T08:00:00.000Z');
    const db = (opened = openDb(file));
    const now = new Date(NOW);
    const result = purge(db, now, TZ, () => undefined, 6, 24);
    assert.equal(getMeta(db, 'stats_first_month'), '2026-05');
    assert.equal(getMeta(db, 'stats_legacy_through'), undefined, 'a database younger than the window has no legacy months');
    // The fixture has rows from before the household existed (the damage report of October stays: an open report is
    // never purged). A month wholly before the cutoff is stored, and complete: nothing was cut short before.
    assert.equal(result.statsFrozen, 1);
    assert.deepEqual(frozenMonths(db), ['2025-10']);
    for (const m of frozenMonths(db)) assert.deepEqual(flagsOf(db, m), { complete: 1, frozen: 1 });
    const months = statsReport(db, SETTINGS, now, { from: '2026-03', to: '2026-06' }).months;
    const by = (m: string): StatsMonthDto => months.find((x) => x.month === m) as StatsMonthDto;
    assert.equal(by('2026-03').unavailable, false, 'March has data, so it is shown although it is before the household existed');
    assert.deepEqual([by('2026-04').unavailable, by('2026-04').household], [true, null], 'April has nothing and is before the household existed: not zero');
    assert.equal(by('2026-05').unavailable, false);
    assert.equal(by('2026-05').household?.trips, 0, 'May is a month of this household and quiet: zero');
    assert.ok(months.every((m) => !m.incomplete), 'nothing is flagged');
  } finally {
    opened?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a database without users has no baseline yet: the purge writes it later, once somebody exists', async () => {
  const h = await createHousehold({ now: NOW });
  try {
    run(h.t.db, 'UPDATE users SET created_at = ?', 'not a time');
    purgeNow(h);
    assert.equal(getMeta(h.t.db, 'stats_first_month'), undefined, 'nothing to base it on');
    run(h.t.db, 'UPDATE users SET created_at = ?', '2026-02-01T08:00:00.000Z');
    purgeNow(h);
    assert.equal(getMeta(h.t.db, 'stats_first_month'), '2026-02');
  } finally {
    await h.t.close();
  }
});

// ================================================================ numbers only, the plan

test('what is stored is numbers only: a month key, two flags and whole non-negative integers', async () => {
  const h = await setup();
  try {
    seedOldMonths(h);
    insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2025-09-01', description: 'a secret scratch', noticedBy: h.ben.id });
    purgeNow(h);
    const months = many<Record<string, unknown>>(h.t.db, 'SELECT * FROM stats_months');
    const totals = many<Record<string, unknown>>(h.t.db, 'SELECT * FROM stats_totals');
    assert.ok(months.length >= 3 && totals.length >= 3);
    for (const row of months) assert.deepEqual(Object.keys(row).sort(), ['complete', 'frozen', 'month']);
    for (const row of totals) {
      for (const [key, value] of Object.entries(row)) {
        if (key === 'month') assert.match(String(value), /^\d{4}-\d{2}$/);
        else assert.ok(Number.isInteger(value) && (value as number) >= 0, `${key} is a whole number`);
      }
    }
    const text = JSON.stringify([months, totals]);
    assert.doesNotMatch(text, /secret|scratch|Anna|anna|T\d\d:\d\d/, 'no free text, no name, no time of day');
  } finally {
    await h.t.close();
  }
});

test('planFreeze: which months a purge stores, as a table', () => {
  const rows = (trips: number): MonthRows => new Map([[1, { ...emptyTotals(), trips }]]);
  const months = (entries: Record<string, number>): Months => new Map(Object.entries(entries).map(([m, n]) => [m, rows(n)]));
  const base = { frozen: new Set<string>(), marked: new Set<string>(), current: '2026-06', keepFrom: '2024-07', cutoffMonth: '2025-12', legacyThrough: null as string | null };
  const freeze = (plan: ReturnType<typeof planFreeze>): string[] => plan.freeze.map((f) => `${f.month}${f.complete ? '' : '*'}`);

  // Nothing changed, nothing wholly before the cutoff: nothing to store.
  const same = months({ '2026-01': 1, '2026-02': 2 });
  assert.deepEqual(planFreeze({ ...base, before: same, after: same }), { freeze: [], mark: [] });
  // A month whose numbers changed is stored (from before): also one that lost no row of its own (a different number is a different number).
  assert.deepEqual(freeze(planFreeze({ ...base, before: months({ '2026-01': 1, '2026-02': 2 }), after: months({ '2026-01': 1, '2026-02': 9 }) })), ['2026-02']);
  // A month that is gone after the purge (all its rows were deleted) is stored with its before numbers.
  assert.deepEqual(freeze(planFreeze({ ...base, before: months({ '2025-11': 4 }), after: months({}) })), ['2025-11']);
  // Already stored months are never touched, and months older than what is kept are not kept.
  assert.deepEqual(freeze(planFreeze({ ...base, frozen: new Set(['2025-11']), before: months({ '2025-11': 4, '2024-06': 1 }), after: months({}) })), []);
  // The current month is never stored: a change leaves a marker, no change leaves nothing.
  assert.deepEqual(planFreeze({ ...base, before: months({ '2026-06': 1 }), after: months({ '2026-06': 2 }) }), { freeze: [], mark: ['2026-06'] });
  assert.deepEqual(planFreeze({ ...base, before: months({ '2026-06': 1 }), after: months({ '2026-06': 1 }) }), { freeze: [], mark: [] });
  assert.deepEqual(planFreeze({ ...base, before: months({ '2026-07': 1 }), after: months({}) }), { freeze: [], mark: [] }, 'a month after the current one is ignored');
  // A month wholly before the cutoff month with numbers is stored although nothing changed; the cutoff month itself is not.
  assert.deepEqual(freeze(planFreeze({ ...base, before: months({ '2025-09': 1, '2025-12': 1 }), after: months({ '2025-09': 1, '2025-12': 1 }) })), ['2025-09']);
  // The first purge of an old database: every month up to legacyThrough that has numbers, incomplete (the star).
  assert.deepEqual(freeze(planFreeze({ ...base, legacyThrough: '2026-02', before: months({ '2025-12': 1, '2026-02': 1, '2026-03': 1 }), after: months({ '2025-12': 1, '2026-02': 1, '2026-03': 1 }) })), ['2025-12*', '2026-02*']);
  // A month that carried a marker is stored as incomplete.
  assert.deepEqual(freeze(planFreeze({ ...base, marked: new Set(['2026-01']), before: months({ '2026-01': 1 }), after: months({ '2026-01': 2 }) })), ['2026-01*']);
  // Empty months are not stored: no numbers, no change.
  assert.deepEqual(planFreeze({ ...base, before: new Map(), after: new Map() }), { freeze: [], mark: [] });
  // Signature: a person with other numbers, or one more person, is a change.
  const a: Months = new Map([['2026-01', new Map([[1, { ...emptyTotals(), km: 5 }]])]]);
  const b: Months = new Map([['2026-01', new Map([[1, { ...emptyTotals(), km: 5 }], [2, { ...emptyTotals(), km: 0, trips: 1 }]])]]);
  assert.deepEqual(freeze(planFreeze({ ...base, before: a, after: b })), ['2026-01']);
  assert.equal(monthSignature(undefined), '');
  assert.equal(monthSignature(new Map()), '');
});

test('the purge uses the clock it is given and the household zone for "wholly before the cutoff" (the cutoff month is never "wholly")', async () => {
  const h = await setup();
  try {
    // 2025-12-15T10:59 is before the cutoff (11:00 UTC), 2025-12-15T11:00:00.000Z is not: December is the cutoff month.
    insertUsage(h.t, { userId: h.anna.id, start: '2025-12-15T09:00:00.000Z', end: '2025-12-15T10:59:59.999Z', odometerStart: 0, odometerEnd: 5 });
    insertUsage(h.t, { userId: h.anna.id, start: '2025-12-15T10:00:00.000Z', end: CUTOFF, odometerStart: 5, odometerEnd: 9 });
    const result = purgeNow(h);
    assert.equal(result.usage, 1);
    assert.deepEqual(frozenMonths(h.t.db), ['2025-12'], 'the first one went, so December changed');
    const december = storedRows(h.t.db, '2025-12').get(h.anna.id);
    assert.equal(december?.trips, 2);
    assert.equal(december?.km, 9);
    const clock = makeClock(NOW);
    assert.equal(clock.now().toISOString(), NOW);
    assert.equal(loadConfig({}).statsRetentionMonths, 24);
  } finally {
    await h.t.close();
  }
});
