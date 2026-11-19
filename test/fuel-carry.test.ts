// What a person still owes from earlier fill-ups rides along with the next share, a payment settles
// it, the debtor can say "I have paid" for their own share, and a new fill-up tells the people who
// owe money. The rules are in src/fuel-carry.ts (pure) and src/fuel.ts, src/fuel-notify.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { many, one, run } from '../src/db.ts';
import { carryKey, carryOver, type CarryFuel, type CarryRequest, type CarryShare } from '../src/fuel-carry.ts';
import { createFuelNotifier, fuelMessage } from '../src/fuel-notify.ts';
import { requestMessage } from '../src/payments.ts';
import { purge } from '../src/retention.ts';
import { windowBounds } from '../src/validate.ts';
import { at, createHousehold, insertFuel, insertUsage, makeSubscriber, stubFetch, type Json } from './helpers.ts';

// ------------------------------------------------------------ the pure rules

const T = (n: number): string => `2026-06-${String(10 + n).padStart(2, '0')}T08:00:00.000Z`;
const fuel = (id: number, userId: number, day: number): CarryFuel => ({ id, userId, atUtc: T(day) });
const share = (fuelId: number, debtorId: number, cents: number): CarryShare => ({ fuelId, debtorId, cents });
const req = (fuelId: number, debtorId: number, paid: boolean, coversFuelId: number | null): CarryRequest => ({ fuelId, debtorId, paid, coversFuelId });
const carry = (m: ReturnType<typeof carryOver>, fuelId: number, debtorId: number): Json => ({ ...m.get(carryKey(fuelId, debtorId)) });

test('carryOver: the first share carries nothing, later ones carry what is still open between the same two people', () => {
  const fuels = [fuel(1, 1, 0), fuel(2, 1, 1), fuel(3, 1, 2)];
  const out = carryOver(fuels, [share(1, 2, 1000), share(2, 2, 400), share(3, 2, 250), share(2, 3, 999)], []);
  assert.deepEqual(carry(out, 1, 2), { carriedCents: 0, dueCents: 1000, settledBy: null });
  assert.deepEqual(carry(out, 2, 2), { carriedCents: 1000, dueCents: 1400, settledBy: null });
  assert.deepEqual(carry(out, 3, 2), { carriedCents: 1400, dueCents: 1650, settledBy: null }, 'it adds up along the chain');
  assert.deepEqual(carry(out, 2, 3), { carriedCents: 0, dueCents: 999, settledBy: null }, 'another person\'s debts are not mixed in');
});

test('carryOver: what the fueler owes the debtor back is taken off, and the amount due is never below zero', () => {
  // User 2 owes user 1 the 10.00 of fill-up 1; user 1 owes user 2 the 3.00 of fill-up 2 (user 2 fuelled); fill-up 3 is user 1's again.
  const fuels = [fuel(1, 1, 0), fuel(2, 2, 1), fuel(3, 1, 2)];
  const out = carryOver(fuels, [share(1, 2, 1000), share(2, 1, 300), share(3, 2, 500)], []);
  assert.deepEqual(carry(out, 3, 2), { carriedCents: 700, dueCents: 1200, settledBy: null }, '10.00 - 3.00 carried, plus the 5.00 share');
  assert.deepEqual(carry(out, 2, 1), { carriedCents: -1000, dueCents: 0, settledBy: null }, 'user 1 owes 3.00 but is owed 10.00 by user 2: nothing to ask');
  assert.deepEqual(carry(out, 1, 2), { carriedCents: 0, dueCents: 1000, settledBy: null });
  const bigger = carryOver(fuels, [share(1, 2, 200), share(2, 1, 900), share(3, 2, 100)], []);
  assert.deepEqual(carry(bigger, 3, 2), { carriedCents: -700, dueCents: 0, settledBy: null }, 'the fueler owes more than the share: due 0, not negative');
});

test('carryOver: a share that is paid itself, or has no amount, is not carried', () => {
  const fuels = [fuel(1, 1, 0), fuel(2, 1, 1), fuel(3, 1, 2)];
  const out = carryOver(fuels, [share(1, 2, 1000), share(2, 2, 0), share(3, 2, 250)], [req(1, 2, true, null)]);
  assert.deepEqual(carry(out, 3, 2), { carriedCents: 0, dueCents: 250, settledBy: null }, 'the first is paid, the second is nothing');
  assert.deepEqual(carry(out, 2, 2), { carriedCents: 0, dueCents: 0, settledBy: null }, 'no share, no due: the carry rides on a share');
});

test('carryOver: a paid request settles the earlier shares it covered, and only those', () => {
  const fuels = [fuel(1, 1, 0), fuel(2, 1, 1), fuel(3, 1, 2), fuel(4, 1, 3)];
  const shares = [share(1, 2, 1000), share(2, 2, 400), share(3, 2, 250), share(4, 2, 100)];
  // The request on fill-up 3 was made when fill-ups 1 to 3 existed and has been paid.
  const out = carryOver(fuels, shares, [req(3, 2, true, 3)]);
  assert.deepEqual(carry(out, 1, 2).settledBy, { fuelId: 3, debtorId: 2 });
  assert.deepEqual(carry(out, 2, 2).settledBy, { fuelId: 3, debtorId: 2 });
  assert.equal(carry(out, 3, 2).settledBy, null, 'the request is on this share: it is paid, not settled by someone else');
  assert.equal(carry(out, 4, 2).settledBy, null, 'a later fill-up is not covered');
  assert.deepEqual(carry(out, 4, 2), { carriedCents: 0, dueCents: 100, settledBy: null }, 'and what was settled is not carried again');
  // Its own amount keeps counting what it settled: paying it does not make it look changed.
  assert.deepEqual(carry(out, 3, 2), { carriedCents: 1400, dueCents: 1650, settledBy: null });
  const open = carryOver(fuels, shares, [req(3, 2, false, 3)]);
  assert.deepEqual(carry(open, 3, 2), { carriedCents: 1400, dueCents: 1650, settledBy: null }, 'the same numbers before the payment');
  assert.equal(carry(open, 1, 2).settledBy, null, 'marking it unpaid opens them again');
  assert.deepEqual(carry(open, 4, 2), { carriedCents: 1650, dueCents: 1750, settledBy: null });
});

test('carryOver: a request made before carry-over existed settles nothing but itself', () => {
  const fuels = [fuel(1, 1, 0), fuel(2, 1, 1)];
  const out = carryOver(fuels, [share(1, 2, 1000), share(2, 2, 400)], [req(2, 2, true, null)]);
  assert.equal(carry(out, 1, 2).settledBy, null);
  assert.equal(carry(out, 1, 2).dueCents, 1000, 'still owed');
});

test('carryOver: a fill-up registered after the request was made is not covered, even when it is dated before it', () => {
  // Fill-up 3 is dated between 1 and 2 but was registered last; the request on 2 covers up to id 2.
  const fuels = [fuel(1, 1, 0), fuel(2, 1, 2), fuel(3, 1, 1)];
  const out = carryOver(fuels, [share(1, 2, 1000), share(2, 2, 400), share(3, 2, 300)], [req(2, 2, true, 2)]);
  assert.deepEqual(carry(out, 1, 2).settledBy, { fuelId: 2, debtorId: 2 });
  assert.equal(carry(out, 3, 2).settledBy, null, 'created after the request: still owed');
  assert.equal(carry(out, 3, 2).dueCents, 300 + 1000 - 1000, 'and what was settled before it is not carried onto it');
});

test('carryOver: the opposite direction settles too, and a second payment over the same share does not settle it twice', () => {
  const fuels = [fuel(1, 2, 0), fuel(2, 1, 1), fuel(3, 1, 2)];
  // User 1 owes user 2 the 4.00 of fill-up 1; user 2 owes user 1 the 6.00 and the 5.00 of fill-ups 2 and 3.
  const shares = [share(1, 1, 400), share(2, 2, 600), share(3, 2, 500)];
  const out = carryOver(fuels, shares, [req(2, 2, true, 3)]);
  assert.deepEqual(carry(out, 1, 1).settledBy, { fuelId: 2, debtorId: 2 }, 'the 4.00 the fueler owed back went into the same payment');
  const both = carryOver(fuels, shares, [req(2, 2, true, 3), req(3, 2, true, 3)]);
  assert.deepEqual(carry(both, 1, 1).settledBy, { fuelId: 2, debtorId: 2 }, 'the earlier request got it; the later one is then flagged by its own numbers');
  assert.deepEqual(carry(both, 2, 2), { carriedCents: -400, dueCents: 200, settledBy: null });
  assert.deepEqual(carry(both, 3, 2), { carriedCents: 0, dueCents: 500, settledBy: null }, 'its settled share is gone from it: 5.00 now, not what it asked');
});

