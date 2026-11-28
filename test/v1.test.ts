// The read-only token API (src/v1.ts): what each route answers, that it never shows a person more than the app does,
// and that the "who has the car" rule agrees with the Start screen. Token handling itself is in test/tokens.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { carNow as browserCarNow } from '../public/views/home.js';
import { apkOf, openDamageCount } from '../src/car.ts';
import { listReservations } from '../src/reservations.ts';
import { pendingKmFor, usageSummary } from '../src/usage.ts';
import { carNow, myNextReservation } from '../src/v1.ts';
import {
  createHousehold,
  insertApk,
  insertDamage,
  insertDraft,
  insertFuel,
  insertReservation,
  insertUsage,
  type Client,
  type Household,
  type Json,
} from './helpers.ts';

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function tokenOf(client: Client): Promise<string> {
  const r = await client.post('/api/tokens', { name: 'test' });
  assert.equal(r.status, 201, r.text);
  return r.body.token as string;
}

async function withHousehold(fn: (h: Household) => Promise<void>): Promise<void> {
  const h = await createHousehold();
  try {
    await fn(h);
  } finally {
    await h.t.close();
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (h: Household, offsetMs: number): string => new Date(h.t.clock.now().getTime() + offsetMs).toISOString();

// ------------------------------------------------------------------ reservations

test('reservations: a token sees exactly what the app shows its owner, minus the buttons', async () => {
  await withHousehold(async (h) => {
    const confirmed = insertReservation(h.t, { userId: h.ben.id, start: iso(h, 2 * HOUR), end: iso(h, 4 * HOUR), note: 'to the shops' });
    // Ben suggests a slot to Anna: only Ben, Anna and an admin may see it.
    const suggestion = insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'pending', start: iso(h, DAY), end: iso(h, DAY + 2 * HOUR) });
    // Anna's suggestion to Ben, which he declined: only the two of them (and an admin) see it.
    const declined = insertReservation(h.t, { userId: h.ben.id, createdBy: h.anna.id, status: 'declined', start: iso(h, 2 * DAY), end: iso(h, 2 * DAY + HOUR) });
    const anna = await tokenOf(h.anna);
    const carla = await tokenOf(h.carla);
    const adminToken = await tokenOf(h.admin);
    const anon = h.t.client();

    const strip = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      items.map((item) => {
        const copy = { ...item };
        delete copy['can'];
        return copy;
      });
    const ids = (r: { body: { items: Array<{ id: number }> } }): number[] => r.body.items.map((i) => i.id);

    for (const [who, client, token] of [['anna', h.anna, anna], ['carla', h.carla, carla]] as const) {
      const viaApp = await client.get('/api/reservations');
      const viaToken = await anon.get('/api/v1/reservations', bearer(token));
      assert.equal(viaToken.status, 200, who);
      assert.deepEqual(viaToken.body.items, strip(viaApp.body.items), `${who}: the same items, only without "can"`);
      assert.deepEqual(viaToken.body.window, viaApp.body.window);
      assert.ok(viaToken.body.items.every((i: Record<string, unknown>) => !('can' in i)));
    }
    assert.deepEqual(ids(await anon.get('/api/v1/reservations', bearer(anna))), [confirmed, suggestion, declined], 'the target sees the suggestion, the creator the declined one');
    assert.deepEqual(ids(await anon.get('/api/v1/reservations', bearer(carla))), [confirmed], 'somebody else does not');

    // Role-blind: an admin's token sees what a member sees; the admin's cookie session sees everything.
    assert.deepEqual(ids(await h.admin.get('/api/reservations')), [confirmed, suggestion, declined]);
    assert.deepEqual(ids(await anon.get('/api/v1/reservations', bearer(adminToken))), [confirmed], 'the admin token is a member token');

    // The app's own filters work the same way.
    const mine = await anon.get(`/api/v1/reservations?userId=${h.ben.id}&status=confirmed`, bearer(carla));
    assert.deepEqual(ids(mine), [confirmed]);
    const bad = await anon.get('/api/v1/reservations?status=nope', bearer(carla));
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.fields.status, 'invalid_value');
    const ranged = await anon.get(`/api/v1/reservations?from=${encodeURIComponent(iso(h, 3 * HOUR))}&to=${encodeURIComponent(iso(h, 5 * HOUR))}`, bearer(carla));
    assert.deepEqual(ids(ranged), [confirmed], 'from and to are the app\'s');
  });
});

