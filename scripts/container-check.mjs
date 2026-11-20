// Health, sign-in and a few API calls against an app that is ALREADY running (the CI Docker job
// uses it on the container started from docker-compose.yml). No dependencies.
//   ADMIN_USERNAME=admin ADMIN_PASSWORD=... node scripts/container-check.mjs http://127.0.0.1:3000
// It sends no Origin and no X-Forwarded-For header, like any non-browser client. It writes one
// reservation (a day from now) to the database it talks to, so only point it at a throw-away one.
const base = (process.argv[2] ?? '').replace(/\/$/, '');
const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = process.env;
if (!/^https?:\/\//.test(base) || !username || !password) {
  console.error('Usage: ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/container-check.mjs http://host:port');
  process.exit(2);
}

const failures = [];
async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  ok   ${name}${note ? ` (${note})` : ''}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) });
const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify(body) });

console.log(`Checking ${base}`);
await check('GET /api/health reports ok', async () => {
  const res = await fetch(`${base}/api/health`);
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.json()).status === 'ok', 'body is not {status: "ok"}');
});
await check('GET / is the HTML app shell and /shared/time.js is JavaScript', async () => {
  const page = await fetch(`${base}/`);
  expect(page.status === 200 && (page.headers.get('content-type') ?? '').startsWith('text/html'), `/ gave ${page.status} ${page.headers.get('content-type')}`);
  const shared = await fetch(`${base}/shared/time.js`);
  expect(shared.status === 200 && (shared.headers.get('content-type') ?? '').startsWith('text/javascript'), `time.js gave ${shared.status} ${shared.headers.get('content-type')}`);
});
await check('anonymous calls: API is 401, /admin redirects away', async () => {
  const api = await fetch(`${base}/api/reservations`);
  expect(api.status === 401, `/api/reservations gave ${api.status}`);
  const admin = await fetch(`${base}/admin`, { redirect: 'manual' });
  expect(admin.status === 302, `/admin gave ${admin.status}`);
});
let cookie = '';
await check('a wrong password is refused, the right one signs in with an HttpOnly cookie', async () => {
  const bad = await post('/api/auth/login', { username, password: `${password}-wrong` });
  expect(bad.status === 401, `wrong password gave ${bad.status}`);
  const started = Date.now();
  const res = await post('/api/auth/login', { username, password });
  const took = Date.now() - started;
  expect(res.status === 200, `login gave ${res.status}`);
  const setCookie = res.headers.getSetCookie()[0] ?? '';
  expect(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), 'the session cookie lacks HttpOnly or SameSite=Lax');
  cookie = setCookie.split(';')[0] ?? '';
  return `login took ${took} ms`;
});
await check('GET /api/auth/me says who is signed in', async () => {
  const res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
  expect(res.status === 200, `status ${res.status}`);
  const me = (await res.json()).user;
  expect(me.role === 'admin' && me.username === username, `user ${JSON.stringify(me)}`);
});
await check('a reservation is created (201) and the same slot is refused (409)', async () => {
  const body = { start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 2 * 86_400_000).toISOString(), note: 'container check' };
  const made = await post('/api/reservations', body, cookie);
  expect(made.status === 201, `create gave ${made.status}`);
  const clash = await post('/api/reservations', body, cookie);
  expect(clash.status === 409, `the same slot gave ${clash.status}`);
});

if (failures.length > 0) {
  console.log(`\nContainer check FAILED: ${failures.join('; ')}`);
  // Set the exit code and let the process end; do not call exit here. fetch may still be closing its
  // sockets, and on Windows Node then aborts with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
  // and a crash code instead of 1 (test/ci.test.ts pins this).
  process.exitCode = 1;
} else {
  console.log('\nContainer check passed.');
}
