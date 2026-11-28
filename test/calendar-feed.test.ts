// The private calendar feed (src/calendar.ts): the person's own link, what the feed lists, the exact instants it
// writes, its HTTP behaviour (ETag, 304, HEAD), the way misses and floods are answered, and that the secret in its
// address never reaches a log line, an answer or a header.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { FEED_PREFIX, etagOf, ifNoneMatches } from '../src/calendar.ts';
import { many, run } from '../src/db.ts';
import { windowBounds } from '../src/validate.ts';
import { localInputToUtc } from '../shared/time.js';
import { createHousehold, insertReservation, type Client, type Household } from './helpers.ts';
import { parseIcs, valueOf, type IcsProps } from './ics-strict.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Europe/Amsterdam';
const iso = (h: Household, offsetMs: number): string => new Date(h.t.clock.now().getTime() + offsetMs).toISOString();
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function withHousehold(opts: Parameters<typeof createHousehold>[0], fn: (h: Household) => Promise<void>): Promise<void> {
  const h = await createHousehold(opts);
  try {
    await fn(h);
  } finally {
    await h.t.close();
  }
}

/** Make (or fetch) the person's feed; returns its path and its secret. */
async function feedOf(client: Client): Promise<{ path: string; secret: string }> {
  const r = await client.post('/api/calendar-feed', {});
  assert.ok(r.status === 200 || r.status === 201, r.text);
  const path = r.body.feed.path as string;
  assert.match(path, /^\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
  return { path, secret: path.slice(FEED_PREFIX.length, -4) };
}

// ------------------------------------------------------------------- the person's own link

test('a person makes a link, gets the same one again, replaces it (the old one dies at once) and turns it off', async () => {
  await withHousehold({}, async (h) => {
    assert.deepEqual((await h.anna.get('/api/calendar-feed')).body, { feed: null }, 'no link yet is an answer, not an error');
    const first = await h.anna.post('/api/calendar-feed', {});
    assert.equal(first.status, 201);
    assert.deepEqual(Object.keys(first.body.feed).sort(), ['createdAt', 'path']);
    assert.equal(first.body.feed.createdAt, h.t.clock.now().toISOString());
    const path = first.body.feed.path as string;
    assert.match(path, /^\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/, '43 base64url characters: 256 bits');
    assert.equal(Buffer.from(path.slice(FEED_PREFIX.length, -4), 'base64url').length, 32);

    const again = await h.anna.post('/api/calendar-feed', {});
    assert.equal(again.status, 200, 'a second tap does not replace the link that was just copied');
    assert.equal(again.body.feed.path, path);
    assert.equal((await h.anna.get('/api/calendar-feed')).body.feed.path, path);
    assert.equal((await h.ben.get('/api/calendar-feed')).body.feed, null, 'everybody has their own');

    const anon = h.t.client();
    assert.equal((await anon.get(path)).status, 200);

    h.t.clock.advance(HOUR);
    const renewed = await h.anna.post('/api/calendar-feed/new-link', {});
    assert.equal(renewed.status, 201);
    assert.notEqual(renewed.body.feed.path, path);
    assert.equal(renewed.body.feed.createdAt, h.t.clock.now().toISOString());
    assert.equal((await anon.get(path)).status, 404, 'the old address is dead at once');
    assert.equal((await anon.get(renewed.body.feed.path)).status, 200);
    assert.equal(many(h.t.db, 'SELECT user_id FROM calendar_feeds').length, 1, 'replaced, not added');

    assert.equal((await h.anna.del('/api/calendar-feed')).status, 204);
    assert.equal((await anon.get(renewed.body.feed.path)).status, 404);
    assert.deepEqual((await h.anna.get('/api/calendar-feed')).body, { feed: null });
    assert.equal((await h.anna.del('/api/calendar-feed')).status, 204, 'turning off twice is fine');
    // New-link without a link makes one (it is "make a new one").
    assert.equal((await h.anna.post('/api/calendar-feed/new-link', {})).status, 201);
  });
});

test('the link routes are for a signed-in person only, and a token cannot reach them', async () => {
  await withHousehold({}, async (h) => {
    const anon = h.t.client();
    for (const [method, target] of [['GET', '/api/calendar-feed'], ['POST', '/api/calendar-feed'], ['POST', '/api/calendar-feed/new-link'], ['DELETE', '/api/calendar-feed']] as const) {
      assert.equal((await anon.request(method, target, method === 'POST' ? {} : undefined)).status, 401, `${method} ${target}`);
    }
    const token = (await h.anna.post('/api/tokens', { name: 'x' })).body.token as string;
    assert.equal((await anon.get('/api/calendar-feed', bearer(token))).status, 401);
    assert.equal((await anon.post('/api/calendar-feed', {}, bearer(token))).status, 401);
  });
});

test('deactivating a person deletes their link, and reactivating does not bring it back', async () => {
  await withHousehold({}, async (h) => {
    const { path } = await feedOf(h.ben);
    const anon = h.t.client();
    assert.equal((await anon.get(path)).status, 200);
    assert.equal((await h.admin.patch(`/api/admin/users/${h.ben.id}`, { active: false })).status, 200);
    assert.equal((await anon.get(path)).status, 404);
    assert.deepEqual(many(h.t.db, 'SELECT user_id FROM calendar_feeds WHERE user_id = ?', h.ben.id), [], 'the row is gone');
    assert.equal((await h.admin.patch(`/api/admin/users/${h.ben.id}`, { active: true })).status, 200);
    assert.equal((await anon.get(path)).status, 404, 'and stays gone');
    // A row that somehow survives (a restore of an old backup) is still not served for an inactive person.
    run(h.t.db, 'UPDATE users SET active = 0 WHERE id = ?', h.carla.id);
    const { path: carlaPath } = await feedOf(h.anna);
    run(h.t.db, 'UPDATE calendar_feeds SET user_id = ? WHERE user_id = ?', h.carla.id, h.anna.id);
    assert.equal((await anon.get(carlaPath)).status, 404, 'the join on active people');
  });
});

// -------------------------------------------------------------------------- what it lists

test('the feed lists every confirmed reservation in the window and the person\'s own waiting suggestions, and nothing else', async () => {
  await withHousehold({}, async (h) => {
    const note = 'MIJN-GEHEIME-NOTITIE';
    const confirmedBen = insertReservation(h.t, { userId: h.ben.id, start: iso(h, 2 * HOUR), end: iso(h, 4 * HOUR), note });
    const confirmedAnna = insertReservation(h.t, { userId: h.anna.id, start: iso(h, DAY), end: iso(h, DAY + HOUR), note });
    // Waiting suggestions: Ben suggests a slot to Anna; Carla suggests one to Ben; Anna suggests one to Carla.
    const toAnna = insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'pending', start: iso(h, 2 * DAY), end: iso(h, 2 * DAY + HOUR), note });
    const toBen = insertReservation(h.t, { userId: h.ben.id, createdBy: h.carla.id, status: 'pending', start: iso(h, 3 * DAY), end: iso(h, 3 * DAY + HOUR), note });
    const byAnna = insertReservation(h.t, { userId: h.carla.id, createdBy: h.anna.id, status: 'pending', start: iso(h, 4 * DAY), end: iso(h, 4 * DAY + HOUR), note });
    // Never in a feed: declined, a suggestion that has lapsed (started already), one outside the window, a deleted one.
    insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'declined', start: iso(h, 5 * DAY), end: iso(h, 5 * DAY + HOUR) });
    insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'pending', start: iso(h, -2 * HOUR), end: iso(h, HOUR) });
    insertReservation(h.t, { userId: h.ben.id, start: iso(h, 300 * DAY), end: iso(h, 300 * DAY + HOUR) });
    const gone = insertReservation(h.t, { userId: h.ben.id, start: iso(h, 6 * DAY), end: iso(h, 6 * DAY + HOUR) });
    assert.equal((await h.ben.del(`/api/reservations/${gone}`)).status, 204);

    const anna = await feedOf(h.anna);
    const carla = await feedOf(h.carla);
    const anon = h.t.client();
    const events = async (path: string): Promise<Array<{ uid: string; status: string; summary: string }>> =>
      parseIcs((await anon.get(path)).text).events.map((e) => ({ uid: valueOf(e, 'UID'), status: valueOf(e, 'STATUS'), summary: valueOf(e, 'SUMMARY') }));

    assert.deepEqual(await events(anna.path), [
      { uid: `reservation-${confirmedBen}@gedeelde-auto`, status: 'CONFIRMED', summary: 'Auto: Ben' },
      { uid: `reservation-${confirmedAnna}@gedeelde-auto`, status: 'CONFIRMED', summary: 'Auto: Anna' },
      { uid: `reservation-${toAnna}@gedeelde-auto`, status: 'TENTATIVE', summary: 'Voorstel: Anna' },
      { uid: `reservation-${byAnna}@gedeelde-auto`, status: 'TENTATIVE', summary: 'Voorstel: Carla' },
    ], 'Anna: everybody\'s confirmed ones, and the suggestions she made and received (not the one between Carla and Ben)');
    assert.deepEqual(
      (await events(carla.path)).map((e) => e.uid),
      [confirmedBen, confirmedAnna, toBen, byAnna].map((id) => `reservation-${id}@gedeelde-auto`),
      'Carla: the suggestion she made to Ben and the one made to her, not the one between Ben and Anna',
    );
    assert.ok(!(await events(carla.path)).some((e) => e.uid === `reservation-${toAnna}@gedeelde-auto`));

    const text = (await anon.get(anna.path)).text;
    assert.ok(!text.includes(note), 'a note never appears');
    assert.doesNotMatch(text, /DESCRIPTION|LOCATION|ATTENDEE|[0-9]{4,} km|odometer/i);
    assert.equal(parseIcs(text).events.length, 4);
  });
});

