// The reminder scheduler, driven by a fake clock and a stub push service: nothing
// waits for real time and nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { many, run } from '../src/db.ts';
import { createPush } from '../src/push.ts';
import { GRACE_MS, REPEAT_AFTER_END_MS, START_LEAD_MS, createReminders, reminderMessage } from '../src/reminders.ts';
import { createHousehold, insertDraft, insertReservation, insertUsage, makeSubscriber, stubFetch, type Household, type Json, type StubFetch, type Subscriber } from './helpers.ts';

const ENV = { PUSH_CONTACT: 'https://car.example.test' };
// Amsterdam is UTC+2 in June, so 14:00Z shows as 16:00 in the messages.
const START = '2026-06-15T14:00:00.000Z';
const END = '2026-06-15T16:00:00.000Z';
const MOMENTS = { start: '2026-06-15T13:30:00.000Z', end: '2026-06-15T16:00:00.000Z', repeat: '2026-06-15T17:00:00.000Z' };

interface Setup extends Household {
  stub: StubFetch;
  phone: Subscriber;
  /** Messages delivered to the phone so far, decrypted. */
  messages(): Json[];
  reservation: number;
  tick(iso: string): Promise<Awaited<ReturnType<Household['t']['app']['reminders']['tick']>>>;
}

async function setup(opts: { reserve?: boolean } = {}): Promise<Setup> {
  const stub = stubFetch();
  const h = await createHousehold({ env: ENV, fetch: stub.fetch, now: '2026-06-15T10:00:00.000Z' });
  const phone = makeSubscriber();
  assert.equal((await h.anna.post('/api/push/subscribe', phone.subscription)).status, 201);
  const reservation = opts.reserve === false ? 0 : insertReservation(h.t, { userId: h.anna.id, start: START, end: END });
  return {
    ...h,
    stub,
    phone,
    reservation,
    messages: () => stub.calls.filter((c) => c.url === phone.endpoint).map((c) => phone.read(c)),
    tick: (iso) => {
      h.t.clock.set(iso);
      return h.t.app.reminders.tick();
    },
  };
}

const claims = (s: Setup): Array<{ kind: string; scheduled_utc: string }> =>
  many(s.t.db, 'SELECT kind, scheduled_utc FROM reminders_sent ORDER BY scheduled_utc');

test('timing: 30 minutes before the start, at the end, and once more an hour later, each exactly once', async () => {
  const s = await setup();
  try {
    assert.equal(START_LEAD_MS, 30 * 60_000);
    assert.equal(REPEAT_AFTER_END_MS, 60 * 60_000);
    assert.deepEqual({ ...(await s.tick('2026-06-15T10:00:00.000Z')) }, { claimed: 0, sent: 0, released: 0 });
    assert.equal((await s.tick('2026-06-15T13:29:59.000Z')).claimed, 0, 'one second too early');

    const start = await s.tick(MOMENTS.start);
    assert.deepEqual({ ...start }, { claimed: 1, sent: 1, released: 0 });
    for (const later of ['13:31:00', '13:40:00', '13:44:59']) assert.equal((await s.tick(`2026-06-15T${later}.000Z`)).claimed, 0, `${later} again`);
    assert.equal(s.messages().length, 1);
    assert.deepEqual({ ...s.messages()[0] }, {
      title: 'Your car reservation starts soon',
      body: 'It starts at 16:00. Save your starting odometer reading now.',
      url: `/#/usage?res=${s.reservation}`,
      tag: `km-${s.reservation}`,
    });

    assert.equal((await s.tick('2026-06-15T15:59:59.000Z')).claimed, 0);
    assert.equal((await s.tick(MOMENTS.end)).sent, 1);
    assert.equal((await s.tick('2026-06-15T16:01:00.000Z')).claimed, 0);
    assert.deepEqual({ ...s.messages()[1] }, {
      title: 'Register your kilometres',
      body: 'Your reservation ended at 18:00. Register the kilometres you drove.',
      url: `/#/usage?res=${s.reservation}`,
      tag: `km-${s.reservation}`,
    });

    assert.equal((await s.tick('2026-06-15T16:59:59.000Z')).claimed, 0);
    assert.equal((await s.tick(MOMENTS.repeat)).sent, 1);
    assert.equal(s.messages()[2]?.['title'], 'Reminder: Register your kilometres');
    for (const later of ['17:01:00', '17:14:00', '17:16:00', '19:00:00']) assert.equal((await s.tick(`2026-06-15T${later}.000Z`)).claimed, 0, `${later}: nothing after the repeat`);
    assert.equal(s.messages().length, 3);
    assert.deepEqual(claims(s).map((c) => [c.kind, c.scheduled_utc]), [['start', MOMENTS.start], ['end', MOMENTS.end], ['repeat', MOMENTS.repeat]]);
  } finally {
    await s.t.close();
  }
});

