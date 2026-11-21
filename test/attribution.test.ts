// Kilometres that are not the driver's own: the rules on the drive (a person or "together", a note
// is then compulsory), who may set them, what the lists and the summary show, and how the fuel
// split follows the owner of the kilometres instead of the driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db.ts';
import { computeShares, type ShareDrive } from '../src/fuel.ts';
import { attributionErrors } from '../src/usage.ts';
import { ODO, FUEL_ODO, at, createHousehold, insertReservation, insertUsage, type Json } from './helpers.ts';

// ------------------------------------------------------------ the pure rules

test('attributionErrors: a person needs a person other than the driver, self and together take none, and anything but self needs a note', () => {
  const ok = { kmUserId: null, driverId: 2, note: 'x' } as const;
  assert.deepEqual(attributionErrors({ kmFor: 'self', ...ok, note: '' }), {}, 'the driver\'s own kilometres need no note');
  assert.deepEqual(attributionErrors({ kmFor: 'self', ...ok, note: '   ' }), {});
  assert.deepEqual(attributionErrors({ kmFor: 'together', ...ok }), {});
  assert.deepEqual(attributionErrors({ kmFor: 'person', ...ok, kmUserId: 3 }), {});

  assert.deepEqual(attributionErrors({ kmFor: 'together', ...ok, note: '' }), { note: 'required' });
  assert.deepEqual(attributionErrors({ kmFor: 'together', ...ok, note: ' \t ' }), { note: 'required' }, 'blank is empty');
  assert.deepEqual(attributionErrors({ kmFor: 'person', ...ok, kmUserId: 3, note: '' }), { note: 'required' });
  assert.deepEqual(attributionErrors({ kmFor: 'person', ...ok }), { kmUserId: 'required' });
  assert.deepEqual(attributionErrors({ kmFor: 'person', ...ok, kmUserId: 2 }), { kmUserId: 'same_as_driver' });
  assert.deepEqual(attributionErrors({ kmFor: 'person', ...ok, note: '' }), { kmUserId: 'required', note: 'required' }, 'both at once');
  assert.deepEqual(attributionErrors({ kmFor: 'self', ...ok, kmUserId: 3 }), { kmUserId: 'only_for_person' });
  assert.deepEqual(attributionErrors({ kmFor: 'together', ...ok, kmUserId: 3 }), { kmUserId: 'only_for_person' });
});

// ------------------------------------------------------------ creating a drive

const drive = (t: { clock: Parameters<typeof at>[0] }, from: number, to: number, over: Json = {}): Json => ({
  start: at(t.clock, from),
  end: at(t.clock, to),
  ...ODO,
  ...over,
});

test('a drive is the driver\'s own by default; the answer says whose kilometres they are', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const own = await anna.post('/api/usage', drive(t, -10, -9));
    assert.equal(own.status, 201, own.text);
    assert.deepEqual([own.body.usage.kmFor, own.body.usage.kmUserId, own.body.usage.kmUserName], ['self', null, null]);

    const forBen = await anna.post('/api/usage', drive(t, -8, -7, { kmFor: 'person', kmUserId: ben.id, note: 'Took Ben to the station', odometerStart: 10_050, odometerEnd: 10_080 }));
    assert.equal(forBen.status, 201, forBen.text);
    assert.deepEqual([forBen.body.usage.userId, forBen.body.usage.kmFor, forBen.body.usage.kmUserId, forBen.body.usage.kmUserName], [anna.id, 'person', ben.id, 'Ben'], 'Anna stays the driver');
    assert.equal(forBen.body.usage.distanceKm, 30);

    const shared = await anna.post('/api/usage', drive(t, -6, -5, { kmFor: 'together', note: 'Family trip', odometerStart: 10_080, odometerEnd: 10_100 }));
    assert.equal(shared.status, 201, shared.text);
    assert.deepEqual([shared.body.usage.kmFor, shared.body.usage.kmUserId, shared.body.usage.kmUserName], ['together', null, null]);

    // The explicit "self" is the same as saying nothing, and needs no note.
    const explicit = await anna.post('/api/usage', drive(t, -4, -3, { kmFor: 'self', kmUserId: null, odometerStart: 10_100, odometerEnd: 10_110 }));
    assert.equal(explicit.status, 201, explicit.text);
    assert.equal(explicit.body.usage.kmFor, 'self');

    const row = one<Json>(t.db, 'SELECT km_for, km_user_id FROM usage WHERE id = ?', forBen.body.usage.id);
    assert.deepEqual({ ...row }, { km_for: 'person', km_user_id: ben.id });
  } finally {
    await t.close();
  }
});

