// scripts/container-check.mjs is what the CI "Docker" job runs against the real container: health,
// anonymous 401, sign-in, GET /api/auth/me, a reservation (201) and the same slot again (409).
// Nothing else exercises it before CI does, so these tests run it for real, as a child process:
//  - against the real app (in this process, on a real port): it must pass and write one reservation;
//  - against a small stand-in server that behaves like the app, and then with ONE thing broken at a
//    time: the script must name that check and exit 1. A check that cannot fail would let a broken
//    container through the Docker job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, PASSWORD } from './helpers.ts';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'container-check.mjs');

interface Outcome {
  code: number;
  out: string;
  err: string;
}

/** Run the script as the workflow does. It must be asynchronous: the server it talks to lives in this process. */
function runCheck(args: string[], env: Record<string, string | undefined>): Promise<Outcome> {
  const clean: NodeJS.ProcessEnv = { ...process.env, ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined, ...env };
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: clean, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 255;
      resolve({ code, out: stdout, err: stderr });
    });
  });
}

const failed = (o: Outcome): string[] => o.out.split('\n').filter((l) => l.startsWith('  FAIL ')).map((l) => l.slice(7));

// ------------------------------------------------------------------ against the real app

test('against the real app: every check passes, and it writes exactly one reservation', async () => {
  // The script asks for "a day from now" by the real clock, so the app must run on the real clock too.
  const t = await createTestApp({ now: new Date().toISOString() });
  try {
    await t.signIn('admin', 'admin');
    const o = await runCheck([`http://127.0.0.1:${t.port}`], { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: PASSWORD });
    assert.equal(o.code, 0, o.out + o.err);
    assert.deepEqual(failed(o), []);
    assert.match(o.out, /Container check passed\./);
    for (const name of ['GET /api/health reports ok', 'anonymous calls', 'GET /api/auth/me says who is signed in', 'a reservation is created (201) and the same slot is refused (409)']) {
      assert.ok(o.out.includes(`  ok   ${name}`), `"${name}" ran and passed:\n${o.out}`);
    }
    const rows = t.db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number };
    assert.equal(rows.n, 1, 'the 409 on the second attempt wrote nothing');
  } finally {
    await t.close();
  }
});