test('only the driver is reminded, on all their devices, and every request is signed', async () => {
  const s = await setup();
  try {
    const second = makeSubscriber('https://updates.push.services.mozilla.com/wpush/v2/laptop');
    await s.anna.post('/api/push/subscribe', second.subscription);
    const other = makeSubscriber();
    await s.ben.post('/api/push/subscribe', other.subscription);
    const out = await s.tick(MOMENTS.start);
    assert.equal(out.claimed, 1);
    assert.equal(s.stub.calls.length, 2, 'Anna has two devices, Ben none of this');
    assert.equal(second.read(s.stub.calls.find((c) => c.url === second.endpoint)!)['tag'], `km-${s.reservation}`);
    assert.ok(s.stub.calls.every((c) => /^vapid t=.+, k=.+$/.test(c.headers['authorization'] ?? '')));
    assert.equal(s.stub.calls.some((c) => c.url === other.endpoint), false);
  } finally {
    await s.t.close();
  }
});

test('nothing is sent for pending, declined or cancelled reservations, or for someone without a device', async () => {
  const s = await setup({ reserve: false });
  try {
    insertReservation(s.t, { userId: s.anna.id, createdBy: s.ben.id, status: 'pending', start: START, end: END });
    insertReservation(s.t, { userId: s.anna.id, createdBy: s.ben.id, status: 'declined', start: '2026-06-15T18:00:00.000Z', end: '2026-06-15T19:00:00.000Z' });
    const cancelled = insertReservation(s.t, { userId: s.anna.id, start: '2026-06-15T20:00:00.000Z', end: '2026-06-15T21:00:00.000Z' });
    assert.equal((await s.anna.del(`/api/reservations/${cancelled}`)).status, 204);
    insertReservation(s.t, { userId: s.ben.id, start: START, end: END }); // Ben has no device
    // The only way to be reminded is a confirmed reservation: step through every moment.
    for (const iso of ['2026-06-15T13:30:00.000Z', '2026-06-15T16:00:00.000Z', '2026-06-15T17:00:00.000Z', '2026-06-15T17:30:00.000Z', '2026-06-15T18:30:00.000Z', '2026-06-15T19:00:00.000Z', '2026-06-15T20:00:00.000Z']) {
      assert.equal((await s.tick(iso)).claimed, 0, iso);
    }
    assert.equal(s.stub.calls.length, 0);
    assert.equal(claims(s).length, 0, 'no device means no claim either');
  } finally {
    await s.t.close();
  }
});

test('a completed registration silences the reminders; an unfinished draft changes their wording', async () => {
  const registered = await setup();
  try {
    insertUsage(registered.t, { userId: registered.anna.id, start: START, end: END, odometerStart: 100, odometerEnd: 140, reservationId: registered.reservation });
    for (const iso of [MOMENTS.start, MOMENTS.end, MOMENTS.repeat]) assert.equal((await registered.tick(iso)).claimed, 0, iso);
    assert.equal(registered.stub.calls.length, 0);
  } finally {
    await registered.t.close();
  }

  const drive = await setup();
  try {
    // The start reading is saved at 14:05, so the start reminder (13:30) went out and the end ones ask to finish.
    assert.equal((await drive.tick(MOMENTS.start)).sent, 1);
    insertDraft(drive.t, { userId: drive.anna.id, start: '2026-06-15T14:05:00.000Z', reservationId: drive.reservation });
    assert.equal((await drive.tick(MOMENTS.end)).sent, 1);
    assert.equal((await drive.tick(MOMENTS.repeat)).sent, 1);
    assert.deepEqual(drive.messages().map((m) => m['title']), ['Your car reservation starts soon', 'Finish your drive', 'Reminder: Finish your drive']);
    assert.equal(drive.messages()[1]?.['body'], 'Your reservation ended at 18:00. Enter the end odometer reading.');
  } finally {
    await drive.t.close();
  }

  const early = await setup();
  try {
    // Started exactly at the start lead time: inside the reservation's own window, so it is this reservation's draft.
    insertDraft(early.t, { userId: early.anna.id, start: MOMENTS.start });
    assert.equal((await early.tick(MOMENTS.start)).claimed, 0, 'the start reading is already saved: no start reminder');
    assert.equal((await early.tick(MOMENTS.end)).sent, 1);
    assert.equal(early.messages()[0]?.['title'], 'Finish your drive');
  } finally {
    await early.t.close();
  }
});

