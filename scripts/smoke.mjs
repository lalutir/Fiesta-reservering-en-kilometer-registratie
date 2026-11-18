// Build the project, start the BUILT server (dist/src/server.js, the same layout
// the Docker image uses) on a free port with a throw-away data directory, and
// check the basics over real HTTP. This is what catches "works in dev, breaks in
// the image" problems such as the public/ and shared/ directories not being found.
//   npm run smoke
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { username: 'smoke', password: 'smoke-test-password-1' };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const failures = [];
let checks = 0;
async function check(name, fn) {
  checks++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('Building...');
execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-smoke-'));
const env = { ...process.env };
// public/ and shared/ must be found from dist/src without any override. The push and payment
// settings are cleared too: the smoke test must never send anything to a push service or to Tikkie.
for (const key of [
  'PUBLIC_DIR',
  'SHARED_DIR',
  'TRUST_PROXY',
  'HOUSEHOLD_TZ',
  'BACKUP_KEEP_DAYS',
  'SCRYPT_R',
  'DOMAIN',
  'PUSH_CONTACT',
  'PUSH_ENABLED',
  'TIKKIE_PAYMENT_REQUEST_URL',
  'TIKKIE_API_KEY',
  'TIKKIE_ACCESS_TOKEN',
]) {
  delete env[key];
}
Object.assign(env, {
  PORT: String(port),
  BIND_HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  COOKIE_SECURE: 'false',
  ADMIN_USERNAME: ADMIN.username,
  ADMIN_PASSWORD: ADMIN.password,
  SCRYPT_N: '1024',
  SCRYPT_P: '1',
});

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join('dist', 'src', 'server.js')], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
let exited = false;
const exitPromise = new Promise((resolve) =>
  child.on('exit', (code) => {
    exited = true;
    resolve(code);
  }),
);

const base = `http://127.0.0.1:${port}`;

async function waitUntilUp() {
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error(`server exited early:\n${output}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${output}`);
}

try {
  console.log(`Starting dist/src/server.js on port ${port}...`);
  await waitUntilUp();

  await check('GET /api/health is ok', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status === 200, `status ${res.status}`);
    expect((await res.json()).status === 'ok', 'body');
  });
  await check('GET / serves the app shell from public/', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status === 200, `status ${res.status}`);
    expect((res.headers.get('content-type') ?? '').startsWith('text/html'), 'content-type');
    const html = await res.text();
    expect(html.includes('rel="manifest"') && html.includes('/app.js'), 'index.html content');
  });
  await check('GET /shared/time.js serves the shared time module', async () => {
    const res = await fetch(`${base}/shared/time.js`);
    expect(res.status === 200, `status ${res.status}`);
    expect((res.headers.get('content-type') ?? '').startsWith('text/javascript'), 'content-type');
    expect((await res.text()).includes('addCalendarMonths'), 'content');
  });
  await check('manifest, service worker and icons are served', async () => {
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status === 200 && (await manifest.json()).display === 'standalone', 'manifest');
    expect((await fetch(`${base}/sw.js`)).status === 200, 'sw.js');
    const icon = await fetch(`${base}/icons/icon-192.png`);
    expect(icon.status === 200 && icon.headers.get('content-type') === 'image/png', 'icon');
  });
  await check('anonymous /admin redirects to / and its assets are forbidden', async () => {
    const page = await fetch(`${base}/admin`, { redirect: 'manual' });
    expect(page.status === 302 && page.headers.get('location') === '/', `page ${page.status} ${page.headers.get('location')}`);
    const asset = await fetch(`${base}/admin/admin.js`, { redirect: 'manual' });
    expect(asset.status === 403, `asset ${asset.status}`);
  });
  await check('anonymous API call is 401', async () => {
    expect((await fetch(`${base}/api/reservations`)).status === 401, 'status');
  });

  let cookie = '';
  await check('login round trip (bootstrap admin from env)', async () => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN.username, password: 'definitely-wrong-password' }),
    });
    expect(bad.status === 401, `wrong password gave ${bad.status}`);
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    expect(res.status === 200, `login ${res.status}`);
    const setCookie = res.headers.getSetCookie()[0] ?? '';
    expect(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), `cookie flags: ${setCookie}`);
    cookie = setCookie.split(';')[0];
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status === 200 && (await me.json()).user.role === 'admin', 'me');
  });
  await check('signed-in admin reaches /admin/ and a reservation round trip works', async () => {
    const noSlash = await fetch(`${base}/admin`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(noSlash.status === 302 && noSlash.headers.get('location') === '/admin/', 'redirect to /admin/');
    const page = await fetch(`${base}/admin/`, { headers: { Cookie: cookie } });
    expect(page.status === 200, `admin page ${page.status}`);
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const made = await fetch(`${base}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ start, end }),
    });
    expect(made.status === 201, `create ${made.status}`);
    const clash = await fetch(`${base}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ start, end }),
    });
    expect(clash.status === 409, `overlap ${clash.status}`);
  });
  await check('reminders: the key endpoint needs a login and reports push as off without a configured address', async () => {
    expect((await fetch(`${base}/api/push/key`)).status === 401, 'anonymous');
    const res = await fetch(`${base}/api/push/key`, { headers: { Cookie: cookie } });
    expect(res.status === 200, `status ${res.status}`);
    expect((await res.json()).enabled === false, 'push should be off here');
  });
  await check('startup log says why reminders are off when no https address is configured', async () => {
    expect(output.includes('"event":"server.warning"') && output.includes('Reminders are off'), 'no "Reminders are off" warning in the startup log');
    expect(!output.includes('mailto:') && !output.includes('BEGIN'), 'the warning must not echo any address or key');
  });
  await check('a drive can be started as a draft and shows up as km to register, then finishes', async () => {
    const json = { 'Content-Type': 'application/json', Cookie: cookie };
    const started = await fetch(`${base}/api/usage`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ status: 'draft', start: new Date().toISOString(), odometerStart: 1000 }),
    });
    expect(started.status === 201, `draft ${started.status}`);
    const draft = (await started.json()).usage;
    expect(draft.status === 'draft' && draft.end === null, 'draft shape');
    const pending = await (await fetch(`${base}/api/usage/pending`, { headers: { Cookie: cookie } })).json();
    expect(pending.count === 1, `pending count ${pending.count}`);
    const finished = await fetch(`${base}/api/usage/${draft.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 'completed', end: new Date().toISOString(), odometerEnd: 1042 }),
    });
    expect(finished.status === 200, `finish ${finished.status}`);
    expect((await finished.json()).usage.distanceKm === 42, 'distance');
    const after = await (await fetch(`${base}/api/usage/pending`, { headers: { Cookie: cookie } })).json();
    expect(after.count === 0, `pending count after finishing ${after.count}`);
  });
} catch (err) {
  failures.push('startup');
  console.log(`  FAIL startup: ${err instanceof Error ? err.message : err}`);
} finally {
  child.kill();
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

if (failures.length > 0) {
  console.log(`\nSmoke test FAILED (${failures.length} of ${checks} checks): ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\nSmoke test passed (${checks} checks).`);