test('approving, declining and cancelling change the feed as they should, and LAST-MODIFIED follows the record', async () => {
  await withHousehold({}, async (h) => {
    const suggestion = (await h.ben.post('/api/reservations', { userId: h.anna.id, start: iso(h, DAY), end: iso(h, DAY + 2 * HOUR) })).body.reservation.id as number;
    const { path } = await feedOf(h.anna);
    const anon = h.t.client();
    const eventOf = async (): Promise<ReturnType<typeof parseIcs>['events'][number] | undefined> => parseIcs((await anon.get(path)).text).events.find((e) => valueOf(e, 'UID') === `reservation-${suggestion}@gedeelde-auto`);

    let e = await eventOf();
    assert.equal(valueOf(e!, 'STATUS'), 'TENTATIVE');
    assert.equal(valueOf(e!, 'LAST-MODIFIED'), '20260615T100000Z');
    h.t.clock.advance(HOUR);
    assert.equal((await h.anna.post(`/api/reservations/${suggestion}/approve`, {})).status, 200);
    e = await eventOf();
    assert.equal(valueOf(e!, 'STATUS'), 'CONFIRMED', 'the same event, now confirmed');
    assert.equal(valueOf(e!, 'LAST-MODIFIED'), '20260615T110000Z', 'the approval is the modification');
    assert.equal(valueOf(e!, 'DTSTAMP'), valueOf(e!, 'LAST-MODIFIED'));
    h.t.clock.advance(HOUR);
    assert.equal((await h.anna.patch(`/api/reservations/${suggestion}`, { end: iso(h, DAY + 3 * HOUR - 2 * HOUR) })).status, 200);
    e = await eventOf();
    assert.equal(valueOf(e!, 'LAST-MODIFIED'), '20260615T120000Z');
    assert.equal((await h.anna.del(`/api/reservations/${suggestion}`)).status, 204);
    assert.equal(await eventOf(), undefined, 'a cancelled reservation is gone from the feed');

    // A declined suggestion disappears too.
    const second = (await h.ben.post('/api/reservations', { userId: h.anna.id, start: iso(h, 2 * DAY), end: iso(h, 2 * DAY + HOUR) })).body.reservation.id as number;
    assert.ok(parseIcs((await anon.get(path)).text).events.some((x) => valueOf(x, 'UID') === `reservation-${second}@gedeelde-auto`));
    await h.anna.post(`/api/reservations/${second}/decline`, {});
    assert.ok(!parseIcs((await anon.get(path)).text).events.some((x) => valueOf(x, 'UID') === `reservation-${second}@gedeelde-auto`));
  });
});

