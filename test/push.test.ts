import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { many, one, run } from '../src/db.ts';
import { createPush, validateEndpoint, validateKeys } from '../src/push.ts';
import { fromB64u, toB64u } from '../src/webpush.ts';
import { verifyVapidToken } from './webpush-peer.ts';
import { createHousehold, makeSubscriber, stubFetch, type Json } from './helpers.ts';

const ENV = { PUSH_CONTACT: 'https://car.example.test' };

// ------------------------------------------------------ endpoint allow-list

test('endpoints: only https on 443 at the four push services are accepted', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
    'https://web.push.apple.com/QGkq1',
    'https://push.apple.com/x',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) {
    assert.equal(validateEndpoint(ok), null, ok);
  }
});

test('endpoints: look-alike hosts, other Google hosts, IPs, localhost, credentials, ports and plain http are all refused', () => {
  const unsupported = [
    'https://example.com/push',
    'https://fcm.googleapis.com.evil.test/fcm/send/abc',
    'https://evil.test/fcm.googleapis.com',
    'https://evilfcm.googleapis.com/x',
    'https://googleapis.com/x',
    'https://storage.googleapis.com/x',
    'https://www.googleapis.com/x',
    'https://evilpush.apple.com/x',
    'https://push.apple.com.evil.test/x',
    'https://web.push.apple.com./x',
    'https://services.mozilla.com/x',
    'https://push.services.mozilla.com.evil.test/x',
    'https://notify.windows.com.evil.test/x',
    'https://windows.com/x',
  ];
  for (const bad of unsupported) assert.equal(validateEndpoint(bad), 'unsupported_endpoint', bad);
  const invalid = [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://user:pw@fcm.googleapis.com/fcm/send/abc',
    'https://user@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://[fe80::1]/x',
    'https://localhost/x',
    'https://localhost:443/x',
    'ftp://fcm.googleapis.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '',
    `https://fcm.googleapis.com/${'a'.repeat(2100)}`,
  ];
  for (const bad of invalid) assert.equal(validateEndpoint(bad), 'invalid_endpoint', bad.slice(0, 60));
});

test('subscription keys: p256dh must be a real P-256 point and auth 16 bytes, both base64url', () => {
  const sub = makeSubscriber();
  assert.deepEqual(validateKeys(sub.p256dh, sub.auth), {});
  assert.equal(validateKeys('', sub.auth).p256dh, 'invalid_key');
  assert.equal(validateKeys(sub.p256dh.slice(0, 40), sub.auth).p256dh, 'invalid_key', 'too short');
  assert.equal(validateKeys(toB64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])), sub.auth).p256dh, 'invalid_key', 'not on the curve');
  assert.equal(validateKeys(toB64u(Buffer.concat([Buffer.from([2]), fromB64u(sub.p256dh).subarray(1)])), sub.auth).p256dh, 'invalid_key', 'compressed prefix');
  assert.equal(validateKeys('!!' + sub.p256dh.slice(2), sub.auth).p256dh, 'invalid_key', 'not base64url');
  assert.equal(validateKeys(sub.p256dh, '').auth, 'invalid_key');
  assert.equal(validateKeys(sub.p256dh, toB64u(crypto.randomBytes(15))).auth, 'invalid_key');
  assert.equal(validateKeys(sub.p256dh, toB64u(crypto.randomBytes(17))).auth, 'invalid_key');
});

// ------------------------------------------------------------------- routes

test('every push route needs a signed-in user', async () => {
  const { t } = await createHousehold({ env: ENV });
  try {
    const anon = t.client();
    assert.equal((await anon.get('/api/push/key')).status, 401);
    assert.equal((await anon.post('/api/push/subscribe', makeSubscriber().subscription)).status, 401);
    assert.equal((await anon.post('/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/x' })).status, 401);
    assert.equal((await anon.post('/api/push/test', {})).status, 401);
  } finally {
    await t.close();
  }
});

