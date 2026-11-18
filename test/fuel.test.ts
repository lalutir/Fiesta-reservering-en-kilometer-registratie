import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db.ts';
import { computeShares, pricePerLitreMillis, splitCents, type ShareDrive, type ShareFuel } from '../src/fuel.ts';
import { at, createHousehold, insertDraft, insertFuel, insertUsage, type Json } from './helpers.ts';

const MIN = 60_000;

// ------------------------------------------------------------ pure maths

const T1 = '2026-06-01T12:00:00.000Z';
const T2 = '2026-06-10T12:00:00.000Z';
const before = (iso: string, ms: number): string => new Date(Date.parse(iso) - ms).toISOString();
const fuel = (id: number, atUtc: string, totalCents: number): ShareFuel => ({ id, atUtc, totalCents });
const drive = (userId: number, endUtc: string, km: number): ShareDrive => ({ userId, endUtc, km });
const centsOf = (shares: Array<{ userId: number; cents: number }>): Record<number, number> => Object.fromEntries(shares.map((s) => [s.userId, s.cents]));

test('60.00 split over 100/50/50 km is exactly 30.00/15.00/15.00', () => {
  const [calc] = computeShares([fuel(1, T1, 6000)], [drive(1, before(T1, 1000), 100), drive(2, before(T1, 2000), 50), drive(3, before(T1, 3000), 50)], [1, 2, 3]);
  assert.deepEqual(centsOf(calc!.shares), { 1: 3000, 2: 1500, 3: 1500 });
  assert.equal(calc!.totalKm, 200);
  assert.equal(calc!.equalSplit, false);
  assert.deepEqual(calc!.shares.map((s) => s.km), [100, 50, 50]);
});

test('10.00 over three equal drivers is 3.34/3.33/3.33: the odd cent goes to the lowest id, the sum is exact', () => {
  const [calc] = computeShares([fuel(1, T1, 1000)], [drive(7, before(T1, 1), 1), drive(5, before(T1, 2), 1), drive(6, before(T1, 3), 1)], [5, 6, 7]);
  assert.deepEqual(centsOf(calc!.shares), { 5: 334, 6: 333, 7: 333 });
  assert.deepEqual(calc!.shares.map((s) => s.userId), [5, 6, 7], 'shares come back in user id order');
});

