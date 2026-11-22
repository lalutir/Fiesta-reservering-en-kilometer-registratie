// Request-body validation: the Fields collector on its own, then what a client sees when
// it sends the wrong types. The rule is always the same: a 4xx with a code per field,
// never a 500 and never a half-written row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/http.ts';
import {
  FUTURE_SLACK_MS,
  Fields,
  ValidationError,
  assertPastInsideWindow,
  failIfAny,
  isFutureDate,
  queryUserId,
  windowBounds,
  windowStartDate,
} from '../src/validate.ts';
import { countRows } from '../src/db.ts';
import { createHousehold, at } from './helpers.ts';

/** Run a collector over `input` and return its errors. */
function errorsOf(input: Record<string, unknown>, use: (f: Fields) => void): Record<string, string> {
  const f = new Fields(input);
  use(f);
  return f.errors;
}

test('strings: required, trimmed, length-checked, and only strings are accepted', () => {
  const f = new Fields({ ok: '  hello  ', raw: '  keep  ', blank: '   ', long: 'x'.repeat(501), edge: 'x'.repeat(500), short: 'ab' });
  assert.equal(f.string('ok', { min: 1, max: 500 }), 'hello', 'surrounding spaces are trimmed');
  assert.equal(f.string('raw', { trim: false }), '  keep  ');
  assert.equal(f.string('blank', { min: 1 }), undefined);
  assert.equal(f.string('long', { max: 500 }), undefined);
  assert.equal(f.string('edge', { max: 500 })?.length, 500, 'exactly the maximum is fine');
  assert.equal(f.string('short', { min: 3 }), undefined);
  assert.equal(f.string('missing'), undefined);
  assert.equal(f.string('absent-but-optional', { optional: true }), undefined);
  assert.deepEqual(f.errors, { blank: 'required', long: 'too_long', short: 'too_short', missing: 'required' });

  for (const wrong of [123, true, null, {}, [], ['a']]) {
    assert.deepEqual(errorsOf({ note: wrong }, (g) => g.string('note', { optional: true })), { note: 'must_be_string' }, JSON.stringify(wrong));
  }
});

test('integers: whole numbers only, with inclusive bounds', () => {
  const f = new Fields({ a: 5, lo: 1, hi: 10, below: 0, above: 11, frac: 1.5, text: '5', nothing: null, big: 1e300 });
  assert.equal(f.int('a'), 5);
  assert.equal(f.int('lo', { min: 1, max: 10 }), 1);
  assert.equal(f.int('hi', { min: 1, max: 10 }), 10);
  f.int('below', { min: 1 });
  f.int('above', { max: 10 });
  f.int('frac');
  f.int('text');
  f.int('nothing');
  f.int('big');
  f.int('missing');
  assert.deepEqual(f.errors, {
    below: 'too_small',
    above: 'too_large',
    frac: 'must_be_integer',
    text: 'must_be_integer',
    nothing: 'must_be_integer',
    big: 'too_large', // a whole number, but beyond what a double (and so SQLite via JSON) holds exactly
    missing: 'required',
  });
  assert.equal(new Fields({}).int('x', { optional: true }), undefined);
});

test('nullableInt distinguishes "not sent" from "clear it"', () => {
  assert.equal(new Fields({ x: null }).nullableInt('x'), null);
  assert.equal(new Fields({}).nullableInt('x'), undefined);
  assert.equal(new Fields({ x: 7 }).nullableInt('x', { min: 1 }), 7);
  assert.deepEqual(errorsOf({ x: 0 }, (f) => f.nullableInt('x', { min: 1 })), { x: 'too_small' });
  assert.deepEqual(errorsOf({ x: '7' }, (f) => f.nullableInt('x')), { x: 'must_be_integer' });
});