test('against the real app with a wrong password: the sign-in check fails and so does everything that needs a session', async () => {
  const t = await createTestApp({ now: new Date().toISOString() });
  try {
    await t.signIn('admin', 'admin');
    const o = await runCheck([`http://127.0.0.1:${t.port}`], { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: `${PASSWORD}-not` });
    assert.equal(o.code, 1, o.out + o.err);
    assert.match(o.out, /Container check FAILED/);
    assert.ok(failed(o).some((n) => n.startsWith('a wrong password is refused')), o.out);
    assert.ok(failed(o).some((n) => n.startsWith('a reservation is created')), 'no session, so no reservation: the job must not pass');
    assert.ok(o.out.includes('  ok   GET /api/health reports ok'), 'the checks that need no session still ran');
    const rows = t.db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------- usage and no server

test('without credentials or with a bad address it prints the usage and exits 2, before sending anything', async () => {
  const noPassword = await runCheck(['http://127.0.0.1:1'], { ADMIN_USERNAME: 'admin' });
  assert.equal(noPassword.code, 2);
  assert.match(noPassword.err, /Usage: /);
  const noUser = await runCheck(['http://127.0.0.1:1'], { ADMIN_PASSWORD: 'x' });
  assert.equal(noUser.code, 2);
  const noAddress = await runCheck([], { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x' });
  assert.equal(noAddress.code, 2);
  const notHttp = await runCheck(['127.0.0.1:3000'], { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x' });
  assert.equal(notHttp.code, 2, 'an address without http:// or https:// is refused');
  assert.equal(noPassword.out + noAddress.out + notHttp.out, '', 'nothing was checked');
});

test('with nothing listening, every check fails cleanly (exit 1, no crash)', async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  const o = await runCheck([`http://127.0.0.1:${port}`], { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x' });
  assert.equal(o.code, 1, o.out + o.err);
  assert.equal(failed(o).length, 6, `all six checks fail, none is skipped:\n${o.out}`);
  assert.equal(o.err, '', 'a refused connection is reported as a failed check, not as an unhandled error');
});

// ------------------------------------------------------------ a stand-in app with one fault

type Fault =
  | 'health-degraded'
  | 'shell-not-html'
  | 'api-open-to-anonymous'
  | 'admin-open-to-anonymous'
  | 'accepts-wrong-password'
  | 'cookie-without-httponly'
  | 'cookie-without-samesite'
  | 'me-is-not-admin'
  | 'overlap-accepted'
  | 'create-fails'
  | 'create-answers-200';

const COOKIE = 'sid=stub-session';
const STUB_PASSWORD = 'stub-password';

/** Answers like the app (same paths, status codes and headers the script looks at), optionally with one fault. */
async function stubApp(fault?: Fault): Promise<{ url: string; close(): Promise<void> }> {
  const seen = new Set<string>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const pathname = new URL(req.url ?? '/', 'http://stub').pathname;
      const signedIn = req.headers.cookie === COOKIE;
      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const body = raw === '' ? {} : (JSON.parse(raw) as { password?: string; start?: string; end?: string });
      switch (`${req.method} ${pathname}`) {
        case 'GET /api/health':
          return json(200, { status: fault === 'health-degraded' ? 'degraded' : 'ok' });
        case 'GET /':
          res.writeHead(200, { 'Content-Type': fault === 'shell-not-html' ? 'application/json' : 'text/html; charset=utf-8' });
          return void res.end('<!doctype html><title>stub</title>');
        case 'GET /shared/time.js':
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          return void res.end('export {};');
        case 'GET /api/reservations':
          return signedIn || fault === 'api-open-to-anonymous' ? json(200, []) : json(401, { error: 'unauthenticated' });
        case 'GET /admin':
          if (fault === 'admin-open-to-anonymous') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return void res.end('<!doctype html>');
          }
          res.writeHead(302, { Location: '/' });
          return void res.end();
        case 'POST /api/auth/login':
          if (body.password !== STUB_PASSWORD && fault !== 'accepts-wrong-password') return json(401, { error: 'invalid_credentials' });
          return json(200, { ok: true }, { 'Set-Cookie': `${COOKIE}; Path=/${fault === 'cookie-without-samesite' ? '' : '; SameSite=Lax'}${fault === 'cookie-without-httponly' ? '' : '; HttpOnly'}` });
        case 'GET /api/auth/me':
          return signedIn ? json(200, { user: { username: 'admin', role: fault === 'me-is-not-admin' ? 'member' : 'admin' } }) : json(401, { error: 'unauthenticated' });
        case 'POST /api/reservations': {
          if (!signedIn) return json(401, { error: 'unauthenticated' });
          if (fault === 'create-fails') return json(500, { error: 'internal' });
          const slot = `${body.start}|${body.end}`;
          if (seen.has(slot) && fault !== 'overlap-accepted') return json(409, { error: 'overlap' });
          seen.add(slot);
          return json(fault === 'create-answers-200' ? 200 : 201, { reservation: { id: seen.size } });
        }
        default:
          return json(404, { error: 'not_found' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

const STUB_ENV = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: STUB_PASSWORD };

test('the stand-in app (no fault) passes, so the faults below are the only reason for a failure', async () => {
  const stub = await stubApp();
  try {
    const o = await runCheck([stub.url], STUB_ENV);
    assert.equal(o.code, 0, o.out + o.err);
    assert.deepEqual(failed(o), []);
  } finally {
    await stub.close();
  }
});

const FAULTS: Array<[Fault, string]> = [
  ['health-degraded', 'GET /api/health reports ok'],
  ['shell-not-html', 'GET / is the HTML app shell'],
  ['api-open-to-anonymous', 'anonymous calls: API is 401'],
  ['admin-open-to-anonymous', 'anonymous calls: API is 401'],
  ['accepts-wrong-password', 'a wrong password is refused'],
  ['cookie-without-httponly', 'a wrong password is refused, the right one signs in with an HttpOnly cookie'],
  ['cookie-without-samesite', 'a wrong password is refused, the right one signs in with an HttpOnly cookie'],
  ['me-is-not-admin', 'GET /api/auth/me says who is signed in'],
  ['overlap-accepted', 'a reservation is created (201) and the same slot is refused (409)'],
  ['create-fails', 'a reservation is created (201) and the same slot is refused (409)'],
  ['create-answers-200', 'a reservation is created (201) and the same slot is refused (409)'],
];

for (const [fault, check] of FAULTS) {
  test(`fault "${fault}": the script names "${check}" and exits 1`, async () => {
    const stub = await stubApp(fault);
    try {
      const o = await runCheck([stub.url], STUB_ENV);
      assert.equal(o.code, 1, `the job must go red:\n${o.out}${o.err}`);
      assert.ok(failed(o).some((name) => name.startsWith(check)), `FAIL line for "${check}":\n${o.out}`);
      assert.doesNotMatch(o.out, /Container check passed/);
    } finally {
      await stub.close();
    }
  });
}
