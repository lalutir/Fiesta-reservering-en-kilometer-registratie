import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OdometerItem } from '../public/api.js';
import { gapDefaults } from '../public/kmcheck.js';
import { at, createHousehold, insertFuel, insertReservation, insertUsage, type Client, type Json } from './helpers.ts';

// The odometer check across the whole stack: real routes, real database, and the one client helper whose
// output goes straight into a server request. The pure derivation is in odometer.test.ts, the individual
// routes in odometer-api.test.ts and the screens in odometer-view.test.ts; what is here is what only shows
// when the pieces run together: that nothing the chain finds ever blocks a save, that "Add the missing
// drive" produces a request the server accepts and that closes the gap, and that the fuel cards and the
// fill-ups inside a trip follow the exact rules at the exact instants.

const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const asItem = (i: Json): OdometerItem => i as unknown as OdometerItem;
const kinds = (body: Json): Array<[string, number]> => body.items.map((i: Json) => [i.kind, i.km]);
const cardKm = (body: Json): Array<[number, number]> => body.items.map((f: Json) => [f.id, f.unaccountedKm]);

// ------------------------------------------------------------ saving is never blocked

test('a reading that does not fit never blocks a save: drives, edits, drafts and fill-ups all save, and the finding shows up afterwards', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 1000, odometerEnd: 1100 });

    // A start reading below the last known one (a mismatch) and one far above it (a gap): both are saved as typed.
    const lower = await anna.post('/api/usage', { start: at(t.clock, -20), end: at(t.clock, -19), odometerStart: 900, odometerEnd: 950 });
    assert.equal(lower.status, 201, lower.text);
    const higher = await anna.post('/api/usage', { start: at(t.clock, -15), end: at(t.clock, -14), odometerStart: 2000, odometerEnd: 2050 });
    assert.equal(higher.status, 201, higher.text);
    assert.deepEqual([lower.body.usage.odometerStart, higher.body.usage.odometerStart], [900, 2000], 'stored as typed');

    // Editing a finished drive into a worse fit is allowed too.
    const edited = await anna.patch(`/api/usage/${lower.body.usage.id}`, { odometerStart: 940, odometerEnd: 960 });
    assert.equal(edited.status, 200, edited.text);

    // Fill-ups: a reading far below and one far above the last known reading.
    const low = await anna.post('/api/fuel', { at: at(t.clock, -10), millilitres: 40_000, totalCents: 6000, odometer: 100 });
    assert.equal(low.status, 201, low.text);
    const high = await anna.post('/api/fuel', { at: at(t.clock, -9), millilitres: 40_000, totalCents: 6000, odometer: 9_000_000 });
    assert.equal(high.status, 201, high.text);
    assert.equal(high.body.fuel.unaccountedKm, 9_000_000 - 100, 'the card of the new fill-up already tells about the gap it ends');
    assert.equal((await anna.patch(`/api/fuel/${low.body.fuel.id}`, { odometer: 5 })).status, 200, 'a fill-up reading can be corrected into a worse fit');

    // A draft whose start reading is nowhere near the last one.
    const started = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -5), odometerStart: 3 });
    assert.equal(started.status, 201, started.text);

    const body = (await anna.get('/api/odometer')).body;
    assert.ok(body.items.some((i: Json) => i.kind === 'gap'), 'a gap was found');
    assert.ok(body.items.some((i: Json) => i.kind === 'mismatch'), 'a mismatch was found');
    // Ben's drive (2 readings), Anna's two drives (4), two fill-ups (2) and the draft's start (1).
    assert.equal(body.readings.length, 9, 'every reading took part');
    assert.equal(body.latest.source, 'draft-start');
    assert.equal(body.latest.km, 3);
  } finally {
    await t.close();
  }
});

test('findings and explanations never change what counts as kilometres still to register', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    // Anna has a reservation that ended without a registered drive: that is her one item to register.
    insertReservation(t, { userId: anna.id, start: at(t.clock, -48), end: at(t.clock, -47) });
    const pending = async (): Promise<Json> => (await anna.get('/api/usage/pending')).body;
    const before = await pending();
    assert.equal(before.count, 1, 'one reservation is waiting for kilometres');

    // Other people's drives (not overlapping her reservation) leave a gap of 30 km between them.
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 1000, odometerEnd: 1100 });
    insertUsage(t, { userId: carla.id, start: at(t.clock, -20), end: at(t.clock, -19), odometerStart: 1130, odometerEnd: 1180 });
    const gap = (await anna.get('/api/odometer')).body.items.find((i: Json) => i.kind === 'gap');
    assert.equal(gap.km, 30);
    assert.deepEqual(await pending(), before, 'an open gap is not something to register');

    assert.equal((await ben.post('/api/odometer/explain', { key: gap.key, note: 'borrowed car' })).status, 201);
    assert.deepEqual(await pending(), before, 'an explained gap does not change it either');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------ Add the missing drive

