import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertInsideWindow, clampRange, parseInstant, windowBounds } from '../src/validate.ts';
import { addCalendarMonths } from '../shared/time.js';
import { createHousehold, insertReservation, insertUsage } from './helpers.ts';

const TZ = 'Europe/Amsterdam';
const NOW = '2026-06-15T10:00:00.000Z';
// 12:00 CEST on 15 Jun  ->  12:00 CET on 15 Dec, both months back and forward.
const FROM = '2025-12-15T11:00:00.000Z';
const TO = '2026-12-15T11:00:00.000Z';

const shift = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const HOUR = 3_600_000;

test('windowBounds is six calendar months either side in the household zone', () => {
  assert.deepEqual(windowBounds(new Date(NOW), TZ, 6), { from: FROM, to: TO });
  assert.equal(windowBounds(new Date('2026-08-31T10:00:00.000Z'), TZ, 6).from, '2026-02-28T11:00:00.000Z');
});

test('assertInsideWindow: boundaries are inclusive, one millisecond further is outside', () => {
  const now = new Date(NOW);
  assert.doesNotThrow(() => assertInsideWindow(TO, shift(TO, HOUR), now, TZ, 6));
  assert.doesNotThrow(() => assertInsideWindow(shift(FROM, -HOUR), FROM, now, TZ, 6));
  assert.throws(() => assertInsideWindow(shift(TO, 1), shift(TO, HOUR), now, TZ, 6), (e: { code: string; fields: Record<string, string> }) => {
    assert.equal(e.code, 'outside_window');
    assert.deepEqual(e.fields, { start: 'outside_window' });
    return true;
  });
  assert.throws(() => assertInsideWindow(shift(FROM, -HOUR), shift(FROM, -1), now, TZ, 6), (e: { fields: Record<string, string> }) => {
    assert.deepEqual(e.fields, { end: 'outside_window' });
    return true;
  });
});

test('clampRange narrows to the window, never widens it, and rejects junk', () => {
  const b = { from: FROM, to: TO };
  assert.deepEqual(clampRange(null, null, b), b);
  assert.deepEqual(clampRange('2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', b), b);
  assert.deepEqual(clampRange('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', b), {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-02-01T00:00:00.000Z',
  });
  assert.throws(() => clampRange('junk', null, b));
});

test('parseInstant normalises valid instants and rejects everything else', () => {
  assert.equal(parseInstant('2026-06-15T12:00:00+02:00'), '2026-06-15T10:00:00.000Z');
  assert.equal(parseInstant('2026-06-15T10:00Z'), '2026-06-15T10:00:00.000Z');
  assert.equal(parseInstant('2026-06-15T10:00:00.12Z'), '2026-06-15T10:00:00.120Z');
  for (const bad of ['2026-06-15', '2026-06-15 10:00:00Z', '2026-06-15T10:00:00', '2026-13-01T00:00:00Z', '2026-04-31T00:00:00Z', '1999-01-01T00:00:00Z', '2026-06-15T10:00:60Z', 5, undefined]) {
    assert.equal(parseInstant(bad), undefined, String(bad));
  }
});

test('creating a reservation more than six months ahead is rejected, exactly six is accepted', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    const ok = await anna.post('/api/reservations', { start: TO, end: shift(TO, HOUR) });
    assert.equal(ok.status, 201);
    const tooFar = await anna.post('/api/reservations', { start: shift(TO, 1), end: shift(TO, 2 * HOUR) });
    assert.equal(tooFar.status, 422);
    assert.equal(tooFar.body.error.code, 'outside_window');
    assert.equal(tooFar.body.error.fields.start, 'outside_window');
    // Same rule for suggestions.
    const suggestion = await anna.post('/api/reservations', { userId: ben.id, start: shift(TO, 1), end: shift(TO, 2 * HOUR) });
    assert.equal(suggestion.status, 422);
    assert.equal((await anna.post('/api/reservations', { userId: ben.id, start: shift(TO, 2 * HOUR), end: shift(TO, 3 * HOUR) })).status, 422);
  } finally {
    await t.close();
  }
});

test('a reservation that ended more than six months ago is rejected, ending exactly at the edge is accepted', async () => {
  const { t, anna } = await createHousehold();
  try {
    const edge = await anna.post('/api/reservations', { start: shift(FROM, -2 * HOUR), end: FROM });
    assert.equal(edge.status, 201);
    const tooOld = await anna.post('/api/reservations', { start: shift(FROM, -3 * HOUR), end: shift(FROM, -1) });
    assert.equal(tooOld.status, 422);
    assert.equal(tooOld.body.error.code, 'outside_window');
    assert.equal(tooOld.body.error.fields.end, 'outside_window');
  } finally {
    await t.close();
  }
});