test('anything but the driver\'s own kilometres needs a note, on create, on a draft and when a draft is finished', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    for (const note of [undefined, '', '   ']) {
      for (const choice of [{ kmFor: 'together' }, { kmFor: 'person', kmUserId: ben.id }]) {
        const res = await anna.post('/api/usage', drive(t, -10, -9, { ...choice, ...(note === undefined ? {} : { note }) }));
        assert.equal(res.status, 422, JSON.stringify([choice, note]));
        assert.equal(res.body.error.fields.note, 'required');
      }
    }
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n, 0, 'nothing was stored');
    assert.equal((await anna.post('/api/usage', drive(t, -10, -9, { note: '' }))).status, 201, 'a self drive still saves without a note');

    // A draft: the rule belongs to the row, not to its status.
    const noNote = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -2), odometerStart: 10_050, kmFor: 'together' });
    assert.equal(noNote.status, 422);
    assert.equal(noNote.body.error.fields.note, 'required');
    const started = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -2), odometerStart: 10_050, kmFor: 'together', note: 'Shopping for everybody' });
    assert.equal(started.status, 201, started.text);
    assert.equal(started.body.usage.status, 'draft');
    assert.equal(started.body.usage.kmFor, 'together');

    // Finishing it keeps the choice and the note; emptying the note at the same time is refused.
    const finish = { status: 'completed', end: at(t.clock, -1), odometerEnd: 10_090 };
    const blank = await anna.patch(`/api/usage/${started.body.usage.id}`, { ...finish, note: '' });
    assert.equal(blank.status, 422);
    assert.equal(blank.body.error.fields.note, 'required');
    const finished = await anna.patch(`/api/usage/${started.body.usage.id}`, finish);
    assert.equal(finished.status, 200, finished.text);
    assert.deepEqual([finished.body.usage.status, finished.body.usage.kmFor, finished.body.usage.note], ['completed', 'together', 'Shopping for everybody']);

    // A self draft that is turned into someone else's while it is finished needs the note too.
    const plain = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -0.5), odometerStart: 10_090 });
    assert.equal(plain.status, 201, plain.text);
    const turned = await anna.patch(`/api/usage/${plain.body.usage.id}`, { status: 'completed', end: at(t.clock, -0.1), odometerEnd: 10_095, kmFor: 'person', kmUserId: ben.id });
    assert.equal(turned.status, 422);
    assert.equal(turned.body.error.fields.note, 'required');
  } finally {
    await t.close();
  }
});

test('the person must be another, active person; self and together take no person; a bad choice is refused with a code per field', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const fields = async (over: Json): Promise<Json> => {
      const res = await anna.post('/api/usage', drive(t, -10, -9, { note: 'why', ...over }));
      assert.equal(res.status, 422, JSON.stringify(over));
      return res.body.error.fields;
    };
    assert.deepEqual({ ...(await fields({ kmFor: 'person' })) }, { kmUserId: 'required' });
    assert.deepEqual({ ...(await fields({ kmFor: 'person', kmUserId: null })) }, { kmUserId: 'required' });
    assert.deepEqual({ ...(await fields({ kmFor: 'person', kmUserId: anna.id })) }, { kmUserId: 'same_as_driver' }, 'not the driver');
    assert.deepEqual({ ...(await fields({ kmFor: 'person', kmUserId: 9999 })) }, { kmUserId: 'unknown_user' });
    assert.deepEqual({ ...(await fields({ kmFor: 'self', kmUserId: ben.id })) }, { kmUserId: 'only_for_person' });
    assert.deepEqual({ ...(await fields({ kmFor: 'together', kmUserId: ben.id })) }, { kmUserId: 'only_for_person' });
    assert.deepEqual({ ...(await fields({ kmFor: 'friend' })) }, { kmFor: 'invalid_value' });
    assert.deepEqual({ ...(await fields({ kmFor: 'person', kmUserId: '3' })) }, { kmUserId: 'must_be_integer' });
    assert.deepEqual({ ...(await fields({ kmFor: 'person', kmUserId: 0 })) }, { kmUserId: 'too_small' });

    // A deactivated person cannot be chosen.
    assert.equal((await admin.patch(`/api/admin/users/${ben.id}`, { active: false })).status, 200);
    assert.deepEqual({ ...(await fields({ kmFor: 'person', kmUserId: ben.id })) }, { kmUserId: 'unknown_user' });
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n, 0);
  } finally {
    await t.close();
  }
});

// -------------------------------------------------------------- changing it

test('only the driver or an admin can set or change it; an admin sets it on anybody\'s drive and chooses the driver too', async () => {
  const { t, admin, anna, ben, carla } = await createHousehold();
  try {
    const made = await anna.post('/api/usage', drive(t, -10, -9));
    const id = made.body.usage.id;
    const change = { kmFor: 'person', kmUserId: carla.id, note: 'Carla\'s errand' };
    assert.equal((await ben.patch(`/api/usage/${id}`, change)).status, 403, 'another member cannot');
    assert.equal(one<Json>(t.db, 'SELECT km_for FROM usage WHERE id = ?', id)?.km_for, 'self');
    assert.equal((await ben.post('/api/usage', { ...drive(t, -8, -7), userId: anna.id, ...change })).status, 403, 'nor create one for somebody else');

    assert.equal((await anna.patch(`/api/usage/${id}`, change)).status, 200, 'the driver can');
    const byAdmin = await admin.patch(`/api/usage/${id}`, { kmFor: 'together' });
    assert.equal(byAdmin.status, 200, byAdmin.text);
    assert.deepEqual([byAdmin.body.usage.kmFor, byAdmin.body.usage.kmUserId, byAdmin.body.usage.note], ['together', null, 'Carla\'s errand'], 'together clears the person and keeps the note');

    const forOther = await admin.post('/api/usage', { ...drive(t, -8, -7, { odometerStart: 10_050, odometerEnd: 10_070 }), userId: ben.id, kmFor: 'person', kmUserId: carla.id, note: 'Registered by the admin' });
    assert.equal(forOther.status, 201, forOther.text);
    assert.deepEqual([forOther.body.usage.userId, forOther.body.usage.kmUserName, forOther.body.usage.createdBy], [ben.id, 'Carla', admin.id]);
  } finally {
    await t.close();
  }
});

