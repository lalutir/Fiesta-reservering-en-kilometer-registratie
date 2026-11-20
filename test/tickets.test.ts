// Traffic tickets: the API (create, list, correct, delete), who-was-driving matching and its
// boundaries, the fact that the match is derived rather than stored, and who may change what.
// Purge and the retention page are covered in retention.test.ts, the schema in db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { many, one, run } from '../src/db.ts';
import { MAX_AMOUNT_CENTS, REASON_MAX, whoDrove } from '../src/tickets.ts';
import { createHousehold, insertDraft, insertReservation, insertTicket, insertUsage, type Client, type Household, type Json, type TestApp } from './helpers.ts';

const NOW = '2026-06-15T10:00:00.000Z';
const WINDOW_START = '2025-12-15T11:00:00.000Z';
const shift = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
/** A moment on 10 June 2026, which is well in the past of the test clock and well inside the window. */
const D10 = (time: string): string => `2026-06-10T${time}:00.000Z`;
/** A moment on 14 June 2026, the day before the test clock. */
const D14 = (time: string): string => `2026-06-14T${time}:00.000Z`;

async function withHousehold(fn: (h: Household) => Promise<void>): Promise<void> {
  const h = await createHousehold();
  try {
    await fn(h);
  } finally {
    await h.t.close();
  }
}

const ticketCount = (t: TestApp): number => one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM tickets')?.n ?? 0;

/** The matcher on its own: [driver id or null, basis]. */
const who = (t: TestApp, at: string): [number | null, string] => {
  const r = whoDrove(t.db, at);
  return [r.driver?.id ?? null, r.basis];
};

const fieldsOf = (res: { body: Json }): Json => res.body.error.fields;

// ------------------------------------------------------------ create and read

test('a member adds a ticket with only the time of the offence; the optional fields are empty', async () => {
  await withHousehold(async ({ t, anna }) => {
    const res = await anna.post('/api/tickets', { at: D10('08:30') });
    assert.equal(res.status, 201);
    const ticket = res.body.ticket;
    assert.equal(ticket.at, D10('08:30'));
    assert.equal(ticket.amountCents, null);
    assert.equal(ticket.reason, '');
    assert.equal(ticket.createdBy, anna.id);
    assert.equal(ticket.createdByName, 'Anna');
    assert.equal(ticket.createdAt, NOW);
    assert.equal(ticket.updatedAt, NOW);
    assert.equal(ticket.driver, null);
    assert.equal(ticket.basis, 'none');
    assert.deepEqual(ticket.can, { edit: true, delete: true });
    assert.equal(ticketCount(t), 1);
  });
});

test('price and reason are stored, the reason trimmed, and the time is normalised to UTC', async () => {
  await withHousehold(async ({ anna }) => {
    // 10:30 in Amsterdam in June is 08:30 UTC.
    const res = await anna.post('/api/tickets', { at: '2026-06-10T10:30:00+02:00', amountCents: 7_500, reason: '  Speeding on the A4  ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.ticket.at, D10('08:30'));
    assert.equal(res.body.ticket.amountCents, 7_500);
    assert.equal(res.body.ticket.reason, 'Speeding on the A4');
  });
});

test('every route needs a signed-in user', async () => {
  const h = await createHousehold();
  try {
    const anon = h.t.client();
    assert.equal((await anon.get('/api/tickets')).status, 401);
    assert.equal((await anon.post('/api/tickets', { at: D10('08:30') })).status, 401);
    assert.equal((await anon.patch('/api/tickets/1', { reason: 'x' })).status, 401);
    assert.equal((await anon.del('/api/tickets/1')).status, 401);
    assert.equal(ticketCount(h.t), 0);
  } finally {
    await h.t.close();
  }
});

test('any member lists every ticket, newest offence first, with edit and delete rights per viewer', async () => {
  await withHousehold(async ({ t, admin, anna, ben, carla }) => {
    const old = insertTicket(t, { userId: anna.id, at: D10('08:00'), reason: 'old' });
    const mid = insertTicket(t, { userId: ben.id, at: D10('12:00'), amountCents: 5_000 });
    const sameTimeA = insertTicket(t, { userId: anna.id, at: D14('09:00') });
    const sameTimeB = insertTicket(t, { userId: ben.id, at: D14('09:00') });

    const asAnna = await anna.get('/api/tickets');
    assert.equal(asAnna.status, 200);
    assert.deepEqual(asAnna.body.items.map((i: Json) => i.id), [sameTimeB, sameTimeA, mid, old], 'newest first, the later row first on a tie');
    const canOf = (res: { body: Json }): Json => Object.fromEntries(res.body.items.map((i: Json) => [i.id, i.can.edit && i.can.delete]));
    assert.deepEqual(canOf(asAnna), { [old]: true, [mid]: false, [sameTimeA]: true, [sameTimeB]: false });
    assert.deepEqual(canOf(await ben.get('/api/tickets')), { [old]: false, [mid]: true, [sameTimeA]: false, [sameTimeB]: true });
    assert.deepEqual(canOf(await admin.get('/api/tickets')), { [old]: true, [mid]: true, [sameTimeA]: true, [sameTimeB]: true });
    const carlaItems = (await carla.get('/api/tickets')).body.items;
    assert.equal(carlaItems.length, 4, 'a member who entered nothing still sees them all');
    assert.ok(carlaItems.every((i: Json) => i.can.edit === false && i.can.delete === false));
    assert.equal(carlaItems.find((i: Json) => i.id === mid).createdByName, 'Ben');
    assert.equal(carlaItems.find((i: Json) => i.id === mid).amountCents, 5_000);
  });
});

test('an empty list is an empty array', async () => {
  await withHousehold(async ({ anna }) => {
    const res = await anna.get('/api/tickets');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [] });
  });
});

