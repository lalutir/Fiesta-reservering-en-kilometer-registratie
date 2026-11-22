// Damage reports (src/car.ts): who can do what, what is validated, how a report moves between open and repaired,
// the neutral "who had the car before" hint that is worked out on every read, and the calendar-date rules
// (the day a dent was noticed is a day of the household's calendar, whatever the server's own zone is).
// The APK date is in test/apk.test.ts, the push in test/notify.test.ts, the purge in test/retention.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DESCRIPTION_MAX, LOCATIONS, REPAIR_NOTE_MAX } from '../src/car.ts';
import { many, one, run } from '../src/db.ts';
import { windowStartDate } from '../src/validate.ts';
import { startOfLocalDay } from '../shared/time.js';
import { ODO, createHousehold, insertDamage, insertDraft, insertReservation, insertUsage, rawRequest, type Client, type Household, type Json, type Reply } from './helpers.ts';

const TZ = 'Europe/Amsterdam';
/** Today in the tests: 12:00 on 15 June 2026 in Amsterdam. */
const TODAY = '2026-06-15';
const YESTERDAY = '2026-06-14';
const HOUR = 3_600_000;
const shift = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ noticedOn: YESTERDAY, location: 'front', description: 'A dent in the bumper', ...over });
const fieldsOf = (res: Reply): Record<string, string> => res.body.error.fields;
const damageCount = (h: Household): number => (one<{ n: number }>(h.t.db, 'SELECT COUNT(*) AS n FROM damage_reports')?.n ?? 0);

/** A raw request with the person's cookie and a body that is sent exactly as written (it may not be JSON). */
function rawWithBody(h: Household, who: Client, method: string, url: string, body: string): Promise<Reply> {
  const cookie = [...who.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  return rawRequest(h.t.port, method, url, { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body);
}

// ------------------------------------------------------------------ who may do what

test('every route of the Car tab needs a login', async () => {
  const h = await createHousehold();
  try {
    const anonymous = h.t.client();
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api/damage'],
      ['POST', '/api/damage', valid()],
      ['PATCH', '/api/damage/1', { description: 'x' }],
      ['DELETE', '/api/damage/1'],
      ['POST', '/api/damage/1/repair', { repairedOn: TODAY }],
      ['GET', '/api/car/apk'],
      ['PATCH', '/api/car/apk', { expiresOn: '2027-01-01' }],
    ];
    for (const [method, url, body] of calls) {
      const res = await anonymous.request(method, url, body);
      assert.equal(res.status, 401, `${method} ${url}`);
    }
    // The router table says the same, so a new route cannot forget it.
    const mine = h.t.app.router.routes.filter((r) => r.pattern.startsWith('/api/damage') || r.pattern.startsWith('/api/car/'));
    assert.equal(mine.length, 7);
    assert.ok(mine.every((r) => r.auth === 'user'), 'any signed-in member, no admin-only part');
  } finally {
    await h.t.close();
  }
});

test('anybody signed in can file a report; the reporter is the signed-in person, whatever the body says', async () => {
  const h = await createHousehold();
  try {
    for (const who of [h.anna, h.ben, h.admin]) {
      const res = await who.post('/api/damage', valid({ reportedBy: h.carla.id }));
      assert.equal(res.status, 201, res.text);
      assert.equal(res.body.report.reportedBy.id, who.id, 'a reportedBy in the body has no effect');
    }
    assert.deepEqual(
      many<{ reported_by: number }>(h.t.db, 'SELECT reported_by FROM damage_reports ORDER BY id').map((r) => r.reported_by),
      [h.anna.id, h.ben.id, h.admin.id],
    );
  } finally {
    await h.t.close();
  }
});

test('a new report is open, trimmed, names the noticer (the reporter by default) and says what it can do; the log line has no free text', async () => {
  const h = await createHousehold();
  try {
    const res = await h.ben.post('/api/damage', valid({ location: 'left', description: '  Dent in the rear left door \n' }));
    assert.equal(res.status, 201, res.text);
    const r = res.body.report;
    assert.deepEqual(
      { ...r, id: 'x', createdAt: 'x', updatedAt: 'x' },
      {
        id: 'x',
        noticedOn: YESTERDAY,
        noticedBy: { id: h.ben.id, name: 'Ben' },
        reportedBy: { id: h.ben.id, name: 'Ben' },
        description: 'Dent in the rear left door',
        location: 'left',
        status: 'open',
        repairedOn: null,
        repairNote: '',
        createdAt: 'x',
        updatedAt: 'x',
        hint: { driver: null, basis: 'none' },
        can: { edit: true, delete: true, repair: true },
      },
    );
    assert.equal(r.createdAt, h.t.clock.now().toISOString());
    const line = h.t.logs.find((l) => l['event'] === 'damage.created');
    assert.deepEqual({ ...line }, { event: 'damage.created', id: r.id, by: h.ben.id, location: 'left', basis: 'none' });
    assert.ok(!JSON.stringify(h.t.logs).includes('Dent in the rear left door'), 'a description is free text about people: never logged');
  } finally {
    await h.t.close();
  }
});

test('everybody sees every report, newest noticed first, including ones filed or noticed by somebody who has been deactivated; the can flags are per viewer', async () => {
  const h = await createHousehold();
  try {
    const old = insertDamage(h.t, { reportedBy: h.carla.id, noticedOn: '2026-05-01', noticedBy: h.carla.id, description: 'Old scratch' });
    const mid = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01', repairedOn: '2026-06-05', repairNote: 'Done' });
    const sameDayLater = insertDamage(h.t, { reportedBy: h.ben.id, noticedOn: '2026-06-01' });
    const recent = insertDamage(h.t, { reportedBy: h.ben.id, noticedOn: '2026-06-10', noticedBy: null });
    run(h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', h.carla.id);
    const asAnna = (await h.anna.get('/api/damage')).body.items as Json[];
    assert.deepEqual(asAnna.map((r) => r.id), [recent, sameDayLater, mid, old], 'newest noticed first, then newest id');
    assert.deepEqual(asAnna.find((r) => r.id === old).reportedBy, { id: h.carla.id, name: 'Carla' }, 'a deactivated person is still named');
    assert.deepEqual(asAnna.find((r) => r.id === old).noticedBy, { id: h.carla.id, name: 'Carla' });
    assert.equal(asAnna.find((r) => r.id === recent).noticedBy, null, 'unknown');
    // Anna filed one report; Ben two; an admin may change them all; "repair" is for reports that are still open.
    const can = (items: Json[]): Record<number, string> => Object.fromEntries(items.map((r) => [r.id, `${r.can.edit}/${r.can.delete}/${r.can.repair}`]));
    assert.deepEqual(can(asAnna), { [recent]: 'false/false/true', [sameDayLater]: 'false/false/true', [mid]: 'true/true/false', [old]: 'false/false/true' });
    assert.deepEqual(can((await h.ben.get('/api/damage')).body.items), { [recent]: 'true/true/true', [sameDayLater]: 'true/true/true', [mid]: 'false/false/false', [old]: 'false/false/true' });
    assert.deepEqual(can((await h.admin.get('/api/damage')).body.items), { [recent]: 'true/true/true', [sameDayLater]: 'true/true/true', [mid]: 'true/true/false', [old]: 'true/true/true' });
  } finally {
    await h.t.close();
  }
});

test('editing and deleting: the person who filed it and an admin can; anybody else gets a 403 before the body is even read', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, description: 'Original' });
    const before = one<Json>(h.t.db, 'SELECT * FROM damage_reports WHERE id = ?', id);
    const url = `/api/damage/${id}`;
    // A valid body, an invalid one and one that is not JSON at all: for somebody else's report each is the same 403.
    for (const body of ['{"description":"Hijacked"}', '{"description":"","location":"nope","noticedOn":"2026-02-30"}', '{not json']) {
      const res = await rawWithBody(h, h.ben, 'PATCH', url, body);
      assert.equal(res.status, 403, body);
      assert.equal(res.body.error.code, 'forbidden');
    }
    assert.equal((await h.ben.del(url)).status, 403);
    assert.equal((await h.carla.post(`${url}/repair`, { repairedOn: 'rubbish' })).status, 422, 'repair is open to everybody, so a bad body is the answer there');
    assert.deepEqual(one<Json>(h.t.db, 'SELECT * FROM damage_reports WHERE id = ?', id), before, 'nothing changed');
    // An unknown id is a 404 for everybody, before any permission question.
    assert.equal((await h.ben.patch('/api/damage/9999', { description: 'x' })).status, 404);
    assert.equal((await h.ben.del('/api/damage/9999')).status, 404);
    assert.equal((await h.ben.post('/api/damage/9999/repair', { repairedOn: TODAY })).status, 404);
    assert.equal((await h.ben.patch('/api/damage/abc', { description: 'x' })).status, 404);

    assert.equal((await h.anna.patch(url, { description: 'By the person who filed it' })).status, 200);
    assert.equal((await h.admin.patch(url, { description: 'By an admin' })).status, 200);
    assert.equal(one<{ description: string }>(h.t.db, 'SELECT description FROM damage_reports WHERE id = ?', id)?.description, 'By an admin');
    assert.equal((await h.anna.del(url)).status, 204);
    assert.equal(damageCount(h), 0);
    const other = insertDamage(h.t, { reportedBy: h.ben.id });
    assert.equal((await h.admin.del(`/api/damage/${other}`)).status, 204, 'an admin can delete anybody\'s');
    assert.equal((await h.admin.del(`/api/damage/${other}`)).status, 404, 'and it is gone');
  } finally {
    await h.t.close();
  }
});

