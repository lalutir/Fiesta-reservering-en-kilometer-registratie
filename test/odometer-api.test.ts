import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { MIGRATIONS, many, one, openDb, run } from '../src/db.ts';
import { fuelOverview } from '../src/fuel.ts';
import { PASSWORD, FUEL_ODO, at, createHousehold, insertDraft, insertFuel, insertUsage, makeClock, type Client, type Json, Client as HttpClient } from './helpers.ts';

// The routes of the odometer check (GET /api/odometer, explain, remove) and the fill-up odometer in
// /api/fuel. The pure derivation is in odometer.test.ts.

// ------------------------------------------------------------ B. the routes

/**
 * Anna drives 2000 to 2100, Ben drives 2130 to 2180 (30 km nobody registered between them), and Carla
 * fuels at 2150 (30 km below Ben's end reading). Ids: admin 1, Anna 2, Ben 3, Carla 4.
 */
async function chainHousehold() {
  const h = await createHousehold();
  const { t, anna, ben, carla } = h;
  const a = insertUsage(t, { userId: anna.id, start: at(t.clock, -10), end: at(t.clock, -9), odometerStart: 2000, odometerEnd: 2100 });
  const b = insertUsage(t, { userId: ben.id, start: at(t.clock, -8), end: at(t.clock, -7), odometerStart: 2130, odometerEnd: 2180 });
  const f = insertFuel(t, { userId: carla.id, at: at(t.clock, -5), odometer: 2150 });
  return { ...h, a, b, f };
}
const gapOf = (body: Json): Json => body.items.find((i: Json) => i.kind === 'gap');
const mismatchOf = (body: Json): Json => body.items.find((i: Json) => i.kind === 'mismatch');
const explain = (who: Client, item: Json, note: string) => who.post('/api/odometer/explain', { key: item.key, note });
const rows = (t: { db: Parameters<typeof one>[0] }): number => one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM odometer_explained')?.n ?? -1;

test('the odometer routes are for signed-in users only', async () => {
  const { t } = await chainHousehold();
  try {
    assert.equal((await t.client().get('/api/odometer')).status, 401);
    assert.equal((await t.client().post('/api/odometer/explain', { key: 'x', note: 'y' })).status, 401);
    assert.equal((await t.client().del('/api/odometer/explained/1')).status, 401);
  } finally {
    await t.close();
  }
});

test('GET /api/odometer returns the readings in order, the findings newest first with both neighbours, and the latest reading', async () => {
  const { t, anna, a, b, f } = await chainHousehold();
  try {
    const res = await anna.get('/api/odometer');
    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(typeof body.window.from, 'string');
    assert.deepEqual(
      body.readings.map((r: Json) => [r.source, r.id, r.km, r.userName]),
      [['drive-start', a, 2000, 'Anna'], ['drive-end', a, 2100, 'Anna'], ['drive-start', b, 2130, 'Ben'], ['drive-end', b, 2180, 'Ben'], ['fuel', f, 2150, 'Carla']],
    );
    assert.deepEqual(body.items.map((i: Json) => [i.kind, i.km]), [['mismatch', 30], ['gap', 30]], 'newest first');
    const gap = gapOf(body);
    assert.deepEqual([gap.prev.source, gap.prev.userName, gap.prev.km, gap.prev.at], ['drive-end', 'Anna', 2100, at(t.clock, -9)]);
    assert.deepEqual([gap.next.source, gap.next.userName, gap.next.km, gap.next.at], ['drive-start', 'Ben', 2130, at(t.clock, -8)]);
    assert.equal(gap.explained, null);
    assert.deepEqual(body.latest, body.readings[4]);
    assert.equal(body.latest.source, 'fuel');
  } finally {
    await t.close();
  }
});

test('everybody sees the same findings: a member, an outsider and the admin get the same list', async () => {
  const { t, admin, anna, ben, carla } = await chainHousehold();
  try {
    const lists = [];
    for (const who of [admin, anna, ben, carla]) lists.push((await who.get('/api/odometer')).body.items.map((i: Json) => ({ ...i, can: undefined })));
    for (const l of lists) assert.deepEqual(l, lists[0]);
    assert.equal(lists[0].length, 2);
  } finally {
    await t.close();
  }
});

test('an empty household has an empty chain and no latest reading', async () => {
  const { t, anna } = await createHousehold();
  try {
    const body = (await anna.get('/api/odometer')).body;
    assert.deepEqual([body.readings, body.items, body.latest], [[], [], null]);
  } finally {
    await t.close();
  }
});