test('an admin enters a ticket like any member, and the other members cannot change or delete it', async () => {
  await withHousehold(async ({ t, admin, anna }) => {
    const res = await admin.post('/api/tickets', { at: D10('08:30'), amountCents: 2_500, reason: 'Parked on a bend' });
    assert.equal(res.status, 201);
    const ticket = res.body.ticket;
    assert.equal(ticket.createdBy, admin.id);
    assert.deepEqual(ticket.can, { edit: true, delete: true });

    const seenByAnna = (await anna.get('/api/tickets')).body.items;
    assert.equal(seenByAnna.length, 1, 'every member sees it');
    assert.equal(seenByAnna[0].id, ticket.id);
    assert.deepEqual(seenByAnna[0].can, { edit: false, delete: false });
    assert.equal((await anna.patch(`/api/tickets/${ticket.id}`, { reason: 'x' })).status, 403);
    assert.equal((await anna.del(`/api/tickets/${ticket.id}`)).status, 403);
    assert.deepEqual(
      { ...one<Json>(t.db, 'SELECT amount_cents, reason FROM tickets WHERE id = ?', ticket.id) },
      { amount_cents: 2_500, reason: 'Parked on a bend' },
      'untouched after the two refusals',
    );
  });
});

// ----------------------------------------------------------------- validation

test('the time of the offence: required, a real instant with a zone, not in the future, inside the six-month window', async () => {
  await withHousehold(async ({ t, anna }) => {
    const post = (body: Json) => anna.post('/api/tickets', body);
    const missing = await post({});
    assert.equal(missing.status, 422);
    assert.equal(fieldsOf(missing).at, 'required');
    for (const bad of ['yesterday', '2026-06-10T08:30', '2026-02-30T08:00:00Z', '2026-06-10 08:30:00Z', 12345, null]) {
      const res = await post({ at: bad });
      assert.equal(res.status, 422, JSON.stringify(bad));
      assert.equal(fieldsOf(res).at, 'invalid_datetime', JSON.stringify(bad));
    }

    // Five minutes ahead is clock slack, one millisecond more is the future.
    assert.equal((await post({ at: shift(NOW, 5 * MIN) })).status, 201);
    const future = await post({ at: shift(NOW, 5 * MIN + 1) });
    assert.equal(future.status, 422);
    assert.equal(fieldsOf(future).at, 'in_future');
    assert.equal(future.body.error.code, 'validation_failed');

    // The window starts six calendar months back in the household zone; both ends are inclusive.
    assert.equal((await post({ at: WINDOW_START })).status, 201);
    const old = await post({ at: shift(WINDOW_START, -1) });
    assert.equal(old.status, 422);
    assert.equal(fieldsOf(old).at, 'outside_window');
    assert.equal(old.body.error.code, 'outside_window');

    assert.equal(ticketCount(t), 2, 'only the two accepted ones were written');
  });
});

test('the price: a whole number of cents from 1 to 10,000.00, or none', async () => {
  await withHousehold(async ({ t, anna }) => {
    const post = (amountCents: unknown) => anna.post('/api/tickets', { at: D10('08:30'), amountCents });
    for (const [value, code] of [
      [0, 'too_small'],
      [-1, 'too_small'],
      [1.5, 'must_be_integer'],
      ['5', 'must_be_integer'],
      [true, 'must_be_integer'],
      [MAX_AMOUNT_CENTS + 1, 'too_large'],
    ] as const) {
      const res = await post(value);
      assert.equal(res.status, 422, JSON.stringify(value));
      assert.equal(fieldsOf(res).amountCents, code, JSON.stringify(value));
    }
    assert.equal(MAX_AMOUNT_CENTS, 1_000_000);
    assert.equal((await post(1)).body.ticket.amountCents, 1);
    assert.equal((await post(MAX_AMOUNT_CENTS)).body.ticket.amountCents, 1_000_000);
    assert.equal((await post(null)).body.ticket.amountCents, null);
    assert.equal(ticketCount(t), 3);
  });
});

test('the reason: at most 500 characters, a string, and blank means none', async () => {
  await withHousehold(async ({ t, anna }) => {
    const post = (reason: unknown) => anna.post('/api/tickets', { at: D10('08:30'), reason });
    assert.equal(REASON_MAX, 500);
    assert.equal((await post('x'.repeat(500))).status, 201);
    const long = await post('x'.repeat(501));
    assert.equal(long.status, 422);
    assert.equal(fieldsOf(long).reason, 'too_long');
    const number = await post(5);
    assert.equal(number.status, 422);
    assert.equal(fieldsOf(number).reason, 'must_be_string');
    const blank = await post('   ');
    assert.equal(blank.status, 201);
    assert.equal(blank.body.ticket.reason, '', 'whitespace only is stored as empty');
    assert.equal(ticketCount(t), 2);
  });
});

test('every bad field is reported at once and nothing is written', async () => {
  await withHousehold(async ({ t, anna }) => {
    const res = await anna.post('/api/tickets', { amountCents: 0, reason: 5 });
    assert.equal(res.status, 422);
    assert.deepEqual({ ...fieldsOf(res) }, { at: 'required', amountCents: 'too_small', reason: 'must_be_string' });
    assert.equal(ticketCount(t), 0);
  });
});

// ------------------------------------------------------------------- matching

test('a completed drive that covers the moment names its driver, start and end included', async () => {
  await withHousehold(async ({ t, anna }) => {
    insertUsage(t, { userId: anna.id, start: D10('08:00'), end: D10('10:00') });
    assert.deepEqual(who(t, D10('08:00')), [anna.id, 'drive'], 'at the start');
    assert.deepEqual(who(t, D10('09:00')), [anna.id, 'drive']);
    assert.deepEqual(who(t, D10('10:00')), [anna.id, 'drive'], 'at the end');
    assert.deepEqual(who(t, shift(D10('08:00'), -1)), [null, 'none'], '1 ms before');
    assert.deepEqual(who(t, shift(D10('10:00'), 1)), [null, 'none'], '1 ms after');
  });
});

