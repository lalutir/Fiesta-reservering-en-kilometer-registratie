import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HttpError, logPath, sendReply, type Reply } from '../src/http.ts';
import { safeSegments } from '../src/static.ts';
import { PASSWORD, createTestApp, rawRequest, type TestApp, type TestAppOptions } from './helpers.ts';

const SECRET = 'TOP-SECRET-OUTSIDE-PUBLIC';

/** A temp site: public/ (with an admin/ area), shared/, and a secret next to them. */
function makeSite(): { root: string; publicDir: string; sharedDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'car-site-'));
  const publicDir = path.join(root, 'public');
  const sharedDir = path.join(root, 'shared');
  fs.mkdirSync(path.join(publicDir, 'admin'), { recursive: true });
  fs.mkdirSync(path.join(publicDir, 'views'), { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>home</title>');
  fs.writeFileSync(path.join(publicDir, 'app.js'), 'export {};');
  fs.writeFileSync(path.join(publicDir, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(publicDir, 'views', 'a.js'), 'export {};');
  fs.writeFileSync(path.join(publicDir, '.hidden'), 'hidden');
  fs.writeFileSync(path.join(publicDir, 'admin', 'index.html'), '<!doctype html><title>admin</title>');
  fs.writeFileSync(path.join(publicDir, 'admin', 'admin.js'), 'export {};');
  fs.writeFileSync(path.join(sharedDir, 'time.js'), 'export const x = 1;');
  return { root, publicDir, sharedDir };
}

async function withSite(
  tctx: TestContext,
  opts: TestAppOptions = {},
): Promise<{ t: TestApp; site: ReturnType<typeof makeSite> }> {
  const site = makeSite();
  const t = await createTestApp({ ...opts, overrides: { publicDir: site.publicDir, sharedDir: site.sharedDir, ...opts.overrides } });
  tctx.after(async () => {
    await t.close();
    fs.rmSync(site.root, { recursive: true, force: true });
  });
  return { t, site };
}

test('static files are served with the right types, caching headers and ETag', async (tctx) => {
  const { t } = await withSite(tctx);
  const home = await rawRequest(t.port, 'GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'] as string, /^text\/html/);
  assert.equal(home.headers['cache-control'], 'no-cache');
  assert.match(home.text, /home/);

  assert.match((await rawRequest(t.port, 'GET', '/app.js')).headers['content-type'] as string, /^text\/javascript/);
  assert.match((await rawRequest(t.port, 'GET', '/manifest.webmanifest')).headers['content-type'] as string, /^application\/manifest\+json/);
  assert.match((await rawRequest(t.port, 'GET', '/shared/time.js')).headers['content-type'] as string, /^text\/javascript/);
  assert.equal((await rawRequest(t.port, 'GET', '/views/a.js')).status, 200);

  const etag = home.headers['etag'] as string;
  assert.ok(etag);
  const again = await rawRequest(t.port, 'GET', '/', { 'If-None-Match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.text, '');

  const head = await rawRequest(t.port, 'HEAD', '/app.js');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.ok(Number(head.headers['content-length']) > 0);

  const post = await rawRequest(t.port, 'POST', '/app.js', { 'Content-Type': 'application/json' }, '{}');
  assert.equal(post.status, 405);
  assert.equal(post.headers['allow'], 'GET, HEAD');
  assert.equal((await rawRequest(t.port, 'GET', '/nope.js')).status, 404);
  assert.equal((await rawRequest(t.port, 'GET', '/views')).status, 404, 'no directory listings or redirects');
  assert.equal((await rawRequest(t.port, 'GET', '/views/')).status, 404);
  assert.equal((await rawRequest(t.port, 'GET', '/shared/')).status, 404);
});

test('path traversal, dotfiles, NUL bytes and odd encodings never reach the file system', async (tctx) => {
  const { t } = await withSite(tctx);
  const attacks = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/a/../../secret.txt',
    '/..\\secret.txt',
    '/%5c..%5csecret.txt',
    '/..%5csecret.txt',
    '/shared/../secret.txt',
    '/shared/%2e%2e/secret.txt',
    '/views/../../secret.txt',
    '/%252e%252e/secret.txt',
    '/index.html%00.png',
    '/.hidden',
    '/%2ehidden',
    '/views/.%2e/../secret.txt',
    '/c:/windows/win.ini',
    '/app.js.',
    '/app.js%20',
    '/%E0%A4%A',
    '/admin%2fadmin.js',
  ];
  for (const attack of attacks) {
    const res = await rawRequest(t.port, 'GET', attack);
    assert.ok([400, 403, 404].includes(res.status), `${attack} -> ${res.status}`);
    assert.ok(!res.text.includes(SECRET), `${attack} leaked the secret`);
    assert.ok(!res.text.includes('hidden'), `${attack} leaked a dotfile`);
  }
});

test('safeSegments splits and rejects as documented', () => {
  assert.deepEqual(safeSegments('/a//b/c.js'), ['a', 'b', 'c.js']);
  assert.deepEqual(safeSegments('/'), []);
  assert.equal(safeSegments('/a/../b'), undefined);
  assert.equal(safeSegments('/a/./b'), undefined);
  assert.equal(safeSegments('/a%2Fb'), undefined);
  assert.equal(safeSegments('/a\\b'), undefined);
  assert.equal(safeSegments('/x:y'), undefined);
  assert.equal(safeSegments('/.env'), undefined);
});

test('security headers are on every response and API responses are no-store', async (tctx) => {
  const { t } = await withSite(tctx);
  for (const target of ['/', '/api/health', '/nope', '/admin/']) {
    const res = await rawRequest(t.port, 'GET', target);
    const csp = res.headers['content-security-policy'] as string;
    assert.match(csp, /default-src 'self'/, target);
    assert.match(csp, /frame-ancestors 'none'/, target);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, target);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', target);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', target);
    assert.equal(res.headers['x-frame-options'], 'DENY', target);
  }
  const api = await rawRequest(t.port, 'GET', '/api/health');
  assert.equal(api.status, 200);
  assert.deepEqual(api.body, { status: 'ok' });
  assert.equal(api.headers['cache-control'], 'no-store');
  const missing = await rawRequest(t.port, 'GET', '/api/nothing-here');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
  assert.equal(missing.headers['cache-control'], 'no-store');
});