test('no answer of the token API holds a password hash, a session or token digest, or somebody else\'s pending suggestion', async () => {
  await withHousehold(async (h) => {
    const suggestion = insertReservation(h.t, { userId: h.ben.id, createdBy: h.anna.id, status: 'pending', start: iso(h, DAY), end: iso(h, DAY + HOUR), note: 'secret plan for Ben' });
    const carla = await tokenOf(h.carla);
    const token = await tokenOf(h.anna);
    const anon = h.t.client();
    const texts: string[] = [];
    for (const route of ['/api/v1/status', '/api/v1/reservations', '/api/v1/stats', '/api/v1/me']) {
      const r = await anon.get(route, bearer(carla));
      assert.equal(r.status, 200, route);
      texts.push(r.text);
    }
    const all = texts.join('\n');
    assert.doesNotMatch(all, /scrypt\$|password|token_hash|secret_hash|session|pat_[A-Za-z0-9_-]{43}/i);
    assert.ok(!all.includes('secret plan for Ben'), 'Ben\'s suggestion (and its note) is not Carla\'s to see');
    const listed = JSON.parse(texts[1] as string) as { items: Array<{ id: number }> };
    assert.ok(!listed.items.some((i) => i.id === suggestion), 'nor is it in the list');
    assert.ok(!all.includes(token), 'nor anybody else\'s token');
    const hashes = h.t.db.prepare('SELECT password_hash FROM users').all() as Array<{ password_hash: string }>;
    for (const row of hashes) assert.ok(!all.includes(row.password_hash.slice(0, 20)));
  });
});

// ---------------------------------------------------------------------------- stats

test('stats: byte for byte what GET /api/stats answers, with the same range rules', async () => {
  await withHousehold(async (h) => {
    insertUsage(h.t, { userId: h.anna.id, start: iso(h, -3 * DAY), end: iso(h, -3 * DAY + HOUR), odometerStart: 1000, odometerEnd: 1100 });
    insertFuel(h.t, { userId: h.anna.id, at: iso(h, -2 * DAY) });
    const token = await tokenOf(h.ben);
    const anon = h.t.client();
    for (const query of ['', '?from=2026-04&to=2026-06', '?from=2026-06', '?to=2026-05']) {
      const viaApp = await h.ben.get(`/api/stats${query}`);
      const viaToken = await anon.get(`/api/v1/stats${query}`, bearer(token));
      assert.equal(viaToken.status, viaApp.status, query);
      assert.equal(viaToken.text, viaApp.text, `the same bytes for "${query}"`);
    }
    const bad = await anon.get('/api/v1/stats?from=nope', bearer(token));
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.fields.from, 'invalid_month');
  });
});

// ------------------------------------------------------------------------------ me