test('the drive log answers without odometer readings, and whoever the kilometres belong to', async () => {
  await withHousehold(async ({ t, anna, ben, carla }) => {
    // Anna drove Ben to the hospital: the kilometres are Ben's, the driver is still Anna.
    const forBen = insertUsage(t, { userId: anna.id, start: D10('08:00'), end: D10('09:00'), odometerStart: 100, odometerEnd: 140 });
    run(t.db, "UPDATE usage SET km_for = 'person', km_user_id = ?, note = 'hospital' WHERE id = ?", ben.id, forBen);
    const together = insertUsage(t, { userId: carla.id, start: D10('11:00'), end: D10('12:00'), odometerStart: 140, odometerEnd: 160 });
    run(t.db, "UPDATE usage SET km_for = 'together', note = 'groceries' WHERE id = ?", together);
    insertUsage(t, { userId: ben.id, start: D10('14:00'), end: D10('15:00') }); // no readings at all
    assert.deepEqual(who(t, D10('08:30')), [anna.id, 'drive'], 'the driver, not the km owner');
    assert.deepEqual(who(t, D10('11:30')), [carla.id, 'drive'], 'together kilometres still have a driver');
    assert.deepEqual(who(t, D10('14:30')), [ben.id, 'drive'], 'a legacy drive without readings');
  });
});

test('the drive log beats a reservation of someone else, the reservation answers where there is no drive', async () => {
  await withHousehold(async ({ t, anna, ben }) => {
    insertReservation(t, { userId: ben.id, start: D10('07:00'), end: D10('13:00') });
    insertUsage(t, { userId: anna.id, start: D10('08:00'), end: D10('09:00') });
    assert.deepEqual(who(t, D10('08:30')), [anna.id, 'drive'], 'Anna actually drove inside Ben\'s reservation');
    assert.deepEqual(who(t, D10('10:00')), [ben.id, 'reservation'], 'nobody logged a drive, so the holder');
    assert.deepEqual(who(t, D10('07:00')), [ben.id, 'reservation'], 'reservation start included');
    assert.deepEqual(who(t, D10('13:00')), [ben.id, 'reservation'], 'reservation end included');
    assert.deepEqual(who(t, shift(D10('13:00'), 1)), [null, 'none']);
  });
});

test('only confirmed reservations match: an approved suggestion names the person it was for, pending, expired and declined ones never do', async () => {
  await withHousehold(async ({ t, anna, ben, carla }) => {
    // Anna suggested the slot to Ben and he approved: the reservation is Ben's.
    insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'confirmed', start: D10('08:00'), end: D10('09:00') });
    insertReservation(t, { userId: carla.id, createdBy: anna.id, status: 'pending', start: D10('10:00'), end: D10('11:00') });
    insertReservation(t, { userId: carla.id, createdBy: anna.id, status: 'declined', start: D10('12:00'), end: D10('13:00') });
    // A suggestion for the future, and one whose time has passed without an answer.
    insertReservation(t, { userId: carla.id, createdBy: anna.id, status: 'pending', start: shift(NOW, 2 * HOUR), end: shift(NOW, 3 * HOUR) });
    assert.deepEqual(who(t, D10('08:30')), [ben.id, 'reservation']);
    assert.deepEqual(who(t, D10('10:30')), [null, 'none'], 'pending (expired)');
    assert.deepEqual(who(t, D10('12:30')), [null, 'none'], 'declined');
    assert.deepEqual(who(t, shift(NOW, 2.5 * HOUR)), [null, 'none'], 'pending (future)');
  });
});

test('a deactivated driver is still named', async () => {
  await withHousehold(async ({ t, anna }) => {
    insertUsage(t, { userId: anna.id, start: D10('08:00'), end: D10('09:00') });
    run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', anna.id);
    assert.deepEqual(who(t, D10('08:30')), [anna.id, 'drive']);
    assert.equal(whoDrove(t.db, D10('08:30')).driver?.name, 'Anna');
  });
});

test('back-to-back records share a boundary instant and the one that started later wins', async () => {
  await withHousehold(async ({ t, anna, ben, carla }) => {
    insertUsage(t, { userId: anna.id, start: D10('08:00'), end: D10('10:00') });
    insertUsage(t, { userId: ben.id, start: D10('10:00'), end: D10('12:00') });
    assert.deepEqual(who(t, D10('10:00')), [ben.id, 'drive'], 'drives');
    assert.deepEqual(who(t, shift(D10('10:00'), -1)), [anna.id, 'drive']);

    insertReservation(t, { userId: anna.id, start: D14('08:00'), end: D14('10:00') });
    insertReservation(t, { userId: carla.id, start: D14('10:00'), end: D14('12:00') });
    assert.deepEqual(who(t, D14('10:00')), [carla.id, 'reservation'], 'reservations');

    // Same start: the higher id (the one entered later) wins, so the answer never depends on row order.
    insertUsage(t, { userId: anna.id, start: D14('16:00'), end: D14('17:00') });
    insertUsage(t, { userId: carla.id, start: D14('16:00'), end: D14('17:00') });
    assert.deepEqual(who(t, D14('16:30')), [carla.id, 'drive']);
  });
});

test('an open draft answers from its start for up to 24 hours', async () => {
  await withHousehold(async ({ t, ben }) => {
    insertDraft(t, { userId: ben.id, start: D14('09:00') });
    assert.deepEqual(who(t, D14('09:00')), [ben.id, 'draft'], 'at its start');
    assert.deepEqual(who(t, D14('20:00')), [ben.id, 'draft']);
    assert.deepEqual(who(t, shift(D14('09:00'), 24 * HOUR)), [ben.id, 'draft'], 'exactly 24 hours later');
    assert.deepEqual(who(t, shift(D14('09:00'), 24 * HOUR + 1)), [null, 'none'], '24 hours and 1 ms later');
    assert.deepEqual(who(t, shift(D14('09:00'), -1)), [null, 'none'], 'a draft that starts after the moment does not match');
  });
});

test('a draft that begins after the ticket time never matches it, whatever else is on record', async () => {
  await withHousehold(async ({ t, carla }) => {
    insertDraft(t, { userId: carla.id, start: D14('11:00') });
    assert.deepEqual(who(t, D14('10:00')), [null, 'none']);
    assert.deepEqual(who(t, D14('10:59')), [null, 'none']);
    assert.deepEqual(who(t, D14('11:00')), [carla.id, 'draft']);
  });
});