test('a suggestion that lapses (its start passes) leaves the feed', async () => {
  await withHousehold({}, async (h) => {
    insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'pending', start: iso(h, HOUR), end: iso(h, 2 * HOUR) });
    const { path } = await feedOf(h.anna);
    const anon = h.t.client();
    assert.equal(parseIcs((await anon.get(path)).text).events.length, 1);
    h.t.clock.advance(HOUR); // the start is now
    assert.equal(parseIcs((await anon.get(path)).text).events.length, 0);
  });
});

// ------------------------------------------------------- exact instants: DST, midnight, the window edges

test('Europe/Amsterdam daylight saving and local midnight give exact UTC instants, with no time zone in the feed', async () => {
  await withHousehold({}, async (h) => {
    const at = (date: string, time: string): string => localInputToUtc(date, time, TZ) as string;
    // 2026-03-29: the clocks go from 02:00 to 03:00. 01:30 is CET (UTC+1) and 03:30 is CEST (UTC+2): one real hour.
    insertReservation(h.t, { userId: h.ben.id, start: at('2026-03-29', '01:30'), end: at('2026-03-29', '03:30') });
    // 2026-10-25: the clocks go from 03:00 back to 02:00. 01:30 is CEST (UTC+2), 04:00 is CET (UTC+1): three and a half real hours.
    insertReservation(h.t, { userId: h.ben.id, start: at('2026-10-25', '01:30'), end: at('2026-10-25', '04:00') });
    // The repeated hour: 02:30 happens twice that night; the app takes the first (CEST).
    insertReservation(h.t, { userId: h.carla.id, start: at('2026-10-25', '02:30'), end: at('2026-10-25', '02:45') });
    // Local midnight in summer (UTC+2) and in winter (UTC+1).
    insertReservation(h.t, { userId: h.anna.id, start: at('2026-06-16', '00:00'), end: at('2026-06-16', '01:00') });
    insertReservation(h.t, { userId: h.anna.id, start: at('2026-12-01', '00:00'), end: at('2026-12-02', '00:00') });
    const { path } = await feedOf(h.anna);
    const text = (await h.t.client().get(path)).text;
    const parsed = parseIcs(text);
    const times = parsed.events.map((e) => `${valueOf(e, 'DTSTART')}-${valueOf(e, 'DTEND')}`);
    assert.deepEqual(
      times,
      [
        '20260329T003000Z-20260329T013000Z', // 01:30 CET .. 03:30 CEST
        '20260615T220000Z-20260615T230000Z', // 2026-06-16 00:00 CEST is 22:00Z the day before
        '20261024T233000Z-20261025T030000Z', // 01:30 CEST .. 04:00 CET
        '20261025T003000Z-20261025T004500Z', // the first 02:30 (CEST)
        '20261130T230000Z-20261201T230000Z', // 2026-12-01 00:00 CET .. 2026-12-02 00:00 CET
      ],
      'every instant is the stored one, written as UTC',
    );
    assert.ok(!/TZID|VTIMEZONE|X-WR-TIMEZONE/.test(text));
    // The same instants through the app's own API (what a person sees converted back).
    const viaApi = (await h.anna.get('/api/reservations')).body.items as Array<{ start: string; end: string }>;
    assert.ok(viaApi.some((r) => r.start === '2026-03-29T00:30:00.000Z' && r.end === '2026-03-29T01:30:00.000Z'));
  });
});