test('me: only the owner\'s kilometres and what the owner owes or is owed, nothing about anybody else', async () => {
  await withHousehold(async (h) => {
    const day = (n: number): string => iso(h, -n * DAY);
    // Ben drives 100 km of his own, and 50 km for Anna; Carla drives 40 km; 30 km are together.
    insertUsage(h.t, { userId: h.ben.id, start: day(6), end: iso(h, -6 * DAY + HOUR), odometerStart: 1000, odometerEnd: 1100 });
    insertUsage(h.t, { userId: h.ben.id, start: day(5), end: iso(h, -5 * DAY + HOUR), odometerStart: 1100, odometerEnd: 1150, kmFor: 'person', kmUserId: h.anna.id });
    insertUsage(h.t, { userId: h.carla.id, start: day(4), end: iso(h, -4 * DAY + HOUR), odometerStart: 1150, odometerEnd: 1190 });
    insertUsage(h.t, { userId: h.anna.id, start: day(3), end: iso(h, -3 * DAY + HOUR), odometerStart: 1190, odometerEnd: 1220, kmFor: 'together' });
    insertFuel(h.t, { userId: h.anna.id, at: day(2), totalCents: 9000, odometer: 1220 });
    const anon = h.t.client();
    const [annaToken, benToken, adminToken] = [await tokenOf(h.anna), await tokenOf(h.ben), await tokenOf(h.admin)];

    const anna = (await anon.get('/api/v1/me', bearer(annaToken))).body;
    assert.deepEqual(Object.keys(anna).sort(), ['fuel', 'km', 'user']);
    assert.deepEqual(anna.user, { id: h.anna.id, username: 'anna', displayName: 'Anna' });
    // Her own 50 km were driven by Ben; she drove 30 together km herself (that is a trip of hers, not her kilometres).
    assert.deepEqual({ ...anna.km, window: undefined }, { trips: 1, tripsWithKm: 1, km: 50, window: undefined });
    assert.ok(anna.km.window.from < anna.km.window.to);
    assert.equal(anna.fuel.oweTotalCents, 0);
    assert.ok(anna.fuel.owedTotalCents > 0, 'the fueler is owed money');
    assert.deepEqual(anna.fuel.owe, []);
    assert.deepEqual(
      anna.fuel.owed.map((o: { userId: number }) => o.userId).sort(),
      [h.ben.id, h.carla.id].sort(),
      'Ben and Carla owe Anna',
    );

    const ben = (await anon.get('/api/v1/me', bearer(benToken))).body;
    assert.equal(ben.km.km, 100);
    assert.equal(ben.km.trips, 2);
    assert.deepEqual(ben.fuel.owe.map((o: { userId: number }) => o.userId), [h.anna.id]);
    assert.deepEqual(ben.fuel.owed, []);
    assert.ok(!JSON.stringify(ben).includes('Carla'), 'what Carla owes is not Ben\'s business');

    // Role-blind: the admin token shows the admin's own numbers, and the admin pays no fuel.
    const admin = (await anon.get('/api/v1/me', bearer(adminToken))).body;
    assert.deepEqual(admin.km.km, 0);
    assert.deepEqual(admin.fuel, { owe: [], owed: [], oweTotalCents: 0, owedTotalCents: 0 });
    // The owner's totals add up the same as the app's own summary.
    const summary = (await h.ben.get('/api/usage/summary')).body;
    assert.equal(summary.items.find((i: { userId: number }) => i.userId === h.ben.id).km, ben.km.km);
  });
});

// -------------------------------------------------------------------------- status