test('a completed drive that started after the draft replaces it, a drive that covers the moment beats it', async () => {
  await withHousehold(async ({ t, anna, ben }) => {
    insertDraft(t, { userId: ben.id, start: D14('09:00') });
    insertUsage(t, { userId: anna.id, start: D14('12:00'), end: D14('13:00') });
    assert.deepEqual(who(t, D14('10:00')), [ben.id, 'draft'], 'before the later drive started, the draft is the latest record');
    assert.deepEqual(who(t, D14('12:30')), [anna.id, 'drive'], 'a covering drive beats the draft');
    assert.deepEqual(who(t, D14('15:00')), [null, 'none'], 'after the later drive ended, the draft is superseded');
    assert.deepEqual(who(t, D14('12:00')), [anna.id, 'drive']);
  });
});

test('a draft beats someone else\'s reservation, and of two drafts the one that started later wins', async () => {
  await withHousehold(async ({ t, anna, ben, carla }) => {
    insertReservation(t, { userId: anna.id, start: D14('08:00'), end: D14('20:00') });
    insertDraft(t, { userId: ben.id, start: D14('09:00') });
    assert.deepEqual(who(t, D14('10:00')), [ben.id, 'draft'], 'the draft is more recent than the plan');
    insertDraft(t, { userId: carla.id, start: D14('11:00') });
    assert.deepEqual(who(t, D14('12:00')), [carla.id, 'draft'], 'the later-starting draft');
    assert.deepEqual(who(t, D14('10:00')), [ben.id, 'draft'], 'before Carla started, Ben\'s is the only one');
  });
});

test('after 24 hours a forgotten draft stops answering and a reservation that still covers the moment takes over', async () => {
  await withHousehold(async ({ t, admin, anna }) => {
    insertReservation(t, { userId: anna.id, start: D10('08:00'), end: shift(D10('08:00'), 72 * HOUR) });
    insertDraft(t, { userId: admin.id, start: D10('09:00') });
    assert.deepEqual(who(t, shift(D10('09:00'), 24 * HOUR)), [admin.id, 'draft']);
    assert.deepEqual(who(t, shift(D10('09:00'), 24 * HOUR + 1)), [anna.id, 'reservation']);
    assert.deepEqual(who(t, D10('08:30')), [anna.id, 'reservation'], 'before the draft started');
  });
});

test('the match is shown on the ticket over the API', async () => {
  await withHousehold(async ({ t, anna, ben }) => {
    insertUsage(t, { userId: ben.id, start: D10('08:00'), end: D10('10:00') });
    const res = await anna.post('/api/tickets', { at: D10('09:00'), amountCents: 6_000, reason: 'Red light' });
    assert.equal(res.status, 201);
    assert.deepEqual({ ...res.body.ticket.driver }, { id: ben.id, name: 'Ben' });
    assert.equal(res.body.ticket.basis, 'drive');
    const list = (await anna.get('/api/tickets')).body.items;
    assert.deepEqual({ ...list[0].driver }, { id: ben.id, name: 'Ben' });
    assert.equal(list[0].createdByName, 'Anna', 'who entered it is not who drove');
    assert.equal(ticketCount(t), 1);
  });
});

// ------------------------------------------------------------------- derived

test('the match follows the drive log and the reservations: nothing about the driver is stored', async () => {
  await withHousehold(async ({ t, anna, ben, carla }) => {
    const created = await anna.post('/api/tickets', { at: D10('09:00') });
    const id: number = created.body.ticket.id;
    const read = async (): Promise<[number | null, string]> => {
      const item = (await anna.get('/api/tickets')).body.items.find((i: Json) => i.id === id);
      return [item.driver?.id ?? null, item.basis];
    };
    assert.deepEqual(await read(), [null, 'none']);

    const reservation = insertReservation(t, { userId: ben.id, start: D10('08:00'), end: D10('12:00') });
    assert.deepEqual(await read(), [ben.id, 'reservation'], 'a reservation added later');

    const drive = insertUsage(t, { userId: anna.id, start: D10('08:30'), end: D10('09:30') });
    assert.deepEqual(await read(), [anna.id, 'drive'], 'a drive added later');

    run(t.db, 'UPDATE usage SET user_id = ? WHERE id = ?', carla.id, drive);
    assert.deepEqual(await read(), [carla.id, 'drive'], 'the drive is corrected to another driver');

    run(t.db, 'UPDATE usage SET end_utc = ? WHERE id = ?', D10('08:45'), drive);
    assert.deepEqual(await read(), [ben.id, 'reservation'], 'the drive is shortened so it no longer covers the moment');

    run(t.db, 'UPDATE usage SET end_utc = ? WHERE id = ?', D10('09:30'), drive);
    run(t.db, 'DELETE FROM usage WHERE id = ?', drive);
    assert.deepEqual(await read(), [ben.id, 'reservation'], 'the drive is deleted');

    run(t.db, 'DELETE FROM reservations WHERE id = ?', reservation);
    assert.deepEqual(await read(), [null, 'none'], 'the reservation is deleted');

    const columns = many<{ name: string }>(t.db, 'PRAGMA table_info(tickets)').map((c) => c.name);
    assert.ok(!columns.some((c) => /driver|user_id/.test(c)), `no driver column, found ${columns.join(', ')}`);
  });
});

test('changing the time of a ticket re-evaluates who was driving', async () => {
  await withHousehold(async ({ t, anna, ben }) => {
    insertUsage(t, { userId: ben.id, start: D10('08:00'), end: D10('09:00') });
    const created = await anna.post('/api/tickets', { at: D10('12:00') });
    const id: number = created.body.ticket.id;
    assert.equal(created.body.ticket.basis, 'none');
    const moved = await anna.patch(`/api/tickets/${id}`, { at: D10('08:30') });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.ticket.at, D10('08:30'));
    assert.deepEqual({ ...moved.body.ticket.driver }, { id: ben.id, name: 'Ben' });
    assert.equal(moved.body.ticket.basis, 'drive');
    const back = await anna.patch(`/api/tickets/${id}`, { at: D10('12:00') });
    assert.equal(back.body.ticket.driver, null);
    assert.equal(back.body.ticket.basis, 'none');
  });
});