test("'Add the missing drive' with the times the client derives from a real finding is accepted by the server, closes the gap, and cannot be saved twice", async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    // Anna's drive ends 17 seconds past the minute, Ben's starts 41 seconds past it: 30 km between them.
    insertUsage(t, { userId: anna.id, start: at(t.clock, -10), end: plus(at(t.clock, -9), 17_345), odometerStart: 1000, odometerEnd: 1100 });
    insertUsage(t, { userId: ben.id, start: plus(at(t.clock, -8), 41_020), end: at(t.clock, -7), odometerStart: 1130, odometerEnd: 1180 });
    // Carla pumped 50 km after Ben stopped, 30 seconds past a minute: the gap ends in the fill-up.
    insertFuel(t, { userId: carla.id, at: plus(at(t.clock, -5), 30_000), odometer: 1230 });

    const items = (await anna.get('/api/odometer')).body.items as Json[];
    assert.deepEqual(items.map((i) => [i.kind, i.km, i.prev.source, i.next.source]).sort(), [['gap', 30, 'drive-end', 'drive-start'], ['gap', 50, 'drive-end', 'fuel']].sort());

    const saved: Json[] = [];
    for (const [who, km] of [[anna, 30], [carla, 50]] as Array<[Client, number]>) {
      const item = ((await who.get('/api/odometer')).body.items as Json[]).find((i) => i.kind === 'gap' && i.km === km) as Json;
      const d = gapDefaults(asItem(item));
      assert.ok(d.start !== null && d.end !== null, `the ${km} km gap has room for a drive`);
      assert.ok(d.start >= item.prev.at && d.end <= item.next.at, 'the times lie between the two neighbours, never over them');
      assert.equal(new Date(d.start).getUTCSeconds() + new Date(d.end).getUTCSeconds(), 0, 'whole minutes');
      assert.deepEqual([d.odometerStart, d.odometerEnd], [item.prev.km, item.next.km]);
      const res = await who.post('/api/usage', { start: d.start, end: d.end, odometerStart: d.odometerStart, odometerEnd: d.odometerEnd });
      assert.equal(res.status, 201, `the ${km} km drive: ${res.text}`);
      saved.push({ ...d, id: res.body.usage.id, who });
      const left = (await who.get('/api/odometer')).body.items as Json[];
      assert.ok(!left.some((i) => i.kind === 'gap' && i.km === km), `the ${km} km gap is closed`);
    }
    const after = (await anna.get('/api/odometer')).body;
    assert.deepEqual(after.items, [], 'both gaps are closed and nothing new is flagged: the drives fit exactly');
    assert.deepEqual(
      after.readings.map((r: Json) => [r.source, r.km]),
      [['drive-start', 1000], ['drive-end', 1100], ['drive-start', 1100], ['drive-end', 1130], ['drive-start', 1130], ['drive-end', 1180], ['drive-start', 1180], ['drive-end', 1230], ['fuel', 1230]],
    );

    // The normal overlap rule is unchanged: the same times again are refused.
    const first = saved[0] as Json;
    const again = await (first['who'] as Client).post('/api/usage', { start: first['start'], end: first['end'], odometerStart: first['odometerStart'], odometerEnd: first['odometerEnd'] });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'overlap');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------ fuel cards, at the exact instants