test('property: for 500 seeded random fill-ups the shares always add up to the total, are never negative and are within one cent of exact', () => {
  let seed = 20260617;
  const random = (): number => {
    // mulberry32, so a failure can be replayed
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
  for (let round = 0; round < 500; round++) {
    const total = int(1, 1_000_000);
    const weights = Array.from({ length: int(1, 8) }, (_, i) => ({ userId: i + 1, weight: int(0, 100_000) }));
    const parts = splitCents(total, weights);
    const sum = parts.reduce((n, p) => n + p.cents, 0);
    const weightSum = weights.reduce((n, w) => n + w.weight, 0);
    if (weightSum === 0) {
      assert.equal(sum, 0, `round ${round}: no weight, nothing allocated`);
      continue;
    }
    assert.equal(sum, total, `round ${round}: ${JSON.stringify({ total, weights })}`);
    for (const [i, p] of parts.entries()) {
      const exact = (total * (weights[i] as { weight: number }).weight) / weightSum;
      assert.ok(p.cents >= 0, `round ${round}: negative share`);
      assert.ok(Math.abs(p.cents - exact) < 1 + 1e-9, `round ${round}: ${p.cents} vs exact ${exact}`);
      if ((weights[i] as { weight: number }).weight === 0) assert.equal(p.cents, 0, `round ${round}: zero weight gets nothing`);
    }
  }
});

test('no kilometres in the period: the cost is split equally over the active users and flagged', () => {
  const [none] = computeShares([fuel(1, T1, 1000)], [], []);
  assert.deepEqual(none!.shares, [], 'nobody to split over');
  const [first, second] = computeShares([fuel(1, T1, 1000), fuel(2, T2, 1000)], [drive(1, before(T1, 1), 80)], [3, 1, 2]) as [ReturnType<typeof computeShares>[number], ReturnType<typeof computeShares>[number]];
  assert.equal(first.equalSplit, false);
  assert.equal(second.equalSplit, true);
  assert.equal(second.totalKm, 0);
  assert.deepEqual(centsOf(second.shares), { 1: 334, 2: 333, 3: 333 });
  assert.deepEqual(second.shares.map((s) => s.km), [0, 0, 0]);
});

test('a single driver carries the whole fill-up; zero-kilometre drives get no share', () => {
  const [calc] = computeShares([fuel(1, T1, 4321)], [drive(4, before(T1, 5), 33), drive(9, before(T1, 6), 0)], [4, 9]);
  assert.deepEqual(calc!.shares, [{ userId: 4, km: 33, cents: 4321 }]);
});

test('period boundaries: a drive ending exactly at the previous fill-up belongs to it, one ending exactly at this fill-up belongs to this one', () => {
  const calcs = computeShares(
    [fuel(1, T1, 1000), fuel(2, T2, 1000)],
    [drive(1, T1, 10), drive(2, T2, 10), drive(3, before(T1, 1), 10), drive(3, new Date(Date.parse(T1) + 1).toISOString(), 10)],
    [1, 2, 3],
  );
  const [first, second] = calcs as [(typeof calcs)[number], (typeof calcs)[number]];
  assert.equal(first.fromUtc, null);
  assert.deepEqual(first.shares.map((s) => [s.userId, s.km]), [[1, 10], [3, 10]], 'user 1 ended exactly at T1, user 3 just before');
  assert.equal(second.fromUtc, T1);
  assert.deepEqual(second.shares.map((s) => [s.userId, s.km]), [[2, 10], [3, 10]], 'user 2 ended exactly at T2, user 3 just after T1');
});

test('the first fill-up pays for every drive before it, however old; later drives belong to later fill-ups', () => {
  const [calc] = computeShares([fuel(1, T1, 900)], [drive(1, '2026-01-01T00:00:00.000Z', 100), drive(2, T2, 100)], [1, 2]);
  assert.deepEqual(calc!.shares.map((s) => [s.userId, s.cents]), [[1, 900]]);
});

test('the price per litre is derived in integer thousandths of a euro', () => {
  assert.equal(pricePerLitreMillis(6000, 40_000), 1500);
  assert.equal(pricePerLitreMillis(7499, 41_230), 1819);
  assert.equal(pricePerLitreMillis(1, 200_000), 0);
});

// -------------------------------------------------------------------- API

/** Three drivers (100, 50, 50 km) and nobody fuelled yet. Ids: admin 1, Anna 2, Ben 3, Carla 4. */
async function household() {
  const h = await createHousehold();
  const { t, anna, ben, carla } = h;
  insertUsage(t, { userId: anna.id, start: at(t.clock, -30), end: at(t.clock, -28), odometerStart: 1000, odometerEnd: 1100 });
  insertUsage(t, { userId: ben.id, start: at(t.clock, -26), end: at(t.clock, -24), odometerStart: 1100, odometerEnd: 1150 });
  insertUsage(t, { userId: carla.id, start: at(t.clock, -22), end: at(t.clock, -20), odometerStart: 1150, odometerEnd: 1200 });
  return h;
}

const body = (t: { clock: Parameters<typeof at>[0] }, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  at: at(t.clock, -10),
  millilitres: 40_000,
  totalCents: 6000,
  ...over,
});

test('a member records a fill-up for themselves; the figures are consistent and the shares follow the kilometres', async () => {
  const { t, anna, ben, carla } = await household();
  try {
    const res = await anna.post('/api/fuel', { ...body(t), note: 'Shell on the ring road' });
    assert.equal(res.status, 201, res.text);
    const f = res.body.fuel;
    assert.equal(f.userId, anna.id);
    assert.equal(f.userName, 'Anna');
    assert.equal(f.totalCents, 6000);
    assert.equal(f.millilitres, 40_000);
    assert.equal(f.pricePerLitreMillis, 1500);
    assert.equal(f.note, 'Shell on the ring road');
    assert.equal(f.totalKm, 200);
    assert.equal(f.equalSplit, false);
    assert.equal(f.firstInData, true);
    assert.deepEqual({ ...f.period }, { from: null, to: at(t.clock, -10) });
    assert.deepEqual(f.shares.map((s: Json) => [s.userName, s.km, s.cents, s.owes]), [
      ['Anna', 100, 3000, false],
      ['Ben', 50, 1500, true],
      ['Carla', 50, 1500, true],
    ]);
    assert.equal(f.shares.reduce((n: number, s: Json) => n + s.cents, 0), f.totalCents, 'the shares add up to the total');
    assert.deepEqual(f.can, { edit: true, delete: true });

    // Everybody sees fill-ups (like drives); only the fueler or an admin can change them.
    const seen = (await ben.get('/api/fuel')).body;
    assert.equal(seen.items.length, 1);
    assert.deepEqual(seen.items[0].can, { edit: false, delete: false });
    assert.deepEqual(seen.balances.map((b: Json) => [b.fromName, b.toName, b.cents]), [['Ben', 'Anna', 1500], ['Carla', 'Anna', 1500]]);
    assert.ok(seen.window.from < seen.window.to);
    assert.equal((await carla.get('/api/fuel')).status, 200);
    assert.equal((await t.client().get('/api/fuel')).status, 401);
  } finally {
    await t.close();
  }
});