test('changing the choice: person to person, person to together, back to self; the person only carries over while it stays "person"', async () => {
  const { t, admin, anna, ben, carla } = await createHousehold();
  try {
    const id = (await anna.post('/api/usage', drive(t, -10, -9, { kmFor: 'person', kmUserId: ben.id, note: 'for Ben' }))).body.usage.id;
    const state = (): Json => ({ ...one<Json>(t.db, 'SELECT km_for, km_user_id FROM usage WHERE id = ?', id) });

    // Not saying anything about it keeps it.
    assert.equal((await anna.patch(`/api/usage/${id}`, { odometerEnd: 10_060 })).status, 200);
    assert.deepEqual(state(), { km_for: 'person', km_user_id: ben.id });
    assert.equal((await anna.patch(`/api/usage/${id}`, { kmFor: 'person' })).status, 200, 'saying "person" again keeps the person');
    assert.deepEqual(state(), { km_for: 'person', km_user_id: ben.id });

    assert.equal((await anna.patch(`/api/usage/${id}`, { kmUserId: carla.id })).status, 200, 'another person');
    assert.deepEqual(state(), { km_for: 'person', km_user_id: carla.id });
    assert.equal((await anna.patch(`/api/usage/${id}`, { kmFor: 'together' })).status, 200);
    assert.deepEqual(state(), { km_for: 'together', km_user_id: null });
    const stray = await anna.patch(`/api/usage/${id}`, { kmUserId: ben.id });
    assert.equal(stray.status, 422, 'a person on a together drive is refused, not silently dropped');
    assert.equal(stray.body.error.fields.kmUserId, 'only_for_person');

    assert.equal((await anna.patch(`/api/usage/${id}`, { kmFor: 'self' })).status, 200, 'back to the driver\'s own, the note stays');
    assert.deepEqual(state(), { km_for: 'self', km_user_id: null });
    assert.equal(one<Json>(t.db, 'SELECT note FROM usage WHERE id = ?', id)?.note, 'for Ben');
    assert.equal((await anna.patch(`/api/usage/${id}`, { note: '' })).status, 200, 'and now it needs none');

    // The driver cannot be the other person: an admin handing the drive to Ben while it is Ben's kilometres.
    assert.equal((await anna.patch(`/api/usage/${id}`, { kmFor: 'person', kmUserId: ben.id, note: 'again' })).status, 200);
    const handed = await admin.patch(`/api/usage/${id}`, { userId: ben.id });
    assert.equal(handed.status, 422);
    assert.equal(handed.body.error.fields.kmUserId, 'same_as_driver');
    assert.deepEqual(state(), { km_for: 'person', km_user_id: ben.id }, 'nothing changed');
    assert.equal((await admin.patch(`/api/usage/${id}`, { userId: ben.id, kmFor: 'self' })).status, 200, 'but handing it over as his own is fine');
  } finally {
    await t.close();
  }
});

test('a person who was deactivated after the choice stays as it was; choosing a deactivated person is refused', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const id = (await anna.post('/api/usage', drive(t, -10, -9, { kmFor: 'person', kmUserId: ben.id, note: 'for Ben' }))).body.usage.id;
    assert.equal((await admin.patch(`/api/admin/users/${ben.id}`, { active: false })).status, 200);
    const edited = await anna.patch(`/api/usage/${id}`, { note: 'for Ben, corrected', kmUserId: ben.id });
    assert.equal(edited.status, 200, 'unchanged, so not checked again');
    assert.equal(edited.body.usage.kmUserName, 'Ben');
    const moved = await anna.post('/api/usage', drive(t, -8, -7, { kmFor: 'person', kmUserId: ben.id, note: 'new' }));
    assert.equal(moved.status, 422);
    assert.equal(moved.body.error.fields.kmUserId, 'unknown_user');
  } finally {
    await t.close();
  }
});

test('a drive locked by a payment request: a member cannot change whose kilometres it is (409 fuel_requested), an admin can', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const id = (await ben.post('/api/usage', drive(t, -30, -28))).body.usage.id;
    const fuel = (await anna.post('/api/fuel', { at: at(t.clock, -10), millilitres: 40_000, totalCents: 6000, odometer: FUEL_ODO })).body.fuel;
    assert.equal((await ben.patch(`/api/usage/${id}`, { kmFor: 'together', note: 'before the request' })).status, 200, 'free before a request');
    assert.equal((await ben.patch(`/api/usage/${id}`, { kmFor: 'self' })).status, 200);
    assert.equal((await anna.post(`/api/fuel/${fuel.id}/requests`, { debtorId: ben.id })).status, 201);

    const refused = await ben.patch(`/api/usage/${id}`, { kmFor: 'together', note: 'too late' });
    assert.deepEqual([refused.status, refused.body.error.code], [409, 'fuel_requested']);
    assert.equal(one<Json>(t.db, 'SELECT km_for FROM usage WHERE id = ?', id)?.km_for, 'self', 'nothing changed');
    const byAdmin = await admin.patch(`/api/usage/${id}`, { kmFor: 'together', note: 'fixed by the admin' });
    assert.equal(byAdmin.status, 200, byAdmin.text);
    assert.equal(byAdmin.body.usage.kmFor, 'together');
  } finally {
    await t.close();
  }
});

