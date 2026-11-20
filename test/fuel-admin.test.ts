// Admins do not pay for fuel: no share, no payment request, no push and no "I have paid", and their own
// kilometres are left out of the split, so the others pay the whole fill-up. An admin who fuels is still
// owed the money, and kilometres an admin drove for a member (or together) count under that owner.
// The rules are in fuelOverview (src/fuel.ts); computeShares itself knows nothing about roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/db.ts';
import { ODO, at, createHousehold, insertFuel, insertUsage, makeSubscriber, stubFetch, type Json } from './helpers.ts';

const ENV = { PUSH_CONTACT: 'https://car.example.test' };

/**
 * Anna drives 100 km, Ben 50 km and the admin 100 km, one after the other. Ids: admin 1, Anna 2, Ben 3, Carla 4.
 * Without the admin rule the admin would pay 40% of a fill-up; with it Anna pays 100 of 150 and Ben 50 of 150.
 */
async function world(opts: Parameters<typeof createHousehold>[0] = {}) {
  const h = await createHousehold(opts);
  const { t, admin, anna, ben } = h;
  insertUsage(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -28), odometerStart: 1000, odometerEnd: 1100 });
  insertUsage(t, { userId: ben.id, start: at(t.clock, -26), end: at(t.clock, -24), odometerStart: 1100, odometerEnd: 1150 });
  insertUsage(t, { userId: admin.id, start: at(t.clock, -22), end: at(t.clock, -20), odometerStart: 1150, odometerEnd: 1250 });
  return h;
}

const fill = { millilitres: 40_000, totalCents: 6000 };
const nameOf = (s: Json): Json[] => [s.userName, s.km, s.cents];
const sum = (shares: Json[]): number => shares.reduce((n: number, s: Json) => n + s.cents, 0);
const pairs = (balances: Json[]): Json[][] => balances.map((b) => [b.fromName, b.toName, b.cents]);
const itemOf = (items: Json[], id: number): Json => items.find((f) => f.id === id) as Json;
const shareOf = (item: Json, userId: number): Json | undefined => (item.shares as Json[]).find((s) => s.userId === userId);

test('an admin pays no fuel: no share, no request, no "I have paid", and the others pay the whole fill-up to the cent', async () => {
  const { t, admin, anna, ben, carla } = await world();
  try {
    const res = await carla.post('/api/fuel', { at: at(t.clock, -10), ...fill });
    assert.equal(res.status, 201, res.text);
    const f = res.body.fuel;
    assert.deepEqual(f.shares.map(nameOf), [['Anna', 100, 4000], ['Ben', 50, 2000]], 'the admin\'s 100 km are left out; Anna 100 of 150, Ben 50 of 150');
    assert.equal(sum(f.shares), 6000, 'the others pay all of it, to the cent');
    assert.equal(f.totalKm, 150);
    assert.equal(f.equalSplit, false);
    assert.equal(shareOf(f, admin.id), undefined, 'no share for the admin');

    // The same card for everybody, the admin included.
    const seenByAdmin = itemOf((await admin.get('/api/fuel')).body.items, f.id);
    assert.deepEqual(seenByAdmin.shares.map(nameOf), [['Anna', 100, 4000], ['Ben', 50, 2000]]);
    assert.deepEqual(pairs((await carla.get('/api/fuel')).body.balances), [['Anna', 'Carla', 4000], ['Ben', 'Carla', 2000]], 'the admin owes nothing');

    // Nothing to ask the admin for, and the admin cannot say they paid it.
    const asked = await carla.post(`/api/fuel/${f.id}/requests`, { debtorId: admin.id });
    assert.equal(asked.status, 422);
    assert.equal(asked.body.error.fields.debtorId, 'nothing_owed');
    const said = await admin.post(`/api/fuel/${f.id}/requests/${admin.id}/paid`, { paid: true });
    assert.equal(said.status, 422);
    assert.equal(said.body.error.fields.debtorId, 'nothing_owed', 'an admin may mark any request that exists, but there is none to mark');

    // The others are unaffected.
    assert.equal((await carla.post(`/api/fuel/${f.id}/requests`, { debtorId: anna.id })).status, 201);
    assert.equal((await ben.post(`/api/fuel/${f.id}/requests/${ben.id}/paid`, { paid: true })).status, 200);
  } finally {
    await t.close();
  }
});