test('who may record a fill-up: a member for themselves, an admin for anyone, nobody for someone who is not there', async () => {
  const { t, admin, anna, ben } = await household();
  try {
    assert.equal((await anna.post('/api/fuel', { ...body(t), userId: ben.id })).status, 403);
    assert.equal((await anna.post('/api/fuel', { ...body(t), userId: anna.id })).status, 201, 'explicitly for yourself is fine');
    const forBen = await admin.post('/api/fuel', { ...body(t, { at: at(t.clock, -5) }), userId: ben.id });
    assert.equal(forBen.status, 201);
    assert.equal(forBen.body.fuel.userId, ben.id);
    assert.equal(one<{ created_by: number }>(t.db, 'SELECT created_by FROM fuel WHERE id = ?', forBen.body.fuel.id)?.created_by, admin.id);
    const ghost = await admin.post('/api/fuel', { ...body(t), userId: 9999 });
    assert.equal(ghost.status, 422);
    assert.equal(ghost.body.error.fields.userId, 'unknown_user');
  } finally {
    await t.close();
  }
});

test('fill-up input is validated with a code per field: zero, negative, huge, fractional, future and out-of-window values', async () => {
  const { t, anna } = await household();
  try {
    const fields = async (over: Record<string, unknown>): Promise<Json> => {
      const res = await anna.post('/api/fuel', body(t, over));
      assert.equal(res.status, 422, JSON.stringify(over));
      return res.body.error.fields;
    };
    assert.equal((await fields({ millilitres: 0 })).millilitres, 'too_small');
    assert.equal((await fields({ millilitres: -5 })).millilitres, 'too_small');
    assert.equal((await fields({ millilitres: 200_001 })).millilitres, 'too_large');
    assert.equal((await fields({ millilitres: 40.5 })).millilitres, 'must_be_integer');
    assert.equal((await fields({ millilitres: '40' })).millilitres, 'must_be_integer');
    assert.equal((await fields({ totalCents: 0 })).totalCents, 'too_small');
    assert.equal((await fields({ totalCents: -1 })).totalCents, 'too_small');
    assert.equal((await fields({ totalCents: 1_000_001 })).totalCents, 'too_large');
    assert.equal((await fields({ totalCents: 59.99 })).totalCents, 'must_be_integer');
    assert.equal((await fields({ at: 'yesterday' })).at, 'invalid_datetime');
    assert.equal((await fields({ note: 'x'.repeat(501) })).note, 'too_long');
    assert.deepEqual({ ...(await fields({ at: undefined, millilitres: undefined, totalCents: undefined })) }, { at: 'required', millilitres: 'required', totalCents: 'required' });

    const future = await anna.post('/api/fuel', body(t, { at: new Date(t.clock.now().getTime() + 5 * MIN + 1).toISOString() }));
    assert.equal(future.status, 422);
    assert.equal(future.body.error.fields.at, 'in_future');
    assert.equal((await anna.post('/api/fuel', body(t, { at: new Date(t.clock.now().getTime() + 5 * MIN).toISOString() }))).status, 201, 'five minutes of slack');
    const old = await anna.post('/api/fuel', body(t, { at: '2025-11-01T08:00:00Z' }));
    assert.equal(old.status, 422);
    assert.equal(old.body.error.code, 'outside_window');
    assert.equal(old.body.error.fields.at, 'outside_window');
    assert.equal((await anna.post('/api/fuel', body(t, { at: '2025-12-15T11:00:00.000Z' }))).status, 201, 'the edge of the window is inside it');
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel')?.n, 2, 'nothing was stored for the rejected ones');
  } finally {
    await t.close();
  }
});