test('a member cannot register kilometres for someone else or for everybody into a billed period, by creating a drive or finishing a draft; their own drive, an admin and other periods are not affected', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const count = (): number => one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')!.n;
    const billed = (over: Json) => ({ ...drive(t, -20, -19), kmFor: 'person', kmUserId: ben.id, note: 'for Ben', ...over });
    assert.equal((await ben.post('/api/usage', drive(t, -30, -28))).status, 201);
    const fuel = (await anna.post('/api/fuel', { at: at(t.clock, -10), millilitres: 40_000, totalCents: 6000, odometer: FUEL_ODO })).body.fuel;
    assert.equal((await anna.post('/api/usage', billed({ start: at(t.clock, -26), end: at(t.clock, -25) }))).status, 201, 'free before a request');
    assert.equal((await anna.post(`/api/fuel/${fuel.id}/requests`, { debtorId: ben.id })).status, 201);
    // Anna's draft is open already (nothing is billed to anyone until it is finished).
    const draft = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -23), odometerStart: 10_050, kmFor: 'person', kmUserId: ben.id, note: 'for Ben' });
    assert.equal(draft.status, 201, draft.text);
    const draftId = draft.body.usage.id;
    const rows = count();

    // Creating: someone else's kilometres and the shared pool are refused; nothing is written, nothing is billed.
    for (const over of [{}, { kmFor: 'together', kmUserId: null, start: at(t.clock, -18), end: at(t.clock, -17) }]) {
      const refused = await anna.post('/api/usage', billed(over));
      assert.deepEqual([refused.status, refused.body.error.code], [409, 'fuel_requested'], JSON.stringify(over));
    }
    // Finishing the draft into the billed period is the same thing.
    const finish = { status: 'completed', end: at(t.clock, -22), odometerEnd: 10_080 };
    const notFinished = await anna.patch(`/api/usage/${draftId}`, finish);
    assert.deepEqual([notFinished.status, notFinished.body.error.code], [409, 'fuel_requested']);
    assert.equal(one<Json>(t.db, 'SELECT status FROM usage WHERE id = ?', draftId)?.status, 'draft', 'still a draft');
    assert.equal(count(), rows, 'nothing was written');
    const card = (await anna.get('/api/fuel')).body.items[0].shares.find((s: Json) => s.userId === ben.id);
    assert.equal(card.request.changed, false, "Ben's request still asks what is owed");

    // Their own kilometres stay open (the fuel card flags the change), also when the draft is turned into one.
    const own = await anna.post('/api/usage', drive(t, -16, -15, { odometerStart: 10_080, odometerEnd: 10_090 }));
    assert.equal(own.status, 201, own.text);
    assert.equal(own.body.usage.fuelLocked, true, 'billed, and the owner is told');
    const asOwn = await anna.patch(`/api/usage/${draftId}`, { ...finish, kmFor: 'self' });
    assert.equal(asOwn.status, 200, asOwn.text);
    assert.deepEqual([asOwn.body.usage.kmFor, asOwn.body.usage.kmUserId], ['self', null]);

    // Outside the billed period nothing changes: a drive after the last fill-up belongs to a later one.
    const later = await anna.post('/api/usage', billed({ start: at(t.clock, -8), end: at(t.clock, -7) }));
    assert.equal(later.status, 201, later.text);

    // An admin can, by creating and by finishing a draft.
    const byAdmin = await admin.post('/api/usage', billed({ userId: anna.id, start: at(t.clock, -14), end: at(t.clock, -13) }));
    assert.equal(byAdmin.status, 201, byAdmin.text);
    const second = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -12), odometerStart: 10_090, kmFor: 'together', note: 'family' });
    assert.equal(second.status, 201, second.text);
    const closed = await admin.patch(`/api/usage/${second.body.usage.id}`, { status: 'completed', end: at(t.clock, -11.5), odometerEnd: 10_100 });
    assert.equal(closed.status, 200, closed.text);
    assert.equal(closed.body.usage.kmFor, 'together');
  } finally {
    await t.close();
  }
});

// ----------------------------------------------------------- what the lists show