// ------------------------------------------------------------------ validation

test('the day it was noticed is required, a real calendar day in strict YYYY-MM-DD, and not in the future', async () => {
  const h = await createHousehold();
  try {
    const bad: unknown[] = ['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29', '2026-1-5', '26-06-14', '2026/06/14', '2026-06-14T10:00:00.000Z', '2026-06-14T00:00', '2026-06-14\n', ' 2026-06-14', '', '1999-12-31', '2101-01-01', 20260614, null, true, ['2026-06-14']];
    for (const noticedOn of bad) {
      const res = await h.anna.post('/api/damage', valid({ noticedOn }));
      assert.equal(res.status, 422, JSON.stringify(noticedOn));
      assert.deepEqual(fieldsOf(res), { noticedOn: 'invalid_date' }, JSON.stringify(noticedOn));
    }
    const missing = await h.anna.post('/api/damage', { location: 'front', description: 'x' });
    assert.deepEqual(fieldsOf(missing), { noticedOn: 'required' });
    // Not in the future: tomorrow is refused, today and the days before are fine, so are the first valid day and a leap day.
    assert.equal(fieldsOf(await h.anna.post('/api/damage', valid({ noticedOn: '2026-06-16' })))['noticedOn'], 'in_future');
    assert.equal(fieldsOf(await h.anna.post('/api/damage', valid({ noticedOn: '2100-01-01' })))['noticedOn'], 'in_future');
    for (const ok of [TODAY, YESTERDAY, '2024-02-29', '2000-02-29', '2000-01-01', '2025-12-31']) {
      assert.equal((await h.anna.post('/api/damage', valid({ noticedOn: ok }))).status, 201, ok);
    }
    // Old dates are fine: the six month window is for the data kept, an old known dent must still be enterable.
    assert.equal(damageCount(h), 6, 'only the six good ones were stored');
  } finally {
    await h.t.close();
  }
});

test('the description is required, trimmed and at most 1000 characters; the place is one of the list', async () => {
  const h = await createHousehold();
  try {
    const cases: Array<[Record<string, unknown>, Record<string, string>]> = [
      [{ description: undefined }, { description: 'required' }],
      [{ description: '' }, { description: 'required' }],
      [{ description: '   \n\t ' }, { description: 'required' }],
      [{ description: 'x'.repeat(DESCRIPTION_MAX + 1) }, { description: 'too_long' }],
      [{ description: 12 }, { description: 'must_be_string' }],
      [{ description: null }, { description: 'must_be_string' }],
      [{ description: '\0' }, { description: 'invalid_value' }],
      [{ description: '\0\0\0' }, { description: 'invalid_value' }],
      [{ description: 'before\0after' }, { description: 'invalid_value' }],
      [{ location: undefined }, { location: 'required' }],
      [{ location: '' }, { location: 'invalid_value' }],
      [{ location: 'bonnet' }, { location: 'invalid_value' }],
      [{ location: 'FRONT' }, { location: 'invalid_value' }],
      [{ location: 'front ' }, { location: 'invalid_value' }],
      [{ location: 7 }, { location: 'invalid_value' }],
      [{ location: null }, { location: 'invalid_value' }],
    ];
    for (const [over, expected] of cases) {
      const res = await h.anna.post('/api/damage', valid(over));
      assert.equal(res.status, 422, JSON.stringify(over));
      assert.deepEqual(fieldsOf(res), expected, JSON.stringify(over));
    }
    assert.equal(damageCount(h), 0, 'a refused report stores nothing, and a NUL is a 422, never a 500');
    // The longest allowed, and every place on the list.
    assert.equal((await h.anna.post('/api/damage', valid({ description: 'x'.repeat(DESCRIPTION_MAX) }))).status, 201);
    assert.equal((await h.anna.post('/api/damage', valid({ description: `${' '.repeat(20)}${'y'.repeat(DESCRIPTION_MAX)}${' '.repeat(20)}` }))).status, 201, 'the spaces around it are not counted');
    for (const location of LOCATIONS) assert.equal((await h.anna.post('/api/damage', valid({ location }))).status, 201, location);
    assert.equal(LOCATIONS.length, 10);
  } finally {
    await h.t.close();
  }
});