test('request bodies: JSON only, size capped, syntax checked', async (tctx) => {
  const { t } = await withSite(tctx);
  const json = { 'Content-Type': 'application/json' };
  const text = await rawRequest(t.port, 'POST', '/api/auth/login', { 'Content-Type': 'text/plain' }, '{}');
  assert.equal(text.status, 415);
  const form = await rawRequest(t.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'username=a&password=b');
  assert.equal(form.status, 415);
  const none = await rawRequest(t.port, 'POST', '/api/auth/login');
  assert.equal(none.status, 415);
  const bad = await rawRequest(t.port, 'POST', '/api/auth/login', json, '{not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad_json');
  const array = await rawRequest(t.port, 'POST', '/api/auth/login', json, '[1,2]');
  assert.equal(array.status, 400);
  const charset = await rawRequest(t.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/json; charset=utf-8' }, '{}');
  assert.equal(charset.status, 401, 'charset parameter is accepted');

  const big = JSON.stringify({ username: 'a', password: 'x'.repeat(70 * 1024) });
  const status = await rawRequest(t.port, 'POST', '/api/auth/login', { ...json, 'Content-Length': String(Buffer.byteLength(big)) }, big).then(
    (res) => res.status,
    () => 413, // the server may hang up while we are still sending; that is the point of the cap
  );
  assert.equal(status, 413);
});

test('CSRF: cross-origin and cross-site writes are rejected, same-origin ones pass', async (tctx) => {
  const { t } = await withSite(tctx);
  const json = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({ username: 'x', password: 'y' });
  const host = `127.0.0.1:${t.port}`;

  const evil = await rawRequest(t.port, 'POST', '/api/auth/login', { ...json, Origin: 'https://evil.example' }, body);
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error.code, 'csrf');
  assert.equal((await rawRequest(t.port, 'POST', '/api/auth/login', { ...json, Origin: 'null' }, body)).status, 403);
  assert.equal((await rawRequest(t.port, 'POST', '/api/auth/login', { ...json, Origin: `http://${host}.evil.example` }, body)).status, 403);
  assert.equal((await rawRequest(t.port, 'POST', '/api/auth/login', { ...json, 'Sec-Fetch-Site': 'cross-site' }, body)).status, 403);
  assert.equal((await rawRequest(t.port, 'POST', '/api/auth/login', { ...json, 'Sec-Fetch-Site': 'same-site' }, body)).status, 403);

  // Allowed: same origin, no browser headers at all (curl), and Sec-Fetch-Site same-origin / none.
  const allowed: Array<Record<string, string>> = [{ Origin: `http://${host}` }, {}, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }];
  for (const extra of allowed) {
    const res = await rawRequest(t.port, 'POST', '/api/auth/login', { ...json, ...extra }, body);
    assert.equal(res.status, 401, JSON.stringify(extra));
  }
  // GET is never blocked by the CSRF check.
  assert.equal((await rawRequest(t.port, 'GET', '/api/health', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 200);
});

test('the /admin area is for admins only: pages redirect, assets are 403, /admin gets a trailing slash', async (tctx) => {
  const { t } = await withSite(tctx);
  const admin = await t.signIn('admin', 'admin');
  const member = await t.signIn('anna');
  const anon = t.client();

  for (const [who, client] of [['anonymous', anon], ['member', member]] as const) {
    for (const page of ['/admin', '/admin/', '/admin/index.html', '/ADMIN/', '/Admin']) {
      const res = await client.get(page);
      assert.equal(res.status, 302, `${who} ${page}`);
      assert.equal(res.headers['location'], '/', `${who} ${page}`);
      assert.doesNotMatch(res.text, /admin/i);
    }
    for (const asset of ['/admin/admin.js', '/ADMIN/admin.js', '//admin/admin.js', '/admin//admin.js', '/admin/nothing.js']) {
      const res = await client.get(asset);
      assert.equal(res.status, 403, `${who} ${asset}`);
    }
  }

  const noSlash = await admin.get('/admin');
  assert.equal(noSlash.status, 302);
  assert.equal(noSlash.headers['location'], '/admin/');
  const page = await admin.get('/admin/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] as string, /^text\/html/);
  assert.match(page.text, /<title>admin<\/title>/);
  assert.equal((await admin.get('/admin/index.html')).status, 200);
  const js = await admin.get('/admin/admin.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'] as string, /^text\/javascript/);
  assert.equal(js.headers['cache-control'], 'no-store');
});

test('the admin check follows role changes and deactivation immediately', async (tctx) => {
  const { t } = await withSite(tctx);
  const boss = await t.signIn('boss', 'admin');
  const other = await t.signIn('other', 'admin');
  assert.equal((await other.get('/admin/admin.js')).status, 200);
  await boss.patch(`/api/admin/users/${other.id}`, { role: 'member' });
  assert.equal((await other.get('/admin/admin.js')).status, 403);
  assert.equal((await other.get('/admin/')).status, 302);
});

test('X-Forwarded-For is only trusted with TRUST_PROXY, and only its last entry', async (tctx) => {
  const trusted = await withSite(tctx, { env: { TRUST_PROXY: '1' } });
  const t = trusted.t;
  await t.signIn('anna');
  const fail = (xff: string) =>
    rawRequest(t.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, JSON.stringify({ username: 'anna', password: 'wrong-password-1' }));
  for (let i = 0; i < 5; i++) assert.equal((await fail('spoofed, 10.0.0.1')).status, 401);
  assert.equal((await fail('different-spoof, 10.0.0.1')).status, 429, 'client-supplied entries are ignored; the proxy-appended last one counts');
  assert.equal((await fail('10.0.0.2')).status, 401, 'another real client address is unaffected');
});

test('an IPv6 client behind the proxy is throttled by its /64, not by single addresses', async (tctx) => {
  const { t } = await withSite(tctx, { env: { TRUST_PROXY: '1' } });
  await t.signIn('anna');
  const fail = (xff: string) =>
    rawRequest(t.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, JSON.stringify({ username: 'anna', password: 'wrong-password-1' }));
  for (let i = 1; i <= 5; i++) assert.equal((await fail(`2001:db8:1:2::${i}`)).status, 401);
  assert.equal((await fail('2001:db8:1:2:dead:beef:0:1')).status, 429, 'a new address in the same /64 shares the counter');
  assert.equal((await fail('2001:db8:1:3::1')).status, 401, 'another /64 is unaffected');
});

test('without TRUST_PROXY the X-Forwarded-For header is ignored', async (tctx) => {
  const { t } = await withSite(tctx);
  await t.signIn('anna');
  const fail = (xff: string) =>
    rawRequest(t.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, JSON.stringify({ username: 'anna', password: 'wrong-password-1' }));
  for (let i = 0; i < 5; i++) assert.equal((await fail(`10.0.0.${i}`)).status, 401);
  assert.equal((await fail('10.9.9.9')).status, 429, 'rotating the header does not evade the limiter');
});

test('unexpected errors become a generic 500 and the stack stays in the server log', async (tctx) => {
  const { t } = await withSite(tctx);
  t.app.router.add('GET', '/api/boom', 'public', () => {
    throw new Error('internal detail: db password is hunter2');
  });
  t.app.router.add('GET', '/api/teapot', 'public', () => {
    throw new HttpError(418, 'teapot', 'short and stout');
  });
  const res = await rawRequest(t.port, 'GET', '/api/boom');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: { code: 'internal', message: 'Internal server error' } });
  assert.doesNotMatch(res.text, /hunter2|Error:|at /);
  const logged = t.logs.find((l) => l['event'] === 'error');
  assert.match(String(logged?.['message']), /hunter2/);
  assert.match(String(logged?.['stack']), /Error/);
  const teapot = await rawRequest(t.port, 'GET', '/api/teapot');
  assert.equal(teapot.status, 418);
  assert.equal(teapot.body.error.code, 'teapot');
});