test('editing or deleting a fill-up recalculates the next one', async () => {
  const { t, anna, ben } = await household();
  try {
    const first = (await anna.post('/api/fuel', body(t, { at: at(t.clock, -23), totalCents: 3000 }))).body.fuel;
    // Carla's drive (ends at -20) now falls after the first fill-up; Ben's (-24) before it.
    const second = (await ben.post('/api/fuel', body(t, { at: at(t.clock, -5), totalCents: 2000, millilitres: 30_000 }))).body.fuel;
    assert.deepEqual(first.shares.map((s: Json) => [s.userName, s.cents]), [['Anna', 2000], ['Ben', 1000]]);
    const list = (await anna.get('/api/fuel')).body.items;
    assert.deepEqual(list.map((f: Json) => f.id), [second.id, first.id], 'newest first');
    assert.deepEqual(list[0].shares.map((s: Json) => [s.userName, s.cents]), [['Carla', 2000]]);
    assert.equal(list[0].firstInData, false);
    assert.equal(list[0].period.from, at(t.clock, -23));

    // Moving the first fill-up later pulls Carla's drive into its period; the second one then has none (equal split).
    const moved = await anna.patch(`/api/fuel/${first.id}`, { at: at(t.clock, -19) });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual(moved.body.fuel.shares.map((s: Json) => [s.userName, s.cents]), [['Anna', 1500], ['Ben', 750], ['Carla', 750]]);
    const after = (await anna.get('/api/fuel')).body.items[0];
    assert.equal(after.equalSplit, true);
    assert.equal(after.totalKm, 0);
    assert.deepEqual(after.shares.map((s: Json) => s.cents), [500, 500, 500, 500], 'equal over the four active users');

    // Deleting the first one makes the second the first in the data: it now pays for everything before it.
    assert.equal((await anna.del(`/api/fuel/${first.id}`)).status, 204);
    const only = (await anna.get('/api/fuel')).body.items;
    assert.equal(only.length, 1);
    assert.equal(only[0].firstInData, true);
    assert.equal(only[0].period.from, null);
    assert.equal(only[0].totalKm, 200);
    assert.deepEqual(only[0].shares.map((s: Json) => [s.userName, s.cents]), [['Anna', 1000], ['Ben', 500], ['Carla', 500]]);
    assert.equal((await anna.del(`/api/fuel/${first.id}`)).status, 404);
  } finally {
    await t.close();
  }
});

test('drafts and drives without readings never count towards a share', async () => {
  const { t, anna, ben, carla } = await household();
  try {
    insertDraft(t, { userId: ben.id, start: at(t.clock, -12) });
    insertUsage(t, { userId: carla.id, start: at(t.clock, -19), end: at(t.clock, -18) }); // older data without readings
    insertUsage(t, { userId: carla.id, start: at(t.clock, -17), end: at(t.clock, -16), odometerEnd: 5000 });
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    assert.equal(f.totalKm, 200);
    assert.deepEqual(f.shares.map((s: Json) => [s.userName, s.km]), [['Anna', 100], ['Ben', 50], ['Carla', 50]]);
  } finally {
    await t.close();
  }
});

test('who may edit, delete, ask for money and mark it paid: the fueler or an admin, nobody else', async () => {
  const { t, admin, anna, ben, carla } = await household();
  try {
    const id = (await anna.post('/api/fuel', body(t))).body.fuel.id;
    assert.equal((await ben.patch(`/api/fuel/${id}`, { note: 'hijack' })).status, 403, 'a debtor cannot edit');
    assert.equal((await carla.patch(`/api/fuel/${id}`, { note: 'hijack' })).status, 403, 'neither can another member');
    assert.equal((await ben.del(`/api/fuel/${id}`)).status, 403);
    assert.equal((await ben.post(`/api/fuel/${id}/requests`, { debtorId: carla.id })).status, 403);
    assert.equal((await carla.post(`/api/fuel/${id}/requests`, { debtorId: carla.id })).status, 403, 'not even for yourself');
    assert.equal((await anna.post(`/api/fuel/${id}/requests`, { debtorId: ben.id })).status, 201);
    // A debtor may say "I have paid" for their own share (fuel-carry.test.ts), but never undo it and never speak for someone else.
    assert.equal((await ben.post(`/api/fuel/${id}/requests/${ben.id}/paid`, { paid: false })).status, 403, 'a debtor cannot mark their own payment as unpaid');
    assert.equal((await carla.post(`/api/fuel/${id}/requests/${ben.id}/paid`, { paid: true })).status, 403);
    assert.equal((await t.client().post(`/api/fuel/${id}/requests/${ben.id}/paid`, { paid: true })).status, 401);

    const seenByBen = (await ben.get('/api/fuel')).body.items[0];
    assert.deepEqual(seenByBen.can, { edit: false, delete: false });
    assert.deepEqual(seenByBen.shares.map((s: Json) => s.can), [
      { request: false, markPaid: false, selfPaid: false },
      { request: false, markPaid: false, selfPaid: true },
      { request: false, markPaid: false, selfPaid: false },
    ]);
    const seenByAnna = (await anna.get('/api/fuel')).body.items[0];
    assert.deepEqual(seenByAnna.shares.map((s: Json) => [s.userName, s.can.request, s.can.markPaid]), [['Anna', false, false], ['Ben', true, true], ['Carla', true, false]]);

    assert.equal((await anna.post(`/api/fuel/${id}/requests/${ben.id}/paid`, { paid: true })).status, 200);
    assert.equal((await admin.post(`/api/fuel/${id}/requests/${ben.id}/paid`, { paid: false })).status, 200, 'an admin can undo it');
    assert.equal((await admin.patch(`/api/fuel/${id}`, { note: 'by admin' })).status, 200);
    assert.equal((await admin.patch(`/api/fuel/${id}`, { userId: ben.id })).status, 200, 'an admin can change who fuelled');
    assert.equal((await ben.post(`/api/fuel/${id}/requests`, { debtorId: ben.id })).status, 422, 'the new fueler does not owe themselves');
    assert.equal((await anna.patch(`/api/fuel/${id}`, { note: 'no longer mine' })).status, 403);
    assert.equal((await ben.patch(`/api/fuel/${id}`, { userId: anna.id })).status, 403, 'a member cannot hand it to someone else');
    assert.equal((await anna.patch('/api/fuel/9999', { note: 'x' })).status, 404);
  } finally {
    await t.close();
  }
});

