import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli.ts';
import { many, one, openDb, run } from '../src/db.ts';
import { purge } from '../src/retention.ts';
import { ODO, at, createHousehold, createTestApp, insertApk, insertDamage, insertDraft, insertFuel, insertReservation, insertTicket, insertUsage, makeClock, type TestApp } from './helpers.ts';

const TZ = 'Europe/Amsterdam';
const NOW = '2026-06-15T10:00:00.000Z';
const CUTOFF = '2025-12-15T11:00:00.000Z';
const HOUR = 3_600_000;
const shift = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

function ids(t: TestApp, table: 'reservations' | 'usage'): number[] {
  return many<{ id: number }>(t.db, `SELECT id FROM ${table} ORDER BY id`).map((r) => r.id);
}

test('purge deletes only what ended strictly before the cutoff (boundary +/- 1 ms)', async () => {
  const { t, anna } = await createHousehold();
  try {
    const before = insertReservation(t, { userId: anna.id, start: shift(CUTOFF, -HOUR), end: shift(CUTOFF, -1) });
    const atCutoff = insertReservation(t, { userId: anna.id, start: shift(CUTOFF, -HOUR), end: CUTOFF });
    const after = insertReservation(t, { userId: anna.id, start: shift(CUTOFF, -HOUR), end: shift(CUTOFF, 1) });
    const uBefore = insertUsage(t, { userId: anna.id, start: shift(CUTOFF, -HOUR), end: shift(CUTOFF, -1) });
    const uAt = insertUsage(t, { userId: anna.id, start: shift(CUTOFF, -2 * HOUR), end: CUTOFF });
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.cutoff, CUTOFF);
    assert.equal(result.reservations, 1);
    assert.equal(result.usage, 1);
    assert.deepEqual(ids(t, 'reservations'), [atCutoff, after]);
    assert.deepEqual(ids(t, 'usage'), [uAt]);
    assert.ok(!ids(t, 'reservations').includes(before));
    assert.ok(!ids(t, 'usage').includes(uBefore));
  } finally {
    await t.close();
  }
});

test('a row exactly at the cutoff is both accepted by validation and kept by the purge', async () => {
  const { t, anna } = await createHousehold();
  try {
    const res = await anna.post('/api/reservations', { start: shift(CUTOFF, -HOUR), end: CUTOFF });
    assert.equal(res.status, 201);
    const use = await anna.post('/api/usage', { start: shift(CUTOFF, -3 * HOUR), end: CUTOFF, ...ODO });
    assert.equal(use.status, 201);
    purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(ids(t, 'reservations').length, 1);
    assert.equal(ids(t, 'usage').length, 1);
    t.clock.advance(1); // one millisecond later the window has moved past them
    purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(ids(t, 'reservations').length, 0);
    assert.equal(ids(t, 'usage').length, 0);
  } finally {
    await t.close();
  }
});

test('current and future data is never touched, whatever its status', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const keep = [
      insertReservation(t, { userId: anna.id, start: at(t.clock, -2), end: at(t.clock, 2) }), // in progress
      insertReservation(t, { userId: anna.id, start: at(t.clock, 24), end: at(t.clock, 26) }),
      insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'pending', start: at(t.clock, 30), end: at(t.clock, 32) }),
      insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'declined', start: at(t.clock, 40), end: at(t.clock, 42) }),
      insertReservation(t, { userId: anna.id, start: shift(CUTOFF, 5 * HOUR), end: shift(CUTOFF, 6 * HOUR) }),
    ];
    const keepUsage = [
      insertUsage(t, { userId: anna.id, start: at(t.clock, -5), end: at(t.clock, -4) }),
      insertUsage(t, { userId: ben.id, start: at(t.clock, -1), end: at(t.clock, 0) }),
    ];
    const gone = [
      insertReservation(t, { userId: anna.id, start: '2025-01-01T08:00:00.000Z', end: '2025-01-01T10:00:00.000Z' }),
      insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'pending', start: '2025-02-01T08:00:00.000Z', end: '2025-02-01T10:00:00.000Z' }),
      insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'declined', start: '2025-03-01T08:00:00.000Z', end: '2025-03-01T10:00:00.000Z' }),
    ];
    insertUsage(t, { userId: anna.id, start: '2025-01-01T08:00:00.000Z', end: '2025-01-01T10:00:00.000Z' });
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.deepEqual([result.reservations, result.usage], [3, 1]);
    assert.deepEqual(ids(t, 'reservations'), keep);
    assert.deepEqual(ids(t, 'usage'), keepUsage);
    assert.ok(gone.every((g) => !ids(t, 'reservations').includes(g)));
  } finally {
    await t.close();
  }
});