test('carryOver: shares or requests of fill-ups that do not exist are ignored', () => {
  const out = carryOver([fuel(1, 1, 0)], [share(1, 2, 100), share(9, 2, 500)], [req(9, 2, true, 9)]);
  assert.deepEqual([...out.keys()], [carryKey(1, 2)]);
  assert.deepEqual(carry(out, 1, 2), { carriedCents: 0, dueCents: 100, settledBy: null });
});

test('property: paying a request made over everything that existed leaves nothing open for that pair up to that fill-up, to the cent', () => {
  let seed = 7;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    const count = 2 + rand(5);
    const fuels = Array.from({ length: count }, (_, i) => fuel(i + 1, 1 + rand(3), i));
    const shares = fuels.flatMap((f) => [1, 2, 3].filter((u) => u !== f.userId).map((u) => share(f.id, u, rand(4) === 0 ? 0 : 1 + rand(5000))));
    // The last fill-up; one of its debtors with a share is asked, over all fill-ups there are.
    const last = fuels[count - 1] as CarryFuel;
    const asked = shares.filter((s) => s.fuelId === last.id && s.cents > 0)[0];
    if (!asked) continue;
    const before = carryOver(fuels, shares, []).get(carryKey(last.id, asked.debtorId)) as Json;
    const due = before.dueCents as number;
    const withPayment = carryOver(fuels, shares, [req(last.id, asked.debtorId, true, count)]);
    // Every share between the same two people, with its sign: owed to the fueler of the request (+) or by them (-).
    const pairShares: Array<{ s: CarryShare; sign: number }> = shares
      .filter((s) => s.cents > 0)
      .flatMap((s) => {
        const f = fuels.find((x) => x.id === s.fuelId) as CarryFuel;
        if (f.userId === last.userId && s.debtorId === asked.debtorId) return [{ s, sign: 1 }];
        if (f.userId === asked.debtorId && s.debtorId === last.userId) return [{ s, sign: -1 }];
        return [];
      });
    // Nothing is paid yet, so the net of all of them is what the pair owes, and the request asks for exactly that.
    const owed = pairShares.reduce((n, p) => n + p.sign * p.s.cents, 0);
    assert.equal(due, Math.max(0, owed), `round ${round}: the amount due is the open net of the pair`);
    if (due > 0) {
      // Paying it settles every other share of the pair: what was paid is exactly what was owed, nothing is left over or counted twice.
      for (const p of pairShares) {
        const isOwn: boolean = p.s.fuelId === last.id && p.s.debtorId === asked.debtorId;
        const by = withPayment.get(carryKey(p.s.fuelId, p.s.debtorId))?.settledBy ?? null;
        assert.equal(by !== null, !isOwn, `round ${round}: ${isOwn ? 'the share it is on is paid, not settled' : 'an earlier share of the pair is settled'}`);
      }
    }
    // The request's own numbers do not move when it is paid.
    assert.deepEqual(withPayment.get(carryKey(last.id, asked.debtorId)), before, `round ${round}: paying does not change what it asked`);
    // Other pairs are untouched.
    for (const s of shares) {
      const pair = (a: number, b: number): boolean => new Set([a, b]).size === 2 && [a, b].every((u) => [last.userId, asked.debtorId].includes(u));
      const f = fuels.find((x) => x.id === s.fuelId) as CarryFuel;
      if (!pair(f.userId, s.debtorId)) assert.equal(withPayment.get(carryKey(s.fuelId, s.debtorId))?.settledBy, null, `round ${round}: other pairs are not settled`);
    }
  }
});

test('the request text: nothing carried reads exactly as before, carried amounts are named, and the pool is explained', () => {
  const base = { amountCents: 1500, creditorName: 'Anna', debtorName: 'Ben', litres: '40.00', date: 'Sat 14 Nov', km: 50, kmTotal: 200, equalSplit: false, reference: 'fuel-1-2' };
  const plain = 'Hi Ben, Anna fuelled the shared car on Sat 14 Nov (40.00 L). Your share is EUR 15.00 (50 of 200 km driven). Please pay Anna.';
  assert.equal(requestMessage(base), plain);
  assert.equal(requestMessage({ ...base, shareCents: 1500, carriedCents: 0, togetherKm: 0 }), plain, 'zero carried and zero together change nothing');
  assert.equal(
    requestMessage({ ...base, amountCents: 2500, shareCents: 1500, carriedCents: 1000 }),
    'Hi Ben, Anna fuelled the shared car on Sat 14 Nov (40.00 L). Your share is EUR 15.00 (50 of 200 km driven). EUR 10.00 from earlier fill-ups is still open, so the total is EUR 25.00. Please pay Anna.',
  );
  assert.equal(
    requestMessage({ ...base, amountCents: 500, shareCents: 1500, carriedCents: -1000 }),
    'Hi Ben, Anna fuelled the shared car on Sat 14 Nov (40.00 L). Your share is EUR 15.00 (50 of 200 km driven). EUR 10.00 that Anna still owes you from earlier is taken off, so the total is EUR 5.00. Please pay Anna.',
  );
  assert.match(requestMessage({ ...base, togetherKm: 80 }), /\(50 km of your own and an equal part of 80 km driven together, 200 km in all\)/);
});

test('the push text names the fueler and the amount, and says what is carried', () => {
  const m = fuelMessage({ id: 7, userName: 'Anna' }, { cents: 1500, carriedCents: 0, dueCents: 1500 });
  assert.deepEqual({ ...m }, { title: 'Anna fuelled the car', body: 'You owe Anna EUR 15.00. This can still change when more drives are registered.', url: '/#/history', tag: 'fuel-7' });
  assert.match(fuelMessage({ id: 7, userName: 'Anna' }, { cents: 1500, carriedCents: 1000, dueCents: 2500 }).body, /You owe Anna EUR 25\.00 \(EUR 15\.00 now plus EUR 10\.00 still open from earlier\)/);
  assert.match(fuelMessage({ id: 7, userName: 'Anna' }, { cents: 1500, carriedCents: -400, dueCents: 1100 }).body, /You owe Anna EUR 11\.00 \(EUR 15\.00 now, minus EUR 4\.00 that Anna owes you from earlier\)/);
  const long = fuelMessage({ id: 1, userName: 'A'.repeat(200) }, { cents: 1, carriedCents: 0, dueCents: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(long)) < 600, 'a long name cannot push the message over the size limit');
});

// ------------------------------------------------------ carry-over over HTTP

const ENV = { PUSH_CONTACT: 'https://car.example.test' };

/** Ben drives 100 km, Anna fuels (60.00, all Ben's), Ben drives 50 km, Anna fuels again (30.00, all Ben's). Ids: admin 1, Anna 2, Ben 3, Carla 4. */
async function twoFillUps() {
  const h = await createHousehold();
  const { t, anna, ben } = h;
  insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 0, odometerEnd: 100 });
  const first = (await anna.post('/api/fuel', { at: at(t.clock, -20), millilitres: 40_000, totalCents: 6000 })).body.fuel;
  insertUsage(t, { userId: ben.id, start: at(t.clock, -15), end: at(t.clock, -14), odometerStart: 100, odometerEnd: 150 });
  const second = (await anna.post('/api/fuel', { at: at(t.clock, -10), millilitres: 20_000, totalCents: 3000 })).body.fuel;
  assert.deepEqual([first.shares.map((s: Json) => s.cents), second.shares.map((s: Json) => s.cents)], [[6000], [3000]]);
  return { ...h, first, second };
}
const benOf = (f: Json): Json => f.shares.find((s: Json) => s.userName === 'Ben');
const pairs = (balances: Json[]): Json[][] => balances.map((b) => [b.fromName, b.toName, b.cents]);

test('the second fill-up carries the first: the card, the request, the text and the balances agree and nothing is counted twice', async () => {
  const { t, anna, ben, first, second } = await twoFillUps();
  try {
    const share = benOf(second);
    assert.deepEqual([share.cents, share.carriedCents, share.dueCents, share.settledBy], [3000, 6000, 9000, null]);
    assert.deepEqual([benOf(first).carriedCents, benOf(first).dueCents], [0, 6000]);
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Ben', 'Anna', 9000]], 'the balance is the sum of the two shares, once');

    const made = await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id });
    assert.equal(made.status, 201, made.text);
    const request = benOf(made.body.fuel).request;
    assert.equal(request.amountCents, 9000, 'the request asks for the total');
    assert.equal(request.changed, false);
    assert.match(request.message, /Your share is EUR 30\.00 \(50 of 50 km driven\)\. EUR 60\.00 from earlier fill-ups is still open, so the total is EUR 90\.00\. Please pay Anna\./);
    assert.equal(one<Json>(t.db, 'SELECT covers_fuel_id FROM fuel_requests WHERE fuel_id = ?', second.id)?.covers_fuel_id, second.id, 'it covers everything that existed');
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Ben', 'Anna', 9000]], 'asking changes nothing about what is owed');

    // Ben says he paid: the second share and the first one it carried are both settled.
    const paid = await ben.post(`/api/fuel/${second.id}/requests/${ben.id}/paid`, { paid: true });
    assert.equal(paid.status, 200, paid.text);
    const after = (await anna.get('/api/fuel')).body;
    assert.deepEqual(after.balances, [], 'nobody owes anything: one payment, both shares');
    const [newest, oldest] = after.items;
    assert.equal(benOf(newest).request.paidAt !== null, true);
    assert.equal(benOf(newest).request.changed, false, 'settling the earlier share does not make the request look changed');
    assert.deepEqual({ ...benOf(oldest).settledBy }, { fuelId: second.id, at: second.at });
    assert.equal(benOf(oldest).request, null, 'the first fill-up never had a request of its own');
    assert.deepEqual([benOf(oldest).can.selfPaid, benOf(oldest).can.request, benOf(oldest).can.markPaid], [false, false, false], 'nothing left to do on it');
  } finally {
    await t.close();
  }
});

