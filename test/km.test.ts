// Linking a reservation to a drive, the km obligation, drafts and the pending-km list.
// The first group is the permanent regression guard for the reported problem
// "reservations cannot be tied to a registered drive" (reproduced in a browser
// before the fix: upcoming reservations could not be linked, the picker never
// offered them, and a linked drive was invisible on the reservation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db.ts';
import { ODO, at, createHousehold, insertDraft, insertReservation, insertUsage, type Json } from './helpers.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

const reservationItem = (body: Json, id: number): Json => body.items.find((r: Json) => r.id === id);

// ------------------------------------------------------------------ the link

test('a drive can be started against an upcoming or a running reservation, and both show it', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const running = insertReservation(t, { userId: anna.id, start: at(t.clock, -0.5), end: at(t.clock, 1.5) });
    const upcoming = (await anna.post('/api/reservations', { start: at(t.clock, 3), end: at(t.clock, 5) })).body.reservation;
    assert.equal(upcoming.kmState, 'missing');
    assert.equal(upcoming.drive, null);

    // The failing case before the fix: this used to be 422 (the end of a drive cannot lie in the future).
    const started = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -0.4), odometerStart: 10_000, reservationId: running });
    assert.equal(started.status, 201, started.text);
    assert.equal(started.body.usage.status, 'draft');
    assert.equal(started.body.usage.end, null);
    assert.equal(started.body.usage.reservationId, running);

    const list = (await ben.get('/api/reservations')).body;
    assert.deepEqual(
      { ...reservationItem(list, running).drive },
      {
        id: started.body.usage.id,
        userId: anna.id,
        userName: 'Anna',
        status: 'draft',
        odometerStart: 10_000,
        odometerEnd: null,
        distanceKm: null,
        linked: true,
      },
    );
    assert.equal(reservationItem(list, running).kmState, 'draft');
    assert.equal(reservationItem(list, upcoming.id).kmState, 'missing');
    assert.equal(reservationItem(list, upcoming.id).drive, null);

    // Linking to the upcoming one works too (a drive that starts early, before the reserved time).
    t.clock.advance(HOUR);
    const early = await ben.post('/api/usage', { status: 'draft', start: at(t.clock, -0.1), odometerStart: 20_000, reservationId: upcoming.id });
    assert.equal(early.status, 201, early.text);
    assert.equal((await ben.get(`/api/reservations/${upcoming.id}`)).body.reservation.drive.userName, 'Ben');
  } finally {
    await t.close();
  }
});

test('reservation lists, detail, inbox and history all carry the linked drive and its km state', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const res = insertReservation(t, { userId: anna.id, start: at(t.clock, -6), end: at(t.clock, -2) });
    const drive = await anna.post('/api/usage', { start: at(t.clock, -5), end: at(t.clock, -3), ...ODO, reservationId: res });
    assert.equal(drive.status, 201, drive.text);

    const expected = {
      id: drive.body.usage.id,
      userId: anna.id,
      userName: 'Anna',
      status: 'completed',
      odometerStart: 10_000,
      odometerEnd: 10_050,
      distanceKm: 50,
      linked: true,
    };
    const fromList = reservationItem((await ben.get('/api/reservations')).body, res);
    assert.deepEqual({ ...fromList.drive }, expected);
    assert.equal(fromList.kmState, 'registered');
    const detail = (await ben.get(`/api/reservations/${res}`)).body.reservation;
    assert.deepEqual({ ...detail.drive }, expected);
    assert.equal(detail.kmState, 'registered');
    const history = (await ben.get('/api/history')).body;
    const fromHistory = history.reservations.find((r: Json) => r.id === res);
    assert.deepEqual({ ...fromHistory.drive }, expected);
    assert.equal(fromHistory.kmState, 'registered');
    assert.equal(history.usage[0].status, 'completed');
    assert.equal(history.usage[0].reservation.id, res);
  } finally {
    await t.close();
  }
});

