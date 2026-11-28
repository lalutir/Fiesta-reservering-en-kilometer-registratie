import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, parseHash, verifyPassword, LoginLimiter, throttleAddress } from '../src/auth.ts';
import { one } from '../src/db.ts';
import { PASSWORD, createTestApp, rawRequest } from './helpers.ts';

// The calendar feed is the one deliberate addition: its address is its credential (src/calendar.ts), and it is a GET and a HEAD.
const PUBLIC_ROUTES = ['GET /api/health', 'POST /api/auth/login', 'GET /api/calendar/:file', 'HEAD /api/calendar/:file'];

test('every API route except health and login answers 401 to anonymous callers', async () => {
  const t = await createTestApp();
  try {
    const anon = t.client();
    const routes = t.app.router.routes;
    const open = routes.filter((r) => r.auth === 'public').map((r) => `${r.method} ${r.pattern}`);
    assert.deepEqual(open.sort(), [...PUBLIC_ROUTES].sort());
    for (const route of routes) {
      if (PUBLIC_ROUTES.includes(`${route.method} ${route.pattern}`)) continue;
      const target = route.pattern.replace(/:\w+/g, '1');
      const res = await anon.request(route.method, target, route.method === 'GET' ? undefined : {});
      assert.equal(res.status, 401, `${route.method} ${route.pattern} should be 401 but was ${res.status}`);
    }
  } finally {
    await t.close();
  }
});

test('unknown API paths are 404 and there is no public registration endpoint', async () => {
  const t = await createTestApp();
  try {
    const anon = t.client();
    for (const target of ['/api/register', '/api/signup', '/api/auth/register', '/api/auth/signup', '/api/users']) {
      const res = await anon.post(target, { username: 'mallory', password: PASSWORD, displayName: 'M' });
      assert.ok(res.status === 404 || res.status === 401, `${target} -> ${res.status}`);
    }
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM users')?.n, 0);
    assert.equal(t.app.router.routes.some((r) => /regist|signup/i.test(r.pattern)), false);
  } finally {
    await t.close();
  }
});

test('a wrong login gives one generic 401 for wrong password, unknown user and deactivated user', async () => {
  const t = await createTestApp();
  try {
    const admin = await t.signIn('admin', 'admin');
    await t.signIn('anna');
    const created = await admin.post('/api/admin/users', { username: 'dora', displayName: 'Dora', password: PASSWORD });
    assert.equal(created.status, 201);
    await admin.patch(`/api/admin/users/${created.body.user.id}`, { active: false });

    const attempts = [
      { username: 'anna', password: 'definitely-wrong-password' },
      { username: 'nobody', password: PASSWORD },
      { username: 'dora', password: PASSWORD },
      { username: 'anna' },
      { username: 'anna', password: 'x'.repeat(201) },
    ];
    const bodies = new Set<string>();
    for (const a of attempts) {
      const res = await t.client().post('/api/auth/login', a);
      assert.equal(res.status, 401, JSON.stringify(a));
      assert.equal(res.headers['set-cookie'], undefined);
      bodies.add(res.text);
    }
    assert.equal(bodies.size, 1, 'all failures must look identical');
    assert.equal(JSON.parse([...bodies][0] as string).error.code, 'invalid_credentials');
  } finally {
    await t.close();
  }
});

test('login sets a __Host- session cookie that is HttpOnly, Secure and SameSite', async () => {
  const t = await createTestApp();
  try {
    await t.signIn('anna');
    const res = await t.client().login('anna');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'anna');
    assert.equal(res.body.timeZone, 'Europe/Amsterdam');
    assert.equal(res.body.user.passwordHash, undefined);
    const cookie = (res.headers['set-cookie'] as string[])[0] as string;
    assert.match(cookie, /^__Host-sid=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Max-Age=2592000/);
    assert.doesNotMatch(cookie, /Domain=/i);
  } finally {
    await t.close();
  }
});

