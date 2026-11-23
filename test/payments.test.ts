import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEuro } from '../shared/format.js';
import { isTikkieLink, requestMessage, manualProvider, type PaymentInput } from '../src/payments.ts';
import { loadConfig } from '../src/config.ts';
import { FUEL_ODO, at, createHousehold, insertUsage, stubFetch, type Json, type StubFetch } from './helpers.ts';

const API_KEY = 'api-key-must-never-leak-0001';
const TOKEN = 'access-token-must-never-leak-0002';
const TIKKIE_ENV = { TIKKIE_PAYMENT_REQUEST_URL: 'https://tikkie.test.invalid/v1/requests', TIKKIE_API_KEY: API_KEY, TIKKIE_ACCESS_TOKEN: TOKEN };

const INPUT: PaymentInput = {
  amountCents: 1500,
  creditorName: 'Anna',
  debtorName: 'Ben',
  litres: '40,00',
  date: 'zaterdag 13 juni',
  km: 50,
  kmTotal: 200,
  equalSplit: false,
  reference: 'fuel-1-3',
};

async function household(opts: Parameters<typeof createHousehold>[0] = {}) {
  const h = await createHousehold(opts);
  insertUsage(h.t, { userId: h.anna.id, start: at(h.t.clock, -30), end: at(h.t.clock, -28), odometerStart: 1000, odometerEnd: 1150 });
  insertUsage(h.t, { userId: h.ben.id, start: at(h.t.clock, -26), end: at(h.t.clock, -24), odometerStart: 1150, odometerEnd: 1200 });
  const fuel = (await h.anna.post('/api/fuel', { at: at(h.t.clock, -10), millilitres: 40_000, totalCents: 6000, odometer: FUEL_ODO })).body.fuel;
  return { ...h, fuel };
}

const everything = (h: { t: { logs: unknown[] } }, ...replies: Array<{ text: string }>): string => JSON.stringify(h.t.logs) + replies.map((r) => r.text).join('\n');

test('money is formatted from integer cents without floats', () => {
  assert.equal(formatEuro(1500), '€\u00a015,00');
  assert.equal(formatEuro(5), '€\u00a00,05');
  assert.equal(formatEuro(1234567), '€\u00a012.345,67');
  assert.equal(formatEuro(-250), '€\u00a0-2,50');
});

test('the manual provider writes the request text with the amount, the names and the basis', async () => {
  const made = await manualProvider.create(INPUT);
  assert.equal(made.provider, 'manual');
  assert.equal(made.link, undefined);
  assert.match(made.message, /Ben/);
  assert.match(made.message, /Anna heeft op zaterdag 13 juni de gedeelde auto getankt \(40,00 L\)/);
  assert.match(made.message, /€\s15,00/);
  assert.match(made.message, /50 van 200 km gereden/);
  assert.match(requestMessage({ ...INPUT, equalSplit: true }), /in die periode zijn geen kilometers geteld, dus de kosten zijn gelijk verdeeld/);
});

test('the request text explains the split: personal kilometres, the pool in the same ratio, only the pool, or nothing counted', () => {
  // Personal kilometres only: as it always was.
  assert.match(requestMessage(INPUT), /Jouw aandeel is €\s15,00 \(50 van 200 km gereden\)\./);
  assert.match(requestMessage({ ...INPUT, togetherKm: 0 }), /\(50 van 200 km gereden\)/);

  // Personal kilometres plus a pool: the ratio is told against the personal total, and the pool follows it.
  const withPool = requestMessage({ ...INPUT, km: 50, kmTotal: 260, togetherKm: 60 });
  assert.match(withPool, /\(50 van 200 km gereden; de 60 km die samen zijn gereden, worden in dezelfde verhouding verdeeld\)/);
  assert.doesNotMatch(withPool, /gelijk deel|gelijk verdeeld/);

  // Only the pool: an equal split, and it says why.
  const onlyPool = requestMessage({ ...INPUT, km: 0, kmTotal: 60, togetherKm: 60, equalSplit: true });
  assert.match(onlyPool, /\(in die periode zijn maar 60 km samen gereden, dus de kosten zijn gelijk verdeeld\)/);

  // Nothing counted at all.
  assert.match(requestMessage({ ...INPUT, km: 0, kmTotal: 0, equalSplit: true }), /\(in die periode zijn geen kilometers geteld, dus de kosten zijn gelijk verdeeld\)/);

  // Without a pool and with nothing carried, only the no-kilometres sentence differs from the old text.
  assert.equal(
    requestMessage(INPUT),
    'Hoi Ben, Anna heeft op zaterdag 13 juni de gedeelde auto getankt (40,00 L). Jouw aandeel is €\u00a015,00 (50 van 200 km gereden). Wil je dit aan Anna betalen?',
  );
});

