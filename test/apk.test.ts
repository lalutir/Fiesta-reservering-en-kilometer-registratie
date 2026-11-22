// The APK expiry date of the car (src/car.ts): one record, "not set" until somebody enters it, any member can
// enter it, every change is audit-logged, and the date is a calendar day that means the same day in every zone.
// What is checked here is mostly the edges of that: the days that do not exist, the leap day, the limits, and
// what "days left" and "today" are across the clock changes of the household's zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APK_YEARS_AHEAD } from '../src/car.ts';
import { many, one } from '../src/db.ts';
import { addDateKeyYears, daysBetween, localDateKey } from '../shared/time.js';
import { createHousehold, insertApk, rawRequest, type Household, type Json, type Reply } from './helpers.ts';

const TZ = 'Europe/Amsterdam';
const NOW_DAY = '2026-06-15'; // 12:00 in Amsterdam on the default clock
const fieldsOf = (res: Reply): Record<string, string> => res.body.error.fields;
const apkRows = (h: Household): Json[] => many(h.t.db, 'SELECT id, expires_on, updated_by FROM car_apk');
const apk = async (who: { get: (url: string) => Promise<Reply> }): Promise<Json> => (await who.get('/api/car/apk')).body.apk;

test('on a fresh database the APK is not set: no date, no days left, nobody who entered it', async () => {
  const h = await createHousehold();
  try {
    for (const who of [h.anna, h.admin]) {
      const res = await who.get('/api/car/apk');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { apk: { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null } });
    }
    assert.deepEqual(apkRows(h), []);
  } finally {
    await h.t.close();
  }
});