test('explain: who may, what it needs, and how a note shows up for everybody', async () => {
  const { t, admin, anna, ben, carla } = await chainHousehold();
  try {
    const first = (await anna.get('/api/odometer')).body;
    const gap = gapOf(first);
    const mismatch = mismatchOf(first);
    // can flags: the driver of the earlier reading, the driver of the later one, and the admin; not Carla for the gap.
    const flags = async (who: Client, kind: string): Promise<Json> => (await who.get('/api/odometer')).body.items.find((i: Json) => i.kind === kind).can;
    const canExplain = async (kind: string): Promise<boolean[]> => [(await flags(anna, kind)).explain, (await flags(ben, kind)).explain, (await flags(carla, kind)).explain, (await flags(admin, kind)).explain];
    assert.deepEqual(await canExplain('gap'), [true, true, false, true]);
    assert.deepEqual(await canExplain('mismatch'), [false, true, true, true]);
    assert.deepEqual([(await flags(anna, 'gap')).unexplain, (await flags(admin, 'gap')).unexplain], [false, false], 'nothing to remove yet');

    // Somebody who is not at either end gets a 403, however good the note.
    assert.equal((await explain(carla, gap, 'I was there')).status, 403);
    assert.equal((await explain(anna, mismatch, 'I was there')).status, 403);
    assert.equal(rows(t), 0);

    // The driver of the earlier reading, the driver of the later one, the fueler and the admin may.
    const made = await explain(anna, gap, 'Ben took the car for a day trip and forgot to log it');
    assert.equal(made.status, 201);
    assert.equal(made.body.item.explained.note, 'Ben took the car for a day trip and forgot to log it');
    assert.equal(made.body.item.explained.byName, 'Anna');
    assert.equal((await explain(ben, mismatch, 'typo, fixed elsewhere')).status, 201);
    assert.equal((await explain(admin, gap, 'an outsider drove')).status, 200, 'a second note on the same pair replaces the first');
    assert.equal((await explain(carla, mismatch, 'pump display is off')).status, 200, 'the fueler may too');
    assert.equal(rows(t), 2, 'one explanation per pair');

    // Everybody sees the note and who wrote it, and the items are silenced rather than removed.
    const seen = (await carla.get('/api/odometer')).body;
    assert.deepEqual(
      seen.items.map((i: Json) => [i.kind, i.explained.note, i.explained.byName]),
      [['mismatch', 'pump display is off', 'Carla'], ['gap', 'an outsider drove', 'Admin']],
    );
  } finally {
    await t.close();
  }
});

test('explain needs a key that is flagged right now and a note of 1 to 500 characters after trimming', async () => {
  const { t, anna } = await chainHousehold();
  try {
    const gap = gapOf((await anna.get('/api/odometer')).body);
    for (const note of ['', '   ', '\n\t ']) {
      const res = await explain(anna, gap, note);
      assert.deepEqual([res.status, res.body.error.fields.note], [422, 'required'], JSON.stringify(note));
    }
    const missing = await anna.post('/api/odometer/explain', { key: gap.key });
    assert.deepEqual([missing.status, missing.body.error.fields.note], [422, 'required']);
    const noKey = await anna.post('/api/odometer/explain', { note: 'x' });
    assert.deepEqual([noKey.status, noKey.body.error.fields.key], [422, 'required']);
    const tooLong = await explain(anna, gap, 'x'.repeat(501));
    assert.deepEqual([tooLong.status, tooLong.body.error.fields.note], [422, 'too_long']);
    // A note of NUL characters has SQLite length 0: it must be a 422, not the table's CHECK failing as a 500.
    for (const note of ['\0', ' \0 ', '\0'.repeat(5)]) {
      const nul = await explain(anna, gap, note);
      assert.deepEqual([nul.status, nul.body.error.fields.note], [422, 'invalid_value'], JSON.stringify(note));
    }
    assert.equal(rows(t), 0, 'nothing was stored');
    assert.equal((await explain(anna, gap, `  ${'x'.repeat(500)}  `)).status, 201, '500 characters is fine, and the note is trimmed');
    assert.equal(one<{ note: string }>(t.db, 'SELECT note FROM odometer_explained')?.note, 'x'.repeat(500));

    // A key that is not flagged (made up, or from a pair that changed) is a 404 and stores nothing.
    const stale = await anna.post('/api/odometer/explain', { key: 'drive-end:1:1:2026-01-01T00:00:00.000Z:2>drive-start:2:9:2026-01-01T01:00:00.000Z:3', note: 'x' });
    assert.deepEqual([stale.status, stale.body.error.code], [404, 'not_found']);
    assert.equal(rows(t), 1);
  } finally {
    await t.close();
  }
});