test('a fill-up that a later payment settled is locked like one with a paid request, until that payment is marked unpaid', async () => {
  const { t, anna, ben, first, second } = await twoFillUps();
  try {
    await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id });
    await ben.post(`/api/fuel/${second.id}/requests/${ben.id}/paid`, { paid: true });
    const locked = (await anna.get('/api/fuel')).body.items.find((f: Json) => f.id === first.id);
    assert.equal(locked.settledByLater, true);
    assert.equal(locked.hasPaidRequests, false);
    assert.deepEqual({ ...locked.can }, { edit: false, delete: false });
    for (const res of [await anna.patch(`/api/fuel/${first.id}`, { note: 'rewrite history' }), await anna.del(`/api/fuel/${first.id}`)]) {
      assert.deepEqual([res.status, res.body.error.code], [409, 'has_paid_requests']);
    }

    // Marking the payment unpaid re-opens what it settled, and the fill-up can be changed again.
    assert.equal((await anna.post(`/api/fuel/${second.id}/requests/${ben.id}/paid`, { paid: false })).status, 200);
    const open = (await anna.get('/api/fuel')).body;
    assert.deepEqual(pairs(open.balances), [['Ben', 'Anna', 9000]]);
    assert.equal(open.items.find((f: Json) => f.id === first.id).settledByLater, false);
    assert.equal((await anna.patch(`/api/fuel/${first.id}`, { note: 'now fine' })).status, 200);
  } finally {
    await t.close();
  }
});

test('a drive added to an earlier period after the payment does not re-open it: the paid request is flagged with the difference instead', async () => {
  const { t, anna, ben, carla, first, second } = await twoFillUps();
  try {
    await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id });
    await ben.post(`/api/fuel/${second.id}/requests/${ben.id}/paid`, { paid: true });
    // Carla remembers a 100 km drive in the first period: the first fill-up is now shared with Ben, 30.00 each.
    insertUsage(t, { userId: carla.id, start: at(t.clock, -28), end: at(t.clock, -27), odometerStart: 0, odometerEnd: 100 });
    const { items, balances } = (await anna.get('/api/fuel')).body;
    const oldest = items.find((f: Json) => f.id === first.id);
    assert.deepEqual(oldest.shares.map((s: Json) => [s.userName, s.cents]), [['Ben', 3000], ['Carla', 3000]]);
    assert.notEqual(benOf(oldest).settledBy, null, 'Ben\'s share of it stays settled');
    assert.deepEqual(pairs(balances), [['Carla', 'Anna', 3000]], 'only Carla\'s new share is open');
    const newest = items.find((f: Json) => f.id === second.id);
    assert.equal(benOf(newest).request.amountCents, 9000, 'what he paid');
    assert.equal(benOf(newest).dueCents, 6000, 'what it would ask now: 30.00 + the 30.00 it settled');
    assert.equal(benOf(newest).request.changed, true, 'the one signal');
    assert.equal(benOf(newest).request.currentCents, 6000);
  } finally {
    await t.close();
  }
});

test('what the fueler owes the debtor back is taken off the amount due, and settled together with it', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    // Anna drives 100 km, Ben fuels (40.00, all Anna's); Ben drives 50 km, Anna fuels (60.00, all Ben's).
    insertUsage(t, { userId: anna.id, start: at(t.clock, -40), end: at(t.clock, -39), odometerStart: 0, odometerEnd: 100 });
    const owedBack = (await ben.post('/api/fuel', { at: at(t.clock, -35), millilitres: 30_000, totalCents: 4000 })).body.fuel;
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 100, odometerEnd: 150 });
    const second = (await anna.post('/api/fuel', { at: at(t.clock, -20), millilitres: 40_000, totalCents: 6000 })).body.fuel;

    const share = benOf(second);
    assert.deepEqual([share.cents, share.carriedCents, share.dueCents], [6000, -4000, 2000]);
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Ben', 'Anna', 2000]], 'the same 20.00 the balances say');
    const made = await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id });
    assert.equal(benOf(made.body.fuel).request.amountCents, 2000);
    assert.match(benOf(made.body.fuel).request.message, /EUR 40\.00 that Anna still owes you from earlier is taken off, so the total is EUR 20\.00\./);

    await ben.post(`/api/fuel/${second.id}/requests/${ben.id}/paid`, { paid: true });
    const after = (await anna.get('/api/fuel')).body;
    assert.deepEqual(after.balances, [], 'Ben paid 20.00 and the 40.00 Anna owed him went into it');
    const settled = after.items.find((f: Json) => f.id === owedBack.id).shares.find((s: Json) => s.userName === 'Anna');
    assert.equal(settled.settledBy.fuelId, second.id);
  } finally {
    await t.close();
  }
});

test('when the fueler owes the debtor more than the share there is nothing to ask for, and nothing the debtor can mark paid', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    insertUsage(t, { userId: anna.id, start: at(t.clock, -40), end: at(t.clock, -39), odometerStart: 0, odometerEnd: 100 });
    await ben.post('/api/fuel', { at: at(t.clock, -35), millilitres: 30_000, totalCents: 4000 });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 100, odometerEnd: 150 });
    const small = (await anna.post('/api/fuel', { at: at(t.clock, -20), millilitres: 20_000, totalCents: 3000 })).body.fuel;
    const share = benOf(small);
    assert.deepEqual([share.cents, share.carriedCents, share.dueCents], [3000, -4000, 0]);
    assert.deepEqual({ ...share.can }, { request: false, markPaid: false, selfPaid: false });
    const asked = await anna.post(`/api/fuel/${small.id}/requests`, { debtorId: ben.id });
    assert.equal(asked.status, 422);
    assert.equal(asked.body.error.fields.debtorId, 'nothing_owed');
    const said = await ben.post(`/api/fuel/${small.id}/requests/${ben.id}/paid`, { paid: true });
    assert.equal(said.status, 422);
    assert.equal(said.body.error.fields.debtorId, 'nothing_owed');
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Anna', 'Ben', 1000]], 'Anna still owes Ben 10.00');
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel_requests')?.n, 0);
  } finally {
    await t.close();
  }
});

test('a request made before carry-over existed asks for the share alone, settles nothing earlier and is not flagged for it', async () => {
  const { t, anna, ben, second } = await twoFillUps();
  try {
    // What the previous release wrote: a paid request for the share of 30.00, with no cover.
    run(
      t.db,
      `INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, link, created_at, updated_at, paid_at, paid_by)
       VALUES (?, ?, 3000, 'manual', 'old text', '', ?, ?, ?, ?)`,
      second.id,
      ben.id,
      at(t.clock, -9),
      at(t.clock, -9),
      at(t.clock, -8),
      anna.id,
    );
    const { items, balances } = (await anna.get('/api/fuel')).body;
    const share = benOf(items.find((f: Json) => f.id === second.id));
    assert.deepEqual([share.request.amountCents, share.request.changed, share.request.currentCents], [3000, false, 3000], 'compared with the share alone');
    assert.equal(benOf(items.find((f: Json) => f.id === items[1].id)).settledBy, null, 'the earlier share is still open');
    assert.deepEqual(pairs(balances), [['Ben', 'Anna', 6000]]);
  } finally {
    await t.close();
  }
});

test('a fill-up registered after the request was made, even one dated before it, is not settled by its payment', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 0, odometerEnd: 100 });
    const late = (await anna.post('/api/fuel', { at: at(t.clock, -10), millilitres: 40_000, totalCents: 6000 })).body.fuel;
    assert.equal((await anna.post(`/api/fuel/${late.id}/requests`, { debtorId: ben.id })).status, 201);
    // A forgotten earlier fill-up is added afterwards: it takes the drive, and the later one now pays for nothing.
    const back = (await anna.post('/api/fuel', { at: at(t.clock, -20), millilitres: 20_000, totalCents: 2000 })).body.fuel;
    assert.equal(benOf(back).dueCents, 2000);

    assert.equal((await ben.post(`/api/fuel/${late.id}/requests/${ben.id}/paid`, { paid: true })).status, 200);
    const { items, balances } = (await anna.get('/api/fuel')).body;
    assert.equal(benOf(items.find((f: Json) => f.id === back.id)).settledBy, null, 'created after the request: still owed');
    assert.deepEqual(pairs(balances), [['Ben', 'Anna', 2000], ['Admin', 'Anna', 1500], ['Carla', 'Anna', 1500]]);
    assert.equal(benOf(items.find((f: Json) => f.id === late.id)).request.changed, true, 'and the request says it moved');
  } finally {
    await t.close();
  }
});