test('purging an old reservation unlinks newer usage but keeps it', async () => {
  const { t, anna } = await createHousehold();
  try {
    const oldRes = insertReservation(t, { userId: anna.id, start: shift(CUTOFF, -3 * HOUR), end: shift(CUTOFF, -HOUR) });
    const u = insertUsage(t, { userId: anna.id, start: shift(CUTOFF, HOUR), end: shift(CUTOFF, 2 * HOUR), reservationId: oldRes });
    purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.deepEqual(ids(t, 'reservations'), []);
    assert.equal(one<{ reservation_id: number | null }>(t.db, 'SELECT reservation_id FROM usage WHERE id = ?', u)?.reservation_id, null);
  } finally {
    await t.close();
  }
});

test('expired sessions are removed, live ones stay', async () => {
  const { t, anna } = await createHousehold();
  try {
    run(t.db, "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, refreshed_at) VALUES ('old', ?, ?, ?, ?)", anna.id, CUTOFF, shift(NOW, -HOUR), CUTOFF);
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.sessions, 1);
    assert.equal(one<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'old'")?.n, 0);
    assert.equal((await anna.get('/api/auth/me')).status, 200);
  } finally {
    await t.close();
  }
});

test('the deleted-row counts are logged as one JSON line and kept for the admin page', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    insertReservation(t, { userId: anna.id, start: '2025-01-01T08:00:00.000Z', end: '2025-01-01T10:00:00.000Z' });
    insertReservation(t, { userId: anna.id, start: '2025-01-02T08:00:00.000Z', end: '2025-01-02T10:00:00.000Z' });
    insertUsage(t, { userId: anna.id, start: '2025-01-01T08:00:00.000Z', end: '2025-01-01T10:00:00.000Z' });
    t.logs.length = 0;
    const res = await admin.post('/api/admin/retention/run');
    assert.equal(res.status, 200);
    assert.deepEqual({ ...res.body.result }, { cutoff: CUTOFF, reservations: 2, usage: 1, fuel: 0, fuelRequests: 0, tickets: 0, odometerExplained: 0, damageReports: 0, sessions: 0 });
    const lines = t.logs.filter((l) => l['event'] === 'retention.purge');
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0] }, { event: 'retention.purge', cutoff: CUTOFF, reservations: 2, usage: 1, fuel: 0, fuelRequests: 0, tickets: 0, odometerExplained: 0, damageReports: 0, sessions: 0 });

    const status = (await admin.get('/api/admin/retention')).body;
    assert.equal(status.cutoff, CUTOFF);
    assert.equal(status.windowMonths, 6);
    assert.deepEqual(status.window, { from: CUTOFF, to: '2026-12-15T11:00:00.000Z' });
    assert.equal(status.lastPurgeAt, NOW);
    assert.deepEqual({ ...status.lastPurge }, { cutoff: CUTOFF, reservations: 2, usage: 1, fuel: 0, fuelRequests: 0, tickets: 0, odometerExplained: 0, damageReports: 0, sessions: 0 });
    assert.deepEqual(status.counts, { reservations: 0, usage: 0, fuel: 0, fuelRequests: 0, tickets: 0, odometerExplained: 0, damageReports: 0, sessions: status.counts.sessions });
    assert.equal(status.oldest.reservationEnd, null);
    assert.equal(status.timeZone, 'Europe/Amsterdam');
  } finally {
    await t.close();
  }
});

test('the cutoff uses calendar months in the household zone, including DST and month ends', async () => {
  const cases: Array<[string, string]> = [
    ['2026-10-25T12:00:00.000Z', '2026-04-25T11:00:00.000Z'], // clocks went back that morning
    ['2026-03-10T09:00:00.000Z', '2025-09-10T08:00:00.000Z'], // clocks go forward later that month
    ['2026-03-29T12:00:00.000Z', '2025-09-29T12:00:00.000Z'], // the spring-forward day itself
    ['2026-08-31T10:00:00.000Z', '2026-02-28T11:00:00.000Z'], // day clamped to the shorter month
    ['2028-08-31T10:00:00.000Z', '2028-02-29T11:00:00.000Z'], // ... and a leap day
  ];
  for (const [now, cutoff] of cases) {
    const t = await createTestApp({ now });
    try {
      const user = await t.signIn('anna');
      const keep = insertReservation(t, { userId: user.id, start: shift(cutoff, -HOUR), end: cutoff });
      insertReservation(t, { userId: user.id, start: shift(cutoff, -2 * HOUR), end: shift(cutoff, -1) });
      const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
      assert.equal(result.cutoff, cutoff, now);
      assert.deepEqual(ids(t, 'reservations'), [keep], now);
    } finally {
      await t.close();
    }
  }
});