test('removing an explanation: the same people, and not when the pair is gone', async () => {
  const { t, admin, anna, ben, carla, b } = await chainHousehold();
  try {
    const gap = gapOf((await anna.get('/api/odometer')).body);
    await explain(anna, gap, 'someone else drove');
    const noted = async (who: Client): Promise<Json> => (await who.get('/api/odometer')).body.items.find((i: Json) => i.kind === 'gap');
    const id = (await noted(anna)).explained.id;
    assert.equal((await noted(carla)).can.unexplain, false);
    assert.equal((await noted(ben)).can.unexplain, true);
    assert.equal((await carla.del(`/api/odometer/explained/${id}`)).status, 403);
    assert.equal((await anna.del('/api/odometer/explained/9999')).status, 404);
    assert.equal((await ben.del(`/api/odometer/explained/${id}`)).status, 204, 'the driver at the other end may remove it');
    assert.equal((await noted(carla)).explained, null, 'open again');
    assert.equal((await anna.del(`/api/odometer/explained/${id}`)).status, 404, 'already gone');

    await explain(admin, gap, 'again');
    const second = (await noted(anna)).explained.id;
    // The pair changes: the note no longer applies, and nobody is left to answer for it.
    assert.equal((await admin.patch(`/api/usage/${b}`, { odometerStart: 2131 })).status, 200);
    assert.equal((await admin.del(`/api/odometer/explained/${second}`)).status, 404);
    assert.equal(rows(t), 1, 'the stale row stays until the purge');
  } finally {
    await t.close();
  }
});

test('an explanation stops applying when either reading, its time or its driver changes, or a drive is added in the gap; it applies again if the exact pair comes back', async () => {
  const { t, admin, anna, carla, a, b, f } = await chainHousehold();
  try {
    const open = async (kind: string): Promise<Json> => (await carla.get('/api/odometer')).body.items.find((i: Json) => i.kind === kind);
    const silenced = async (kind: string): Promise<boolean> => (await open(kind))?.explained != null;
    await explain(admin, await open('gap'), 'before the check existed');
    await explain(admin, await open('mismatch'), 'typo');
    assert.equal(await silenced('gap'), true);
    assert.equal(await silenced('mismatch'), true);

    // The earlier reading (a drive's end) is edited: the gap is 29 km now and not explained.
    assert.equal((await admin.patch(`/api/usage/${a}`, { odometerEnd: 2101 })).status, 200);
    assert.deepEqual([(await open('gap')).km, await silenced('gap'), await silenced('mismatch')], [29, false, true], 'only that pair is affected');
    // And back: the exact pair is the explained one again.
    assert.equal((await admin.patch(`/api/usage/${a}`, { odometerEnd: 2100 })).status, 200);
    assert.equal(await silenced('gap'), true, 'the same pair re-applies its note');

    // The later reading changes its time.
    assert.equal((await admin.patch(`/api/usage/${b}`, { start: at(t.clock, -8.5) })).status, 200);
    assert.equal(await silenced('gap'), false);
    assert.equal((await admin.patch(`/api/usage/${b}`, { start: at(t.clock, -8) })).status, 200);
    assert.equal(await silenced('gap'), true);

    // The driver of a reading changes (an admin reassigns the drive).
    assert.equal((await admin.patch(`/api/usage/${b}`, { userId: carla.id })).status, 200);
    assert.equal(await silenced('gap'), false);
    assert.equal((await admin.patch(`/api/usage/${b}`, { userId: 3 })).status, 200);
    assert.equal(await silenced('gap'), true);

    // The fill-up's odometer is corrected: the mismatch is a different one.
    assert.equal((await carla.patch(`/api/fuel/${f}`, { odometer: 2151 })).status, 200);
    assert.deepEqual([(await open('mismatch')).km, await silenced('mismatch')], [29, false]);
    assert.equal((await carla.patch(`/api/fuel/${f}`, { odometer: 2150 })).status, 200);
    assert.equal(await silenced('mismatch'), true);

    // A drive is added inside the gap: the two readings are no longer neighbours.
    const inGap = await anna.post('/api/usage', { start: at(t.clock, -8.6), end: at(t.clock, -8.4), odometerStart: 2100, odometerEnd: 2110 });
    assert.equal(inGap.status, 201, inGap.text);
    const now = (await carla.get('/api/odometer')).body;
    assert.deepEqual(now.items.filter((i: Json) => i.kind === 'gap').map((i: Json) => [i.km, i.explained]), [[20, null]], 'the 30 km became a 20 km gap that nobody explained');
    assert.equal(rows(t), 2, 'both notes are still stored');
    // Deleting that drive brings the old pair, and its note, back.
    assert.equal((await anna.del(`/api/usage/${inGap.body.usage.id}`)).status, 204);
    assert.equal(await silenced('gap'), true);
  } finally {
    await t.close();
  }
});

test('the log says an explanation was made, by whom and how big, and never what it says', async () => {
  const { t, anna } = await chainHousehold();
  try {
    const gap = gapOf((await anna.get('/api/odometer')).body);
    await explain(anna, gap, 'SECRET-NOTE-about-a-person');
    const id = (await anna.get('/api/odometer')).body.items.find((i: Json) => i.kind === 'gap').explained.id;
    await anna.del(`/api/odometer/explained/${id}`);
    const lines = t.logs.filter((l) => String(l['event']).startsWith('odometer.'));
    assert.deepEqual(lines.map((l) => l['event']), ['odometer.explained', 'odometer.unexplained']);
    assert.deepEqual([lines[0]?.['by'], lines[0]?.['kind'], lines[0]?.['km']], [anna.id, 'gap', 30]);
    assert.ok(!JSON.stringify(t.logs).includes('SECRET-NOTE'), 'no log line carries the note');
  } finally {
    await t.close();
  }
});

