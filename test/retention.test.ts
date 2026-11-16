import { test } from 'node:test';
import assert from 'node:assert/strict';
import { many, one, run } from '../src/db.ts';
import { purge } from '../src/retention.ts';
import { at, createHousehold, createTestApp, insertReservation, insertUsage, type TestApp } from './helpers.ts';

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
    const use = await anna.post('/api/usage', { start: shift(CUTOFF, -3 * HOUR), end: CUTOFF });
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
    assert.deepEqual({ ...res.body.result }, { cutoff: CUTOFF, reservations: 2, usage: 1, sessions: 0 });
    const lines = t.logs.filter((l) => l['event'] === 'retention.purge');
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...lines[0] }, { event: 'retention.purge', cutoff: CUTOFF, reservations: 2, usage: 1, sessions: 0 });

    const status = (await admin.get('/api/admin/retention')).body;
    assert.equal(status.cutoff, CUTOFF);
    assert.equal(status.windowMonths, 6);
    assert.deepEqual(status.window, { from: CUTOFF, to: '2026-12-15T11:00:00.000Z' });
    assert.equal(status.lastPurgeAt, NOW);
    assert.deepEqual({ ...status.lastPurge }, { cutoff: CUTOFF, reservations: 2, usage: 1, sessions: 0 });
    assert.deepEqual(status.counts, { reservations: 0, usage: 0, sessions: status.counts.sessions });
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