test('purge is idempotent and leaves an empty database alone', async () => {
  const t = await createTestApp();
  try {
    const first = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    const second = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.deepEqual([first.reservations, first.usage, second.reservations, second.usage], [0, 0, 0, 0]);
  } finally {
    await t.close();
  }
});

test('old fill-ups are purged with their payment requests, current ones stay (boundary +/- 1 ms)', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const before = insertFuel(t, { userId: anna.id, at: shift(CUTOFF, -1) });
    const atCutoff = insertFuel(t, { userId: anna.id, at: CUTOFF });
    const recent = insertFuel(t, { userId: anna.id, at: at(t.clock, -48) });
    for (const fuelId of [before, atCutoff, recent]) {
      run(
        t.db,
        "INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, created_at, updated_at) VALUES (?, ?, 1500, 'manual', 'pay', ?, ?)",
        fuelId,
        ben.id,
        NOW,
        NOW,
      );
    }
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.fuel, 1);
    assert.equal(result.fuelRequests, 1, 'the unpaid request of the old fill-up goes with it');
    assert.deepEqual(
      many<{ id: number }>(t.db, 'SELECT id FROM fuel ORDER BY id').map((r) => r.id),
      [atCutoff, recent],
    );
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel_requests')?.n, 2);
    assert.equal(
      one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel_requests WHERE fuel_id = ?', before)?.n,
      0,
    );
  } finally {
    await t.close();
  }
});

test('the admin retention page reports fill-ups and requests, and the CLI-style counts include them', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const fuel = insertFuel(t, { userId: anna.id, at: at(t.clock, -10) });
    run(
      t.db,
      "INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, created_at, updated_at) VALUES (?, ?, 1500, 'manual', 'pay', ?, ?)",
      fuel,
      ben.id,
      NOW,
      NOW,
    );
    const status = (await admin.get('/api/admin/retention')).body;
    assert.equal(status.counts.fuel, 1);
    assert.equal(status.counts.fuelRequests, 1);
    assert.equal(status.oldest.fuelAt, at(t.clock, -10));
    // A purge result stored by the previous release has no fuel keys: the page must cope (it reads them with ?? 0).
    run(t.db, "INSERT INTO meta (key, value) VALUES ('last_purge', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ cutoff: CUTOFF, reservations: 1, usage: 2, sessions: 3 }));
    const old = (await admin.get('/api/admin/retention')).body;
    assert.equal(old.lastPurge.fuel, undefined);
    assert.equal(old.lastPurge.reservations, 1);
  } finally {
    await t.close();
  }
});

test('old tickets are purged by the time of the offence, strictly before the cutoff (boundary +/- 1 ms); current and future ones stay', async () => {
  const { t, anna } = await createHousehold();
  try {
    const before = insertTicket(t, { userId: anna.id, at: shift(CUTOFF, -1), amountCents: 5_000, reason: 'speeding' });
    const atCutoff = insertTicket(t, { userId: anna.id, at: CUTOFF });
    const recent = insertTicket(t, { userId: anna.id, at: at(t.clock, -48) });
    const future = insertTicket(t, { userId: anna.id, at: at(t.clock, 24) });
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.tickets, 1);
    assert.deepEqual(
      many<{ id: number }>(t.db, 'SELECT id FROM tickets ORDER BY id').map((r) => r.id),
      [atCutoff, recent, future],
    );
    assert.ok(!many<{ id: number }>(t.db, 'SELECT id FROM tickets').some((r) => r.id === before));
    // A ticket does not take anything else with it, and the other counts stay at zero.
    assert.deepEqual({ ...result }, { cutoff: CUTOFF, reservations: 0, usage: 0, fuel: 0, fuelRequests: 0, tickets: 1, odometerExplained: 0, damageReports: 0, sessions: 0 });
    t.clock.advance(1); // one millisecond later the window has moved past the one at the edge
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).tickets, 1);
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).tickets, 0, 'idempotent');
  } finally {
    await t.close();
  }
});