test('status: who has the car, until when it is free, the next reservation, and what is still to do', async () => {
  await withHousehold(async (h) => {
    const anon = h.t.client();
    const token = await tokenOf(h.anna);
    const status = async (): Promise<Json> => (await anon.get('/api/v1/status', bearer(token))).body;

    // Nothing planned at all.
    let s = await status();
    assert.deepEqual(Object.keys(s).sort(), ['apk', 'car', 'kmToRegister', 'myNext', 'next', 'now', 'openDamage']);
    assert.equal(s.now, h.t.clock.now().toISOString());
    assert.deepEqual(s.car, { state: 'free', holder: null, since: null, until: null, freeUntil: null });
    assert.equal(s.next, null);
    assert.equal(s.myNext, null);
    assert.equal(s.kmToRegister, 0);
    assert.equal(s.openDamage, 0);
    assert.deepEqual(s.apk, { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null });

    // Free, with Ben booked in two hours and Anna the day after.
    const ben = insertReservation(h.t, { userId: h.ben.id, start: iso(h, 2 * HOUR), end: iso(h, 4 * HOUR) });
    const anna = insertReservation(h.t, { userId: h.anna.id, start: iso(h, DAY), end: iso(h, DAY + HOUR) });
    s = await status();
    assert.deepEqual(s.car, { state: 'free', holder: null, since: null, until: null, freeUntil: iso(h, 2 * HOUR) });
    assert.deepEqual(s.next, { id: ben, userId: h.ben.id, userName: 'Ben', start: iso(h, 2 * HOUR), end: iso(h, 4 * HOUR) });
    assert.deepEqual(s.myNext, { id: anna, userId: h.anna.id, userName: 'Anna', start: iso(h, DAY), end: iso(h, DAY + HOUR) });

    // Ben's reservation is running now.
    h.t.clock.advance(3 * HOUR);
    s = await status();
    assert.deepEqual(s.car, { state: 'reserved', holder: { id: h.ben.id, name: 'Ben' }, since: iso(h, -HOUR), until: iso(h, HOUR), freeUntil: null });
    assert.equal(s.next.id, anna, 'the next one after it');

    // Carla has started a drive and not finished it: the car is on the road, whatever the reservation says.
    insertDraft(h.t, { userId: h.carla.id, start: iso(h, -30 * 60_000) });
    s = await status();
    assert.deepEqual(s.car, { state: 'driving', holder: { id: h.carla.id, name: 'Carla' }, since: iso(h, -30 * 60_000), until: null, freeUntil: null });

    // Damage and the APK.
    insertDamage(h.t, { reportedBy: h.ben.id });
    insertDamage(h.t, { reportedBy: h.ben.id, repairedOn: '2026-06-12' });
    insertApk(h.t, { userId: h.anna.id, expiresOn: '2026-07-15' });
    s = await status();
    assert.equal(s.openDamage, 1, 'a repaired one is not open');
    assert.equal(s.apk.expiresOn, '2026-07-15');
    assert.equal(s.apk.daysLeft, 30);
    assert.equal(s.apk.updatedBy.name, 'Anna');
  });
});

test('status: the kilometres still to register are the owner\'s, the same number GET /api/usage/pending reports', async () => {
  await withHousehold(async (h) => {
    const anon = h.t.client();
    const token = await tokenOf(h.anna);
    const count = async (): Promise<[number, number]> => [
      (await anon.get('/api/v1/status', bearer(token))).body.kmToRegister,
      (await h.anna.get('/api/usage/pending')).body.count,
    ];
    assert.deepEqual(await count(), [0, 0]);
    // An ended reservation of Anna's with no drive, one with a drive, and one of Ben's.
    insertReservation(h.t, { userId: h.anna.id, start: iso(h, -3 * DAY), end: iso(h, -3 * DAY + 2 * HOUR) });
    const done = insertReservation(h.t, { userId: h.anna.id, start: iso(h, -2 * DAY), end: iso(h, -2 * DAY + 2 * HOUR) });
    insertUsage(h.t, { userId: h.anna.id, start: iso(h, -2 * DAY), end: iso(h, -2 * DAY + HOUR), odometerStart: 10, odometerEnd: 20, reservationId: done });
    insertReservation(h.t, { userId: h.ben.id, start: iso(h, -DAY), end: iso(h, -DAY + 2 * HOUR) });
    assert.deepEqual(await count(), [1, 1], 'Ben\'s unregistered reservation is not Anna\'s');
    // An open draft of hers counts as one more thing to finish.
    insertDraft(h.t, { userId: h.anna.id, start: iso(h, -HOUR) });
    assert.deepEqual(await count(), [2, 2]);
    // Older than the 14 days the app looks back is not counted, by either.
    insertReservation(h.t, { userId: h.anna.id, start: iso(h, -40 * DAY), end: iso(h, -40 * DAY + HOUR) });
    assert.deepEqual(await count(), [2, 2]);
  });
});