test('deleting the reservation keeps the drive and clears the link', async () => {
  const { t, anna } = await createHousehold();
  try {
    const res = insertReservation(t, { userId: anna.id, start: at(t.clock, -6), end: at(t.clock, -2) });
    const drive = (await anna.post('/api/usage', { start: at(t.clock, -5), end: at(t.clock, -3), ...ODO, reservationId: res })).body.usage;
    assert.equal((await anna.del(`/api/reservations/${res}`)).status, 204);
    const after = (await anna.get('/api/usage')).body.items;
    assert.equal(after.length, 1);
    assert.equal(after[0].id, drive.id);
    assert.equal(after[0].reservationId, null);
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n, 1);
  } finally {
    await t.close();
  }
});

test('when someone else drives a reservation the card names who registered it', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const annaSlot = insertReservation(t, { userId: anna.id, start: at(t.clock, -6), end: at(t.clock, -2) });
    await ben.post('/api/usage', { start: at(t.clock, -5), end: at(t.clock, -3), ...ODO, reservationId: annaSlot });
    const r = reservationItem((await anna.get('/api/reservations')).body, annaSlot);
    assert.equal(r.kmState, 'registered');
    assert.equal(r.drive.userName, 'Ben');
    assert.equal(r.drive.userId, ben.id);
    assert.equal(r.drive.linked, true);
  } finally {
    await t.close();
  }
});

test('a linked drive without readings (older data) leaves the reservation at "missing", but is still shown', async () => {
  const { t, anna } = await createHousehold();
  try {
    const res = insertReservation(t, { userId: anna.id, start: at(t.clock, -6), end: at(t.clock, -2) });
    const legacy = insertUsage(t, { userId: anna.id, start: at(t.clock, -5), end: at(t.clock, -3), reservationId: res });
    const r = reservationItem((await anna.get('/api/reservations')).body, res);
    assert.equal(r.kmState, 'missing');
    assert.equal(r.drive.id, legacy);
    assert.equal(r.drive.status, 'completed');
    assert.equal(r.drive.odometerStart, null);
    assert.equal(r.drive.distanceKm, null);
    assert.equal(r.drive.linked, true);
  } finally {
    await t.close();
  }
});

test('an unlinked completed drive that overlaps the reservation registers it; touching ends do not', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const slot = insertReservation(t, { userId: anna.id, start: at(t.clock, -6), end: at(t.clock, -2) });
    const touching = insertReservation(t, { userId: ben.id, start: at(t.clock, -9), end: at(t.clock, -7) });
    // Ends exactly where Ben's reservation ends... and starts where Anna's begins: neither overlaps the other.
    insertUsage(t, { userId: ben.id, start: at(t.clock, -7), end: at(t.clock, -6), odometerStart: 5, odometerEnd: 9 });
    const inside = insertUsage(t, { userId: anna.id, start: at(t.clock, -5), end: at(t.clock, -4), odometerStart: 10, odometerEnd: 20 });
    const list = (await anna.get('/api/reservations')).body;
    const r = reservationItem(list, slot);
    assert.equal(r.kmState, 'registered');
    assert.equal(r.drive.id, inside, 'the drive that registers it is shown even without a link');
    assert.equal(r.drive.linked, false);
    assert.equal(reservationItem(list, touching).kmState, 'missing', 'a drive that only touches the end does not count');
    assert.equal(reservationItem(list, touching).drive, null);
  } finally {
    await t.close();
  }
});