test('any signed-in member can enter the date: the answer and the next read carry the date, who entered it, their name and when', async () => {
  const h = await createHousehold();
  try {
    const res = await h.ben.patch('/api/car/apk', { expiresOn: '2027-03-01' });
    assert.equal(res.status, 200, res.text);
    const expected = { expiresOn: '2027-03-01', daysLeft: daysBetween(NOW_DAY, '2027-03-01'), updatedBy: { id: h.ben.id, name: 'Ben' }, updatedAt: h.t.clock.now().toISOString() };
    assert.deepEqual(res.body.apk, expected);
    assert.equal(expected.daysLeft, 259);
    for (const who of [h.ben, h.anna, h.carla, h.admin]) assert.deepEqual(await apk(who), expected, 'everybody sees the same');

    // Anybody can change it when the car has been inspected again: it is the one record, so it is replaced.
    h.t.clock.advance(3_600_000);
    const again = await h.carla.patch('/api/car/apk', { expiresOn: '2029-03-01' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.apk, { expiresOn: '2029-03-01', daysLeft: daysBetween(NOW_DAY, '2029-03-01'), updatedBy: { id: h.carla.id, name: 'Carla' }, updatedAt: h.t.clock.now().toISOString() });
    assert.deepEqual(apkRows(h), [{ id: 1, expires_on: '2029-03-01', updated_by: h.carla.id }], 'one row, replaced');
    // Somebody who is deactivated afterwards is still named as the one who entered it.
    h.t.db.exec(`UPDATE users SET active = 0 WHERE id = ${h.carla.id}`);
    assert.equal((await apk(h.anna)).updatedBy.name, 'Carla');
  } finally {
    await h.t.close();
  }
});

test('every change writes one audit line with who, the old and the new date, and nothing else', async () => {
  const h = await createHousehold();
  try {
    assert.equal((await h.ben.patch('/api/car/apk', { expiresOn: '2027-03-01' })).status, 200);
    assert.equal((await h.anna.patch('/api/car/apk', { expiresOn: '2029-03-01' })).status, 200);
    assert.equal((await h.anna.patch('/api/car/apk', { expiresOn: '2020-02-29' })).status, 200, 'a past date is a change too');
    const lines = h.t.logs.filter((l) => l['event'] === 'apk.updated').map((l) => ({ ...l }));
    assert.deepEqual(lines, [
      { event: 'apk.updated', by: h.ben.id, from: null, to: '2027-03-01' },
      { event: 'apk.updated', by: h.anna.id, from: '2027-03-01', to: '2029-03-01' },
      { event: 'apk.updated', by: h.anna.id, from: '2029-03-01', to: '2020-02-29' },
    ]);
    // A refused change is not a change: no line, and the record is as it was.
    const before = h.t.logs.length;
    assert.equal((await h.ben.patch('/api/car/apk', { expiresOn: '2027-02-29' })).status, 422);
    assert.equal(h.t.logs.filter((l) => l['event'] === 'apk.updated').length, 3);
    assert.ok(h.t.logs.slice(before).every((l) => l['event'] !== 'apk.updated'));
    assert.equal((await apk(h.ben)).expiresOn, '2020-02-29');
  } finally {
    await h.t.close();
  }
});

test('only a real calendar day in strict YYYY-MM-DD is accepted: 30 February, the 29th of February in a year that has none, month 13, other shapes and times are all a 422', async () => {
  const h = await createHousehold();
  try {
    const refused: Array<[unknown, string]> = [
      ['2027-02-29', 'invalid_date'],
      ['2026-02-30', 'invalid_date'],
      ['2026-02-31', 'invalid_date'],
      ['2026-04-31', 'invalid_date'],
      ['2026-13-01', 'invalid_date'],
      ['2026-00-10', 'invalid_date'],
      ['2026-12-00', 'invalid_date'],
      ['2027-1-5', 'invalid_date'],
      ['27-01-05', 'invalid_date'],
      ['2027/01/05', 'invalid_date'],
      ['05-01-2027', 'invalid_date'],
      ['2027-01-05T00:00:00.000Z', 'invalid_date'],
      ['2027-01-05T00:00', 'invalid_date'],
      ['2027-01-05 10:00', 'invalid_date'],
      ['2027-01-05\n', 'invalid_date'],
      [' 2027-01-05', 'invalid_date'],
      ['', 'invalid_date'],
      ['soon', 'invalid_date'],
      [20270105, 'invalid_date'],
      [null, 'invalid_date'],
      [true, 'invalid_date'],
      [['2027-01-05'], 'invalid_date'],
      [{ date: '2027-01-05' }, 'invalid_date'],
      ['1999-12-31', 'invalid_date'],
      ['0000-01-01', 'invalid_date'],
      ['2101-01-01', 'invalid_date'],
      ['9999-12-31', 'invalid_date'],
    ];
    for (const [value, code] of refused) {
      const res = await h.anna.patch('/api/car/apk', { expiresOn: value });
      assert.equal(res.status, 422, JSON.stringify(value));
      assert.deepEqual(fieldsOf(res), { expiresOn: code }, JSON.stringify(value));
    }
    const missing = await h.anna.patch('/api/car/apk', {});
    assert.equal(missing.status, 422);
    assert.deepEqual(fieldsOf(missing), { expiresOn: 'required' });
    assert.deepEqual(apkRows(h), [], 'nothing was stored');
    // The good edges: the leap day of a year that has one, the first day of 2000 (a leap year), a day that is long past, month ends.
    for (const good of ['2028-02-29', '2000-01-01', '2000-02-29', '2026-06-14', '2026-06-15', '2027-12-31', '2028-04-30']) {
      const res = await h.anna.patch('/api/car/apk', { expiresOn: good });
      assert.equal(res.status, 200, good);
      assert.equal(res.body.apk.expiresOn, good);
    }
    // A leap day is a day: counted without a hiccup.
    await h.anna.patch('/api/car/apk', { expiresOn: '2028-02-29' });
    assert.equal((await apk(h.anna)).daysLeft, daysBetween(NOW_DAY, '2028-02-29'));
  } finally {
    await h.t.close();
  }
});

test('a past date is accepted and shown as expired: the days left are negative', async () => {
  const h = await createHousehold();
  try {
    for (const [date, days] of [['2026-06-15', 0], ['2026-06-14', -1], ['2026-06-16', 1], ['2026-05-15', -31], ['2025-06-15', -365], ['2000-01-01', daysBetween(NOW_DAY, '2000-01-01')]] as const) {
      const res = await h.anna.patch('/api/car/apk', { expiresOn: date });
      assert.equal(res.status, 200, date);
      assert.equal(res.body.apk.daysLeft, days, date);
    }
    assert.equal(daysBetween(NOW_DAY, '2000-01-01') < -9000, true);
  } finally {
    await h.t.close();
  }
});

test('the date may be at most five calendar years ahead of today in the household zone, with the day clamped (29 February plus five years is 28 February)', async () => {
  assert.equal(APK_YEARS_AHEAD, 5);
  const cases: Array<[string, string, string]> = [
    // [clock, the last day that is accepted, the first day that is refused]
    ['2026-06-15T10:00:00.000Z', '2031-06-15', '2031-06-16'],
    ['2026-06-14T23:30:00.000Z', '2031-06-15', '2031-06-16'], // already the 15th in Amsterdam: the local day counts, not the UTC date
    ['2028-02-29T10:00:00.000Z', '2033-02-28', '2033-03-01'], // 29 Feb + 5 years does not exist: 28 Feb
    ['2024-02-29T10:00:00.000Z', '2029-02-28', '2029-03-01'],
    ['2026-12-31T22:30:00.000Z', '2031-12-31', '2032-01-01'], // 23:30 on New Year's Eve in Amsterdam
    ['2026-12-31T23:30:00.000Z', '2032-01-01', '2032-01-02'], // 00:30 on New Year's Day
  ];
  for (const [now, last, first] of cases) {
    const h = await createHousehold({ now });
    try {
      assert.equal(addDateKeyYears(localDateKey(now, TZ), APK_YEARS_AHEAD), last, `${now}: the limit is five years from the local day`);
      const ok = await h.anna.patch('/api/car/apk', { expiresOn: last });
      assert.equal(ok.status, 200, `${now}: ${last} is the last accepted day`);
      const refused = await h.anna.patch('/api/car/apk', { expiresOn: first });
      assert.equal(refused.status, 422, `${now}: ${first} is too far`);
      assert.deepEqual(fieldsOf(refused), { expiresOn: 'too_far_ahead' });
      assert.equal((await apk(h.anna)).expiresOn, last, 'the refused one changed nothing');
    } finally {
      await h.t.close();
    }
  }
});

// ---------------------------------------------------------- days left, today, and the clock changes

/** The clocks around the clock changes of 2026: [clock, today in Amsterdam]. Each group is within one session's lifetime (30 days). */
const MARCH: Array<[string, string]> = [
  ['2026-03-27T23:30:00.000Z', '2026-03-28'],
  ['2026-03-28T10:00:00.000Z', '2026-03-28'],
  ['2026-03-28T22:59:59.999Z', '2026-03-28'],
  ['2026-03-28T23:00:00.000Z', '2026-03-29'], // midnight, the day of the change begins
  ['2026-03-29T00:30:00.000Z', '2026-03-29'], // 01:30, just before the clocks jump
  ['2026-03-29T01:00:00.000Z', '2026-03-29'], // 03:00 local, after the jump
  ['2026-03-29T10:00:00.000Z', '2026-03-29'],
  ['2026-03-29T21:59:59.999Z', '2026-03-29'],
  ['2026-03-29T22:00:00.000Z', '2026-03-30'],
];
const OCTOBER: Array<[string, string]> = [
  ['2026-10-24T21:59:59.999Z', '2026-10-24'],
  ['2026-10-24T22:00:00.000Z', '2026-10-25'], // the 25 hour day begins
  ['2026-10-25T00:30:00.000Z', '2026-10-25'], // 02:30 summer time (the first 02:30)
  ['2026-10-25T01:30:00.000Z', '2026-10-25'], // 02:30 again, now winter time
  ['2026-10-25T10:00:00.000Z', '2026-10-25'],
  ['2026-10-25T22:59:59.999Z', '2026-10-25'],
  ['2026-10-25T23:00:00.000Z', '2026-10-26'],
];

test('the days left are whole calendar days: the same count on the 23 hour and the 25 hour day, at every hour around the clock changes', async () => {
  for (const [group, expiresOn] of [[MARCH, '2026-04-30'], [OCTOBER, '2026-11-30']] as const) {
    const h = await createHousehold({ now: group[0]?.[0] as string });
    try {
      insertApk(h.t, { userId: h.anna.id, expiresOn });
      for (const [now, today] of group) {
        h.t.clock.set(now);
        assert.equal(localDateKey(now, TZ), today, `${now} is ${today} in Amsterdam`);
        const read = await apk(h.anna);
        assert.equal(read.daysLeft, daysBetween(today, expiresOn), `${now}: ${read.daysLeft} days to ${expiresOn}`);
      }
      // Spot values, so the table above is not only comparing the helper with itself.
      if (group === MARCH) {
        h.t.clock.set('2026-03-29T10:00:00.000Z');
        assert.equal((await apk(h.anna)).daysLeft, 32, '29 March to 30 April, over the 23 hour day itself');
        h.t.clock.set('2026-03-28T10:00:00.000Z');
        assert.equal((await apk(h.anna)).daysLeft, 33);
      } else {
        h.t.clock.set('2026-10-25T10:00:00.000Z');
        assert.equal((await apk(h.anna)).daysLeft, 36, '25 October to 30 November, on the 25 hour day itself');
        h.t.clock.set('2026-10-24T22:00:00.000Z');
        assert.equal((await apk(h.anna)).daysLeft, 36, 'the first instant of the 25 hour day');
        h.t.clock.set('2026-10-25T23:00:00.000Z');
        assert.equal((await apk(h.anna)).daysLeft, 35, 'the first instant of the next day');
      }
    } finally {
      await h.t.close();
    }
  }
});

test('an APK that runs out across a clock change is the same number of days away whichever side of it you stand', async () => {
  const h = await createHousehold({ now: '2026-03-25T10:00:00.000Z' });
  try {
    insertApk(h.t, { userId: h.anna.id, expiresOn: '2026-04-01' });
    const seen: number[] = [];
    for (const day of ['2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']) {
      h.t.clock.set(`${day}T10:00:00.000Z`);
      seen.push((await apk(h.anna)).daysLeft);
    }
    assert.deepEqual(seen, [7, 6, 5, 4, 3, 2, 1, 0, -1], 'one day per day, also over the 23 hour day of 29 March');
  } finally {
    await h.t.close();
  }
});

test('the browser counts the days with the same helpers as the server', async () => {
  const { apkSummary } = await import('../public/views/car.js');
  for (const group of [MARCH, OCTOBER]) {
    const h = await createHousehold({ now: group[0]?.[0] as string });
    try {
      for (const expiresOn of ['2026-11-01', '2026-03-29', '2026-10-25', '2026-03-01', '2028-02-29']) {
        insertApk(h.t, { userId: h.anna.id, expiresOn });
        for (const [now] of group) {
          h.t.clock.set(now);
          const server = (await apk(h.anna)).daysLeft;
          // What the screen computes from its own clock and the date it was given.
          assert.equal(apkSummary(expiresOn, localDateKey(now, TZ)).daysLeft, server, `${expiresOn} at ${now}`);
        }
      }
    } finally {
      await h.t.close();
    }
  }
});

test('one instant is a different day in another household zone, so the days left and the limit follow the zone', async () => {
  const now = '2026-03-28T05:00:00.000Z'; // 06:00 on the 28th in Amsterdam, 22:00 on the 27th in Los Angeles
  const amsterdam = await createHousehold({ now });
  const losAngeles = await createHousehold({ now, env: { HOUSEHOLD_TZ: 'America/Los_Angeles' } });
  try {
    for (const h of [amsterdam, losAngeles]) assert.equal((await h.anna.patch('/api/car/apk', { expiresOn: '2026-03-29' })).status, 200);
    assert.equal((await apk(amsterdam.anna)).daysLeft, 1);
    assert.equal((await apk(losAngeles.anna)).daysLeft, 2);
    // The five-year limit follows the same local day.
    assert.equal((await amsterdam.anna.patch('/api/car/apk', { expiresOn: '2031-03-28' })).status, 200);
    assert.equal((await amsterdam.anna.patch('/api/car/apk', { expiresOn: '2031-03-29' })).status, 422);
    assert.equal((await losAngeles.anna.patch('/api/car/apk', { expiresOn: '2031-03-27' })).status, 200);
    assert.equal((await losAngeles.anna.patch('/api/car/apk', { expiresOn: '2031-03-28' })).status, 422);
  } finally {
    await amsterdam.t.close();
    await losAngeles.t.close();
  }
});

test('the process zone does not matter: the server answers the same whatever TZ it runs under', async () => {
  const saved = process.env['TZ'];
  const answers: string[] = [];
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env['TZ'] = tz;
      const h = await createHousehold({ now: '2026-03-27T23:30:00.000Z' });
      try {
        assert.equal((await h.anna.patch('/api/car/apk', { expiresOn: '2026-03-30' })).status, 200);
        const damage = await h.anna.post('/api/damage', { noticedOn: '2026-03-28', location: 'front', description: 'x' });
        const tooLate = await h.anna.post('/api/damage', { noticedOn: '2026-03-29', location: 'front', description: 'x' });
        answers.push(JSON.stringify([(await apk(h.anna)).daysLeft, damage.status, tooLate.status]));
      } finally {
        await h.t.close();
      }
    }
  } finally {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  }
  assert.deepEqual(answers, [JSON.stringify([2, 201, 422]), JSON.stringify([2, 201, 422]), JSON.stringify([2, 201, 422])], 'it is already the 28th in Amsterdam: two days to the 30th, and the 29th is tomorrow');
});

test('the body must be a JSON object, and nothing but the date is read from it', async () => {
  const h = await createHousehold();
  try {
    const cookie = [...h.anna.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const send = (body: string): Promise<Reply> =>
      rawRequest(h.t.port, 'PATCH', '/api/car/apk', { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body);
    assert.equal((await send('[1]')).status, 400);
    assert.equal((await send('{nope')).status, 400);
    const res = await h.anna.patch('/api/car/apk', { expiresOn: '2027-03-01', updatedBy: h.ben.id, updatedAt: '2000-01-01T00:00:00.000Z', id: 7 });
    assert.equal(res.status, 200);
    assert.deepEqual(apkRows(h), [{ id: 1, expires_on: '2027-03-01', updated_by: h.anna.id }], 'who and when come from the server, and there is only the one record');
    assert.equal(res.body.apk.updatedAt, h.t.clock.now().toISOString());
    assert.equal(one<{ n: number }>(h.t.db, 'SELECT COUNT(*) AS n FROM car_apk')?.n, 1);
  } finally {
    await h.t.close();
  }
});