test('a failure while deriving the chain never turns a saved fill-up into a 500; only GET /api/odometer fails', async () => {
  const { t, anna } = await chainHousehold();
  try {
    t.db.exec('DROP TABLE odometer_explained'); // the loader now throws
    const res = await anna.post('/api/fuel', { at: at(t.clock, -2), millilitres: 40_000, totalCents: 6000, odometer: 2200 });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.fuel.unaccountedKm, 0, 'no gaps are claimed when they cannot be derived');
    assert.equal((await anna.get('/api/fuel')).status, 200);
    assert.ok(t.logs.some((l) => l['event'] === 'odometer.chain_failed' && typeof l['message'] === 'string'), 'the failure is logged');
    assert.equal((await anna.get('/api/odometer')).status, 500);
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel')?.n, 2, 'the fill-up is saved');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------ C. the fill-up odometer

/** Ben drove 100 km and nothing else is registered. Ids: admin 1, Anna 2, Ben 3, Carla 4. */
async function fuelHousehold() {
  const h = await createHousehold();
  insertUsage(h.t, { userId: h.ben.id, start: at(h.t.clock, -30), end: at(h.t.clock, -29), odometerStart: 0, odometerEnd: 100 });
  return h;
}
const fill = (t: { clock: Parameters<typeof at>[0] }, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  at: at(t.clock, -20),
  millilitres: 40_000,
  totalCents: 6000,
  odometer: FUEL_ODO,
  ...over,
});
const without = (o: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

test('a new fill-up needs an odometer reading from 0 to 10,000,000 km, also when an admin records it for somebody else', async () => {
  const { t, admin, anna, ben } = await fuelHousehold();
  try {
    const missing = await anna.post('/api/fuel', without(fill(t), 'odometer'));
    assert.deepEqual([missing.status, missing.body.error.fields.odometer], [422, 'required']);
    for (const [value, code] of [[-1, 'too_small'], [10_000_001, 'too_large'], [1.5, 'must_be_integer'], ['5', 'must_be_integer'], [null, 'must_be_integer']] as const) {
      const res = await anna.post('/api/fuel', fill(t, { odometer: value }));
      assert.deepEqual([res.status, res.body.error.fields.odometer], [422, code], JSON.stringify(value));
    }
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel')?.n, 0, 'nothing was saved');
    for (const km of [0, 10_000_000]) {
      const created = await anna.post('/api/fuel', fill(t, { odometer: km }));
      assert.equal(created.status, 201, `${km} is a valid reading`);
      assert.equal(created.body.fuel.odometer, km, 'the reading is in the fill-up');
    }
    const forBen = await admin.post('/api/fuel', { ...without(fill(t, { at: at(t.clock, -5) }), 'odometer'), userId: ben.id });
    assert.deepEqual([forBen.status, forBen.body.error.fields.odometer], [422, 'required']);
    assert.equal((await admin.post('/api/fuel', { ...fill(t, { at: at(t.clock, -5) }), userId: ben.id })).status, 201);
    assert.equal(one<{ odometer: number }>(t.db, 'SELECT odometer FROM fuel WHERE user_id = ? AND at_utc = ?', ben.id, at(t.clock, -5))?.odometer, FUEL_ODO);
  } finally {
    await t.close();
  }
});

test('the odometer of a fill-up can be set or changed by the fueler or an admin, but not cleared; a legacy fill-up without one stays as it is until it is set', async () => {
  const { t, admin, anna, ben } = await fuelHousehold();
  try {
    const legacy = insertFuel(t, { userId: anna.id, at: at(t.clock, -20) });
    const url = `/api/fuel/${legacy}`;
    assert.equal((await anna.get('/api/fuel')).body.items[0].odometer, null, 'a legacy fill-up has no reading');
    assert.equal((await anna.patch(url, { note: 'still no reading' })).body.fuel.odometer, null, 'an edit that does not mention it leaves a legacy null alone');
    assert.equal((await anna.patch(url, { odometer: 500 })).body.fuel.odometer, 500, 'it can be set');
    assert.equal((await anna.patch(url, { note: 'kept' })).body.fuel.odometer, 500, 'and is kept when absent');
    assert.equal((await anna.patch(url, { odometer: 510, note: 'changed with other fields' })).body.fuel.odometer, 510);
    for (const [value, code] of [[null, 'must_be_integer'], [-5, 'too_small'], [10_000_001, 'too_large'], ['9', 'must_be_integer']] as const) {
      const res = await anna.patch(url, { odometer: value });
      assert.deepEqual([res.status, res.body.error.fields.odometer], [422, code], JSON.stringify(value));
    }
    assert.equal(one<{ odometer: number }>(t.db, 'SELECT odometer FROM fuel WHERE id = ?', legacy)?.odometer, 510, 'nothing was cleared');
    assert.equal((await ben.patch(url, { odometer: 1 })).status, 403, 'somebody else may not, not even for the reading alone');
    assert.equal((await admin.patch(url, { odometer: 520 })).body.fuel.odometer, 520, 'an admin may');
  } finally {
    await t.close();
  }
});

test('correcting only the odometer works on a fill-up that is locked by a paid request or a later payment; any other change still 409s', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 0, odometerEnd: 100 });
    const first = (await anna.post('/api/fuel', fill(t, { at: at(t.clock, -20), totalCents: 6000 }))).body.fuel;
    insertUsage(t, { userId: ben.id, start: at(t.clock, -15), end: at(t.clock, -14), odometerStart: 100, odometerEnd: 150 });
    const second = (await anna.post('/api/fuel', fill(t, { at: at(t.clock, -10), totalCents: 3000, millilitres: 20_000 }))).body.fuel;
    await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id });
    assert.equal((await ben.post(`/api/fuel/${second.id}/requests/${ben.id}/paid`, { paid: true })).status, 200);

    const items = (await anna.get('/api/fuel')).body.items;
    const lockedSecond = items.find((f: Json) => f.id === second.id);
    const lockedFirst = items.find((f: Json) => f.id === first.id);
    assert.equal(lockedSecond.hasPaidRequests, true);
    assert.equal(lockedFirst.settledByLater, true);
    let reading = 31_000;
    for (const f of [lockedSecond, lockedFirst]) {
      assert.deepEqual({ ...f.can }, { edit: false, delete: false }, 'locked for everything else');
      assert.equal(f.canOdometer, true, 'but the reading can still be corrected by the fueler');
      reading += 1;
      assert.equal((await anna.patch(`/api/fuel/${f.id}`, { odometer: reading })).status, 200, 'odometer only');
      assert.equal((await anna.get('/api/fuel')).body.items.find((x: Json) => x.id === f.id).odometer, reading);
      for (const body of [{ note: 'x' }, { odometer: 31_500, note: 'x' }, { odometer: 31_500, totalCents: 1 }]) {
        const res = await anna.patch(`/api/fuel/${f.id}`, body);
        assert.deepEqual([res.status, res.body.error.code], [409, 'has_paid_requests'], JSON.stringify(body));
      }
      assert.equal((await anna.del(`/api/fuel/${f.id}`)).status, 409);
    }
    // The audit line tells the one change that skips the paid-request lock from an ordinary edit.
    const updates = t.logs.filter((l) => l['event'] === 'fuel.updated');
    assert.deepEqual(updates.map((l) => [l['by'], l['odometerOnly']]), [[anna.id, true], [anna.id, true]]);
    assert.equal((await ben.patch(`/api/fuel/${second.id}`, { odometer: 1 })).status, 403, 'the debtor is not the fueler');
    assert.equal((await ben.get('/api/fuel')).body.items.find((f: Json) => f.id === second.id).canOdometer, false);
    // Nothing about the money moved.
    const after = (await anna.get('/api/fuel')).body.items.find((f: Json) => f.id === second.id);
    assert.deepEqual(after.shares.map((s: Json) => [s.userName, s.cents, s.dueCents]), [['Ben', 3000, 9000]]);
  } finally {
    await t.close();
  }
});