test('invariant: whenever a reservation is "registered" its drive is not null, whatever mix of rows exists', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const a = insertReservation(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -26) });
    const b = insertReservation(t, { userId: ben.id, start: at(t.clock, -20), end: at(t.clock, -16) });
    const c = insertReservation(t, { userId: anna.id, start: at(t.clock, -10), end: at(t.clock, -6) });
    insertReservation(t, { userId: ben.id, start: at(t.clock, 2), end: at(t.clock, 4) });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -29), end: at(t.clock, -27), odometerStart: 1, odometerEnd: 2, reservationId: a });
    insertUsage(t, { userId: anna.id, start: at(t.clock, -19), end: at(t.clock, -17), reservationId: b }); // legacy, linked
    insertUsage(t, { userId: ben.id, start: at(t.clock, -9), end: at(t.clock, -7), odometerStart: 3, odometerEnd: 4 }); // unlinked overlap of c
    insertDraft(t, { userId: anna.id, start: at(t.clock, -0.2) });
    const items = (await anna.get('/api/reservations')).body.items;
    assert.equal(items.length, 4);
    for (const r of items) {
      if (r.kmState === 'registered') assert.notEqual(r.drive, null, `reservation ${r.id}`);
      if (r.drive?.status === 'draft') assert.equal(r.kmState, 'draft');
    }
    assert.equal(reservationItem({ items }, a).kmState, 'registered');
    assert.equal(reservationItem({ items }, b).kmState, 'missing');
    assert.equal(reservationItem({ items }, c).kmState, 'registered');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------ the obligation

test('a completed drive needs both odometer readings; the error names the missing field', async () => {
  const { t, anna } = await createHousehold();
  try {
    const times = { start: at(t.clock, -3), end: at(t.clock, -2) };
    const bare = await anna.post('/api/usage', times);
    assert.equal(bare.status, 422);
    assert.deepEqual({ ...bare.body.error.fields }, { odometerStart: 'required', odometerEnd: 'required' });
    const noEnd = await anna.post('/api/usage', { ...times, odometerStart: 100 });
    assert.deepEqual({ ...noEnd.body.error.fields }, { odometerEnd: 'required' });
    const noStart = await anna.post('/api/usage', { ...times, odometerEnd: 100 });
    assert.deepEqual({ ...noStart.body.error.fields }, { odometerStart: 'required' });
    const nulls = await anna.post('/api/usage', { ...times, odometerStart: null, odometerEnd: null });
    assert.deepEqual({ ...nulls.body.error.fields }, { odometerStart: 'required', odometerEnd: 'required' });
    const noTime = await anna.post('/api/usage', { start: times.start, ...ODO });
    assert.deepEqual({ ...noTime.body.error.fields }, { end: 'required' });
    const backwards = await anna.post('/api/usage', { ...times, odometerStart: 500, odometerEnd: 499 });
    assert.equal(backwards.status, 422);
    assert.equal(backwards.body.error.fields.odometerEnd, 'must_not_be_below_start');
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n, 0, 'nothing was stored');
    assert.equal((await anna.post('/api/usage', { ...times, ...ODO })).status, 201);
  } finally {
    await t.close();
  }
});

test('clearing or dropping a reading on an existing drive is rejected', async () => {
  const { t, anna } = await createHousehold();
  try {
    const id = (await anna.post('/api/usage', { start: at(t.clock, -3), end: at(t.clock, -2), ...ODO })).body.usage.id;
    for (const body of [{ odometerStart: null }, { odometerEnd: null }, { odometerStart: null, odometerEnd: null }, { end: null }]) {
      const res = await anna.patch(`/api/usage/${id}`, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.equal(Object.values(res.body.error.fields)[0], 'required', JSON.stringify(body));
    }
    assert.equal((await anna.patch(`/api/usage/${id}`, { odometerEnd: 10_080 })).body.usage.distanceKm, 80, 'a correction is fine');
  } finally {
    await t.close();
  }
});

test('kilometres are attributed to the driver, drafts and legacy rows without readings are left out', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    await anna.post('/api/usage', { start: at(t.clock, -30), end: at(t.clock, -28), odometerStart: 1000, odometerEnd: 1040 });
    await admin.post('/api/usage', { start: at(t.clock, -20), end: at(t.clock, -18), odometerStart: 1040, odometerEnd: 1100, userId: ben.id });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -10), end: at(t.clock, -8) }); // legacy: no readings
    insertDraft(t, { userId: anna.id, start: at(t.clock, -1) });
    const s = (await anna.get('/api/usage/summary')).body;
    assert.deepEqual(s.items, [
      { userId: ben.id, userName: 'Ben', trips: 2, tripsWithKm: 1, km: 60 },
      { userId: anna.id, userName: 'Anna', trips: 1, tripsWithKm: 1, km: 40 },
    ]);
    assert.equal(s.totalKm, 100);
    assert.equal(s.totalTrips, 3, 'the open draft is not a trip yet');
  } finally {
    await t.close();
  }
});