// ------------------------------------------------------- authorization, update

test('the person who entered a ticket and an admin may correct it, nobody else', async () => {
  await withHousehold(async ({ t, admin, anna, ben }) => {
    const id = insertTicket(t, { userId: anna.id, at: D10('08:30'), amountCents: 5_000, reason: 'original' });
    const row = (): Json => ({ ...one(t.db, 'SELECT at_utc, amount_cents, reason, updated_at FROM tickets WHERE id = ?', id) });
    const before = row();
    const patch = (who: Client) => who.patch(`/api/tickets/${id}`, { amountCents: 9_900, reason: 'changed' });

    const other = await patch(ben);
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'forbidden');
    assert.deepEqual(row(), before, 'the row is untouched after a 403');

    const anon = await t.client().patch(`/api/tickets/${id}`, { reason: 'x' });
    assert.equal(anon.status, 401);
    assert.deepEqual(row(), before);

    t.clock.advance(HOUR);
    const own = await patch(anna);
    assert.equal(own.status, 200);
    assert.equal(own.body.ticket.amountCents, 9_900);
    assert.equal(own.body.ticket.reason, 'changed');
    assert.notEqual(own.body.ticket.updatedAt, own.body.ticket.createdAt, 'updatedAt moves');

    const byAdmin = await admin.patch(`/api/tickets/${id}`, { reason: 'admin fixed it' });
    assert.equal(byAdmin.status, 200);
    assert.equal(byAdmin.body.ticket.reason, 'admin fixed it');
    assert.equal(byAdmin.body.ticket.createdBy, anna.id, 'the creator stays the creator');
    assert.deepEqual(byAdmin.body.ticket.can, { edit: true, delete: true });
  });
});

test('the person who entered a ticket and an admin may delete it, nobody else', async () => {
  await withHousehold(async ({ t, admin, anna, ben }) => {
    const mine = insertTicket(t, { userId: anna.id, at: D10('08:30') });
    const other = await ben.del(`/api/tickets/${mine}`);
    assert.equal(other.status, 403);
    assert.equal(ticketCount(t), 1, 'still there after a 403');
    assert.equal((await t.client().del(`/api/tickets/${mine}`)).status, 401);
    assert.equal(ticketCount(t), 1);

    const own = await anna.del(`/api/tickets/${mine}`);
    assert.equal(own.status, 204);
    assert.equal(own.text, '');
    assert.equal(ticketCount(t), 0);
    assert.equal((await anna.del(`/api/tickets/${mine}`)).status, 404, 'gone');

    const second = insertTicket(t, { userId: ben.id, at: D10('09:30') });
    assert.equal((await admin.del(`/api/tickets/${second}`)).status, 204);
    assert.equal(ticketCount(t), 0);
  });
});

test('someone else\'s ticket is a 403 before a bad body is a 422', async () => {
  await withHousehold(async ({ t, anna, ben }) => {
    const id = insertTicket(t, { userId: anna.id, at: D10('08:30'), amountCents: 5_000 });
    const bad = await ben.patch(`/api/tickets/${id}`, { amountCents: 0, at: 'nonsense', reason: 5 });
    assert.equal(bad.status, 403);
    const mine = await anna.patch(`/api/tickets/${id}`, { amountCents: 0, at: 'nonsense', reason: 5 });
    assert.equal(mine.status, 422);
    assert.deepEqual({ ...fieldsOf(mine) }, { at: 'invalid_datetime', amountCents: 'too_small', reason: 'must_be_string' });
    assert.equal(one<{ amount_cents: number }>(t.db, 'SELECT amount_cents FROM tickets WHERE id = ?', id)?.amount_cents, 5_000);
  });
});

test('unknown and malformed ids are a 404, also for an admin', async () => {
  await withHousehold(async ({ admin, anna }) => {
    for (const who of [anna, admin]) {
      for (const id of ['9999', 'abc', '0', '-1', '1.5']) {
        assert.equal((await who.patch(`/api/tickets/${id}`, { reason: 'x' })).status, 404, `PATCH ${id}`);
        assert.equal((await who.del(`/api/tickets/${id}`)).status, 404, `DELETE ${id}`);
      }
    }
  });
});

test('null clears the price, an empty string clears the reason, and what is left out stays', async () => {
  await withHousehold(async ({ t, anna }) => {
    const id = insertTicket(t, { userId: anna.id, at: D10('08:30'), amountCents: 5_000, reason: 'Speeding' });
    const patch = async (body: Json): Promise<Json> => {
      const res = await anna.patch(`/api/tickets/${id}`, body);
      assert.equal(res.status, 200, JSON.stringify(body));
      return res.body.ticket;
    };
    let ticket = await patch({});
    assert.deepEqual([ticket.at, ticket.amountCents, ticket.reason], [D10('08:30'), 5_000, 'Speeding'], 'an empty body changes nothing');
    ticket = await patch({ amountCents: null });
    assert.deepEqual([ticket.amountCents, ticket.reason], [null, 'Speeding'], 'null clears only the price');
    ticket = await patch({ amountCents: 1_200 });
    assert.deepEqual([ticket.amountCents, ticket.reason], [1_200, 'Speeding'], 'a price can be added again');
    ticket = await patch({ reason: '' });
    assert.deepEqual([ticket.amountCents, ticket.reason], [1_200, ''], '"" clears only the reason');
    ticket = await patch({ reason: '  Parked wrong  ', amountCents: 7_000 });
    assert.deepEqual([ticket.amountCents, ticket.reason], [7_000, 'Parked wrong']);
    const bad = await anna.patch(`/api/tickets/${id}`, { amountCents: 1_000_001 });
    assert.equal(bad.status, 422);
    assert.equal(fieldsOf(bad).amountCents, 'too_large');
  });
});