test('payment requests: one per person per fill-up, never for the fueler or a zero share, link must be https, paid is final', async () => {
  const { t, admin, anna, ben } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    const url = `/api/fuel/${f.id}/requests`;
    assert.equal((await anna.post(url, { debtorId: anna.id })).body.error.fields.debtorId, 'nothing_owed', 'the fueler is not asked');
    assert.equal((await anna.post(url, { debtorId: admin.id })).body.error.fields.debtorId, 'nothing_owed', 'the admin drove nothing, so owes nothing');
    assert.equal((await anna.post(url, {})).body.error.fields.debtorId, 'required');
    for (const link of ['http://pay.example/x', 'javascript:alert(1)', 'not a url', 'https://user:pw@pay.example/x']) {
      assert.equal((await anna.post(url, { debtorId: ben.id, link })).body.error.fields.link, 'invalid_link', link);
    }

    const made = await anna.post(url, { debtorId: ben.id });
    assert.equal(made.status, 201);
    const share = made.body.fuel.shares.find((s: Json) => s.userId === ben.id);
    assert.equal(share.request.amountCents, 1500);
    assert.equal(share.request.provider, 'manual');
    assert.equal(share.request.link, '');
    assert.equal(share.request.changed, false);
    assert.equal(share.request.paidAt, null);
    assert.match(share.request.message, /Hi Ben, Anna fuelled the shared car on .* \(40\.00 L\)\. Your share is EUR 15\.00 \(50 of 200 km driven\)\. Please pay Anna\./);

    // Asking again redoes the snapshot (here with a pasted payment link) but never makes a second record.
    const again = await anna.post(url, { debtorId: ben.id, link: 'https://pay.example/abc' });
    assert.equal(again.status, 200);
    assert.equal(again.body.fuel.shares.find((s: Json) => s.userId === ben.id).request.link, 'https://pay.example/abc');
    assert.match(again.body.fuel.shares.find((s: Json) => s.userId === ben.id).request.message, /Pay here: https:\/\/pay\.example\/abc$/);
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel_requests')?.n, 1);

    // Paid is final for requests and for the fill-up itself, until it is marked unpaid again.
    assert.equal((await anna.post(`${url}/${ben.id}/paid`, { paid: true })).status, 200);
    assert.equal((await anna.post(url, { debtorId: ben.id })).body.error.code, 'already_paid');
    assert.equal((await anna.patch(`/api/fuel/${f.id}`, { note: 'x' })).body.error.code, 'has_paid_requests');
    assert.equal((await anna.del(`/api/fuel/${f.id}`)).body.error.code, 'has_paid_requests');
    const flags = (await anna.get('/api/fuel')).body.items[0];
    assert.deepEqual(flags.can, { edit: false, delete: false });
    assert.equal(flags.hasPaidRequests, true);
    assert.equal((await anna.post(`${url}/${ben.id}/paid`, { paid: false })).status, 200);
    assert.equal((await anna.patch(`/api/fuel/${f.id}`, { note: 'now fine' })).status, 200);
    assert.equal((await anna.post(`${url}/9999/paid`, { paid: true })).status, 404, 'no request for that person');
    assert.equal((await anna.post(`${url}/${ben.id}/paid`, {})).body.error.fields.paid, 'required');
  } finally {
    await t.close();
  }
});