// ----------------------------------------------------- "I have paid this request"

test('a debtor says "I have paid" for their own share, with or without a request; nobody else can, and nobody but the fueler or an admin can undo it', async () => {
  const { t, admin, anna, ben, carla, first } = await twoFillUps();
  try {
    const url = (fuelId: number, debtor: number): string => `/api/fuel/${fuelId}/requests/${debtor}/paid`;
    // Without a request: the app records what is due now as a manual request nobody sent.
    const paid = await ben.post(url(first.id, ben.id), { paid: true });
    assert.equal(paid.status, 200, paid.text);
    const row = one<Json>(t.db, 'SELECT * FROM fuel_requests WHERE fuel_id = ?', first.id);
    assert.deepEqual(
      { provider: row?.provider, amount: row?.amount_cents, link: row?.link, paidBy: row?.paid_by, covers: row?.covers_fuel_id, paid: row?.paid_at !== null },
      { provider: 'manual', amount: 6000, link: '', paidBy: ben.id, covers: row?.covers_fuel_id, paid: true },
    );
    assert.ok((row?.covers_fuel_id as number) >= first.id, 'it records what existed');
    assert.match(row?.message as string, /^Hi Ben, Anna fuelled the shared car/);
    assert.equal(benOf(paid.body.fuel).request.paidAt !== null, true);

    // Twice is once: the first mark keeps its name and time, the log has one line.
    t.clock.advance(5 * 60_000);
    const stamp = { ...one<Json>(t.db, 'SELECT paid_at, paid_by, updated_at FROM fuel_requests WHERE fuel_id = ?', first.id) };
    assert.equal((await ben.post(url(first.id, ben.id), { paid: true })).status, 200);
    assert.deepEqual({ ...one<Json>(t.db, 'SELECT paid_at, paid_by, updated_at FROM fuel_requests WHERE fuel_id = ?', first.id) }, stamp);
    assert.equal(t.logs.filter((l) => l['event'] === 'fuel.paid').length, 1);
    assert.equal(many(t.db, 'SELECT id FROM fuel_requests WHERE fuel_id = ?', first.id).length, 1, 'no second snapshot');

    // Not for somebody else, not to undo, not for yourself when you are the fueler, not for nothing.
    assert.equal((await carla.post(url(first.id, ben.id), { paid: true })).status, 403, 'another member');
    assert.equal((await ben.post(url(first.id, ben.id), { paid: false })).status, 403, 'a debtor cannot undo it');
    assert.equal((await ben.post(url(first.id, carla.id), { paid: true })).status, 403, 'nor speak for somebody else');
    assert.equal((await anna.post(url(first.id, carla.id), { paid: true })).status, 404, 'the fueler still needs a request to mark for someone else');
    assert.equal((await anna.post(url(first.id, anna.id), { paid: true })).status, 422, 'the fueler owes themselves nothing');
    assert.equal((await carla.post(url(first.id, carla.id), { paid: true })).status, 422, 'a person with no share owes nothing');
    assert.equal((await t.client().post(url(first.id, ben.id), { paid: true })).status, 401);

    // The fueler and an admin keep their rights, undo included.
    assert.equal((await anna.post(url(first.id, ben.id), { paid: false })).status, 200);
    assert.equal(benOf((await ben.get('/api/fuel')).body.items.find((f: Json) => f.id === first.id)).request.paidAt, null);
    assert.equal((await admin.post(url(first.id, ben.id), { paid: true })).status, 200);
    assert.equal(one<Json>(t.db, 'SELECT paid_by FROM fuel_requests WHERE fuel_id = ?', first.id)?.paid_by, admin.id);
  } finally {
    await t.close();
  }
});

test('the debtor\'s button follows the state: offered for an unpaid share, with or without a request, gone once paid or settled', async () => {
  const { t, anna, ben, carla, first, second: later } = await twoFillUps();
  try {
    const mine = async (who: typeof ben): Promise<Json[]> => ((await who.get('/api/fuel')).body.items as Json[]).map((f) => benOf(f)?.can ?? null);
    assert.deepEqual(await mine(ben), [{ request: false, markPaid: false, selfPaid: true }, { request: false, markPaid: false, selfPaid: true }], 'both shares, no request yet');
    assert.deepEqual((await anna.get('/api/fuel')).body.items.map((f: Json) => benOf(f).can.selfPaid), [false, false], 'only the debtor themselves');
    assert.deepEqual(((await carla.get('/api/fuel')).body.items as Json[]).map((f) => benOf(f).can.selfPaid), [false, false]);

    await anna.post(`/api/fuel/${later.id}/requests`, { debtorId: ben.id });
    assert.equal(benOf((await ben.get('/api/fuel')).body.items[0]).can.selfPaid, true, 'with a request');
    await ben.post(`/api/fuel/${later.id}/requests/${ben.id}/paid`, { paid: true });
    assert.deepEqual(await mine(ben), [{ request: false, markPaid: false, selfPaid: false }, { request: false, markPaid: false, selfPaid: false }], 'paid, and the one it settled');

    // Pressing it on a share that a later payment settled is refused, not recorded twice.
    const again = await ben.post(`/api/fuel/${first.id}/requests/${ben.id}/paid`, { paid: true });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_paid');
    assert.equal(many(t.db, 'SELECT id FROM fuel_requests').length, 1);
  } finally {
    await t.close();
  }
});

// -------------------------------------------------------------- the push

/** Ben drove 50 km and Carla 50, Anna 100 and fuelled: Ben and Carla owe 15.00 each. */
async function pushHousehold(over: { env?: Record<string, string>; fetchHandler?: Parameters<typeof stubFetch>[0] } = {}) {
  const stub = stubFetch(over.fetchHandler);
  const h = await createHousehold({ env: { ...ENV, ...over.env }, fetch: stub.fetch });
  const { t, anna, ben, carla } = h;
  insertUsage(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -28), odometerStart: 1000, odometerEnd: 1100 });
  insertUsage(t, { userId: ben.id, start: at(t.clock, -26), end: at(t.clock, -24), odometerStart: 1100, odometerEnd: 1150 });
  insertUsage(t, { userId: carla.id, start: at(t.clock, -22), end: at(t.clock, -20), odometerStart: 1150, odometerEnd: 1200 });
  return { ...h, stub };
}
const fillUp = { millilitres: 40_000, totalCents: 6000 };

test('a new fill-up sends one push to each device of everybody who owes money, and to nobody else', async () => {
  const { t, admin, anna, ben, stub } = await pushHousehold();
  try {
    const phone = makeSubscriber('https://fcm.googleapis.com/fcm/send/ben-phone');
    const tablet = makeSubscriber('https://fcm.googleapis.com/fcm/send/ben-tablet');
    const own = makeSubscriber('https://fcm.googleapis.com/fcm/send/anna-phone');
    const adminPhone = makeSubscriber('https://fcm.googleapis.com/fcm/send/admin-phone');
    for (const [who, sub] of [[ben, phone], [ben, tablet], [anna, own], [admin, adminPhone]] as const) assert.equal((await who.post('/api/push/subscribe', sub.subscription)).status, 201);
    // Carla owes 15.00 too but has no device signed up.
    const res = await anna.post('/api/fuel', { at: at(t.clock, -10), ...fillUp });
    assert.equal(res.status, 201, res.text);
    await t.app.idle();

    const sent = stub.calls.filter((c) => c.url.includes('/fcm/send/'));
    assert.deepEqual(sent.map((c) => c.url).sort(), [phone.endpoint, tablet.endpoint].sort(), 'both of Ben\'s devices, once each; not Anna (the fueler), not the admin (owes nothing), not Carla (no device)');
    for (const [sub, call] of [[phone, sent.find((c) => c.url === phone.endpoint)], [tablet, sent.find((c) => c.url === tablet.endpoint)]] as const) {
      const message = sub.read(call!);
      assert.deepEqual({ ...message }, { title: 'Anna fuelled the car', body: 'You owe Anna EUR 15.00. This can still change when more drives are registered.', url: '/#/history', tag: `fuel-${res.body.fuel.id}` });
      assert.equal(call!.redirect, 'manual');
      assert.equal(call!.hasSignal, true, 'every send has a timeout');
    }
    assert.ok(t.logs.some((l: Json) => l['event'] === 'fuel.push' && l['userId'] === ben.id && l['sent'] === 2 && l['failed'] === 0));
  } finally {
    await t.close();
  }
});