test('the admin retention page counts tickets and shows the oldest, and a purge result stored before tickets existed is returned as stored', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    assert.equal((await admin.get('/api/admin/retention')).body.oldest.ticketAt, null);
    insertTicket(t, { userId: anna.id, at: at(t.clock, -10) });
    insertTicket(t, { userId: anna.id, at: at(t.clock, -20) });
    const status = (await admin.get('/api/admin/retention')).body;
    assert.equal(status.counts.tickets, 2);
    assert.equal(status.oldest.ticketAt, at(t.clock, -20));
    // The previous release stored no `tickets` key: the page reads it with ?? 0, the server hands it back untouched.
    run(t.db, "INSERT INTO meta (key, value) VALUES ('last_purge', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ cutoff: CUTOFF, reservations: 1, usage: 2, fuel: 3, fuelRequests: 4, sessions: 5 }));
    const old = (await admin.get('/api/admin/retention')).body;
    assert.equal(old.lastPurge.tickets, undefined);
    assert.equal(old.lastPurge.fuelRequests, 4);
    // A manual run stores the new shape, with tickets.
    const run1 = await admin.post('/api/admin/retention/run');
    assert.equal(run1.body.result.tickets, 0);
    assert.equal(run1.body.status.lastPurge.tickets, 0);
  } finally {
    await t.close();
  }
});

test('the purge command says how many tickets it removed', async (tctx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-ret-cli-'));
  tctx.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { DATA_DIR: dir, SCRYPT_N: '1024', SCRYPT_P: '1' };
  // The command prints its sentence on `out` (the JSON log line goes to `err`); the clock is fixed so the cutoff is too.
  const purgeLine = async (): Promise<string> => {
    const out: string[] = [];
    const io: CliIo = { readStdin: async () => '', out: (l) => out.push(l), err: () => undefined };
    assert.equal(await runCli(['purge'], env, io, makeClock(NOW)), 0);
    return out.join('\n');
  };

  assert.equal(
    await purgeLine(),
    `Purged 0 reservations, 0 usage records, 0 fill-ups (0 payment requests), 0 tickets, 0 odometer explanations, 0 repaired damage reports and 0 expired sessions older than ${CUTOFF}. Open damage reports are never purged.`,
  );

  const db = openDb(path.join(dir, 'car.db'));
  const user = run(db, "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES ('anna', 'Anna', 'x', 'member', 'now', 'now')").lastInsertRowid;
  for (const when of [shift(CUTOFF, -HOUR), shift(CUTOFF, -2 * HOUR), CUTOFF]) {
    run(db, 'INSERT INTO tickets (at_utc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)', when, user, 'now', 'now');
  }
  db.close();
  assert.equal(
    await purgeLine(),
    `Purged 0 reservations, 0 usage records, 0 fill-ups (0 payment requests), 2 tickets, 0 odometer explanations, 0 repaired damage reports and 0 expired sessions older than ${CUTOFF}. Open damage reports are never purged.`,
    'two tickets removed, the one exactly at the cutoff kept',
  );
});

// ----------------------------------------------- odometer explanations and the chain

function insertExplained(t: TestApp, key: string, prevAt: string, by: number): number {
  return run(t.db, 'INSERT INTO odometer_explained (item_key, prev_at, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', key, prevAt, 'why', by, 'now', 'now').lastInsertRowid;
}

test('odometer explanations are purged when their earlier reading is strictly before the cutoff (boundary +/- 1 ms), and counted', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    const before = insertExplained(t, 'before', shift(CUTOFF, -1), anna.id);
    const atCutoff = insertExplained(t, 'at', CUTOFF, anna.id);
    const recent = insertExplained(t, 'recent', at(t.clock, -48), anna.id);
    assert.equal((await admin.get('/api/admin/retention')).body.counts.odometerExplained, 3);
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.odometerExplained, 1);
    assert.deepEqual(
      many<{ id: number }>(t.db, 'SELECT id FROM odometer_explained ORDER BY id').map((r) => r.id),
      [atCutoff, recent],
    );
    assert.ok(!many<{ id: number }>(t.db, 'SELECT id FROM odometer_explained').some((r) => r.id === before));
    assert.deepEqual({ ...result }, { cutoff: CUTOFF, reservations: 0, usage: 0, fuel: 0, fuelRequests: 0, tickets: 0, odometerExplained: 1, damageReports: 0, sessions: 0 });
    assert.equal((await admin.get('/api/admin/retention')).body.counts.odometerExplained, 2);
    t.clock.advance(1); // one millisecond later the window has moved past the one at the edge
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).odometerExplained, 1);
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).odometerExplained, 0, 'idempotent');
  } finally {
    await t.close();
  }
});

