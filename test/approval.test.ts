import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db.ts';
import { at, createHousehold, type Client, type Household } from './helpers.ts';

async function suggest(h: Household, from: Client, to: Client, startH = 24, endH = 28): Promise<number> {
  const res = await from.post('/api/reservations', { userId: to.id, start: at(h.t.clock, startH), end: at(h.t.clock, endH), note: 'please' });
  assert.equal(res.status, 201, res.text);
  return res.body.reservation.id;
}

const ids = (items: Array<{ id: number }>): number[] => items.map((i) => i.id);

test('a suggestion is pending, visible to the target and creator, and hidden from other members', async () => {
  const h = await createHousehold();
  const { t, admin, anna, ben, carla } = h;
  try {
    const id = await suggest(h, anna, ben);
    const asBen = await ben.get('/api/reservations');
    assert.deepEqual(ids(asBen.body.items), [id]);
    assert.equal(asBen.body.items[0].status, 'pending');
    assert.deepEqual(asBen.body.items[0].can, { edit: false, cancel: false, approve: true, decline: true });
    assert.deepEqual(ids((await anna.get('/api/reservations')).body.items), [id]);
    assert.deepEqual(ids((await admin.get('/api/reservations')).body.items), [id]);
    assert.deepEqual((await carla.get('/api/reservations')).body.items, []);
    assert.equal((await carla.get(`/api/reservations/${id}`)).status, 403);
    assert.equal((await ben.get(`/api/reservations/${id}`)).status, 200);
    assert.equal((await carla.get('/api/reservations?status=pending')).body.items.length, 0);

    const inboxBen = (await ben.get('/api/inbox')).body;
    assert.deepEqual(ids(inboxBen.incoming), [id]);
    assert.equal(inboxBen.incomingCount, 1);
    assert.deepEqual(inboxBen.outgoing, []);
    const inboxAnna = (await anna.get('/api/inbox')).body;
    assert.deepEqual(ids(inboxAnna.outgoing), [id]);
    assert.equal(inboxAnna.incomingCount, 0);
    const inboxCarla = (await carla.get('/api/inbox')).body;
    assert.deepEqual([inboxCarla.incoming, inboxCarla.outgoing, inboxCarla.incomingCount], [[], [], 0]);
  } finally {
    await t.close();
  }
});

test('only the target can approve; everyone else gets 403 and nothing changes', async () => {
  const h = await createHousehold();
  const { t, admin, anna, ben, carla } = h;
  try {
    const id = await suggest(h, anna, ben);
    for (const [who, client] of [['creator', anna], ['other member', carla], ['admin', admin]] as const) {
      assert.equal((await client.post(`/api/reservations/${id}/approve`)).status, 403, who);
      assert.equal((await client.post(`/api/reservations/${id}/decline`)).status, 403, who);
    }
    assert.equal(one<{ status: string }>(t.db, 'SELECT status FROM reservations')?.status, 'pending');

    const ok = await ben.post(`/api/reservations/${id}/approve`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.reservation.status, 'confirmed');
    assert.equal(ok.body.reservation.userId, ben.id);
    assert.equal(ok.body.reservation.createdBy, anna.id);
    assert.equal(ok.body.reservation.suggestion, true);
    assert.equal(ok.body.reservation.note, 'please');
    // Now it blocks the slot and is visible to everybody.
    assert.deepEqual(ids((await carla.get('/api/reservations')).body.items), [id]);
    assert.equal((await carla.post('/api/reservations', { start: at(t.clock, 25), end: at(t.clock, 26) })).status, 409);
    assert.deepEqual((await ben.get('/api/inbox')).body.incoming, []);
    // Answering twice is a conflict, not a second approval.
    assert.equal((await ben.post(`/api/reservations/${id}/approve`)).status, 409);
    assert.equal((await ben.post(`/api/reservations/${id}/decline`)).status, 409);
  } finally {
    await t.close();
  }
});