/**
 * Anna fuels at -20 and -10, Ben drives, and readings are placed so that the odometer chain has a gap in each
 * period: a gap of 50 before the first fill-up and one of 100 before the second, and one after the last
 * fill-up (which belongs to no card yet).
 */
async function gapsInPeriods() {
  const h = await createHousehold();
  const { t, anna, ben } = h;
  insertUsage(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 1000, odometerEnd: 1100 });
  insertUsage(t, { userId: ben.id, start: at(t.clock, -26), end: at(t.clock, -25), odometerStart: 1150, odometerEnd: 1200 }); // gap 50, in period 1
  const first = insertFuel(t, { userId: anna.id, at: at(t.clock, -20), odometer: 1200 });
  insertUsage(t, { userId: ben.id, start: at(t.clock, -15), end: at(t.clock, -14), odometerStart: 1300, odometerEnd: 1350 }); // gap 100, in period 2
  const second = insertFuel(t, { userId: anna.id, at: at(t.clock, -10), odometer: 1350 });
  insertUsage(t, { userId: ben.id, start: at(t.clock, -5), end: at(t.clock, -4), odometerStart: 1400, odometerEnd: 1450 }); // gap 50, after the last fill-up
  return { ...h, first, second };
}
const cardKm = (body: Json): Array<[number, number]> => body.items.map((f: Json) => [f.id, f.unaccountedKm]);