// ---------------------------------------------------- the functions the cookie routes and the token API share

test('the extracted functions give exactly what the cookie routes answer (the move changed nothing)', async () => {
  await withHousehold(async (h) => {
    insertUsage(h.t, { userId: h.anna.id, start: iso(h, -3 * DAY), end: iso(h, -3 * DAY + HOUR), odometerStart: 10, odometerEnd: 70 });
    insertUsage(h.t, { userId: h.ben.id, start: iso(h, -2 * DAY), end: iso(h, -2 * DAY + HOUR), odometerStart: 70, odometerEnd: 90, kmFor: 'person', kmUserId: h.anna.id });
    insertUsage(h.t, { userId: h.carla.id, start: iso(h, -DAY), end: iso(h, -DAY + HOUR), odometerStart: 90, odometerEnd: 100, kmFor: 'together' });
    insertReservation(h.t, { userId: h.anna.id, start: iso(h, -5 * DAY), end: iso(h, -5 * DAY + HOUR) }); // ended, nothing registered
    insertDraft(h.t, { userId: h.anna.id, start: iso(h, -HOUR) });
    const viaApi = await h.anna.get('/api/usage/summary');
    assert.deepEqual(usageSummary(h.t.ctx, viaApi.body.window), viaApi.body);
    const principal = { id: h.anna.id, username: 'anna', displayName: 'Anna', role: 'member' as const, sessionId: 0 };
    const pending = await h.anna.get('/api/usage/pending');
    const direct = pendingKmFor(h.t.ctx, principal, h.anna.id);
    assert.deepEqual(JSON.parse(JSON.stringify({ reservations: direct.reservations, drafts: direct.drafts })), { reservations: pending.body.items[0].reservations, drafts: pending.body.items[0].drafts });
    assert.equal(direct.count, pending.body.count);
    assert.equal(direct.count, 2, 'the unregistered reservation and the draft');
    const list = await h.anna.get('/api/reservations');
    assert.deepEqual(JSON.parse(JSON.stringify(listReservations(h.t.ctx, principal, new URLSearchParams()))), list.body);
    assert.deepEqual(JSON.parse(JSON.stringify(apkOf(h.t.db, h.t.config.tz, h.t.clock.now()))), (await h.anna.get('/api/car/apk')).body.apk);
    assert.equal(openDamageCount(h.t.db), 0);
  });
});

// ------------------------------------------------------- the Start screen's rule, ported