test('approving re-checks overlap: a slot taken in the meantime gives 409 and the suggestion stays pending', async () => {
  const h = await createHousehold();
  const { t, anna, ben, carla } = h;
  try {
    const id = await suggest(h, anna, ben, 24, 28);
    const taken = await carla.post('/api/reservations', { start: at(t.clock, 26), end: at(t.clock, 30) });
    assert.equal(taken.status, 201);
    const res = await ben.post(`/api/reservations/${id}/approve`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'overlap');
    assert.equal(res.body.error.conflict.id, taken.body.reservation.id);
    assert.equal(one<{ status: string }>(t.db, 'SELECT status FROM reservations WHERE id = ?', id)?.status, 'pending');
    // Declining still works, and after carla frees the slot a fresh suggestion can be approved.
    await carla.del(`/api/reservations/${taken.body.reservation.id}`);
    assert.equal((await ben.post(`/api/reservations/${id}/approve`)).status, 200);
  } finally {
    await t.close();
  }
});

test('two suggestions for the same slot: the first approval wins, the second gets 409', async () => {
  const h = await createHousehold();
  const { t, anna, ben, carla } = h;
  try {
    const first = await suggest(h, anna, ben, 24, 28);
    const second = await suggest(h, carla, ben, 25, 27);
    assert.equal((await ben.post(`/api/reservations/${first}/approve`)).status, 200);
    assert.equal((await ben.post(`/api/reservations/${second}/approve`)).status, 409);
    assert.equal((await ben.post(`/api/reservations/${second}/decline`)).status, 200);
  } finally {
    await t.close();
  }
});

test('declining marks the suggestion declined; the creator sees it and can remove it', async () => {
  const h = await createHousehold();
  const { t, admin, anna, ben, carla } = h;
  try {
    const id = await suggest(h, anna, ben);
    const res = await ben.post(`/api/reservations/${id}/decline`);
    assert.equal(res.status, 200);
    assert.equal(res.body.reservation.status, 'declined');
    assert.deepEqual((await ben.get('/api/inbox')).body.incoming, []);
    const outgoing = (await anna.get('/api/inbox')).body.outgoing;
    assert.deepEqual(outgoing.map((o: { id: number; status: string }) => [o.id, o.status]), [[id, 'declined']]);
    assert.equal((await ben.post(`/api/reservations/${id}/approve`)).status, 409);
    // It never blocked anything.
    assert.equal((await carla.post('/api/reservations', { start: at(t.clock, 24), end: at(t.clock, 28) })).status, 201);
    assert.equal((await carla.get(`/api/reservations/${id}`)).status, 403);
    assert.equal((await ben.del(`/api/reservations/${id}`)).status, 403, 'the target cannot delete, only answer');
    assert.equal((await anna.del(`/api/reservations/${id}`)).status, 204);
    assert.equal((await admin.get(`/api/reservations/${id}`)).status, 404);
  } finally {
    await t.close();
  }
});

test('the creator can withdraw a pending suggestion; others cannot, admins can', async () => {
  const h = await createHousehold();
  const { t, admin, anna, ben, carla } = h;
  try {
    const id = await suggest(h, anna, ben);
    assert.equal((await carla.del(`/api/reservations/${id}`)).status, 403);
    assert.equal((await ben.del(`/api/reservations/${id}`)).status, 403);
    assert.equal((await anna.del(`/api/reservations/${id}`)).status, 204);
    assert.deepEqual((await ben.get('/api/inbox')).body.incoming, []);
    assert.equal((await ben.post(`/api/reservations/${id}/approve`)).status, 404);

    const again = await suggest(h, anna, ben);
    assert.equal((await admin.del(`/api/reservations/${again}`)).status, 204);
  } finally {
    await t.close();
  }
});

test('unanswered suggestions lapse once their start time has passed', async () => {
  const h = await createHousehold();
  const { t, anna, ben } = h;
  try {
    const id = await suggest(h, anna, ben, 2, 5);
    assert.equal((await ben.get('/api/inbox')).body.incomingCount, 1);

    t.clock.advance(3 * 3_600_000); // now inside the suggested slot
    const list = await ben.get('/api/reservations');
    assert.equal(list.body.items[0].status, 'expired');
    assert.deepEqual(list.body.items[0].can, { edit: false, cancel: false, approve: false, decline: false });
    assert.equal((await ben.get('/api/reservations?status=expired')).body.items.length, 1);
    assert.equal((await ben.get('/api/reservations?status=pending')).body.items.length, 0);
    const inbox = (await ben.get('/api/inbox')).body;
    assert.deepEqual([inbox.incoming, inbox.incomingCount], [[], 0]);

    const approve = await ben.post(`/api/reservations/${id}/approve`);
    assert.equal(approve.status, 409);
    assert.equal(approve.body.error.code, 'suggestion_expired');
    assert.equal((await ben.post(`/api/reservations/${id}/decline`)).body.error.code, 'suggestion_expired');
    assert.equal((await anna.patch(`/api/reservations/${id}`, { note: 'too late' })).body.error.code, 'not_editable');
    // The creator still sees it as expired in the outgoing list and can clean it up.
    assert.equal((await anna.get('/api/inbox')).body.outgoing[0].status, 'expired');
    assert.equal((await anna.del(`/api/reservations/${id}`)).status, 204);
  } finally {
    await t.close();
  }
});

