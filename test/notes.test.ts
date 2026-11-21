// Notes are recommended on a reservation, a drive (draft or finished) and a fill-up,
// never required: the forms nudge, the API accepts an empty note, and wherever the
// item shows up its note shows up with it. (The nudge itself is in forms.test.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ODO, FUEL_ODO, at, createHousehold, insertReservation, type Client, type Json, type TestApp } from './helpers.ts';

type Kind = 'reservation' | 'drive' | 'fill-up';
const KINDS: Kind[] = ['reservation', 'drive', 'fill-up'];

/**
 * Create one of each kind through the API, a little further apart each time so
 * nothing overlaps. `note: undefined` leaves the field out of the request.
 */
async function create(t: TestApp, who: Client, kind: Kind, slot: number, note: string | undefined): Promise<{ status: number; item: Json; res: Json }> {
  const extra = note === undefined ? {} : { note };
  if (kind === 'reservation') {
    const res = await who.post('/api/reservations', { start: at(t.clock, 24 + slot * 3), end: at(t.clock, 25 + slot * 3), ...extra });
    return { status: res.status, item: res.body.reservation, res };
  }
  if (kind === 'drive') {
    const res = await who.post('/api/usage', { start: at(t.clock, -60 + slot * 3), end: at(t.clock, -59 + slot * 3), ...ODO, ...extra });
    return { status: res.status, item: res.body.usage, res };
  }
  const res = await who.post('/api/fuel', { at: at(t.clock, -30 + slot), millilitres: 40_000, totalCents: 6000, odometer: FUEL_ODO, ...extra });
  return { status: res.status, item: res.body.fuel, res };
}

const pathOf = (kind: Kind, id: number): string => (kind === 'reservation' ? `/api/reservations/${id}` : kind === 'drive' ? `/api/usage/${id}` : `/api/fuel/${id}`);

test('a reservation, a drive and a fill-up can be saved without a note: left out, empty and blank all give an empty note', async () => {
  const { t, anna } = await createHousehold();
  try {
    for (const kind of KINDS) {
      let slot = 0;
      for (const note of [undefined, '', '   ']) {
        const made = await create(t, anna, kind, slot++, note);
        assert.equal(made.status, 201, `${kind} with note ${JSON.stringify(note)}: ${made.res.text}`);
        assert.equal(made.item.note, '', `${kind} with note ${JSON.stringify(note)}`);
      }
    }
  } finally {
    await t.close();
  }
});

test('a drive that has only started (a draft) needs no note either', async () => {
  const { t, ben } = await createHousehold();
  try {
    const res = await ben.post('/api/usage', { status: 'draft', start: at(t.clock, -0.2), odometerStart: 10_000 });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.usage.note, '');
  } finally {
    await t.close();
  }
});

test('a note is trimmed and limited to 500 characters; a longer one is a field error on note', async () => {
  const { t, anna } = await createHousehold();
  try {
    for (const kind of KINDS) {
      const trimmed = await create(t, anna, kind, 0, '  to the market  ');
      assert.equal(trimmed.status, 201);
      assert.equal(trimmed.item.note, 'to the market', kind);

      const longest = await create(t, anna, kind, 1, 'x'.repeat(500));
      assert.equal(longest.status, 201, `${kind}: 500 characters fit`);
      assert.equal(longest.item.note.length, 500);

      const tooLong = await create(t, anna, kind, 2, 'x'.repeat(501));
      assert.equal(tooLong.status, 422, kind);
      assert.deepEqual({ ...tooLong.res.body.error.fields }, { note: 'too_long' }, kind);
    }
  } finally {
    await t.close();
  }
});