test('the time is only checked against the window when it changes: an old ticket can still get its price or reason corrected', async () => {
  await withHousehold(async ({ t, anna }) => {
    // Inserted directly: the API would not accept a time past the edge of the window.
    const id = insertTicket(t, { userId: anna.id, at: shift(WINDOW_START, -HOUR), reason: 'aged' });
    const reasonOnly = await anna.patch(`/api/tickets/${id}`, { reason: 'corrected' });
    assert.equal(reasonOnly.status, 200);
    assert.equal(reasonOnly.body.ticket.reason, 'corrected');
    const sameTime = await anna.patch(`/api/tickets/${id}`, { at: shift(WINDOW_START, -HOUR), amountCents: 4_000 });
    assert.equal(sameTime.status, 200, 'sending the stored time back is not a change');
    const moved = await anna.patch(`/api/tickets/${id}`, { at: shift(WINDOW_START, -2 * HOUR) });
    assert.equal(moved.status, 422);
    assert.equal(fieldsOf(moved).at, 'outside_window');
    assert.equal(moved.body.error.code, 'outside_window');
    const future = await anna.patch(`/api/tickets/${id}`, { at: shift(NOW, 6 * MIN) });
    assert.equal(fieldsOf(future).at, 'in_future');
    const inside = await anna.patch(`/api/tickets/${id}`, { at: D10('08:00') });
    assert.equal(inside.status, 200);
    assert.equal(inside.body.ticket.at, D10('08:00'));
  });
});

// ---------------------------------------------------------------------- audit

test('the log records who did what and on what basis, never the price or the reason', async () => {
  await withHousehold(async ({ t, anna, ben }) => {
    insertUsage(t, { userId: ben.id, start: D10('08:00'), end: D10('09:00') });
    t.logs.length = 0;
    const created = await anna.post('/api/tickets', { at: D10('08:30'), amountCents: 12_345, reason: 'secret reason' });
    const id: number = created.body.ticket.id;
    await anna.patch(`/api/tickets/${id}`, { amountCents: 54_321, reason: 'another secret' });
    await anna.del(`/api/tickets/${id}`);
    const lines = t.logs.filter((l) => String(l['event']).startsWith('ticket.'));
    assert.deepEqual(
      lines.map((l) => ({ ...l })),
      [
        { event: 'ticket.created', id, by: anna.id, basis: 'drive' },
        { event: 'ticket.updated', id, by: anna.id, basis: 'drive' },
        { event: 'ticket.deleted', id, by: anna.id, basis: 'drive' },
      ],
    );
    const text = JSON.stringify(t.logs);
    for (const secret of ['secret reason', 'another secret', '12345', '54321']) assert.ok(!text.includes(secret), `${secret} is not logged`);
  });
});

// ------------------------------------------------ test stage: more of the stated rules
// The sections above pin each rule on its own. These check what the rules promise together: the
// answer on every tier through the list, a draft that has been superseded, the real routes (not raw
// SQL) changing the match, nothing that can set the driver by hand, and the matcher against a plain
// model of the written rule.

test('the list names the basis of every tier: drive log, open draft, reservation and nobody on record', async () => {
  await withHousehold(async ({ t, admin, anna, ben, carla }) => {
    insertUsage(t, { userId: anna.id, start: D10('08:00'), end: D10('09:00') });
    insertDraft(t, { userId: ben.id, start: D14('09:00') });
    insertReservation(t, { userId: carla.id, start: D10('12:00'), end: D10('13:00') });
    const drive = insertTicket(t, { userId: admin.id, at: D10('08:30') });
    const reservation = insertTicket(t, { userId: admin.id, at: D10('12:30') });
    const draft = insertTicket(t, { userId: admin.id, at: D14('10:00') });
    const none = insertTicket(t, { userId: admin.id, at: D10('20:00') });

    const items: Json[] = (await carla.get('/api/tickets')).body.items;
    const answer = (id: number): [number | null, string] => {
      const item = items.find((i) => i.id === id) as Json;
      return [item.driver?.id ?? null, item.basis];
    };
    assert.deepEqual(answer(drive), [anna.id, 'drive']);
    assert.deepEqual(answer(draft), [ben.id, 'draft']);
    assert.deepEqual(answer(reservation), [carla.id, 'reservation']);
    assert.deepEqual(answer(none), [null, 'none']);
    assert.equal(items.find((i) => i.id === none)?.driver, null, 'no driver is null, not an empty object');
  });
});

test('a draft that a later completed drive has superseded hands over to the reservation; a drive that ended before the draft began does not supersede it', async () => {
  await withHousehold(async ({ t, anna, ben, carla }) => {
    insertReservation(t, { userId: anna.id, start: D14('06:00'), end: D14('20:00') });
    insertUsage(t, { userId: carla.id, start: D14('07:00'), end: D14('08:00') }); // finished before the draft began
    insertDraft(t, { userId: ben.id, start: D14('09:00') });
    assert.deepEqual(who(t, D14('10:00')), [ben.id, 'draft'], 'an earlier drive is no later record of the car');
    assert.deepEqual(who(t, D14('07:30')), [carla.id, 'drive']);
    assert.deepEqual(who(t, D14('08:30')), [anna.id, 'reservation'], 'before the draft began');

    insertUsage(t, { userId: carla.id, start: D14('11:00'), end: D14('11:30') }); // started after the draft
    assert.deepEqual(who(t, D14('10:59')), [ben.id, 'draft'], 'one minute before the later drive');
    assert.deepEqual(who(t, D14('11:15')), [carla.id, 'drive']);
    assert.deepEqual(who(t, D14('12:00')), [anna.id, 'reservation'], 'the draft is superseded, so the reservation answers');
  });
});