test('suggestions must start in the future and name an active user', async () => {
  const h = await createHousehold();
  const { t, admin, anna, ben } = h;
  try {
    const past = await anna.post('/api/reservations', { userId: ben.id, start: at(t.clock, -2), end: at(t.clock, 2) });
    assert.equal(past.status, 422);
    assert.equal(past.body.error.fields.start, 'must_be_in_future');
    const ghost = await anna.post('/api/reservations', { userId: 9999, start: at(t.clock, 2), end: at(t.clock, 3) });
    assert.equal(ghost.status, 422);
    assert.equal(ghost.body.error.fields.userId, 'unknown_user');
    await admin.patch(`/api/admin/users/${ben.id}`, { active: false });
    const inactive = await anna.post('/api/reservations', { userId: ben.id, start: at(t.clock, 2), end: at(t.clock, 3) });
    assert.equal(inactive.status, 422);
    // Own reservations in the past are fine.
    assert.equal((await anna.post('/api/reservations', { start: at(t.clock, -5), end: at(t.clock, -3) })).status, 201);
  } finally {
    await t.close();
  }
});

test('the creator can edit a pending suggestion; the new times are what gets approved', async () => {
  const h = await createHousehold();
  const { t, admin, anna, ben, carla } = h;
  try {
    const id = await suggest(h, anna, ben, 24, 28);
    assert.equal((await ben.patch(`/api/reservations/${id}`, { note: 'mine now' })).status, 403);
    assert.equal((await carla.patch(`/api/reservations/${id}`, { note: 'nope' })).status, 403);
    const edited = await anna.patch(`/api/reservations/${id}`, { start: at(t.clock, 30), end: at(t.clock, 33) });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.reservation.status, 'pending');
    assert.equal((await anna.patch(`/api/reservations/${id}`, { start: at(t.clock, -1) })).status, 422);
    assert.equal((await admin.patch(`/api/reservations/${id}`, { note: 'admin touched' })).status, 200);
    const approved = await ben.post(`/api/reservations/${id}/approve`);
    assert.equal(approved.body.reservation.start, at(t.clock, 30));
    assert.equal(approved.body.reservation.note, 'admin touched');
  } finally {
    await t.close();
  }
});

test('after approval the driver owns the reservation: they and admins can change it, the creator cannot', async () => {
  const h = await createHousehold();
  const { t, admin, anna, ben } = h;
  try {
    const id = await suggest(h, anna, ben);
    await ben.post(`/api/reservations/${id}/approve`);
    assert.equal((await anna.patch(`/api/reservations/${id}`, { note: 'creator' })).status, 403);
    assert.equal((await anna.del(`/api/reservations/${id}`)).status, 403);
    assert.equal((await ben.patch(`/api/reservations/${id}`, { note: 'driver' })).status, 200);
    assert.equal((await admin.patch(`/api/reservations/${id}`, { note: 'admin' })).status, 200);
    assert.equal((await ben.del(`/api/reservations/${id}`)).status, 204);
  } finally {
    await t.close();
  }
});

test('an admin suggestion follows the same flow and the admin cannot approve for the target', async () => {
  const h = await createHousehold();
  const { admin, anna, t } = h;
  try {
    const id = await suggest(h, admin, anna);
    assert.equal((await admin.post(`/api/reservations/${id}/approve`)).status, 403);
    assert.equal((await anna.post(`/api/reservations/${id}/approve`)).status, 200);
  } finally {
    await t.close();
  }
});

test('answering unknown reservations is 404', async () => {
  const h = await createHousehold();
  try {
    assert.equal((await h.ben.post('/api/reservations/4242/approve')).status, 404);
    assert.equal((await h.ben.post('/api/reservations/abc/decline')).status, 404);
  } finally {
    await h.t.close();
  }
});