test('a purge result stored before odometer explanations existed is returned as stored, and a manual run stores the new key', async () => {
  const { t, admin } = await createHousehold();
  try {
    run(t.db, "INSERT INTO meta (key, value) VALUES ('last_purge', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ cutoff: CUTOFF, reservations: 1, usage: 2, fuel: 3, fuelRequests: 4, tickets: 6, sessions: 5 }));
    const old = (await admin.get('/api/admin/retention')).body;
    assert.equal(old.lastPurge.odometerExplained, undefined, 'the page reads it with ?? 0');
    assert.equal(old.lastPurge.tickets, 6);
    const manual = await admin.post('/api/admin/retention/run');
    assert.equal(manual.body.result.odometerExplained, 0);
    assert.equal(manual.body.status.lastPurge.odometerExplained, 0);
  } finally {
    await t.close();
  }
});

test('the odometer chain does not change when the purge runs: a drive that straddles the cutoff keeps its end as the oldest reading, with no predecessor', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    // Before the window: nothing here may be anybody's predecessor. Drive 1 ends at 100, drive 2 starts at 150 (a 50 km gap, but too old to flag).
    insertUsage(t, { userId: carla.id, start: shift(CUTOFF, -3 * HOUR), end: shift(CUTOFF, -2 * HOUR), odometerStart: 50, odometerEnd: 100 });
    const straddle = insertUsage(t, { userId: anna.id, start: shift(CUTOFF, -HOUR), end: shift(CUTOFF, HOUR), odometerStart: 150, odometerEnd: 300 });
    insertUsage(t, { userId: ben.id, start: shift(CUTOFF, 2 * HOUR), end: shift(CUTOFF, 3 * HOUR), odometerStart: 350, odometerEnd: 400 });
    const view = async () => (await anna.get('/api/odometer')).body;
    const derive = async () => {
      const body = await view();
      return { readings: body.readings, items: body.items.map((i: { key: string; kind: string; km: number }) => [i.key, i.kind, i.km]) };
    };
    const beforePurge = await derive();
    assert.deepEqual(beforePurge.readings.map((r: { source: string; id: number; km: number }) => [r.source, r.id, r.km]), [['drive-end', straddle, 300], ['drive-start', straddle + 1, 350], ['drive-end', straddle + 1, 400]]);
    assert.deepEqual(beforePurge.items.map((i: unknown[]) => [i[1], i[2]]), [['gap', 50]], 'only the gap inside the window; the old drive is nobody\'s predecessor');
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.usage, 1, 'the old drive is gone, the straddling one stays');
    assert.deepEqual(await derive(), beforePurge, 'derive, purge, derive again: the same');
  } finally {
    await t.close();
  }
});

test('a reading exactly at the cutoff takes part in the chain, one a millisecond before does not, and the purge changes nothing about it', async () => {
  const { t, anna } = await createHousehold();
  try {
    insertFuel(t, { userId: anna.id, at: shift(CUTOFF, -1), odometer: 500 });
    insertFuel(t, { userId: anna.id, at: CUTOFF, odometer: 520 });
    insertFuel(t, { userId: anna.id, at: shift(CUTOFF, HOUR), odometer: 560 });
    const view = async (): Promise<unknown> => {
      const body = (await anna.get('/api/odometer')).body;
      return { readings: body.readings.map((r: { km: number }) => r.km), items: body.items.map((i: { kind: string; km: number }) => [i.kind, i.km]) };
    };
    const expected = { readings: [520, 560], items: [['gap', 40]] };
    assert.deepEqual(await view(), expected, 'the 500 reading is outside the window, so there is no 20 km gap before 520');
    purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(many(t.db, 'SELECT id FROM fuel').length, 2, 'the purge removed the one before the cutoff only');
    assert.deepEqual(await view(), expected);
  } finally {
    await t.close();
  }
});