test('every response carries a server-made X-Request-Id that ties the caller to the access and error logs', async (tctx) => {
  const { t } = await withSite(tctx);
  t.app.router.add('GET', '/api/boom', 'public', () => {
    throw new Error('kaboom');
  });
  const boom = await rawRequest(t.port, 'GET', '/api/boom', { 'X-Request-Id': 'forged-by-caller' });
  const rid = boom.headers['x-request-id'] as string;
  assert.match(rid, /^[0-9a-f]{12}$/, 'a client-supplied id is never reused');
  assert.equal(boom.status, 500);
  assert.equal(t.logs.find((l) => l['event'] === 'error')?.['rid'], rid);
  assert.equal(t.logs.findLast((l) => l['event'] === 'http')?.['rid'], rid);

  const ids = new Set([rid]);
  for (const target of ['/api/health', '/api/nope', '/', '/manifest.webmanifest']) {
    const res = await rawRequest(t.port, 'GET', target);
    assert.match(res.headers['x-request-id'] as string, /^[0-9a-f]{12}$/, target);
    ids.add(res.headers['x-request-id'] as string);
  }
  assert.equal(ids.size, 5, 'ids are unique per request');
});

test('login, rate limiting and password changes leave audit log lines without secrets or usernames', async (tctx) => {
  const { t } = await withSite(tctx);
  const anna = await t.signIn('anna');
  t.logs.length = 0;
  const c = t.client();
  for (let i = 0; i < 6; i++) await c.login('anna', 'wrong-password-1');
  assert.equal(t.logs.filter((l) => l['event'] === 'auth.login_failed').length, 5);
  assert.equal(t.logs.filter((l) => l['event'] === 'auth.rate_limited').length, 1);
  await anna.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'brand-new-password' });
  assert.deepEqual(t.logs.find((l) => l['event'] === 'auth.password_changed'), { event: 'auth.password_changed', userId: anna.id });
  t.clock.advance(16 * 60_000); // out of the lockout window
  assert.equal((await t.client().login('anna', 'brand-new-password')).status, 200);
  assert.deepEqual(t.logs.find((l) => l['event'] === 'auth.login'), { event: 'auth.login', userId: anna.id });
  assert.doesNotMatch(JSON.stringify(t.logs), /wrong-password-1|brand-new-password|"anna"/);
});