test('the window edges are inclusive: an event ending exactly at the start of the window, or starting exactly at its end, is in', async () => {
  await withHousehold({}, async (h) => {
    const { from, to } = windowBounds(h.t.clock.now(), TZ, h.t.config.windowMonths);
    const ms = (instant: string, delta: number): string => new Date(Date.parse(instant) + delta).toISOString();
    const endsAtFrom = insertReservation(h.t, { userId: h.ben.id, start: ms(from, -HOUR), end: from });
    insertReservation(h.t, { userId: h.ben.id, start: ms(from, -2 * HOUR), end: ms(from, -1) }); // ends 1 ms too early
    const startsAtTo = insertReservation(h.t, { userId: h.carla.id, start: to, end: ms(to, HOUR) });
    insertReservation(h.t, { userId: h.carla.id, start: ms(to, 1), end: ms(to, HOUR) }); // starts 1 ms too late
    const { path } = await feedOf(h.anna);
    const uids = parseIcs((await h.t.client().get(path)).text).events.map((e) => valueOf(e, 'UID'));
    assert.deepEqual(uids, [endsAtFrom, startsAtTo].map((id) => `reservation-${id}@gedeelde-auto`));
  });
});

// ------------------------------------------------------------------------------------- HTTP

test('the feed is text/calendar with a strong ETag, no-store, no-referrer and nosniff; HEAD and the 304 say the same', async () => {
  await withHousehold({}, async (h) => {
    insertReservation(h.t, { userId: h.ben.id, start: iso(h, HOUR), end: iso(h, 2 * HOUR) });
    const { path } = await feedOf(h.anna);
    const anon = h.t.client();
    const get = await anon.get(path);
    assert.equal(get.status, 200);
    assert.equal(get.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.equal(get.headers['cache-control'], 'no-store');
    assert.equal(get.headers['referrer-policy'], 'no-referrer');
    assert.equal(get.headers['x-content-type-options'], 'nosniff');
    assert.equal(get.headers['content-length'], String(Buffer.byteLength(get.text)));
    const etag = get.headers['etag'] as string;
    assert.match(etag, /^"[0-9a-f]{32}"$/, 'a strong tag (no W/)');
    assert.equal(etag, etagOf(get.text));
    assert.equal((await anon.get(path)).headers['etag'], etag, 'the same body gives the same tag');

    const head = await anon.request('HEAD', path);
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['etag'], etag);
    assert.equal(head.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.equal(head.headers['content-length'], get.headers['content-length'], 'the length of the body a GET would send');
    assert.equal(head.headers['cache-control'], 'no-store');

    for (const header of [etag, `W/${etag}`, `"nope", ${etag}`, `${etag}, "other"`, '*', ` ${etag} `]) {
      const r = await anon.get(path, { 'If-None-Match': header });
      assert.equal(r.status, 304, `If-None-Match: ${header}`);
      assert.equal(r.text, '', 'no body');
      assert.equal(r.headers['etag'], etag);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['content-length'], undefined);
    }
    for (const header of ['"nope"', 'W/"nope"', '', 'nonsense', `${etag.slice(0, -2)}x"`]) {
      assert.equal((await anon.get(path, { 'If-None-Match': header })).status, 200, `If-None-Match: ${header}`);
    }
    assert.equal((await anon.request('HEAD', path, undefined, { 'If-None-Match': etag })).status, 304);
    // An unknown address is a 404 whatever it sends.
    assert.equal((await anon.get(`${FEED_PREFIX}${'a'.repeat(43)}.ics`, { 'If-None-Match': '*' })).status, 404);
  });
});

test('an edit changes the ETag, so a client that had the old one gets the new body', async () => {
  await withHousehold({}, async (h) => {
    const id = insertReservation(h.t, { userId: h.ben.id, start: iso(h, HOUR), end: iso(h, 2 * HOUR) });
    const { path } = await feedOf(h.anna);
    const anon = h.t.client();
    const before = await anon.get(path);
    h.t.clock.advance(60_000);
    assert.equal((await h.ben.patch(`/api/reservations/${id}`, { end: iso(h, 3 * HOUR) })).status, 200);
    const after = await anon.get(path, { 'If-None-Match': before.headers['etag'] as string });
    assert.equal(after.status, 200, 'the old tag no longer matches');
    assert.notEqual(after.headers['etag'], before.headers['etag']);
    assert.notEqual(after.text, before.text);
    assert.equal((await anon.get(path, { 'If-None-Match': after.headers['etag'] as string })).status, 304);
    // Just a note changes nothing the feed shows... but the record's updated time is part of the feed, so it does change.
  });
});