test('the push carries what is carried over: the second fill-up\'s message names the total and where it comes from', async () => {
  const { t, anna, ben, stub } = await pushHousehold();
  try {
    const phone = makeSubscriber();
    await ben.post('/api/push/subscribe', phone.subscription);
    await anna.post('/api/fuel', { at: at(t.clock, -10), ...fillUp });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -8), end: at(t.clock, -7), odometerStart: 1200, odometerEnd: 1260 });
    await anna.post('/api/fuel', { at: at(t.clock, -5), millilitres: 20_000, totalCents: 2000 });
    await t.app.idle();
    const bodies = stub.calls.filter((c) => c.url === phone.endpoint).map((c) => phone.read(c).body);
    assert.equal(bodies.length, 2);
    assert.match(bodies[1], /You owe Anna EUR 35\.00 \(EUR 20\.00 now plus EUR 15\.00 still open from earlier\)/);
  } finally {
    await t.close();
  }
});

test('a slow or failing push service never delays or fails the fill-up', async () => {
  let release: () => void = () => undefined;
  const { t, anna, ben, stub } = await pushHousehold({
    fetchHandler: () => new Promise<Response>((resolve) => void (release = () => resolve(new Response(null, { status: 201 })))),
  });
  try {
    const phone = makeSubscriber('https://fcm.googleapis.com/fcm/send/slow-phone');
    await ben.post('/api/push/subscribe', phone.subscription);

    // The push service does not answer at all: the fill-up is still saved and answered.
    const slow = await anna.post('/api/fuel', { at: at(t.clock, -10), ...fillUp });
    assert.equal(slow.status, 201, slow.text);
    assert.equal(stub.calls.filter((c) => c.url === phone.endpoint).length, 1, 'the send was started');
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel')?.n, 1);
    release();
    await t.app.idle();

    // It throws: still saved, the failure is logged without the endpoint or the keys.
    stub.respond(() => {
      throw new Error(`boom for ${phone.endpoint}`);
    });
    const broken = await anna.post('/api/fuel', { at: at(t.clock, -5), ...fillUp });
    assert.equal(broken.status, 201, broken.text);
    await t.app.idle();
    assert.ok(t.logs.some((l: Json) => l['event'] === 'push.send_failed'));
    // And a 500 answer is a retry outcome, not an error for the person who saved.
    stub.respond(() => new Response(null, { status: 503 }));
    assert.equal((await anna.post('/api/fuel', { at: at(t.clock, -4), ...fillUp })).status, 201);
    await t.app.idle();
    const logged = JSON.stringify(t.logs);
    for (const secret of [phone.endpoint, 'slow-phone', phone.p256dh, phone.auth]) assert.ok(!logged.includes(secret), `the log leaked ${secret.slice(0, 20)}`);
  } finally {
    await t.close();
  }
});

test('nothing is sent when push is switched off, or when a fill-up is edited or deleted; only registering one tells people', async () => {
  const off = await pushHousehold({ env: { PUSH_ENABLED: 'false' } });
  try {
    run(off.t.db, 'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)', off.ben.id, 'https://fcm.googleapis.com/fcm/send/x', 'k', 'a', at(off.t.clock, 0));
    assert.equal((await off.anna.post('/api/fuel', { at: at(off.t.clock, -10), ...fillUp })).status, 201);
    await off.t.app.idle();
    assert.equal(off.stub.calls.length, 0, 'switched off');
  } finally {
    await off.t.close();
  }

  const { t, admin, anna, ben, stub } = await pushHousehold();
  try {
    await ben.post('/api/push/subscribe', makeSubscriber().subscription);
    await admin.post('/api/push/subscribe', makeSubscriber().subscription);
    // Ben and Carla owe 15.00 each; the admin drove nothing and owes nothing, so only Ben (the one with a device) is told.
    const f = (await anna.post('/api/fuel', { at: at(t.clock, -10), ...fillUp })).body.fuel;
    await t.app.idle();
    const before = stub.calls.length;
    assert.equal(before, 1, 'Ben only');
    assert.equal((await anna.patch(`/api/fuel/${f.id}`, { note: 'edited' })).status, 200);
    assert.equal((await anna.patch(`/api/fuel/${f.id}`, { totalCents: 7000 })).status, 200);
    assert.equal((await anna.del(`/api/fuel/${f.id}`)).status, 204);
    await t.app.idle();
    assert.equal(stub.calls.length, before, 'only registering a fill-up sends something');
  } finally {
    await t.close();
  }
});

test('a deactivated person is not told, even if a device of theirs is still on file', async () => {
  const { t, anna, ben, carla, stub } = await pushHousehold();
  try {
    const benPhone = makeSubscriber('https://fcm.googleapis.com/fcm/send/ben');
    const carlaPhone = makeSubscriber('https://fcm.googleapis.com/fcm/send/carla');
    await ben.post('/api/push/subscribe', benPhone.subscription);
    await carla.post('/api/push/subscribe', carlaPhone.subscription);
    // Carla's device row survives a deactivation of her account in this test: it is the active check that must keep her out.
    run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', carla.id);
    await anna.post('/api/fuel', { at: at(t.clock, -10), ...fillUp });
    await t.app.idle();
    assert.deepEqual(stub.calls.map((c) => c.url), [benPhone.endpoint], 'Carla is inactive, so only Ben is told');
  } finally {
    await t.close();
  }
});

test('closing the app waits for the notifications that are on their way', async () => {
  let release: () => void = () => undefined;
  const { t, anna, ben, stub } = await pushHousehold({ fetchHandler: () => new Promise<Response>((resolve) => void (release = () => resolve(new Response(null, { status: 201 })))) });
  let closed = false;
  try {
    await ben.post('/api/push/subscribe', makeSubscriber().subscription);
    await anna.post('/api/fuel', { at: at(t.clock, -10), ...fillUp });
    assert.equal(stub.calls.length, 1);
    const closing = t.app.close().then(() => void (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, false, 'close() is still waiting for the send');
    release();
    await closing;
    assert.equal(closed, true);
  } finally {
    release();
    // Closing again is harmless; it removes the database and the folder.
    await t.close();
  }
});

// ------------------------------------------------ backend hardening (specialist pass)

test('a share that a later payment settled cannot be marked paid again, also when it has a request of its own; marking the later one unpaid frees it', async () => {
  const { t, anna, ben, first, second } = await twoFillUps();
  try {
    const url = (fuelId: number): string => `/api/fuel/${fuelId}/requests/${ben.id}/paid`;
    assert.equal((await anna.post(`/api/fuel/${first.id}/requests`, { debtorId: ben.id })).status, 201);
    assert.equal((await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id })).status, 201);
    assert.equal((await ben.post(url(second.id), { paid: true })).status, 200);

    // The first share is settled by the second payment: no button for it, and the server refuses too (the debtor and the fueler alike).
    const card = benOf((await ben.get('/api/fuel')).body.items.find((f: Json) => f.id === first.id));
    assert.deepEqual([card.can.selfPaid, card.can.markPaid], [false, false]);
    for (const who of [ben, anna]) {
      const again = await who.post(url(first.id), { paid: true });
      assert.deepEqual([again.status, again.body.error.code], [409, 'already_paid']);
    }
    assert.equal(one<Json>(t.db, 'SELECT paid_at FROM fuel_requests WHERE fuel_id = ?', first.id)?.paid_at, null, 'nothing was recorded');
    const after = (await anna.get('/api/fuel')).body;
    assert.equal(benOf(after.items.find((f: Json) => f.id === second.id)).request.changed, false, 'the payment that settled it is not flagged as changed');
    assert.deepEqual(after.balances, []);
    // Asking for the state it is already in stays harmless.
    assert.equal((await anna.post(url(first.id), { paid: false })).status, 200);

    // Marking the later payment unpaid re-opens the share, and then it can be paid on its own.
    assert.equal((await anna.post(url(second.id), { paid: false })).status, 200);
    assert.equal((await ben.post(url(first.id), { paid: true })).status, 200);
    assert.notEqual(one<Json>(t.db, 'SELECT paid_at FROM fuel_requests WHERE fuel_id = ?', first.id)?.paid_at, null);
  } finally {
    await t.close();
  }
});

test('a notification job that fails is logged and dropped, never an unhandled rejection; each person\'s devices are read once', async () => {
  const { t, anna, ben } = await createHousehold();
  const unhandled: unknown[] = [];
  const onRejection = (err: unknown): void => void unhandled.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    const events: string[] = [];
    // The logger itself fails for the line that reports a finished send, which is the one thing deliver() does outside its try/catch.
    const ctx = {
      ...t.ctx,
      log: (event: Record<string, unknown>) => {
        events.push(String(event['event']));
        if (event['event'] === 'fuel.push') throw new Error('log down');
      },
    };
    let reads = 0;
    const push = {
      enabled: true,
      publicKey: () => '',
      send: async () => 'ok' as const,
      subscriptionsOf: () => {
        reads++;
        return [{ id: 1 }, { id: 2 }] as never;
      },
    };
    const notifier = createFuelNotifier(ctx, push as never);
    notifier.fuelCreated({ id: 1, userId: anna.id, userName: 'Anna', shares: [{ userId: ben.id, owes: true, cents: 100, carriedCents: 0, dueCents: 100 }] } as never);
    await notifier.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.equal(reads, 1, 'one query for the devices of one debtor');
    assert.deepEqual(events, ['fuel.push', 'fuel.push_error'], 'the failure is reported once, by the name of the error only');
  } finally {
    process.off('unhandledRejection', onRejection);
    await t.close();
  }
});