test('the drives list, the history, the reservation card and the pending list show whose kilometres they are, with the note', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const res = insertReservation(t, { userId: anna.id, start: at(t.clock, -6), end: at(t.clock, -2) });
    const made = await anna.post('/api/usage', drive(t, -5, -3, { reservationId: res, kmFor: 'person', kmUserId: ben.id, note: 'Took Ben to the station' }));
    assert.equal(made.status, 201, made.text);

    const listed = ((await ben.get('/api/usage')).body.items as Json[]).find((u) => u.id === made.body.usage.id);
    assert.deepEqual([listed?.kmFor, listed?.kmUserId, listed?.kmUserName, listed?.note], ['person', ben.id, 'Ben', 'Took Ben to the station']);
    const history = ((await ben.get('/api/history')).body.usage as Json[]).find((u) => u.id === made.body.usage.id);
    assert.deepEqual([history?.kmFor, history?.kmUserName, history?.note], ['person', 'Ben', 'Took Ben to the station']);
    const card = ((await ben.get('/api/reservations')).body.items as Json[]).find((r) => r.id === res);
    assert.equal(card?.kmState, 'registered');
    assert.deepEqual([card?.drive.userName, card?.drive.kmFor, card?.drive.kmUserId, card?.drive.kmUserName], ['Anna', 'person', ben.id, 'Ben'], 'Anna drove it, the kilometres are Ben\'s');
    assert.equal((await ben.get(`/api/reservations/${res}`)).body.reservation.drive.kmFor, 'person');

    // Whose kilometres they are changes nothing about the registration: Anna's reservation is registered, nobody is nagged.
    const pending = (await anna.get('/api/usage/pending')).body;
    assert.equal(pending.count, 0);
  } finally {
    await t.close();
  }
});

test('the summary counts kilometres under their owner, reports together kilometres on their own and keeps the grand total', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    // Anna drives: 100 km her own, 40 km Ben's, 30 km together. Ben drives 20 km his own. Carla only owns 10 km of Anna's.
    await anna.post('/api/usage', drive(t, -40, -39, { odometerStart: 0, odometerEnd: 100 }));
    await anna.post('/api/usage', drive(t, -38, -37, { odometerStart: 100, odometerEnd: 140, kmFor: 'person', kmUserId: ben.id, note: 'for Ben' }));
    await anna.post('/api/usage', drive(t, -36, -35, { odometerStart: 140, odometerEnd: 170, kmFor: 'together', note: 'for all' }));
    await anna.post('/api/usage', drive(t, -34, -33, { odometerStart: 170, odometerEnd: 180, kmFor: 'person', kmUserId: carla.id, note: 'for Carla' }));
    await ben.post('/api/usage', drive(t, -32, -31, { odometerStart: 180, odometerEnd: 200 }));
    // Drafts and drives without readings count for nobody.
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29) });
    await ben.post('/api/usage', { status: 'draft', start: at(t.clock, -2), odometerStart: 200 });

    const s = (await carla.get('/api/usage/summary')).body;
    const by = new Map<string, Json>((s.items as Json[]).map((i) => [i.userName, i]));
    assert.deepEqual([...by.keys()].sort(), ['Anna', 'Ben', 'Carla']);
    assert.equal(by.get('Anna')?.km, 100, 'only her own');
    assert.equal(by.get('Ben')?.km, 60, 'his own 20 and the 40 that are his');
    assert.equal(by.get('Carla')?.km, 10, 'owns kilometres without having driven');
    assert.deepEqual({ ...s.together }, { trips: 1, tripsWithKm: 1, km: 30 });
    assert.equal(s.totalKm, 200, 'the grand total is the odometer distance: nothing is lost or counted twice');
    assert.equal(s.totalKm, (s.items as Json[]).reduce((n, i) => n + i.km, 0) + s.together.km);
    // Trips follow the driver and every drive is one trip, together drives included.
    assert.deepEqual([by.get('Anna')?.trips, by.get('Ben')?.trips, by.get('Carla')?.trips], [4, 2, 0]);
    assert.equal(s.totalTrips, 6, 'five registered drives and one without readings; the draft is not a trip yet');
    assert.deepEqual((s.items as Json[]).map((i) => i.userName), ['Anna', 'Ben', 'Carla'], 'most kilometres first');

    // The same window rules as before.
    const narrowed = (await carla.get(`/api/usage/summary?from=${encodeURIComponent(at(t.clock, -34.5))}`)).body;
    assert.equal(narrowed.totalKm, 30, 'only the drives after the cut-off: Carla\'s 10 and Ben\'s 20');
    assert.deepEqual({ ...narrowed.together }, { trips: 0, tripsWithKm: 0, km: 0 });
  } finally {
    await t.close();
  }
});

// -------------------------------------------------------------- the fuel split

const D = (userId: number, minutesBefore: number, km: number, together = false): ShareDrive => ({
  userId,
  endUtc: new Date(Date.parse('2026-06-15T10:00:00.000Z') - minutesBefore * 60_000).toISOString(),
  km,
  ...(together ? { together: true } : {}),
});
const F = (id: number, totalCents: number, minutesBefore = 0) => ({
  id,
  atUtc: new Date(Date.parse('2026-06-15T10:00:00.000Z') - minutesBefore * 60_000).toISOString(),
  totalCents,
});
const cents = (calc: ReturnType<typeof computeShares>[number]): Array<[number, number]> => calc.shares.map((s) => [s.userId, s.cents]);

