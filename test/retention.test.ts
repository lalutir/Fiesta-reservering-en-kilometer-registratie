import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli.ts';
import { many, one, openDb, run } from '../src/db.ts';
import { purge } from '../src/retention.ts';
import { ODO, at, createHousehold, createTestApp, insertDraft, insertFuel, insertReservation, insertTicket, insertUsage, makeClock, type TestApp } from './helpers.ts';

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
    assert.deepEqual({ ...res.body.result }, { cutoff: CUTOFF, reservations: 2, usage: 1, fuel: 0, fuelRequests: 0, tickets: 0, sessions: 0 });
    const lines = t.logs.filter((l) => l['event'] === 'retention.purge');
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0] }, { event: 'retention.purge', cutoff: CUTOFF, reservations: 2, usage: 1, fuel: 0, fuelRequests: 0, tickets: 0, sessions: 0 });

    const status = (await admin.get('/api/admin/retention')).body;
    assert.equal(status.cutoff, CUTOFF);
    assert.equal(status.windowMonths, 6);
    assert.deepEqual(status.window, { from: CUTOFF, to: '2026-12-15T11:00:00.000Z' });
    assert.equal(status.lastPurgeAt, NOW);
    assert.deepEqual({ ...status.lastPurge }, { cutoff: CUTOFF, reservations: 2, usage: 1, fuel: 0, fuelRequests: 0, tickets: 0, sessions: 0 });
    assert.deepEqual(status.counts, { reservations: 0, usage: 0, fuel: 0, fuelRequests: 0, tickets: 0, sessions: status.counts.sessions });
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
    assert.deepEqual({ ...result }, { cutoff: CUTOFF, reservations: 0, usage: 0, fuel: 0, fuelRequests: 0, tickets: 1, sessions: 0 });
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
    `Purged 0 reservations, 0 usage records, 0 fill-ups (0 payment requests), 0 tickets and 0 expired sessions older than ${CUTOFF}.`,
  );

  const db = openDb(path.join(dir, 'car.db'));
  const user = run(db, "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES ('anna', 'Anna', 'x', 'member', 'now', 'now')").lastInsertRowid;
  for (const when of [shift(CUTOFF, -HOUR), shift(CUTOFF, -2 * HOUR), CUTOFF]) {
    run(db, 'INSERT INTO tickets (at_utc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)', when, user, 'now', 'now');
  }
  db.close();
  assert.equal(
    await purgeLine(),
    `Purged 0 reservations, 0 usage records, 0 fill-ups (0 payment requests), 2 tickets and 0 expired sessions older than ${CUTOFF}.`,
    'two tickets removed, the one exactly at the cutoff kept',
  );
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