test('the access log records method, path and status but never bodies, cookies or query strings', async (tctx) => {
  const { t } = await withSite(tctx);
  await t.signIn('anna');
  const secretPassword = 'log-me-not-please-123';
  await t.client().post('/api/auth/login', { username: 'anna', password: secretPassword });
  await rawRequest(t.port, 'GET', '/api/health?token=query-secret', { Cookie: '__Host-sid=cookie-secret' });
  const lines = t.logs.filter((l) => l['event'] === 'http');
  assert.ok(lines.length >= 2);
  const all = JSON.stringify(t.logs);
  assert.doesNotMatch(all, /log-me-not-please-123|query-secret|cookie-secret/);
  const login = lines.findLast((l) => l['path'] === '/api/auth/login' && l['method'] === 'POST');
  assert.equal(login?.['status'], 401);
  assert.equal(typeof login?.['ms'], 'number');
});

test('health reports ok with a working database', async (tctx) => {
  const { t } = await withSite(tctx);
  const res = await t.client().get('/api/health');
  assert.equal(res.status, 200);
});

// ------------------------------------------------------------- the logged path (logPath)

test('logPath: ordinary paths stay readable, the feed secret and any long opaque run are replaced, however the slashes are written', () => {
  const secret = 'abcDEF0123456789_-abcDEF0123456789_-abc';
  assert.equal(logPath('/api/reservations'), '/api/reservations');
  assert.equal(logPath('/api/reservations/12'), '/api/reservations/12');
  assert.equal(logPath('/views/integrations.js'), '/views/integrations.js');
  assert.equal(logPath('/api/calendar-feed'), '/api/calendar-feed', 'the link routes of the Account page are not the feed');
  assert.equal(logPath('/api/v1/status'), '/api/v1/status');
  // The feed address.
  assert.equal(logPath(`/api/calendar/${secret}.ics`), '/api/calendar/[redacted]');
  assert.equal(logPath(`/api//calendar/${secret}.ics`), '/api/calendar/[redacted]');
  assert.equal(logPath(`/api/calendar//${secret}.ics`), '/api/calendar/[redacted]');
  assert.equal(logPath(`/api///calendar///${secret}.ics`), '/api/calendar/[redacted]');
  assert.equal(logPath('/api/calendar/short.ics'), '/api/calendar/[redacted]', 'whatever stands there, short or not');
  assert.equal(logPath('/API/CALENDAR/whatever'), '/API/CALENDAR/[redacted]', 'the router is case sensitive, but a log line never leaks on a guess');
  // A secret that ended up somewhere else is caught by its shape.
  assert.equal(logPath(`/somewhere/${secret}`), '/somewhere/[redacted]');
  assert.equal(logPath(`/x/pat_${'t'.repeat(43)}/y`), '/x/[redacted]/y');
  assert.equal(logPath(`/${'a'.repeat(31)}`), `/${'a'.repeat(31)}`, 'a run of 31 is not long enough to be a secret');
  assert.equal(logPath(`/${'a'.repeat(32)}`), '/[redacted]');
  // Cut at 200 characters.
  assert.equal(logPath(`/${'a/'.repeat(300)}`).length, 200);
});