test('who noticed it: the reporter when left out, nobody when null, otherwise an active person', async () => {
  const h = await createHousehold();
  try {
    const noticer = async (extra: Record<string, unknown>): Promise<Json> => (await h.anna.post('/api/damage', valid(extra))).body.report.noticedBy;
    assert.deepEqual(await noticer({}), { id: h.anna.id, name: 'Anna' }, 'left out: the reporter');
    assert.equal(await noticer({ noticedBy: null }), null, 'null: unknown');
    assert.deepEqual(await noticer({ noticedBy: h.ben.id }), { id: h.ben.id, name: 'Ben' });
    assert.deepEqual(await noticer({ noticedBy: h.anna.id }), { id: h.anna.id, name: 'Anna' });
    run(h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', h.carla.id);
    for (const [value, code] of [[h.carla.id, 'unknown_user'], [9999, 'unknown_user'], [0, 'too_small'], [-1, 'too_small'], ['ben', 'must_be_integer'], [1.5, 'must_be_integer'], [true, 'must_be_integer']] as const) {
      const res = await h.anna.post('/api/damage', valid({ noticedBy: value }));
      assert.equal(res.status, 422, JSON.stringify(value));
      assert.deepEqual(fieldsOf(res), { noticedBy: code }, JSON.stringify(value));
    }
    assert.equal(damageCount(h), 4);
  } finally {
    await h.t.close();
  }
});

test('several field errors come back together, in one 422', async () => {
  const h = await createHousehold();
  try {
    const res = await h.anna.post('/api/damage', { noticedOn: '2026-02-30', noticedBy: 9999, location: 'bonnet', description: '' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.deepEqual(fieldsOf(res), { noticedOn: 'invalid_date', noticedBy: 'unknown_user', location: 'invalid_value', description: 'required' });
    const future = await h.anna.post('/api/damage', { noticedOn: '2027-01-01', noticedBy: 9999, location: 'front', description: 'x'.repeat(1001) });
    assert.deepEqual(fieldsOf(future), { noticedOn: 'in_future', noticedBy: 'unknown_user', description: 'too_long' });
    assert.equal(damageCount(h), 0);
    // And the body must be an object of the right type, like everywhere else.
    assert.equal((await rawWithBody(h, h.anna, 'POST', '/api/damage', '[1]')).status, 400);
    assert.equal((await rawWithBody(h, h.anna, 'POST', '/api/damage', '{broken')).status, 400);
  } finally {
    await h.t.close();
  }
});

// ------------------------------------------------------------------ calendar dates and time zones

test('"not in the future" is the household calendar day, whatever the clock says in UTC (night, DST changes)', async () => {
  // [clock, today in Amsterdam, tomorrow]
  const cases: Array<[string, string, string]> = [
    ['2026-03-27T23:30:00.000Z', '2026-03-28', '2026-03-29'], // 00:30 on 28 March, the evening before the clocks go forward
    ['2026-03-28T22:30:00.000Z', '2026-03-28', '2026-03-29'], // 23:30 on 28 March
    ['2026-03-28T23:30:00.000Z', '2026-03-29', '2026-03-30'], // 01:30 on the 23 hour day itself
    ['2026-03-29T21:30:00.000Z', '2026-03-29', '2026-03-30'], // 23:30 on the 23 hour day (UTC+2 now)
    ['2026-10-24T23:30:00.000Z', '2026-10-25', '2026-10-26'], // 01:30 on the 25 hour day, still summer time
    ['2026-10-25T22:30:00.000Z', '2026-10-25', '2026-10-26'], // 23:30 on the 25 hour day (UTC+1 again)
    ['2026-10-25T23:30:00.000Z', '2026-10-26', '2026-10-27'], // 00:30 the day after
    ['2027-03-27T23:30:00.000Z', '2027-03-28', '2027-03-29'], // the next spring change
    ['2027-03-28T22:30:00.000Z', '2027-03-29', '2027-03-30'], // 00:30 on the 29th (UTC+2)
  ];
  for (const [now, today, tomorrow] of cases) {
    const h = await createHousehold({ now });
    try {
      assert.equal((await h.anna.post('/api/damage', valid({ noticedOn: today }))).status, 201, `${now}: ${today} is today`);
      const refused = await h.anna.post('/api/damage', valid({ noticedOn: tomorrow }));
      assert.equal(refused.status, 422, `${now}: ${tomorrow} is tomorrow`);
      assert.equal(fieldsOf(refused)['noticedOn'], 'in_future');
    } finally {
      await h.t.close();
    }
  }
});

test('one instant is a different calendar day in a different household zone, and the verdict follows the zone', async () => {
  const now = '2026-03-28T05:00:00.000Z'; // 06:00 on the 28th in Amsterdam, 22:00 on the 27th in Los Angeles
  for (const [tz, accepted, refused] of [['Europe/Amsterdam', '2026-03-28', '2026-03-29'], ['America/Los_Angeles', '2026-03-27', '2026-03-28']] as const) {
    const h = await createHousehold({ now, env: { HOUSEHOLD_TZ: tz } });
    try {
      assert.equal((await h.anna.post('/api/damage', valid({ noticedOn: accepted }))).status, 201, `${tz}: ${accepted}`);
      assert.equal(fieldsOf(await h.anna.post('/api/damage', valid({ noticedOn: refused })))['noticedOn'], 'in_future', `${tz}: ${refused}`);
    } finally {
      await h.t.close();
    }
  }
});

// ------------------------------------------------------------------ marking repaired and editing

test('anybody can mark a report repaired, with a date and an optional note; the report keeps its place in the list', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    const res = await h.carla.post(`/api/damage/${id}/repair`, { repairedOn: '2026-06-12', repairNote: '  Fixed at the garage  ' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([res.body.report.status, res.body.report.repairedOn, res.body.report.repairNote], ['repaired', '2026-06-12', 'Fixed at the garage']);
    assert.deepEqual(res.body.report.can, { edit: false, delete: false, repair: false }, 'carla did not file it, and it is not open any more');
    assert.deepEqual({ ...h.t.logs.find((l) => l['event'] === 'damage.repaired') }, { event: 'damage.repaired', id, by: h.carla.id });
    assert.ok(!JSON.stringify(h.t.logs).includes('Fixed at the garage'));
    // The note is optional, and the same day as it was noticed is fine.
    const second = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: TODAY });
    const plain = await h.ben.post(`/api/damage/${second}/repair`, { repairedOn: TODAY });
    assert.equal(plain.status, 200, plain.text);
    assert.equal(plain.body.report.repairNote, '');
  } finally {
    await h.t.close();
  }
});

test('the repaired date is required, a real day, not before it was noticed, not in the future and not older than the window; the note is at most 500 characters', async () => {
  const h = await createHousehold();
  try {
    const start = windowStartDate(h.t.clock.now(), TZ, 6);
    assert.equal(start, '2025-12-15');
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2025-01-01' });
    const repair = (body: Record<string, unknown>): Promise<Reply> => h.ben.post(`/api/damage/${id}/repair`, body);
    const cases: Array<[Record<string, unknown>, Record<string, string>]> = [
      [{}, { repairedOn: 'required' }],
      [{ repairedOn: null }, { repairedOn: 'invalid_date' }],
      [{ repairedOn: '' }, { repairedOn: 'invalid_date' }],
      [{ repairedOn: '2026-02-30' }, { repairedOn: 'invalid_date' }],
      [{ repairedOn: '2026-06-14T10:00:00.000Z' }, { repairedOn: 'invalid_date' }],
      [{ repairedOn: '2024-12-31' }, { repairedOn: 'before_noticed' }],
      [{ repairedOn: '2026-06-16' }, { repairedOn: 'in_future' }],
      [{ repairedOn: '2025-12-14' }, { repairedOn: 'outside_window' }],
      [{ repairedOn: TODAY, repairNote: 'x'.repeat(REPAIR_NOTE_MAX + 1) }, { repairNote: 'too_long' }],
      [{ repairedOn: TODAY, repairNote: '\0' }, { repairNote: 'invalid_value' }],
      [{ repairedOn: TODAY, repairNote: 5 }, { repairNote: 'must_be_string' }],
      [{ repairedOn: 'x', repairNote: 'x'.repeat(REPAIR_NOTE_MAX + 1) }, { repairedOn: 'invalid_date', repairNote: 'too_long' }],
    ];
    for (const [body, expected] of cases) {
      const res = await repair(body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.deepEqual(fieldsOf(res), expected, JSON.stringify(body));
    }
    assert.equal(one<{ status: string }>(h.t.db, 'SELECT status FROM damage_reports WHERE id = ?', id)?.status, 'open', 'every refusal left it open');
    // The first day of the window is fine, and so is a note of exactly 500 characters.
    const ok = await repair({ repairedOn: start, repairNote: 'n'.repeat(REPAIR_NOTE_MAX) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.report.repairNote.length, REPAIR_NOTE_MAX);
  } finally {
    await h.t.close();
  }
});

test('a second "repaired" is a 409 that changes nothing, also when two people tap at the same moment', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    const first = await h.ben.post(`/api/damage/${id}/repair`, { repairedOn: '2026-06-10', repairNote: 'first' });
    assert.equal(first.status, 200);
    const again = await h.carla.post(`/api/damage/${id}/repair`, { repairedOn: '2026-06-12', repairNote: 'second' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_repaired');
    assert.equal((await h.carla.post(`/api/damage/${id}/repair`, { repairedOn: 'rubbish' })).status, 409, 'the stale tap is told so before its body is judged');
    assert.deepEqual(one<Json>(h.t.db, 'SELECT repaired_on, repair_note FROM damage_reports WHERE id = ?', id), { repaired_on: '2026-06-10', repair_note: 'first' });

    const open = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    const [a, b] = await Promise.all([
      h.ben.post(`/api/damage/${open}/repair`, { repairedOn: '2026-06-10', repairNote: 'ben' }),
      h.carla.post(`/api/damage/${open}/repair`, { repairedOn: '2026-06-11', repairNote: 'carla' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winner = a.status === 200 ? 'ben' : 'carla';
    assert.equal(one<{ repair_note: string }>(h.t.db, 'SELECT repair_note FROM damage_reports WHERE id = ?', open)?.repair_note, winner, 'the first one stands');
  } finally {
    await h.t.close();
  }
});

test('a tap whose body arrives after somebody else has repaired the report is a 409 too, and does not overwrite the first date', async () => {
  // Promise.all above does not force this order: the server may finish one request before it starts the other. Here the
  // late request has been read as far as its headers (the report was open then) and waits for its body while another
  // person repairs the report; only the conditional UPDATE can tell it that it is too late.
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    const cookie = [...h.ben.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const body = JSON.stringify({ repairedOn: '2026-06-11', repairNote: 'late' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const late = new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: h.t.port, method: 'POST', path: `/api/damage/${id}/repair`, agent: false, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.flushHeaders();
      void gate.then(() => req.end(body));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const quick = await h.carla.post(`/api/damage/${id}/repair`, { repairedOn: '2026-06-10', repairNote: 'quick' });
    assert.equal(quick.status, 200);
    release();
    const result = await late;
    assert.equal(result.status, 409, result.text);
    assert.match(result.text, /already_repaired/);
    assert.deepEqual(one<Json>(h.t.db, 'SELECT repaired_on, repair_note FROM damage_reports WHERE id = ?', id), { repaired_on: '2026-06-10', repair_note: 'quick' }, 'the first repair stands');
  } finally {
    await h.t.close();
  }
});

/**
 * A request whose headers are sent at once and whose body waits for release(): the server is inside the handler
 * (it has authorised the caller) and is waiting for the body, like a slow phone. `ready` resolves once the server has
 * had time to get that far.
 */
function held(h: Household, who: Client, method: string, url: string, payload: unknown): { ready: Promise<void>; release: () => void; result: Promise<{ status: number; text: string }> } {
  const cookie = [...who.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const body = JSON.stringify(payload);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const result = new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: h.t.port, method, path: url, agent: false, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.flushHeaders();
    void gate.then(() => req.end(body));
  });
  return { ready: new Promise((resolve) => setTimeout(resolve, 150)), release, result };
}

test('an edit whose body arrives after somebody else has repaired the report is merged into the report as it is now: the repair stays', async () => {
  // The caller is authorised on the report as it was when the headers came in; the merge must not use that old copy,
  // or it would write "open" and an empty date over the repair that was made while the body was on its way.
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    const late = held(h, h.anna, 'PATCH', `/api/damage/${id}`, { description: 'Edited on a slow connection' });
    await late.ready;
    const repaired = await h.ben.post(`/api/damage/${id}/repair`, { repairedOn: '2026-06-10', repairNote: 'garage' });
    assert.equal(repaired.status, 200, repaired.text);
    late.release();
    const result = await late.result;
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(
      one<Json>(h.t.db, 'SELECT status, repaired_on, repair_note, description FROM damage_reports WHERE id = ?', id),
      { status: 'repaired', repaired_on: '2026-06-10', repair_note: 'garage', description: 'Edited on a slow connection' },
      'the edit is kept and so is the repair',
    );
  } finally {
    await h.t.close();
  }
});

test('an edit or a repair whose body arrives after the report was deleted is a 404, not a write', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    const edit = held(h, h.anna, 'PATCH', `/api/damage/${id}`, { description: 'Too late' });
    const repair = held(h, h.ben, 'POST', `/api/damage/${id}/repair`, { repairedOn: '2026-06-10' });
    await Promise.all([edit.ready, repair.ready]);
    assert.equal((await h.anna.del(`/api/damage/${id}`)).status, 204);
    edit.release();
    repair.release();
    assert.equal((await edit.result).status, 404);
    assert.equal((await repair.result).status, 404);
    assert.equal(damageCount(h), 0);
  } finally {
    await h.t.close();
  }
});

test('a repair whose body arrives after the noticed day was moved later is checked against the new day: 422, not a failed CHECK', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    // 5 June is after the day the report had when the headers came in, and before the day it has now.
    const late = held(h, h.ben, 'POST', `/api/damage/${id}/repair`, { repairedOn: '2026-06-05' });
    await late.ready;
    assert.equal((await h.anna.patch(`/api/damage/${id}`, { noticedOn: '2026-06-10' })).status, 200);
    late.release();
    const result = await late.result;
    assert.equal(result.status, 422, result.text);
    assert.match(result.text, /before_noticed/);
    assert.deepEqual(one<Json>(h.t.db, 'SELECT status, repaired_on, noticed_on FROM damage_reports WHERE id = ?', id), { status: 'open', repaired_on: null, noticed_on: '2026-06-10' });
  } finally {
    await h.t.close();
  }
});

test('the person who filed it, or an admin, can set a repaired report back to open: that clears the date and the note', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01', repairedOn: '2026-06-10', repairNote: 'garage' });
    assert.equal((await h.ben.patch(`/api/damage/${id}`, { status: 'open' })).status, 403, 'not for somebody else');
    const reopened = await h.anna.patch(`/api/damage/${id}`, { status: 'open' });
    assert.equal(reopened.status, 200, reopened.text);
    assert.deepEqual([reopened.body.report.status, reopened.body.report.repairedOn, reopened.body.report.repairNote], ['open', null, '']);
    assert.deepEqual({ ...h.t.logs.find((l) => l['event'] === 'damage.updated') }, { event: 'damage.updated', id, by: h.anna.id, status: 'open', reopened: true });
    // It can be repaired again with a new date.
    assert.equal((await h.ben.post(`/api/damage/${id}/repair`, { repairedOn: '2026-06-14' })).status, 200);
    assert.equal((await h.admin.patch(`/api/damage/${id}`, { status: 'open', repairedOn: null })).status, 200, 'an admin can too; a null date says the same as none');
  } finally {
    await h.t.close();
  }
});

test('editing keeps the rules of a whole row: open has no repaired date or note, repaired has a date, and what is not changed is not re-checked', async () => {
  const h = await createHousehold();
  try {
    const open = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01' });
    const patch = (id: number, body: Record<string, unknown>): Promise<Reply> => h.anna.patch(`/api/damage/${id}`, body);
    // Open: no repair data can be sent.
    assert.deepEqual(fieldsOf(await patch(open, { repairedOn: '2026-06-10' })), { repairedOn: 'only_when_repaired' });
    assert.deepEqual(fieldsOf(await patch(open, { repairNote: 'note' })), { repairNote: 'only_when_repaired' });
    assert.deepEqual(fieldsOf(await patch(open, { status: 'open', repairedOn: '2026-06-10', repairNote: 'x' })), { repairedOn: 'only_when_repaired', repairNote: 'only_when_repaired' });
    assert.equal((await patch(open, { repairedOn: null, repairNote: '' })).status, 200, 'nothing is nothing');
    // Repaired through an edit needs its date.
    assert.deepEqual(fieldsOf(await patch(open, { status: 'repaired' })), { repairedOn: 'required' });
    assert.deepEqual(fieldsOf(await patch(open, { status: 'repaired', repairedOn: null })), { repairedOn: 'required' });
    assert.deepEqual(fieldsOf(await patch(open, { status: 'fixed' })), { status: 'invalid_value' });
    assert.deepEqual(fieldsOf(await patch(open, { status: 'repaired', repairedOn: '2026-05-31' })), { repairedOn: 'before_noticed' });
    assert.deepEqual(fieldsOf(await patch(open, { status: 'repaired', repairedOn: '2026-06-16' })), { repairedOn: 'in_future' });
    assert.deepEqual(fieldsOf(await patch(open, { status: 'repaired', repairedOn: '2026-02-30' })), { repairedOn: 'invalid_date' });
    const repaired = await patch(open, { status: 'repaired', repairedOn: '2026-06-10', repairNote: 'garage' });
    assert.equal(repaired.status, 200, repaired.text);
    assert.deepEqual([repaired.body.report.status, repaired.body.report.repairedOn, repaired.body.report.repairNote], ['repaired', '2026-06-10', 'garage']);
    // The noticed day cannot move past the repaired day.
    assert.deepEqual(fieldsOf(await patch(open, { noticedOn: '2026-06-11' })), { repairedOn: 'before_noticed' });
    assert.deepEqual(fieldsOf(await patch(open, { noticedOn: '2026-06-16' })), { noticedOn: 'in_future', repairedOn: 'before_noticed' });
    assert.equal((await patch(open, { repairNote: '' })).body.report.repairNote, '', 'the note can be emptied');

    // A report that has aged toward the edge stays editable: a date that is not being changed is not checked again.
    const aged = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2020-01-01', repairedOn: '2025-02-01' }); // repaired before the window starts
    assert.equal((await patch(aged, { repairNote: 'still editable' })).status, 200, 'the old repaired date is left alone');
    assert.equal((await patch(aged, { description: 'and so is the text', noticedOn: '2020-01-01', repairedOn: '2025-02-01' })).status, 200, 'also when the same dates are sent again');
    assert.deepEqual(fieldsOf(await patch(aged, { repairedOn: '2025-03-01' })), { repairedOn: 'outside_window' }, 'a new date is checked');
    assert.deepEqual(fieldsOf(await patch(aged, { repairedOn: '2019-12-31' })), { repairedOn: 'before_noticed' });
    // An open report noticed years ago is fine to edit as well.
    const ancient = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2001-01-01' });
    assert.equal((await patch(ancient, { description: 'Still there' })).status, 200);
  } finally {
    await h.t.close();
  }
});

test('editing the other fields: the text, the place and who noticed it; a noticer who has been deactivated since stays, a new one must be active', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedBy: h.carla.id, noticedOn: '2026-06-01', description: 'Original', location: 'front' });
    run(h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', h.carla.id);
    const patch = (body: Record<string, unknown>): Promise<Reply> => h.anna.patch(`/api/damage/${id}`, body);
    const edited = await patch({ description: ' New text ', location: 'rear' });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual([edited.body.report.description, edited.body.report.location, edited.body.report.noticedBy], ['New text', 'rear', { id: h.carla.id, name: 'Carla' }], 'a deactivated noticer is kept when something else is edited');
    assert.equal((await patch({ noticedBy: h.carla.id, description: 'Sent again' })).status, 200, 'and when the same noticer is sent again');
    assert.deepEqual(fieldsOf(await patch({ noticedBy: 9999 })), { noticedBy: 'unknown_user' });
    assert.equal((await patch({ noticedBy: h.ben.id })).body.report.noticedBy.name, 'Ben');
    assert.deepEqual(fieldsOf(await patch({ noticedBy: h.carla.id })), { noticedBy: 'unknown_user' }, 'a deactivated person cannot be newly picked');
    assert.equal((await patch({ noticedBy: null })).body.report.noticedBy, null, 'unknown');
    assert.equal((await patch({})).status, 200, 'an empty edit changes nothing');
    assert.deepEqual(fieldsOf(await patch({ description: '' })), { description: 'required' });
    assert.deepEqual(fieldsOf(await patch({ description: '\0' })), { description: 'invalid_value' });
    assert.deepEqual(fieldsOf(await patch({ description: 'x'.repeat(1001), location: 'bonnet', noticedOn: '2026-02-30' })), { description: 'too_long', location: 'invalid_value', noticedOn: 'invalid_date' });
    assert.deepEqual(fieldsOf(await patch({ noticedOn: '2026-06-16' })), { noticedOn: 'in_future' });
    assert.equal((await patch({ noticedOn: '2026-06-02' })).body.report.noticedOn, '2026-06-02');
    assert.equal(one<{ description: string }>(h.t.db, 'SELECT description FROM damage_reports WHERE id = ?', id)?.description, 'Sent again', 'the refused edits left it alone');
    // reportedBy cannot be changed by an edit either.
    assert.equal((await patch({ reportedBy: h.ben.id })).body.report.reportedBy.id, h.anna.id);
  } finally {
    await h.t.close();
  }
});