test('marking paid or unpaid twice changes nothing: the first person to mark it keeps their name and time', async () => {
  const { t, admin, anna, ben } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    const url = `/api/fuel/${f.id}/requests`;
    await anna.post(url, { debtorId: ben.id });
    const request = (res: { body: Json }): Json => res.body.fuel.shares.find((s: Json) => s.userId === ben.id).request;
    const stamp = (): Json => one(t.db, 'SELECT paid_at, paid_by, updated_at FROM fuel_requests WHERE fuel_id = ?', f.id);

    // Unpaid -> unpaid is a no-op too.
    const untouched = stamp();
    assert.equal((await anna.post(`${url}/${ben.id}/paid`, { paid: false })).status, 200);
    assert.deepEqual({ ...stamp() }, { ...untouched });

    const first = request(await anna.post(`${url}/${ben.id}/paid`, { paid: true }));
    assert.equal(first.paidBy, anna.id);
    const afterFirst = { ...stamp() };
    t.clock.advance(5 * MIN);
    const again = await admin.post(`${url}/${ben.id}/paid`, { paid: true });
    assert.equal(again.status, 200);
    assert.deepEqual({ paidAt: request(again).paidAt, paidBy: request(again).paidBy }, { paidAt: first.paidAt, paidBy: anna.id }, 'an admin repeating it does not take over the mark');
    assert.deepEqual({ ...stamp() }, afterFirst, 'not even updated_at moves');
    assert.equal(t.logs.filter((l) => l['event'] === 'fuel.paid').length, 1, 'one change, one log line');

    assert.equal(request(await admin.post(`${url}/${ben.id}/paid`, { paid: false })).paidAt, null);
    const undone = { ...stamp() };
    t.clock.advance(5 * MIN);
    assert.equal((await anna.post(`${url}/${ben.id}/paid`, { paid: false })).status, 200);
    assert.deepEqual({ ...stamp() }, undone);
    assert.equal(t.logs.filter((l) => l['event'] === 'fuel.unpaid').length, 1);
  } finally {
    await t.close();
  }
});

test('a request is a snapshot: when a drive changes the live share, the request is flagged as changed and keeps its amount', async () => {
  const { t, anna, ben } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    await anna.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id });
    insertUsage(t, { userId: ben.id, start: at(t.clock, -19), end: at(t.clock, -18), odometerStart: 1200, odometerEnd: 1300 });
    const now = (await anna.get('/api/fuel')).body.items[0];
    const share = now.shares.find((s: Json) => s.userId === ben.id);
    assert.equal(share.cents, 3000, 'Ben now drove 150 of 300 km');
    assert.equal(share.request.amountCents, 1500, 'what was asked stays what was asked');
    assert.equal(share.request.changed, true);
  } finally {
    await t.close();
  }
});

/** The id of the (only) drive of a user in the household fixture. */
const driveOf = (t: Parameters<typeof insertUsage>[0], userId: number): number => one<{ id: number }>(t.db, 'SELECT id FROM usage WHERE user_id = ?', userId)!.id;
const names = (shares: Json[]): Json[][] => shares.map((s) => [s.userName, s.km, s.cents]);
const pairs = (balances: Json[]): Json[][] => balances.map((b) => [b.fromName, b.toName, b.cents]);

test('a drive that a payment request depends on is locked for its owner: no edit, move or delete, flagged on the drive; an admin and new drives are not affected', async () => {
  const { t, admin, anna, ben, carla } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    const benDrive = driveOf(t, ben.id);
    const later = insertUsage(t, { userId: ben.id, start: at(t.clock, -8), end: at(t.clock, -6), odometerStart: 1200, odometerEnd: 1230 }); // after the fill-up: nobody is billed for it yet
    const driveFor = async (who: typeof ben, id: number): Promise<Json> => ((await who.get('/api/usage')).body.items as Json[]).find((u) => u.id === id);

    assert.deepEqual({ ...(await driveFor(ben, benDrive)).can }, { edit: true, delete: true }, 'no request yet, so nothing is locked');
    assert.equal((await driveFor(ben, benDrive)).fuelLocked, false);

    assert.equal((await anna.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id })).status, 201);
    const locked = await driveFor(ben, benDrive);
    assert.deepEqual({ ...locked.can }, { edit: false, delete: false });
    assert.equal(locked.fuelLocked, true, 'the owner is told why');
    assert.equal((await driveFor(carla, driveOf(t, carla.id))).fuelLocked, true, 'the whole period was billed, not only the person who was asked');
    const others = await driveFor(anna, benDrive);
    assert.deepEqual([others.can.edit, others.fuelLocked], [false, false], "someone else's drive was never theirs to change, so there is nothing to explain");
    const byAdmin = await driveFor(admin, benDrive);
    assert.deepEqual([byAdmin.can.edit, byAdmin.can.delete, byAdmin.fuelLocked], [true, true, false]);
    assert.equal((await driveFor(ben, later)).fuelLocked, false, 'a drive after the last fill-up belongs to a later one');
    const history = ((await ben.get('/api/history')).body.usage as Json[]).find((u) => u.id === benDrive);
    assert.equal(history?.fuelLocked, true, 'the history list says the same');

    // The owner cannot change the kilometres, the time, the note or delete it.
    for (const change of [{ odometerEnd: 1250 }, { end: at(t.clock, -23.5) }, { note: 'typo' }]) {
      const res = await ben.patch(`/api/usage/${benDrive}`, change);
      assert.equal(res.status, 409, JSON.stringify(change));
      assert.equal(res.body.error.code, 'fuel_requested');
    }
    const refused = await ben.del(`/api/usage/${benDrive}`);
    assert.deepEqual([refused.status, refused.body.error.code], [409, 'fuel_requested']);
    assert.deepEqual({ ...one<Json>(t.db, 'SELECT odometer_end, note FROM usage WHERE id = ?', benDrive) }, { odometer_end: 1150, note: '' }, 'nothing changed');
    // Moving a free drive into the billed period is the same thing from the other side.
    const moved = await ben.patch(`/api/usage/${later}`, { start: at(t.clock, -19), end: at(t.clock, -18) });
    assert.deepEqual([moved.status, moved.body.error.code], [409, 'fuel_requested']);
    assert.equal((await ben.patch(`/api/usage/${later}`, { note: 'free to edit' })).status, 200, 'but the free drive can still be edited where it is');

    // Registering a new drive stays open to everybody, also into that period (the fuel card then flags the change).
    const added = await ben.post('/api/usage', { start: at(t.clock, -17), end: at(t.clock, -16), odometerStart: 1230, odometerEnd: 1260 });
    assert.equal(added.status, 201, added.text);
    assert.equal(added.body.usage.fuelLocked, true);

    // An admin can, and the lock goes away together with the fill-up.
    assert.equal((await admin.patch(`/api/usage/${benDrive}`, { odometerEnd: 1250 })).status, 200);
    assert.equal((await anna.del(`/api/fuel/${f.id}`)).status, 204);
    assert.equal((await driveFor(ben, benDrive)).fuelLocked, false);
    assert.equal((await ben.del(`/api/usage/${benDrive}`)).status, 204);
    assert.equal((await admin.del(`/api/usage/${added.body.usage.id}`)).status, 204);
  } finally {
    await t.close();
  }
});