test('computeShares: the together pool is split in the ratio of the personal kilometres, so nobody without personal kilometres pays any of it', () => {
  // 60.00: Anna 100 km, Ben 100 km, and 100 km together; Carla (3) is a payer but drove nothing of her own.
  const [calc] = computeShares([F(1, 6000)], [D(1, 60, 100), D(2, 50, 100), D(9, 40, 100, true)], [1, 2, 3]);
  assert.equal(calc?.totalKm, 300);
  assert.equal(calc?.togetherKm, 100);
  assert.equal(calc?.equalSplit, false);
  assert.deepEqual(cents(calc!), [[1, 3000], [2, 3000]], '100:100 of the personal kilometres; the pool does not move money');
  assert.equal(calc!.shares.reduce((n, s) => n + s.cents, 0), 6000, 'to the cent');
  assert.deepEqual(calc!.shares.map((s) => s.km), [100, 100], "km is the person's own; the pool is not in it");

  // 60.00 with Anna 100 km, Ben 50 km and 90 km together: the whole fill-up goes 100:50, which is what 100:50 of the personal part
  // and the same ratio of the pool add up to (Anna 40.00, Ben 20.00).
  const [uneven] = computeShares([F(1, 6000)], [D(1, 60, 100), D(2, 50, 50), D(9, 40, 90, true)], [1, 2, 3]);
  assert.deepEqual(cents(uneven!), [[1, 4000], [2, 2000]]);
  assert.equal(uneven?.totalKm, 240);

  // The cents stay exact when the ratio does not divide: 100 : 100 : 100 of 10.00, the odd cent to the lowest id.
  const [thirds] = computeShares([F(1, 1000)], [D(1, 60, 100), D(2, 50, 100), D(3, 40, 100)], [1, 2, 3]);
  assert.deepEqual(cents(thirds!), [[1, 334], [2, 333], [3, 333]]);
});

test('computeShares: only together kilometres fall back to an equal split over the payers, flagged; nobody driving at all is the old equal split; no payers means no shares', () => {
  const [pool] = computeShares([F(1, 1000)], [D(7, 30, 50, true)], [1, 2, 3]);
  assert.deepEqual(cents(pool!), [[1, 334], [2, 333], [3, 333]], 'the odd cent goes to the lowest id');
  assert.equal(pool?.equalSplit, true, 'nobody has personal kilometres');
  assert.equal(pool?.totalKm, 50);
  assert.equal(pool?.togetherKm, 50);

  const [nobody] = computeShares([F(1, 1000)], [], [1, 2, 3]);
  assert.equal(nobody?.equalSplit, true);
  assert.equal(nobody?.togetherKm, 0);
  assert.deepEqual(cents(nobody!), [[1, 334], [2, 333], [3, 333]]);

  const [nobodyHome] = computeShares([F(1, 1000)], [D(1, 30, 50), D(7, 20, 50, true)], []);
  assert.deepEqual(cents(nobodyHome!), [[1, 1000]], 'with no payer the personal kilometres still pay');

  const [nobodyAtAll] = computeShares([F(1, 1000)], [D(7, 20, 50, true)], []);
  assert.deepEqual(nobodyAtAll?.shares, [], 'no payer and no personal kilometres: no shares, and no error');
  assert.equal(nobodyAtAll?.equalSplit, true);
});

test('computeShares: a deactivated owner still pays for their own kilometres; the pool goes nowhere on its own; self drives are exactly as before', () => {
  const [calc] = computeShares([F(1, 3000)], [D(4, 30, 100), D(5, 20, 100, true)], [1, 2]);
  assert.deepEqual(cents(calc!), [[4, 3000]], 'user 4 (not a payer) has the only personal kilometres, so pays the whole fill-up');

  const [before] = computeShares([F(1, 6000)], [D(1, 30, 100), D(2, 20, 50), D(3, 10, 50)], [1, 2, 3]);
  assert.deepEqual(cents(before!), [[1, 3000], [2, 1500], [3, 1500]], 'plain 100/50/50 km is unchanged');
  assert.equal(before?.togetherKm, 0);
  assert.equal(before?.equalSplit, false);
});

test('computeShares: periods keep apart, and together kilometres belong to the period they ended in', () => {
  const calcs = computeShares([F(1, 1000, 100), F(2, 1000, 0)], [D(1, 150, 10, true), D(2, 50, 10)], [1, 2]);
  assert.deepEqual(cents(calcs[0]!), [[1, 500], [2, 500]], 'the first period only had the pool');
  assert.deepEqual(cents(calcs[1]!), [[2, 1000]], 'the second only had Ben\'s own');
});

test('property: for 500 seeded random fill-ups the shares add up to the total, to the cent, and follow the personal kilometres', () => {
  let seed = 20260615;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let i = 0; i < 500; i++) {
    const payers = [1, 2, 3, 4, 5].slice(0, rand(6));
    const drives = Array.from({ length: rand(8) }, () => D(1 + rand(6), 10 + rand(50), rand(400), rand(3) === 0));
    const total = 1 + rand(100_000);
    const [calc] = computeShares([F(1, total)], drives, payers);
    const shares = calc!.shares;
    const sum = shares.reduce((n, s) => n + s.cents, 0);
    const label = `case ${i}: ${JSON.stringify({ drives, payers, total })}`;
    // Somebody is always left to pay unless there is nobody at all (no owner of personal kilometres and no payer).
    assert.equal(sum, shares.length === 0 ? 0 : total, label);
    assert.ok(shares.every((s) => s.cents >= 0), `never negative, ${label}`);
    // The pool never moves money: only personal kilometres weigh, so the exact share is total * km / personal kilometres.
    const personal = drives.filter((d) => !d.together).reduce((n, d) => n + d.km, 0);
    if (personal > 0) {
      assert.equal(calc!.equalSplit, false, label);
      assert.deepEqual(
        shares.map((s) => s.userId),
        [...new Set(drives.filter((d) => !d.together && d.km > 0).map((d) => d.userId))].sort((x, y) => x - y),
        `exactly the people with personal kilometres pay, ${label}`,
      );
      shares.forEach((s, j) => assert.ok(Math.abs(s.cents - (total * s.km) / personal) < 1, `share ${j} is within a cent of total * km / personal km, ${label}`));
    } else {
      assert.equal(calc!.equalSplit, true, label);
      assert.deepEqual(shares.map((s) => s.userId), [...payers].sort((x, y) => x - y), `equal split over the payers, ${label}`);
      if (shares.length > 0) {
        const cs = shares.map((x) => x.cents);
        assert.ok(Math.max(...cs) - Math.min(...cs) <= 1, `equal within a cent, ${label}`);
      }
    }
  }
});