// ------------------------------------------------------------ added by the test stage

test('"I have paid" with no request on a share that carries earlier ones records the total, says so in the message and settles them too', async () => {
  const { t, anna, ben, first, second } = await twoFillUps();
  try {
    const url = `/api/fuel/${second.id}/requests/${ben.id}/paid`;
    // A forgotten fill-up, dated between the two, is registered before Ben pays: nobody asked him for it, but it existed when he paid.
    // It takes no drive (Ben's 50 km come after it), so its 20.00 is split equally over the four of them: 5.00 for Ben.
    const late = (await anna.post('/api/fuel', { at: at(t.clock, -17), millilitres: 15_000, totalCents: 2000 })).body.fuel;
    assert.ok(late.id > second.id);
    const before = benOf((await ben.get('/api/fuel')).body.items.find((f: Json) => f.id === second.id));
    assert.deepEqual([before.cents, before.carriedCents, before.dueCents], [3000, 6500, 9500], 'the 60.00 and the 5.00 are both carried');

    const paid = await ben.post(url, { paid: true });
    assert.equal(paid.status, 200, paid.text);
    const row = one<Json>(t.db, 'SELECT * FROM fuel_requests WHERE fuel_id = ?', second.id);
    assert.deepEqual(
      { provider: row?.provider, amount: row?.amount_cents, covers: row?.covers_fuel_id, paidBy: row?.paid_by, link: row?.link },
      { provider: 'manual', amount: 9500, covers: late.id, paidBy: ben.id, link: '' },
      'the snapshot asks for the share (30.00) and the 65.00 it carries, and covers everything that existed',
    );
    assert.match(row?.message as string, /EUR 65\.00 from earlier fill-ups is still open, so the total is EUR 95\.00/);
    assert.equal(many(t.db, 'SELECT id FROM fuel_requests').length, 1, 'one row: the earlier fill-ups got none of their own');

    const after = (await anna.get('/api/fuel')).body;
    assert.deepEqual(pairs(after.balances).sort(), [['Admin', 'Anna', 500], ['Carla', 'Anna', 500]], 'one payment settled all three of Ben\'s shares; the others still owe theirs');
    for (const earlier of [first, late]) {
      assert.deepEqual({ ...benOf(after.items.find((f: Json) => f.id === earlier.id)).settledBy }, { fuelId: second.id, at: second.at });
    }
    assert.equal(benOf(after.items.find((f: Json) => f.id === second.id)).request.changed, false);

    // The person who is owed can take it back: all three shares are open again and nothing else was written.
    assert.equal((await anna.post(url, { paid: false })).status, 200);
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances).sort(), [['Admin', 'Anna', 500], ['Ben', 'Anna', 9500], ['Carla', 'Anna', 500]]);
    assert.equal(many(t.db, 'SELECT id FROM fuel_requests').length, 1);
  } finally {
    await t.close();
  }
});

test('asking again after an earlier fill-up was registered late refreshes the amount and what the request covers, so its payment settles that one too', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    // Ben drives 100 km, Anna fuels (40.00, all Ben's); Ben drives 50 km, Anna fuels again (30.00): 30.00 + the 40.00 carried.
    insertUsage(t, { userId: ben.id, start: at(t.clock, -40), end: at(t.clock, -39), odometerStart: 0, odometerEnd: 100 });
    const first = (await anna.post('/api/fuel', { at: at(t.clock, -30), millilitres: 30_000, totalCents: 4000 })).body.fuel;
    insertUsage(t, { userId: ben.id, start: at(t.clock, -26), end: at(t.clock, -25), odometerStart: 100, odometerEnd: 150 });
    const second = (await anna.post('/api/fuel', { at: at(t.clock, -20), millilitres: 20_000, totalCents: 3000 })).body.fuel;
    const asked = await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id });
    assert.equal(asked.status, 201, asked.text);
    assert.equal(benOf(asked.body.fuel).request.amountCents, 7000);
    const coversOf = (fuelId: number): unknown => one<Json>(t.db, 'SELECT covers_fuel_id FROM fuel_requests WHERE fuel_id = ?', fuelId)?.covers_fuel_id;
    assert.equal(coversOf(second.id), second.id);

    // A forgotten fill-up, dated in between, is registered afterwards: it takes Ben's 50 km, and the later one is split equally.
    const late = (await anna.post('/api/fuel', { at: at(t.clock, -22), millilitres: 15_000, totalCents: 2000 })).body.fuel;
    assert.ok(late.id > second.id);
    const moved = benOf((await anna.get('/api/fuel')).body.items.find((f: Json) => f.id === second.id));
    assert.deepEqual([moved.cents, moved.carriedCents, moved.dueCents], [750, 6000, 6750], 'what it would ask now');
    assert.deepEqual([moved.request.amountCents, moved.request.changed, moved.request.currentCents], [7000, true, 6750], 'the request says it moved');

    // Asking again redoes the same request (200, not 201) with the amount and the cover of now.
    const redone = await anna.post(`/api/fuel/${second.id}/requests`, { debtorId: ben.id });
    assert.equal(redone.status, 200, redone.text);
    assert.deepEqual([benOf(redone.body.fuel).request.amountCents, benOf(redone.body.fuel).request.changed], [6750, false]);
    assert.equal(coversOf(second.id), late.id, 'it now covers the fill-up registered late');
    assert.equal(many(t.db, 'SELECT id FROM fuel_requests').length, 1);

    // Paying it settles both earlier shares; only the other people's equal shares of the later fill-up stay open.
    assert.equal((await ben.post(`/api/fuel/${second.id}/requests/${ben.id}/paid`, { paid: true })).status, 200);
    const { items, balances } = (await anna.get('/api/fuel')).body;
    assert.deepEqual([first.id, late.id].map((id) => benOf(items.find((f: Json) => f.id === id)).settledBy?.fuelId), [second.id, second.id]);
    assert.deepEqual(pairs(balances).sort(), [['Admin', 'Anna', 750], ['Carla', 'Anna', 750]]);
  } finally {
    await t.close();
  }
});

test('the six-month purge removes an earlier fill-up a request carried: the carry is gone, the request says it changed, and it can still be paid', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const tz = t.config.tz;
    const cutoff = windowBounds(t.clock.now(), tz, t.config.windowMonths).from;
    const before = (hours: number): string => new Date(Date.parse(cutoff) + hours * 3_600_000).toISOString();
    // Ben's first 100 km and Anna's 40.00 fill-up lie just before the window; his 50 km and the 30.00 fill-up are recent.
    insertUsage(t, { userId: ben.id, start: before(-4), end: before(-3), odometerStart: 0, odometerEnd: 100 });
    insertFuel(t, { userId: anna.id, at: before(-1), millilitres: 30_000, totalCents: 4000 });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -26), end: at(t.clock, -25), odometerStart: 100, odometerEnd: 150 });
    const recent = (await anna.post('/api/fuel', { at: at(t.clock, -20), millilitres: 20_000, totalCents: 3000 })).body.fuel;
    const share = benOf(recent);
    assert.deepEqual([share.cents, share.carriedCents, share.dueCents], [3000, 4000, 7000]);
    assert.equal((await anna.post(`/api/fuel/${recent.id}/requests`, { debtorId: ben.id })).status, 201);

    const result = purge(t.db, t.clock.now(), tz, t.ctx.log, t.config.windowMonths);
    assert.deepEqual([result.fuel, result.usage], [1, 1], 'the old fill-up and the old drive are gone');

    const listed = await anna.get('/api/fuel');
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.items.length, 1);
    const left = benOf(listed.body.items[0]);
    assert.deepEqual([left.cents, left.carriedCents, left.dueCents], [3000, 0, 3000], 'nothing left to carry');
    assert.deepEqual([left.request.amountCents, left.request.changed, left.request.currentCents], [7000, true, 3000], 'the request still asks for what it asked, and says it moved');
    assert.deepEqual(pairs(listed.body.balances), [['Ben', 'Anna', 3000]]);

    // Paying still works; its cover points at a fill-up that no longer exists, which settles nothing and breaks nothing.
    const paid = await ben.post(`/api/fuel/${recent.id}/requests/${ben.id}/paid`, { paid: true });
    assert.equal(paid.status, 200, paid.text);
    const done = (await anna.get('/api/fuel')).body;
    assert.deepEqual(done.balances, []);
    assert.equal(benOf(done.items[0]).request.changed, true, 'the one signal stays');
  } finally {
    await t.close();
  }
});