test('COOKIE_SECURE=false (local dev) uses a plain cookie name without Secure', async () => {
  const t = await createTestApp({ env: { COOKIE_SECURE: 'false' } });
  try {
    await t.signIn('anna');
    const res = await t.client().login('anna');
    const cookie = (res.headers['set-cookie'] as string[])[0] as string;
    assert.match(cookie, /^sid=/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
  } finally {
    await t.close();
  }
});

test('passwords are stored as scrypt hashes and sessions only as sha256 digests', async () => {
  const t = await createTestApp();
  try {
    const anna = await t.signIn('anna');
    const row = one<{ password_hash: string }>(t.db, "SELECT password_hash FROM users WHERE username = 'anna'");
    assert.match(row?.password_hash ?? '', /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.ok(!row?.password_hash.includes(PASSWORD));
    const token = anna.cookies.get('__Host-sid') as string;
    const stored = one<{ token_hash: string }>(t.db, 'SELECT token_hash FROM sessions');
    assert.equal(stored?.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.notEqual(stored?.token_hash, token);
  } finally {
    await t.close();
  }
});

test('hashPassword round-trips, salts each hash, and works with the production parameters', async () => {
  const prod = { N: 2 ** 15, r: 8, p: 3 };
  const a = await hashPassword('a long enough password', prod);
  const b = await hashPassword('a long enough password', prod);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$32768$8$3$'));
  assert.equal(await verifyPassword('a long enough password', a), true);
  assert.equal(await verifyPassword('another password!!', a), false);
});

test('parseHash rejects malformed hashes and absurd cost parameters', () => {
  assert.equal(parseHash('nonsense'), undefined);
  assert.equal(parseHash('bcrypt$1$2$3$AAAAAAAAAAAA$AAAA'), undefined);
  assert.equal(parseHash(`scrypt$${2 ** 20}$8$1$${'A'.repeat(24)}$${Buffer.alloc(32).toString('base64')}`), undefined);
  assert.equal(parseHash(`scrypt$1000$8$1$${'A'.repeat(24)}$${Buffer.alloc(32).toString('base64')}`), undefined);
  assert.ok(parseHash(`scrypt$1024$8$1$${'A'.repeat(24)}$${Buffer.alloc(32).toString('base64')}`));
});

test('login is rate limited per ip+username and recovers after the window', async () => {
  const t = await createTestApp();
  try {
    await t.signIn('anna');
    const c = t.client();
    for (let i = 0; i < 5; i++) {
      assert.equal((await c.login('anna', 'wrong-password-1')).status, 401);
    }
    const blocked = await c.login('anna', 'wrong-password-1');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'too_many_attempts');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    // Even the right password is refused while locked out, and no hashing is spent on it.
    assert.equal((await c.login('anna')).status, 429);
    // Another username from the same address is still allowed.
    assert.equal((await c.login('someone-else')).status, 401);

    t.clock.advance(16 * 60_000);
    assert.equal((await c.login('anna')).status, 200);
  } finally {
    await t.close();
  }
});

test('a burst of parallel wrong guesses is counted as it arrives, not after each hash finishes', async () => {
  // A slower hash keeps every request in flight while the others are checked.
  const t = await createTestApp({ env: { SCRYPT_N: '16384' } });
  try {
    await t.signIn('anna');
    const burst = await Promise.all(Array.from({ length: 12 }, () => t.client().login('anna', 'wrong-password-1')));
    const statuses = burst.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 5, `statuses: ${statuses.join(',')}`);
    assert.equal(statuses.filter((s) => s === 429).length, 7, `statuses: ${statuses.join(',')}`);
    assert.equal((await t.client().login('anna')).status, 429, 'locked out, even with the right password');
  } finally {
    await t.close();
  }
});

test('the same holds for guesses at the current password on the change-password route', async () => {
  const t = await createTestApp({ env: { SCRYPT_N: '16384' } });
  try {
    const anna = await t.signIn('anna');
    const burst = await Promise.all(
      Array.from({ length: 10 }, () =>
        anna.post('/api/auth/password', { currentPassword: 'wrong-password-1', newPassword: 'brand-new-password' }),
      ),
    );
    const statuses = burst.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 422).length, 5, `statuses: ${statuses.join(',')}`);
    assert.equal(statuses.filter((s) => s === 429).length, 5, `statuses: ${statuses.join(',')}`);
  } finally {
    await t.close();
  }
});