test('a gap belongs to the fuel card whose period holds its later reading, also at the exact instants: the period is (previous fill-up, this fill-up]', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    // Before the first fill-up: the oldest card has no lower bound, so this 50 km gap is on it.
    insertUsage(t, { userId: anna.id, start: at(t.clock, -45), end: at(t.clock, -44), odometerStart: 800, odometerEnd: 900 });
    insertUsage(t, { userId: anna.id, start: at(t.clock, -40), end: at(t.clock, -39), odometerStart: 950, odometerEnd: 1100 });
    // The gap that ends IN the fill-up: its later reading is at the fill-up's own instant, so it is on that card.
    const a = insertFuel(t, { userId: carla.id, at: at(t.clock, -20), odometer: 1150 });
    // A drive starting at the very instant of that fill-up, 50 km further on: a gap whose later reading is at
    // fill-up A's instant. It belongs to A (period end is inclusive), and not to the next card (start exclusive).
    insertUsage(t, { userId: ben.id, start: at(t.clock, -20), end: at(t.clock, -19), odometerStart: 1200, odometerEnd: 1250 });
    const b = insertFuel(t, { userId: carla.id, at: at(t.clock, -10), odometer: 1250 }); // fits: nothing before it
    // A gap after the last fill-up: no card shows it yet.
    insertUsage(t, { userId: ben.id, start: at(t.clock, -5), end: at(t.clock, -4), odometerStart: 1300, odometerEnd: 1320 });

    const odo = (await anna.get('/api/odometer')).body;
    assert.deepEqual(kinds(odo), [['gap', 50], ['gap', 50], ['gap', 50], ['gap', 50]], 'four gaps of 50 km in all');
    assert.deepEqual(cardKm((await anna.get('/api/fuel')).body), [[b, 0], [a, 150]], 'three gaps on the oldest card (two of them at its instant), none on the next, and the last one on no card yet');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------ a fill-up during a trip

test('a fill-up during a trip that reads outside the drive is a mismatch against that drive only: listed, explainable by the people at both ends, and not a link in the chain', async () => {
  const { t, admin, anna, ben, carla } = await createHousehold();
  try {
    insertUsage(t, { userId: anna.id, start: at(t.clock, -10), end: at(t.clock, -8), odometerStart: 1000, odometerEnd: 1100 });
    const above = insertFuel(t, { userId: carla.id, at: at(t.clock, -9), odometer: 1150 }); // 50 over the end reading
    insertFuel(t, { userId: ben.id, at: at(t.clock, -8.5), odometer: 900 }); // 100 under the start reading
    insertFuel(t, { userId: ben.id, at: at(t.clock, -9.5), odometer: 1050 }); // fits the trip: nothing

    const body = (await anna.get('/api/odometer')).body;
    assert.deepEqual(body.readings.map((r: Json) => [r.source, r.km]), [['drive-start', 1000], ['drive-end', 1100]], 'pump stops during the trip are not in the chain');
    assert.equal(body.latest.source, 'drive-end');
    assert.deepEqual(
      body.items.map((i: Json) => [i.kind, i.km, i.prev.source, i.next.source]),
      [['mismatch', 50, 'fuel', 'drive-end'], ['mismatch', 100, 'drive-start', 'fuel']],
      'newest first',
    );
    assert.deepEqual(cardKm((await anna.get('/api/fuel')).body).map(([, km]) => km), [0, 0, 0], 'a mismatch is not unaccounted kilometres');

    const mayExplain = async (who: Client): Promise<boolean[]> => ((await who.get('/api/odometer')).body.items as Json[]).map((i) => i.can.explain);
    assert.deepEqual(await mayExplain(anna), [true, true], 'the driver is at one end of both');
    assert.deepEqual(await mayExplain(carla), [true, false], 'the fueler of the 1150 reading');
    assert.deepEqual(await mayExplain(ben), [false, true], 'the fueler of the 900 reading');
    assert.deepEqual(await mayExplain(admin), [true, true]);

    const [over, under] = body.items as Json[];
    assert.equal((await ben.post('/api/odometer/explain', { key: (over as Json).key, note: 'not mine' })).status, 403);
    assert.equal((await carla.post('/api/odometer/explain', { key: (under as Json).key, note: 'not mine' })).status, 403);
    assert.equal((await carla.post('/api/odometer/explain', { key: (over as Json).key, note: 'the pump display was off' })).status, 201);
    assert.equal((await ben.post('/api/odometer/explain', { key: (under as Json).key, note: 'wrote the wrong digits' })).status, 201);

    // Correcting the reading into the trip's own range removes the finding; putting it back brings the note back.
    assert.equal((await carla.patch(`/api/fuel/${above}`, { odometer: 1050 })).status, 200);
    assert.deepEqual(kinds((await anna.get('/api/odometer')).body), [['mismatch', 100]], 'only the other one is left');
    assert.equal((await carla.patch(`/api/fuel/${above}`, { odometer: 1150 })).status, 200);
    const back = (await anna.get('/api/odometer')).body.items as Json[];
    assert.deepEqual(back.map((i) => [i.km, i.explained?.note]), [[50, 'the pump display was off'], [100, 'wrote the wrong digits']]);
  } finally {
    await t.close();
  }
});