test('an admin\'s own kilometres are ignored, a deactivated admin\'s too; kilometres an admin drove for a member or together still count under that owner', async () => {
  const { t, admin, anna, carla } = await createHousehold();
  try {
    const ben = (await t.signIn('benno')).id; // a second member, to be the owner of kilometres the admin drove
    const root = await t.signIn('root', 'admin');
    insertUsage(t, { userId: anna.id, start: at(t.clock, -40), end: at(t.clock, -38), odometerStart: 0, odometerEnd: 100 });
    // The admin drives 60 km for Benno and 50 km together (a note is compulsory), and 40 km of their own.
    const forBenno = await admin.post('/api/usage', { start: at(t.clock, -36), end: at(t.clock, -34), ...ODO, odometerStart: 100, odometerEnd: 160, kmFor: 'person', kmUserId: ben, note: 'Drove Benno to the airport' });
    assert.equal(forBenno.status, 201, forBenno.text);
    const together = await admin.post('/api/usage', { start: at(t.clock, -32), end: at(t.clock, -30), odometerStart: 160, odometerEnd: 210, kmFor: 'together', note: 'Groceries for the house' });
    assert.equal(together.status, 201, together.text);
    insertUsage(t, { userId: admin.id, start: at(t.clock, -28), end: at(t.clock, -26), odometerStart: 210, odometerEnd: 250 });
    // A second admin who was deactivated afterwards: still an admin, so still not part of the split.
    insertUsage(t, { userId: root.id, start: at(t.clock, -24), end: at(t.clock, -22), odometerStart: 250, odometerEnd: 330 });
    run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', root.id);

    const f = (await carla.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    // Personal kilometres that count: Anna 100 and Benno 60 (from the admin). The 50 km pool follows that ratio and the
    // admin's 40 and Root's 80 km are not counted, so the shares are 100:60 of 60.00.
    assert.deepEqual(f.shares.map(nameOf), [['Anna', 100, 3750], ['Benno', 60, 2250]]);
    assert.equal(sum(f.shares), 6000);
    assert.equal(f.totalKm, 210, 'personal 160 and 50 together; neither admin\'s own kilometres');
    assert.equal(f.togetherKm, 50);
    assert.equal(f.equalSplit, false);
  } finally {
    await t.close();
  }
});

test('an admin who fuels is still owed the money, and can ask for it', async () => {
  const { t, admin, anna, ben } = await world();
  try {
    const f = (await admin.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    assert.deepEqual(f.shares.map(nameOf), [['Anna', 100, 4000], ['Ben', 50, 2000]]);
    assert.equal(f.userName, 'Admin');
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Anna', 'Admin', 4000], ['Ben', 'Admin', 2000]], 'owed to the admin');
    const asked = await admin.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id });
    assert.equal(asked.status, 201, asked.text);
    assert.equal(shareOf(asked.body.fuel, ben.id)?.request.amountCents, 2000);
    assert.equal(shareOf(asked.body.fuel, ben.id)?.owes, true);
  } finally {
    await t.close();
  }
});

test('nobody is pushed for an admin\'s share: the people who owe hear about it, the admin does not, whatever devices there are', async () => {
  const stub = stubFetch();
  const { t, admin, anna, ben, carla } = await world({ env: ENV, fetch: stub.fetch });
  try {
    const devices = new Map<number, ReturnType<typeof makeSubscriber>>();
    for (const who of [admin, anna, ben]) {
      const sub = makeSubscriber(`https://fcm.googleapis.com/fcm/send/device-${who.id}`);
      devices.set(who.id, sub);
      assert.equal((await who.post('/api/push/subscribe', sub.subscription)).status, 201);
    }
    const res = await carla.post('/api/fuel', { at: at(t.clock, -10), ...fill });
    assert.equal(res.status, 201, res.text);
    await t.app.idle();
    const callsTo = (userId: number): number => stub.calls.filter((c) => c.url === devices.get(userId)?.endpoint).length;
    assert.deepEqual([callsTo(anna.id), callsTo(ben.id), callsTo(admin.id)], [1, 1, 0]);
    const message = devices.get(anna.id)?.read(stub.calls.find((c) => c.url === devices.get(anna.id)?.endpoint) as never) as Json;
    assert.match(message['body'], /You owe Carla EUR 40\.00/);
  } finally {
    await t.close();
  }
});