test('only https links on tikkie.me count as a Tikkie link', () => {
  assert.equal(isTikkieLink('https://tikkie.me/pay/abc123'), true);
  assert.equal(isTikkieLink('https://www.tikkie.me/pay/abc'), true);
  for (const bad of ['http://tikkie.me/pay/a', 'https://tikkie.me.evil.test/pay/a', 'https://eviltikkie.me/a', 'javascript:alert(1)', 'https://user:pw@tikkie.me/a', '', 42, null, `https://tikkie.me/${'a'.repeat(600)}`]) {
    assert.equal(isTikkieLink(bad), false, String(bad));
  }
});

test('without Tikkie settings nothing outbound is ever called, however many requests are made', async () => {
  const stub = stubFetch();
  const { t, anna, ben, fuel } = await household({ fetch: stub.fetch });
  try {
    const res = await anna.post(`/api/fuel/${fuel.id}/requests`, { debtorId: ben.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.fuel.shares.find((s: Json) => s.userId === ben.id).request.provider, 'manual');
    assert.equal((await anna.post(`/api/fuel/${fuel.id}/requests`, { debtorId: ben.id, link: 'https://pay.example/x' })).status, 200);
    assert.equal(stub.calls.length, 0);
    assert.equal(t.config.tikkie, undefined);
  } finally {
    await t.close();
  }
});

test('with all three Tikkie settings the adapter calls the configured endpoint with the documented headers and body (stub only)', async () => {
  const stub = stubFetch(() => Response.json({ url: 'https://tikkie.me/pay/abc123' }, { status: 201 }));
  const { t, anna, ben, fuel } = await household({ env: TIKKIE_ENV, fetch: stub.fetch });
  try {
    const res = await anna.post(`/api/fuel/${fuel.id}/requests`, { debtorId: ben.id });
    assert.equal(res.status, 201, res.text);
    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0]!;
    assert.equal(call.url, 'https://tikkie.test.invalid/v1/requests');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['api-key'], API_KEY);
    assert.equal(call.headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(call.headers['content-type'], 'application/json');
    const sent = JSON.parse(call.body!.toString('utf8'));
    assert.deepEqual(sent, { amountInCents: 1500, currency: 'EUR', description: sent.description, referenceId: `fuel-${fuel.id}-${ben.id}` });
    assert.match(sent.description, /^Tankbeurt /);
    const request = res.body.fuel.shares.find((s: Json) => s.userId === ben.id).request;
    assert.equal(request.provider, 'tikkie');
    assert.equal(request.link, 'https://tikkie.me/pay/abc123');
    assert.match(request.message, /€\s15,00/);
    assert.match(request.message, /Betaal hier: https:\/\/tikkie\.me\/pay\/abc123$/);
    // The paymentRequestUrl spelling is accepted too, and a link pasted by the user wins over the provider's.
    stub.respond(() => Response.json({ paymentRequestUrl: 'https://tikkie.me/pay/second' }));
    const second = await anna.post(`/api/fuel/${fuel.id}/requests`, { debtorId: ben.id });
    assert.equal(second.body.fuel.shares.find((s: Json) => s.userId === ben.id).request.link, 'https://tikkie.me/pay/second');
    const pasted = await anna.post(`/api/fuel/${fuel.id}/requests`, { debtorId: ben.id, link: 'https://pay.example/mine' });
    assert.equal(pasted.body.fuel.shares.find((s: Json) => s.userId === ben.id).request.link, 'https://pay.example/mine');
  } finally {
    await t.close();
  }
});