test('a fuel card shows the unaccounted kilometres of the gaps that end in its period, and explained gaps are not counted', async () => {
  const { t, anna, ben, first, second } = await gapsInPeriods();
  try {
    assert.deepEqual(cardKm((await anna.get('/api/fuel')).body), [[second, 100], [first, 50]], 'each gap belongs to the period that contains its later reading; the last gap has no card yet');
    // Somebody explains the 100 km: it drops off the card, the other is untouched.
    const items = (await anna.get('/api/odometer')).body.items;
    const hundred = items.find((i: Json) => i.kind === 'gap' && i.km === 100);
    assert.equal((await explain(ben, hundred, "we borrowed an outsider's car")).status, 201);
    assert.deepEqual(cardKm((await anna.get('/api/fuel')).body), [[second, 0], [first, 50]]);
    // A single fill-up's other routes answer with the same card.
    assert.equal((await anna.patch(`/api/fuel/${first}`, { note: 'x' })).body.fuel.unaccountedKm, 50);
  } finally {
    await t.close();
  }
});

test('a mismatch is not unaccounted kilometres, and a fill-up without any gap around it shows none', async () => {
  const { t, anna } = await createHousehold();
  try {
    insertUsage(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 1000, odometerEnd: 1100 });
    const lower = insertFuel(t, { userId: anna.id, at: at(t.clock, -20), odometer: 1050 });
    const body = (await anna.get('/api/odometer')).body;
    assert.deepEqual(body.items.map((i: Json) => [i.kind, i.km]), [['mismatch', 50]]);
    assert.deepEqual(cardKm((await anna.get('/api/fuel')).body), [[lower, 0]]);
  } finally {
    await t.close();
  }
});

test('a legacy fill-up (no reading) still gets the note for gaps between drive readings; a household without readings has none', async () => {
  const { t, anna } = await createHousehold();
  try {
    insertUsage(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 1000, odometerEnd: 1100 });
    insertUsage(t, { userId: anna.id, start: at(t.clock, -26), end: at(t.clock, -25), odometerStart: 1500, odometerEnd: 1600 }); // a gap of 400 km
    const legacy = insertFuel(t, { userId: anna.id, at: at(t.clock, -20) });
    const card = (await anna.get('/api/fuel')).body.items.find((f: Json) => f.id === legacy);
    assert.deepEqual([card.odometer, card.unaccountedKm], [null, 400]);
  } finally {
    await t.close();
  }
  const none = await createHousehold();
  try {
    const quiet = insertFuel(none.t, { userId: none.anna.id, at: at(none.t.clock, -20) });
    assert.deepEqual(cardKm((await none.anna.get('/api/fuel')).body), [[quiet, 0]]);
  } finally {
    await none.t.close();
  }
});

/** The same household twice, once with odometer readings on the fill-ups (that create a gap and a mismatch) and once without; what it returns is what money looks like. */
async function moneyScenario(withOdometer: boolean): Promise<Json> {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 0, odometerEnd: 100 });
    insertUsage(t, { userId: carla.id, start: at(t.clock, -28), end: at(t.clock, -27), odometerStart: 100, odometerEnd: 140 });
    const first = insertFuel(t, { userId: anna.id, at: at(t.clock, -20), totalCents: 6000, odometer: withOdometer ? 900 : null });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -15), end: at(t.clock, -14), odometerStart: 140, odometerEnd: 190 });
    const second = insertFuel(t, { userId: anna.id, at: at(t.clock, -10), totalCents: 3000, millilitres: 20_000, odometer: withOdometer ? 150 : null });
    assert.equal((await anna.post(`/api/fuel/${second}/requests`, { debtorId: ben.id })).status, 201);
    assert.equal((await ben.post(`/api/fuel/${second}/requests/${ben.id}/paid`, { paid: true })).status, 200);
    assert.equal((await anna.post(`/api/fuel/${first}/requests`, { debtorId: carla.id })).status, 201);
    const body = (await anna.get('/api/fuel')).body;
    const strip = (f: Json): Json => ({ ...f, odometer: undefined, unaccountedKm: undefined, canOdometer: undefined });
    return { items: body.items.map(strip), balances: body.balances, unaccounted: body.items.map((f: Json) => f.unaccountedKm) };
  } finally {
    await t.close();
  }
}

test('shares, requests, carry-over and balances are identical with and without odometer readings; only the note differs', async () => {
  const plain = await moneyScenario(false);
  const odo = await moneyScenario(true);
  assert.deepEqual(odo.items, plain.items, 'every share, request, carried amount and lock is the same');
  assert.deepEqual(odo.balances, plain.balances);
  assert.deepEqual(plain.unaccounted, [0, 0]);
  assert.notDeepEqual(odo.unaccounted, [0, 0], 'the readings do show up in the note: this scenario has gaps');
  assert.ok(plain.items[0].shares.length > 0, 'the scenario really has shares');
});