test('the match follows the real routes: a reservation, a logged drive, a draft that is finished, and their removal, each change it on the next read', async () => {
  await withHousehold(async ({ anna, ben }) => {
    const ticketId: number = (await anna.post('/api/tickets', { at: D14('09:30') })).body.ticket.id;
    const read = async (): Promise<[number | null, string]> => {
      const item = (await anna.get('/api/tickets')).body.items.find((i: Json) => i.id === ticketId);
      return [item.driver?.id ?? null, item.basis];
    };
    assert.deepEqual(await read(), [null, 'none']);

    const reservation = await ben.post('/api/reservations', { start: D14('08:00'), end: D14('12:00') });
    assert.equal(reservation.status, 201);
    assert.deepEqual(await read(), [ben.id, 'reservation'], 'a reservation made through the API');

    const logged = await anna.post('/api/usage', { start: D14('09:00'), end: D14('10:00'), odometerStart: 1_000, odometerEnd: 1_020 });
    assert.equal(logged.status, 201, JSON.stringify(logged.body));
    const driveUrl = `/api/usage/${logged.body.usage.id}`;
    assert.deepEqual(await read(), [anna.id, 'drive'], 'a drive logged through the API beats the reservation');

    assert.equal((await anna.patch(driveUrl, { end: D14('09:15'), odometerEnd: 1_010 })).status, 200);
    assert.deepEqual(await read(), [ben.id, 'reservation'], 'the drive is corrected to end before the moment');
    assert.equal((await anna.del(driveUrl)).status, 204);

    const draft = await anna.post('/api/usage', { status: 'draft', start: D14('09:00'), odometerStart: 1_000 });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const draftUrl = `/api/usage/${draft.body.usage.id}`;
    assert.deepEqual(await read(), [anna.id, 'draft'], 'a drive that was started and not finished');

    const finishedShort = await anna.patch(draftUrl, { status: 'completed', end: D14('09:20'), odometerEnd: 1_010 });
    assert.equal(finishedShort.status, 200, JSON.stringify(finishedShort.body));
    assert.deepEqual(await read(), [ben.id, 'reservation'], 'finished before the moment: no longer a draft, and it does not cover it');
    assert.equal((await anna.patch(draftUrl, { end: D14('10:00'), odometerEnd: 1_030 })).status, 200);
    assert.deepEqual(await read(), [anna.id, 'drive'], 'the finished drive is stretched over the moment');

    assert.equal((await ben.del(`/api/reservations/${reservation.body.reservation.id}`)).status, 204);
    assert.deepEqual(await read(), [anna.id, 'drive'], 'cancelling the reservation leaves the drive log');
    assert.equal((await anna.del(draftUrl)).status, 204);
    assert.deepEqual(await read(), [null, 'none'], 'nothing on record any more');
  });
});

