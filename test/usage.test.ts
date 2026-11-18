import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db.ts';
import { ODO, at, createHousehold, insertReservation, insertUsage } from './helpers.ts';

const MIN = 60_000;

test('a user logs their own drive; both odometer readings are required', async () => {
  const { t, anna } = await createHousehold();
  try {
    const res = await anna.post('/api/usage', {
      start: at(t.clock, -5),
      end: at(t.clock, -3),
      odometerStart: 45_000,
      odometerEnd: 45_120,
      note: 'Visit to the in-laws',
    });
    assert.equal(res.status, 201);
    const u = res.body.usage;
    assert.equal(u.userId, anna.id);
    assert.equal(u.userName, 'Anna');
    assert.equal(u.createdBy, anna.id);
    assert.equal(u.distanceKm, 120);
    assert.equal(u.reservationId, null);
    assert.deepEqual(u.can, { edit: true, delete: true });

    const bare = await anna.post('/api/usage', { start: at(t.clock, -2), end: at(t.clock, -1) });
    assert.equal(bare.status, 422);
    assert.deepEqual({ ...bare.body.error.fields }, { odometerStart: 'required', odometerEnd: 'required' });

    const oneSide = await anna.post('/api/usage', { start: at(t.clock, -8), end: at(t.clock, -7), odometerEnd: 45_200 });
    assert.equal(oneSide.status, 422, 'a drive with one reading is not a registered drive');
    assert.deepEqual({ ...oneSide.body.error.fields }, { odometerStart: 'required' });
  } finally {
    await t.close();
  }
});

test('usage times: end must not be before start, may equal it, and cannot lie in the future', async () => {
  const { t, anna } = await createHousehold();
  try {
    const backwards = await anna.post('/api/usage', { start: at(t.clock, -1), end: at(t.clock, -2), ...ODO });
    assert.equal(backwards.status, 422);
    assert.equal(backwards.body.error.fields.end, 'must_not_be_before_start');
    assert.equal((await anna.post('/api/usage', { start: at(t.clock, -4), end: at(t.clock, -4), ...ODO })).status, 201, 'end >= start');

    assert.equal((await anna.post('/api/usage', { start: at(t.clock, -1), end: new Date(t.clock.now().getTime() + 5 * MIN).toISOString(), ...ODO })).status, 201, 'five minutes of slack');
    const future = await anna.post('/api/usage', { start: at(t.clock, 1), end: at(t.clock, 2), ...ODO });
    assert.equal(future.status, 422);
    assert.equal(future.body.error.fields.end, 'in_future');
    const slightly = await anna.post('/api/usage', { start: at(t.clock, -9), end: new Date(t.clock.now().getTime() + 5 * MIN + 1).toISOString(), ...ODO });
    assert.equal(slightly.status, 422);
    assert.equal(slightly.body.error.fields.end, 'in_future');

    const missing = await anna.post('/api/usage', {});
    assert.equal(missing.status, 422);
    assert.deepEqual({ ...missing.body.error.fields }, { start: 'required', end: 'required', odometerStart: 'required', odometerEnd: 'required' });
  } finally {
    await t.close();
  }
});

test('odometer readings are non-negative integers and the end cannot be below the start', async () => {
  const { t, anna } = await createHousehold();
  try {
    const base = { start: at(t.clock, -3), end: at(t.clock, -2) };
    const below = await anna.post('/api/usage', { ...base, odometerStart: 500, odometerEnd: 499 });
    assert.equal(below.status, 422);
    assert.equal(below.body.error.fields.odometerEnd, 'must_not_be_below_start');
    for (const [value, code] of [[-1, 'too_small'], [10.5, 'must_be_integer'], ['100', 'must_be_integer'], [99_999_999, 'too_large']] as const) {
      const bad = await anna.post('/api/usage', { ...base, odometerStart: value, odometerEnd: 600 });
      assert.equal(bad.status, 422, String(value));
      assert.equal(bad.body.error.fields.odometerStart, code, `odometerStart ${JSON.stringify(value)}`);
    }
    const badEnd = await anna.post('/api/usage', { ...base, odometerStart: 100, odometerEnd: 10.5 });
    assert.equal(badEnd.body.error.fields.odometerEnd, 'must_be_integer');
    const equal = await anna.post('/api/usage', { ...base, odometerStart: 500, odometerEnd: 500 });
    assert.equal(equal.status, 201);
    assert.equal(equal.body.usage.distanceKm, 0);
  } finally {
    await t.close();
  }
});