test('when only an admin drove, nobody\'s kilometres count: an equal split over the active members, flagged, without the admin', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    insertUsage(t, { userId: admin.id, start: at(t.clock, -30), end: at(t.clock, -28), odometerStart: 0, odometerEnd: 100 });
    const f = (await anna.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    assert.equal(f.equalSplit, true);
    assert.equal(f.totalKm, 0, 'the admin\'s kilometres are not counted');
    assert.deepEqual(f.shares.map((s: Json) => [s.userName, s.cents]), [['Anna', 2000], ['Ben', 2000], ['Carla', 2000]]);
    assert.equal(shareOf(f, admin.id), undefined);
    assert.deepEqual(pairs((await ben.get('/api/fuel')).body.balances), [['Ben', 'Anna', 2000], ['Carla', 'Anna', 2000]]);
  } finally {
    await t.close();
  }
});

test('a household where everybody is an admin: a fill-up is saved without shares and without an error', async () => {
  const { t, anna, ben } = await world();
  try {
    run(t.db, "UPDATE users SET role = 'admin'");
    const res = await anna.post('/api/fuel', { at: at(t.clock, -10), ...fill });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.body.fuel.shares, []);
    assert.equal(res.body.fuel.totalCents, 6000);
    const list = await ben.get('/api/fuel');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.balances, []);
    assert.deepEqual(list.body.items[0].shares, []);
  } finally {
    await t.close();
  }
});

test('the rule is live: making someone an admin re-splits at once, a request made earlier keeps its amount and says it changed, and making them a member again restores it', async () => {
  const { t, anna, ben, carla } = await world();
  try {
    const f = (await carla.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    const asked = await carla.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id });
    assert.equal(asked.status, 201, asked.text);
    assert.deepEqual(f.shares.map(nameOf), [['Anna', 100, 4000], ['Ben', 50, 2000]]);

    // Ben becomes an admin: his 50 km are no longer counted, so Anna pays everything.
    run(t.db, "UPDATE users SET role = 'admin' WHERE id = ?", ben.id);
    const promoted = (await carla.get('/api/fuel')).body;
    const card = itemOf(promoted.items, f.id);
    assert.deepEqual(card.shares.map(nameOf), [['Anna', 100, 6000], ['Ben', 0, 0]], 'Ben stays listed because a request was made for him');
    assert.equal(sum(card.shares), 6000);
    const bens = shareOf(card, ben.id) as Json;
    assert.equal(bens.owes, false, 'no longer owes anything');
    assert.deepEqual([bens.request.amountCents, bens.request.changed, bens.request.currentCents], [2000, true, 0], 'the request keeps what was asked and says it moved');
    assert.deepEqual(bens.can, { request: false, markPaid: true, selfPaid: false }, 'the fueler can still settle it; Ben cannot say "I have paid" for nothing');
    assert.deepEqual(pairs(promoted.balances), [['Anna', 'Carla', 6000]], 'the old request is not a debt any more');

    // Ben sees the same, and nothing to pay.
    const bensView = shareOf(itemOf((await ben.get('/api/fuel')).body.items, f.id), ben.id) as Json;
    assert.deepEqual([bensView.owes, bensView.can.selfPaid], [false, false]);
    assert.equal((await ben.post(`/api/fuel/${f.id}/requests/${ben.id}/paid`, { paid: true })).status, 200, 'an admin may still mark a request that exists');

    // The fueler can take that mark back; a new request for the admin is refused.
    assert.equal((await carla.post(`/api/fuel/${f.id}/requests/${ben.id}/paid`, { paid: false })).status, 200);
    assert.equal((await carla.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id })).body.error.fields.debtorId, 'nothing_owed');

    // And back: the same fill-up splits as before and the request is no longer flagged.
    run(t.db, "UPDATE users SET role = 'member' WHERE id = ?", ben.id);
    const restored = itemOf((await anna.get('/api/fuel')).body.items, f.id);
    assert.deepEqual(restored.shares.map(nameOf), [['Anna', 100, 4000], ['Ben', 50, 2000]]);
    const again = shareOf(restored, ben.id) as Json;
    assert.deepEqual([again.owes, again.request.changed], [true, false]);
  } finally {
    await t.close();
  }
});