// ------------------------------------------------------------------ the hint: who had the car before

/** File a report for `noticedOn` after `setup` has put drives and reservations in place; returns the hint the server worked out. */
async function hintAfter(setup: (h: Household, dayStart: string) => void | Promise<void>, noticedOn = '2026-06-10', now?: string): Promise<Json> {
  const h = await createHousehold(now ? { now } : {});
  try {
    await setup(h, startOfLocalDay(noticedOn, TZ));
    const res = await h.carla.post('/api/damage', valid({ noticedOn }));
    assert.equal(res.status, 201, res.text);
    const listed = (await h.carla.get('/api/damage')).body.items[0];
    assert.deepEqual(listed.hint, res.body.report.hint, 'the list says the same as the answer to the create');
    return res.body.report.hint;
  } finally {
    await h.t.close();
  }
}

const done = (h: Household, who: Client, from: string, to: string): number => insertUsage(h.t, { userId: who.id, start: from, end: to, ...ODO });

test('the hint: a logged drive that covers the start of the noticed day comes first, the later start wins, both ends count', async () => {
  const covering = await hintAfter((h, day) => void done(h, h.anna, shift(day, -2 * HOUR), shift(day, HOUR)));
  assert.deepEqual(covering, { driver: { id: covering.driver.id, name: 'Anna' }, basis: 'drive' });
  const later = await hintAfter((h, day) => {
    done(h, h.anna, shift(day, -3 * HOUR), shift(day, 2 * HOUR));
    done(h, h.ben, shift(day, -HOUR), shift(day, HOUR));
  });
  assert.deepEqual([later.driver.name, later.basis], ['Ben', 'drive'], 'two drives cover it: the one that started later');
  const endsAtStart = await hintAfter((h, day) => void done(h, h.anna, shift(day, -2 * HOUR), day));
  assert.deepEqual([endsAtStart.driver.name, endsAtStart.basis], ['Anna', 'drive'], 'a drive that ends at the very start of the day covers it');
  const startsAtStart = await hintAfter((h, day) => void done(h, h.ben, day, shift(day, HOUR)));
  assert.deepEqual([startsAtStart.driver.name, startsAtStart.basis], ['Ben', 'drive'], 'and so does one that starts then: it was already under way');
});