test('instants are normalised to UTC; anything else is invalid_datetime', () => {
  const f = new Fields({ a: '2026-06-15T12:00:00+02:00', b: '2026-06-15 12:00', c: 1781000000000, d: '2026-02-30T10:00:00Z' });
  assert.equal(f.instant('a'), '2026-06-15T10:00:00.000Z');
  f.instant('b');
  f.instant('c');
  f.instant('d');
  f.instant('missing');
  assert.equal(f.instant('absent', { optional: true }), undefined);
  assert.deepEqual(f.errors, { b: 'invalid_datetime', c: 'invalid_datetime', d: 'invalid_datetime', missing: 'required' });
});

test('booleans and choices accept exactly their own type and values', () => {
  const f = new Fields({ yes: true, no: false, str: 'true', num: 1, role: 'admin', badRole: 'root', roleNum: 1 });
  assert.equal(f.bool('yes'), true);
  assert.equal(f.bool('no'), false, 'false is a value, not "missing"');
  f.bool('str');
  f.bool('num');
  assert.equal(f.oneOf('role', ['admin', 'member'] as const), 'admin');
  f.oneOf('badRole', ['admin', 'member'] as const);
  f.oneOf('roleNum', ['admin', 'member'] as const);
  assert.deepEqual(f.errors, { str: 'must_be_boolean', num: 'must_be_boolean', badRole: 'invalid_value', roleNum: 'invalid_value' });
});

test('the first error per field wins, and done() throws one 422 listing every bad field', () => {
  const f = new Fields({ a: 'x'.repeat(20), b: 3 });
  f.string('a', { min: 25, max: 10 });
  f.fail('a', 'something_else');
  f.string('b');
  assert.equal(f.errors['a'], 'too_short', 'a later failure does not overwrite the first');
  assert.throws(
    () => f.done(),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError && err instanceof HttpError);
      assert.deepEqual([err.status, err.code, err.message], [422, 'validation_failed', 'Validation failed']);
      assert.deepEqual(err.fields, { a: 'too_short', b: 'must_be_string' });
      return true;
    },
  );
  assert.doesNotThrow(() => new Fields({ ok: 1 }).done());
  assert.doesNotThrow(() => failIfAny({}));
  assert.throws(() => failIfAny({ end: 'outside_window' }, 'outside_window'), (err: unknown) => err instanceof ValidationError && err.code === 'outside_window');
});

test('assertPastInsideWindow: five minutes of clock slack into the future, both window ends inclusive, and the two failures are told apart', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');
  const tz = 'Europe/Amsterdam';
  const { from, to } = windowBounds(now, tz, 6);
  const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
  const check = (value: string): void => assertPastInsideWindow(value, now, tz, 6);
  const failure = (value: string): ValidationError => {
    try {
      check(value);
    } catch (err) {
      assert.ok(err instanceof ValidationError, 'a ValidationError, nothing else');
      return err;
    }
    assert.fail(`${value} was accepted`);
  };

  assert.equal(FUTURE_SLACK_MS, 5 * 60_000);
  check(now.toISOString());
  check(plus(now.toISOString(), FUTURE_SLACK_MS)); // exactly five minutes ahead is still "now"
  const late = failure(plus(now.toISOString(), FUTURE_SLACK_MS + 1));
  assert.deepEqual(late.fields, { at: 'in_future' });
  assert.equal(late.code, 'validation_failed', 'in_future keeps the ordinary validation code');
  assert.equal(late.status, 422);

  check(from); // the past edge itself is inside
  const early = failure(plus(from, -1));
  assert.deepEqual(early.fields, { at: 'outside_window' });
  assert.equal(early.code, 'outside_window', 'outside_window is also the top-level code');
  // The future edge of the window lies far beyond the slack, so the slack rule answers first there.
  assert.ok(to > plus(now.toISOString(), FUTURE_SLACK_MS));
  assert.deepEqual(failure(to).fields, { at: 'in_future' });
});