// -------------------------------------------------------------------- drafts

test('a draft needs only a start time and the start reading', async () => {
  const { t, anna } = await createHousehold();
  try {
    const res = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -0.1), odometerStart: 12_345, note: 'on my way' });
    assert.equal(res.status, 201, res.text);
    const u = res.body.usage;
    assert.equal(u.status, 'draft');
    assert.equal(u.end, null, 'the placeholder end never leaves the server');
    assert.equal(u.odometerEnd, null);
    assert.equal(u.distanceKm, null);
    assert.deepEqual(u.can, { edit: true, delete: true });
    const row = one<{ end_utc: string; start_utc: string }>(t.db, 'SELECT end_utc, start_utc FROM usage WHERE id = ?', u.id);
    assert.equal(row?.end_utc, row?.start_utc);

    const listed = (await anna.get('/api/usage')).body.items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'draft');
    assert.equal(listed[0].end, null);

    const missingReading = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -0.05) });
    assert.equal(missingReading.status, 422);
    assert.deepEqual({ ...missingReading.body.error.fields }, { odometerStart: 'required' });
  } finally {
    await t.close();
  }
});

test('a draft cannot carry an end time or an end reading, and its start is checked like any other time', async () => {
  const { t, anna } = await createHousehold();
  try {
    const start = at(t.clock, -0.1);
    const withEnd = await anna.post('/api/usage', { status: 'draft', start, odometerStart: 5, end: at(t.clock, -0.05), odometerEnd: 9 });
    assert.equal(withEnd.status, 422);
    assert.deepEqual({ ...withEnd.body.error.fields }, { end: 'must_be_empty', odometerEnd: 'must_be_empty' });
    // null means "none" and is fine.
    assert.equal((await anna.post('/api/usage', { status: 'draft', start, odometerStart: 5, end: null, odometerEnd: null })).status, 201);

    const t2 = await createHousehold();
    try {
      const future = await t2.anna.post('/api/usage', { status: 'draft', start: new Date(t2.t.clock.now().getTime() + 5 * MIN + 1).toISOString(), odometerStart: 5 });
      assert.equal(future.status, 422);
      assert.equal(future.body.error.fields.start, 'in_future');
      const slack = await t2.anna.post('/api/usage', { status: 'draft', start: new Date(t2.t.clock.now().getTime() + 5 * MIN).toISOString(), odometerStart: 5 });
      assert.equal(slack.status, 201, 'five minutes of slack, as for ends');
      const old = await t2.ben.post('/api/usage', { status: 'draft', start: '2025-06-01T08:00:00Z', odometerStart: 5 });
      assert.equal(old.status, 422);
      assert.equal(old.body.error.code, 'outside_window');
      assert.equal((await t2.ben.post('/api/usage', { status: 'bogus', start: at(t2.t.clock, -1), odometerStart: 5 })).body.error.fields.status, 'invalid_value');
    } finally {
      await t2.t.close();
    }
  } finally {
    await t.close();
  }
});

test('only one open draft per driver: the second is 409 draft_exists and names the first', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const first = (await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -2), odometerStart: 100 })).body.usage;
    const second = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -1), odometerStart: 150 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'draft_exists');
    assert.equal(second.body.error.draftId, first.id);
    assert.equal((await ben.post('/api/usage', { status: 'draft', start: at(t.clock, -1), odometerStart: 150 })).status, 201, 'a different driver is unaffected');
    // An admin cannot create a second one for Anna either.
    assert.equal((await admin.post('/api/usage', { status: 'draft', start: at(t.clock, -0.5), odometerStart: 150, userId: anna.id })).status, 409);
    // Finishing the first makes room.
    assert.equal((await anna.patch(`/api/usage/${first.id}`, { status: 'completed', end: at(t.clock, -1.5), odometerEnd: 120 })).status, 200);
    assert.equal((await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -1), odometerStart: 150 })).status, 201);
  } finally {
    await t.close();
  }
});