test('a draft takes part in the chain with its start reading but its kilometres are never counted', async () => {
  const { t, anna, ben } = await fuelHousehold();
  try {
    insertFuel(t, { userId: anna.id, at: at(t.clock, -20), odometer: 100 });
    const withoutUnaccounted = (body: Json): Json[] => body.items.map((f: Json) => ({ ...f, unaccountedKm: undefined }));
    const before = {
      summary: (await anna.get('/api/usage/summary')).body,
      fuel: withoutUnaccounted((await anna.get('/api/fuel')).body),
      list: (await anna.get('/api/usage')).body.items.map((u: Json) => u.distanceKm),
    };
    insertDraft(t, { userId: ben.id, start: at(t.clock, -5), odometerStart: 700 });
    const after = (await anna.get('/api/odometer')).body;
    const draft = after.readings.find((r: Json) => r.source === 'draft-start');
    assert.deepEqual([draft.km, draft.draft, draft.userName], [700, true, 'Ben'], 'the start reading of the drive in progress is in the chain');
    assert.deepEqual(after.items.map((i: Json) => [i.kind, i.km, i.next.source]), [['gap', 600, 'draft-start']]);
    assert.equal(after.latest.source, 'draft-start');
    // Nothing that counts kilometres changed: not the summary, not the split, not the distances.
    assert.deepEqual((await anna.get('/api/usage/summary')).body, before.summary);
    assert.deepEqual(withoutUnaccounted((await anna.get('/api/fuel')).body), before.fuel);
    const list = (await anna.get('/api/usage')).body.items;
    assert.deepEqual(list.filter((u: Json) => u.status === 'completed').map((u: Json) => u.distanceKm), before.list);
    assert.equal(list.find((u: Json) => u.status === 'draft').distanceKm, null);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------- first deploy with existing data

test('first deploy: a realistic v4 database with gaps upgrades untouched, nothing is dismissed, and everybody sees the same open items', async (tctx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-first-deploy-'));
  // One hook, in this order: the server and the database first, then the folder (Windows will not delete an open file).
  const open: { app?: ReturnType<typeof createApp>; db?: ReturnType<typeof openDb> } = {};
  tctx.after(async () => {
    await open.app?.close();
    open.db?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const config = loadConfig({ DATA_DIR: dir, SCRYPT_N: '1024', SCRYPT_R: '8', SCRYPT_P: '1' });
  const clock = makeClock();
  const file = path.join(dir, 'car.db');
  const hash = await hashPassword(PASSWORD, config.scrypt);

  // What a household has after months on the release before the kilometre check: drives with and without
  // readings, a few stretches that do not add up, fill-ups that never had a reading, a paid request.
  const old = openDb(file, MIGRATIONS.slice(0, 4));
  const now = clock.now().toISOString();
  const user = (name: string, role: string): number =>
    run(old, 'INSERT INTO users (username, display_name, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', name, name, hash, role, now, now).lastInsertRowid;
  const boss = user('boss', 'admin');
  const anna = user('anna', 'member');
  const ben = user('ben', 'member');
  const drive = (who: number, from: number, to: number, startKm: number | null, endKm: number | null): number =>
    run(
      old,
      'INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      who,
      at(clock, from),
      at(clock, to),
      startKm,
      endKm,
      who,
      now,
      now,
    ).lastInsertRowid;
  drive(anna, -100, -99, 1000, 1100);
  drive(ben, -90, -89, 1180, 1230); // 80 km after the one before it: a gap
  drive(anna, -80, -79, 1230, 1300);
  drive(ben, -70, -69, 1290, 1350); // starts 10 km below where the last one ended: a mismatch
  drive(anna, -60, -59, null, null); // from the very first release: no readings at all
  drive(ben, -50, -49, 1350, null); // only a start reading
  drive(anna, -40, -39, 1400, 1450); // 50 km after that start reading: a gap (the one-reading limit)
  const fuelRow = (who: number, hours: number): number =>
    run(old, 'INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, created_by, created_at, updated_at) VALUES (?, ?, 40000, 6000, ?, ?, ?)', who, at(clock, hours), who, now, now).lastInsertRowid;
  const first = fuelRow(anna, -85);
  fuelRow(ben, -30);
  run(old, "INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, covers_fuel_id, paid_at, created_at, updated_at) VALUES (?, ?, 1500, 'manual', 'pay up', ?, ?, ?, ?)", first, ben, first, now, now, now);
  run(old, 'INSERT INTO tickets (at_utc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)', at(clock, -75), anna, now, now);
  const before = {
    users: many(old, 'SELECT * FROM users ORDER BY id'),
    usage: many(old, 'SELECT * FROM usage ORDER BY id'),
    fuel: many(old, 'SELECT * FROM fuel ORDER BY id'),
    requests: many(old, 'SELECT * FROM fuel_requests ORDER BY id'),
    tickets: many(old, 'SELECT * FROM tickets ORDER BY id'),
  };
  old.close();

  // The first start of the new version on that file.
  const db = openDb(file);
  open.db = db;
  const app = createApp({ db, clock, config, log: () => undefined });
  open.app = app;
  const { port } = await app.listen(0, '127.0.0.1');

  // Every row is as it was; the only change is the empty new column; nothing is explained; one copy of the old file exists.
  const withoutOdometer = (rows: Json[]): Json[] => rows.map(({ odometer, ...rest }) => (odometer === null ? rest : { ...rest, odometer }));
  assert.deepEqual(many(db, 'SELECT * FROM users ORDER BY id'), before.users);
  assert.deepEqual(many(db, 'SELECT * FROM usage ORDER BY id'), before.usage);
  assert.deepEqual(withoutOdometer(many(db, 'SELECT * FROM fuel ORDER BY id')), before.fuel);
  assert.deepEqual(many(db, 'SELECT odometer FROM fuel'), [{ odometer: null }, { odometer: null }], 'old fill-ups have no reading: nothing is back-filled');
  assert.deepEqual(many(db, 'SELECT * FROM fuel_requests ORDER BY id'), before.requests);
  assert.deepEqual(many(db, 'SELECT * FROM tickets ORDER BY id'), before.tickets);
  assert.deepEqual(many(db, 'SELECT id FROM odometer_explained'), [], 'nothing is dismissed automatically');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('pre-migrate')), ['pre-migrate-v4.db']);

  // Everybody sees the same open items; they are what the household has to clear. (Item count for the build write-up.)
  const signedIn = async (name: string): Promise<Client> => {
    const c = new HttpClient(port);
    const res = await c.login(name);
    assert.equal(res.status, 200, `${name} signs in: the rows and hashes survived the upgrade`);
    return c;
  };
  const admin = await signedIn('boss');
  const member = await signedIn('anna');
  const outsider = await signedIn('ben');
  const lists = [];
  for (const who of [admin, member, outsider]) lists.push((await who.get('/api/odometer')).body);
  const plain = (body: Json): Json[] => body.items.map((i: Json) => ({ ...i, can: undefined }));
  assert.deepEqual(plain(lists[1]), plain(lists[0]));
  assert.deepEqual(plain(lists[2]), plain(lists[0]));
  const items = lists[0].items as Json[];
  tctx.diagnostic(`first-deploy rehearsal: ${items.length} open items on a v4 file with 7 drives and 2 fill-ups: ${items.map((i) => `${i.kind} ${i.km} km`).join(', ')}`);
  assert.deepEqual(
    items.map((i) => [i.kind, i.km, i.prev.source, i.next.source]),
    [
      ['gap', 50, 'drive-start', 'drive-start'],
      ['mismatch', 10, 'drive-end', 'drive-start'],
      ['gap', 80, 'drive-end', 'drive-start'],
    ],
    'the three stretches that do not add up, newest first; the drive without readings and the equal neighbours are not findings',
  );
  assert.ok(items.every((i) => i.explained === null), 'all open');
  assert.deepEqual(lists[0].items.map((i: Json) => i.can.explain), [true, true, true], 'an admin may explain any of them');
  assert.deepEqual(lists[1].items.map((i: Json) => i.can.explain), [true, true, true], 'Anna drove at one end of each');
  assert.equal(lists[0].items.length, 3);

  // The fuel split is exactly what it was: shares, requests and balances come out the same with and without the readings.
  const fuelBody = (await admin.get('/api/fuel')).body;
  assert.deepEqual(fuelBody.items.map((f: Json) => f.odometer), [null, null]);
  const actor = { id: boss, role: 'admin' } as Parameters<typeof fuelOverview>[1];
  const plainOverview = fuelOverview(db, actor);
  assert.deepEqual(fuelBody.items.map((f: Json) => f.shares), plainOverview.items.map((f) => f.shares));
  assert.deepEqual(fuelBody.balances, plainOverview.balances);
  // The gaps only show as a note on the cards of the period they end in.
  assert.ok(fuelBody.items.some((f: Json) => f.unaccountedKm > 0), 'older fuel cards carry the note');
  assert.deepEqual(plainOverview.items.map((f) => f.unaccountedKm), [0, 0], 'and it is display only: without it the same numbers come out');
});

// ---------------------------------------------------------------- the guide says so

test('the deployment guide and the README describe the v5 upgrade, going back, and what happens to existing gaps', () => {
  const guide = fs.readFileSync(new URL('../docs/DEPLOYMENT.md', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const needle of ['pre-migrate-v4.db', 'First deploy with existing data', 'Nothing is rewritten, back-filled or dismissed', 'car-static-v5', 'Going back', 'refuses to open a v5 database']) {
    assert.ok(guide.replace(/\s+/g, ' ').includes(needle) || guide.includes(needle), `the guide mentions "${needle}"`);
  }
  assert.ok(guide.includes('Kilometre check'), 'the guide has the subsection');
  assert.match(guide, /pre-migrate-v4\.db[\s\S]*Kilometre check|Kilometre check[\s\S]*pre-migrate-v4\.db/);
  assert.ok(readme.includes('schema v5'), 'the README layout names schema v5');
  assert.ok(readme.includes('**Kilometre check.**'), 'the README lists the feature');
  assert.ok(readme.includes('GAP_TOLERANCE_KM'), 'the README says where the tolerance lives');
});