test('an unpaid request stays on the card when its drive is deleted: listed, flagged, counted at what is owed now, and not offered again', async () => {
  const { t, admin, anna, ben } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    assert.equal((await anna.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id })).status, 201);
    assert.equal((await ben.del(`/api/usage/${driveOf(t, ben.id)}`)).status, 409, 'a member cannot pull the drive from under the request');
    assert.equal((await admin.del(`/api/usage/${driveOf(t, ben.id)}`)).status, 204);

    const { items, balances } = (await anna.get('/api/fuel')).body;
    assert.deepEqual(names(items[0].shares), [['Anna', 100, 4000], ['Ben', 0, 0], ['Carla', 50, 2000]], 'Ben is still listed, and Carla now pays for 50 of 150 km');
    assert.equal(items[0].shares.reduce((n: number, s: Json) => n + s.cents, 0), 6000, 'the shares still add up to the fill-up');
    const share = items[0].shares[1];
    assert.equal(share.owes, true);
    assert.deepEqual([share.request.amountCents, share.request.changed, share.request.paidAt], [1500, true, null], 'the request keeps what was asked and says it changed');
    assert.deepEqual({ ...share.can }, { request: false, markPaid: true, selfPaid: false }, 'nothing left to ask for, but the request can still be settled');
    assert.deepEqual(pairs(balances), [['Carla', 'Anna', 2000]], 'nobody is asked for money for a drive that no longer exists');
    assert.equal((await anna.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id })).body.error.fields.debtorId, 'nothing_owed', 'no request for 0.00');
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel_requests')?.n, 1, 'the request itself is still on record');
  } finally {
    await t.close();
  }
});

test('a paid request stays on the card, flagged with its changed share, when the drive is deleted or corrected afterwards', async () => {
  const { t, admin, anna, ben } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    await anna.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id });
    assert.equal((await anna.post(`/api/fuel/${f.id}/requests/${ben.id}/paid`, { paid: true })).status, 200);
    const benShare = async (): Promise<Json> => (await anna.get('/api/fuel')).body.items[0].shares.find((s: Json) => s.userId === ben.id);

    // Corrected upwards by an admin: Ben drove 100 km, so his share is 24.00 of 60.00 while he paid 15.00.
    assert.equal((await ben.patch(`/api/usage/${driveOf(t, ben.id)}`, { odometerEnd: 1200 })).status, 409);
    assert.equal((await admin.patch(`/api/usage/${driveOf(t, ben.id)}`, { odometerEnd: 1200 })).status, 200);
    let share = await benShare();
    assert.deepEqual([share.cents, share.request.amountCents, share.request.changed, share.request.paidAt !== null], [2400, 1500, true, true], 'paid, and flagged instead of looking settled');
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Carla', 'Anna', 1200]], 'what was paid is settled; the card shows the 9.00 difference');

    // Deleted instead: Ben paid for a drive that is gone, and still shows up with that payment.
    assert.equal((await admin.del(`/api/usage/${driveOf(t, ben.id)}`)).status, 204);
    share = await benShare();
    assert.deepEqual([share.km, share.cents, share.owes, share.request.amountCents, share.request.changed, share.request.paidAt !== null], [0, 0, true, 1500, true, true]);
    assert.deepEqual({ ...share.can }, { request: false, markPaid: true, selfPaid: false }, 'the fueler can still mark it unpaid');
    assert.deepEqual(pairs((await anna.get('/api/fuel')).body.balances), [['Carla', 'Anna', 2000]]);
  } finally {
    await t.close();
  }
});

