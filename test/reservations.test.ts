import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db.ts';
import { at, createHousehold } from './helpers.ts';

test('a member books the car for themselves and it is confirmed at once', async () => {
  const { t, anna } = await createHousehold();
  try {
    const start = at(t.clock, 24);
    const end = at(t.clock, 28);
    const res = await anna.post('/api/reservations', { start, end, note: 'Groceries' });
    assert.equal(res.status, 201);
    const r = res.body.reservation;
    assert.equal(r.status, 'confirmed');
    assert.equal(r.userId, anna.id);
    assert.equal(r.createdBy, anna.id);
    assert.equal(r.suggestion, false);
    assert.equal(r.start, start);
    assert.equal(r.end, end);
    assert.equal(r.note, 'Groceries');
    assert.equal(r.userName, 'Anna');
    assert.deepEqual(r.can, { edit: true, cancel: true, approve: false, decline: false });

    // Naming yourself explicitly is the same thing.
    const explicit = await anna.post('/api/reservations', { userId: anna.id, start: at(t.clock, 48), end: at(t.clock, 50) });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.body.reservation.status, 'confirmed');

    const list = await anna.get('/api/reservations');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((i: { id: number }) => i.id), [r.id, explicit.body.reservation.id]);
  } finally {
    await t.close();
  }
});

test('reservation input is validated: start must be before end, dates must be real ISO instants', async () => {
  const { t, anna } = await createHousehold();
  try {
    const start = at(t.clock, 24);
    const same = await anna.post('/api/reservations', { start, end: start });
    assert.equal(same.status, 422);
    assert.equal(same.body.error.fields.end, 'must_be_after_start');
    const reversed = await anna.post('/api/reservations', { start: at(t.clock, 26), end: start });
    assert.equal(reversed.status, 422);

    const missing = await anna.post('/api/reservations', {});
    assert.equal(missing.status, 422);
    assert.deepEqual(missing.body.error.fields, { start: 'required', end: 'required' });

    for (const bad of ['tomorrow', '2026-06-16', '2026-06-16T10:00', '2026-02-30T10:00:00Z', '2026-06-16T25:00:00Z', 12345, null]) {
      const res = await anna.post('/api/reservations', { start: bad, end: at(t.clock, 30) });
      assert.equal(res.status, 422, String(bad));
      assert.ok(res.body.error.fields.start, String(bad));
    }

    // An explicit offset is normalised to UTC.
    const offset = await anna.post('/api/reservations', { start: '2026-06-20T10:00:00+02:00', end: '2026-06-20T12:30:00.5+02:00' });
    assert.equal(offset.status, 201);
    assert.equal(offset.body.reservation.start, '2026-06-20T08:00:00.000Z');
    assert.equal(offset.body.reservation.end, '2026-06-20T10:30:00.500Z');

    const longNote = await anna.post('/api/reservations', { start: at(t.clock, 60), end: at(t.clock, 61), note: 'x'.repeat(501) });
    assert.equal(longNote.status, 422);
    assert.equal(longNote.body.error.fields.note, 'too_long');
    const badUser = await anna.post('/api/reservations', { userId: 'ben', start: at(t.clock, 60), end: at(t.clock, 61) });
    assert.equal(badUser.status, 422);
  } finally {
    await t.close();
  }
});

test('overlapping confirmed reservations return 409; touching ends are fine', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const base = await anna.post('/api/reservations', { start: at(t.clock, 24), end: at(t.clock, 28) });
    assert.equal(base.status, 201);

    const cases: Array<[string, number, number]> = [
      ['identical', 24, 28],
      ['inside', 25, 27],
      ['covering', 20, 30],
      ['overlapping the start', 22, 25],
      ['overlapping the end', 27, 30],
    ];
    for (const [label, from, to] of cases) {
      for (const who of [anna, ben]) {
        const res = await who.post('/api/reservations', { start: at(t.clock, from), end: at(t.clock, to) });
        assert.equal(res.status, 409, label);
        assert.equal(res.body.error.code, 'overlap', label);
        assert.equal(res.body.error.conflict.id, base.body.reservation.id, label);
        assert.equal(res.body.error.conflict.userName, 'Anna', label);
      }
    }
    assert.equal((await ben.post('/api/reservations', { start: at(t.clock, 28), end: at(t.clock, 30) })).status, 201, 'starts when the other ends');
    assert.equal((await ben.post('/api/reservations', { start: at(t.clock, 22), end: at(t.clock, 24) })).status, 201, 'ends when the other starts');
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM reservations')?.n, 3);
  } finally {
    await t.close();
  }
});

test('a member cannot make a confirmed reservation for someone else: it becomes a pending suggestion', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const res = await anna.post('/api/reservations', { userId: ben.id, start: at(t.clock, 24), end: at(t.clock, 28) });
    assert.equal(res.status, 201);
    assert.equal(res.body.reservation.status, 'pending');
    assert.equal(res.body.reservation.userId, ben.id);
    assert.equal(res.body.reservation.createdBy, anna.id);
    assert.equal(res.body.reservation.suggestion, true);
    const row = one<{ status: string }>(t.db, 'SELECT status FROM reservations');
    assert.equal(row?.status, 'pending');
    assert.equal(one<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM reservations WHERE status = 'confirmed'")?.n, 0);
  } finally {
    await t.close();
  }
});