test('only admins can log usage for someone else', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const times = { start: at(t.clock, -5), end: at(t.clock, -3), ...ODO };
    const denied = await anna.post('/api/usage', { ...times, userId: ben.id });
    assert.equal(denied.status, 403);
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n, 0);

    const ownExplicit = await anna.post('/api/usage', { ...times, userId: anna.id });
    assert.equal(ownExplicit.status, 201);

    const onBehalf = await admin.post('/api/usage', { start: at(t.clock, -9), end: at(t.clock, -7), ...ODO, userId: ben.id });
    assert.equal(onBehalf.status, 201);
    assert.equal(onBehalf.body.usage.userId, ben.id);
    assert.equal(onBehalf.body.usage.createdBy, admin.id);

    const ghost = await admin.post('/api/usage', { start: at(t.clock, -12), end: at(t.clock, -11), ...ODO, userId: 9999 });
    assert.equal(ghost.status, 422);
    assert.equal(ghost.body.error.fields.userId, 'unknown_user');
  } finally {
    await t.close();
  }
});

test('overlapping usage records are rejected across users; touching ones are fine', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const first = await anna.post('/api/usage', { start: at(t.clock, -6), end: at(t.clock, -4), ...ODO });
    assert.equal(first.status, 201);
    for (const [from, to] of [[-6, -4], [-5, -4.5], [-7, -5], [-5, -3], [-8, -3]] as const) {
      const res = await ben.post('/api/usage', { start: at(t.clock, from), end: at(t.clock, to), ...ODO });
      assert.equal(res.status, 409, `${from}..${to}`);
      assert.equal(res.body.error.code, 'overlap');
      assert.equal(res.body.error.conflict.userName, 'Anna');
    }
    assert.equal((await ben.post('/api/usage', { start: at(t.clock, -4), end: at(t.clock, -3), ...ODO })).status, 201, 'starts when the other ends');
    assert.equal((await ben.post('/api/usage', { start: at(t.clock, -7), end: at(t.clock, -6), ...ODO })).status, 201, 'ends when the other starts');
    // Identical zero-length duplicates are also rejected.
    assert.equal((await ben.post('/api/usage', { start: at(t.clock, -2), end: at(t.clock, -2), ...ODO })).status, 201);
    assert.equal((await anna.post('/api/usage', { start: at(t.clock, -2), end: at(t.clock, -2), ...ODO })).status, 409);
  } finally {
    await t.close();
  }
});

test('usage may link to an existing confirmed reservation only', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const confirmed = insertReservation(t, { userId: ben.id, start: at(t.clock, -6), end: at(t.clock, -2) });
    const pending = insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'pending', start: at(t.clock, 5), end: at(t.clock, 6) });
    const times = { start: at(t.clock, -5), end: at(t.clock, -3), ...ODO };
    const linked = await anna.post('/api/usage', { ...times, reservationId: confirmed });
    assert.equal(linked.status, 201);
    assert.equal(linked.body.usage.reservationId, confirmed);

    for (const [id, label] of [[9999, 'unknown'], [pending, 'pending']] as const) {
      const bad = await anna.post('/api/usage', { start: at(t.clock, -1), end: at(t.clock, -0.5), ...ODO, reservationId: id });
      assert.equal(bad.status, 422, label);
      assert.equal(bad.body.error.fields.reservationId, 'unknown_reservation', label);
    }

    // Removing the reservation keeps the usage record and drops the link.
    assert.equal((await ben.del(`/api/reservations/${confirmed}`)).status, 204);
    const after = await anna.get('/api/usage');
    assert.equal(after.body.items[0].reservationId, null);
    assert.equal(after.body.items.length, 1);
  } finally {
    await t.close();
  }
});