/** A small deterministic generator, so a failing scenario can be replayed from its number. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('carNow agrees with the browser\'s carNow over 150 seeded households (drives and reservations within what the Start screen looks at)', async () => {
  await withHousehold(async (h) => {
    const now = h.t.clock.now();
    const nowIso = now.toISOString();
    const people = [h.anna.id, h.ben.id, h.carla.id];
    const state = { driving: 0, reserved: 0, free: 0 };
    for (let scenario = 1; scenario <= 150; scenario++) {
      h.t.db.exec('DELETE FROM usage; DELETE FROM reservations;');
      const rnd = seeded(scenario);
      const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)] as T;
      for (let i = 0, n = Math.floor(rnd() * 6); i < n; i++) {
        // Starts from 8 days back to 50 days ahead (inside what the Start screen asks for), lasting 30 minutes to 2 days.
        const start = Math.round((-8 * DAY + rnd() * 58 * DAY) / 60_000) * 60_000;
        const length = (30 + Math.floor(rnd() * 2850)) * 60_000;
        insertReservation(h.t, {
          userId: pick(people),
          status: rnd() < 0.7 ? 'confirmed' : pick(['pending', 'declined'] as const),
          start: iso(h, start),
          end: iso(h, start + length),
        });
      }
      // Half of the households have somebody whose reservation covers this moment.
      if (rnd() < 0.5) {
        const before = Math.round(rnd() * 300) * 60_000 + 60_000;
        insertReservation(h.t, { userId: pick(people), start: iso(h, -before), end: iso(h, Math.round(rnd() * 300) * 60_000 + 60_000) });
      }
      const drafted = new Set<number>(); // one open drive per person
      for (let i = 0, n = Math.floor(rnd() * 3); i < n; i++) {
        const start = Math.round((-9 * DAY + rnd() * 10 * DAY) / 60_000) * 60_000;
        const person = pick(people);
        if (rnd() < 0.3 && !drafted.has(person)) {
          drafted.add(person);
          insertDraft(h.t, { userId: person, start: iso(h, start) });
        } else insertUsage(h.t, { userId: person, start: iso(h, start), end: iso(h, start + HOUR), odometerStart: 1, odometerEnd: 2 });
      }
      // What the Start screen asks the server for, as its endpoints() do.
      const range = (back: number, ahead: number): string => `from=${encodeURIComponent(iso(h, -back))}&to=${encodeURIComponent(iso(h, ahead))}`;
      const reservations = (await h.anna.get(`/api/reservations?status=confirmed&${range(7 * DAY, 60 * DAY)}`)).body.items;
      const drives = (await h.anna.get(`/api/usage?${range(7 * DAY, DAY)}`)).body.items;
      const browser = browserCarNow(reservations, drives, nowIso);
      const server = carNow(h.t.db, now);
      const where = `scenario ${scenario}`;
      assert.equal(server.car.state, browser.state, where);
      if (browser.state === 'driving') assert.equal(server.car.holder?.id, browser.driving?.userId, `${where}: who is on the road`);
      if (browser.state === 'reserved') assert.equal(server.car.holder?.id, browser.current?.userId, `${where}: whose reservation it is`);
      if (browser.state === 'free') assert.equal(server.car.holder, null, where);
      assert.equal(server.next?.id ?? null, browser.next?.id ?? null, `${where}: the next reservation`);
      state[browser.state]++;
    }
    assert.ok(state.driving > 10 && state.reserved > 10 && state.free > 10, `the scenarios cover all three states: ${JSON.stringify(state)}`);
  });
});

test('carNow differs from the Start screen in two documented ways: the next reservation beyond 60 days, and nothing else', async () => {
  await withHousehold(async (h) => {
    const far = insertReservation(h.t, { userId: h.ben.id, start: iso(h, 100 * DAY), end: iso(h, 100 * DAY + HOUR) });
    const now = h.t.clock.now();
    // The browser asks for 60 days ahead and so does not see it; the token API looks as far as the window.
    const reservations = (await h.anna.get(`/api/reservations?status=confirmed&from=${encodeURIComponent(iso(h, -7 * DAY))}&to=${encodeURIComponent(iso(h, 60 * DAY))}`)).body.items;
    assert.equal(browserCarNow(reservations, [], now.toISOString()).next, null);
    const server = carNow(h.t.db, now);
    assert.equal(server.next?.id, far);
    assert.equal(server.car.freeUntil, iso(h, 100 * DAY), 'free until the one 100 days away');
    // A forgotten drive older than 7 days does not mean "on the road" in either.
    insertDraft(h.t, { userId: h.carla.id, start: iso(h, -8 * DAY) });
    assert.equal(carNow(h.t.db, now).car.state, 'free');
    insertDraft(h.t, { userId: h.ben.id, start: iso(h, -6 * DAY) });
    assert.equal(carNow(h.t.db, now).car.state, 'driving');
  });
});

test('carNow: the edges of a reservation are the browser\'s: it starts at its start and is over at its end', async () => {
  await withHousehold(async (h) => {
    const now = h.t.clock.now();
    const nowIso = now.toISOString();
    const ended = insertReservation(h.t, { userId: h.ben.id, start: iso(h, -HOUR), end: nowIso });
    assert.equal(carNow(h.t.db, now).car.state, 'free', 'a reservation that ends right now is over');
    assert.equal(browserCarNow([{ id: ended, userId: h.ben.id, status: 'confirmed', start: iso(h, -HOUR), end: nowIso }] as never[], [], nowIso).state, 'free');
    const starting = insertReservation(h.t, { userId: h.carla.id, start: nowIso, end: iso(h, HOUR) });
    const reserved = carNow(h.t.db, now);
    assert.equal(reserved.car.state, 'reserved', 'one that starts right now has the car');
    assert.equal(reserved.car.holder?.id, h.carla.id);
    assert.equal(reserved.next, null, 'and is not its own next reservation');
    assert.equal(browserCarNow([{ id: starting, userId: h.carla.id, status: 'confirmed', start: nowIso, end: iso(h, HOUR) }] as never[], [], nowIso).state, 'reserved');
  });
});

test('myNextReservation: the first confirmed reservation of the person that has not ended, one in progress included', async () => {
  await withHousehold(async (h) => {
    const nowIso = h.t.clock.now().toISOString();
    assert.equal(myNextReservation(h.t.db, h.anna.id, nowIso), null);
    insertReservation(h.t, { userId: h.anna.id, start: iso(h, -5 * HOUR), end: iso(h, -3 * HOUR) }); // ended
    insertReservation(h.t, { userId: h.anna.id, status: 'pending', createdBy: h.ben.id, start: iso(h, HOUR), end: iso(h, 2 * HOUR) }); // a suggestion
    insertReservation(h.t, { userId: h.ben.id, start: iso(h, 30 * 60_000), end: iso(h, 45 * 60_000) }); // somebody else's
    const going = insertReservation(h.t, { userId: h.anna.id, start: iso(h, -HOUR), end: iso(h, HOUR) });
    const later = insertReservation(h.t, { userId: h.anna.id, start: iso(h, 5 * HOUR), end: iso(h, 6 * HOUR) });
    assert.equal(myNextReservation(h.t.db, h.anna.id, nowIso)?.id, going);
    assert.equal(myNextReservation(h.t.db, h.anna.id, iso(h, 2 * HOUR))?.id, later);
  });
});

// ------------------------------------------------------------------------ docs/API.md

/** Every key of a JSON value, however deep (arrays by all their elements). */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