test('whatever goes wrong at Tikkie, the request falls back to the manual text and nothing secret is logged or returned', async () => {
  const scenarios: Array<[string, (stub: StubFetch) => void]> = [
    ['a non-2xx answer', (s) => s.respond(() => new Response('{"error":"nope"}', { status: 401 }))],
    ['a server error', (s) => s.respond(() => new Response('boom', { status: 503 }))],
    ['a link on another host', (s) => s.respond(() => Response.json({ url: 'https://tikkie.me.evil.test/pay/x' }))],
    ['a link that is not https', (s) => s.respond(() => Response.json({ url: 'http://tikkie.me/pay/x' }))],
    ['an answer without a link', (s) => s.respond(() => Response.json({ ok: true }))],
    ['malformed JSON', (s) => s.respond(() => new Response('<html>not json', { status: 200 }))],
    ['a network failure', (s) => s.respond(() => Promise.reject(new TypeError(`fetch failed for ${TOKEN}`)))],
    ['a timeout', (s) => s.respond(() => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')))],
  ];
  for (const [label, script] of scenarios) {
    const stub = stubFetch();
    script(stub);
    const h = await household({ env: TIKKIE_ENV, fetch: stub.fetch });
    try {
      const res = await h.anna.post(`/api/fuel/${h.fuel.id}/requests`, { debtorId: h.ben.id });
      assert.equal(res.status, 201, label);
      const request = res.body.fuel.shares.find((s: Json) => s.userId === h.ben.id).request;
      assert.equal(request.provider, 'manual', label);
      assert.equal(request.link, '', label);
      assert.match(request.message, /€\s15,00/, label);
      assert.equal(stub.calls.length, 1, label);
      const text = everything(h, res);
      assert.ok(!text.includes(API_KEY) && !text.includes(TOKEN), `${label}: no secret in the logs or the response`);
      assert.ok(h.t.logs.some((l) => l['event'] === 'payment.tikkie_failed'), `${label}: the failure is logged, by status only`);
      assert.ok(h.t.logs.filter((l) => l['event'] === 'payment.tikkie_failed').every((l) => Object.keys(l).every((k) => ['event', 'status'].includes(k))), label);
    } finally {
      await h.t.close();
    }
  }
});

test('an unusable Tikkie answer is not left half-read: its body is cancelled so the connection is released', async () => {
  let cancelled = false;
  const stub = stubFetch(
    () =>
      new Response(
        new ReadableStream({
          pull() {
            // never delivers a chunk: only cancelling gets rid of it
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 502 },
      ),
  );
  const h = await household({ env: TIKKIE_ENV, fetch: stub.fetch });
  try {
    const res = await h.anna.post(`/api/fuel/${h.fuel.id}/requests`, { debtorId: h.ben.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.fuel.shares.find((s: Json) => s.userId === h.ben.id).request.provider, 'manual');
    assert.equal(cancelled, true);
  } finally {
    await h.t.close();
  }
});

test('the secrets never appear in any response or log, also on the happy path and in the fuel list', async () => {
  const stub = stubFetch(() => Response.json({ url: 'https://tikkie.me/pay/abc123' }));
  const h = await household({ env: TIKKIE_ENV, fetch: stub.fetch });
  try {
    const made = await h.anna.post(`/api/fuel/${h.fuel.id}/requests`, { debtorId: h.ben.id });
    const list = await h.ben.get('/api/fuel');
    const admin = await h.admin.get('/api/admin/retention');
    const text = everything(h, made, list, admin);
    assert.ok(!text.includes(API_KEY), 'API key');
    assert.ok(!text.includes(TOKEN), 'access token');
    assert.ok(!text.includes('tikkie.test.invalid'), 'the configured endpoint is not echoed either');
  } finally {
    await h.t.close();
  }
});

test('a partial Tikkie configuration fails fast and names what is missing; an http endpoint is refused', () => {
  assert.equal(loadConfig({}).tikkie, undefined);
  assert.equal(loadConfig({ TIKKIE_PAYMENT_REQUEST_URL: '', TIKKIE_API_KEY: '', TIKKIE_ACCESS_TOKEN: '' }).tikkie, undefined, 'empty values (as in .env.example) mean off');
  assert.deepEqual({ ...loadConfig(TIKKIE_ENV).tikkie }, { url: TIKKIE_ENV.TIKKIE_PAYMENT_REQUEST_URL, apiKey: API_KEY, accessToken: TOKEN });
  assert.throws(() => loadConfig({ TIKKIE_API_KEY: API_KEY }), /missing: TIKKIE_PAYMENT_REQUEST_URL, TIKKIE_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ TIKKIE_PAYMENT_REQUEST_URL: TIKKIE_ENV.TIKKIE_PAYMENT_REQUEST_URL }), /missing: TIKKIE_API_KEY, TIKKIE_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ ...TIKKIE_ENV, TIKKIE_ACCESS_TOKEN: '' }), /missing: TIKKIE_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ ...TIKKIE_ENV, TIKKIE_PAYMENT_REQUEST_URL: 'http://tikkie.example/v1' }), /must start with https:\/\//);
  assert.throws(() => loadConfig({ TIKKIE_API_KEY: API_KEY }), (err: Error) => !err.message.includes(API_KEY), 'the error does not echo the secret');
});