test('only the end matters for the past edge: starting long ago but ending inside the window is accepted', async () => {
  const { t, anna } = await createHousehold();
  try {
    const res = await anna.post('/api/reservations', { start: '2025-01-01T00:00:00Z', end: shift(FROM, HOUR) });
    assert.equal(res.status, 201);
  } finally {
    await t.close();
  }
});

test('editing a reservation cannot move it outside the window', async () => {
  const { t, anna } = await createHousehold();
  try {
    const r = await anna.post('/api/reservations', { start: shift(NOW, 24 * HOUR), end: shift(NOW, 26 * HOUR) });
    const id = r.body.reservation.id;
    const res = await anna.patch(`/api/reservations/${id}`, { start: shift(TO, 1), end: shift(TO, HOUR) });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'outside_window');
  } finally {
    await t.close();
  }
});

test('lists only return items inside the window, whatever range is asked for', async () => {
  const { t, anna, ben } = await createHousehold();
  try {
    // Fixtures written directly: the API would refuse the out-of-window ones.
    const inside = insertReservation(t, { userId: anna.id, start: shift(NOW, HOUR), end: shift(NOW, 2 * HOUR) });
    const edgePast = insertReservation(t, { userId: anna.id, start: shift(FROM, -HOUR), end: FROM });
    const edgeFuture = insertReservation(t, { userId: anna.id, start: TO, end: shift(TO, HOUR) });
    insertReservation(t, { userId: anna.id, start: shift(FROM, -3 * HOUR), end: shift(FROM, -1) });
    insertReservation(t, { userId: anna.id, start: shift(TO, 1), end: shift(TO, 3 * HOUR) });
    insertReservation(t, { userId: ben.id, start: '2025-01-01T08:00:00.000Z', end: '2025-01-01T10:00:00.000Z', status: 'pending', createdBy: anna.id });
    const u1 = insertUsage(t, { userId: anna.id, start: shift(NOW, -3 * HOUR), end: shift(NOW, -2 * HOUR) });
    insertUsage(t, { userId: anna.id, start: '2025-02-01T08:00:00.000Z', end: '2025-02-01T10:00:00.000Z' });
    const uEdge = insertUsage(t, { userId: anna.id, start: shift(FROM, -HOUR), end: FROM });

    const res = await ben.get('/api/reservations?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z');
    assert.deepEqual(res.body.items.map((i: { id: number }) => i.id), [edgePast, inside, edgeFuture]);
    assert.deepEqual(res.body.window, { from: FROM, to: TO });
    assert.deepEqual((await ben.get('/api/reservations')).body.items.map((i: { id: number }) => i.id), [edgePast, inside, edgeFuture]);
    assert.deepEqual((await ben.get('/api/usage?from=2000-01-01T00:00:00Z')).body.items.map((i: { id: number }) => i.id), [u1, uEdge]);
    assert.deepEqual((await ben.get('/api/history?from=2000-01-01T00:00:00Z')).body.usage.map((i: { id: number }) => i.id), [u1, uEdge]);
    const inbox = (await ben.get('/api/inbox')).body;
    assert.deepEqual(inbox.incoming, [], 'old and lapsed suggestions are not offered');
  } finally {
    await t.close();
  }
});

test('the window moves with the clock', async () => {
  const { t, anna } = await createHousehold();
  try {
    const old = { start: shift(FROM, -3 * HOUR), end: shift(FROM, -HOUR) };
    insertReservation(t, { userId: anna.id, ...old });
    assert.equal((await anna.get('/api/reservations')).body.items.length, 0);
    t.clock.set('2026-05-15T10:00:00.000Z'); // a month earlier: the window now reaches back far enough
    assert.equal((await anna.get('/api/reservations')).body.items.length, 1);
    assert.equal((await anna.get('/api/reservations')).body.window.from, addCalendarMonths('2026-05-15T10:00:00.000Z', -6, TZ));
  } finally {
    await t.close();
  }
});

test('window edges follow the local wall clock across a DST change', async () => {
  const { t, anna } = await createHousehold({ now: '2026-10-25T12:00:00.000Z' });
  try {
    // 25 Oct 13:00 CET -> 25 Apr 13:00 CEST = 11:00Z
    const from = '2026-04-25T11:00:00.000Z';
    assert.equal((await anna.post('/api/reservations', { start: shift(from, -HOUR), end: from })).status, 201);
    const res = await anna.post('/api/reservations', { start: shift(from, -2 * HOUR), end: shift(from, -1) });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'outside_window');
  } finally {
    await t.close();
  }
});
