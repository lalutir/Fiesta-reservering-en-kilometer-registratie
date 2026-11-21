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
  await check('kilometres for another person need a note, the fuel share follows them (the admin pays none), and the debtor can say "I have paid"', async () => {
    const json = { 'Content-Type': 'application/json', Cookie: cookie };
    const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
    const password = 'smoke-ben-password-1';
    const made = await fetch(`${base}/api/admin/users`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'smokeben', displayName: 'Ben', password }) });
    expect(made.status === 201, `create user ${made.status}`);
    const ben = (await made.json()).user;

    const drive = (start, end, odometerStart, odometerEnd, extra = {}) =>
      fetch(`${base}/api/usage`, { method: 'POST', headers: json, body: JSON.stringify({ start: hoursAgo(start), end: hoursAgo(end), odometerStart, odometerEnd, ...extra }) });
    expect((await drive(10, 9, 2000, 2100)).status === 201, 'the admin\'s own drive');
    const noNote = await drive(8, 7, 2100, 2150, { kmFor: 'person', kmUserId: ben.id });
    expect(noNote.status === 422 && (await noNote.json()).error.fields.note === 'required', `a drive for somebody else without a note gave ${noNote.status}`);
    const forBen = await drive(8, 7, 2100, 2150, { kmFor: 'person', kmUserId: ben.id, note: 'Took Ben to the station' });
    expect(forBen.status === 201, `the drive for Ben ${forBen.status}`);
    expect((await forBen.json()).usage.kmUserName === 'Ben', 'the answer names whose kilometres they are');

    const summary = await (await fetch(`${base}/api/usage/summary`, { headers: { Cookie: cookie } })).json();
    const bens = summary.items.find((i) => i.userId === ben.id);
    expect(bens?.km === 50 && summary.together.km === 0, `summary: Ben ${bens?.km}, together ${summary.together?.km}`);

    const fuel = await fetch(`${base}/api/fuel`, { method: 'POST', headers: json, body: JSON.stringify({ at: hoursAgo(1), millilitres: 40000, totalCents: 6000, odometer: 2150 }) });
    expect(fuel.status === 201, `fill-up ${fuel.status}`);
    const fuelId = (await fuel.json()).fuel.id;

    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smokeben', password }) });
    expect(login.status === 200, `Ben signs in ${login.status}`);
    const benCookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0];
    const listed = await (await fetch(`${base}/api/fuel`, { headers: { Cookie: benCookie } })).json();
    const share = listed.items.find((f) => f.id === fuelId)?.shares.find((s) => s.userId === ben.id);
    // The admin's own kilometres (the 100 km above) do not count: Ben, whose 50 km the admin drove, pays the whole 60.00.
    expect(share?.dueCents === 6000 && share.can.selfPaid === true, `Ben's share ${JSON.stringify(share)}`);
    const shares = listed.items.find((f) => f.id === fuelId)?.shares ?? [];
    expect(shares.length === 1 && shares[0].userId === ben.id, `only Ben has a share, the admin has none: ${JSON.stringify(shares.map((s) => s.userName))}`);
    const paid = await fetch(`${base}/api/fuel/${fuelId}/requests/${ben.id}/paid`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: benCookie }, body: JSON.stringify({ paid: true }) });
    expect(paid.status === 200, `I have paid ${paid.status}`);
    const after = await (await fetch(`${base}/api/fuel`, { headers: { Cookie: benCookie } })).json();
    expect(after.balances.length === 0, `balances after paying ${JSON.stringify(after.balances)}`);
  });
  // Relies on the two drives the previous check logged: 10 to 9 hours ago (the admin's own kilometres)
  // and 8 to 7 hours ago (the admin drove, the kilometres are Ben's).
  await check('a traffic ticket is matched to whoever drove at that moment, also when the kilometres are someone else\'s, and the list is newest first', async () => {
    const json = { 'Content-Type': 'application/json', Cookie: cookie };
    const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
    expect((await fetch(`${base}/api/tickets`)).status === 401, 'anonymous gets 401');
    const adminId = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json()).user.id;
    const add = async (hours, extra = {}) => {
      const res = await fetch(`${base}/api/tickets`, { method: 'POST', headers: json, body: JSON.stringify({ at: hoursAgo(hours), ...extra }) });
      expect(res.status === 201, `ticket ${hours} hours ago gave ${res.status}`);
      return (await res.json()).ticket;
    };

    const own = await add(9.5, { amountCents: 7500, reason: 'Speeding' });
    expect(own.driver?.id === adminId && own.basis === 'drive', `inside the admin's own drive: ${JSON.stringify([own.driver, own.basis])}`);
    expect(own.amountCents === 7500 && own.reason === 'Speeding', 'price and reason are kept');
    const forBen = await add(7.5);
    expect(forBen.driver?.id === adminId && forBen.basis === 'drive', `the admin drove Ben's kilometres: ${JSON.stringify([forBen.driver, forBen.basis])}`);
    expect(forBen.amountCents === null && forBen.reason === '', 'only the time is required');
    const nobody = await add(5);
    expect(nobody.driver === null && nobody.basis === 'none', `no drive or reservation: ${JSON.stringify([nobody.driver, nobody.basis])}`);

    const bad = await fetch(`${base}/api/tickets`, { method: 'POST', headers: json, body: JSON.stringify({ at: hoursAgo(-2) }) });
    expect(bad.status === 422 && (await bad.json()).error.fields.at === 'in_future', `a ticket in the future gave ${bad.status}`);

    const list = (await (await fetch(`${base}/api/tickets`, { headers: { Cookie: cookie } })).json()).items;
    expect(list.map((t) => t.id).join() === [nobody.id, forBen.id, own.id].join(), `newest first: ${list.map((t) => t.id)}`);

    expect((await fetch(`${base}/api/tickets/${nobody.id}`, { method: 'DELETE', headers: json })).status === 204, 'delete');
    const left = (await (await fetch(`${base}/api/tickets`, { headers: { Cookie: cookie } })).json()).items;
    expect(left.length === 2, `${left.length} tickets left after the delete`);
  });
  // Relies on what the earlier checks left: the admin's drive 1000 to 1042 (just now), the drives 2000 to 2100 and 2100 to
  // 2150 (10 to 7 hours ago, Ben is neither of their drivers) and the fill-up at 2150 one hour ago. So the chain has one
  // finding to begin with: the drive just now starts at 1000 although the fill-up before it read 2150 (a mismatch of 1150 km).
  await check('the odometer chain: gaps and mismatches for everybody, explaining one needs a note and an involved person, correcting a reading clears it, a fill-up needs its reading', async () => {
    const json = { 'Content-Type': 'application/json', Cookie: cookie };
    const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
    expect((await fetch(`${base}/api/odometer`)).status === 401, 'anonymous gets 401');
    const chain = async (cookieHeader = cookie) => (await (await fetch(`${base}/api/odometer`, { headers: { Cookie: cookieHeader } })).json());

    const noReading = await fetch(`${base}/api/fuel`, { method: 'POST', headers: json, body: JSON.stringify({ at: hoursAgo(0.5), millilitres: 1000, totalCents: 100 }) });
    expect(noReading.status === 422 && (await noReading.json()).error.fields.odometer === 'required', `a fill-up without its reading gave ${noReading.status}`);

    const first = await chain();
    const startMismatch = first.items.find((i) => i.kind === 'mismatch');
    expect(first.items.length === 1 && startMismatch?.km === 1150, `one mismatch of 1150 km to begin with: ${JSON.stringify(first.items.map((i) => [i.kind, i.km]))}`);
    expect(startMismatch.prev.source === 'fuel' && startMismatch.next.source === 'drive-start', 'it names both neighbours: the fill-up and the drive after it');
    expect(first.latest?.km === 1042, `the latest known reading is the end of the drive just now: ${first.latest?.km}`);

    // The admin drives 2180 to 2200 six to five hours ago: 30 km after the drive that ended at 2150, and 50 km above the fill-up that follows.
    const made = await fetch(`${base}/api/usage`, { method: 'POST', headers: json, body: JSON.stringify({ start: hoursAgo(6), end: hoursAgo(5), odometerStart: 2180, odometerEnd: 2200 }) });
    expect(made.status === 201, `the drive after the gap ${made.status}`);
    const driveId = (await made.json()).usage.id;
    const second = await chain();
    const gap = second.items.find((i) => i.kind === 'gap');
    const fillMismatch = second.items.find((i) => i.kind === 'mismatch' && i.km === 50);
    expect(second.items.length === 3 && gap?.km === 30 && fillMismatch, `a gap of 30 and mismatches of 50 and 1150: ${JSON.stringify(second.items.map((i) => [i.kind, i.km]))}`);
    expect(gap.prev.km === 2150 && gap.next.km === 2180 && gap.next.id === driveId, 'the gap names the end of the earlier drive and the start of the new one');

    const fuelCard = async () => (await (await fetch(`${base}/api/fuel`, { headers: { Cookie: cookie } })).json()).items[0];
    expect((await fuelCard()).unaccountedKm === 30, `the fuel card notes the 30 km: ${(await fuelCard()).unaccountedKm}`);

    const explain = (body, cookieHeader = cookie) =>
      fetch(`${base}/api/odometer/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader }, body: JSON.stringify(body) });
    const noNote = await explain({ key: gap.key });
    expect(noNote.status === 422 && (await noNote.json()).error.fields.note === 'required', `an explanation without a note gave ${noNote.status}`);
    const blank = await explain({ key: gap.key, note: '   ' });
    expect(blank.status === 422, `a blank note gave ${blank.status}`);
    expect((await explain({ key: 'no-such-stretch', note: 'x' })).status === 404, 'an unknown stretch is 404');

    // Ben did not drive or fill up at either end of the gap, so it is not his to explain; he still sees it.
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smokeben', password: 'smoke-ben-password-1' }) });
    const benCookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0];
    expect(login.status === 200 && benCookie !== '', `Ben signs in ${login.status}`);
    expect((await chain(benCookie)).items.length === 3, 'everybody sees the same findings');
    expect((await explain({ key: gap.key, note: 'not mine' }, benCookie)).status === 403, 'somebody who is not involved cannot explain it');

    const done = await explain({ key: gap.key, note: 'Borrowed by a neighbour' });
    expect(done.status === 201, `explained ${done.status}`);
    const explained = (await chain()).items.find((i) => i.key === gap.key);
    expect(explained?.explained?.note === 'Borrowed by a neighbour', 'the note shows on the item');
    expect((await fuelCard()).unaccountedKm === 0, `an explained gap is not counted on the card: ${(await fuelCard()).unaccountedKm}`);

    expect((await fetch(`${base}/api/odometer/explained/${explained.explained.id}`, { method: 'DELETE', headers: json })).status === 204, 'the explanation can be removed');
    expect((await chain()).items.find((i) => i.key === gap.key)?.explained === null, 'and the gap is open again');

    // Correcting the reading is the other way out: the gap is gone, the mismatch with the fill-up stays.
    const fixed = await fetch(`${base}/api/usage/${driveId}`, { method: 'PATCH', headers: json, body: JSON.stringify({ odometerStart: 2150 }) });
    expect(fixed.status === 200, `correcting the start reading ${fixed.status}`);
    const third = await chain();
    expect(third.items.every((i) => i.kind === 'mismatch') && third.items.length === 2, `the gap is gone: ${JSON.stringify(third.items.map((i) => [i.kind, i.km]))}`);
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