test('a suggestion for someone else matches only after that person approves it; pending and declined ones stay unknown', async () => {
  await withHousehold(async ({ anna, ben, carla }) => {
    // A suggestion must start in the future and a ticket may be up to five minutes ahead of the clock,
    // so a ticket three minutes from now lies inside a suggestion that starts one minute from now.
    const slot = { start: shift(NOW, MIN), end: shift(NOW, HOUR) };
    const ticketId: number = (await anna.post('/api/tickets', { at: shift(NOW, 3 * MIN) })).body.ticket.id;
    const read = async (): Promise<[number | null, string]> => {
      const item = (await anna.get('/api/tickets')).body.items.find((i: Json) => i.id === ticketId);
      return [item.driver?.id ?? null, item.basis];
    };

    const first = await anna.post('/api/reservations', { userId: ben.id, ...slot });
    assert.equal(first.status, 201);
    assert.equal(first.body.reservation.status, 'pending');
    assert.deepEqual(await read(), [null, 'none'], 'pending: nobody agreed to it yet');
    assert.equal((await ben.post(`/api/reservations/${first.body.reservation.id}/decline`, {})).status, 200);
    assert.deepEqual(await read(), [null, 'none'], 'declined');

    const second = await anna.post('/api/reservations', { userId: carla.id, ...slot });
    assert.equal(second.status, 201);
    assert.deepEqual(await read(), [null, 'none'], 'the new suggestion is pending again');
    const approved = await carla.post(`/api/reservations/${second.body.reservation.id}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(await read(), [carla.id, 'reservation'], 'approved: the person it was for, not the one who suggested it');
  });
});

test('nothing can set the driver by hand: such fields in the body are ignored on create and on edit, even from an admin', async () => {
  await withHousehold(async ({ t, admin, anna, ben }) => {
    const sneaky = {
      driverId: ben.id,
      driver: { id: ben.id, name: 'Ben' },
      basis: 'drive',
      createdBy: ben.id,
      createdByName: 'Ben',
      createdAt: '2020-01-01T00:00:00.000Z',
      id: 4_242,
      can: { edit: false, delete: false },
    };
    const created = await anna.post('/api/tickets', { at: D10('08:30'), reason: 'mine', ...sneaky });
    assert.equal(created.status, 201);
    const ticket = created.body.ticket;
    assert.notEqual(ticket.id, 4_242);
    assert.equal(ticket.createdBy, anna.id);
    assert.equal(ticket.createdByName, 'Anna');
    assert.equal(ticket.createdAt, NOW);
    assert.equal(ticket.driver, null, 'with no drive or reservation on record there is no driver, whatever the body says');
    assert.equal(ticket.basis, 'none');
    assert.deepEqual(ticket.can, { edit: true, delete: true });

    const edited = await admin.patch(`/api/tickets/${ticket.id}`, { reason: 'fixed', ...sneaky });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.ticket.reason, 'fixed');
    assert.equal(edited.body.ticket.createdBy, anna.id, 'the creator cannot be reassigned');
    assert.equal(edited.body.ticket.createdAt, NOW);
    assert.equal(edited.body.ticket.driver, null);
    assert.equal(edited.body.ticket.basis, 'none');
    assert.equal(ticketCount(t), 1);
  });
});

test('an edit cannot wipe the time of the offence: null or a non-string is a 422 and the ticket is untouched', async () => {
  await withHousehold(async ({ t, anna }) => {
    const id = insertTicket(t, { userId: anna.id, at: D10('08:30'), amountCents: 5_000, reason: 'kept' });
    for (const bad of [null, 12345, '', false]) {
      const res = await anna.patch(`/api/tickets/${id}`, { at: bad, reason: 'changed' });
      assert.equal(res.status, 422, JSON.stringify(bad));
      assert.equal(fieldsOf(res).at, 'invalid_datetime', JSON.stringify(bad));
    }
    assert.deepEqual({ ...one<Json>(t.db, 'SELECT at_utc, amount_cents, reason FROM tickets WHERE id = ?', id) }, { at_utc: D10('08:30'), amount_cents: 5_000, reason: 'kept' });
  });
});

test('odd spellings of the time are normalised to the stored shape or refused, never a server error', async () => {
  await withHousehold(async ({ t, anna }) => {
    // Short forms and a fractional second are valid instants and are stored the way every other time is.
    for (const [sent, stored] of [
      ['2026-06-10T08:30Z', D10('08:30')],
      ['2026-06-10T08:30:00.5Z', '2026-06-10T08:30:00.500Z'],
      ['2026-06-10T10:30:00+02:00', D10('08:30')],
    ] as const) {
      const res = await anna.post('/api/tickets', { at: sent });
      assert.equal(res.status, 201, sent);
      assert.equal(res.body.ticket.at, stored, sent);
    }
    assert.equal(ticketCount(t), 3);
    for (const bad of ['0001-01-01T00:00:00Z', '-000001-01-01T00:00:00Z', '+010000-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z', '2026-06-10T24:00:00Z', '2026-06-10T08:30:00.123456789Z', '10 June 2026']) {
      const res = await anna.post('/api/tickets', { at: bad });
      assert.equal(res.status, 422, bad);
      assert.equal(fieldsOf(res).at, 'invalid_datetime', bad);
    }
    assert.equal(ticketCount(t), 3, 'nothing else was written');
  });
});

test('a ticket stays listed after the person who entered it is deactivated, still under their name', async () => {
  await withHousehold(async ({ t, admin, anna }) => {
    const id = insertTicket(t, { userId: anna.id, at: D10('08:30'), reason: 'left behind' });
    run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', anna.id);
    const items: Json[] = (await admin.get('/api/tickets')).body.items;
    const item = items.find((i) => i.id === id);
    assert.ok(item, 'still listed');
    assert.equal(item.createdByName, 'Anna');
    assert.deepEqual(item.can, { edit: true, delete: true }, 'an admin can still correct or delete it');
    assert.equal((await admin.del(`/api/tickets/${id}`)).status, 204);
  });
});

// ------------------------------------------------- the matcher against a plain model

/** A small seeded generator (mulberry32): a failure names its seed, so it can be replayed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Rec {
  id: number;
  user: number;
  start: number;
  end: number;
}

/** The written rule, with no SQL: the first tier with an answer wins, and within a tier the later start (then the later row). */
function modelWho(at: number, drives: Rec[], drafts: Rec[], reservations: Rec[]): [number | null, string] {
  const latest = (a: Rec, b: Rec): number => b.start - a.start || b.id - a.id;
  const covering = (rs: Rec[]): Rec | undefined => rs.filter((r) => r.start <= at && at <= r.end).sort(latest)[0];
  const drive = covering(drives);
  if (drive) return [drive.user, 'drive'];
  const draft = drafts
    .filter((d) => d.start <= at && d.start >= at - 24 * HOUR && !drives.some((c) => c.start > d.start && c.start <= at))
    .sort(latest)[0];
  if (draft) return [draft.user, 'draft'];
  const reservation = covering(reservations);
  if (reservation) return [reservation.user, 'reservation'];
  return [null, 'none'];
}

test('the matcher agrees with a plain model of the rule on 300 seeded random households, probing every start, end and 24-hour edge', async () => {
  await withHousehold(async ({ t, admin, anna, ben, carla }) => {
    const people = [admin.id, anna.id, ben.id, carla.id];
    const base = Date.parse(D10('00:00'));
    const seen: Record<string, number> = { drive: 0, draft: 0, reservation: 0, none: 0 };
    let probed = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = seeded(seed);
      const int = (n: number): number => Math.floor(rnd() * n);
      // Starts sit on a one-hour grid over three days, so records share boundaries and 24-hour edges often.
      const slot = (): number => base + int(72) * HOUR;
      run(t.db, 'DELETE FROM usage');
      run(t.db, 'DELETE FROM reservations');

      const drives: Rec[] = [];
      for (let i = int(5); i > 0; i--) {
        const start = slot();
        const end = start + (1 + int(6)) * HOUR;
        const user = people[int(4)] as number;
        drives.push({ id: insertUsage(t, { userId: user, start: new Date(start).toISOString(), end: new Date(end).toISOString() }), user, start, end });
      }
      const drafts: Rec[] = [];
      for (const user of people) {
        if (rnd() < 0.5) continue; // at most one open draft per person, as the database insists
        const start = slot();
        drafts.push({ id: insertDraft(t, { userId: user, start: new Date(start).toISOString() }), user, start, end: start });
      }
      const reservations: Rec[] = [];
      for (let i = int(5); i > 0; i--) {
        const start = slot();
        const end = start + (1 + int(8)) * HOUR;
        const user = people[int(4)] as number;
        const status = (['confirmed', 'confirmed', 'pending', 'declined'] as const)[int(4)] as 'confirmed' | 'pending' | 'declined';
        const id = insertReservation(t, { userId: user, createdBy: user, status, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
        if (status === 'confirmed') reservations.push({ id, user, start, end });
      }

      const moments = new Set<number>();
      for (const r of [...drives, ...drafts, ...reservations]) for (const edge of [r.start, r.end, r.start + 24 * HOUR]) for (const d of [-1, 0, 1]) moments.add(edge + d);
      for (let i = 0; i < 12; i++) moments.add(base + int(80) * HOUR).add(base - 2 * HOUR + int(84 * 3_600) * 1_000 + int(1_000));
      for (const ms of moments) {
        const iso = new Date(ms).toISOString();
        const expected = modelWho(ms, drives, drafts, reservations);
        assert.deepEqual(who(t, iso), expected, `seed ${seed}, at ${iso}`);
        seen[expected[1] as string] = (seen[expected[1] as string] ?? 0) + 1;
        probed++;
      }
    }
    // The generator has to reach every tier, or agreeing with the model would prove little.
    for (const basis of ['drive', 'draft', 'reservation', 'none']) assert.ok((seen[basis] ?? 0) >= 100, `${basis} was probed ${seen[basis]} times of ${probed}`);
  });
});