test('the push says what is really due: nothing when the fueler owes the debtor at least as much back, only the difference when it is part of it', async () => {
  const stub = stubFetch();
  const { t, anna, ben } = await createHousehold({ env: ENV, fetch: stub.fetch });
  try {
    const phone = makeSubscriber('https://fcm.googleapis.com/fcm/send/ben-net');
    assert.equal((await ben.post('/api/push/subscribe', phone.subscription)).status, 201);
    // Anna drives 100 km and Ben fuels (40.00): Ben is the fueler, so there is nothing to tell him.
    insertUsage(t, { userId: anna.id, start: at(t.clock, -40), end: at(t.clock, -39), odometerStart: 0, odometerEnd: 100 });
    assert.equal((await ben.post('/api/fuel', { at: at(t.clock, -35), millilitres: 30_000, totalCents: 4000 })).status, 201);
    await t.app.idle();
    assert.equal(stub.calls.length, 0);

    // Ben drives 50 km and Anna fuels (30.00): his 30.00 is less than the 40.00 Anna owes him, so he owes nothing and hears nothing.
    insertUsage(t, { userId: ben.id, start: at(t.clock, -30), end: at(t.clock, -29), odometerStart: 100, odometerEnd: 150 });
    const small = await anna.post('/api/fuel', { at: at(t.clock, -20), millilitres: 20_000, totalCents: 3000 });
    assert.equal(small.status, 201, small.text);
    assert.deepEqual([benOf(small.body.fuel).cents, benOf(small.body.fuel).carriedCents, benOf(small.body.fuel).dueCents], [3000, -4000, 0]);
    await t.app.idle();
    assert.equal(stub.calls.length, 0, 'a share above zero is not enough: what is due is zero');

    // Ben drives 50 km more and Anna fuels again (60.00): 60.00 now, plus his open 30.00, minus the 40.00 Anna owes him = 50.00.
    insertUsage(t, { userId: ben.id, start: at(t.clock, -15), end: at(t.clock, -14), odometerStart: 150, odometerEnd: 200 });
    const big = await anna.post('/api/fuel', { at: at(t.clock, -10), millilitres: 40_000, totalCents: 6000 });
    assert.equal(big.status, 201, big.text);
    assert.deepEqual([benOf(big.body.fuel).cents, benOf(big.body.fuel).carriedCents, benOf(big.body.fuel).dueCents], [6000, -1000, 5000]);
    await t.app.idle();
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(
      { ...phone.read(stub.calls[0]!) },
      {
        title: 'Anna fuelled the car',
        body: 'You owe Anna EUR 50.00 (EUR 60.00 now, minus EUR 10.00 that Anna owes you from earlier). This can still change when more drives are registered.',
        url: '/#/history',
        tag: `fuel-${big.body.fuel.id}`,
      },
    );
  } finally {
    await t.close();
  }
});

test('an admin registering a fill-up for somebody else tells the others about that person, and not that person', async () => {
  const { t, admin, anna, ben, stub } = await pushHousehold();
  try {
    const benPhone = makeSubscriber('https://fcm.googleapis.com/fcm/send/ben-phone');
    const annaPhone = makeSubscriber('https://fcm.googleapis.com/fcm/send/anna-phone');
    const adminPhone = makeSubscriber('https://fcm.googleapis.com/fcm/send/admin-phone');
    for (const [who, sub] of [[ben, benPhone], [anna, annaPhone], [admin, adminPhone]] as const) assert.equal((await who.post('/api/push/subscribe', sub.subscription)).status, 201);

    const res = await admin.post('/api/fuel', { userId: anna.id, at: at(t.clock, -10), ...fillUp });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.fuel.userId, anna.id);
    await t.app.idle();
    assert.deepEqual(stub.calls.map((c) => c.url), [benPhone.endpoint], 'Ben owes Anna; Anna fuelled, the admin owes nothing');
    const message = benPhone.read(stub.calls[0]!);
    assert.equal(message.title, 'Anna fuelled the car', 'the fueler is named, not the admin who typed it in');
    assert.equal(message.body, 'You owe Anna EUR 15.00. This can still change when more drives are registered.');
  } finally {
    await t.close();
  }
});

// ----------------------------------------------- the notifier on its own (failure paths)

const someFuel = (over: Json = {}, shares: Json[] = []): never =>
  ({ id: 1, userId: 2, userName: 'Anna', shares, ...over }) as never;
const owes = (userId: number, over: Json = {}): Json => ({ userId, owes: true, cents: 100, carriedCents: 0, dueCents: 100, ...over });

test('the notifier: a device that fails does not stop the others, and the failure is logged by the name of the error only', async () => {
  const { t, ben } = await createHousehold();
  try {
    const logs: Array<Record<string, unknown>> = [];
    const ctx = { ...t.ctx, log: (event: Record<string, unknown>) => void logs.push(event) };
    const endpoints = ['https://fcm.googleapis.com/fcm/send/SECRET-ONE', 'https://fcm.googleapis.com/fcm/send/SECRET-TWO'];
    const sent: string[] = [];
    const push = {
      enabled: true,
      publicKey: () => '',
      send: async (subscription: { endpoint: string }) => {
        if (subscription.endpoint === endpoints[0]) throw new TypeError(`cannot reach ${subscription.endpoint}`);
        sent.push(subscription.endpoint);
        return 'ok' as const;
      },
      subscriptionsOf: () => endpoints.map((endpoint, id) => ({ id, endpoint })) as never,
    };
    const notifier = createFuelNotifier(ctx, push as never);
    notifier.fuelCreated(someFuel({}, [owes(ben.id)]));
    await notifier.idle();
    assert.deepEqual(sent, [endpoints[1]], 'the second device was still told');
    assert.deepEqual(
      logs.map((l) => ({ ...l })),
      [
        { event: 'fuel.push_error', fuelId: 1, userId: ben.id, reason: 'TypeError' },
        { event: 'fuel.push', fuelId: 1, userId: ben.id, sent: 1, failed: 1 },
      ],
    );
    assert.ok(!JSON.stringify(logs).includes('SECRET'), 'no endpoint, and no error message that could carry one, in the log');
  } finally {
    await t.close();
  }
});

test('the notifier: it never throws and never reads a device for somebody who is not told, and a broken device lookup is logged', async () => {
  const { t, anna, ben, carla } = await createHousehold();
  try {
    const logs: Array<Record<string, unknown>> = [];
    const ctx = { ...t.ctx, log: (event: Record<string, unknown>) => void logs.push(event) };
    let lookups = 0;
    const push = (enabled: boolean, lookup: () => never) => ({ enabled, publicKey: () => '', send: async () => 'ok' as const, subscriptionsOf: () => (lookups++, lookup()) });
    const devices = (): never => [{ id: 1, endpoint: 'https://fcm.googleapis.com/fcm/send/x' }] as never;
    const silent = createFuelNotifier(ctx, push(true, devices) as never);

    // Nobody here is told: the fueler's own share, no debt, a share of nothing, a due of nothing, a deactivated person.
    run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', carla.id);
    silent.fuelCreated(
      someFuel({ userId: anna.id }, [owes(anna.id), owes(ben.id, { owes: false }), owes(ben.id, { cents: 0 }), owes(ben.id, { dueCents: 0 }), owes(ben.id, { dueCents: -5 }), owes(carla.id)]),
    );
    await silent.idle();
    assert.equal(lookups, 0, 'no device was even looked up');
    // (length, not deepEqual: deepEqual is a type assertion and would narrow `logs` to never[] for the rest of the test)
    assert.equal(logs.length, 0, 'nothing was logged either');

    // Switched off: nothing at all, not even a lookup.
    createFuelNotifier(ctx, push(false, devices) as never).fuelCreated(someFuel({ userId: anna.id }, [owes(ben.id)]));
    assert.equal(lookups, 0);

    // A lookup that blows up must not escape into the request that saved the fill-up; it is logged by the error's name.
    const broken = createFuelNotifier(
      ctx,
      push(true, () => {
        throw new RangeError('database is locked: https://fcm.googleapis.com/fcm/send/SECRET');
      }) as never,
    );
    assert.doesNotThrow(() => broken.fuelCreated(someFuel({ id: 9, userId: anna.id }, [owes(ben.id)])));
    await broken.idle();
    assert.equal(lookups, 1);
    assert.deepEqual(logs.map((l) => ({ ...l })), [{ event: 'fuel.push_error', fuelId: 9, reason: 'RangeError' }]);
    assert.ok(!JSON.stringify(logs).includes('SECRET'));
  } finally {
    await t.close();
  }
});

test('the notifier: a logger that is itself broken cannot turn a finished send into an unhandled rejection', async () => {
  const { t, ben } = await createHousehold();
  const unhandled: unknown[] = [];
  const onRejection = (err: unknown): void => void unhandled.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    let calls = 0;
    const ctx = {
      ...t.ctx,
      log: () => {
        calls++;
        throw new Error('log down');
      },
    };
    const push = { enabled: true, publicKey: () => '', send: async () => 'ok' as const, subscriptionsOf: () => [{ id: 1 }] as never };
    const notifier = createFuelNotifier(ctx, push as never);
    notifier.fuelCreated(someFuel({}, [owes(ben.id)]));
    await notifier.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.equal(calls, 2, 'the finished send was reported, the report failed, and the failure of that was swallowed');
  } finally {
    process.off('unhandledRejection', onRejection);
    await t.close();
  }
});