test('the hint: without a covering drive an open draft counts, then a confirmed reservation, and suggestions that were never agreed do not', async () => {
  const draft = await hintAfter((h, day) => void insertDraft(h.t, { userId: h.ben.id, start: shift(day, -3 * HOUR) }));
  assert.deepEqual([draft.driver.name, draft.basis], ['Ben', 'draft']);
  const reservation = await hintAfter((h, day) => void insertReservation(h.t, { userId: h.anna.id, start: shift(day, -HOUR), end: shift(day, 5 * HOUR) }));
  assert.deepEqual([reservation.driver.name, reservation.basis], ['Anna', 'reservation']);
  const both = await hintAfter((h, day) => {
    insertReservation(h.t, { userId: h.anna.id, start: shift(day, -HOUR), end: shift(day, 5 * HOUR) });
    done(h, h.ben, shift(day, -2 * HOUR), shift(day, HOUR));
  });
  assert.deepEqual([both.driver.name, both.basis], ['Ben', 'drive'], 'a drive in the log beats a reservation');
  const unagreed = await hintAfter((h, day) => {
    insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'pending', start: shift(day, -HOUR), end: shift(day, 5 * HOUR) });
    insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'declined', start: shift(day, -HOUR), end: shift(day, 5 * HOUR) });
  });
  assert.deepEqual(unagreed, { driver: null, basis: 'none' });
});