test('usage outside the six-month window is rejected', async () => {
  const { t, anna } = await createHousehold();
  try {
    const old = await anna.post('/api/usage', { start: '2025-11-01T08:00:00Z', end: '2025-11-01T10:00:00Z', ...ODO });
    assert.equal(old.status, 422);
    assert.equal(old.body.error.code, 'outside_window');
    assert.equal((await anna.post('/api/usage', { start: '2025-12-15T09:00:00.000Z', end: '2025-12-15T11:00:00.000Z', ...ODO })).status, 201, 'ending exactly at the edge');
  } finally {
    await t.close();
  }
});

test('owners and admins can correct or delete usage records; others cannot', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const created = await anna.post('/api/usage', { start: at(t.clock, -6), end: at(t.clock, -4), odometerStart: 100, odometerEnd: 150, note: 'a' });
    const id = created.body.usage.id;
    assert.deepEqual((await ben.get('/api/usage')).body.items[0].can, { edit: false, delete: false });

    assert.equal((await ben.patch(`/api/usage/${id}`, { note: 'hijack' })).status, 403);
    assert.equal((await ben.del(`/api/usage/${id}`)).status, 403);

    const fixed = await anna.patch(`/api/usage/${id}`, { odometerEnd: 160, note: 'b' });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.usage.distanceKm, 60);
    assert.equal(fixed.body.usage.note, 'b');
    assert.equal(fixed.body.usage.start, at(t.clock, -6), 'untouched fields stay');

    // The readings are obligatory: they can be corrected but not cleared (either one, or both).
    for (const body of [{ odometerStart: null, odometerEnd: null }, { odometerStart: null }, { odometerEnd: null }]) {
      const cleared = await anna.patch(`/api/usage/${id}`, body);
      assert.equal(cleared.status, 422, JSON.stringify(body));
      assert.equal(cleared.body.error.fields[Object.keys(body)[0] as string], 'required', JSON.stringify(body));
    }
    assert.equal((await anna.get('/api/usage')).body.items[0].distanceKm, 60, 'the stored readings are untouched');
    assert.equal((await anna.patch(`/api/usage/${id}`, { odometerStart: 200, odometerEnd: 100 })).status, 422);
    assert.equal((await anna.patch(`/api/usage/${id}`, { start: at(t.clock, -3) })).status, 422, 'start after the existing end');

    assert.equal((await anna.patch(`/api/usage/${id}`, { userId: ben.id })).status, 403, 'members cannot reassign');
    const reassigned = await admin.patch(`/api/usage/${id}`, { userId: ben.id });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.usage.userId, ben.id);
    assert.equal(reassigned.body.usage.createdBy, anna.id);
    assert.equal((await admin.patch(`/api/usage/${id}`, { userId: 9999 })).status, 422);

    const second = await ben.post('/api/usage', { start: at(t.clock, -3), end: at(t.clock, -2), ...ODO });
    assert.equal((await ben.patch(`/api/usage/${second.body.usage.id}`, { start: at(t.clock, -5) })).status, 409, 'overlap is re-checked');
    assert.equal((await ben.patch(`/api/usage/${second.body.usage.id}`, { start: at(t.clock, -4) })).status, 200, 'touching is fine');

    assert.equal((await anna.del(`/api/usage/${id}`)).status, 403, 'no longer hers after reassignment');
    assert.equal((await admin.del(`/api/usage/${id}`)).status, 204);
    assert.equal((await ben.del(`/api/usage/${second.body.usage.id}`)).status, 204);
    assert.equal((await ben.del(`/api/usage/${second.body.usage.id}`)).status, 404);
    assert.equal((await ben.patch('/api/usage/777', { note: 'x' })).status, 404);
  } finally {
    await t.close();
  }
});

