import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, isTikkieLink, requestMessage, manualProvider, type PaymentInput } from '../src/payments.ts';
import { loadConfig } from '../src/config.ts';
import { at, createHousehold, insertUsage, stubFetch, type Json, type StubFetch } from './helpers.ts';

const API_KEY = 'api-key-must-never-leak-0001';
const TOKEN = 'access-token-must-never-leak-0002';
const TIKKIE_ENV = { TIKKIE_PAYMENT_REQUEST_URL: 'https://tikkie.test.invalid/v1/requests', TIKKIE_API_KEY: API_KEY, TIKKIE_ACCESS_TOKEN: TOKEN };

const INPUT: PaymentInput = {
  amountCents: 1500,
  creditorName: 'Anna',
  debtorName: 'Ben',
  litres: '40.00',
  date: 'Saturday 13 June',
  km: 50,
  kmTotal: 200,
  equalSplit: false,
  reference: 'fuel-1-3',
};

async function household(opts: Parameters<typeof createHousehold>[0] = {}) {
  const h = await createHousehold(opts);
  insertUsage(h.t, { userId: h.anna.id, start: at(h.t.clock, -30), end: at(h.t.clock, -28), odometerStart: 1000, odometerEnd: 1150 });
  insertUsage(h.t, { userId: h.ben.id, start: at(h.t.clock, -26), end: at(h.t.clock, -24), odometerStart: 1150, odometerEnd: 1200 });
  const fuel = (await h.anna.post('/api/fuel', { at: at(h.t.clock, -10), millilitres: 40_000, totalCents: 6000 })).body.fuel;
  return { ...h, fuel };
}

const everything = (h: { t: { logs: unknown[] } }, ...replies: Array<{ text: string }>): string => JSON.stringify(h.t.logs) + replies.map((r) => r.text).join('\n');

test('money is formatted from integer cents without floats', () => {
  assert.equal(formatCents(1500), '15.00');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(1234567), '12345.67');
  assert.equal(formatCents(-250), '-2.50');
});

test('the manual provider writes the request text with the amount, the names and the basis', async () => {
  const made = await manualProvider.create(INPUT);
  assert.equal(made.provider, 'manual');
  assert.equal(made.link, undefined);
  assert.match(made.message, /Ben/);
  assert.match(made.message, /Anna fuelled the shared car on Saturday 13 June \(40\.00 L\)/);
  assert.match(made.message, /EUR 15\.00/);
  assert.match(made.message, /50 of 200 km driven/);
  assert.match(requestMessage({ ...INPUT, equalSplit: true }), /nobody drove in that period, so the cost is split equally/);
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
    assert.match(sent.description, /^Fuel /);
    const request = res.body.fuel.shares.find((s: Json) => s.userId === ben.id).request;
    assert.equal(request.provider, 'tikkie');
    assert.equal(request.link, 'https://tikkie.me/pay/abc123');
    assert.match(request.message, /EUR 15\.00/);
    assert.match(request.message, /Pay here: https:\/\/tikkie\.me\/pay\/abc123$/);
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
      assert.match(request.message, /EUR 15\.00/, label);
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