test('only a draft that belongs to the reservation counts: a forgotten old draft changes nothing', async () => {
  // Three days old and not linked: this reservation still gets its start reminder and the plain end wording.
  const stale = await setup();
  try {
    insertDraft(stale.t, { userId: stale.anna.id, start: '2026-06-12T09:00:00.000Z' });
    assert.equal((await stale.tick(MOMENTS.start)).sent, 1, 'the start reminder is not silenced by an old draft');
    assert.equal((await stale.tick(MOMENTS.end)).sent, 1);
    assert.deepEqual(stale.messages().map((m) => m['title']), ['Your car reservation starts soon', 'Register your kilometres']);
    assert.equal(stale.messages()[1]?.['body'], 'Your reservation ended at 18:00. Register the kilometres you drove.');
  } finally {
    await stale.t.close();
  }

  // The window opens at the start lead time (13:30), to the second (the test above covers 13:30:00 itself).
  const justBefore = await setup();
  try {
    insertDraft(justBefore.t, { userId: justBefore.anna.id, start: '2026-06-15T13:29:59.000Z' });
    assert.equal((await justBefore.tick(MOMENTS.start)).sent, 1, 'one second before the window: not this reservation\'s draft');
  } finally {
    await justBefore.t.close();
  }

  // A draft linked to the reservation counts even when it was saved days earlier.
  const linked = await setup();
  try {
    insertDraft(linked.t, { userId: linked.anna.id, start: '2026-06-12T09:00:00.000Z', reservationId: linked.reservation });
    assert.equal((await linked.tick(MOMENTS.start)).claimed, 0, 'linked draft: the start reading is saved');
    assert.equal((await linked.tick(MOMENTS.end)).sent, 1);
    assert.equal(linked.messages()[0]?.['title'], 'Finish your drive');
  } finally {
    await linked.t.close();
  }
});

test('a kilometre registration made between the reminders stops the later ones', async () => {
  const s = await setup();
  try {
    assert.equal((await s.tick(MOMENTS.end)).sent, 1);
    insertUsage(s.t, { userId: s.anna.id, start: START, end: END, odometerStart: 5, odometerEnd: 25 });
    assert.equal((await s.tick(MOMENTS.repeat)).claimed, 0, 'registered in the meantime: no repeat');
  } finally {
    await s.t.close();
  }
});

test('a moment missed by more than the grace period is skipped, not sent late', async () => {
  assert.equal(GRACE_MS, 15 * 60_000);
  const s = await setup();
  try {
    // The server was down from before 13:30 until 13:45:01.
    assert.equal((await s.tick('2026-06-15T13:45:00.000Z')).claimed, 0, 'exactly at the end of the grace period is already too late');
    assert.equal((await s.tick('2026-06-15T15:00:00.000Z')).claimed, 0);
    // Down across the end moment too.
    assert.equal((await s.tick('2026-06-15T16:15:00.000Z')).claimed, 0);
    assert.equal((await s.tick('2026-06-15T16:30:00.000Z')).claimed, 0);
    assert.equal(s.stub.calls.length, 0);
    // Back up just inside the grace period of the repeat: that one is still sent.
    assert.equal((await s.tick('2026-06-15T17:14:59.000Z')).sent, 1);
  } finally {
    await s.t.close();
  }
});

test('a restart does not send anything twice: the claim is in the database', async () => {
  const s = await setup();
  try {
    assert.equal((await s.tick(MOMENTS.start)).sent, 1);
    const restarted = createReminders(s.t.ctx, createPush(s.t.ctx));
    s.t.clock.set('2026-06-15T13:31:00.000Z');
    assert.deepEqual({ ...(await restarted.tick()) }, { claimed: 0, sent: 0, released: 0 });
    assert.equal(s.stub.calls.length, 1);
  } finally {
    await s.t.close();
  }
});