test('finishing a draft runs the same checks as logging a drive', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const draft = (await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -3), odometerStart: 100 })).body.usage;
    const url = `/api/usage/${draft.id}`;

    const noEnd = await anna.patch(url, { status: 'completed', odometerEnd: 140 });
    assert.equal(noEnd.status, 422);
    assert.deepEqual({ ...noEnd.body.error.fields }, { end: 'required' }, 'the stored end is only a placeholder');
    const noReading = await anna.patch(url, { status: 'completed', end: at(t.clock, -1) });
    assert.deepEqual({ ...noReading.body.error.fields }, { odometerEnd: 'required' });
    const before = await anna.patch(url, { status: 'completed', end: at(t.clock, -4), odometerEnd: 140 });
    assert.equal(before.body.error.fields.end, 'must_not_be_before_start');
    const below = await anna.patch(url, { status: 'completed', end: at(t.clock, -1), odometerEnd: 99 });
    assert.equal(below.body.error.fields.odometerEnd, 'must_not_be_below_start');
    const future = await anna.patch(url, { status: 'completed', end: at(t.clock, 1), odometerEnd: 140 });
    assert.equal(future.body.error.fields.end, 'in_future');

    await ben.post('/api/usage', { start: at(t.clock, -2), end: at(t.clock, -1), ...ODO });
    const clash = await anna.patch(url, { status: 'completed', end: at(t.clock, -0.5), odometerEnd: 140 });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'overlap');
    assert.equal(clash.body.error.conflict.userName, 'Ben');

    const done = await anna.patch(url, { status: 'completed', end: at(t.clock, -2), odometerEnd: 140 });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.usage.status, 'completed');
    assert.equal(done.body.usage.end, at(t.clock, -2));
    assert.equal(done.body.usage.distanceKm, 40);
  } finally {
    await t.close();
  }
});

test('a draft can be edited while it stays a draft, cannot be reopened once finished, and belongs to its driver', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const draft = (await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -3), odometerStart: 100 })).body.usage;
    const url = `/api/usage/${draft.id}`;
    const edited = await anna.patch(url, { odometerStart: 101, note: 'fixed the reading' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.usage.status, 'draft');
    assert.equal(edited.body.usage.odometerStart, 101);
    assert.equal(edited.body.usage.end, null);
    assert.equal((await anna.patch(url, { end: at(t.clock, -1) })).body.error.fields.end, 'must_be_empty');
    assert.equal((await anna.patch(url, { odometerEnd: 150 })).body.error.fields.odometerEnd, 'must_be_empty');
    assert.equal((await anna.patch(url, { odometerStart: null })).body.error.fields.odometerStart, 'required');

    assert.equal((await ben.patch(url, { status: 'completed', end: at(t.clock, -1), odometerEnd: 150 })).status, 403, 'another user cannot finish it');
    assert.equal((await ben.del(url)).status, 403);
    const byAdmin = await admin.patch(url, { status: 'completed', end: at(t.clock, -1), odometerEnd: 150 });
    assert.equal(byAdmin.status, 200, 'an admin can finish it for them');
    assert.equal(byAdmin.body.usage.userId, anna.id);

    const reopen = await anna.patch(url, { status: 'draft' });
    assert.equal(reopen.status, 422);
    assert.equal(reopen.body.error.fields.status, 'cannot_reopen');

    const another = (await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -0.5), odometerStart: 150 })).body.usage;
    assert.equal((await anna.del(`/api/usage/${another.id}`)).status, 204, 'an abandoned draft can be thrown away');
  } finally {
    await t.close();
  }
});