test('everyone sees all usage records; the list can be filtered by driver and is newest first', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    await anna.post('/api/usage', { start: at(t.clock, -30), end: at(t.clock, -28), ...ODO });
    await ben.post('/api/usage', { start: at(t.clock, -20), end: at(t.clock, -18), ...ODO });
    await anna.post('/api/usage', { start: at(t.clock, -10), end: at(t.clock, -8), ...ODO });
    const all = await carla.get('/api/usage');
    assert.deepEqual(all.body.items.map((i: { userName: string }) => i.userName), ['Anna', 'Ben', 'Anna']);
    const justBen = await carla.get(`/api/usage?userId=${ben.id}`);
    assert.deepEqual(justBen.body.items.map((i: { userName: string }) => i.userName), ['Ben']);
    assert.equal((await carla.get('/api/usage?userId=x')).status, 422);
  } finally {
    await t.close();
  }
});

test('the summary counts trips per user and sums kilometres only where both readings exist (older rows may lack them)', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    await anna.post('/api/usage', { start: at(t.clock, -30), end: at(t.clock, -28), odometerStart: 1000, odometerEnd: 1040 });
    await anna.post('/api/usage', { start: at(t.clock, -20), end: at(t.clock, -18), odometerStart: 1040, odometerEnd: 1100 });
    // Drives saved before the readings became obligatory: the API no longer accepts them, so they are inserted directly.
    insertUsage(t, { userId: anna.id, start: at(t.clock, -10), end: at(t.clock, -8), odometerEnd: 1200 });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -6), end: at(t.clock, -4) });
    const s = (await ben.get('/api/usage/summary')).body;
    assert.deepEqual(s.items, [
      { userId: anna.id, userName: 'Anna', trips: 3, tripsWithKm: 2, km: 100 },
      { userId: ben.id, userName: 'Ben', trips: 1, tripsWithKm: 0, km: 0 },
    ]);
    assert.equal(s.totalKm, 100);
    assert.equal(s.totalTrips, 4);
    const narrowed = (await ben.get(`/api/usage/summary?from=${encodeURIComponent(at(t.clock, -25))}`)).body;
    assert.equal(narrowed.totalKm, 60);
  } finally {
    await t.close();
  }
});

test('history shows reserved versus actual driver', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    const benSlot = insertReservation(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -26) });
    const annaSlot = insertReservation(t, { userId: anna.id, start: at(t.clock, -20), end: at(t.clock, -16) });
    const unused = insertReservation(t, { userId: carla.id, start: at(t.clock, -12), end: at(t.clock, -10) });
    insertReservation(t, { userId: carla.id, createdBy: ben.id, status: 'pending', start: at(t.clock, 5), end: at(t.clock, 6) });

    // Ben reserved but Anna drove; Anna reserved and drove; one trip with no reservation.
    await anna.post('/api/usage', { start: at(t.clock, -29), end: at(t.clock, -27), ...ODO, reservationId: benSlot });
    await anna.post('/api/usage', { start: at(t.clock, -19), end: at(t.clock, -17), ...ODO, reservationId: annaSlot });
    await ben.post('/api/usage', { start: at(t.clock, -8), end: at(t.clock, -7), ...ODO });

    const h = (await carla.get('/api/history')).body;
    const byNote = h.usage.map((u: { userName: string; sameDriver: boolean | null; reservation: { userName: string } | null }) => [
      u.userName,
      u.reservation?.userName ?? null,
      u.sameDriver,
    ]);
    assert.deepEqual(byNote, [
      ['Ben', null, null],
      ['Anna', 'Anna', true],
      ['Anna', 'Ben', false],
    ]);
    assert.deepEqual(h.reservations.map((r: { id: number }) => r.id), [benSlot, annaSlot, unused], 'confirmed reservations only');
    const linked = new Set(h.usage.map((u: { reservationId: number | null }) => u.reservationId));
    assert.equal(linked.has(unused), false, 'a reservation nobody drove is visible as unused');
    assert.equal(h.usage[2].reservation.id, benSlot);
  } finally {
    await t.close();
  }
});