test('a back-dated fill-up that moves a drive into another period leaves the old request listed and counts the share where it lands now', async () => {
  const { t, anna, ben, carla } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel; // pays for all three drives; Ben was asked for 15.00
    await anna.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id });
    // Carla remembers an earlier fill-up (30.00) that covers the drives of Anna and Ben.
    assert.equal((await carla.post('/api/fuel', body(t, { at: at(t.clock, -23), totalCents: 3000, millilitres: 20_000 }))).status, 201);

    const { items, balances } = (await anna.get('/api/fuel')).body;
    const [later, earlier] = items;
    assert.equal(later.id, f.id);
    assert.deepEqual(names(earlier.shares), [['Anna', 100, 2000], ['Ben', 50, 1000]]);
    assert.deepEqual(names(later.shares), [['Ben', 0, 0], ['Carla', 50, 6000]], 'Ben is only listed because of his request');
    assert.equal(later.shares.find((s: Json) => s.userId === ben.id).request.changed, true);
    // Ben owes Carla 10.00 for the earlier fill-up and nothing for the later one; Carla owes Anna 60.00, less the 20.00 Anna owes her.
    assert.deepEqual(pairs(balances), [['Carla', 'Anna', 4000], ['Ben', 'Carla', 1000]]);
  } finally {
    await t.close();
  }
});

test('balances net each pair and leave out what is paid', async () => {
  const { t, anna, ben, carla } = await household();
  try {
    const a = (await anna.post('/api/fuel', body(t, { at: at(t.clock, -15), totalCents: 6000 }))).body.fuel; // Ben owes Anna 1500, Carla 1500
    // Ben fuels later, when nobody drove: 6.00 split equally over the four active users, so Anna owes Ben 1.50.
    const b = (await ben.post('/api/fuel', body(t, { at: at(t.clock, -5), totalCents: 600, millilitres: 4000 }))).body.fuel;
    assert.equal(b.equalSplit, true);
    const balances = (await carla.get('/api/fuel')).body.balances;
    assert.deepEqual(balances.map((x: Json) => [x.fromName, x.toName, x.cents]), [
      ['Carla', 'Anna', 1500],
      ['Ben', 'Anna', 1350],
      ['Admin', 'Ben', 150],
      ['Carla', 'Ben', 150],
    ]);
    await anna.post(`/api/fuel/${a.id}/requests`, { debtorId: carla.id });
    await anna.post(`/api/fuel/${a.id}/requests/${carla.id}/paid`, { paid: true });
    const after = (await carla.get('/api/fuel')).body.balances;
    assert.deepEqual(after.map((x: Json) => [x.fromName, x.toName, x.cents]), [['Ben', 'Anna', 1350], ['Admin', 'Ben', 150], ['Carla', 'Ben', 150]]);
  } finally {
    await t.close();
  }
});

test('a paid request also stops a change of who fuelled; changing the fueler drops the unpaid requests', async () => {
  const { t, admin, anna, ben } = await household();
  try {
    const f = (await anna.post('/api/fuel', body(t))).body.fuel;
    await anna.post(`/api/fuel/${f.id}/requests`, { debtorId: ben.id });
    await anna.post(`/api/fuel/${f.id}/requests/${ben.id}/paid`, { paid: true });
    assert.equal((await admin.patch(`/api/fuel/${f.id}`, { userId: ben.id })).body.error.code, 'has_paid_requests');
    await anna.post(`/api/fuel/${f.id}/requests/${ben.id}/paid`, { paid: false });
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel_requests')?.n, 1);
    assert.equal((await admin.patch(`/api/fuel/${f.id}`, { userId: ben.id })).status, 200);
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM fuel_requests')?.n, 0, 'the old request was addressed to the old fueler');
    assert.equal(insertFuel(t, { userId: anna.id, at: at(t.clock, -1) }) > 0, true, 'fixture helper works');
  } finally {
    await t.close();
  }
});