test('the fuel split follows the owner: kilometres Anna drove for Ben are Ben\'s share, and together kilometres follow the personal ratio', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    await anna.post('/api/usage', drive(t, -40, -39, { odometerStart: 0, odometerEnd: 100 }));
    await anna.post('/api/usage', drive(t, -38, -37, { odometerStart: 100, odometerEnd: 200, kmFor: 'person', kmUserId: ben.id, note: 'for Ben' }));
    const first = (await carla.post('/api/fuel', { at: at(t.clock, -20), millilitres: 40_000, totalCents: 6000, odometer: FUEL_ODO })).body.fuel;
    const names = (f: Json): Json[] => f.shares.map((s: Json) => [s.userName, s.km, s.cents]);
    assert.deepEqual(names(first), [['Anna', 100, 3000], ['Ben', 100, 3000]], 'Ben pays for what Anna drove for him');
    assert.equal(first.totalKm, 200);
    assert.equal(first.togetherKm, 0);

    // 100 km together, plus Ben's own 100 km: Ben has the only personal kilometres of this period, so he pays all of it,
    // and the admin (who does not pay for fuel) has no share either way.
    await anna.post('/api/usage', drive(t, -18, -17, { odometerStart: 200, odometerEnd: 300, kmFor: 'together', note: 'for all' }));
    await ben.post('/api/usage', drive(t, -16, -15, { odometerStart: 300, odometerEnd: 400 }));
    const second = (await carla.post('/api/fuel', { at: at(t.clock, -10), millilitres: 40_000, totalCents: 8000, odometer: FUEL_ODO })).body.fuel;
    assert.equal(second.totalKm, 200);
    assert.equal(second.togetherKm, 100);
    assert.deepEqual(names(second), [['Ben', 100, 8000]]);
    assert.equal(second.equalSplit, false);
    const list = (await carla.get('/api/fuel')).body;
    assert.equal(list.items[0].togetherKm, 100);
    // Carla fuelled both: Ben owes her 30.00 + 80.00, Anna 30.00.
    assert.deepEqual(list.balances.map((b: Json) => [b.fromName, b.toName, b.cents]), [['Ben', 'Carla', 11000], ['Anna', 'Carla', 3000]]);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------ more on changing a saved drive (test stage)

test('changing a saved drive: handing it to somebody else needs a note, and the note cannot be emptied while it is not the driver\'s own', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    const id = (await anna.post('/api/usage', drive(t, -10, -9))).body.usage.id;
    const url = `/api/usage/${id}`;
    const state = (): Json => ({ ...one<Json>(t.db, 'SELECT km_for, km_user_id, note FROM usage WHERE id = ?', id) });

    // A drive of one's own has no note. Handing it over without one is refused, for the driver and for an admin alike.
    for (const who of [anna, admin]) {
      const together = await who.patch(url, { kmFor: 'together' });
      assert.equal(together.status, 422, together.text);
      assert.equal(together.body.error.fields.note, 'required');
      const person = await who.patch(url, { kmFor: 'person', kmUserId: ben.id, note: '   ' });
      assert.equal(person.status, 422, person.text);
      assert.deepEqual({ ...person.body.error.fields }, { note: 'required' }, 'only the note is wrong; the person is fine');
    }
    assert.deepEqual(state(), { km_for: 'self', km_user_id: null, note: '' }, 'nothing was stored');

    // With a note it works, and from then on the note cannot be emptied (or blanked) by anybody.
    assert.equal((await anna.patch(url, { kmFor: 'together', note: 'Family trip' })).status, 200);
    for (const who of [anna, admin]) {
      for (const note of ['', '   ']) {
        const emptied = await who.patch(url, { note });
        assert.equal(emptied.status, 422, JSON.stringify(note));
        assert.equal(emptied.body.error.fields.note, 'required');
      }
    }
    assert.equal(state().note, 'Family trip');

    // A better note, or another choice that keeps the note, is fine.
    assert.equal((await anna.patch(url, { note: 'Family trip to the coast' })).status, 200);
    assert.equal((await anna.patch(url, { kmFor: 'person', kmUserId: ben.id })).status, 200);
    assert.deepEqual(state(), { km_for: 'person', km_user_id: ben.id, note: 'Family trip to the coast' });

    // An open draft follows the same rule while it stays a draft.
    const draftId = (await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -2), odometerStart: 10_050 })).body.usage.id;
    const asked = await anna.patch(`/api/usage/${draftId}`, { kmFor: 'together' });
    assert.equal(asked.status, 422);
    assert.equal(asked.body.error.fields.note, 'required');
    const noted = await anna.patch(`/api/usage/${draftId}`, { kmFor: 'together', note: 'Shopping for everybody' });
    assert.equal(noted.status, 200, noted.text);
    assert.deepEqual([noted.body.usage.status, noted.body.usage.kmFor], ['draft', 'together']);
    assert.equal((await anna.patch(`/api/usage/${draftId}`, { note: '' })).status, 422, 'and it keeps its note');
  } finally {
    await t.close();
  }
});

