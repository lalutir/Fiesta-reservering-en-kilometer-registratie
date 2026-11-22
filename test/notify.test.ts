// Push notifications for what somebody else enters, changes or removes on a person's behalf (src/notify.ts).
//
// Every event gets the same five checks, driven by one table of scenarios:
//   1. it fires: exactly the people it concerns are told, one push per device, with the right words, screen and tag;
//   2. it does not fire to yourself: the same thing done by the person it concerns tells nobody (or nobody extra);
//   3. it does not fire without a device signed up for notifications;
//   4. it does not fire with push switched off, even when devices are on file;
//   5. a push service that throws never changes the answer the person who made the change gets.
// The checks after the table cover the engine itself (the actor and the inactive are dropped, a new event plugs
// in with one table row), the tags, the limits of what the service worker shows, the rule that all words live in
// one module, and that the Inbox and the banners still work for people without a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/db.ts';
import { EVENTS, createNotifier, fit, row, type Events } from '../src/notify.ts';
import { createPush } from '../src/push.ts';
import { S } from '../public/strings.js';
import { formatLocal, localDateKey } from '../shared/time.js';
import {
  FUEL_ODO,
  ODO,
  at,
  createHousehold,
  insertFuel,
  insertReservation,
  insertTicket,
  insertUsage,
  makeSubscriber,
  stubFetch,
  type Client,
  type Household,
  type Json,
  type Reply,
  type StubFetch,
  type Subscriber,
} from './helpers.ts';

type Name = 'admin' | 'anna' | 'ben' | 'carla';
const NAMES: Name[] = ['admin', 'anna', 'ben', 'carla'];
const ENV = { PUSH_CONTACT: 'https://car.example.test' };

interface World {
  h: Household;
  stub: StubFetch;
  people: Record<Name, Client>;
  /** Two devices per person. */
  phones: Record<Name, Subscriber[]>;
}

/**
 * A household of an admin and three members, each with two phones.
 *   'api'   the phones sign up through the subscribe route (push is on)
 *   'rows'  the phones are on file but push is switched off, so nothing may be sent
 *   'none'  nobody has a phone signed up
 */
async function world(devices: 'api' | 'rows' | 'none', handler?: Parameters<typeof stubFetch>[0]): Promise<World> {
  const stub = stubFetch(handler);
  const h = await createHousehold({ env: { ...ENV, ...(devices === 'rows' ? { PUSH_ENABLED: 'false' } : {}) }, fetch: stub.fetch });
  const people: Record<Name, Client> = { admin: h.admin, anna: h.anna, ben: h.ben, carla: h.carla };
  const phones = {} as Record<Name, Subscriber[]>;
  for (const name of NAMES) {
    phones[name] = [0, 1].map((i) => makeSubscriber(`https://fcm.googleapis.com/fcm/send/${name}-${i}`));
    for (const phone of phones[name]) {
      if (devices === 'api') assert.equal((await people[name].post('/api/push/subscribe', phone.subscription)).status, 201);
      if (devices === 'rows') {
        run(h.t.db, 'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)', people[name].id, phone.endpoint, phone.p256dh, phone.auth, at(h.t.clock, 0));
      }
    }
  }
  return { h, stub, people, phones };
}

/** What one person is told: the words, where a tap opens and the tag. */
interface Note {
  title: string;
  body?: RegExp;
  url: string | RegExp;
  tag: string | RegExp;
}

interface Scenario {
  name: string;
  status: number;
  /** Set up the data with direct inserts (they tell nobody); returns what act needs. */
  prepare?: (w: World) => Json | Promise<Json>;
  act: (w: World, c: Json) => Promise<Reply>;
  /** Who is told what. Empty: nobody. */
  told: (w: World, c: Json, reply: Reply) => Partial<Record<Name, Note>>;
  /** The same change made by the person it concerns, or by whoever is the actor in a variant with nobody extra to tell. */
  own?: { status: number; prepare?: Scenario['prepare']; act: Scenario['act']; told?: Scenario['told'] };
  /** Text that must appear in none of the messages (a price, a reason). */
  never?: RegExp;
}

const hours = (w: World, n: number): string => at(w.h.t.clock, n);
const day = (w: World, iso: string): string => localDateKey(iso, w.h.t.config.tz);
const resIdOf = (reply: Reply): number => reply.body.reservation.id;

// ---------------------------------------------------------------- data builders

const confirmed = (w: World, owner: Name, from: number, to: number): number =>
  insertReservation(w.h.t, { userId: w.people[owner].id, start: hours(w, from), end: hours(w, to) });
const suggestion = (w: World, from: Name, to: Name, startH: number, endH: number, status: 'pending' | 'declined' = 'pending'): number =>
  insertReservation(w.h.t, { userId: w.people[to].id, createdBy: w.people[from].id, status, start: hours(w, startH), end: hours(w, endH) });
const drive = (w: World, driver: Name, from = -5, to = -4, extra: { reservationId?: number } = {}): number =>
  insertUsage(w.h.t, { userId: w.people[driver].id, start: hours(w, from), end: hours(w, to), ...ODO, ...extra });
/** A drive whose kilometres are somebody else's. */
const attributed = (w: World, driver: Name, owner: Name): number => {
  const id = drive(w, driver);
  run(w.h.t.db, "UPDATE usage SET km_for = 'person', km_user_id = ?, note = 'Took them to the hospital' WHERE id = ?", w.people[owner].id, id);
  return id;
};
/** Anna drove 100 km, Ben 50 and Carla 50, and Anna fuelled for 60.00: Ben and Carla owe 15.00 each, the admin nothing. */
function fuelled(w: World): number {
  insertUsage(w.h.t, { userId: w.people.anna.id, start: hours(w, -30), end: hours(w, -28), odometerStart: 1000, odometerEnd: 1100 });
  insertUsage(w.h.t, { userId: w.people.ben.id, start: hours(w, -26), end: hours(w, -24), odometerStart: 1100, odometerEnd: 1150 });
  insertUsage(w.h.t, { userId: w.people.carla.id, start: hours(w, -22), end: hours(w, -20), odometerStart: 1150, odometerEnd: 1200 });
  return insertFuel(w.h.t, { userId: w.people.anna.id, at: hours(w, -10), odometer: FUEL_ODO });
}
const FILL_UP = { millilitres: 40_000, totalCents: 6000, odometer: FUEL_ODO };
const paidUrl = (fuelId: number, debtor: Client): string => `/api/fuel/${fuelId}/requests/${debtor.id}/paid`;
/** A payment request for Ben's share (it moves nothing and tells nobody). */
const requested = async (w: World, fuelId: number): Promise<void> => {
  assert.equal((await w.people.anna.post(`/api/fuel/${fuelId}/requests`, { debtorId: w.people.ben.id })).status, 201);
};