test('promoting someone through the admin API re-splits at once, and the audit lines say which role and how many people paid', async () => {
  const { t, admin, anna, ben, carla } = await world();
  try {
    const f = (await carla.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    const created = t.logs.find((l) => l['event'] === 'fuel.created' && l['id'] === f.id);
    assert.deepEqual([created?.['shares'], created?.['equalSplit']], [2, false], 'two people share the cost, by kilometres');

    const promoted = await admin.patch(`/api/admin/users/${ben.id}`, { role: 'admin' });
    assert.equal(promoted.status, 200, promoted.text);
    const line = t.logs.find((l) => l['event'] === 'user.updated' && l['userId'] === ben.id);
    assert.deepEqual([line?.['role'], line?.['active'], line?.['by']], ['admin', true, admin.id], 'the role a person ends up with is in the audit line');
    assert.equal(JSON.stringify(line).includes('password'), false);

    const card = itemOf((await anna.get('/api/fuel')).body.items, f.id);
    assert.deepEqual(card.shares.map(nameOf), [['Anna', 100, 6000]], 'Ben no longer pays; Anna pays the whole fill-up');

    const demoted = await admin.patch(`/api/admin/users/${ben.id}`, { role: 'member' });
    assert.equal(demoted.status, 200, demoted.text);
    assert.equal(t.logs.filter((l) => l['event'] === 'user.updated' && l['userId'] === ben.id).at(-1)?.['role'], 'member');
    assert.deepEqual(itemOf((await anna.get('/api/fuel')).body.items, f.id).shares.map(nameOf), [['Anna', 100, 4000], ['Ben', 50, 2000]]);

    // A fill-up nobody pays for says so in its log line.
    run(t.db, "UPDATE users SET role = 'admin'");
    const none = (await anna.post('/api/fuel', { at: at(t.clock, -5), millilitres: 30_000, totalCents: 4500 })).body.fuel;
    const line2 = t.logs.find((l) => l['event'] === 'fuel.created' && l['id'] === none.id);
    assert.deepEqual([line2?.['shares'], line2?.['equalSplit']], [0, true]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- added by the test stage

test('what an admin who fuels is owed carries over like any other debt, and one "I have paid" settles the earlier fill-up too', async () => {
  const { t, anna, ben, admin } = await world();
  try {
    const first = (await admin.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    assert.deepEqual(first.shares.map(nameOf), [['Anna', 100, 4000], ['Ben', 50, 2000]]);
    // Both drive again, 100 km each, and the admin fuels again (the admin's own 100 km before the first fill-up do not matter).
    insertUsage(t, { userId: anna.id, start: at(t.clock, -8), end: at(t.clock, -7), odometerStart: 1250, odometerEnd: 1350 });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -6), end: at(t.clock, -5), odometerStart: 1350, odometerEnd: 1450 });
    const second = (await admin.post('/api/fuel', { at: at(t.clock, -2), millilitres: 30_000, totalCents: 4000 })).body.fuel;
    assert.deepEqual(second.shares.map(nameOf), [['Anna', 100, 2000], ['Ben', 100, 2000]]);
    const [annas, bens] = [shareOf(second, anna.id), shareOf(second, ben.id)] as Json[];
    assert.deepEqual([annas.carriedCents, annas.dueCents], [4000, 6000], 'Anna still owes the admin the first fill-up');
    assert.deepEqual([bens.carriedCents, bens.dueCents], [2000, 4000]);
    assert.deepEqual(pairs((await ben.get('/api/fuel')).body.balances), [['Anna', 'Admin', 6000], ['Ben', 'Admin', 4000]]);

    // Anna says she paid the amount due on the second fill-up: the first is settled with it.
    assert.equal((await anna.post(`/api/fuel/${second.id}/requests/${anna.id}/paid`, { paid: true })).status, 200);
    assert.deepEqual(pairs((await ben.get('/api/fuel')).body.balances), [['Ben', 'Admin', 4000]], 'nothing left for Anna');
    const settled = shareOf(itemOf((await anna.get('/api/fuel')).body.items, first.id), anna.id) as Json;
    assert.equal(settled.settledBy?.fuelId, second.id);
  } finally {
    await t.close();
  }
});

test('kilometres a member drove for an admin are the admin\'s own and are left out, so nobody else is charged for them', async () => {
  const { t, admin, anna, ben } = await createHousehold();
  try {
    insertUsage(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -28), odometerStart: 0, odometerEnd: 100 });
    const forAdmin = await ben.post('/api/usage', { start: at(t.clock, -26), end: at(t.clock, -24), odometerStart: 100, odometerEnd: 150, kmFor: 'person', kmUserId: admin.id, note: 'Drove the admin to the station' });
    assert.equal(forAdmin.status, 201, forAdmin.text);
    const f = (await ben.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    assert.deepEqual(f.shares.map(nameOf), [['Anna', 100, 6000]], 'Ben drove, but the kilometres are the admin\'s: they do not count for Ben either');
    assert.equal(f.totalKm, 100);
    assert.equal(f.equalSplit, false);
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Anna', 'Ben', 6000]]);
  } finally {
    await t.close();
  }
});

test('the kilometre totals are not touched by the rule: an admin\'s kilometres are still counted there', async () => {
  const { t, anna } = await world();
  try {
    await anna.post('/api/fuel', { at: at(t.clock, -10), ...fill });
    const summary = (await anna.get('/api/usage/summary')).body;
    assert.deepEqual(
      summary.items.map((s: Json) => [s.userName, s.km]),
      [['Admin', 100], ['Anna', 100], ['Ben', 50]],
      'the admin is in the totals with their 100 km',
    );
    assert.equal(summary.totalKm, 250);
    assert.equal(itemOf((await anna.get('/api/fuel')).body.items, 1).totalKm, 150, 'and out of the fuel split');
  } finally {
    await t.close();
  }
});

test('a deactivated member takes no part in the equal split either, and neither does a deactivated admin', async () => {
  const { t, ben, carla } = await createHousehold();
  try {
    const root = await t.signIn('root', 'admin');
    run(t.db, 'UPDATE users SET active = 0 WHERE id IN (?, ?)', ben.id, root.id);
    const f = (await carla.post('/api/fuel', { at: at(t.clock, -10), ...fill })).body.fuel;
    assert.equal(f.equalSplit, true);
    assert.deepEqual(f.shares.map((s: Json) => [s.userName, s.cents]), [['Anna', 3000], ['Carla', 3000]]);
    assert.equal(sum(f.shares), 6000);
    assert.equal(shareOf(f, ben.id), undefined, 'Ben is deactivated');
  } finally {
    await t.close();
  }
});

test('property: for 25 seeded households of admins, members and a deactivated member who drive every which way, the split follows the rules to the cent', async () => {
  const { t, admin, anna, ben, carla } = await createHousehold();
  try {
    const root = await t.signIn('root', 'admin');
    const dave = await t.signIn('dave'); // a member who is deactivated: still pays for the kilometres that are his
    run(t.db, 'UPDATE users SET active = 0 WHERE id = ?', dave.id);
    const everyone = [admin.id, anna.id, ben.id, carla.id, root.id, dave.id];
    const admins = new Set([admin.id, root.id]);
    const payers = [anna.id, ben.id, carla.id];
    const names = new Map([[admin.id, 'Admin'], [anna.id, 'Anna'], [ben.id, 'Ben'], [carla.id, 'Carla'], [root.id, 'Root'], [dave.id, 'Dave']]);

    let seed = 20261119;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 25; round++) {
      run(t.db, 'DELETE FROM fuel_requests');
      run(t.db, 'DELETE FROM fuel');
      run(t.db, 'DELETE FROM usage');
      // Drives end on whole hours, fill-ups on half hours, so no drive ever sits on a period boundary.
      const drives = Array.from({ length: rand(10) }, (_, k) => {
        const driver = everyone[rand(everyone.length)] as number;
        const kind = rand(5);
        const km = rand(300);
        const kmFor = kind === 0 ? 'together' : kind === 1 ? 'person' : 'self';
        const owner = kmFor === 'person' ? (everyone.filter((u) => u !== driver)[rand(everyone.length - 1)] as number) : driver;
        const id = insertUsage(t, { userId: driver, start: at(t.clock, -100 + 4 * k), end: at(t.clock, -98 + 4 * k), odometerStart: 1000, odometerEnd: 1000 + km });
        run(t.db, 'UPDATE usage SET km_for = ?, km_user_id = ? WHERE id = ?', kmFor, kmFor === 'person' ? owner : null, id);
        return { endHours: -98 + 4 * k, km, together: kmFor === 'together', owner };
      });
      const hours = [...new Set(Array.from({ length: 1 + rand(3) }, () => -99 + rand(98)))].sort((a, b) => a - b);
      const fuels = hours.map((h) => {
        const totalCents = 1 + rand(20_000);
        return { h: h + 0.5, totalCents, id: insertFuel(t, { userId: everyone[rand(everyone.length)] as number, at: at(t.clock, h + 0.5), totalCents }) };
      });
      const stored = new Map((await anna.get('/api/fuel')).body.items.map((f: Json) => [f.id, f]));

      fuels.forEach((fuel, i) => {
        const from = i === 0 ? -Infinity : (fuels[i - 1] as { h: number }).h;
        const card = stored.get(fuel.id) as Json;
        const label = `round ${round}, fill-up ${i}: ${JSON.stringify({ drives, hours })}`;
        const inPeriod = drives.filter((d) => d.endHours > from && d.endHours <= fuel.h);
        const kmBy = new Map<number, number>();
        let pool = 0;
        for (const d of inPeriod) {
          if (d.together) pool += d.km;
          else if (!admins.has(d.owner)) kmBy.set(d.owner, (kmBy.get(d.owner) ?? 0) + d.km);
        }
        const owners = [...kmBy].filter(([, km]) => km > 0).sort((a, b) => a[0] - b[0]);
        const personal = owners.reduce((n, [, km]) => n + km, 0);
        const total = fuel.totalCents;
        const shares = card.shares as Json[];

        assert.equal(card.togetherKm, pool, label);
        assert.equal(card.totalKm, personal + pool, label);
        assert.equal(card.equalSplit, personal === 0, label);
        assert.equal(shares.some((s) => admins.has(s.userId)), false, `no admin has a share, ${label}`);
        assert.equal(sum(shares), total, `the shares add up to the fill-up to the cent, ${label}`);
        assert.ok(shares.every((s) => s.cents >= 0), label);
        if (personal > 0) {
          assert.deepEqual(shares.map((s) => s.userId), owners.map(([u]) => u), `exactly the owners of personal kilometres pay, ${label}`);
          for (const s of shares) {
            assert.equal(s.km, kmBy.get(s.userId), label);
            assert.ok(Math.abs(s.cents - (total * s.km) / personal) < 1, `${names.get(s.userId)} is within a cent of total * km / personal km, ${label}`);
          }
        } else {
          assert.deepEqual(shares.map((s) => s.userId), payers, `the active members who are not admins share equally, ${label}`);
          const cents = shares.map((s) => s.cents as number);
          assert.ok(Math.max(...cents) - Math.min(...cents) <= 1, label);
        }
      });
      // Whoever fuelled, an admin never owes anything.
      const balances = (await carla.get('/api/fuel')).body.balances as Json[];
      assert.equal(balances.some((b) => ['Admin', 'Root'].includes(b.fromName)), false, `round ${round}: no admin owes`);
    }
  } finally {
    await t.close();
  }
});