test('ifNoneMatches: a list, weak tags and * all match; garbage and a missing header do not', () => {
  const tag = '"abc"';
  assert.equal(ifNoneMatches(undefined, tag), false);
  assert.equal(ifNoneMatches('', tag), false);
  assert.equal(ifNoneMatches('*', tag), true);
  assert.equal(ifNoneMatches(' * ', tag), true);
  assert.equal(ifNoneMatches('"abc"', tag), true);
  assert.equal(ifNoneMatches('W/"abc"', tag), true);
  assert.equal(ifNoneMatches('"x", W/"abc", "y"', tag), true);
  assert.equal(ifNoneMatches(['"x"', '"abc"'], tag), true);
  assert.equal(ifNoneMatches('abc', tag), false);
  assert.equal(ifNoneMatches('"abcd"', tag), false);
  assert.equal(ifNoneMatches('"ab"', tag), false);
});

// ------------------------------------------------------------- misses, floods, and independence

test('every kind of miss is the same 404, byte for byte, as an unknown path', async () => {
  await withHousehold({}, async (h) => {
    const { path } = await feedOf(h.anna);
    const dead = (await h.anna.post('/api/calendar-feed/new-link', {})).body.feed.path as string; // the address before it was replaced is `path`
    assert.notEqual(dead, path);
    await h.admin.patch(`/api/admin/users/${h.ben.id}`, { active: false });
    const anon = h.t.client();
    const unknownRoute = await anon.get('/api/does-not-exist');
    assert.equal(unknownRoute.status, 404);
    const targets = [
      path, // replaced
      `${FEED_PREFIX}${crypto.randomBytes(32).toString('base64url')}.ics`, // never made
      `${FEED_PREFIX}short.ics`, // wrong shape
      `${FEED_PREFIX}${'a'.repeat(44)}.ics`,
      `${FEED_PREFIX}${'a'.repeat(43)}.ical`,
      `${FEED_PREFIX}${'a'.repeat(43)}`,
      `${FEED_PREFIX}${'!'.repeat(43)}.ics`,
      `${FEED_PREFIX}${dead.slice(FEED_PREFIX.length, -4).toLowerCase()}.ics`, // right length, wrong case
    ];
    for (const target of targets) {
      for (const method of ['GET', 'HEAD']) {
        const r = await anon.request(method, target);
        assert.equal(r.status, 404, `${method} ${target}`);
        if (method === 'GET') assert.equal(r.text, unknownRoute.text, `${target} is answered exactly like a path that does not exist`);
        assert.equal(r.headers['content-type'], unknownRoute.headers['content-type']);
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.equal(r.headers['www-authenticate'], undefined);
      }
      h.t.clock.advance(16 * 60_000); // misses are counted: let the window pass between them
    }
  });
});

test('misses are counted per address before any lookup; the 31st gets 429 with Retry-After, and only the feed is shut', async () => {
  await withHousehold({ overrides: { trustProxy: true } }, async (h) => {
    const { path } = await feedOf(h.anna);
    const token = (await h.anna.post('/api/tokens', { name: 'x' })).body.token as string;
    const anon = h.t.client();
    const from = (n: number): Record<string, string> => ({ 'X-Forwarded-For': `2001:db8:5:6:${n.toString(16)}::${n.toString(16)}` });
    for (let i = 1; i <= 30; i++) {
      const r = await anon.get(`${FEED_PREFIX}${crypto.randomBytes(32).toString('base64url')}.ics`, from(i));
      assert.equal(r.status, 404, `miss ${i}`);
    }
    const blocked = await anon.get(path, from(99));
    assert.equal(blocked.status, 429, 'a good address from a counted-out /64 is turned away too');
    assert.equal(blocked.body.error.code, 'too_many_attempts');
    assert.ok(Number(blocked.headers['retry-after']) >= 1 && Number(blocked.headers['retry-after']) <= 900);
    assert.equal(blocked.headers['etag'], undefined, 'nothing about the feed leaks into the refusal');
    assert.equal((await anon.request('HEAD', path, undefined, from(98))).status, 429);
    // The other counters are not touched: the same address can use a token and sign in.
    assert.equal((await anon.get('/api/v1/me', { ...bearer(token), ...from(97) })).status, 200);
    assert.equal((await h.t.client().post('/api/auth/login', { username: 'anna', password: 'correct-horse-battery' }, from(96))).status, 200);
    // Another /64 and an IPv4 address are other clients.
    assert.equal((await anon.get(path, { 'X-Forwarded-For': '2001:db8:5:7::1' })).status, 200);
    assert.equal((await anon.get(path, { 'X-Forwarded-For': '192.0.2.44' })).status, 200);
    // And the window passes.
    h.t.clock.advance(15 * 60_000 + 1000);
    assert.equal((await anon.get(path, from(1))).status, 200);
    assert.ok(h.t.logs.some((l) => l['event'] === 'calendar.rate_limited' && typeof l['ip'] === 'string'));
  });
});

test('failed bearer attempts and failed logins do not count against the feed, and a stale feed address does not lock a token out', async () => {
  await withHousehold({}, async (h) => {
    const { path } = await feedOf(h.anna);
    const token = (await h.anna.post('/api/tokens', { name: 'x' })).body.token as string;
    const anon = h.t.client();
    for (let i = 0; i < 30; i++) await anon.get('/api/v1/me', bearer(`pat_${crypto.randomBytes(32).toString('base64url')}`));
    assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 429, 'the token API is shut for this address');
    assert.equal((await anon.get(path)).status, 200, 'the feed is not');
    h.t.clock.advance(16 * 60_000);
    for (let i = 0; i < 30; i++) await anon.get(`${FEED_PREFIX}${crypto.randomBytes(32).toString('base64url')}.ics`);
    assert.equal((await anon.get(path)).status, 429);
    assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 200, 'but the token API is not');
  });
});