test('two schedulers (say, two processes) ticking at the same moment cannot both send: the claim is taken before sending', async () => {
  const s = await setup();
  try {
    s.t.clock.set(MOMENTS.start);
    const second = createReminders(s.t.ctx, createPush(s.t.ctx));
    const [a, b] = await Promise.all([s.t.app.reminders.tick(), second.tick()]);
    assert.equal(a.claimed + b.claimed, 1);
    assert.equal(s.stub.calls.length, 1);
  } finally {
    await s.t.close();
  }
});

test('a moved reservation gets fresh reminders for its new time', async () => {
  const s = await setup();
  try {
    assert.equal((await s.tick(MOMENTS.start)).sent, 1);
    run(s.t.db, 'UPDATE reservations SET start_utc = ?, end_utc = ? WHERE id = ?', '2026-06-15T18:00:00.000Z', '2026-06-15T20:00:00.000Z', s.reservation);
    assert.equal((await s.tick('2026-06-15T17:30:00.000Z')).sent, 1, 'new start moment');
    assert.equal(s.messages()[1]?.['body'], 'It starts at 20:00. Save your starting odometer reading now.');
    assert.equal(claims(s).length, 2);
  } finally {
    await s.t.close();
  }
});

test('a device that signs up after the moment but inside the grace period still gets it', async () => {
  const s = await setup({ reserve: false });
  try {
    const bensRes = insertReservation(s.t, { userId: s.ben.id, start: START, end: END });
    assert.equal((await s.tick(MOMENTS.start)).claimed, 0, 'no device: nothing claimed, so nothing is used up');
    const phone = makeSubscriber();
    await s.ben.post('/api/push/subscribe', phone.subscription);
    const out = await s.tick('2026-06-15T13:40:00.000Z');
    assert.equal(out.sent, 1);
    assert.equal(phone.read(s.stub.calls.find((c) => c.url === phone.endpoint)!)['tag'], `km-${bensRes}`);
  } finally {
    await s.t.close();
  }
});

test('a transient failure gives the claim back so the next minute retries; partial success is never repeated', async () => {
  const s = await setup();
  try {
    s.stub.respond(() => new Response(null, { status: 503 }));
    const failed = await s.tick(MOMENTS.start);
    assert.deepEqual({ ...failed }, { claimed: 1, sent: 0, released: 1 });
    assert.equal(claims(s).length, 0, 'the claim was released');
    assert.deepEqual(
      s.t.logs.filter((l) => l['event'] === 'reminder.undelivered').map((l) => ({ ...l })),
      [{ event: 'reminder.undelivered', reservationId: s.reservation, kind: 'start', devices: 1, willRetry: true }],
      'a reminder that did not get through is logged with its reservation, and says it will be retried',
    );
    s.stub.respond(() => new Response(null, { status: 201 }));
    const retried = await s.tick('2026-06-15T13:31:00.000Z');
    assert.deepEqual({ ...retried }, { claimed: 1, sent: 1, released: 0 });
    assert.equal(claims(s).length, 1);
    assert.equal((await s.tick('2026-06-15T13:32:00.000Z')).claimed, 0);

    // Two devices, one fails: the reminder is delivered, so it is not sent again (the working device would get it twice).
    const flaky = makeSubscriber('https://web.push.apple.com/flaky');
    await s.anna.post('/api/push/subscribe', flaky.subscription);
    s.stub.calls.length = 0;
    s.stub.respond((call) => new Response(null, { status: call.url === flaky.endpoint ? 503 : 201 }));
    assert.deepEqual({ ...(await s.tick(MOMENTS.end)) }, { claimed: 1, sent: 1, released: 0 });
    s.stub.respond(() => new Response(null, { status: 201 }));
    s.stub.calls.length = 0;
    assert.equal((await s.tick('2026-06-15T16:01:00.000Z')).claimed, 0);
    assert.equal(s.stub.calls.length, 0);
  } finally {
    await s.t.close();
  }
});

test('retries stop when the grace period is over', async () => {
  const s = await setup();
  try {
    s.stub.respond(() => new Response(null, { status: 503 }));
    assert.equal((await s.tick(MOMENTS.start)).released, 1);
    assert.equal((await s.tick('2026-06-15T13:44:00.000Z')).released, 1, 'still trying inside the grace period');
    assert.equal((await s.tick('2026-06-15T13:45:00.000Z')).claimed, 0, 'and then it gives up');
  } finally {
    await s.t.close();
  }
});