test('the key route says whether reminders are on; the key is stable across restarts and never leaks the private half', async () => {
  const off = await createHousehold(); // no DOMAIN, no PUSH_CONTACT
  try {
    assert.deepEqual({ ...(await off.anna.get('/api/push/key')).body }, { enabled: false });
    assert.equal((await off.anna.post('/api/push/subscribe', makeSubscriber().subscription)).body.error.code, 'push_disabled');
    assert.equal((await off.anna.post('/api/push/test', {})).body.error.code, 'push_disabled');
    assert.equal(one(off.t.db, "SELECT value FROM meta WHERE key = 'vapid_jwk'"), undefined, 'no key is generated while push is off');
  } finally {
    await off.t.close();
  }
  const killed = await createHousehold({ env: { ...ENV, PUSH_ENABLED: 'false' } });
  try {
    assert.equal((await killed.anna.get('/api/push/key')).body.enabled, false, 'the kill switch wins');
  } finally {
    await killed.t.close();
  }

  const { t, anna, ben } = await createHousehold({ env: ENV });
  try {
    const key = (await anna.get('/api/push/key')).body;
    assert.equal(key.enabled, true);
    assert.equal(fromB64u(key.publicKey).length, 65);
    assert.equal((await ben.get('/api/push/key')).body.publicKey, key.publicKey);
    // A new service object on the same database (a restart) finds the same key.
    assert.equal(createPush(t.ctx).publicKey(), key.publicKey);
    const stored = one<{ value: string }>(t.db, "SELECT value FROM meta WHERE key = 'vapid_jwk'")?.value ?? '';
    assert.ok(stored.includes('"d"'), 'the private key is kept in the database...');
    const text = JSON.stringify((await anna.get('/api/push/key')).body) + JSON.stringify(t.logs);
    assert.ok(!text.includes(JSON.parse(stored).d), '...and nowhere else');
  } finally {
    await t.close();
  }
});

test('subscribing: stored per user, upserted by endpoint, validated with field codes', async () => {
  const { t, anna, ben } = await createHousehold({ env: ENV });
  try {
    const phone = makeSubscriber();
    const res = await anna.post('/api/push/subscribe', phone.subscription);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual({ ...res.body }, { subscribed: true, devices: 1 });
    assert.equal((await anna.post('/api/push/subscribe', phone.subscription)).body.devices, 1, 'the same device twice is still one device');
    assert.equal(many(t.db, 'SELECT id FROM push_subscriptions').length, 1);

    const bad = await anna.post('/api/push/subscribe', { endpoint: 'https://example.com/x', keys: { p256dh: 'AAAA', auth: 'BBBB' } });
    assert.equal(bad.status, 422);
    assert.deepEqual({ ...bad.body.error.fields }, { endpoint: 'unsupported_endpoint', p256dh: 'invalid_key', auth: 'invalid_key' });
    assert.deepEqual({ ...(await anna.post('/api/push/subscribe', {})).body.error.fields }, { endpoint: 'required', p256dh: 'required', auth: 'required' });
    assert.equal((await anna.post('/api/push/subscribe', { endpoint: phone.endpoint, keys: 'nope' })).status, 422);
    assert.equal((await anna.post('/api/push/subscribe', { ...phone.subscription, endpoint: 'http://fcm.googleapis.com/x' })).body.error.fields.endpoint, 'invalid_endpoint');

    // The same phone signed in as someone else: the subscription moves to them.
    assert.equal((await ben.post('/api/push/subscribe', phone.subscription)).status, 201);
    assert.deepEqual(many<{ user_id: number }>(t.db, 'SELECT user_id FROM push_subscriptions').map((r) => r.user_id), [ben.id]);
  } finally {
    await t.close();
  }
});

test('at most ten devices per person', async () => {
  const { t, anna, ben } = await createHousehold({ env: ENV });
  try {
    const devices = Array.from({ length: 10 }, () => makeSubscriber());
    for (const d of devices) assert.equal((await anna.post('/api/push/subscribe', d.subscription)).status, 201);
    const eleventh = await anna.post('/api/push/subscribe', makeSubscriber().subscription);
    assert.equal(eleventh.status, 409);
    assert.equal(eleventh.body.error.code, 'too_many_subscriptions');
    assert.equal((await anna.post('/api/push/subscribe', (devices[0] as ReturnType<typeof makeSubscriber>).subscription)).status, 201, 'refreshing one of the ten is fine');
    assert.equal((await ben.post('/api/push/subscribe', makeSubscriber().subscription)).status, 201, 'the limit is per person');
  } finally {
    await t.close();
  }
});