test('the userId query filter is a positive integer or absent', () => {
  assert.equal(queryUserId(new URLSearchParams('')), undefined);
  assert.equal(queryUserId(new URLSearchParams('userId=')), undefined);
  assert.equal(queryUserId(new URLSearchParams('userId=7')), 7);
  assert.equal(queryUserId(new URLSearchParams('userId=2147483647')), 2147483647);
  for (const bad of ['0', '-1', '1.5', 'abc', '007', '12345678901', '1e3', ' 1']) {
    assert.throws(() => queryUserId(new URLSearchParams({ userId: bad })), (err: unknown) => err instanceof ValidationError && err.fields?.['userId'] === 'must_be_integer', `userId=${bad}`);
  }
});

// -------------------------------------------------------- what a client sees

test('wrong types in a reservation or usage body give a 422 with field codes and write nothing', async () => {
  const { t, anna } = await createHousehold();
  try {
    const rows = (): number => countRows(t.db, 'reservations') + countRows(t.db, 'usage');

    const bad = await anna.post('/api/reservations', { start: 12345, end: null, note: 5, userId: '2' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.error.fields, { userId: 'must_be_integer', start: 'invalid_datetime', end: 'invalid_datetime', note: 'must_be_string' });

    const empty = await anna.post('/api/reservations', {});
    assert.equal(empty.status, 422);
    assert.deepEqual(empty.body.error.fields, { start: 'required', end: 'required' });

    const drive = await anna.post('/api/usage', { start: at(t.clock, -3), end: at(t.clock, -2), odometerStart: '120', odometerEnd: 12.5, reservationId: 'abc', note: [] });
    assert.equal(drive.status, 422);
    assert.deepEqual(drive.body.error.fields, { odometerStart: 'must_be_integer', odometerEnd: 'must_be_integer', reservationId: 'must_be_integer', note: 'must_be_string' });

    // Valid JSON that is not an object is a client error too, on every create route.
    for (const body of [[], 'text', 42, null, [{ start: 'x' }]]) {
      for (const route of ['/api/reservations', '/api/usage']) {
        const res = await anna.post(route, body);
        assert.ok(res.status >= 400 && res.status < 500, `${route} with ${JSON.stringify(body)} gave ${res.status}`);
        assert.ok(res.body?.error?.code, 'the error has a code');
      }
    }
    assert.equal(rows(), 0, 'nothing was stored by the rejected requests');
  } finally {
    await t.close();
  }
});

test('login treats non-string or oversized credentials as an ordinary failed login', async () => {
  const { t } = await createHousehold();
  try {
    const c = t.client();
    for (const body of [{ username: 123, password: { a: 1 } }, { username: ['anna'], password: ['x'] }, { username: 'anna' }, {}]) {
      const res = await c.post('/api/auth/login', body);
      assert.equal(res.status, 401, JSON.stringify(body));
      assert.equal(res.body.error.code, 'invalid_credentials');
      assert.equal(res.headers['set-cookie'], undefined, 'no session is started');
    }
    // Oversized input is an ordinary failed login: same status and code, no hint why, no crash.
    // (The length cap itself only saves hashing time, which an API-level test cannot observe.)
    const huge = await c.post('/api/auth/login', { username: 'anna', password: 'a'.repeat(5000) });
    assert.equal(huge.status, 401);
    assert.equal(huge.body.error.code, 'invalid_credentials');
    const longName = await c.post('/api/auth/login', { username: 'a'.repeat(5000), password: 'whatever-password' });
    assert.equal(longName.status, 401);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------- calendar dates

test('Fields.date: a real day in strict YYYY-MM-DD, in the years 2000 to 2100', () => {
  const f = new Fields({ ok: '2026-03-28', leap: '2028-02-29', first: '2000-01-01', last: '2100-12-31' });
  assert.equal(f.date('ok'), '2026-03-28');
  assert.equal(f.date('leap'), '2028-02-29');
  assert.equal(f.date('first'), '2000-01-01');
  assert.equal(f.date('last'), '2100-12-31');
  assert.deepEqual(f.errors, {});

  const bad = [
    ['feb30', '2026-02-30'],
    ['notLeap', '2027-02-29'],
    ['month13', '2026-13-01'],
    ['short', '2026-1-5'],
    ['datetime', '2026-03-28T10:00:00.000Z'],
    ['newline', '2026-03-28\n'],
    ['padded', ' 2026-03-28'],
    ['before2000', '1999-12-31'],
    ['after2100', '2101-01-01'],
    ['empty', ''],
    ['number', 20260328],
    ['nul', null],
    ['list', ['2026-03-28']],
  ] as const;
  const g = new Fields(Object.fromEntries(bad));
  for (const [key] of bad) assert.equal(g.date(key), undefined, key);
  assert.deepEqual(g.errors, Object.fromEntries(bad.map(([key]) => [key, 'invalid_date'])));
});

test('Fields.date: absent is required unless optional, and it is reported with the other field errors', () => {
  const f = new Fields({ other: 'x'.repeat(600) });
  assert.equal(f.date('missing'), undefined);
  assert.equal(f.date('absentButOptional', { optional: true }), undefined);
  f.string('other', { max: 500 });
  assert.deepEqual(f.errors, { missing: 'required', other: 'too_long' });
});

test('windowStartDate is the local calendar day of the window start, not the UTC day', () => {
  // 2026-06-15T10:00Z is 12:00 in Amsterdam: six months back is 2025-12-15 12:00 local.
  assert.equal(windowStartDate(new Date('2026-06-15T10:00:00.000Z'), 'Europe/Amsterdam', 6), '2025-12-15');
  // At 23:30 UTC on 2026-06-14 it is already 15 June in Amsterdam: the start moves with the local day.
  assert.equal(windowStartDate(new Date('2026-06-14T23:30:00.000Z'), 'Europe/Amsterdam', 6), '2025-12-15');
  assert.equal(windowStartDate(new Date('2026-06-14T23:30:00.000Z'), 'UTC', 6), '2025-12-14');
  // 31 August minus six months is 28 February (the day is clamped, like the window itself).
  assert.equal(windowStartDate(new Date('2026-08-31T10:00:00.000Z'), 'Europe/Amsterdam', 6), '2026-02-28');
  // A window that starts shortly after midnight local time on a day that is still the previous day in UTC.
  const now = new Date('2026-06-15T10:00:00.000Z');
  assert.equal(windowStartDate(now, 'Europe/Amsterdam', 6), windowBounds(now, 'Europe/Amsterdam', 6).from.slice(0, 10), 'same day here');
  const lateNow = new Date('2026-03-27T23:30:00.000Z'); // 28 March in Amsterdam, 00:30
  assert.equal(windowBounds(lateNow, 'Europe/Amsterdam', 6).from, '2025-09-27T22:30:00.000Z', 'the window start is 28 September 00:30 local');
  assert.equal(windowStartDate(lateNow, 'Europe/Amsterdam', 6), '2025-09-28', 'so its calendar day is the 28th although the UTC date is the 27th');
});

test('isFutureDate follows the household zone, with no slack', () => {
  const tz = 'Europe/Amsterdam';
  const now = new Date('2026-03-27T23:30:00.000Z'); // already 28 March in Amsterdam
  assert.equal(isFutureDate('2026-03-28', now, tz), false, 'today in Amsterdam');
  assert.equal(isFutureDate('2026-03-29', now, tz), true, 'tomorrow in Amsterdam');
  assert.equal(isFutureDate('2026-03-27', now, tz), false);
  assert.equal(isFutureDate('2026-03-28', now, 'America/Los_Angeles'), true, 'in Los Angeles it is still 27 March');
  assert.equal(isFutureDate('2026-03-27', now, 'America/Los_Angeles'), false);
});