test('a draft never blocks another driver, but its start cannot lie inside a finished drive', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -3), odometerStart: 100 });
    const around = await ben.post('/api/usage', { start: at(t.clock, -4), end: at(t.clock, -1), ...ODO });
    assert.equal(around.status, 201, 'a finished drive may cover the time an open draft started in');
    const inside = await anna.get('/api/usage');
    assert.equal(inside.body.items.length, 2);

    const t2 = await createHousehold();
    try {
      await t2.ben.post('/api/usage', { start: at(t2.t.clock, -4), end: at(t2.t.clock, -2), ...ODO });
      const clash = await t2.anna.post('/api/usage', { status: 'draft', start: at(t2.t.clock, -3), odometerStart: 100 });
      assert.equal(clash.status, 409);
      assert.equal(clash.body.error.code, 'overlap');
      assert.equal((await t2.anna.post('/api/usage', { status: 'draft', start: at(t2.t.clock, -2), odometerStart: 100 })).status, 201, 'starting where the other drive ended is fine');
    } finally {
      await t2.t.close();
    }

    // A draft keeps its start time in the end column as a placeholder. That placeholder never counts:
    // a zero-length finished drive at the very minute a draft started is not a clash with it.
    const t3 = await createHousehold();
    try {
      assert.equal((await t3.anna.post('/api/usage', { status: 'draft', start: at(t3.t.clock, -3), odometerStart: 100 })).status, 201);
      const same = await t3.ben.post('/api/usage', { start: at(t3.t.clock, -3), end: at(t3.t.clock, -3), ...ODO });
      assert.equal(same.status, 201, same.text);
    } finally {
      await t3.t.close();
    }

    // And the other way round: a draft that starts at the very minute of a zero-length finished drive.
    const t4 = await createHousehold();
    try {
      assert.equal((await t4.ben.post('/api/usage', { start: at(t4.t.clock, -3), end: at(t4.t.clock, -3), ...ODO })).status, 201);
      const draft = await t4.anna.post('/api/usage', { status: 'draft', start: at(t4.t.clock, -3), odometerStart: 100 });
      assert.equal(draft.status, 201, draft.text);
    } finally {
      await t4.t.close();
    }
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------- pending

test('pending: an ended reservation without a completed registration is listed for its driver', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const unregistered = insertReservation(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -26), note: 'Groceries' });
    const registered = insertReservation(t, { userId: anna.id, start: at(t.clock, -20), end: at(t.clock, -16) });
    const touched = insertReservation(t, { userId: anna.id, start: at(t.clock, -12), end: at(t.clock, -10) });
    insertReservation(t, { userId: ben.id, start: at(t.clock, -8), end: at(t.clock, -6) });
    insertUsage(t, { userId: anna.id, start: at(t.clock, -19), end: at(t.clock, -17), odometerStart: 1, odometerEnd: 9, reservationId: registered });
    insertUsage(t, { userId: anna.id, start: at(t.clock, -14), end: at(t.clock, -12), odometerStart: 9, odometerEnd: 20 }); // ends where `touched` starts

    const res = await anna.get('/api/usage/pending');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 2);
    assert.equal(res.body.items.length, 1);
    const mine = res.body.items[0];
    assert.equal(mine.userId, anna.id);
    assert.equal(mine.userName, 'Anna');
    assert.deepEqual(mine.reservations.map((r: Json) => r.id), [unregistered, touched]);
    assert.equal(mine.reservations[0].note, 'Groceries');
    assert.equal(mine.reservations[0].kmState, 'missing');
    assert.deepEqual(mine.drafts, []);
  } finally {
    await t.close();
  }
});