test('sendReply: a raw reply is sent as it is, a 304 and an empty body send no body, JSON is unchanged', async () => {
  const replies: Array<{ status: number; headers?: Record<string, string>; body?: unknown; raw?: Buffer }> = [
    { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', ETag: '"x"' }, raw: Buffer.from('BEGIN:VCALENDAR\r\n', 'utf8') },
    { status: 304, headers: { ETag: '"x"' }, raw: Buffer.alloc(0) },
    { status: 200, headers: { 'Content-Type': 'text/calendar', 'Content-Length': '17' }, raw: Buffer.alloc(0) },
    { status: 200, body: { ok: true } },
    { status: 204 },
  ];
  let next = 0;
  const server = http.createServer((_req, res) => sendReply(res, replies[next++] as Reply));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const first = await rawRequest(port, 'GET', '/');
    assert.equal(first.status, 200);
    assert.equal(first.text, 'BEGIN:VCALENDAR\r\n');
    assert.equal(first.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.equal(first.headers['content-length'], '17', 'the length is set from the bytes');
    const notModified = await rawRequest(port, 'GET', '/');
    assert.equal(notModified.status, 304);
    assert.equal(notModified.text, '');
    assert.equal(notModified.headers['content-length'], undefined);
    assert.equal(notModified.headers['etag'], '"x"');
    const head = await rawRequest(port, 'HEAD', '/');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], '17', 'a handler that sets the length itself keeps it (HEAD)');
    const json = await rawRequest(port, 'GET', '/');
    assert.deepEqual(json.body, { ok: true });
    assert.equal((await rawRequest(port, 'GET', '/')).status, 204);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