test('a device the push service reports as gone is dropped while reminding', async () => {
  const s = await setup();
  try {
    s.stub.respond(() => new Response(null, { status: 410 }));
    const out = await s.tick(MOMENTS.start);
    assert.deepEqual({ ...out }, { claimed: 1, sent: 0, released: 0 });
    assert.equal(many(s.t.db, 'SELECT id FROM push_subscriptions').length, 0);
    assert.deepEqual(
      s.t.logs.filter((l) => l['event'] === 'reminder.undelivered').map((l) => ({ ...l })),
      [{ event: 'reminder.undelivered', reservationId: s.reservation, kind: 'start', devices: 1, willRetry: false }],
      'nothing was delivered and nothing will be retried: that is not silent',
    );
  } finally {
    await s.t.close();
  }
});

test('the reminders and the pending list agree on which reservations still need kilometres (same fixtures)', async () => {
  const s = await setup({ reserve: false });
  try {
    const hours = (h: number): string => new Date(Date.parse('2026-06-15T10:00:00.000Z') + h * 3_600_000).toISOString();
    const done = insertReservation(s.t, { userId: s.anna.id, start: hours(2), end: hours(3) });
    const open = insertReservation(s.t, { userId: s.anna.id, start: hours(4), end: hours(5) });
    const touched = insertReservation(s.t, { userId: s.anna.id, start: hours(6), end: hours(7) });
    const byOther = insertReservation(s.t, { userId: s.anna.id, start: hours(8), end: hours(9) });
    insertUsage(s.t, { userId: s.anna.id, start: hours(2.1), end: hours(2.9), odometerStart: 1, odometerEnd: 9, reservationId: done });
    insertUsage(s.t, { userId: s.anna.id, start: hours(5), end: hours(6), odometerStart: 9, odometerEnd: 12 }); // touches both ends: registers neither
    insertUsage(s.t, { userId: s.ben.id, start: hours(8.5), end: hours(8.8), odometerStart: 12, odometerEnd: 20 }); // someone else drove it
    insertUsage(s.t, { userId: s.anna.id, start: hours(7), end: hours(7.5) }); // legacy row without readings: registers nothing

    const reminded = new Set<number>();
    for (const id of [done, open, touched, byOther]) {
      const row = many<{ end_utc: string }>(s.t.db, 'SELECT end_utc FROM reservations WHERE id = ?', id)[0]!;
      s.stub.calls.length = 0;
      const out = await s.tick(row.end_utc);
      assert.ok(out.claimed <= 1);
      if (s.messages().some((m) => m['title'] === 'Register your kilometres' && m['tag'] === `km-${id}`)) reminded.add(id);
    }
    s.t.clock.set(hours(12));
    const pending = (await s.anna.get('/api/usage/pending')).body.items[0].reservations.map((r: Json) => r.id as number);
    assert.deepEqual([...reminded].sort(), [...pending].sort(), 'the end reminder goes out for exactly the reservations the banner lists');
    assert.deepEqual([...reminded].sort((a, b) => a - b), [open, touched].sort((a, b) => a - b));
  } finally {
    await s.t.close();
  }
});

test('with reminders off nothing runs; start() ticks once at once and can be stopped', async () => {
  const stub = stubFetch();
  const off = await createHousehold({ fetch: stub.fetch, now: '2026-06-15T13:31:00.000Z' }); // no DOMAIN / PUSH_CONTACT
  try {
    insertReservation(off.t, { userId: off.anna.id, start: START, end: END });
    assert.deepEqual({ ...(await off.t.app.reminders.tick()) }, { claimed: 0, sent: 0, released: 0 });
    assert.equal(stub.calls.length, 0);
  } finally {
    await off.t.close();
  }

  const s = await setup();
  try {
    s.t.clock.set('2026-06-15T13:31:00.000Z');
    const handle = s.t.app.reminders.start();
    for (let i = 0; i < 100 && s.stub.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    handle.stop();
    assert.equal(s.stub.calls.length, 1, 'the first tick runs immediately');
  } finally {
    await s.t.close();
  }
});

test('the reminder texts are plain sentences without personal data beyond the time', () => {
  for (const kind of ['start', 'end', 'repeat'] as const) {
    for (const draft of [false, true]) {
      const m = reminderMessage(kind, 7, '18:00', draft);
      assert.equal(m.url, '/#/usage?res=7');
      assert.equal(m.tag, 'km-7');
      assert.ok(m.title.length > 0 && m.body.length > 0);
      assert.ok(new TextEncoder().encode(JSON.stringify(m)).length < 1000, 'fits the push payload limit');
    }
  }
});