test('unsubscribing removes your own device only, and answers the same either way', async () => {
  const { t, anna, ben } = await createHousehold({ env: ENV });
  try {
    const phone = makeSubscriber();
    await anna.post('/api/push/subscribe', phone.subscription);
    assert.equal((await ben.post('/api/push/unsubscribe', { endpoint: phone.endpoint })).status, 204);
    assert.equal(many(t.db, 'SELECT id FROM push_subscriptions').length, 1, "someone else's request changes nothing");
    assert.equal((await anna.post('/api/push/unsubscribe', { endpoint: phone.endpoint })).status, 204);
    assert.equal(many(t.db, 'SELECT id FROM push_subscriptions').length, 0);
    assert.equal((await anna.post('/api/push/unsubscribe', { endpoint: phone.endpoint })).status, 204, 'already gone is fine');
    assert.equal((await anna.post('/api/push/unsubscribe', {})).body.error.fields.endpoint, 'required');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------- sending

test('end to end: a test notification reaches the stub push service, signed with VAPID and decryptable only by the subscriber', async () => {
  const stub = stubFetch();
  const { t, anna } = await createHousehold({ env: ENV, fetch: stub.fetch });
  try {
    const phone = makeSubscriber('https://fcm.googleapis.com/fcm/send/secret-path-123');
    await anna.post('/api/push/subscribe', phone.subscription);
    const res = await anna.post('/api/push/test', {});
    assert.equal(res.status, 200, res.text);
    assert.deepEqual({ ...res.body }, { sent: 1, devices: 1 });

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0]!;
    assert.equal(call.url, phone.endpoint);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['content-encoding'], 'aes128gcm');
    assert.equal(call.headers['ttl'], '3600');
    assert.equal(call.headers['urgency'], 'normal');
    assert.equal(call.redirect, 'manual', 'a redirect from the push service is never followed');
    assert.equal(call.hasSignal, true, 'every call has a timeout');
    const publicKey = (await anna.get('/api/push/key')).body.publicKey;
    const auth = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(call.headers['authorization'] ?? '');
    assert.ok(auth, call.headers['authorization']);
    assert.equal(auth[2], publicKey);
    const token = verifyVapidToken(auth[1] as string, publicKey);
    assert.ok(token, 'the token verifies with the advertised key');
    assert.equal(token.claims['aud'], 'https://fcm.googleapis.com');
    assert.equal(token.claims['sub'], 'https://car.example.test');
    assert.ok((token.claims['exp'] as number) * 1000 - t.clock.now().getTime() <= 24 * 3_600_000);

    const message = phone.read(call);
    assert.deepEqual({ ...message }, { title: 'Testmelding', body: 'Je herinneringen werken op dit apparaat.', url: '/#/account', tag: 'test' });
    assert.ok(!call.body!.toString('latin1').includes('Testmelding'), 'the push service only sees ciphertext');
    // A different subscriber cannot read it.
    assert.throws(() => makeSubscriber().read(call));
  } finally {
    await t.close();
  }
});

test('404 and 410 remove the subscription; 5xx, 429 and 4xx keep it; a redirect is not followed', async () => {
  const stub = stubFetch();
  const { t, anna } = await createHousehold({ env: ENV, fetch: stub.fetch });
  try {
    const phone = makeSubscriber();
    const outcomes: Array<[number, boolean, Record<string, string>?]> = [
      [503, true],
      [500, true],
      [429, true],
      [400, true],
      [401, true],
      [413, true],
      [302, true, { Location: 'http://127.0.0.1:9/steal' }],
      [404, false],
    ];
    for (const [status, kept, headers] of outcomes) {
      await anna.post('/api/push/subscribe', phone.subscription);
      stub.calls.length = 0;
      stub.respond(() => new Response(null, { status, headers }));
      t.clock.advance(61_000); // the test route allows one call a minute
      const res = await anna.post('/api/push/test', {});
      assert.equal(res.status, 200, `status ${status}`);
      assert.equal(res.body.sent, 0, `status ${status}`);
      assert.equal(stub.calls.length, 1, `status ${status}: exactly one request, redirects are not followed`);
      assert.equal(many(t.db, 'SELECT id FROM push_subscriptions').length, kept ? 1 : 0, `status ${status}: ${kept ? 'kept' : 'removed'}`);
    }
    await anna.post('/api/push/subscribe', phone.subscription);
    stub.respond(() => new Response(null, { status: 410 }));
    t.clock.advance(61_000);
    await anna.post('/api/push/test', {});
    assert.equal(many(t.db, 'SELECT id FROM push_subscriptions').length, 0, '410 removes it too');

    await anna.post('/api/push/subscribe', phone.subscription);
    stub.respond(() => Promise.reject(new TypeError('fetch failed')));
    t.clock.advance(61_000);
    assert.equal((await anna.post('/api/push/test', {})).body.sent, 0);
    assert.equal(many(t.db, 'SELECT id FROM push_subscriptions').length, 1, 'a network error keeps the subscription');
  } finally {
    await t.close();
  }
});

test('the test notification is limited to once a minute and needs a device', async () => {
  const stub = stubFetch();
  const { t, anna, ben } = await createHousehold({ env: ENV, fetch: stub.fetch });
  try {
    const none = await anna.post('/api/push/test', {});
    assert.equal(none.status, 409);
    assert.equal(none.body.error.code, 'no_subscription');
    await anna.post('/api/push/subscribe', makeSubscriber().subscription);
    await ben.post('/api/push/subscribe', makeSubscriber().subscription);
    assert.equal((await anna.post('/api/push/test', {})).status, 200);
    const again = await anna.post('/api/push/test', {});
    assert.equal(again.status, 429);
    assert.equal(again.body.error.code, 'too_many_attempts');
    assert.ok(Number(again.headers['retry-after']) > 0);
    assert.equal((await ben.post('/api/push/test', {})).status, 200, 'the limit is per person');
    t.clock.advance(61_000);
    assert.equal((await anna.post('/api/push/test', {})).status, 200);
    assert.equal(stub.calls.length, 3);
  } finally {
    await t.close();
  }
});

test('a stored endpoint outside the allow-list is never contacted', async () => {
  const stub = stubFetch();
  const { t, anna } = await createHousehold({ env: ENV, fetch: stub.fetch });
  try {
    const phone = makeSubscriber();
    run(
      t.db,
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)',
      anna.id,
      'https://169.254.169.254/latest/meta-data',
      phone.p256dh,
      phone.auth,
      t.clock.now().toISOString(),
    );
    const res = await anna.post('/api/push/test', {});
    assert.equal(res.body.sent, 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('deactivating a person removes their devices', async () => {
  const { t, admin, anna, ben } = await createHousehold({ env: ENV });
  try {
    await anna.post('/api/push/subscribe', makeSubscriber().subscription);
    await ben.post('/api/push/subscribe', makeSubscriber().subscription);
    assert.equal((await admin.patch(`/api/admin/users/${anna.id}`, { active: false })).status, 200);
    assert.deepEqual(many<{ user_id: number }>(t.db, 'SELECT user_id FROM push_subscriptions').map((r) => r.user_id), [ben.id]);
  } finally {
    await t.close();
  }
});

test('logs never contain endpoints, keys or the VAPID private key', async () => {
  const stub = stubFetch();
  const { t, anna } = await createHousehold({ env: ENV, fetch: stub.fetch });
  try {
    const phone = makeSubscriber('https://fcm.googleapis.com/fcm/send/capability-secret-xyz');
    await anna.post('/api/push/subscribe', phone.subscription);
    await anna.post('/api/push/test', {});
    stub.respond(() => new Response(null, { status: 410 }));
    t.clock.advance(61_000);
    await anna.post('/api/push/test', {});
    await anna.post('/api/push/subscribe', { ...phone.subscription, endpoint: 'https://evil.test/capability-secret-xyz' });
    const logged = JSON.stringify(t.logs);
    for (const secret of ['capability-secret-xyz', phone.p256dh, phone.auth, JSON.parse(one<{ value: string }>(t.db, "SELECT value FROM meta WHERE key = 'vapid_jwk'")?.value ?? '{}').d]) {
      assert.ok(secret && !logged.includes(secret), `a secret leaked into the log: ${String(secret).slice(0, 12)}`);
    }
    assert.ok(t.logs.some((l: Json) => l['event'] === 'push.subscription_gone' && l['host'] === 'fcm.googleapis.com' && l['status'] === 410));
  } finally {
    await t.close();
  }
});