test('an explanation made through the API leaves with its pair: kept while the earlier reading is at the cutoff, gone the millisecond after, and the finding is gone before the purge even runs', async () => {
  const { t, admin, carla, ben } = await createHousehold();
  try {
    // Carla's drive ends exactly at the cutoff with 200 on the clock; Ben starts an hour later at 260: a 60 km gap.
    insertUsage(t, { userId: carla.id, start: shift(CUTOFF, -HOUR), end: CUTOFF, odometerStart: 100, odometerEnd: 200 });
    insertUsage(t, { userId: ben.id, start: shift(CUTOFF, HOUR), end: shift(CUTOFF, 2 * HOUR), odometerStart: 260, odometerEnd: 300 });
    const gap = (await admin.get('/api/odometer')).body.items[0];
    assert.deepEqual([gap.kind, gap.km, gap.prev.at], ['gap', 60, CUTOFF]);
    assert.equal((await admin.post('/api/odometer/explain', { key: gap.key, note: 'before the check existed' })).status, 201);

    // At the cutoff itself the explanation is still there, still applies, and is not purged.
    const first = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.deepEqual([first.usage, first.odometerExplained], [0, 0]);
    assert.equal((await carla.get('/api/odometer')).body.items[0].explained.note, 'before the check existed');

    // A millisecond later the earlier reading is outside the window: the finding is gone at once (the chain
    // does not wait for the purge), the stale row is still stored, and the purge then deletes exactly it.
    t.clock.advance(1);
    const mid = (await carla.get('/api/odometer')).body;
    assert.deepEqual(mid.items, [], 'no predecessor for the oldest reading left in the window');
    assert.deepEqual(mid.readings.map((r: { km: number }) => r.km), [260, 300]);
    assert.equal(many(t.db, 'SELECT id FROM odometer_explained').length, 1, 'the row is still stored until the purge');
    const second = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.deepEqual([second.usage, second.odometerExplained], [1, 1]);
    assert.equal(many(t.db, 'SELECT id FROM odometer_explained').length, 0);
    assert.deepEqual((await carla.get('/api/odometer')).body, mid, 'derive, purge, derive again: the same');
  } finally {
    await t.close();
  }
});

test('an abandoned old draft is purged like any other old row, a recent one is kept', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const stale = insertDraft(t, { userId: anna.id, start: shift(CUTOFF, -2 * HOUR) });
    const fresh = insertDraft(t, { userId: ben.id, start: at(t.clock, -1) });
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.usage, 1);
    assert.deepEqual(ids(t, 'usage'), [fresh]);
    assert.ok(!ids(t, 'usage').includes(stale));
  } finally {
    await t.close();
  }
});

// ----------------------------------------------- damage reports (the Car tab)

const damageIds = (t: TestApp): number[] => many<{ id: number }>(t.db, 'SELECT id FROM damage_reports ORDER BY id').map((r) => r.id);

test('an open damage report is never purged, however old; a repaired one goes by the day it was repaired, strictly before the first day of the window', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    // NOW is 12:00 on 15 June 2026 in Amsterdam, so the window starts on 15 December 2025.
    const openAncient = insertDamage(t, { reportedBy: anna.id, noticedOn: '2020-01-01' });
    const openLastYear = insertDamage(t, { reportedBy: anna.id, noticedOn: '2025-01-01' });
    const dayBefore = insertDamage(t, { reportedBy: anna.id, noticedOn: '2025-01-01', repairedOn: '2025-12-14' });
    const onCutoffDay = insertDamage(t, { reportedBy: anna.id, noticedOn: '2025-01-01', repairedOn: '2025-12-15' });
    const dayAfter = insertDamage(t, { reportedBy: anna.id, noticedOn: '2025-01-01', repairedOn: '2025-12-16' });
    const longAgo = insertDamage(t, { reportedBy: anna.id, noticedOn: '2020-01-01', repairedOn: '2020-02-01' });
    const recent = insertDamage(t, { reportedBy: anna.id, noticedOn: '2026-06-01', repairedOn: '2026-06-10' });
    assert.equal((await admin.get('/api/admin/retention')).body.counts.damageReports, 7);
    assert.equal((await admin.get('/api/admin/retention')).body.oldest.damageRepairedOn, '2020-02-01', 'the oldest figure only looks at repaired reports');

    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.equal(result.damageReports, 2, 'the one repaired the day before and the one repaired years ago');
    assert.deepEqual(damageIds(t), [openAncient, openLastYear, onCutoffDay, dayAfter, recent], 'both open ones, and the repaired ones from the cutoff day on');
    assert.ok(![dayBefore, longAgo].some((id) => damageIds(t).includes(id)));
    assert.deepEqual({ ...result }, { cutoff: CUTOFF, reservations: 0, usage: 0, fuel: 0, fuelRequests: 0, tickets: 0, odometerExplained: 0, damageReports: 2, sessions: 0 });
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).damageReports, 0, 'idempotent');

    const status = (await admin.get('/api/admin/retention')).body;
    assert.equal(status.counts.damageReports, 5);
    assert.equal(status.oldest.damageRepairedOn, '2025-12-15');
    // The next day the report repaired on the cutoff day has fallen out of the window too.
    t.clock.advance(24 * HOUR);
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).damageReports, 1);
    assert.deepEqual(damageIds(t), [openAncient, openLastYear, dayAfter, recent]);
  } finally {
    await t.close();
  }
});