test('the hint: with nobody on record at that moment it is the driver of the last completed drive that ended before the day, and drives on the day itself are not counted', async () => {
  const last = await hintAfter((h, day) => {
    done(h, h.anna, shift(day, -30 * HOUR), shift(day, -29 * HOUR));
    done(h, h.ben, shift(day, -10 * HOUR), shift(day, -9 * HOUR));
    done(h, h.admin, shift(day, -20 * HOUR), shift(day, -19 * HOUR));
  });
  assert.deepEqual([last.driver.name, last.basis], ['Ben', 'last_drive'], 'the most recent one that ended before the day');
  const justBefore = await hintAfter((h, day) => void done(h, h.anna, shift(day, -2 * HOUR), shift(day, -1)));
  assert.deepEqual([justBefore.driver.name, justBefore.basis], ['Anna', 'last_drive'], 'a drive that ended a millisecond before the day began');
  const onTheDay = await hintAfter((h, day) => {
    done(h, h.anna, shift(day, 2 * HOUR), shift(day, 3 * HOUR));
    done(h, h.ben, shift(day, 30 * HOUR), shift(day, 31 * HOUR));
  });
  assert.deepEqual(onTheDay, { driver: null, basis: 'none' }, 'what happened on or after the noticed day says nothing about before it');
  assert.deepEqual(await hintAfter(() => undefined), { driver: null, basis: 'none' });
  const draftNotCounted = await hintAfter((h, day) => void insertDraft(h.t, { userId: h.ben.id, start: shift(day, -30 * HOUR) }));
  assert.deepEqual(draftNotCounted, { driver: null, basis: 'none' }, 'a draft from long before is not a drive that ended');
  const ancient = await hintAfter(() => undefined, '2020-03-01');
  assert.deepEqual(ancient, { driver: null, basis: 'none' }, 'a report from before the data that is kept');
});

