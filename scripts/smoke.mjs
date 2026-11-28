// Build the project, start the BUILT server (dist/src/server.js, the same layout
// the Docker image uses) on a free port with a throw-away data directory, and
// check the basics over real HTTP. This is what catches "works in dev, breaks in
// the image" problems such as the public/ and shared/ directories not being found.
//   npm run smoke
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  'STATS_RETENTION_MONTHS',
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
    expect(html.includes('rel="manifest"') && html.includes('/app.js') && html.includes('<html lang="nl">'), 'index.html content (Dutch)');
  });
  await check('GET /shared/time.js and /shared/format.js serve the shared modules', async () => {
    const res = await fetch(`${base}/shared/time.js`);
    expect(res.status === 200, `status ${res.status}`);
    expect((res.headers.get('content-type') ?? '').startsWith('text/javascript'), 'content-type');
    expect((await res.text()).includes('addCalendarMonths'), 'content');
    const format = await fetch(`${base}/shared/format.js`);
    expect(format.status === 200 && (format.headers.get('content-type') ?? '').startsWith('text/javascript'), `format.js gave ${format.status}`);
    expect((await format.text()).includes('formatEuro'), 'format.js content');
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

  // The Car tab. These are calendar dates, so "today" is the household's day (what the server calls today, worked out
  // here with Intl), and the damage is noticed in 2020, long before any drive of this run: the hint is deterministic.
  await check('the Car tab: a damage report is filed, repaired once and deleted, the APK date is set, impossible dates are refused and everything needs a login', async () => {
    const json = { 'Content-Type': 'application/json', Cookie: cookie };
    const send = (method, url, body, headers = json) => fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
    const [year, month, dayOfMonth] = today.split('-').map(Number);
    const tomorrow = new Date(Date.UTC(year, month - 1, dayOfMonth + 1)).toISOString().slice(0, 10);
    const fieldsOf = async (res) => (await res.json()).error?.fields ?? {};

    for (const [method, url] of [['GET', '/api/damage'], ['POST', '/api/damage'], ['PATCH', '/api/damage/1'], ['DELETE', '/api/damage/1'], ['POST', '/api/damage/1/repair'], ['GET', '/api/car/apk'], ['PATCH', '/api/car/apk']]) {
      const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect(res.status === 401, `${method} ${url} without a login gave ${res.status}`);
    }

    // The APK: not set to begin with, a leap day is a day, a day that does not exist and a typo of years are refused.
    const fresh = (await (await send('GET', '/api/car/apk')).json()).apk;
    expect(fresh.expiresOn === null && fresh.updatedBy === null && fresh.daysLeft === null, `the APK starts as not set: ${JSON.stringify(fresh)}`);
    const leap = await send('PATCH', '/api/car/apk', { expiresOn: '2028-02-29' });
    const leapApk = (await leap.json()).apk;
    expect(leap.status === 200 && leapApk.expiresOn === '2028-02-29' && leapApk.updatedBy?.name && typeof leapApk.daysLeft === 'number', `29 February 2028 is accepted: ${leap.status} ${JSON.stringify(leapApk)}`);
    const noLeap = await send('PATCH', '/api/car/apk', { expiresOn: '2027-02-29' });
    expect(noLeap.status === 422 && (await fieldsOf(noLeap)).expiresOn === 'invalid_date', `29 February 2027 gave ${noLeap.status}`);
    const tooFar = await send('PATCH', '/api/car/apk', { expiresOn: `${year + 6}-01-15` });
    expect(tooFar.status === 422 && (await fieldsOf(tooFar)).expiresOn === 'too_far_ahead', `six years ahead gave ${tooFar.status}`);
    expect((await (await send('GET', '/api/car/apk')).json()).apk.expiresOn === '2028-02-29', 'a refused date changes nothing');

    // A damage report: the day must exist and not be in the future, anybody sees it, the hint rests on nothing in 2020.
    const bad = await send('POST', '/api/damage', { noticedOn: '2026-02-30', location: 'front', description: 'x' });
    expect(bad.status === 422 && (await fieldsOf(bad)).noticedOn === 'invalid_date', `30 February gave ${bad.status}`);
    const future = await send('POST', '/api/damage', { noticedOn: tomorrow, location: 'front', description: 'x' });
    expect(future.status === 422 && (await fieldsOf(future)).noticedOn === 'in_future', `tomorrow gave ${future.status}`);
    const made = await send('POST', '/api/damage', { noticedOn: '2020-03-14', location: 'front', description: 'Old scratch on the bumper' });
    const report = (await made.json()).report;
    expect(made.status === 201 && report.status === 'open' && report.noticedBy?.name === report.reportedBy.name, `a report is filed: ${made.status}`);
    expect(report.hint.basis === 'none' && report.hint.driver === null, `nobody was on record in 2020: ${JSON.stringify(report.hint)}`);
    const listed = (await (await send('GET', '/api/damage')).json()).items;
    expect(listed.some((r) => r.id === report.id && r.can.repair), 'the report is in the list');

    // Repaired once: the second time is a 409 and the date stays.
    const fixed = await send('POST', `/api/damage/${report.id}/repair`, { repairedOn: today, repairNote: 'Polished' });
    const fixedReport = (await fixed.json()).report;
    expect(fixed.status === 200 && fixedReport.status === 'repaired' && fixedReport.repairedOn === today, `marked repaired: ${fixed.status}`);
    const again = await send('POST', `/api/damage/${report.id}/repair`, { repairedOn: today });
    expect(again.status === 409, `repairing twice gave ${again.status}`);

    // Somebody else can see it, repair nothing twice, and cannot delete what is not theirs; the person who filed it can.
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smokeben', password: 'smoke-ben-password-1' }) });
    const ben = { 'Content-Type': 'application/json', Cookie: (login.headers.getSetCookie()[0] ?? '').split(';')[0] };
    expect(login.status === 200, `Ben signs in ${login.status}`);
    expect(((await (await send('GET', '/api/damage', undefined, ben)).json()).items).some((r) => r.id === report.id), 'everybody sees every report');
    expect((await send('DELETE', `/api/damage/${report.id}`, undefined, ben)).status === 403, 'a report of somebody else cannot be deleted');
    expect((await send('DELETE', `/api/damage/${report.id}`)).status === 204, 'the person who filed it can delete it');
    expect(!((await (await send('GET', '/api/damage')).json()).items).some((r) => r.id === report.id), 'and it is gone');
  });

  // The statistics add up the records the Fuel screen shows, so what they say about a month must equal what the Fuel screen
  // says about the fill-ups of that month, whatever day of the month this run happens to be on. The earlier checks left a
  // fill-up of 60.00 (the admin fuelled, Ben pays all of it) one hour ago.
  await check('statistics: monthly totals equal the Fuel screen and are the same for everybody, the admin pays nothing, a bad range is refused, anonymous is turned away and reading stores nothing', async () => {
    const asAdmin = { 'Content-Type': 'application/json', Cookie: cookie };
    const get = (url, headers = asAdmin) => fetch(`${base}${url}`, { headers });
    expect((await fetch(`${base}/api/stats`)).status === 401, 'anonymous');
    const res = await get('/api/stats');
    expect(res.status === 200, `GET /api/stats ${res.status}`);
    const text = await res.text();
    const stats = JSON.parse(text);
    expect(stats.version === 1 && stats.months.length === 12 && stats.retentionMonths === 24 && stats.windowMonths === 6, `the shape: ${text.slice(0, 200)}`);
    const last = stats.months[11];
    expect(last.month === stats.current && last.provisional === true && stats.range.to === stats.current, `the last month is the current one: ${JSON.stringify(last).slice(0, 120)}`);

    // The month of a moment in the household's zone, the way the server counts.
    const monthOf = (iso) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
      return `${parts.year}-${parts.month}`;
    };
    const fuel = (await (await get('/api/fuel')).json()).items;
    expect(fuel.length >= 1, 'the earlier checks left a fill-up');
    for (const m of stats.months) {
      // A month before the household existed is "unknown": no totals at all, not zeros (this database is a few seconds old).
      if (m.unavailable) {
        expect(m.household === null && m.people.length === 0 && !m.provisional, `${m.month}: an unknown month has no numbers`);
        continue;
      }
      const fills = fuel.filter((f) => monthOf(f.at) === m.month);
      const paid = fills.map((f) => f.totalCents).reduce((a, b) => a + b, 0);
      expect(m.household.paidCents === paid && m.household.fillUps === fills.length, `${m.month}: paid ${m.household.paidCents} against ${paid} on the Fuel screen`);
      for (const person of m.people) {
        const shares = fills.flatMap((f) => f.shares).filter((s) => s.userId === person.userId).map((s) => s.cents).reduce((a, b) => a + b, 0);
        expect(person.shareCents === shares, `${m.month}: the share of user ${person.userId} is ${person.shareCents}, the Fuel screen says ${shares}`);
      }
    }
    expect(stats.months.some((m) => m.household?.paidCents === 6000), 'the 60.00 fill-up is in some month');
    expect(stats.months.filter((m) => m.unavailable).length === 11 && last.unavailable === false, 'a database that is seconds old knows only the current month');
    const me = (await (await get('/api/auth/me')).json()).user;
    for (const m of stats.months) expect((m.people.find((p) => p.userId === me.id)?.shareCents ?? 0) === 0, `${m.month}: the admin pays no fuel`);

    // The same body for a member.
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smokeben', password: 'smoke-ben-password-1' }) });
    expect(login.status === 200, `Ben signs in ${login.status}`);
    const asBen = { 'Content-Type': 'application/json', Cookie: (login.headers.getSetCookie()[0] ?? '').split(';')[0] };
    expect((await (await get('/api/stats', asBen)).text()) === text, 'a member gets the same body as the admin');

    // A range that does not make sense is a 422 with a code per field, not a silent clamp.
    const fieldsOf = async (url) => {
      const bad = await get(url);
      return { status: bad.status, fields: (await bad.json()).error?.fields ?? {} };
    };
    const shift = (key, by) => {
      const [y, m] = key.split('-').map(Number);
      const index = y * 12 + (m - 1) + by;
      return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    };
    for (const [url, field, code] of [
      ['/api/stats?from=2026-13', 'from', 'invalid_month'],
      [`/api/stats?to=${shift(stats.current, 1)}`, 'to', 'in_future'],
      [`/api/stats?from=${stats.current}&to=${shift(stats.current, -1)}`, 'from', 'after_to'],
      [`/api/stats?from=${shift(stats.current, -36)}`, 'from', 'outside_retention'],
    ]) {
      const bad = await fieldsOf(url);
      expect(bad.status === 422 && bad.fields[field] === code, `${url} gave ${bad.status} ${JSON.stringify(bad.fields)}`);
    }

    // Reading stores nothing: only the purge writes a monthly total, and this database has nothing older than the window.
    const status = await (await get('/api/admin/retention')).json();
    expect(status.counts.statsMonths === 0 && status.statsRetentionMonths === 24, `nothing stored by reading: ${JSON.stringify(status.counts)}`);
  });

  // The two read-only integrations (docs/API.md). The reservation of the earlier check is tomorrow, so the feed lists it.
  await check('read-only API and calendar feed: a token reads the four routes and dies when revoked, the feed has an ETag and a new link kills the old one, and no secret reaches the server output', async () => {
    const asAdmin = { 'Content-Type': 'application/json', Cookie: cookie };
    const made = await fetch(`${base}/api/tokens`, { method: 'POST', headers: asAdmin, body: JSON.stringify({ name: 'Smoke test' }) });
    expect(made.status === 201, `make a token ${made.status}`);
    const { token, item } = await made.json();
    expect(/^pat_[A-Za-z0-9_-]{43}$/.test(token), 'the token has its shape');
    const bearer = { Authorization: `Bearer ${token}` };
    for (const route of ['status', 'reservations', 'stats', 'me']) {
      const res = await fetch(`${base}/api/v1/${route}`, { headers: bearer });
      expect(res.status === 200 && res.headers.get('cache-control') === 'no-store', `GET /api/v1/${route}: ${res.status}`);
    }
    const viaToken = await (await fetch(`${base}/api/v1/stats`, { headers: bearer })).text();
    expect(viaToken === (await (await fetch(`${base}/api/stats`, { headers: asAdmin })).text()), 'the token gets the statistics byte for byte');
    expect((await fetch(`${base}/api/v1/me`, { headers: asAdmin })).status === 401, 'a session cookie does not work on /api/v1/');
    expect((await fetch(`${base}/api/auth/me`, { headers: bearer })).status === 401, 'a token does not work on a cookie route');
    expect((await fetch(`${base}/api/v1/me`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' })).status === 404, 'nothing can be written with a token');
    expect((await fetch(`${base}/api/tokens/${item.id}`, { method: 'DELETE', headers: asAdmin })).status === 204, 'revoke');
    expect((await fetch(`${base}/api/v1/me`, { headers: bearer })).status === 401, 'a revoked token is refused');

    const feedMade = await fetch(`${base}/api/calendar-feed`, { method: 'POST', headers: asAdmin, body: '{}' });
    expect(feedMade.status === 201, `make a link ${feedMade.status}`);
    const firstPath = (await feedMade.json()).feed.path;
    const ics = await fetch(`${base}${firstPath}`);
    const body = await ics.text();
    expect(ics.status === 200 && ics.headers.get('content-type') === 'text/calendar; charset=utf-8' && ics.headers.get('cache-control') === 'no-store', `the feed: ${ics.status} ${ics.headers.get('content-type')}`);
    expect(body.startsWith('BEGIN:VCALENDAR\r\n') && body.endsWith('END:VCALENDAR\r\n') && body.includes('BEGIN:VEVENT'), 'it is a calendar with the reservation of the earlier check in it');
    const etag = ics.headers.get('etag') ?? '';
    expect(/^"[0-9a-f]{32}"$/.test(etag), `a strong ETag: ${etag}`);
    const unchanged = await fetch(`${base}${firstPath}`, { headers: { 'If-None-Match': etag } });
    expect(unchanged.status === 304 && (await unchanged.text()) === '', `If-None-Match: ${unchanged.status}`);
    const renewed = await fetch(`${base}/api/calendar-feed/new-link`, { method: 'POST', headers: asAdmin, body: '{}' });
    const secondPath = (await renewed.json()).feed.path;
    expect(secondPath !== firstPath, 'a new link is a different link');
    expect((await fetch(`${base}${firstPath}`)).status === 404, 'the old link is dead');
    expect((await fetch(`${base}${secondPath}`)).status === 200, 'the new one works');

    // The server writes a line for each request; none of them may hold a secret. The path is logged redacted.
    await new Promise((r) => setTimeout(r, 300));
    const secrets = [token, token.slice(4), firstPath.slice('/api/calendar/'.length, -4), secondPath.slice('/api/calendar/'.length, -4)];
    for (const secret of secrets) expect(!output.includes(secret), 'a secret is in the server output');
    expect(output.includes('"path":"/api/calendar/[redacted]"'), 'the access log has the redacted path');
  });
} catch (err) {
  failures.push('startup');
  console.log(`  FAIL startup: ${err instanceof Error ? err.message : err}`);
} finally {
  child.kill();
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 5000))]);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---- the second server: notifications for what somebody else does on your behalf ------------------------------------
// The built server once more, this time with push switched on (DOMAIN is set) and fetch replaced by
// scripts/smoke-push-stub.mjs: every push the notifier makes is recorded on stdout and none leaves the machine.
// This checks the wiring in the built output (who is told, who is not, that answers are unaffected). That a push
// really reaches a phone cannot be checked here.
{
  const notifyPort = await freePort();
  const notifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-smoke-notify-'));
  const stub = pathToFileURL(path.join(root, 'scripts', 'smoke-push-stub.mjs')).href;
  const notifyChild = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', stub, path.join('dist', 'src', 'server.js')],
    { cwd: root, env: { ...env, PORT: String(notifyPort), DATA_DIR: notifyDir, DOMAIN: 'smoke.example.test' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let notifyOut = '';
  notifyChild.stdout.on('data', (d) => (notifyOut += d));
  notifyChild.stderr.on('data', (d) => (notifyOut += d));
  let notifyExited = false;
  const notifyExit = new Promise((resolve) =>
    notifyChild.on('exit', (code) => {
      notifyExited = true;
      resolve(code);
    }),
  );
  const nbase = `http://127.0.0.1:${notifyPort}`;

  try {
    console.log(`Starting a second server with push on and fetch stubbed, on port ${notifyPort}...`);
    for (let i = 0; ; i++) {
      if (notifyExited) throw new Error(`second server exited early:\n${notifyOut}`);
      if (i >= 100) throw new Error(`second server did not start:\n${notifyOut}`);
      try {
        if ((await fetch(`${nbase}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const call = (cookieHeader, method, route, body) =>
      fetch(`${nbase}${route}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookieHeader }, body: body === undefined ? undefined : JSON.stringify(body) });
    const login = async (username, password) => {
      const res = await fetch(`${nbase}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      expect(res.status === 200, `${username} signs in: ${res.status}`);
      return (res.headers.getSetCookie()[0] ?? '').split(';')[0];
    };
    const pushes = () => notifyOut.split('\n').filter((line) => line.startsWith('{"event":"smoke.push"')).map((line) => JSON.parse(line).url);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    // Run an action; the pushes it causes follow the answer, and must be exactly to these endpoints (none: nobody is told).
    async function told(label, action, wanted) {
      const before = pushes().length;
      const res = await action();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && pushes().length - before < wanted.length) await pause(25);
      await pause(150); // anything extra would have arrived by now
      const got = pushes().slice(before).sort();
      const want = [...wanted].sort();
      expect(JSON.stringify(got) === JSON.stringify(want), `${label}: pushes went to ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
      return res;
    }
    const hour = 3_600_000;
    const iso = (h) => new Date(Date.now() + h * hour).toISOString();
    const device = (who, i) => `https://fcm.googleapis.com/fcm/send/smoke-${who}-${i}`;
    const subscription = (endpoint) => {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    };

    const adminCookie = await login(ADMIN.username, ADMIN.password);
    const member = async (username, displayName) => {
      const made = await call(adminCookie, 'POST', '/api/admin/users', { username, displayName, password: 'smoke-notify-password-1' });
      expect(made.status === 201, `create ${username}: ${made.status}`);
      return { id: (await made.json()).user.id, cookie: await login(username, 'smoke-notify-password-1') };
    };
    const ann = await member('smokeann', 'Ann');
    const ben = await member('smokeben2', 'Ben');
    const devices = { admin: [device('admin', 0)], ann: [device('ann', 0)], ben: [device('ben', 0), device('ben', 1)] };

    await check('push is on in the second server and everybody signs their phones up (the admin one, Ann one, Ben two)', async () => {
      const key = await (await call(adminCookie, 'GET', '/api/push/key')).json();
      expect(key.enabled === true, 'push should be on when DOMAIN is set');
      for (const [who, cookieHeader] of [['admin', adminCookie], ['ann', ann.cookie], ['ben', ben.cookie]]) {
        for (const endpoint of devices[who]) {
          const res = await call(cookieHeader, 'POST', '/api/push/subscribe', subscription(endpoint));
          expect(res.status === 201, `${who} subscribes ${endpoint}: ${res.status}`);
        }
      }
    });

    await check('notifications: a suggestion, its answer and what an admin does to the reservation tell the other person, one push per phone, and never the person who did it', async () => {
      let res = await told('a suggestion for Ben', () => call(ann.cookie, 'POST', '/api/reservations', { userId: ben.id, start: iso(30), end: iso(32) }), devices.ben);
      expect(res.status === 201, `suggest ${res.status}`);
      const reservation = (await res.json()).reservation;
      res = await told('Ben approves', () => call(ben.cookie, 'POST', `/api/reservations/${reservation.id}/approve`, {}), devices.ann);
      expect(res.status === 200, `approve ${res.status}`);
      res = await told('an admin moves it', () => call(adminCookie, 'PATCH', `/api/reservations/${reservation.id}`, { start: iso(50), end: iso(52) }), devices.ben);
      expect(res.status === 200, `move ${res.status}`);
      res = await told('an admin cancels it', () => call(adminCookie, 'DELETE', `/api/reservations/${reservation.id}`), devices.ben);
      expect(res.status === 204, `cancel ${res.status}`);
      res = await told('Ben reserves for himself', () => call(ben.cookie, 'POST', '/api/reservations', { start: iso(70), end: iso(71) }), []);
      expect(res.status === 201, `own reservation ${res.status}`);
    });

    await check('notifications: a drive in your name, kilometres put on your name and what happens to them tell the person they concern, not the one who did it', async () => {
      const drive = (cookieHeader, body) => call(cookieHeader, 'POST', '/api/usage', body);
      let res = await told('an admin logs a drive for Ben', () => drive(adminCookie, { userId: ben.id, start: iso(-10), end: iso(-9), odometerStart: 1000, odometerEnd: 1050 }), devices.ben);
      expect(res.status === 201, `drive for Ben ${res.status}`);
      res = await told('Ann registers kilometres as Ben\'s', () => drive(ann.cookie, { start: iso(-8), end: iso(-7), odometerStart: 1050, odometerEnd: 1100, kmFor: 'person', kmUserId: ben.id, note: 'Took Ben to the station' }), devices.ben);
      expect(res.status === 201, `kilometres for Ben ${res.status}`);
      const attributed = (await res.json()).usage;
      res = await told('Ann changes them', () => call(ann.cookie, 'PATCH', `/api/usage/${attributed.id}`, { odometerEnd: 1110 }), devices.ben);
      expect(res.status === 200, `change ${res.status}`);
      res = await told('Ann removes them', () => call(ann.cookie, 'DELETE', `/api/usage/${attributed.id}`), devices.ben);
      expect(res.status === 204, `remove ${res.status}`);
      res = await told('Ben logs his own drive', () => drive(ben.cookie, { start: iso(-6), end: iso(-5), odometerStart: 1100, odometerEnd: 1120 }), []);
      expect(res.status === 201, `own drive ${res.status}`);
    });

    await check('notifications: a fill-up that moves your share, "I have paid" and the paid mark taken off tell the other person (who owes, who is owed)', async () => {
      let res = await told('a new fill-up tells the person who owes', () => call(ann.cookie, 'POST', '/api/fuel', { at: iso(-1), millilitres: 40000, totalCents: 6000, odometer: 5000 }), devices.ben);
      expect(res.status === 201, `fill-up ${res.status}`);
      const fuelId = (await res.json()).fuel.id;
      res = await told('a dearer fill-up moves his share', () => call(ann.cookie, 'PATCH', `/api/fuel/${fuelId}`, { totalCents: 7000 }), devices.ben);
      expect(res.status === 200, `edit ${res.status}`);
      res = await told('Ben says he paid: the fueler hears', () => call(ben.cookie, 'POST', `/api/fuel/${fuelId}/requests/${ben.id}/paid`, { paid: true }), devices.ann);
      expect(res.status === 200, `paid ${res.status}`);
      res = await told('an admin takes the mark off: the debtor hears', () => call(adminCookie, 'POST', `/api/fuel/${fuelId}/requests/${ben.id}/paid`, { paid: false }), devices.ben);
      expect(res.status === 200, `unpaid ${res.status}`);
      res = await told('the fill-up is deleted: the share goes', () => call(ann.cookie, 'DELETE', `/api/fuel/${fuelId}`), devices.ben);
      expect(res.status === 204, `delete ${res.status}`);
    });

    await check('notifications: a traffic ticket for a moment Ben was driving tells Ben, also when it is changed or deleted (its text has no price or reason: the unit tests read the decrypted text)', async () => {
      let res = await told('a ticket is entered', () => call(ann.cookie, 'POST', '/api/tickets', { at: iso(-9.5), amountCents: 7500, reason: 'Speeding' }), devices.ben);
      expect(res.status === 201, `ticket ${res.status}`);
      const ticket = (await res.json()).ticket;
      expect(ticket.driver?.id === ben.id, `the app names Ben as the driver: ${JSON.stringify(ticket.driver)}`);
      res = await told('it is changed', () => call(ann.cookie, 'PATCH', `/api/tickets/${ticket.id}`, { amountCents: 9000 }), devices.ben);
      expect(res.status === 200, `edit ${res.status}`);
      res = await told('it is deleted', () => call(ann.cookie, 'DELETE', `/api/tickets/${ticket.id}`), devices.ben);
      expect(res.status === 204, `delete ${res.status}`);
    });

    await check('notifications: only the made-up smoke phones were ever called, nothing failed, and the Account page list is served', async () => {
      const urls = pushes();
      expect(urls.length >= 20, `${urls.length} pushes were recorded`);
      expect(urls.every((u) => /^https:\/\/fcm\.googleapis\.com\/fcm\/send\/smoke-(admin|ann|ben)-\d$/.test(u)), 'only the made-up smoke devices');
      expect(!/"event":"(notify\.error|push\.send_failed|error)"/.test(notifyOut), 'no failure was logged by the notifier, the push sender or the server');
      const strings = await (await fetch(`${nbase}/strings.js`)).text();
      expect(strings.includes('Waarover je een melding krijgt'), 'the Account page list is in the served strings');
    });
  } catch (err) {
    failures.push('notification server');
    console.log(`  FAIL notification server: ${err instanceof Error ? err.message : err}`);
  } finally {
    notifyChild.kill();
    await Promise.race([notifyExit, new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(notifyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (failures.length > 0) {
  console.log(`\nSmoke test FAILED (${failures.length} of ${checks} checks): ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\nSmoke test passed (${checks} checks).`);