test('a report that was repaired long ago and is reopened is open again, so the purge keeps it; an open report that is repaired starts its six months from that day', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    const id = insertDamage(t, { reportedBy: anna.id, noticedOn: '2020-01-01', repairedOn: '2020-02-01', repairNote: 'garage' });
    const reopened = await anna.patch(`/api/damage/${id}`, { status: 'open' });
    assert.equal(reopened.status, 200, reopened.text);
    assert.deepEqual([reopened.body.report.status, reopened.body.report.repairedOn, reopened.body.report.repairNote], ['open', null, '']);
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).damageReports, 0);
    assert.deepEqual(damageIds(t), [id]);

    // Repaired today: kept now, and deleted once the window has moved past that day.
    assert.equal((await admin.post(`/api/damage/${id}/repair`, { repairedOn: '2026-06-15' })).status, 200);
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).damageReports, 0);
    t.clock.set('2026-12-15T10:00:00.000Z'); // the window now starts on 15 June 2026 ...
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).damageReports, 0, '... the repaired day itself is still inside it');
    t.clock.set('2026-12-16T10:00:00.000Z');
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).damageReports, 1, 'and the day after it has fallen out');
    assert.deepEqual(damageIds(t), []);
  } finally {
    await t.close();
  }
});

test('the cutoff day of a repaired report is the local calendar day, not the UTC date of the cutoff instant', async () => {
  // 00:30 on 15 June in Amsterdam is 22:30 UTC on the 14th. Six months back is 00:30 on 15 December local = 23:30 UTC on the 14th:
  // the UTC date of the cutoff is the 14th, the local one the 15th.
  const t = await createTestApp({ now: '2026-06-14T22:30:00.000Z' });
  try {
    const anna = await t.signIn('anna');
    const dec14 = insertDamage(t, { reportedBy: anna.id, noticedOn: '2025-01-01', repairedOn: '2025-12-14' });
    const dec15 = insertDamage(t, { reportedBy: anna.id, noticedOn: '2025-01-01', repairedOn: '2025-12-15' });
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).cutoff, '2025-12-14T23:30:00.000Z');
    assert.deepEqual(damageIds(t), [dec15], 'repaired on the local 14th: before the local 15th, so deleted; the 15th stays');
    assert.ok(!damageIds(t).includes(dec14));
  } finally {
    await t.close();
  }
});

test('damage reports are counted by the retention page, and a purge result stored before the Car tab existed is returned as stored', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    assert.equal((await admin.get('/api/admin/retention')).body.oldest.damageRepairedOn, null, 'nothing repaired yet');
    insertDamage(t, { reportedBy: anna.id });
    assert.equal((await admin.get('/api/admin/retention')).body.oldest.damageRepairedOn, null, 'an open report has no repaired day');
    insertDamage(t, { reportedBy: anna.id, repairedOn: '2026-06-12' });
    insertDamage(t, { reportedBy: anna.id, repairedOn: '2026-06-11' });
    const status = (await admin.get('/api/admin/retention')).body;
    assert.equal(status.counts.damageReports, 3);
    assert.equal(status.oldest.damageRepairedOn, '2026-06-11');
    // The previous release stored no damageReports key: the page reads it with ?? 0, the server hands it back untouched.
    run(t.db, "INSERT INTO meta (key, value) VALUES ('last_purge', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ cutoff: CUTOFF, reservations: 1, usage: 2, fuel: 3, fuelRequests: 4, tickets: 6, odometerExplained: 7, sessions: 5 }));
    const old = (await admin.get('/api/admin/retention')).body;
    assert.equal(old.lastPurge.damageReports, undefined);
    assert.equal(old.lastPurge.odometerExplained, 7);
    const manual = await admin.post('/api/admin/retention/run');
    assert.equal(manual.body.result.damageReports, 0);
    assert.equal(manual.body.status.lastPurge.damageReports, 0);
  } finally {
    await t.close();
  }
});