const SCENARIOS: Scenario[] = [
  // ---------------------------------------------------------- 1. a suggestion for you
  {
    name: '1. a suggestion made for you',
    status: 201,
    act: (w) => w.people.anna.post('/api/reservations', { userId: w.people.ben.id, start: hours(w, 48), end: hours(w, 50) }),
    told: (_w, _c, r) => ({ ben: { title: 'Anna suggested a reservation for you', body: /Open the Inbox/, url: '/#/inbox', tag: `reservation-${resIdOf(r)}` } }),
    own: { status: 201, act: (w) => w.people.ben.post('/api/reservations', { start: hours(w, 48), end: hours(w, 50) }) },
  },
  {
    name: '1. the suggester changes the suggestion that is in your inbox',
    status: 200,
    prepare: (w) => suggestion(w, 'anna', 'ben', 48, 50),
    act: (w, id) => w.people.anna.patch(`/api/reservations/${id}`, { start: hours(w, 72), end: hours(w, 74) }),
    told: (_w, id) => ({ ben: { title: 'Anna changed a suggestion for you', body: /Now .* \(was /, url: '/#/inbox', tag: `reservation-${id}` } }),
  },
  // -------------------------------------------- 2. your suggestion answered or withdrawn
  {
    name: '2. your suggestion is approved',
    status: 200,
    prepare: (w) => suggestion(w, 'anna', 'ben', 48, 50),
    act: (w, id) => w.people.ben.post(`/api/reservations/${id}/approve`),
    told: (w, id) => ({ anna: { title: 'Ben approved your suggestion', body: /now a confirmed reservation/, url: `/#/?view=day&date=${day(w, hours(w, 48))}`, tag: `reservation-${id}` } }),
  },
  {
    name: '2. your suggestion is declined',
    status: 200,
    prepare: (w) => suggestion(w, 'anna', 'ben', 48, 50),
    act: (w, id) => w.people.ben.post(`/api/reservations/${id}/decline`),
    told: (_w, id) => ({ anna: { title: 'Ben declined your suggestion', url: '/#/inbox', tag: `reservation-${id}` } }),
  },
  {
    name: '2. the suggester withdraws a suggestion that was in your inbox',
    status: 204,
    prepare: (w) => suggestion(w, 'anna', 'ben', 48, 50),
    act: (w, id) => w.people.anna.del(`/api/reservations/${id}`),
    told: (_w, id) => ({ ben: { title: 'Anna withdrew a suggestion for you', url: '/#/inbox', tag: `reservation-${id}` } }),
  },
  {
    name: '2. an admin cancels a suggestion: the person it was for and the suggester both hear',
    status: 204,
    prepare: (w) => suggestion(w, 'anna', 'ben', 48, 50),
    act: (w, id) => w.people.admin.del(`/api/reservations/${id}`),
    told: (_w, id) => ({
      ben: { title: 'Admin cancelled a suggestion made for you', body: /Anna's suggestion/, url: '/#/inbox', tag: `reservation-${id}` },
      anna: { title: 'Admin cancelled your suggestion for Ben', url: '/#/inbox', tag: `reservation-${id}` },
    }),
  },
  {
    name: '2. a suggestion that has lapsed, or was declined, is deleted: nobody is told, nobody can do anything about it',
    status: 204,
    prepare: (w) => ({ lapsed: suggestion(w, 'anna', 'ben', -2, -1), declined: suggestion(w, 'anna', 'ben', 48, 50, 'declined') }),
    act: async (w, c) => {
      assert.equal((await w.people.anna.del(`/api/reservations/${c.declined}`)).status, 204);
      return w.people.anna.del(`/api/reservations/${c.lapsed}`);
    },
    told: () => ({}),
  },
  // -------------------------------------------------- 3. your reservation edited or cancelled
  {
    name: '3. an admin edits your reservation',
    status: 200,
    prepare: (w) => confirmed(w, 'ben', 48, 50),
    act: (w, id) => w.people.admin.patch(`/api/reservations/${id}`, { start: hours(w, 72), end: hours(w, 74) }),
    told: (w, id) => ({ ben: { title: 'Admin changed your reservation', body: /Now .* \(was /, url: `/#/?view=day&date=${day(w, hours(w, 72))}`, tag: `reservation-${id}` } }),
    own: { status: 200, prepare: (w) => confirmed(w, 'ben', 48, 50), act: (w, id) => w.people.ben.patch(`/api/reservations/${id}`, { start: hours(w, 72), end: hours(w, 74) }) },
  },
  {
    name: '3. an admin edits only the note of your reservation: still news, but the note is not in the text',
    status: 200,
    prepare: (w) => confirmed(w, 'ben', 48, 50),
    act: (w, id) => w.people.admin.patch(`/api/reservations/${id}`, { note: 'secret note' }),
    told: (_w, id) => ({ ben: { title: 'Admin changed your reservation', body: /Only the note changed/, url: /^\/#\/\?view=day&date=/, tag: `reservation-${id}` } }),
    never: /secret note/,
  },
  {
    name: '3. an admin cancels your reservation',
    status: 204,
    prepare: (w) => confirmed(w, 'ben', 48, 50),
    act: (w, id) => w.people.admin.del(`/api/reservations/${id}`),
    told: (_w, id) => ({ ben: { title: 'Admin cancelled your reservation', body: /no longer reserved/, url: '/#/', tag: `reservation-${id}` } }),
    own: { status: 204, prepare: (w) => confirmed(w, 'ben', 48, 50), act: (w, id) => w.people.ben.del(`/api/reservations/${id}`) },
  },
  // ----------------------------------------------- 4. a drive logged, edited or deleted in your name
  {
    name: '4. an admin logs a drive in your name',
    status: 201,
    act: (w) => w.people.admin.post('/api/usage', { userId: w.people.ben.id, start: hours(w, -5), end: hours(w, -4), ...ODO }),
    told: (_w, _c, r) => ({ ben: { title: 'Admin logged a drive in your name', body: /50 km/, url: '/#/usage', tag: `usage-${r.body.usage.id}` } }),
    own: { status: 201, act: (w) => w.people.ben.post('/api/usage', { start: hours(w, -5), end: hours(w, -4), ...ODO }) },
  },
  {
    name: '4. an admin edits a drive in your name',
    status: 200,
    prepare: (w) => drive(w, 'ben'),
    act: (w, id) => w.people.admin.patch(`/api/usage/${id}`, { odometerEnd: 10_060 }),
    told: (_w, id) => ({ ben: { title: 'Admin changed a drive in your name', body: /60 km/, url: '/#/usage', tag: `usage-${id}` } }),
    own: { status: 200, prepare: (w) => drive(w, 'ben'), act: (w, id) => w.people.ben.patch(`/api/usage/${id}`, { odometerEnd: 10_060 }) },
  },
  {
    name: '4. an admin deletes a drive in your name',
    status: 204,
    prepare: (w) => drive(w, 'ben'),
    act: (w, id) => w.people.admin.del(`/api/usage/${id}`),
    told: (_w, id) => ({ ben: { title: 'Admin deleted a drive in your name', url: '/#/usage', tag: `usage-${id}` } }),
    own: { status: 204, prepare: (w) => drive(w, 'ben'), act: (w, id) => w.people.ben.del(`/api/usage/${id}`) },
  },
  {
    name: '4. an admin moves a drive from you to somebody else: you hear it is no longer yours, they hear it is theirs',
    status: 200,
    prepare: (w) => drive(w, 'ben'),
    act: (w, id) => w.people.admin.patch(`/api/usage/${id}`, { userId: w.people.carla.id }),
    told: (_w, id) => ({
      ben: { title: 'Admin took a drive off your name', url: '/#/usage', tag: `usage-${id}` },
      carla: { title: 'Admin logged a drive in your name', url: '/#/usage', tag: `usage-${id}` },
    }),
  },
  {
    name: '4. another member says "I drove this" on your reservation',
    status: 201,
    prepare: (w) => confirmed(w, 'ben', -6, -4),
    act: (w, id) => w.people.anna.post('/api/usage', { start: hours(w, -5), end: hours(w, -4), ...ODO, reservationId: id }),
    told: (w, _id, r) => ({ ben: { title: 'Anna registered a drive on your reservation', body: /your reservation of /, url: '/#/history', tag: `usage-${r.body.usage.id}` } }),
    own: { status: 201, prepare: (w) => confirmed(w, 'ben', -6, -4), act: (w, id) => w.people.ben.post('/api/usage', { start: hours(w, -5), end: hours(w, -4), ...ODO, reservationId: id }) },
  },
  {
    name: '4. the other member edits that drive',
    status: 200,
    prepare: (w) => drive(w, 'anna', -5, -4, { reservationId: confirmed(w, 'ben', -6, -4) }),
    act: (w, id) => w.people.anna.patch(`/api/usage/${id}`, { odometerEnd: 10_070 }),
    told: (_w, id) => ({ ben: { title: 'Anna changed a drive on your reservation', url: '/#/history', tag: `usage-${id}` } }),
  },
  {
    name: '4. the other member deletes that drive',
    status: 204,
    prepare: (w) => drive(w, 'anna', -5, -4, { reservationId: confirmed(w, 'ben', -6, -4) }),
    act: (w, id) => w.people.anna.del(`/api/usage/${id}`),
    told: (_w, id) => ({ ben: { title: 'Anna removed a drive from your reservation', url: '/#/history', tag: `usage-${id}` } }),
  },
  {
    name: '4. an admin logs a drive for one member on the reservation of another: both are told, once each',
    status: 201,
    prepare: (w) => confirmed(w, 'ben', -6, -4),
    act: (w, id) => w.people.admin.post('/api/usage', { userId: w.people.anna.id, start: hours(w, -5), end: hours(w, -4), ...ODO, reservationId: id }),
    told: (_w, _id, r) => ({
      anna: { title: 'Admin logged a drive in your name', url: '/#/usage', tag: `usage-${r.body.usage.id}` },
      ben: { title: 'Admin registered a drive on your reservation', url: '/#/history', tag: `usage-${r.body.usage.id}` },
    }),
  },
  {
    name: '4. an admin logs a drive in your name on your own reservation: you hear once, not twice',
    status: 201,
    prepare: (w) => confirmed(w, 'ben', -6, -4),
    act: (w, id) => w.people.admin.post('/api/usage', { userId: w.people.ben.id, start: hours(w, -5), end: hours(w, -4), ...ODO, reservationId: id }),
    told: (_w, _id, r) => ({ ben: { title: 'Admin logged a drive in your name', url: '/#/usage', tag: `usage-${r.body.usage.id}` } }),
  },
  // -------------------------------------------------------- 5. kilometres attributed to you
  {
    name: '5. another driver registers kilometres as yours',
    status: 201,
    act: (w) =>
      w.people.anna.post('/api/usage', { start: hours(w, -5), end: hours(w, -4), ...ODO, kmFor: 'person', kmUserId: w.people.ben.id, note: 'Took Ben to the hospital' }),
    told: (_w, _c, r) => ({ ben: { title: 'Anna registered kilometres as yours', body: /50 km on /, url: '/#/usage', tag: `usage-${r.body.usage.id}` } }),
    never: /hospital/,
    // Nobody tells the actor: an admin logs Anna's drive and puts the kilometres on their own name, so only Anna (who drove) hears.
    own: {
      status: 201,
      act: (w) => w.people.admin.post('/api/usage', { userId: w.people.anna.id, start: hours(w, -5), end: hours(w, -4), ...ODO, kmFor: 'person', kmUserId: w.people.admin.id, note: 'Mine' }),
      told: (_w, _c, r) => ({ anna: { title: 'Admin logged a drive in your name', url: '/#/usage', tag: `usage-${r.body.usage.id}` } }),
    },
  },
  {
    name: '5. the driver changes the kilometres that are yours',
    status: 200,
    prepare: (w) => attributed(w, 'anna', 'ben'),
    act: (w, id) => w.people.anna.patch(`/api/usage/${id}`, { odometerEnd: 10_080 }),
    told: (_w, id) => ({ ben: { title: 'Anna changed kilometres registered as yours', body: /80 km on /, url: '/#/usage', tag: `usage-${id}` } }),
  },
  {
    name: '5. the driver takes the kilometres off your name',
    status: 200,
    prepare: (w) => attributed(w, 'anna', 'ben'),
    act: (w, id) => w.people.anna.patch(`/api/usage/${id}`, { kmFor: 'self' }),
    told: (_w, id) => ({ ben: { title: 'Anna removed kilometres that were yours', body: /no longer yours/, url: '/#/usage', tag: `usage-${id}` } }),
  },
  {
    name: '5. the driver deletes the drive with your kilometres',
    status: 204,
    prepare: (w) => attributed(w, 'anna', 'ben'),
    act: (w, id) => w.people.anna.del(`/api/usage/${id}`),
    told: (_w, id) => ({ ben: { title: 'Anna removed kilometres that were yours', url: '/#/usage', tag: `usage-${id}` } }),
  },
  {
    name: '5. the driver moves the kilometres from you to somebody else: you hear they are gone, they hear they are theirs',
    status: 200,
    prepare: (w) => attributed(w, 'anna', 'ben'),
    act: (w, id) => w.people.anna.patch(`/api/usage/${id}`, { kmUserId: w.people.carla.id }),
    told: (_w, id) => ({
      ben: { title: 'Anna removed kilometres that were yours', url: '/#/usage', tag: `usage-${id}` },
      carla: { title: 'Anna registered kilometres as yours', url: '/#/usage', tag: `usage-${id}` },
    }),
  },
  {
    name: '5. an edit that changes nothing tells nobody',
    status: 200,
    prepare: (w) => attributed(w, 'anna', 'ben'),
    act: (w, id) => w.people.anna.patch(`/api/usage/${id}`, { odometerEnd: 10_050 }),
    told: () => ({}),
  },
  // ------------------------------------------------------------------------------- 6. fuel
  {
    name: '6. a fill-up is edited and your share changes',
    status: 200,
    prepare: (w) => fuelled(w),
    act: (w, id) => w.people.anna.patch(`/api/fuel/${id}`, { totalCents: 7000 }),
    told: (_w, id) => ({
      ben: { title: 'Anna changed their fill-up', body: /went from EUR 15\.00 to EUR 17\.50/, url: '/#/history', tag: `fuel-${id}` },
      carla: { title: 'Anna changed their fill-up', body: /went from EUR 15\.00 to EUR 17\.50/, url: '/#/history', tag: `fuel-${id}` },
    }),
  },
  {
    name: '6. a fill-up is edited but nobody\'s share moves (only the note): nobody is told',
    status: 200,
    prepare: (w) => fuelled(w),
    act: (w, id) => w.people.anna.patch(`/api/fuel/${id}`, { note: 'Shell, Zwolle' }),
    told: () => ({}),
  },
  {
    name: '6. a fill-up is deleted and your share goes with it',
    status: 204,
    prepare: (w) => fuelled(w),
    act: (w, id) => w.people.anna.del(`/api/fuel/${id}`),
    told: (_w, id) => ({
      ben: { title: 'Anna deleted their fill-up', body: /your share of the fuel costs changed/, url: '/#/history', tag: `fuel-${id}` },
      carla: { title: 'Anna deleted their fill-up', url: '/#/history', tag: `fuel-${id}` },
    }),
  },
  {
    name: '6. an admin edits the fill-up of the fueler: the fueler hears it was done to theirs, the debtors that their share moved',
    status: 200,
    prepare: (w) => fuelled(w),
    act: (w, id) => w.people.admin.patch(`/api/fuel/${id}`, { totalCents: 7000 }),
    told: (_w, id) => ({
      anna: { title: 'Admin changed your fill-up', url: '/#/fuel', tag: `fuel-${id}` },
      ben: { title: "Admin changed Anna's fill-up", body: /EUR 15\.00 to EUR 17\.50/, url: '/#/history', tag: `fuel-${id}` },
      carla: { title: "Admin changed Anna's fill-up", url: '/#/history', tag: `fuel-${id}` },
    }),
  },
  {
    name: '6. an admin changes only the note of the fueler\'s fill-up: only the fueler hears',
    status: 200,
    prepare: (w) => fuelled(w),
    act: (w, id) => w.people.admin.patch(`/api/fuel/${id}`, { note: 'Shell' }),
    told: (_w, id) => ({ anna: { title: 'Admin changed your fill-up', url: '/#/fuel', tag: `fuel-${id}` } }),
  },
  {
    name: '6. an admin deletes the fueler\'s fill-up',
    status: 204,
    prepare: (w) => fuelled(w),
    act: (w, id) => w.people.admin.del(`/api/fuel/${id}`),
    told: (_w, id) => ({
      anna: { title: 'Admin deleted your fill-up', url: '/#/fuel', tag: `fuel-${id}` },
      ben: { title: "Admin deleted Anna's fill-up", url: '/#/history', tag: `fuel-${id}` },
      carla: { title: "Admin deleted Anna's fill-up", url: '/#/history', tag: `fuel-${id}` },
    }),
  },
  {
    name: '6. an admin registers a fill-up in your name: you hear it, and so do the people who owe you',
    status: 201,
    prepare: (w) => {
      fuelled(w);
      run(w.h.t.db, 'DELETE FROM fuel');
    },
    act: (w) => w.people.admin.post('/api/fuel', { userId: w.people.anna.id, at: hours(w, -10), ...FILL_UP }),
    told: (_w, _c, r) => ({
      anna: { title: 'Admin registered a fill-up in your name', body: /EUR 60\.00/, url: '/#/fuel', tag: `fuel-${r.body.fuel.id}` },
      ben: { title: 'Anna fuelled the car', body: /You owe Anna EUR 15\.00/, url: '/#/history', tag: `fuel-${r.body.fuel.id}` },
      carla: { title: 'Anna fuelled the car', url: '/#/history', tag: `fuel-${r.body.fuel.id}` },
    }),
    // Registering your own fill-up tells only the people who owe you, as it always did.
    own: {
      status: 201,
      prepare: (w) => {
        fuelled(w);
        run(w.h.t.db, 'DELETE FROM fuel');
      },
      act: (w) => w.people.anna.post('/api/fuel', { at: hours(w, -10), ...FILL_UP }),
      told: (_w, _c, r) => ({
        ben: { title: 'Anna fuelled the car', url: '/#/history', tag: `fuel-${r.body.fuel.id}` },
        carla: { title: 'Anna fuelled the car', url: '/#/history', tag: `fuel-${r.body.fuel.id}` },
      }),
    },
  },
  {
    name: '6. the fueler marks your share as paid',
    status: 200,
    prepare: async (w) => {
      const id = fuelled(w);
      await requested(w, id);
      return id;
    },
    act: (w, id) => w.people.anna.post(paidUrl(id, w.people.ben), { paid: true }),
    told: (_w, id) => ({ ben: { title: 'Anna marked your fuel share as paid', body: /EUR 15\.00/, url: '/#/history', tag: `fuel-${id}` } }),
  },
  {
    name: '6. an admin marks your share as paid',
    status: 200,
    prepare: async (w) => {
      const id = fuelled(w);
      await requested(w, id);
      return id;
    },
    act: (w, id) => w.people.admin.post(paidUrl(id, w.people.ben), { paid: true }),
    told: (_w, id) => ({ ben: { title: 'Admin marked your fuel share as paid', url: '/#/history', tag: `fuel-${id}` } }),
  },
  {
    name: '6. the fueler takes the paid mark off your share again',
    status: 200,
    prepare: async (w) => {
      const id = fuelled(w);
      await requested(w, id);
      assert.equal((await w.people.anna.post(paidUrl(id, w.people.ben), { paid: true })).status, 200);
      return id;
    },
    act: (w, id) => w.people.anna.post(paidUrl(id, w.people.ben), { paid: false }),
    told: (_w, id) => ({ ben: { title: 'Anna marked your fuel share as not paid', body: /open again/, url: '/#/history', tag: `fuel-${id}` } }),
  },
  {
    name: '6. the debtor presses "I have paid": the fueler is told, the debtor is not',
    status: 200,
    prepare: (w) => fuelled(w),
    act: (w, id) => w.people.ben.post(paidUrl(id, w.people.ben), { paid: true }),
    told: (w, id) => ({ anna: { title: 'Ben says the fuel is paid', body: /EUR 15\.00/, url: '/#/fuel', tag: `fuel-${id}-paid-${w.people.ben.id}` } }),
  },
  {
    name: '6. pressing "I have paid" twice tells the fueler once: the second press changed nothing',
    status: 200,
    prepare: async (w) => {
      const id = fuelled(w);
      assert.equal((await w.people.ben.post(paidUrl(id, w.people.ben), { paid: true })).status, 200);
      return id;
    },
    act: (w, id) => w.people.ben.post(paidUrl(id, w.people.ben), { paid: true }),
    told: () => ({}),
  },
  // ----------------------------------------------------------------------------- 7. tickets
  {
    name: '7. a traffic ticket is entered for a moment you were driving',
    status: 201,
    prepare: (w) => drive(w, 'ben', -6, -4),
    act: (w) => w.people.anna.post('/api/tickets', { at: hours(w, -5), amountCents: 7500, reason: 'Speeding past the school' }),
    told: (_w, _c, r) => ({ ben: { title: 'Anna entered a traffic ticket', body: /has you down as the driver/, url: '/#/tickets', tag: `ticket-${r.body.ticket.id}` } }),
    never: /7500|75[.,]00|\b75\b|Speeding|school/,
    own: { status: 201, prepare: (w) => drive(w, 'ben', -6, -4), act: (w) => w.people.ben.post('/api/tickets', { at: hours(w, -5) }) },
  },
  {
    name: '7. such a ticket is edited (price and reason): still told, still without them',
    status: 200,
    prepare: (w) => ({ ticket: insertTicket(w.h.t, { userId: w.people.anna.id, at: hours(w, -5), amountCents: 7500, reason: 'Speeding' }), drive: drive(w, 'ben', -6, -4) }),
    act: (w, c) => w.people.anna.patch(`/api/tickets/${c.ticket}`, { amountCents: 9000, reason: 'Red light' }),
    told: (_w, c) => ({ ben: { title: 'Anna changed a traffic ticket', url: '/#/tickets', tag: `ticket-${c.ticket}` } }),
    never: /9000|90[.,]00|Red light|Speeding/,
    own: {
      status: 200,
      prepare: (w) => ({ ticket: insertTicket(w.h.t, { userId: w.people.ben.id, at: hours(w, -5) }), drive: drive(w, 'ben', -6, -4) }),
      act: (w, c) => w.people.ben.patch(`/api/tickets/${c.ticket}`, { amountCents: 9000 }),
    },
  },
  {
    name: '7. a ticket is moved to a moment somebody else drove: the one it left hears it is gone, the new one hears it is theirs',
    status: 200,
    prepare: (w) => ({ ticket: insertTicket(w.h.t, { userId: w.people.anna.id, at: hours(w, -5) }), ben: drive(w, 'ben', -6, -4), carla: drive(w, 'carla', -3, -2) }),
    act: (w, c) => w.people.anna.patch(`/api/tickets/${c.ticket}`, { at: hours(w, -2.5) }),
    told: (_w, c) => ({
      ben: { title: 'Anna changed a traffic ticket', body: /no longer linked to you/, url: '/#/tickets', tag: `ticket-${c.ticket}` },
      carla: { title: 'Anna entered a traffic ticket', url: '/#/tickets', tag: `ticket-${c.ticket}` },
    }),
  },
  {
    name: '7. a ticket linked to you is deleted',
    status: 204,
    prepare: (w) => ({ ticket: insertTicket(w.h.t, { userId: w.people.anna.id, at: hours(w, -5), amountCents: 7500 }), drive: drive(w, 'ben', -6, -4) }),
    act: (w, c) => w.people.anna.del(`/api/tickets/${c.ticket}`),
    told: (_w, c) => ({ ben: { title: 'Anna deleted a traffic ticket', body: /is gone/, url: '/#/tickets', tag: `ticket-${c.ticket}` } }),
    own: {
      status: 204,
      prepare: (w) => ({ ticket: insertTicket(w.h.t, { userId: w.people.ben.id, at: hours(w, -5) }), drive: drive(w, 'ben', -6, -4) }),
      act: (w, c) => w.people.ben.del(`/api/tickets/${c.ticket}`),
    },
  },
  {
    name: '7. a ticket for a moment nobody was on record as driving tells nobody',
    status: 201,
    act: (w) => w.people.anna.post('/api/tickets', { at: hours(w, -5) }),
    told: () => ({}),
  },
];

// ------------------------------------------------------------------ the five checks

/** Every url a notification carries must open a screen of the app. */
const ROUTE_NAMES = ((): Set<string> => {
  const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  const views = /const VIEWS = \{([^}]*)\}/.exec(app)?.[1] ?? '';
  return new Set(views.split(',').map((v) => v.trim()).filter(Boolean));
})();
function opensAScreen(url: string): boolean {
  const m = /^\/#\/([a-z]*)(\?.*)?$/.exec(url);
  if (!m) return false;
  return m[1] === '' ? ROUTE_NAMES.has('agenda') : ROUTE_NAMES.has(m[1] as string);
}

function matches(actual: string, want: string | RegExp, what: string): void {
  if (typeof want === 'string') assert.equal(actual, want, what);
  else assert.match(actual, want, what);
}

/** The pushes that went out must be exactly those in `told`: one per device of each person, nothing for anybody else. */
async function assertTold(w: World, told: Partial<Record<Name, Note>>, never?: RegExp): Promise<void> {
  await w.h.t.app.idle();
  const wanted = (Object.keys(told) as Name[]).flatMap((name) => w.phones[name].map((phone) => ({ name, phone })));
  assert.deepEqual(w.stub.calls.map((c) => c.url).sort(), wanted.map((x) => x.phone.endpoint).sort(), 'exactly one push per device of exactly the people it concerns');
  for (const { name, phone } of wanted) {
    const note = told[name] as Note;
    const message = phone.read(w.stub.calls.find((c) => c.url === phone.endpoint)!);
    assert.equal(message.title, note.title, `${name}: title`);
    if (note.body) assert.match(message.body, note.body, `${name}: body`);
    matches(message.url, note.url, `${name}: where a tap opens`);
    matches(message.tag, note.tag, `${name}: tag`);
    assert.ok(opensAScreen(message.url), `${name}: ${message.url} is a screen of the app`);
    assert.ok(message.title.length <= 100 && message.body.length <= 300 && message.tag.length <= 64, `${name}: fits what the service worker shows`);
    if (never) assert.doesNotMatch(JSON.stringify(message), never, `${name}: must not say that`);
  }
  assert.ok(!w.h.t.logs.some((l) => l['event'] === 'notify.error'), 'no failure was logged');
}

/** Prepare, then forget the pushes that preparing may have caused. */
async function prepared(w: World, prepare: Scenario['prepare']): Promise<Json> {
  const context = await prepare?.(w);
  await w.h.t.app.idle();
  w.stub.calls.length = 0;
  return context;
}

for (const sc of SCENARIOS) {
  test(`fires: ${sc.name}`, async () => {
    const w = await world('api');
    try {
      const c = await prepared(w, sc.prepare);
      const reply = await sc.act(w, c);
      assert.equal(reply.status, sc.status, reply.text);
      await assertTold(w, sc.told(w, c, reply), sc.never);
    } finally {
      await w.h.t.close();
    }
  });

  if (sc.own) {
    const own = sc.own;
    test(`not to yourself: ${sc.name} (done by the person it concerns)`, async () => {
      const w = await world('api');
      try {
        const c = await prepared(w, own.prepare);
        const reply = await own.act(w, c);
        assert.equal(reply.status, own.status, reply.text);
        await assertTold(w, own.told ? own.told(w, c, reply) : {});
      } finally {
        await w.h.t.close();
      }
    });
  }

  test(`without a device: ${sc.name}`, async () => {
    const w = await world('none');
    try {
      const c = await prepared(w, sc.prepare);
      const reply = await sc.act(w, c);
      assert.equal(reply.status, sc.status, reply.text);
      await assertTold(w, {});
    } finally {
      await w.h.t.close();
    }
  });

  test(`push switched off: ${sc.name}`, async () => {
    const w = await world('rows');
    try {
      const c = await prepared(w, sc.prepare);
      const reply = await sc.act(w, c);
      assert.equal(reply.status, sc.status, reply.text);
      await assertTold(w, {});
    } finally {
      await w.h.t.close();
    }
  });

  test(`a push service that fails does not change the answer: ${sc.name}`, async () => {
    const w = await world('api', () => {
      throw new Error('push service down');
    });
    try {
      const c = await prepared(w, sc.prepare);
      const reply = await sc.act(w, c);
      assert.equal(reply.status, sc.status, reply.text);
      await w.h.t.app.idle();
      const planned = Object.keys(sc.told(w, c, reply)).length;
      assert.equal(w.stub.calls.length > 0, planned > 0, 'the sends were attempted exactly when somebody was to be told');
      assert.ok(!w.h.t.logs.some((l) => l['event'] === 'error'), 'no server error was logged');
      assert.ok(!JSON.stringify(w.h.t.logs).includes('push service down'), 'the message of the failure is not logged, only that there was one');
    } finally {
      await w.h.t.close();
    }
  });
}

// ------------------------------------------------------- the engine and its rules

test('a push service that never answers neither delays nor fails the change, and shutdown waits for it', async () => {
  // Every device is a separate send, and each one waits until released.
  const waiting: Array<() => void> = [];
  const release = (): void => void waiting.splice(0).forEach((resolve) => resolve());
  const w = await world('api', () => new Promise<Response>((resolve) => void waiting.push(() => resolve(new Response(null, { status: 201 })))));
  try {
    const reply = await w.people.anna.post('/api/reservations', { userId: w.people.ben.id, start: hours(w, 48), end: hours(w, 50) });
    assert.equal(reply.status, 201, reply.text);
    assert.ok(w.stub.calls.length > 0, 'the send was started');
    assert.equal((await w.people.ben.get('/api/inbox')).body.incomingCount, 1, 'and the suggestion is saved');
    let closed = false;
    const closing = w.h.t.app.close().then(() => void (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, false, 'close() is still waiting for the sends');
    release();
    await closing;
    assert.equal(closed, true);
  } finally {
    release();
    await w.h.t.close();
  }
});

test('the notification is sent after the answer: the route has already returned when the work starts', async () => {
  const w = await world('api');
  try {
    // Nothing is looked up or sent while the route runs: the event is built, and everything else waits for the next turn of the event loop.
    let looked = 0;
    const spy = createNotifier(
      w.h.t.ctx,
      {
        enabled: true,
        publicKey: () => '',
        send: async () => 'ok',
        subscriptionsOf: () => {
          looked++;
          return [];
        },
      } as never,
    );
    spy.emit('reservation.suggested', () => ({
      actor: { id: w.people.anna.id, displayName: 'Anna' },
      reservation: { id: 1, userId: w.people.ben.id, userName: 'Ben', createdBy: w.people.anna.id, createdByName: 'Anna', status: 'pending', start: hours(w, 48), end: hours(w, 50), note: '' },
    }));
    assert.equal(looked, 0, 'not inside the call');
    await spy.idle();
    assert.equal(looked, 1, 'but done by the time idle() resolves');
  } finally {
    await w.h.t.close();
  }
});

test('the engine drops the actor, the inactive and the same person twice, and sends one push per device', async () => {
  const w = await world('api');
  try {
    const { anna, ben, carla, admin } = w.people;
    run(w.h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', carla.id);
    const table = {
      ...EVENTS,
      'test.everybody': row<{ actor: { id: number; displayName: string }; line: string }, { userId: number; why: string }>({
        // Everybody, the actor and the inactive included, and Ben twice with different reasons: only the first entry for a person counts.
        who: (_e, dir) => [...dir.activeUserIds(), anna.id, carla.id, ben.id, ben.id].map((userId, i) => ({ userId, why: `entry ${i}` })),
        text: (e, a) => ({ title: e.line, body: a.why }),
        link: () => '/#/history',
        tag: () => 'test-1',
      }),
    };
    const notifier = createNotifier<Events & { 'test.everybody': { actor: { id: number; displayName: string }; line: string } }>(w.h.t.ctx, createPush(w.h.t.ctx), table);
    notifier.emit('test.everybody', () => ({ actor: { id: anna.id, displayName: 'Anna' }, line: 'Hello all' }));
    await notifier.idle();
    const told = w.stub.calls.map((c) => c.url).sort();
    const devices = (n: Name): string[] => w.phones[n].map((p) => p.endpoint);
    assert.deepEqual(told, [...devices('admin'), ...devices('ben')].sort(), 'the admin and Ben, two devices each: not Anna (the actor), not Carla (deactivated), Ben once');
    assert.equal(ben.id > 0 && admin.id > 0, true);
  } finally {
    await w.h.t.close();
  }
});

test('a new kind of event plugs in with one table row: the damage report that goes to everybody needs no change to the notifier', async () => {
  const w = await world('api');
  try {
    type Damage = { actor: { id: number; displayName: string }; reportId: number };
    const table = {
      ...EVENTS,
      'damage.reported': row<Damage, { userId: number }>({
        who: (_e, dir) => dir.activeUserIds().map((userId) => ({ userId })),
        text: (e) => ({ title: `${e.actor.displayName} reported damage`, body: 'Open the app to see it.' }),
        link: () => '/#/history',
        tag: (e) => `damage-${e.reportId}`,
      }),
    };
    const notifier = createNotifier<Events & { 'damage.reported': Damage }>(w.h.t.ctx, createPush(w.h.t.ctx), table);
    notifier.emit('damage.reported', () => ({ actor: { id: w.people.ben.id, displayName: 'Ben' }, reportId: 9 }));
    await notifier.idle();
    const reached = new Set(w.stub.calls.map((c) => c.url));
    for (const name of ['admin', 'anna', 'carla'] as const) for (const phone of w.phones[name]) assert.ok(reached.has(phone.endpoint), `${name} is told`);
    for (const phone of w.phones.ben) assert.ok(!reached.has(phone.endpoint), 'not the one who reported it');
    assert.equal(w.stub.calls.length, 6);
    const first = w.phones.anna[0]!.read(w.stub.calls.find((c) => c.url === w.phones.anna[0]!.endpoint)!);
    assert.deepEqual({ ...first }, { title: 'Ben reported damage', body: 'Open the app to see it.', url: '/#/history', tag: 'damage-9' });
  } finally {
    await w.h.t.close();
  }
});

test('a person who is deactivated is never told, even when their device is still on file', async () => {
  const w = await world('api');
  try {
    drive(w, 'ben', -6, -4);
    run(w.h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', w.people.ben.id);
    assert.equal((await w.people.anna.post('/api/tickets', { at: hours(w, -5) })).status, 201);
    await assertTold(w, {});
  } finally {
    await w.h.t.close();
  }
});

test('one broken recipient or text does not stop the others, and the failure is logged by the name of the error only', async () => {
  const w = await world('api');
  try {
    const table = {
      ...EVENTS,
      'test.two': row<{ actor: { id: number; displayName: string } }, { userId: number }>({
        who: () => [{ userId: w.people.admin.id }, { userId: w.people.ben.id }],
        text: (_e, a) => {
          if (a.userId === w.people.admin.id) throw new RangeError('boom with https://fcm.googleapis.com/fcm/send/SECRET');
          return { title: 'Hello', body: 'You' };
        },
        link: () => '/#/',
        tag: () => 'two',
      }),
    };
    const notifier = createNotifier<Events & { 'test.two': { actor: { id: number; displayName: string } } }>(w.h.t.ctx, createPush(w.h.t.ctx), table);
    assert.doesNotThrow(() => notifier.emit('test.two', () => ({ actor: { id: w.people.anna.id, displayName: 'Anna' } })));
    await notifier.idle();
    assert.equal(w.stub.calls.length, 2, "Ben's two devices were still told");
    const errors = w.h.t.logs.filter((l) => l['event'] === 'notify.error');
    assert.deepEqual(errors.map((l) => ({ ...l })), [{ event: 'notify.error', kind: 'test.two', userId: w.people.admin.id, reason: 'RangeError' }]);
    assert.ok(!JSON.stringify(w.h.t.logs).includes('SECRET'));
    // And a payload that cannot be built (a route's own mistake) is logged and dropped, never thrown into the request.
    assert.doesNotThrow(() =>
      notifier.emit('test.two', () => {
        throw new TypeError('no payload');
      }),
    );
  } finally {
    await w.h.t.close();
  }
});

test('later changes to the same record carry the same tag, so they replace the notification on the phone; other records do not', async () => {
  const w = await world('api');
  try {
    const tagsOf = (name: Name): string[] => w.stub.calls.filter((c) => w.phones[name][0]!.endpoint === c.url).map((c) => w.phones[name][0]!.read(c).tag);
    const reply = await w.people.anna.post('/api/reservations', { userId: w.people.ben.id, start: hours(w, 48), end: hours(w, 50) });
    const id = resIdOf(reply);
    await w.h.t.app.idle();
    assert.equal((await w.people.anna.patch(`/api/reservations/${id}`, { start: hours(w, 72), end: hours(w, 74) })).status, 200);
    await w.h.t.app.idle();
    assert.equal((await w.people.anna.del(`/api/reservations/${id}`)).status, 204);
    await w.h.t.app.idle();
    const other = await w.people.anna.post('/api/reservations', { userId: w.people.ben.id, start: hours(w, 100), end: hours(w, 101) });
    await w.h.t.app.idle();
    assert.deepEqual(tagsOf('ben'), [`reservation-${id}`, `reservation-${id}`, `reservation-${id}`, `reservation-${resIdOf(other)}`]);

    // A fill-up: the push to the debtor when it is registered, when it is edited and when the share is marked paid share one tag.
    const fuelId = fuelled(w);
    await requested(w, fuelId);
    w.stub.calls.length = 0;
    assert.equal((await w.people.anna.patch(`/api/fuel/${fuelId}`, { totalCents: 7000 })).status, 200);
    assert.equal((await w.people.anna.post(paidUrl(fuelId, w.people.ben), { paid: true })).status, 200);
    await w.h.t.app.idle();
    assert.deepEqual(tagsOf('ben'), [`fuel-${fuelId}`, `fuel-${fuelId}`]);
    // Two debtors who say they paid are two different messages for the fueler.
    w.stub.calls.length = 0;
    assert.equal((await w.people.carla.post(paidUrl(fuelId, w.people.carla), { paid: true })).status, 200);
    await w.h.t.app.idle();
    assert.equal((await w.people.ben.post(paidUrl(fuelId, w.people.ben), { paid: true })).status, 200, 'Ben already paid: nothing new');
    await w.h.t.app.idle();
    assert.deepEqual(tagsOf('anna'), [`fuel-${fuelId}-paid-${w.people.carla.id}`]);
  } finally {
    await w.h.t.close();
  }
});

test('the Inbox and the km banner keep working for somebody without a device: the notification is an addition, not a replacement', async () => {
  const w = await world('none');
  try {
    assert.equal((await w.people.anna.post('/api/reservations', { userId: w.people.ben.id, start: hours(w, 48), end: hours(w, 50) })).status, 201);
    const inbox = (await w.people.ben.get('/api/inbox')).body;
    assert.equal(inbox.incomingCount, 1, 'the suggestion waits in the Inbox');
    assert.equal(inbox.incoming[0].createdByName, 'Anna');
    // Kilometres put on Ben's name by Anna are on his Drives tab, and a reservation of his without kilometres is on the banner.
    const id = attributed(w, 'anna', 'ben');
    const summary = (await w.people.ben.get('/api/usage/summary')).body;
    assert.equal(summary.items.find((i: Json) => i.userId === w.people.ben.id).km, 50);
    assert.equal((await w.people.ben.get('/api/usage')).body.items.find((u: Json) => u.id === id).kmUserName, 'Ben');
    // (Anna's drive overlaps nothing of Ben's: a drive by anybody that overlaps a reservation counts as registering it.)
    confirmed(w, 'ben', -30, -28);
    assert.equal((await w.people.ben.get('/api/usage/pending')).body.count, 1);
    await w.h.t.app.idle();
    assert.equal(w.stub.calls.length, 0);
  } finally {
    await w.h.t.close();
  }
});

test('names that are as long as they can be never push a message over what the service worker shows or a push service takes', async () => {
  const w = await world('api');
  try {
    // Display names may be 60 characters, and multi-byte characters weigh more than one byte.
    for (const [name, user] of [['admin', 'A'], ['anna', 'N'], ['ben', 'B'], ['carla', 'C']] as const) {
      run(w.h.t.db, 'UPDATE users SET display_name = ? WHERE id = ?', (name === 'ben' ? '🚗' : user).repeat(60), w.people[name].id);
    }
    const kept: Json[] = [];
    const look = async (act: () => Promise<Reply>): Promise<void> => {
      w.stub.calls.length = 0;
      await act();
      await w.h.t.app.idle();
      for (const call of w.stub.calls) {
        const phone = NAMES.flatMap((n) => w.phones[n]).find((p) => p.endpoint === call.url)!;
        kept.push(phone.read(call));
      }
    };
    const fuelId = fuelled(w);
    await look(() => w.people.anna.post('/api/reservations', { userId: w.people.ben.id, start: hours(w, 48), end: hours(w, 50) }));
    await look(() => w.people.admin.post('/api/usage', { userId: w.people.ben.id, start: hours(w, -5), end: hours(w, -4), ...ODO, kmFor: 'person', kmUserId: w.people.carla.id, note: 'x' }));
    await look(() => w.people.anna.patch(`/api/fuel/${fuelId}`, { totalCents: 99_999 }));
    await look(() => w.people.ben.post(paidUrl(fuelId, w.people.ben), { paid: true }));
    await look(() => w.people.admin.del(`/api/fuel/${fuelId}`));
    assert.ok(kept.length >= 8, `${kept.length} messages were looked at`);
    for (const m of kept) {
      assert.ok([...m.title].length <= 100 && [...m.body].length <= 300 && [...m.tag].length <= 64 && [...m.url].length <= 300, JSON.stringify(m));
      assert.ok(Buffer.byteLength(JSON.stringify(m)) < 1000, 'small enough for a push service');
    }
    assert.ok(kept.some((m) => m.title.includes('…')), 'a long name is shortened on purpose');
  } finally {
    await w.h.t.close();
  }
});

test('whatever a table row produces, the engine delivers it within what the service worker shows and a push service takes', async () => {
  const w = await world('api');
  try {
    type Long = { actor: { id: number; displayName: string } };
    const table = {
      ...EVENTS,
      'test.long': row<Long, { userId: number }>({
        who: () => [{ userId: w.people.ben.id }],
        text: () => ({ title: 'T'.repeat(500), body: '🚗'.repeat(2000) }),
        link: () => `/#/history?${'x'.repeat(500)}`,
        tag: () => 't'.repeat(200),
      }),
    };
    const notifier = createNotifier<Events & { 'test.long': Long }>(w.h.t.ctx, createPush(w.h.t.ctx), table);
    notifier.emit('test.long', () => ({ actor: { id: w.people.anna.id, displayName: 'Anna' } }));
    await notifier.idle();
    assert.equal(w.stub.calls.length, 2, 'it was still sent, to both devices');
    const message = w.phones.ben[0]!.read(w.stub.calls.find((c) => c.url === w.phones.ben[0]!.endpoint)!);
    assert.ok([...message.title].length <= 100 && [...message.body].length <= 300 && [...message.tag].length <= 64 && [...message.url].length <= 300, 'within what the worker shows');
    assert.ok(Buffer.byteLength(JSON.stringify(message)) < 1000, 'and light enough for a push service');
    assert.ok(!w.h.t.logs.some((l) => l['event'] === 'notify.error' || l['event'] === 'push.send_failed'));
  } finally {
    await w.h.t.close();
  }
});

test('fit() cuts to what the service worker shows and what a push may weigh, by code point and with an ellipsis', () => {
  const wide = fit({ title: '🚗'.repeat(300), body: '🚗'.repeat(900), url: `/#/${'x'.repeat(400)}`, tag: 't'.repeat(100) });
  assert.ok([...wide.title].length <= 100 && [...wide.body].length <= 300 && [...wide.url].length <= 300 && [...wide.tag].length <= 64);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= 900, 'the body gives way until the whole message is light enough');
  assert.ok(wide.title.endsWith('…') && !/[\uD800-\uDBFF]$/.test(wide.title.slice(0, -1)), 'never cut in the middle of an emoji');
  const small = { title: 'Hi', body: 'There', url: '/#/', tag: 'a' };
  assert.deepEqual({ ...fit(small) }, small, 'a short message is left alone');
});

test('every notification text lives in src/notify-texts.ts: no other source file composes a title or a body', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const offenders: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'notify-texts.ts')) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      // A title or body with a literal in it is wording. (PushMessage in push.ts is a type: its fields have no value.)
      if (/\b(title|body)\s*:\s*[`'"]/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  // The request bodies of the Tikkie call and the like are not notifications: nothing else may match.
  assert.deepEqual(offenders, []);
});

test('the list on the Account page mentions every event of the table, so a new event cannot go unlisted', () => {
  const items: string[] = S.account.notifications.items;
  // One entry per event; when an event is added to the table this fails until the Account page says so too.
  const listed: Record<keyof typeof EVENTS, RegExp[]> = {
    'reservation.suggested': [/suggests a reservation for you/],
    'reservation.answered': [/approves or declines a suggestion you made/],
    'reservation.changed': [/changes it or withdraws it/, /changes or cancels one of your reservations/],
    'reservation.deleted': [/withdraws it/, /changes or cancels one of your reservations/],
    'usage.changed': [/drive is logged, changed or deleted in your name, or on your reservation/, /registers kilometres as yours/],
    'fuel.created': [/new fill-up that you owe money for/, /somebody enters a fill-up in your name/],
    'fuel.changed': [/fill-up is edited or deleted and your share changes/],
    'fuel.paid': [/marked paid or unpaid, or somebody says they paid you/],
    'ticket.changed': [/traffic ticket is entered, changed or deleted/],
  };
  assert.deepEqual(Object.keys(listed).sort(), Object.keys(EVENTS).sort());
  for (const [kind, patterns] of Object.entries(listed)) {
    for (const pattern of patterns) assert.ok(items.some((item) => pattern.test(item)), `${kind}: no line on the Account page matches ${pattern}`);
  }
  assert.ok(items.some((item) => /reminder/i.test(item)), 'the km reminders are listed too');
  assert.ok(items.every((item) => !/price of|reason for/i.test(item) || /never shows the price or the reason/.test(item)), 'the ticket line promises no price or reason in the text');
});

test('the event table covers every event and each row gives a screen of the app, a tag within the limit and a text', () => {
  const sample = { id: 1, userId: 2, userName: 'Ben', createdBy: 3, createdByName: 'Anna', status: 'pending' as const, start: '2026-06-17T10:00:00.000Z', end: '2026-06-17T12:00:00.000Z', note: '' };
  assert.deepEqual(Object.keys(EVENTS).sort(), [
    'fuel.changed',
    'fuel.created',
    'fuel.paid',
    'reservation.answered',
    'reservation.changed',
    'reservation.deleted',
    'reservation.suggested',
    'ticket.changed',
    'usage.changed',
  ]);
  const spec = EVENTS['reservation.suggested'];
  const event = { actor: { id: 3, displayName: 'Anna' }, reservation: sample };
  const [entry] = spec.who(event, { isActive: () => true, activeUserIds: () => [] });
  assert.equal(entry!.userId, 2);
  assert.ok(opensAScreen(spec.link(event, entry!, { tz: 'Europe/Amsterdam' })));
  const tz = 'Europe/Amsterdam';
  assert.deepEqual(
    { ...spec.text(event, entry!, { tz }) },
    { title: 'Anna suggested a reservation for you', body: `${formatLocal(sample.start, tz)} – ${formatLocal(sample.end, tz)}. Open the Inbox to approve or decline it before it starts.` },
  );
  // A suggestion that is not pending (an own reservation) concerns nobody.
  assert.deepEqual(spec.who({ ...event, reservation: { ...sample, status: 'confirmed', createdBy: 2 } }, { isActive: () => true, activeUserIds: () => [] }), []);
});