test('editing: leaving the note out keeps it, sending an empty one clears it, sending text replaces it', async () => {
  const { t, anna } = await createHousehold();
  try {
    for (const kind of KINDS) {
      const made = await create(t, anna, kind, 0, 'Original');
      assert.equal(made.status, 201, made.res.text);
      const url = pathOf(kind, made.item.id);
      const field = kind === 'reservation' ? 'reservation' : kind === 'drive' ? 'usage' : 'fuel';

      const untouched = await anna.patch(url, {});
      assert.equal(untouched.status, 200, `${kind}: ${untouched.text}`);
      assert.equal(untouched.body[field].note, 'Original', `${kind}: no note in the request keeps the note`);

      const cleared = await anna.patch(url, { note: '' });
      assert.equal(cleared.status, 200, cleared.text);
      assert.equal(cleared.body[field].note, '', `${kind}: an empty note clears it`);

      const replaced = await anna.patch(url, { note: 'Changed' });
      assert.equal(replaced.body[field].note, 'Changed', kind);
    }
  } finally {
    await t.close();
  }
});

test('finishing a draft keeps its note unless a new one is sent', async () => {
  const { t, anna } = await createHousehold();
  try {
    const started = await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -2), odometerStart: 10_000, note: 'Airport run' });
    assert.equal(started.status, 201, started.text);
    const id = started.body.usage.id;
    const finished = await anna.patch(`/api/usage/${id}`, { status: 'completed', end: at(t.clock, -1), odometerEnd: 10_080 });
    assert.equal(finished.status, 200, finished.text);
    assert.equal(finished.body.usage.status, 'completed');
    assert.equal(finished.body.usage.note, 'Airport run');
  } finally {
    await t.close();
  }
});

test('the note shows up everywhere its item does: agenda, detail, inbox, drives, history, pending km and fuel', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    // A confirmed reservation (agenda, detail, history) and a suggestion for Carla (her inbox, Ben's outgoing).
    const booked = (await anna.post('/api/reservations', { start: at(t.clock, 24), end: at(t.clock, 26), note: 'Market trip' })).body.reservation;
    const suggested = (await ben.post('/api/reservations', { start: at(t.clock, 48), end: at(t.clock, 50), userId: carla.id, note: 'Dentist for you' })).body.reservation;
    assert.equal(suggested.status, 'pending');

    const agenda = (await carla.get('/api/reservations')).body.items as Json[];
    assert.equal(agenda.find((r) => r.id === booked.id)?.note, 'Market trip');
    assert.equal((await carla.get(`/api/reservations/${booked.id}`)).body.reservation.note, 'Market trip');
    assert.equal(((await carla.get('/api/inbox')).body.incoming as Json[]).find((r) => r.id === suggested.id)?.note, 'Dentist for you');
    assert.equal(((await ben.get('/api/inbox')).body.outgoing as Json[]).find((r) => r.id === suggested.id)?.note, 'Dentist for you');

    // An ended reservation nobody registered km for (pending km, history) ...
    const past = insertReservation(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -28), note: 'Visit to Oma' });

    // ... a finished drive, an open drive and a fill-up.
    const finished = (await ben.post('/api/usage', { start: at(t.clock, -20), end: at(t.clock, -19), ...ODO, note: 'Airport' })).body.usage;
    const open = (await anna.post('/api/usage', { status: 'draft', start: at(t.clock, -0.5), odometerStart: 10_050, note: 'Still out' })).body.usage;
    const filled = (await carla.post('/api/fuel', { at: at(t.clock, -10), millilitres: 30_000, totalCents: 5000, odometer: FUEL_ODO, note: 'Shell' })).body.fuel;

    const drives = (await ben.get('/api/usage')).body.items as Json[];
    assert.equal(drives.find((u) => u.id === finished.id)?.note, 'Airport');
    assert.equal(drives.find((u) => u.id === open.id)?.note, 'Still out', 'a draft has its note too');

    const history = (await ben.get('/api/history')).body;
    assert.equal((history.usage as Json[]).find((u) => u.id === finished.id)?.note, 'Airport');
    assert.equal((history.reservations as Json[]).find((r) => r.id === booked.id)?.note, 'Market trip');

    const pending = (await anna.get('/api/usage/pending')).body.items[0];
    assert.equal(pending.reservations.find((r: Json) => r.id === past)?.note, 'Visit to Oma');
    assert.equal(pending.drafts.find((d: Json) => d.id === open.id)?.note, 'Still out');

    const fuel = (await ben.get('/api/fuel')).body.items as Json[];
    assert.equal(fuel.find((f) => f.id === filled.id)?.note, 'Shell');
  } finally {
    await t.close();
  }
});