test('who may say what about a payment: the matrix for "paid" and "unpaid" on Ben\'s share, in each state of its request', async () => {
  const { t, admin, anna, ben, carla, first } = await twoFillUps();
  try {
    const url = `/api/fuel/${first.id}/requests/${ben.id}/paid`;
    const actors = { anonymous: t.client(), fueler: anna, debtor: ben, other: carla, admin };
    type Actor = keyof typeof actors;
    /** Every actor but the skipped ones says paid or unpaid, and the answer must be the one in the table. */
    const expectRow = async (state: string, paid: boolean, want: Partial<Record<Actor, number>>): Promise<void> => {
      for (const [name, status] of Object.entries(want) as Array<[Actor, number]>) {
        const res = await actors[name].post(url, { paid });
        assert.equal(res.status, status, `${state}, ${name} says ${paid ? 'paid' : 'unpaid'}: ${res.status} ${res.text}`);
      }
    };
    const stored = (): Json => one<Json>(t.db, 'SELECT paid_at, paid_by FROM fuel_requests WHERE fuel_id = ? AND debtor_id = ?', first.id, ben.id);

    // No request yet. Only the debtor can create one by saying "paid"; everybody else needs a request to talk about.
    await expectRow('no request', true, { anonymous: 401, fueler: 404, other: 403, admin: 404 });
    await expectRow('no request', false, { anonymous: 401, fueler: 404, debtor: 403, other: 403, admin: 404 });
    assert.equal(stored(), undefined, 'nothing was created by all of that');
    await expectRow('no request', true, { debtor: 200 });
    assert.deepEqual([stored().paid_at !== null, stored().paid_by], [true, ben.id]);

    // Paid: saying paid again is harmless for everybody allowed to say it; only the person owed and an admin can undo it.
    await expectRow('paid', true, { anonymous: 401, fueler: 200, debtor: 200, other: 403, admin: 200 });
    assert.equal(stored().paid_by, ben.id, 'the first one to say it keeps their name on it');
    await expectRow('paid', false, { anonymous: 401, debtor: 403, other: 403 });
    assert.notEqual(stored().paid_at, null, 'still paid');
    await expectRow('paid', false, { fueler: 200 });
    assert.equal(stored().paid_at, null);

    // A request that is not paid (yet): undoing nothing is harmless for the two who can, a debtor still cannot.
    await expectRow('unpaid request', false, { anonymous: 401, fueler: 200, debtor: 403, other: 403, admin: 200 });
    await expectRow('unpaid request', true, { anonymous: 401, other: 403 });
    assert.equal(stored().paid_at, null);
    await expectRow('unpaid request', true, { admin: 200 });
    assert.equal(stored().paid_by, admin.id);
  } finally {
    await t.close();
  }
});

// --------------------------------------- the two additions together, from the first drive to the push

test('together: kilometres driven for others set who owes what, the push and the History data say the same, and a later fill-up carries what stayed unpaid', async () => {
  const stub = stubFetch();
  const { t, admin, anna, ben, carla } = await createHousehold({ env: ENV, fetch: stub.fetch });
  try {
    const devices = new Map<number, ReturnType<typeof makeSubscriber>>();
    for (const who of [anna, ben, carla]) {
      const sub = makeSubscriber(`https://fcm.googleapis.com/fcm/send/device-${who.id}`);
      devices.set(who.id, sub);
      assert.equal((await who.post('/api/push/subscribe', sub.subscription)).status, 201);
    }
    const drive = async (who: typeof anna, from: number, to: number, odometerStart: number, odometerEnd: number, over: Json = {}): Promise<void> => {
      const res = await who.post('/api/usage', { start: at(t.clock, from), end: at(t.clock, to), odometerStart, odometerEnd, ...over });
      assert.equal(res.status, 201, res.text);
    };
    const messagesFor = (userId: number, fuelId: number): Json[] =>
      stub.calls
        .filter((c) => c.url === devices.get(userId)?.endpoint)
        .map((c) => devices.get(userId)?.read(c) as Json)
        .filter((m) => m['tag'] === `fuel-${fuelId}`);

    // Anna drives 100 km that are Ben's and 50 km that are everybody's; Carla drives 50 km of her own.
    await drive(anna, -60, -58, 1000, 1100, { kmFor: 'person', kmUserId: ben.id, note: 'Drove Ben to his work trip' });
    await drive(anna, -56, -54, 1100, 1150, { kmFor: 'together', note: 'Groceries for the house' });
    await drive(carla, -52, -50, 1150, 1200);

    // Anna fuels for 80.00. Four active people: the 50 km pool is 12.5 km each. Ben 112.5 of 200 km, Carla 62.5, Anna and the admin 12.5.
    const first = await anna.post('/api/fuel', { at: at(t.clock, -40), millilitres: 40_000, totalCents: 8000 });
    assert.equal(first.status, 201, first.text);
    await t.app.idle();
    const cents = (f: Json): Record<number, number> => Object.fromEntries((f.shares as Json[]).map((s) => [s.userId, s.cents]));
    assert.deepEqual(cents(first.body.fuel), { [anna.id]: 500, [ben.id]: 4500, [carla.id]: 2500, [admin.id]: 500 }, 'the driver of the 150 km pays 5.00; Ben, who did not drive, pays for his 100 km');
    assert.equal(Object.values(cents(first.body.fuel)).reduce((a, b) => a + b, 0), 8000, 'to the cent');

    // The push says what the card says, to the people who owe and have a device; not to Anna (she fuelled) nor to the admin (no device).
    const firstId = first.body.fuel.id;
    assert.deepEqual(messagesFor(ben.id, firstId).map((m) => m['body']), ['You owe Anna EUR 45.00. This can still change when more drives are registered.']);
    assert.deepEqual(messagesFor(carla.id, firstId).map((m) => m['body']), ['You owe Anna EUR 25.00. This can still change when more drives are registered.']);
    assert.deepEqual(messagesFor(anna.id, firstId), []);
    const mine = ((await ben.get('/api/fuel')).body.items as Json[]).find((f) => f['id'] === firstId) as Json;
    const bensShare = (mine.shares as Json[]).find((s) => s['userId'] === ben.id) as Json;
    assert.deepEqual([bensShare['cents'], bensShare['dueCents'], bensShare['can'].selfPaid], [4500, 4500, true], 'the History screen offers Ben the same 45.00 and his button');

    // Ben says he paid, Carla does not. Then Ben (20 km) and Carla (20 km) drive their own, and Anna fuels again for 40.00.
    assert.equal((await ben.post(`/api/fuel/${firstId}/requests/${ben.id}/paid`, { paid: true })).status, 200);
    await drive(ben, -30, -28, 1200, 1220);
    await drive(carla, -26, -24, 1220, 1240);
    const second = await anna.post('/api/fuel', { at: at(t.clock, -10), millilitres: 20_000, totalCents: 4000 });
    assert.equal(second.status, 201, second.text);
    await t.app.idle();
    const secondId = second.body.fuel.id;

    assert.deepEqual(cents(second.body.fuel), { [ben.id]: 2000, [carla.id]: 2000 }, 'only the two who drove in this period have a share (there is no pool this time)');
    const carlaShare = (second.body.fuel.shares as Json[]).find((s) => s['userId'] === carla.id) as Json;
    const benShare = (second.body.fuel.shares as Json[]).find((s) => s['userId'] === ben.id) as Json;
    assert.deepEqual([carlaShare['carriedCents'], carlaShare['dueCents']], [2500, 4500], 'Carla\'s unpaid 25.00 rides along');
    assert.deepEqual([benShare['carriedCents'], benShare['dueCents']], [0, 2000], 'Ben paid, so nothing rides along');
    assert.deepEqual(messagesFor(ben.id, secondId).map((m) => m['body']), ['You owe Anna EUR 20.00. This can still change when more drives are registered.']);
    assert.deepEqual(messagesFor(carla.id, secondId).map((m) => m['body']), ['You owe Anna EUR 45.00 (EUR 20.00 now plus EUR 25.00 still open from earlier). This can still change when more drives are registered.']);

    // "Who owes whom" agrees: Carla 45.00, Ben 20.00 and the admin's 5.00 from the first fill-up, all to Anna; nothing twice.
    const balances = (await anna.get('/api/fuel')).body.balances as Json[];
    assert.equal(balances.reduce((n, b) => n + (b['cents'] as number), 0), 7000);
    assert.equal(balances.find((b) => b['fromName'] === 'Carla')?.['cents'], 4500);
    assert.equal(balances.find((b) => b['fromName'] === 'Ben')?.['cents'], 2000);
  } finally {
    await t.close();
  }
});