// ------------------------------------------ the driver stays the driver (test stage)

test('the driver stays the driver: both readings are still required, and a clash names the driver, whatever the kilometres say', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    // The obligation to register a drive does not depend on whose kilometres they are.
    for (const choice of [{ kmFor: 'together' }, { kmFor: 'person', kmUserId: ben.id }]) {
      const bare = await anna.post('/api/usage', { start: at(t.clock, -10), end: at(t.clock, -9), note: 'why', ...choice });
      assert.equal(bare.status, 422, JSON.stringify(choice));
      assert.deepEqual({ ...bare.body.error.fields }, { odometerStart: 'required', odometerEnd: 'required' });
      const half = await anna.post('/api/usage', { start: at(t.clock, -10), end: at(t.clock, -9), note: 'why', odometerStart: 10_000, ...choice });
      assert.deepEqual({ ...half.body.error.fields }, { odometerEnd: 'required' });
    }
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM usage')?.n, 0);

    // One car, one drive at a time: Anna drove for Ben, so the clash is with Anna, and Ben's own drive does not get around it.
    const made = await anna.post('/api/usage', drive(t, -10, -8, { kmFor: 'person', kmUserId: ben.id, note: 'for Ben' }));
    assert.equal(made.status, 201, made.text);
    for (const [who, over] of [
      [ben, {}],
      [carla, { kmFor: 'together', note: 'for all' }],
      [anna, { kmFor: 'person', kmUserId: carla.id, note: 'for Carla' }],
    ] as const) {
      const clash = await who.post('/api/usage', drive(t, -9, -7, { odometerStart: 10_050, odometerEnd: 10_080, ...over }));
      assert.equal(clash.status, 409, clash.text);
      assert.equal(clash.body.error.code, 'overlap');
      assert.deepEqual([clash.body.error.conflict.id, clash.body.error.conflict.userName], [made.body.usage.id, 'Anna'], 'the driver, not the owner of the kilometres');
    }
    // Back to back is not a clash, for anyone.
    assert.equal((await ben.post('/api/usage', drive(t, -8, -7, { odometerStart: 10_050, odometerEnd: 10_080 }))).status, 201);
  } finally {
    await t.close();
  }
});

test('a drive started for somebody else is the driver\'s to finish: the driver is reminded, the owner of the kilometres is not, and it registers the reservation once it is done', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const res = insertReservation(t, { userId: anna.id, start: at(t.clock, -5), end: at(t.clock, -1) });
    const started = await anna.post('/api/usage', {
      status: 'draft',
      start: at(t.clock, -4.5),
      odometerStart: 10_000,
      reservationId: res,
      kmFor: 'person',
      kmUserId: ben.id,
      note: 'Took Ben to the airport',
    });
    assert.equal(started.status, 201, started.text);
    const url = `/api/usage/${started.body.usage.id}`;

    const card = (await anna.get(`/api/reservations/${res}`)).body.reservation;
    assert.equal(card.kmState, 'draft');
    const annaPending = (await anna.get('/api/usage/pending')).body;
    assert.equal(annaPending.count, 1, 'the driver still has it to finish');
    assert.deepEqual(annaPending.items[0].drafts.map((d: Json) => [d.id, d.kmFor, d.kmUserId]), [[started.body.usage.id, 'person', ben.id]]);
    assert.equal((await ben.get('/api/usage/pending')).body.count, 0, 'the owner of the kilometres has nothing to register');

    // Only the driver (or an admin) finishes it; the kilometres being Ben's does not make it his.
    const finish = { status: 'completed', end: at(t.clock, -2), odometerEnd: 10_060 };
    assert.equal((await ben.patch(url, finish)).status, 403);
    assert.equal(one<Json>(t.db, 'SELECT status FROM usage WHERE id = ?', started.body.usage.id)?.status, 'draft');
    const done = await anna.patch(url, finish);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([done.body.usage.kmFor, done.body.usage.kmUserId, done.body.usage.distanceKm], ['person', ben.id, 60]);

    const after = (await ben.get(`/api/reservations/${res}`)).body.reservation;
    assert.equal(after.kmState, 'registered');
    assert.deepEqual([after.drive.userId, after.drive.kmFor, after.drive.kmUserId], [anna.id, 'person', ben.id]);
    assert.equal((await anna.get('/api/usage/pending')).body.count, 0, 'registered: nobody is reminded');
  } finally {
    await t.close();
  }
});