test('the APK record is never purged, however old its date or its last update, and the purge neither counts nor reports it', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    insertApk(t, { userId: anna.id, expiresOn: '2019-03-01' });
    run(t.db, "UPDATE car_apk SET updated_at = '2019-01-01T00:00:00.000Z'");
    const result = purge(t.db, t.clock.now(), TZ, t.ctx.log);
    assert.deepEqual({ ...result }, { cutoff: CUTOFF, reservations: 0, usage: 0, fuel: 0, fuelRequests: 0, tickets: 0, odometerExplained: 0, damageReports: 0, sessions: 0 }, 'nothing counted, no APK key');
    assert.deepEqual(many(t.db, 'SELECT id, expires_on, updated_by, updated_at FROM car_apk'), [{ id: 1, expires_on: '2019-03-01', updated_by: anna.id, updated_at: '2019-01-01T00:00:00.000Z' }], 'the one row is still there, unchanged');
    // A purge that does remove other things leaves it alone too, and the page still shows it as expired.
    insertDamage(t, { reportedBy: anna.id, noticedOn: '2020-01-01', repairedOn: '2020-02-01' });
    assert.equal(purge(t.db, t.clock.now(), TZ, t.ctx.log).damageReports, 1);
    assert.equal(many(t.db, 'SELECT id FROM car_apk').length, 1);
    const apk = (await admin.get('/api/car/apk')).body.apk;
    assert.deepEqual([apk.expiresOn, apk.updatedBy.name, apk.daysLeft < 0], ['2019-03-01', 'Anna', true]);
    const status = (await admin.get('/api/admin/retention')).body;
    assert.ok(!JSON.stringify(status.counts).includes('apk') && !JSON.stringify(status.oldest).includes('apk'), 'it is not something that is kept for six months, so the retention page does not list it');
  } finally {
    await t.close();
  }
});

test('the purge command counts the repaired damage reports it removed, and says that open ones are never purged', async (tctx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-ret-cli-damage-'));
  tctx.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { DATA_DIR: dir, SCRYPT_N: '1024', SCRYPT_P: '1' };
  const db = openDb(path.join(dir, 'car.db'));
  const user = run(db, "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES ('anna', 'Anna', 'x', 'member', 'now', 'now')").lastInsertRowid;
  const add = (noticedOn: string, repairedOn: string | null): void => {
    run(
      db,
      `INSERT INTO damage_reports (noticed_on, reported_by, description, location, status, repaired_on, created_at, updated_at) VALUES (?, ?, 'A dent', 'front', ?, ?, 'now', 'now')`,
      noticedOn,
      user,
      repairedOn ? 'repaired' : 'open',
      repairedOn,
    );
  };
  add('2020-01-01', null); // open for years: stays
  add('2025-01-01', '2025-12-14'); // repaired before the window: goes
  add('2025-01-01', '2025-12-15'); // repaired on the first day of the window: stays
  db.close();
  const out: string[] = [];
  const io: CliIo = { readStdin: async () => '', out: (l) => out.push(l), err: () => undefined };
  assert.equal(await runCli(['purge'], env, io, makeClock(NOW)), 0);
  assert.equal(
    out.join('\n'),
    `Purged 0 reservations, 0 usage records, 0 fill-ups (0 payment requests), 0 tickets, 0 odometer explanations, 1 repaired damage reports and 0 expired sessions older than ${CUTOFF}. Open damage reports are never purged.`,
  );
  const after = openDb(path.join(dir, 'car.db'));
  assert.deepEqual(many(after, 'SELECT noticed_on, status FROM damage_reports ORDER BY id'), [
    { noticed_on: '2020-01-01', status: 'open' },
    { noticed_on: '2025-01-01', status: 'repaired' },
  ]);
  after.close();
});