test('a good login does not use up the per-ip allowance, and does not wipe earlier failures', async () => {
  const t = await createTestApp();
  try {
    await t.signIn('anna');
    for (let i = 0; i < 40; i++) assert.equal((await t.client().login('anna')).status, 200, `login ${i}`);
    const c = t.client();
    for (let i = 0; i < 4; i++) assert.equal((await c.login('anna', 'wrong-password-1')).status, 401);
    assert.equal((await c.login('anna')).status, 200);
    // The success cleared the anna counter; the four earlier failures still count towards the ip.
    const ip = '127.0.0.1';
    assert.equal(t.ctx.limiter.check(ip, 'anna', t.clock.now().getTime()), 0);
    assert.equal(t.ctx.limiter.check(ip, 'other', t.clock.now().getTime()), 0);
    for (let i = 0; i < 26; i++) t.ctx.limiter.fail(ip, `x${i}`, t.clock.now().getTime());
    assert.ok(t.ctx.limiter.check(ip, 'other', t.clock.now().getTime()) > 0, '4 + 26 failures reach the ip cap of 30');
  } finally {
    await t.close();
  }
});

test('LoginLimiter: per-ip cap and success reset, on an injected clock', () => {
  const l = new LoginLimiter();
  let now = 1_000_000;
  for (let i = 0; i < 30; i++) l.fail('1.2.3.4', `user${i}`, now);
  assert.ok(l.check('1.2.3.4', 'fresh', now) > 0, 'ip with 30 failures is blocked for any username');
  assert.equal(l.check('5.6.7.8', 'fresh', now), 0);
  now += 15 * 60_000 + 1;
  assert.equal(l.check('1.2.3.4', 'fresh', now), 0);

  for (let i = 0; i < 4; i++) l.fail('9.9.9.9', 'anna', now);
  l.reset('9.9.9.9', 'anna');
  l.fail('9.9.9.9', 'anna', now);
  assert.equal(l.check('9.9.9.9', 'anna', now), 0);
});