test('the hint still names somebody who has been deactivated, and is the same for every viewer', async () => {
  const h = await createHousehold();
  try {
    const day = startOfLocalDay('2026-06-10', TZ);
    done(h, h.carla, shift(day, -3 * HOUR), shift(day, HOUR));
    run(h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', h.carla.id);
    const id = (await h.anna.post('/api/damage', valid({ noticedOn: '2026-06-10' }))).body.report.id;
    for (const who of [h.anna, h.ben, h.admin]) {
      const item = (await who.get('/api/damage')).body.items.find((r: Json) => r.id === id);
      assert.deepEqual(item.hint, { driver: { id: h.carla.id, name: 'Carla' }, basis: 'drive' });
    }
  } finally {
    await h.t.close();
  }
});

test('the hint starts at local midnight: on the 23 hour and the 25 hour day too', async () => {
  // 29 March 2026 starts at 00:00 CET = 23:00 UTC on the 28th; 25 October 2026 starts at 00:00 CEST = 22:00 UTC on the 24th.
  const later = '2026-11-15T10:00:00.000Z';
  for (const [noticedOn, start] of [['2026-03-29', '2026-03-28T23:00:00.000Z'], ['2026-10-25', '2026-10-24T22:00:00.000Z'], ['2026-03-30', '2026-03-29T22:00:00.000Z'], ['2026-10-26', '2026-10-25T23:00:00.000Z']] as const) {
    assert.equal(startOfLocalDay(noticedOn, TZ), start);
    const endsAt = await hintAfter((h, day) => void done(h, h.anna, shift(day, -HOUR), day), noticedOn, later);
    assert.deepEqual([endsAt.driver.name, endsAt.basis], ['Anna', 'drive'], `${noticedOn}: ends at the start of the day, so it covers it`);
    const before = await hintAfter((h, day) => void done(h, h.anna, shift(day, -HOUR), shift(day, -1)), noticedOn, later);
    assert.deepEqual([before.driver.name, before.basis], ['Anna', 'last_drive'], `${noticedOn}: ends a millisecond earlier`);
    // A drive an hour into the day itself says nothing about before it.
    const onTheDay = await hintAfter((h, day) => void done(h, h.anna, shift(day, HOUR), shift(day, 2 * HOUR)), noticedOn, later);
    assert.deepEqual(onTheDay, { driver: null, basis: 'none' }, noticedOn);
  }
});

test('the hint is derived on every read and never stored: correcting or deleting the drive changes it on the next read', async () => {
  const h = await createHousehold();
  try {
    const day = startOfLocalDay('2026-06-10', TZ);
    const drive = done(h, h.anna, shift(day, -3 * HOUR), shift(day, HOUR));
    const id = (await h.carla.post('/api/damage', valid({ noticedOn: '2026-06-10' }))).body.report.id;
    const hint = async (): Promise<Json> => (await h.carla.get('/api/damage')).body.items.find((r: Json) => r.id === id).hint;
    assert.deepEqual([(await hint()).driver.name, (await hint()).basis], ['Anna', 'drive']);
    // The driver is corrected: Ben had the car.
    assert.equal((await h.admin.patch(`/api/usage/${drive}`, { userId: h.ben.id })).status, 200);
    assert.deepEqual([(await hint()).driver.name, (await hint()).basis], ['Ben', 'drive']);
    // The drive is moved to end before the day: the same person, a different basis.
    assert.equal((await h.admin.patch(`/api/usage/${drive}`, { start: shift(day, -5 * HOUR), end: shift(day, -4 * HOUR) })).status, 200);
    assert.deepEqual([(await hint()).driver.name, (await hint()).basis], ['Ben', 'last_drive']);
    // And it is gone.
    assert.equal((await h.admin.del(`/api/usage/${drive}`)).status, 204);
    assert.deepEqual(await hint(), { driver: null, basis: 'none' });
    // Nothing about it is in the table.
    const columns = many<{ name: string }>(h.t.db, "SELECT name FROM pragma_table_info('damage_reports')").map((c) => c.name);
    assert.ok(!columns.some((c) => /driver|hint|basis/.test(c)), `no stored driver: ${columns.join(', ')}`);
  } finally {
    await h.t.close();
  }
});

test('many reports noticed on the same day all carry the same hint', async () => {
  const h = await createHousehold();
  try {
    const day = startOfLocalDay('2026-06-10', TZ);
    done(h, h.anna, shift(day, -3 * HOUR), shift(day, HOUR));
    for (let i = 0; i < 20; i++) insertDamage(h.t, { reportedBy: h.ben.id, noticedOn: '2026-06-10', description: `Scratch ${i}` });
    const items = (await h.ben.get('/api/damage')).body.items as Json[];
    assert.equal(items.length, 20);
    assert.ok(items.every((r) => r.hint.driver.name === 'Anna' && r.hint.basis === 'drive'));
  } finally {
    await h.t.close();
  }
});

test('the limits in the browser are the limits on the server, and the places on the list are the places the database accepts', async () => {
  const view = await import('../public/views/car.js');
  assert.deepEqual([...view.LOCATIONS], [...LOCATIONS]);
  assert.equal(view.DESCRIPTION_MAX, DESCRIPTION_MAX);
  assert.equal(view.REPAIR_NOTE_MAX, REPAIR_NOTE_MAX);
  const h = await createHousehold();
  try {
    for (const location of LOCATIONS) assert.ok(insertDamage(h.t, { reportedBy: h.anna.id, location }) > 0, location);
  } finally {
    await h.t.close();
  }
});

// ------------------------------------------------------------------ what the body may and may not decide

test('a new report is always open: repair data, an id or timestamps in the create body are not read', async () => {
  const h = await createHousehold();
  try {
    const res = await h.anna.post(
      '/api/damage',
      valid({ status: 'repaired', repairedOn: YESTERDAY, repairNote: 'Already fixed', id: 999, createdAt: '2001-01-01T00:00:00.000Z', updatedAt: '2001-01-01T00:00:00.000Z' }),
    );
    assert.equal(res.status, 201, res.text);
    const r = res.body.report;
    assert.deepEqual([r.status, r.repairedOn, r.repairNote], ['open', null, ''], 'open, with no repaired date and no note');
    assert.deepEqual(r.can, { edit: true, delete: true, repair: true }, 'so it can still be marked repaired');
    assert.notEqual(r.id, 999);
    assert.equal(r.createdAt, h.t.clock.now().toISOString());
    assert.equal(r.updatedAt, h.t.clock.now().toISOString());
    assert.deepEqual(one<Json>(h.t.db, 'SELECT status, repaired_on, repair_note FROM damage_reports WHERE id = ?', r.id), { status: 'open', repaired_on: null, repair_note: '' });
    assert.equal(damageCount(h), 1);
  } finally {
    await h.t.close();
  }
});

test('who filed a report never changes: a reportedBy in an edit has no effect, and an admin who edits does not become the one who filed it', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, description: 'Original' });
    const url = `/api/damage/${id}`;
    const reporter = (): number | undefined => one<{ reported_by: number }>(h.t.db, 'SELECT reported_by FROM damage_reports WHERE id = ?', id)?.reported_by;

    const byAnna = await h.anna.patch(url, { description: 'Edited by Anna', reportedBy: h.ben.id });
    assert.equal(byAnna.status, 200, byAnna.text);
    assert.deepEqual(byAnna.body.report.reportedBy, { id: h.anna.id, name: 'Anna' });
    const byAdmin = await h.admin.patch(url, { description: 'Edited by the admin', reportedBy: h.carla.id });
    assert.equal(byAdmin.status, 200, byAdmin.text);
    assert.deepEqual(byAdmin.body.report.reportedBy, { id: h.anna.id, name: 'Anna' }, 'the admin changed the text, not who filed it');
    assert.equal(reporter(), h.anna.id);
    // So the permission follows the person who filed it, not the last one who edited: Ben and Carla still have no say.
    assert.equal((await h.ben.patch(url, { description: 'Hijack' })).status, 403);
    assert.equal((await h.carla.del(url)).status, 403);
    assert.equal(one<{ description: string }>(h.t.db, 'SELECT description FROM damage_reports WHERE id = ?', id)?.description, 'Edited by the admin');
  } finally {
    await h.t.close();
  }
});