test('docs/API.md names every field of the real responses, every field it names exists, and its examples have the shape of the real answers', async () => {
  await withHousehold(async (h) => {
    const day = (n: number): string => iso(h, -n * DAY);
    // Everything that makes a key appear: a car in use, a next reservation, a registered drive, damage, an APK date,
    // and money owed in both directions.
    insertReservation(h.t, { userId: h.ben.id, start: iso(h, -HOUR), end: iso(h, HOUR) });
    insertReservation(h.t, { userId: h.anna.id, start: iso(h, DAY), end: iso(h, DAY + HOUR) });
    const past = insertReservation(h.t, { userId: h.anna.id, start: day(3), end: iso(h, -3 * DAY + HOUR), note: 'to the shops' });
    insertUsage(h.t, { userId: h.anna.id, start: day(3), end: iso(h, -3 * DAY + HOUR), odometerStart: 5000, odometerEnd: 5050, reservationId: past });
    insertDamage(h.t, { reportedBy: h.ben.id });
    insertApk(h.t, { userId: h.anna.id, expiresOn: '2026-07-15' });
    for (const [userId, from, to] of [[h.anna.id, 10, 5000], [h.ben.id, 9, 5100], [h.carla.id, 8, 5200]] as const) {
      insertUsage(h.t, { userId, start: day(from), end: iso(h, -from * DAY + HOUR), odometerStart: to, odometerEnd: to + 100 });
    }
    insertFuel(h.t, { userId: h.anna.id, at: day(7), totalCents: 6000 });
    insertUsage(h.t, { userId: h.anna.id, start: day(6), end: iso(h, -6 * DAY + HOUR), odometerStart: 5300, odometerEnd: 5500 });
    insertFuel(h.t, { userId: h.carla.id, at: day(5), totalCents: 6000 });

    const anon = h.t.client();
    const token = await tokenOf(h.anna);
    const get = async (route: string): Promise<Record<string, unknown>> => {
      const r = await anon.get(route, bearer(token));
      assert.equal(r.status, 200, route);
      return r.body as Record<string, unknown>;
    };
    const real = { status: await get('/api/v1/status'), reservations: await get('/api/v1/reservations'), me: await get('/api/v1/me') };
    const me = real.me as { fuel: { owe: unknown[]; owed: unknown[] } };
    assert.ok(me.fuel.owe.length > 0 && me.fuel.owed.length > 0, 'the fixture has money going both ways, so the keys of both lists exist');
    const status = real.status as { car: { holder: unknown }; next: unknown; myNext: unknown };
    assert.ok(status.car.holder && status.next && status.myNext, 'the fixture fills the nullable parts of the status');
    const withDrive = (real.reservations as { items: Array<{ drive: unknown }> }).items.find((i) => i.drive !== null);
    assert.ok(withDrive, 'a reservation with a drive is in the answer');

    const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'API.md'), 'utf8');
    const realKeys = new Set<string>([...keysOf(real.status), ...keysOf(real.reservations), ...keysOf(real.me)]);
    for (const key of realKeys) assert.match(doc, new RegExp(`\`${key}\``), `the document names ${key}`);
    // Every name in the first column of a field table is real.
    const listed = [...doc.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1] as string);
    assert.ok(listed.length >= 40, `${listed.length} fields are listed`);
    for (const key of listed) assert.ok(realKeys.has(key), `the document names ${key}, which no response has`);

    // The three examples (a CRLF checkout must find them too) have the keys of the real answers, at every depth.
    const examples = [...doc.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => JSON.parse(m[1] as string) as unknown);
    assert.equal(examples.length, 3, 'status, reservations, me');
    for (const [i, name] of ['status', 'reservations', 'me'].entries()) {
      assert.deepEqual([...keysOf(examples[i])].sort(), [...keysOf(real[name as keyof typeof real])].sort(), `the ${name} example has the keys of the real answer`);
      assert.deepEqual(Object.keys(examples[i] as object).sort(), Object.keys(real[name as keyof typeof real]).sort());
    }

    // The routes the document describes are the routes there are, and the sentences a reader must not miss are there.
    const v1 = h.t.app.router.routes.filter((r) => r.pattern.startsWith('/api/v1/')).map((r) => `${r.method} ${r.pattern}`);
    for (const route of v1) assert.ok(doc.includes(`## \`${route}\``), `${route} has its own section`);
    assert.match(doc, /Authorization: Bearer/);
    assert.match(doc, /were not run|never run on a real/i, 'the examples are marked as not run on real systems');
    assert.match(doc, /Home\s+Assistant/);
    assert.match(doc, /Apps\s+Script/);
    assert.match(doc, /Google Calendar refreshes/i, 'the slow refresh of Google is said');
    assert.match(doc, /`https:\/\/` address only/, 'only the https address is offered');
    assert.match(doc, /webcal:\/\//, 'and the reason is given');
    assert.match(doc, /`401 unauthenticated`/);
    assert.match(doc, /`429 too_many_attempts`/);
    assert.match(doc, /`429 rate_limited`/);
    assert.match(doc, /60 requests a minute/);
    assert.match(doc, /At most \*\*5\*\* per person/);
    assert.match(doc, /\[STATS-API\.md\]\(STATS-API\.md\)/);
    assert.doesNotMatch(doc, /\bpat_[A-Za-z0-9_-]{43}\b/, 'no real-looking token in the document');
    assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'docs', 'STATS-API.md')), 'the link resolves');
    const stats = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'STATS-API.md'), 'utf8');
    assert.match(stats, /GET \/api\/v1\/stats/, 'the statistics document says it is also served to a token');
  });
});