test('pending: running and future reservations are not listed; the look-back follows ?days', async () => {
  const { t, anna } = await createHousehold();
  try {
    insertReservation(t, { userId: anna.id, start: at(t.clock, -1), end: at(t.clock, 1) }); // running
    insertReservation(t, { userId: anna.id, start: at(t.clock, 5), end: at(t.clock, 6) });
    const recent = insertReservation(t, { userId: anna.id, start: at(t.clock, -48), end: at(t.clock, -46) });
    const old = insertReservation(t, { userId: anna.id, start: at(t.clock, -24 * 20 - 2), end: at(t.clock, -24 * 20) });
    const ancient = insertReservation(t, { userId: anna.id, start: at(t.clock, -24 * 100 - 2), end: at(t.clock, -24 * 100) });
    const ids = async (query: string): Promise<number[]> => (await anna.get(`/api/usage/pending${query}`)).body.items[0].reservations.map((r: Json) => r.id);
    assert.deepEqual(await ids(''), [recent], 'default: 14 days');
    assert.deepEqual(await ids('?days=30'), [old, recent]);
    assert.deepEqual(await ids('?days=190'), [ancient, old, recent]);
    assert.equal((await anna.get('/api/usage/pending?days=0')).status, 422);
    assert.equal((await anna.get('/api/usage/pending?days=400')).status, 422);
    assert.equal((await anna.get('/api/usage/pending?days=x')).status, 422);
  } finally {
    await t.close();
  }
});

test('pending: a reservation with a linked draft is one piece of work, not two', async () => {
  const { t, anna } = await createHousehold();
  try {
    const res = insertReservation(t, { userId: anna.id, start: at(t.clock, -5), end: at(t.clock, -1) });
    const draft = insertDraft(t, { userId: anna.id, start: at(t.clock, -4.5), reservationId: res });
    const body = (await anna.get('/api/usage/pending')).body;
    assert.equal(body.count, 1);
    assert.deepEqual(body.items[0].reservations.map((r: Json) => [r.id, r.kmState]), [[res, 'draft']]);
    assert.deepEqual(body.items[0].drafts.map((d: Json) => [d.id, d.status, d.end]), [[draft, 'draft', null]]);

    // An unlinked draft counts on its own.
    const t2 = await createHousehold();
    try {
      insertDraft(t2.t, { userId: t2.ben.id, start: at(t2.t.clock, -2) });
      const b = (await t2.ben.get('/api/usage/pending')).body;
      assert.equal(b.count, 1);
      assert.deepEqual(b.items[0].reservations, []);
      assert.equal(b.items[0].drafts.length, 1);
    } finally {
      await t2.t.close();
    }
  } finally {
    await t.close();
  }
});

test('pending: members see only their own; admins can look at one person or at everyone', async () => {
  const { t, admin, anna, ben, carla } = await createHousehold();
  try {
    const a = insertReservation(t, { userId: anna.id, start: at(t.clock, -10), end: at(t.clock, -8) });
    const b = insertReservation(t, { userId: ben.id, start: at(t.clock, -6), end: at(t.clock, -4) });
    insertDraft(t, { userId: carla.id, start: at(t.clock, -1) });

    assert.equal((await anna.get(`/api/usage/pending?userId=${ben.id}`)).status, 403);
    assert.equal((await anna.get('/api/usage/pending?all=1')).status, 403);
    assert.equal((await anna.get(`/api/usage/pending?userId=${anna.id}`)).status, 200, 'asking for yourself is fine');

    const one = (await admin.get(`/api/usage/pending?userId=${ben.id}`)).body;
    assert.deepEqual(one.items.map((i: Json) => [i.userName, i.reservations.map((r: Json) => r.id)]), [['Ben', [b]]]);
    assert.equal(one.count, 1);

    const everyone = (await admin.get('/api/usage/pending?all=1')).body;
    assert.deepEqual(everyone.items.map((i: Json) => [i.userName, i.reservations.map((r: Json) => r.id), i.drafts.length]), [
      ['Anna', [a], 0],
      ['Ben', [b], 0],
      ['Carla', [], 1],
    ]);
    assert.equal(everyone.count, 3);
    // The admin's own list is empty and says so.
    const mine = (await admin.get('/api/usage/pending')).body;
    assert.equal(mine.count, 0);
    assert.equal(mine.items.length, 1);
    assert.equal((await admin.get('/api/usage/pending?userId=9999')).status, 422);
    assert.equal((await t.client().get('/api/usage/pending')).status, 401);
  } finally {
    await t.close();
  }
});