test('an edit, a repair or an APK change whose body is not a JSON object is a 400 once the person is allowed in, and changes nothing', async () => {
  const h = await createHousehold();
  try {
    const id = insertDamage(h.t, { reportedBy: h.anna.id, noticedOn: '2026-06-01', description: 'Untouched' });
    const before = one<Json>(h.t.db, 'SELECT * FROM damage_reports WHERE id = ?', id);
    for (const body of ['[1]', '{broken', '"text"', 'null']) {
      const edit = await rawWithBody(h, h.anna, 'PATCH', `/api/damage/${id}`, body);
      assert.equal(edit.status, 400, `edit: ${body}`);
      const repair = await rawWithBody(h, h.ben, 'POST', `/api/damage/${id}/repair`, body);
      assert.equal(repair.status, 400, `repair: ${body}`);
      assert.equal((await rawWithBody(h, h.anna, 'PATCH', '/api/car/apk', body)).status, 400, `apk: ${body}`);
    }
    assert.deepEqual(one<Json>(h.t.db, 'SELECT * FROM damage_reports WHERE id = ?', id), before, 'nothing changed');
    assert.deepEqual(many(h.t.db, 'SELECT * FROM car_apk'), [], 'and no APK date appeared');
  } finally {
    await h.t.close();
  }
});

// ------------------------------------------------------------------ the hint, more edges

test('the hint names the person at the wheel, never the person whose kilometres they were (a drive for somebody else, or for the pool)', async () => {
  const hospital = (h: Household, id: number, owner: Client): void => void run(h.t.db, "UPDATE usage SET km_for = 'person', km_user_id = ?, note = 'Took them to the hospital' WHERE id = ?", owner.id, id);
  const groceries = (h: Household, id: number): void => void run(h.t.db, "UPDATE usage SET km_for = 'together', note = 'Groceries for the family' WHERE id = ?", id);

  const covering = await hintAfter((h, day) => hospital(h, done(h, h.anna, shift(day, -2 * HOUR), shift(day, HOUR)), h.ben));
  assert.deepEqual([covering.driver.name, covering.basis], ['Anna', 'drive'], "a drive covering the day: Anna drove, the kilometres are Ben's");
  const coveringTogether = await hintAfter((h, day) => groceries(h, done(h, h.anna, shift(day, -2 * HOUR), shift(day, HOUR))));
  assert.deepEqual([coveringTogether.driver.name, coveringTogether.basis], ['Anna', 'drive']);

  const lastForPerson = await hintAfter((h, day) => hospital(h, done(h, h.anna, shift(day, -5 * HOUR), shift(day, -4 * HOUR)), h.carla));
  assert.deepEqual([lastForPerson.driver.name, lastForPerson.basis], ['Anna', 'last_drive'], 'the last drive before the day: Anna, not Carla whose kilometres they were');
  const lastTogether = await hintAfter((h, day) => groceries(h, done(h, h.ben, shift(day, -5 * HOUR), shift(day, -4 * HOUR))));
  assert.deepEqual([lastTogether.driver.name, lastTogether.basis], ['Ben', 'last_drive'], 'a drive for the pool still has a driver');
});

test('the hint, last drive: drives that ended at the same moment give the one entered last, and a legacy drive with no readings counts like any other', async () => {
  const tie = await hintAfter((h, day) => {
    done(h, h.anna, shift(day, -4 * HOUR), shift(day, -HOUR));
    done(h, h.ben, shift(day, -3 * HOUR), shift(day, -HOUR));
  });
  assert.deepEqual([tie.driver.name, tie.basis], ['Ben', 'last_drive'], 'the same end instant: the newest entry, every time');
  const legacy = await hintAfter((h, day) => void insertUsage(h.t, { userId: h.ben.id, start: shift(day, -5 * HOUR), end: shift(day, -4 * HOUR) }));
  assert.deepEqual([legacy.driver.name, legacy.basis], ['Ben', 'last_drive'], 'a drive from before odometer readings were asked for');
  const legacyCovering = await hintAfter((h, day) => void insertUsage(h.t, { userId: h.anna.id, start: shift(day, -HOUR), end: shift(day, HOUR) }));
  assert.deepEqual([legacyCovering.driver.name, legacyCovering.basis], ['Anna', 'drive']);
});