test('throttleAddress keys IPv6 by /64 and leaves IPv4 and other strings alone', () => {
  assert.equal(throttleAddress('1.2.3.4'), '1.2.3.4');
  assert.equal(throttleAddress('unknown'), 'unknown');
  assert.equal(throttleAddress('::ffff:10.0.0.1'), '10.0.0.1', 'IPv4-mapped is the IPv4 address');
  assert.equal(throttleAddress('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  // Every spelling of an address inside one /64 gives the same key.
  const key = throttleAddress('2001:db8:1:2::1');
  for (const same of ['2001:DB8:0001:0002:0:0:0:9', '2001:db8:1:2:abcd:ef01:2345:6789', '2001:db8:1:2::', 'fe80::1']) {
    assert.equal(throttleAddress(same) === key, same !== 'fe80::1', same);
  }
  assert.notEqual(throttleAddress('2001:db8:1:3::1'), key, 'a neighbouring /64 is a different client');
  assert.equal(throttleAddress('fe80::1%eth0'), throttleAddress('fe80::2'), 'a zone id is dropped');
  assert.equal(throttleAddress('::1'), '0:0:0:0::/64');
  assert.equal(throttleAddress('::'), '0:0:0:0::/64');
  assert.equal(throttleAddress('1:2:3:4:5:6:7:8'), '1:2:3:4::/64');
  assert.equal(throttleAddress(throttleAddress('2001:db8:1:2::1')), key, 'already collapsed keys map to themselves');
});

test('LoginLimiter: rotating the low bits of an IPv6 address does not evade the limit', () => {
  const l = new LoginLimiter();
  const now = 1_000_000;
  for (let i = 1; i <= 5; i++) l.fail(`2001:db8:1:2::${i}`, 'anna', now);
  assert.ok(l.check('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 'anna', now) > 0, 'a fresh address in the same /64 is still blocked');
  assert.equal(l.check('2001:db8:1:3::1', 'anna', now), 0, 'another /64 is unaffected');
  assert.equal(l.check('::ffff:9.9.9.9', 'anna', now), 0);

  // The reserved attempt of a successful login is given back to the same /64 slot.
  assert.equal(l.attempt('2001:db8:9:9::1', 'ben', now), 0);
  l.succeed('2001:db8:9:9::2', 'ben', now);
  for (let i = 0; i < 29; i++) l.fail(`2001:db8:9:9::${i + 10}`, `u${i}`, now);
  assert.equal(l.check('2001:db8:9:9::ffff', 'other', now), 0, '29 failures: the slot given back by succeed() is free');
  l.fail('2001:db8:9:9::ffff', 'last', now);
  assert.ok(l.check('2001:db8:9:9::1234', 'other', now) > 0, 'the 30th failure from the /64 reaches the cap');
});

test('logout ends the session, and sessions expire after 30 days', async () => {
  const t = await createTestApp();
  try {
    const anna = await t.signIn('anna');
    assert.equal((await anna.get('/api/auth/me')).status, 200);
    const out = await anna.post('/api/auth/logout');
    assert.equal(out.status, 204);
    assert.match((out.headers['set-cookie'] as string[])[0] as string, /Max-Age=0/);
    assert.equal((await anna.get('/api/auth/me')).status, 401);

    const ben = await t.signIn('ben');
    assert.equal((await ben.get('/api/auth/me')).status, 200);
    t.clock.advance(31 * 24 * 3600_000);
    assert.equal((await ben.get('/api/auth/me')).status, 401);
  } finally {
    await t.close();
  }
});

test('an active session is extended at most once a day and re-issues the cookie', async () => {
  const t = await createTestApp();
  try {
    const anna = await t.signIn('anna');
    const same = await anna.get('/api/auth/me');
    assert.equal(same.headers['set-cookie'], undefined);
    t.clock.advance(25 * 3600_000);
    const later = await anna.get('/api/auth/me');
    assert.equal(later.status, 200);
    assert.match((later.headers['set-cookie'] as string[])[0] as string, /^__Host-sid=/);
    const row = one<{ expires_at: string }>(t.db, 'SELECT expires_at FROM sessions');
    assert.equal(row?.expires_at, new Date(t.clock.now().getTime() + 30 * 24 * 3600_000).toISOString());
  } finally {
    await t.close();
  }
});

test('a garbage or forged session cookie is just unauthenticated', async () => {
  const t = await createTestApp();
  try {
    await t.signIn('anna');
    for (const cookie of ['__Host-sid=abc', `__Host-sid=${'A'.repeat(43)}`, '__Host-sid=', 'other=1']) {
      const res = await rawRequest(t.port, 'GET', '/api/auth/me', { Cookie: cookie });
      assert.equal(res.status, 401, cookie);
    }
  } finally {
    await t.close();
  }
});

test('changing the password signs out other sessions and needs the current password', async () => {
  const t = await createTestApp();
  try {
    const first = await t.signIn('anna');
    const second = t.client();
    await second.login('anna');
    const wrong = await first.post('/api/auth/password', { currentPassword: 'not-my-password', newPassword: 'brand-new-password' });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error.fields.currentPassword, 'incorrect');
    const short = await first.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'short' });
    assert.equal(short.status, 422);
    const done = await first.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'brand-new-password' });
    assert.equal(done.status, 204);
    assert.equal((await first.get('/api/auth/me')).status, 200);
    assert.equal((await second.get('/api/auth/me')).status, 401);
    assert.equal((await t.client().login('anna')).status, 401);
    assert.equal((await t.client().login('anna', 'brand-new-password')).status, 200);
  } finally {
    await t.close();
  }
});