// ------------------------------------------------------------------ the secret stays secret

test('neither the secret nor a token reaches a log line, a request id, a header or an error body: 200, 304, 404, 429 and induced 500s', async () => {
  await withHousehold({ overrides: { trustProxy: true } }, async (h) => {
    const feed = await feedOf(h.anna);
    const token = (await h.anna.post('/api/tokens', { name: 'Sensor' })).body.token as string;
    const anon = h.t.client();
    const replies = [];
    const feedGet = await anon.get(feed.path);
    replies.push(feedGet); // 200
    replies.push(await anon.get(feed.path, { 'If-None-Match': feedGet.headers['etag'] as string })); // 304
    replies.push(await anon.request('HEAD', feed.path)); // 200, no body
    // The spellings the router accepts for the same route.
    replies.push(await anon.get(`/api//calendar//${feed.secret}.ics`));
    replies.push(await anon.get(`/api/calendar///${feed.secret}.ics`));
    assert.deepEqual(replies.map((r) => r.status), [200, 304, 200, 200, 200]);
    // 404 with a secret-shaped miss, 401 and 200 on the token API.
    const miss = `${FEED_PREFIX}${crypto.randomBytes(32).toString('base64url')}.ics`;
    replies.push(await anon.get(miss));
    replies.push(await anon.get('/api/v1/me', bearer(token)));
    replies.push(await anon.get('/api/v1/me', bearer(`${token}0`)));
    // 429 on both.
    for (let i = 0; i < 30; i++) replies.push(await anon.get(`${FEED_PREFIX}${crypto.randomBytes(32).toString('base64url')}.ics`, { 'X-Forwarded-For': '192.0.2.9' }));
    replies.push(await anon.get(feed.path, { 'X-Forwarded-For': '192.0.2.9' }));
    for (let i = 0; i < 30; i++) replies.push(await anon.get('/api/v1/me', { ...bearer(`pat_${crypto.randomBytes(32).toString('base64url')}`), 'X-Forwarded-For': '192.0.2.10' }));
    replies.push(await anon.get('/api/v1/me', { ...bearer(token), 'X-Forwarded-For': '192.0.2.10' }));
    assert.ok(replies.some((r) => r.status === 429));

    // Induced server errors on a feed request and on a token request: the message and the stack go to the log.
    const db = h.t.db as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare.bind(db);
    db.prepare = (sql: string): unknown => {
      if (/FROM reservations/.test(sql) || /FROM damage_reports/.test(sql)) throw new Error('induced failure');
      return original(sql);
    };
    try {
      const feed500 = await anon.get(feed.path, { 'X-Forwarded-For': '192.0.2.20' });
      const v1500 = await anon.get('/api/v1/status', { ...bearer(token), 'X-Forwarded-For': '192.0.2.21' });
      assert.equal(feed500.status, 500);
      assert.equal(v1500.status, 500);
      replies.push(feed500, v1500);
    } finally {
      delete (db as { prepare?: unknown }).prepare;
    }
    assert.ok(h.t.logs.some((l) => l['event'] === 'error' && l['message'] === 'induced failure' && typeof l['stack'] === 'string'), 'the errors were logged with their stack');

    const secrets = [feed.secret, token, token.slice(4), crypto.createHash('sha256').update(feed.secret).digest('hex'), crypto.createHash('sha256').update(token).digest('hex')];
    const logText = JSON.stringify(h.t.logs);
    for (const secret of secrets) assert.ok(!logText.includes(secret), `a log line holds ${secret.slice(0, 8)}...`);
    for (const r of replies) {
      for (const secret of secrets) {
        assert.ok(!r.headers['x-request-id']?.includes(secret), 'request id');
        assert.ok(!JSON.stringify(r.headers).includes(secret), 'a header');
        if (r !== feedGet && !r.headers['content-type']?.includes('calendar')) assert.ok(!r.text.includes(secret), 'a body');
      }
    }
    // The logged path is redacted, whichever way the slashes were written.
    const paths = h.t.logs.filter((l) => l['event'] === 'http' && String(l['path']).startsWith('/api/calendar/')).map((l) => l['path']);
    assert.ok(paths.length > 30);
    assert.ok(paths.every((p) => p === '/api/calendar/[redacted]'), `logged paths: ${[...new Set(paths)].join(' | ')}`);
    // The audit lines of the feed carry ids and addresses only.
    const audit = h.t.logs.filter((l) => String(l['event']).startsWith('calendar.'));
    assert.deepEqual(audit[0], { event: 'calendar.created', userId: h.anna.id });
    for (const line of audit) assert.deepEqual(Object.keys(line).filter((k) => !['event', 'userId', 'ip'].includes(k)), []);
  });
});