test('an admin follows the same creation rules as a member', async () => {
  const { t, admin, anna } = await createHousehold();
  try {
    const res = await admin.post('/api/reservations', { userId: anna.id, start: at(t.clock, 24), end: at(t.clock, 26) });
    assert.equal(res.status, 201);
    assert.equal(res.body.reservation.status, 'pending');
    const own = await admin.post('/api/reservations', { start: at(t.clock, 30), end: at(t.clock, 32) });
    assert.equal(own.body.reservation.status, 'confirmed');
  } finally {
    await t.close();
  }
});

test('pending suggestions never block the slot', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    assert.equal((await anna.post('/api/reservations', { userId: ben.id, start: at(t.clock, 24), end: at(t.clock, 28) })).status, 201);
    assert.equal((await carla.post('/api/reservations', { start: at(t.clock, 25), end: at(t.clock, 27) })).status, 201);
    // Two suggestions for the same slot are fine too.
    assert.equal((await anna.post('/api/reservations', { userId: ben.id, start: at(t.clock, 25), end: at(t.clock, 26) })).status, 201);
  } finally {
    await t.close();
  }
});

test('members edit and cancel their own reservations; overlap is re-checked on edit', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const mine = await anna.post('/api/reservations', { start: at(t.clock, 24), end: at(t.clock, 28) });
    const other = await ben.post('/api/reservations', { start: at(t.clock, 30), end: at(t.clock, 32) });
    const id = mine.body.reservation.id;

    const moved = await anna.patch(`/api/reservations/${id}`, { start: at(t.clock, 25), end: at(t.clock, 29), note: 'later' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.reservation.start, at(t.clock, 25));
    assert.equal(moved.body.reservation.note, 'later');

    // Growing into its own old range is not an overlap with itself.
    assert.equal((await anna.patch(`/api/reservations/${id}`, { end: at(t.clock, 30) })).status, 200);
    // Growing into someone else's reservation is.
    const clash = await anna.patch(`/api/reservations/${id}`, { end: at(t.clock, 31) });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'overlap');
    assert.equal(clash.body.error.conflict.id, other.body.reservation.id);

    assert.equal((await anna.patch(`/api/reservations/${id}`, { start: at(t.clock, 30), end: at(t.clock, 29) })).status, 422);
    assert.equal((await anna.patch(`/api/reservations/${id}`, { userId: ben.id })).status, 422);
    assert.equal((await anna.patch(`/api/reservations/${id}`, { userId: anna.id, note: 'same driver is fine' })).status, 200);

    assert.equal((await anna.del(`/api/reservations/${id}`)).status, 204);
    assert.equal((await anna.get(`/api/reservations/${id}`)).status, 404);
    assert.equal((await anna.del(`/api/reservations/${id}`)).status, 404);
    // The freed slot can be booked again.
    assert.equal((await ben.post('/api/reservations', { start: at(t.clock, 25), end: at(t.clock, 29) })).status, 201);
  } finally {
    await t.close();
  }
});

test('members cannot edit or cancel other members reservations; admins can', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const mine = await anna.post('/api/reservations', { start: at(t.clock, 24), end: at(t.clock, 28) });
    const id = mine.body.reservation.id;
    assert.equal((await ben.patch(`/api/reservations/${id}`, { note: 'hijack' })).status, 403);
    assert.equal((await ben.del(`/api/reservations/${id}`)).status, 403);
    assert.equal(one<{ note: string }>(t.db, 'SELECT note FROM reservations WHERE id = ?', id)?.note, '');

    const byAdmin = await admin.patch(`/api/reservations/${id}`, { note: 'moved by admin', end: at(t.clock, 29) });
    assert.equal(byAdmin.status, 200);
    assert.equal(byAdmin.body.reservation.userId, anna.id, 'the driver stays the same');
    assert.equal((await admin.del(`/api/reservations/${id}`)).status, 204);
  } finally {
    await t.close();
  }
});

test('an admin edit that overlaps another confirmed reservation is still refused', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const a = await anna.post('/api/reservations', { start: at(t.clock, 24), end: at(t.clock, 26) });
    await ben.post('/api/reservations', { start: at(t.clock, 26), end: at(t.clock, 28) });
    const res = await admin.patch(`/api/reservations/${a.body.reservation.id}`, { end: at(t.clock, 27) });
    assert.equal(res.status, 409);
  } finally {
    await t.close();
  }
});

test('the list shows confirmed reservations to everyone, filters by status and user, and sorts by start', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    await ben.post('/api/reservations', { start: at(t.clock, 48), end: at(t.clock, 50) });
    await anna.post('/api/reservations', { start: at(t.clock, 24), end: at(t.clock, 26) });
    const all = await carla.get('/api/reservations');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.items.map((i: { userName: string }) => i.userName), ['Anna', 'Ben']);
    assert.ok(all.body.window.from < all.body.window.to);

    const onlyBen = await carla.get(`/api/reservations?userId=${ben.id}`);
    assert.deepEqual(onlyBen.body.items.map((i: { userName: string }) => i.userName), ['Ben']);
    assert.equal((await carla.get('/api/reservations?status=confirmed')).body.items.length, 2);
    assert.equal((await carla.get('/api/reservations?status=pending')).body.items.length, 0);
    assert.equal((await carla.get('/api/reservations?status=bogus')).status, 422);
    assert.equal((await carla.get('/api/reservations?userId=abc')).status, 422);
    assert.equal((await carla.get('/api/reservations?from=nonsense')).status, 422);

    const fromTo = await carla.get(`/api/reservations?from=${encodeURIComponent(at(t.clock, 40))}&to=${encodeURIComponent(at(t.clock, 60))}`);
    assert.deepEqual(fromTo.body.items.map((i: { userName: string }) => i.userName), ['Ben']);
  } finally {
    await t.close();
  }
});