// ----------------------------------------------------------------- added by the test stage

/** Anna drove 150 km and Ben 50 km, then Anna fills up: Ben's share of a fill-up is a quarter of it. */
async function fillUp(millilitres: number, totalCents: number) {
  const h = await createHousehold();
  insertUsage(h.t, { userId: h.anna.id, start: at(h.t.clock, -30), end: at(h.t.clock, -28), odometerStart: 1000, odometerEnd: 1150 });
  insertUsage(h.t, { userId: h.ben.id, start: at(h.t.clock, -26), end: at(h.t.clock, -24), odometerStart: 1150, odometerEnd: 1200 });
  const made = await h.anna.post('/api/fuel', { at: at(h.t.clock, -10), millilitres, totalCents, odometer: FUEL_ODO });
  assert.equal(made.status, 201, made.text);
  return { ...h, fuel: made.body.fuel as Json };
}

test('a stored payment request writes a fill-up that is not a round number the Dutch way: litres with a comma and three decimals, the euro with a comma, the date in Dutch', async () => {
  const h = await fillUp(40_123, 123_456);
  try {
    // The API still speaks integers: only the text people read is formatted.
    assert.equal(h.fuel.millilitres, 40_123);
    assert.equal(h.fuel.totalCents, 123_456);
    assert.ok(Number.isInteger(h.fuel.pricePerLitreMillis), 'the price per litre stays an integer number of thousandths');
    const res = await h.anna.post(`/api/fuel/${h.fuel.id}/requests`, { debtorId: h.ben.id });
    assert.equal(res.status, 201, res.text);
    const share = res.body.fuel.shares.find((s: Json) => s.userId === h.ben.id);
    assert.equal(share.cents, 30_864, 'a quarter of 1.234,56');
    assert.equal(
      share.request.message,
      'Hoi Ben, Anna heeft op maandag 15 juni de gedeelde auto getankt (40,123 L). Jouw aandeel is €\u00a0308,64 (50 van 200 km gereden). Wil je dit aan Anna betalen?',
    );
    assert.ok(!/\d\.\d{2}\b/.test(share.request.message), 'no decimal dot in the text');
  } finally {
    await h.t.close();
  }
});

test('a stored payment request groups thousands with a dot and keeps two decimals on litres that are exact', async () => {
  const h = await fillUp(200_000, 1_000_000); // the largest fill-up there is
  try {
    const res = await h.anna.post(`/api/fuel/${h.fuel.id}/requests`, { debtorId: h.ben.id });
    assert.equal(res.status, 201, res.text);
    const share = res.body.fuel.shares.find((s: Json) => s.userId === h.ben.id);
    assert.equal(share.cents, 250_000);
    assert.match(share.request.message, /getankt \(200,00 L\)\. Jouw aandeel is €\u00a02\.500,00 \(50 van 200 km gereden\)\./);
    assert.equal(share.request.amountCents, 250_000, 'the amount stays whole cents in the API');
  } finally {
    await h.t.close();
  }
});