test('the request id is made by the server, never taken from the request, so it cannot carry a secret into a log', async () => {
  await withHousehold({}, async (h) => {
    const { path } = await feedOf(h.anna);
    const r = await h.t.client().get(path, { 'X-Request-Id': 'SECRET-FROM-THE-CLIENT' });
    assert.match(r.headers['x-request-id'] as string, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(h.t.logs).includes('SECRET-FROM-THE-CLIENT'));
  });
});

test('the feed and the token API never take a query string into the log, and a secret put in one is not echoed', async () => {
  await withHousehold({}, async (h) => {
    const { path } = await feedOf(h.anna);
    const r = await h.t.client().get(`${path}?secret=${'Q'.repeat(43)}`);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(h.t.logs).includes('Q'.repeat(43)));
  });
});

// -------------------------------------------- what the test stage added: the feed against the app, names, and time

/** A small seeded generator (mulberry32), so a failing household can be rebuilt from its number. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the feed shows a person exactly what the app shows them: over 60 seeded households its events are the confirmed reservations of GET /api/reservations and the person\'s own waiting suggestions', async () => {
  await withHousehold({}, async (h) => {
    const people = [h.admin, h.anna, h.ben, h.carla];
    const feeds = new Map<number, string>();
    for (const person of people) feeds.set(person.id, (await feedOf(person)).path);
    const anon = h.t.client();
    const { from, to } = windowBounds(h.t.clock.now(), TZ, h.t.config.windowMonths);
    const shift = (instant: string, ms: number): string => new Date(Date.parse(instant) + ms).toISOString();
    let confirmedSeen = 0;
    let tentativeSeen = 0;
    let hiddenSeen = 0;

    for (let scenario = 1; scenario <= 60; scenario++) {
      const rnd = seeded(scenario);
      const int = (n: number): number => Math.floor(rnd() * n);
      run(h.t.db, 'DELETE FROM reservations');
      const count = 6 + int(12);
      for (let i = 0; i < count; i++) {
        const owner = people[int(people.length)] as Client;
        const creator = rnd() < 0.5 ? owner : (people[int(people.length)] as Client);
        const status = (['confirmed', 'confirmed', 'pending', 'pending', 'declined'] as const)[int(5)] as 'confirmed' | 'pending' | 'declined';
        const length = (1 + int(rnd() < 0.15 ? 96 : 30)) * HOUR;
        let start: string;
        const pick = int(10);
        // Two in ten sit on the edges of the window, to the millisecond: the places where two rules can differ by one.
        if (pick === 0) start = shift(from, -length);
        else if (pick === 1) start = rnd() < 0.5 ? to : shift(to, 1);
        else start = shift(h.t.clock.now().toISOString(), Math.round((rnd() * 460 - 230) * DAY));
        insertReservation(h.t, { userId: owner.id, createdBy: creator.id, status, start, end: shift(start, length) });
      }

      for (const person of people) {
        const app = (await person.get('/api/reservations')).body.items as Array<{ id: number; status: string; userId: number; createdBy: number }>;
        const uid = (id: number): string => `reservation-${id}@gedeelde-auto`;
        const text = (await anon.get(feeds.get(person.id) as string)).text;
        const events = parseIcs(text).events.map((e) => ({ uid: valueOf(e, 'UID'), status: valueOf(e, 'STATUS') }));

        const confirmed = app.filter((i) => i.status === 'confirmed').map((i) => uid(i.id));
        // A waiting suggestion that has not started: made by the person or for them. (An admin's app shows everybody's; the feed never does.)
        const tentative = app.filter((i) => i.status === 'pending' && (i.userId === person.id || i.createdBy === person.id)).map((i) => uid(i.id));
        const message = `household ${scenario}, ${person.id === h.admin.id ? 'the admin' : `person ${person.id}`}`;
        assert.deepEqual(events.filter((e) => e.status === 'CONFIRMED').map((e) => e.uid).sort(), confirmed.sort(), `${message}: confirmed`);
        assert.deepEqual(events.filter((e) => e.status === 'TENTATIVE').map((e) => e.uid).sort(), tentative.sort(), `${message}: tentative`);
        assert.equal(events.length, confirmed.length + tentative.length, `${message}: nothing else`);
        // Never more than the app shows that person.
        const visible = new Set(app.map((i) => uid(i.id)));
        assert.ok(events.every((e) => visible.has(e.uid)), `${message}: every event is one the app shows them`);
        confirmedSeen += confirmed.length;
        tentativeSeen += tentative.length;
        hiddenSeen += app.filter((i) => i.status === 'pending').length - tentative.length;
      }
    }
    assert.ok(confirmedSeen > 500 && tentativeSeen > 100, `the households exercised the feed (${confirmedSeen} confirmed, ${tentativeSeen} tentative)`);
    assert.ok(hiddenSeen > 0, 'and an admin met suggestions between other people that the feed leaves out');
  });
});

test('what a person is called cannot change the shape of the feed: commas, semicolons, backslashes, emoji, 60 characters, and even line breaks in a name', async () => {
  await withHousehold({}, async (h) => {
    const named = new Map<number, string>([
      [h.ben.id, 'Ben, de ; baas\\'],
      [h.carla.id, '😀'.repeat(30)],
      [h.admin.id, 'é'.repeat(60)],
    ]);
    for (const [id, displayName] of named) assert.equal((await h.admin.patch(`/api/admin/users/${id}`, { displayName })).status, 200, displayName);
    // Names the admin screen may never have let through, but an old database or a manual edit can hold: line breaks
    // that try to end the event and begin another one, and a control character.
    const hostile = 'Eve\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:fake\u0007';
    run(h.t.db, 'UPDATE users SET display_name = ? WHERE id = ?', hostile, h.anna.id);
    named.set(h.anna.id, hostile);

    const owners = [h.anna, h.ben, h.carla, h.admin];
    const ids = owners.map((o, i) => insertReservation(h.t, { userId: o.id, start: iso(h, (i + 1) * DAY), end: iso(h, (i + 1) * DAY + HOUR) }));
    const suggestion = insertReservation(h.t, { userId: h.carla.id, createdBy: h.ben.id, status: 'pending', start: iso(h, 6 * DAY), end: iso(h, 6 * DAY + HOUR) });
    const { path } = await feedOf(h.ben);
    const reply = await h.t.client().get(path);
    assert.equal(reply.status, 200);

    // The strict reader throws on anything that is not RFC 5545 (an injected line, a line over 75 octets, a cut character).
    const parsed = parseIcs(reply.text);
    assert.equal(parsed.events.length, 5, 'a name cannot add an event or end one');
    // (the words BEGIN:VEVENT do appear inside the escaped name, on one line: only a line of its own would count)
    assert.equal((reply.text.match(/^BEGIN:VEVENT\r$/gm) ?? []).length, 5);
    assert.equal((reply.text.match(/^END:VEVENT\r$/gm) ?? []).length, 5);
    assert.equal((reply.text.match(/^SUMMARY:/gm) ?? []).length, 5, 'and cannot add a property: a line that starts with a property name is never what a person typed');
    const normalise = (name: string): string => name.replace(/\r\n|\r|\n/g, '\n').replaceAll('\u0007', ' ');
    const summaryOf = (id: number): string => valueOf(parsed.events.find((e) => valueOf(e, 'UID') === `reservation-${id}@gedeelde-auto`) as IcsProps, 'SUMMARY');
    owners.forEach((owner, i) => assert.equal(summaryOf(ids[i] as number), `Auto: ${normalise(named.get(owner.id) as string)}`, `owner ${owner.id}`));
    assert.equal(summaryOf(suggestion), `Voorstel: ${normalise(named.get(h.carla.id) as string)}`);
    for (const line of reply.text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `a line of ${Buffer.byteLength(line)} octets`);
  });
});

test('today a password change or an admin reset leaves the calendar link working: only replacing it, turning it off or deactivating the person ends it', async () => {
  await withHousehold({}, async (h) => {
    const { path } = await feedOf(h.ben);
    const anon = h.t.client();
    assert.equal((await h.ben.post('/api/auth/password', { currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' })).status, 204);
    assert.equal((await anon.get(path)).status, 200, 'their own password change');
    const reset = await h.admin.post(`/api/admin/users/${h.ben.id}/password`, {});
    assert.equal(reset.status, 200);
    assert.equal((await anon.get(path)).status, 200, 'an admin reset (it ends the tokens, not the link: the person replaces the link with "Nieuwe link maken")');
    // The reset ended his sessions: he signs in with the new password and replaces the link himself.
    assert.equal((await h.ben.get('/api/calendar-feed')).status, 401);
    const again = h.t.client();
    assert.equal((await again.login('ben', reset.body.generatedPassword as string)).status, 200);
    assert.equal((await again.post('/api/calendar-feed/new-link', {})).status, 201);
    assert.equal((await anon.get(path)).status, 404, 'and then the old address is dead');
  });
});

test('the body and the ETag change only when the data does: hours and days later with nothing edited, the same tag still gets its 304', async () => {
  await withHousehold({}, async (h) => {
    insertReservation(h.t, { userId: h.ben.id, start: iso(h, 2 * DAY), end: iso(h, 2 * DAY + HOUR) });
    insertReservation(h.t, { userId: h.anna.id, createdBy: h.ben.id, status: 'pending', start: iso(h, 5 * DAY), end: iso(h, 5 * DAY + HOUR) });
    const { path } = await feedOf(h.anna);
    const anon = h.t.client();
    const first = await anon.get(path);
    const tag = first.headers['etag'] as string;
    const stamps = [...first.text.matchAll(/^DTSTAMP:(\S+)$/gm)].map((m) => m[1]);
    assert.equal(stamps.length, 2);
    for (const step of [HOUR, 5 * HOUR, DAY, 30 * HOUR]) {
      h.t.clock.advance(step);
      const again = await anon.get(path);
      assert.equal(again.text, first.text, `the body is the same ${step / HOUR} hours on`);
      assert.equal(again.headers['etag'], tag);
      assert.equal((await anon.get(path, { 'If-None-Match': tag })).status, 304, 'so a client that kept the tag is told nothing changed');
    }
    // DTSTAMP is the record's own time of change, not the time of the request.
    assert.deepEqual([...first.text.matchAll(/^DTSTAMP:(\S+)$/gm)].map((m) => m[1]), ['20260615T100000Z', '20260615T100000Z']);
  });
});
