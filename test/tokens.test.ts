// Personal access tokens (src/tokens.ts): the lifecycle, what is stored, who may use a token where, what ends one,
// and the limits. The read-only API a token opens is tested in test/v1.test.ts.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Router } from '../src/http.ts';
import { many, one } from '../src/db.ts';
import { sha256Hex } from '../src/auth.ts';
import { MAX_TOKENS_PER_USER, TOKEN_REQUESTS_PER_MINUTE } from '../src/tokens.ts';
import { createHousehold, rawRequest, type Client, type Household } from './helpers.ts';

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function mint(client: Client, name = 'Home Assistant'): Promise<{ token: string; id: number }> {
  const r = await client.post('/api/tokens', { name });
  assert.equal(r.status, 201, r.text);
  return { token: r.body.token as string, id: r.body.item.id as number };
}

const V1 = ['/api/v1/status', '/api/v1/reservations', '/api/v1/stats', '/api/v1/me'];

async function withHousehold(opts: Parameters<typeof createHousehold>[0], fn: (h: Household) => Promise<void>): Promise<void> {
  const h = await createHousehold(opts);
  try {
    await fn(h);
  } finally {
    await h.t.close();
  }
}

// ------------------------------------------------------------------ the lifecycle

test('a token is created once with a visible prefix and 256 bits, listed without its secret, and revoked by its owner only', async () => {
  await withHousehold({}, async (h) => {
    const made = await h.anna.post('/api/tokens', { name: '  Home Assistant  ' });
    assert.equal(made.status, 201);
    assert.match(made.body.token, /^pat_[A-Za-z0-9_-]{43}$/, 'pat_ and 43 base64url characters: 256 bits');
    assert.equal(Buffer.from(made.body.token.slice(4), 'base64url').length, 32);
    assert.deepEqual(Object.keys(made.body.item).sort(), ['createdAt', 'id', 'lastUsedAt', 'name']);
    assert.equal(made.body.item.name, 'Home Assistant', 'the name is trimmed');
    assert.equal(made.body.item.lastUsedAt, null);
    assert.equal(made.body.item.createdAt, h.t.clock.now().toISOString());

    const list = await h.anna.get('/api/tokens');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items, [made.body.item]);
    assert.equal(list.body.max, MAX_TOKENS_PER_USER);
    assert.ok(!list.text.includes(made.body.token), 'the list never holds the token');
    assert.doesNotMatch(list.text, /hash|secret|"token"/i);

    // Everybody has their own list: Ben sees none of Anna's, and cannot revoke it (404, so it does not even say it exists).
    assert.deepEqual((await h.ben.get('/api/tokens')).body.items, []);
    assert.equal((await h.ben.del(`/api/tokens/${made.body.item.id}`)).status, 404);
    assert.equal((await h.admin.del(`/api/tokens/${made.body.item.id}`)).status, 404, 'not even an admin through the member route');
    assert.equal((await h.anna.get('/api/tokens')).body.items.length, 1);

    assert.equal((await h.anna.del(`/api/tokens/${made.body.item.id}`)).status, 204);
    assert.deepEqual((await h.anna.get('/api/tokens')).body.items, []);
    assert.equal((await h.anna.del(`/api/tokens/${made.body.item.id}`)).status, 404, 'a second revoke finds nothing');
    assert.equal((await h.anna.del('/api/tokens/abc')).status, 404);
  });
});

test('a name is 1 to 60 characters, and the sixth active token is refused', async () => {
  await withHousehold({}, async (h) => {
    for (const bad of ['', '   ', 'x'.repeat(61), 'a\0b']) {
      const r = await h.anna.post('/api/tokens', { name: bad });
      assert.equal(r.status, 422, JSON.stringify(bad));
      assert.ok(r.body.error.fields.name, 'the field is named');
    }
    assert.equal((await h.anna.post('/api/tokens', {})).status, 422, 'no name');
    assert.equal((await h.anna.post('/api/tokens', { name: 5 })).status, 422);
    assert.equal((await h.anna.post('/api/tokens', { name: 'x'.repeat(60) })).status, 201, '60 is fine');
    for (let i = 1; i < MAX_TOKENS_PER_USER; i++) assert.equal((await h.anna.post('/api/tokens', { name: `t${i}` })).status, 201);
    const sixth = await h.anna.post('/api/tokens', { name: 'one too many' });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.error.code, 'too_many_tokens');
    assert.equal(one<{ n: number }>(h.t.db, 'SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?', h.anna.id)?.n, MAX_TOKENS_PER_USER);
    // The limit is per person: Ben still can.
    assert.equal((await h.ben.post('/api/tokens', { name: 'mine' })).status, 201);
    // Revoking one makes room again.
    const first = (await h.anna.get('/api/tokens')).body.items[0].id as number;
    assert.equal((await h.anna.del(`/api/tokens/${first}`)).status, 204);
    assert.equal((await h.anna.post('/api/tokens', { name: 'again' })).status, 201);
  });
});

test('two requests at once cannot both take the last slot', async () => {
  await withHousehold({}, async (h) => {
    for (let i = 1; i < MAX_TOKENS_PER_USER; i++) await h.anna.post('/api/tokens', { name: `t${i}` });
    const both = await Promise.all([h.anna.post('/api/tokens', { name: 'a' }), h.anna.post('/api/tokens', { name: 'b' })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    assert.equal(one<{ n: number }>(h.t.db, 'SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?', h.anna.id)?.n, MAX_TOKENS_PER_USER);
  });
});

test('a signed-out request cannot use the token routes, and a token cannot manage tokens', async () => {
  await withHousehold({}, async (h) => {
    const { token, id } = await mint(h.anna);
    const anon = h.t.client();
    assert.equal((await anon.get('/api/tokens')).status, 401);
    assert.equal((await anon.post('/api/tokens', { name: 'x' })).status, 401);
    // The management routes take the cookie session and nothing else, however good the bearer is.
    assert.equal((await anon.get('/api/tokens', bearer(token))).status, 401);
    assert.equal((await anon.post('/api/tokens', { name: 'x' }, bearer(token))).status, 401);
    assert.equal((await anon.del(`/api/tokens/${id}`, bearer(token))).status, 401);
    assert.equal((await anon.get('/api/admin/tokens', bearer(token))).status, 401);
    assert.equal((await h.anna.get('/api/tokens')).body.items.length, 1, 'nothing was created or removed');
  });
});

// -------------------------------------------------------------------- what is stored

test('only the SHA-256 digest is stored: neither the database file nor a log line nor a header ever holds the token', async () => {
  await withHousehold({}, async (h) => {
    const { token, id } = await mint(h.anna, 'Apps Script');
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    assert.equal(sha256Hex(token), digest);
    const row = one<{ token_hash: string; name: string }>(h.t.db, 'SELECT token_hash, name FROM api_tokens WHERE id = ?', id);
    assert.equal(row?.token_hash, digest);
    assert.equal(row?.token_hash.length, 64);
    assert.deepEqual(many(h.t.db, 'PRAGMA table_info(api_tokens)').map((c) => (c as { name: string }).name), ['id', 'user_id', 'name', 'token_hash', 'created_at', 'last_used_at'], 'no column could hold a token');

    // Use it, fail with it, revoke it, so that every code path that could log it has run.
    const calls = [
      await h.t.client().get('/api/v1/me', bearer(token)),
      await h.t.client().get('/api/v1/me', bearer(`${token}x`)),
      await h.t.client().get('/api/v1/me', bearer(token.slice(0, -1))),
      await h.anna.del(`/api/tokens/${id}`),
      await h.t.client().get('/api/v1/me', bearer(token)),
    ];
    assert.deepEqual(calls.map((c) => c.status), [200, 401, 401, 204, 401]);
    for (const reply of calls) {
      assert.ok(!reply.text.includes(token), 'no answer repeats the token');
      assert.ok(!JSON.stringify(reply.headers).includes(token), 'no header repeats the token');
    }

    h.t.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    let bytes = 0;
    for (const file of ['car.db', 'car.db-wal']) {
      const full = path.join(h.t.dir, file);
      if (!fs.existsSync(full)) continue;
      const data = fs.readFileSync(full);
      bytes += data.length;
      assert.ok(!data.includes(token), `${file} does not hold the token`);
      assert.ok(!data.includes(token.slice(4)), `${file} does not hold the secret part of the token`);
    }
    assert.ok(bytes > 4096, 'the scan read a real database');
    const logText = JSON.stringify(h.t.logs);
    assert.ok(!logText.includes(token) && !logText.includes(token.slice(4)), 'no log line holds the token');
    assert.ok(!logText.includes(digest), 'nor its digest');
    assert.ok(h.t.logs.length > 5, 'the scan read real log lines');
  });
});

test('the digest comparison is constant-time and the token is never compared as text', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'tokens.ts'), 'utf8');
  assert.match(source, /crypto\.timingSafeEqual\(/, 'timingSafeEqual is used');
  assert.doesNotMatch(source, /(digest|token_hash)\s*[!=]==|[!=]==\s*(digest|row\.token_hash)/, 'no plain comparison of a token digest');
});

// ------------------------------------------------------------------- who may use a token

test('a bearer opens the four read-only routes; a missing, malformed, unknown or revoked one is a 401 that says Bearer', async () => {
  await withHousehold({}, async (h) => {
    const { token, id } = await mint(h.anna);
    const anon = h.t.client();
    for (const route of V1) {
      const good = await anon.get(route, bearer(token));
      assert.equal(good.status, 200, `${route}: ${good.text}`);
      assert.equal(good.headers['cache-control'], 'no-store');
    }
    const unknown = `pat_${crypto.randomBytes(32).toString('base64url')}`;
    const bad: Array<[string, Record<string, string>]> = [
      ['no header', {}],
      ['empty header', { Authorization: '' }],
      ['basic scheme', { Authorization: `Basic ${token}` }],
      ['no scheme', { Authorization: token }],
      ['bearer with nothing', { Authorization: 'Bearer ' }],
      ['two spaces', { Authorization: `Bearer  ${token}` }],
      ['token plus junk', { Authorization: `Bearer ${token} extra` }],
      ['truncated', bearer(token.slice(0, -1))],
      ['wrong prefix', bearer(`xyz_${token.slice(4)}`)],
      ['unknown token', bearer(unknown)],
      ['a session token is not an access token', bearer(h.anna.cookies.values().next().value as string)],
    ];
    for (const [label, headers] of bad) {
      for (const route of V1) {
        const r = await anon.get(route, headers);
        assert.equal(r.status, 401, `${label} on ${route}`);
        assert.equal(r.headers['www-authenticate'], 'Bearer', label);
        assert.equal(r.body.error.code, 'unauthenticated');
      }
      // Every wrong header is a counted guess: let the window pass, so the address is not counted out half way.
      h.t.clock.advance(16 * 60_000);
    }
    // Lower-case scheme is fine (the scheme is case-insensitive).
    assert.equal((await anon.get('/api/v1/me', { Authorization: `bearer ${token}` })).status, 200);

    assert.equal((await h.anna.del(`/api/tokens/${id}`)).status, 204);
    for (const route of V1) assert.equal((await anon.get(route, bearer(token))).status, 401, `${route} after revoking`);
  });
});

test('a session cookie never opens /api/v1/, and a bearer never opens the cookie API', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.anna);
    for (const route of V1) {
      const r = await h.anna.get(route); // a valid session cookie, no bearer
      assert.equal(r.status, 401, route);
      assert.equal(r.headers['www-authenticate'], 'Bearer');
    }
    // Both at once: the token decides on /api/v1/ and the cookie everywhere else.
    assert.equal((await h.anna.get('/api/v1/me', bearer(token))).status, 200);
    assert.equal((await h.t.client().get('/api/auth/me', bearer(token))).status, 401, 'a bearer alone on a cookie route');
    assert.equal((await h.t.client().get('/api/reservations', bearer(token))).status, 401);
    assert.equal((await h.t.client().get('/api/stats', bearer(token))).status, 401);
  });
});

test('route table sweep: every /api/v1/ route is a GET with the token level, and no other route takes a token', async () => {
  await withHousehold({}, async (h) => {
    const routes = h.t.app.router.routes;
    const v1 = routes.filter((r) => r.pattern === '/api/v1' || r.pattern.startsWith('/api/v1/'));
    assert.deepEqual(v1.map((r) => `${r.method} ${r.pattern}`).sort(), V1.map((p) => `GET ${p}`).sort(), 'exactly the four documented routes');
    for (const r of v1) assert.equal(r.auth, 'token', `${r.method} ${r.pattern}`);
    assert.deepEqual(
      routes.filter((r) => r.auth === 'token' && !v1.includes(r)).map((r) => `${r.method} ${r.pattern}`),
      [],
      'no route outside /api/v1/ uses the token level',
    );
    assert.deepEqual(routes.filter((r) => r.pattern.includes('/admin') && r.pattern.startsWith('/api/v1')), [], 'no admin route under /api/v1/');
    assert.ok(routes.length > 40, 'the sweep saw the whole table');

    // Every route that is not public refuses a bearer on its own (no cookie): 401, never 403 or a handler's answer.
    const { token } = await mint(h.anna);
    let swept = 0;
    for (const r of routes) {
      if (r.auth === 'public' || r.auth === 'token') continue;
      const target = r.pattern.replace(/:[a-zA-Z]+/g, '1');
      const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}';
      const headers: Record<string, string> = { ...bearer(token), ...(r.method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(body ? { 'Content-Length': '2' } : {}) };
      const reply = await rawRequest(h.t.port, r.method, target, headers, body);
      assert.equal(reply.status, 401, `${r.method} ${r.pattern} must not take a bearer`);
      swept++;
    }
    assert.ok(swept > 40, `${swept} routes were swept`);
  });
});

test('other methods and unknown paths under /api/v1/ are refused, even with a good token', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.anna);
    const headers = { ...bearer(token), 'Content-Type': 'application/json' };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const route of V1) {
        const r = await rawRequest(h.t.port, method, route, headers, method === 'DELETE' ? undefined : '{}');
        assert.ok(r.status === 404 || r.status === 405, `${method} ${route} answered ${r.status}`);
        assert.notEqual(r.status, 200);
      }
    }
    for (const unknown of ['/api/v1', '/api/v1/', '/api/v1/users', '/api/v1/admin/users', '/api/v1/tokens', '/api/v1/me/extra', '/api/v1/reservations/1']) {
      const r = await h.t.client().get(unknown, bearer(token));
      assert.equal(r.status, 404, unknown);
    }
    assert.equal((await h.t.client().request('HEAD', '/api/v1/me', undefined, bearer(token))).status, 404, 'no HEAD either');
  });
});

test('Router.add refuses a token route that is not a GET under /api/v1/, and any other route under /api/v1/', () => {
  const router = new Router(() => null, false);
  const handler = () => ({ status: 200 });
  assert.throws(() => router.add('POST', '/api/v1/x', 'token', handler), /Only GET routes/);
  assert.throws(() => router.add('GET', '/api/other', 'token', handler), /Only GET routes/);
  assert.throws(() => router.add('GET', '/api/v1x/y', 'token', handler), /Only GET routes/, 'a look-alike prefix is not the prefix');
  assert.throws(() => router.add('GET', '/api/v1/x', 'user', handler), /must use token authentication/);
  assert.throws(() => router.add('GET', '/api/v1', 'public', handler), /must use token authentication/);
  assert.throws(() => router.add('DELETE', '/api/v1/x', 'admin', handler), /must use token authentication/);
  router.add('GET', '/api/v1/ok', 'token', handler);
  router.add('GET', '/api/v1x/fine', 'user', handler);
  assert.equal(router.routes.length, 2);
});

// ------------------------------------------------------------ what ends a token

test('deactivating a person deletes their tokens, and reactivating does not bring them back', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.ben);
    const other = await mint(h.carla);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(token))).status, 200);
    assert.equal((await h.admin.patch(`/api/admin/users/${h.ben.id}`, { active: false })).status, 200);
    const audit = h.t.logs.filter((l) => l['event'] === 'user.updated' && l['userId'] === h.ben.id).at(-1);
    assert.equal(audit?.['tokensRevoked'], 1, 'the audit line counts the tokens the deactivation ended');
    assert.equal(JSON.stringify(audit).includes(token), false);
    assert.deepEqual(many(h.t.db, 'SELECT id FROM api_tokens WHERE user_id = ?', h.ben.id), [], 'the rows are gone, not just flagged');
    assert.equal((await h.t.client().get('/api/v1/me', bearer(token))).status, 401);
    assert.equal((await h.admin.patch(`/api/admin/users/${h.ben.id}`, { active: true })).status, 200);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(token))).status, 401, 'still dead after reactivation');
    assert.equal((await h.ben.login('ben')).status, 200);
    assert.deepEqual((await h.ben.get('/api/tokens')).body.items, [], 'and the list is empty');
    assert.equal((await h.t.client().get('/api/v1/me', bearer(other.token))).status, 200, 'other people are not affected');
  });
});

test('a token whose owner is inactive in the database is refused even when the row survived (an old backup restored)', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.ben);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(token))).status, 200);
    h.t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(h.ben.id); // not through the admin route, which would delete the token
    assert.equal(many(h.t.db, 'SELECT id FROM api_tokens WHERE user_id = ?', h.ben.id).length, 1, 'the row is still there');
    const refused = await h.t.client().get('/api/v1/me', bearer(token));
    assert.equal(refused.status, 401);
    assert.equal(refused.headers['www-authenticate'], 'Bearer');
  });
});

test('an admin lists every token without its secret and revokes any; a member can do neither', async () => {
  await withHousehold({}, async (h) => {
    const a = await mint(h.anna, 'Anna script');
    const b = await mint(h.ben, 'Ben sensor');
    const list = await h.admin.get('/api/admin/tokens');
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.items.map((i: { id: number; name: string; userId: number; userName: string }) => [i.id, i.name, i.userId, i.userName]),
      [[a.id, 'Anna script', h.anna.id, 'Anna'], [b.id, 'Ben sensor', h.ben.id, 'Ben']],
    );
    assert.deepEqual(Object.keys(list.body.items[0]).sort(), ['createdAt', 'id', 'lastUsedAt', 'name', 'userId', 'userName']);
    assert.ok(!list.text.includes(a.token) && !list.text.includes(b.token) && !list.text.includes(sha256Hex(a.token)), 'never the token, never its digest');

    assert.equal((await h.anna.get('/api/admin/tokens')).status, 403);
    assert.equal((await h.anna.del(`/api/admin/tokens/${b.id}`)).status, 403);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(b.token))).status, 200, 'a member could not revoke it');

    assert.equal((await h.admin.del(`/api/admin/tokens/${b.id}`)).status, 204);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(b.token))).status, 401);
    assert.equal((await h.admin.del(`/api/admin/tokens/${b.id}`)).status, 404);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(a.token))).status, 200, 'the others stay');
    assert.ok(h.t.logs.some((l) => l['event'] === 'token.revoked' && l['id'] === b.id && l['userId'] === h.ben.id && l['by'] === h.admin.id));
  });
});

test('an admin password reset revokes that person\'s tokens; their own password change does not', async () => {
  await withHousehold({}, async (h) => {
    const anna = await mint(h.anna);
    const ben = await mint(h.ben);
    // The person changes their own password: sessions elsewhere end, tokens stay (docs/API.md says so).
    const own = await h.anna.post('/api/auth/password', { currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' });
    assert.equal(own.status, 204);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(anna.token))).status, 200, 'their own change leaves the token');

    const reset = await h.admin.post(`/api/admin/users/${h.ben.id}/password`, {});
    assert.equal(reset.status, 200);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(ben.token))).status, 401, 'the reset ended the token');
    assert.deepEqual(many(h.t.db, 'SELECT id FROM api_tokens WHERE user_id = ?', h.ben.id), []);
    assert.equal((await h.t.client().get('/api/v1/me', bearer(anna.token))).status, 200, 'nobody else lost anything');
    assert.ok(h.t.logs.some((l) => l['event'] === 'user.password_reset' && l['userId'] === h.ben.id && l['tokensRevoked'] === 1));
  });
});

// --------------------------------------------------------------------- the limits

test('last_used_at is written at most once an hour per token', async () => {
  await withHousehold({}, async (h) => {
    const { token, id } = await mint(h.anna);
    const anon = h.t.client();
    const used = (): string | null => one<{ last_used_at: string | null }>(h.t.db, 'SELECT last_used_at FROM api_tokens WHERE id = ?', id)?.last_used_at ?? null;
    assert.equal(used(), null, 'not used yet');
    const first = h.t.clock.now().toISOString();
    await anon.get('/api/v1/me', bearer(token));
    assert.equal(used(), first);
    // Count the writes: an UPDATE on api_tokens that changes a row.
    h.t.clock.advance(59 * 60_000);
    await anon.get('/api/v1/me', bearer(token));
    await anon.get('/api/v1/me', bearer(token));
    assert.equal(used(), first, 'within the hour: not written');
    h.t.clock.advance(60_000); // exactly an hour after the first write
    await anon.get('/api/v1/me', bearer(token));
    const second = h.t.clock.now().toISOString();
    assert.equal(used(), second, 'after the hour: written once');
    h.t.clock.advance(30 * 60_000);
    await anon.get('/api/v1/me', bearer(token));
    assert.equal(used(), second, 'and the hour starts again');
    assert.equal((await h.anna.get('/api/tokens')).body.items[0].lastUsedAt, second, 'the list shows it');
    // A failed attempt never writes it.
    h.t.clock.advance(2 * 3_600_000);
    await anon.get('/api/v1/me', bearer(`${token}x`));
    assert.equal(used(), second);
  });
});

test('a token GET inside the hour does not even attempt a write, and a failing last-used write does not fail the request', async () => {
  await withHousehold({}, async (h) => {
    const { token, id } = await mint(h.anna);
    const anon = h.t.client();
    // Every statement that is prepared on the connection, so a write attempt is visible even if it would change no row.
    const prepared: string[] = [];
    const db = h.t.db as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare.bind(h.t.db);
    db.prepare = (sql: string) => {
      prepared.push(sql);
      return original(sql);
    };
    const writesToTokens = (): number => prepared.filter((s) => /UPDATE\s+api_tokens/i.test(s)).length;
    try {
      assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 200);
      assert.equal(writesToTokens(), 1, 'the first use writes once');
      for (let i = 0; i < 5; i++) assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 200);
      h.t.clock.advance(59 * 60_000);
      assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 200);
      assert.equal(writesToTokens(), 1, 'six more reads inside the hour: no UPDATE statement was run at all (no write lock taken)');

      // The write is bookkeeping: when it fails (the database is locked by another process, here a trigger), the answer is still 200.
      h.t.db.exec("CREATE TRIGGER no_token_updates BEFORE UPDATE ON api_tokens BEGIN SELECT RAISE(ABORT, 'locked'); END");
      h.t.clock.advance(2 * 60_000);
      const answered = await anon.get('/api/v1/me', bearer(token));
      assert.equal(answered.status, 200, answered.text);
      const failed = h.t.logs.filter((l) => l['event'] === 'token.last_used_failed');
      assert.deepEqual(failed.map((l) => l['tokenId']), [id], 'the failure is logged, with the id only');
      assert.equal(JSON.stringify(failed).includes(token), false);
      assert.equal(h.t.logs.some((l) => l['event'] === 'error'), false, 'and it is not a server error');
    } finally {
      db.prepare = original;
    }
  });
});

test('failed attempts are counted per address before any lookup: the 31st gets 429 with Retry-After, even with a valid token', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.anna);
    const anon = h.t.client();
    // Requests without a header are answered but are not guesses: they are not counted.
    for (let i = 0; i < 40; i++) assert.equal((await anon.get('/api/v1/me')).status, 401);
    assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 200, 'still fine after 40 header-less requests');
    for (let i = 0; i < 30; i++) {
      const r = await anon.get('/api/v1/me', bearer(`pat_${crypto.randomBytes(32).toString('base64url')}`));
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const blocked = await anon.get('/api/v1/me', bearer(token));
    assert.equal(blocked.status, 429, 'a valid token from a counted-out address is refused too');
    assert.equal(blocked.body.error.code, 'too_many_attempts');
    assert.ok(Number(blocked.headers['retry-after']) >= 1 && Number(blocked.headers['retry-after']) <= 900);
    assert.ok(h.t.logs.some((l) => l['event'] === 'token.rate_limited' && typeof l['ip'] === 'string'));
    assert.ok(h.t.logs.some((l) => l['event'] === 'token.auth_failed'));
    // After the window the address is let back in.
    h.t.clock.advance(15 * 60_000 + 1000);
    assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 200);
  });
});

test('failures are counted by IPv6 /64, and the bearer, the login and the feed keep separate counters', async () => {
  await withHousehold({ overrides: { trustProxy: true } }, async (h) => {
    const { token } = await mint(h.anna);
    const anon = h.t.client();
    const from = (n: number): Record<string, string> => ({ 'X-Forwarded-For': `2001:db8:1:2:${n.toString(16)}::${n.toString(16)}` });
    // 30 guesses, each from another address of one /64.
    for (let i = 1; i <= 30; i++) assert.equal((await anon.get('/api/v1/me', { ...from(i), ...bearer(`pat_${crypto.randomBytes(32).toString('base64url')}`) })).status, 401);
    assert.equal((await anon.get('/api/v1/me', { ...from(99), ...bearer(token) })).status, 429, 'one more address of the same /64 is counted out');
    assert.equal((await anon.get('/api/v1/me', { 'X-Forwarded-For': '2001:db8:1:3::1', ...bearer(token) })).status, 200, 'the next /64 is a different client');
    assert.equal((await anon.get('/api/v1/me', { 'X-Forwarded-For': '192.0.2.7', ...bearer(token) })).status, 200, 'and so is an IPv4 address');
    // The login has its own counter: the same address is not locked out of signing in.
    const login = await h.t.client().post('/api/auth/login', { username: 'anna', password: 'correct-horse-battery' }, from(7));
    assert.equal(login.status, 200, 'bad tokens do not lock anybody out of the login');
  });
});

test('one token may make 60 requests a minute; the 61st gets 429 for that token only', async () => {
  await withHousehold({}, async (h) => {
    const a = await mint(h.anna);
    const b = await mint(h.ben);
    const anon = h.t.client();
    for (let i = 0; i < TOKEN_REQUESTS_PER_MINUTE; i++) assert.equal((await anon.get('/api/v1/status', bearer(a.token))).status, 200, `request ${i + 1}`);
    const over = await anon.get('/api/v1/status', bearer(a.token));
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, 'rate_limited');
    assert.ok(Number(over.headers['retry-after']) >= 1 && Number(over.headers['retry-after']) <= 60);
    assert.equal((await anon.get('/api/v1/status', bearer(b.token))).status, 200, 'another token is not affected');
    assert.equal((await h.t.client().get('/api/v1/status', { ...bearer(a.token) })).status, 429, 'still over');
    // Over the limit is not a failed guess: the address is not counted out.
    assert.equal((await anon.get('/api/v1/me', bearer(b.token))).status, 200);
    h.t.clock.advance(60_000);
    assert.equal((await anon.get('/api/v1/status', bearer(a.token))).status, 200, 'a new minute');
    assert.ok(h.t.logs.some((l) => l['event'] === 'token.rate_limited' && l['tokenId'] === a.id));
  });
});

// ---------------------------------------------------------------------- the audit trail

test('audit lines carry ids and the address only: never the token, its digest, its name or a username', async () => {
  await withHousehold({}, async (h) => {
    const { token, id } = await mint(h.anna, 'Secret Sensor Name');
    const anon = h.t.client();
    await anon.get('/api/v1/me', bearer(token));
    await anon.get('/api/v1/me', bearer('pat_' + 'A'.repeat(43)));
    await h.anna.del(`/api/tokens/${id}`);
    const lines = h.t.logs.filter((l) => String(l['event']).startsWith('token.'));
    assert.deepEqual(
      lines.map((l) => l['event']),
      ['token.created', 'token.auth_failed', 'token.revoked'],
    );
    assert.deepEqual(lines[0], { event: 'token.created', id, userId: h.anna.id });
    assert.deepEqual(lines[2], { event: 'token.revoked', id, userId: h.anna.id, by: h.anna.id });
    assert.equal(lines[1]?.['ip'], '127.0.0.1');
    const everything = JSON.stringify(h.t.logs);
    for (const secret of [token, token.slice(4), sha256Hex(token), 'Secret Sensor Name', 'A'.repeat(43)]) assert.ok(!everything.includes(secret), `a log line holds ${secret.slice(0, 8)}...`);
    // The access log line of the request that used the token has the path and the status, nothing of the header.
    const access = h.t.logs.filter((l) => l['event'] === 'http' && l['path'] === '/api/v1/me');
    assert.equal(access.length, 2);
    assert.deepEqual(Object.keys(access[0] as object).sort(), ['event', 'ip', 'method', 'ms', 'path', 'rid', 'status']);
  });
});

test('an admin\'s token is a member\'s token: role-blind, with no admin route reachable', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.admin);
    const anon = h.t.client();
    const me = await anon.get('/api/v1/me', bearer(token));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.displayName, 'Admin');
    assert.ok(!('role' in me.body.user), 'the role is not part of the answer');
    assert.equal((await anon.get('/api/admin/users', bearer(token))).status, 401);
    assert.equal((await anon.get('/api/admin/tokens', bearer(token))).status, 401);
  });
});

// ------------------------------------------------ the edges of the bearer scheme (what a script or a web page can try)

test('a token is read from the Authorization header and from nowhere else: not a query string, a cookie, another header or Basic credentials', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.anna);
    const anon = h.t.client();
    const sessionCookie = [...h.anna.cookies.keys()][0] as string;
    const attempts: Array<[string, string, Record<string, string>]> = [
      ['access_token in the query', `/api/v1/me?access_token=${token}`, {}],
      ['token in the query', `/api/v1/me?token=${token}`, {}],
      ['api_key in the query', `/api/v1/status?api_key=${token}`, {}],
      ['a cookie called token', '/api/v1/me', { Cookie: `token=${token}` }],
      ['the token in the session cookie', '/api/v1/me', { Cookie: `${sessionCookie}=${token}` }],
      ['X-API-Key', '/api/v1/me', { 'X-API-Key': token }],
      ['X-Access-Token', '/api/v1/me', { 'X-Access-Token': token }],
      ['Proxy-Authorization', '/api/v1/me', { 'Proxy-Authorization': `Bearer ${token}` }],
      ['the token as the password of Basic credentials', '/api/v1/me', { Authorization: `Basic ${Buffer.from(`anna:${token}`).toString('base64')}` }],
    ];
    for (const [label, target, headers] of attempts) {
      const r = await anon.get(target, headers);
      assert.equal(r.status, 401, label);
      assert.equal(r.headers['www-authenticate'], 'Bearer', label);
      assert.ok(!r.text.includes(token), `${label}: the answer does not repeat the token`);
    }
    // A stray query value neither breaks a good header nor stands in for a missing one.
    assert.equal((await anon.get('/api/v1/me?access_token=junk', bearer(token))).status, 200);
    // The query string of a request that was refused is in no log line either.
    assert.ok(!JSON.stringify(h.t.logs).includes(token), 'a token put in a URL by mistake is not written down by the server');
  });
});

test('the token API is for servers, not for web pages: no CORS headers on an answer, no permission on a preflight, and the feed is no different', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.anna);
    const feed = (await h.anna.post('/api/calendar-feed', {})).body.feed.path as string;
    const web = { Origin: 'https://evil.example' };
    const corsHeaders = (headers: Record<string, unknown>): string[] => Object.keys(headers).filter((name) => name.startsWith('access-control-'));
    const targets: Array<[string, Record<string, string>]> = [...V1.map((route): [string, Record<string, string>] => [route, bearer(token)]), [feed, {}]];
    for (const [target, auth] of targets) {
      const answer = await h.t.client().get(target, { ...auth, ...web });
      assert.equal(answer.status, 200, target);
      assert.deepEqual(corsHeaders(answer.headers), [], `${target}: nothing lets a page of another site read the answer`);
      const refused = await h.t.client().get(target, web);
      assert.deepEqual(corsHeaders(refused.headers), [], `${target}: nor the refusal`);

      const preflight = await rawRequest(h.t.port, 'OPTIONS', target, { ...web, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' });
      assert.ok(preflight.status >= 400, `${target}: a preflight is not answered with permission (answered ${preflight.status})`);
      assert.deepEqual(corsHeaders(preflight.headers), [], `${target}: and carries no CORS header`);
    }
  });
});

test('with no proxy in front, a forged X-Forwarded-For does not hide a guesser: the address that is counted is the connection\'s, for the token API and the feed alike', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.anna);
    const feed = (await h.anna.post('/api/calendar-feed', {})).body.feed.path as string;
    const anon = h.t.client();
    const forged = (n: number): Record<string, string> => ({ 'X-Forwarded-For': `203.0.113.${n}`, 'X-Real-IP': `198.51.100.${n}`, Forwarded: `for=192.0.2.${n}`, 'CF-Connecting-IP': `203.0.113.${n}` });
    const guess = (): string => `pat_${crypto.randomBytes(32).toString('base64url')}`;
    for (let i = 1; i <= 30; i++) assert.equal((await anon.get('/api/v1/me', { ...bearer(guess()), ...forged(i) })).status, 401, `guess ${i}`);
    const blocked = await anon.get('/api/v1/me', { ...bearer(token), ...forged(200) });
    assert.equal(blocked.status, 429, 'a new "address" in every request did not reset the count');
    assert.ok(h.t.logs.filter((l) => l['event'] === 'token.auth_failed').every((l) => l['ip'] === '127.0.0.1'), 'every failure was counted against the real address');

    h.t.clock.advance(16 * 60_000);
    for (let i = 1; i <= 30; i++) assert.equal((await anon.get(`/api/calendar/${crypto.randomBytes(32).toString('base64url')}.ics`, forged(i))).status, 404);
    assert.equal((await anon.get(feed, forged(201))).status, 429, 'the feed counts the real address too');
    assert.ok(h.t.logs.filter((l) => l['event'] === 'calendar.miss').every((l) => l['ip'] === '127.0.0.1'));
  });
});

test('editing a person (name, role, "active" left as it was) does not end their tokens or their calendar link; only deactivating does', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.ben);
    const feed = (await h.ben.post('/api/calendar-feed', {})).body.feed.path as string;
    const anon = h.t.client();
    for (const change of [{ displayName: 'Benny' }, { role: 'admin' }, { role: 'member' }, { active: true }, { displayName: 'Ben', role: 'member', active: true }]) {
      assert.equal((await h.admin.patch(`/api/admin/users/${h.ben.id}`, change)).status, 200, JSON.stringify(change));
      assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 200, `the token after ${JSON.stringify(change)}`);
      assert.equal((await anon.get(feed)).status, 200, `the link after ${JSON.stringify(change)}`);
    }
    assert.ok(!h.t.logs.some((l) => l['event'] === 'user.updated' && l['tokensRevoked'] !== undefined), 'no edit claims to have revoked anything');
    assert.equal((await h.admin.patch(`/api/admin/users/${h.ben.id}`, { active: false })).status, 200);
    assert.equal((await anon.get('/api/v1/me', bearer(token))).status, 401);
    assert.equal((await anon.get(feed)).status, 404);
  });
});

test('docs/API.md says every other method on /api/v1/ is the 404 of a path that does not exist, down to the body, so a route cannot be told from a miss', async () => {
  await withHousehold({}, async (h) => {
    const { token } = await mint(h.anna);
    const unknown = await h.t.client().get('/api/v1/does-not-exist', bearer(token));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'not_found');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const route of V1) {
        const r = await rawRequest(h.t.port, method, route, { ...bearer(token), 'Content-Type': 'application/json' }, method === 'DELETE' || method === 'OPTIONS' ? undefined : '{}');
        assert.equal(r.status, 404, `${method} ${route}`);
        assert.deepEqual(r.body, unknown.body, `${method} ${route} is answered like a path that does not exist`);
        assert.equal(r.headers['allow'], undefined, 'no Allow header that names the one method there is');
      }
    }
    // The same for a request with no token at all: the route is behind the token check, the other methods are not.
    const bare = await rawRequest(h.t.port, 'POST', '/api/v1/me', { 'Content-Type': 'application/json' }, '{}');
    assert.equal(bare.status, 404);
  });
});

test('every route that writes refuses a cross-site request, even from a signed-in person, and the token and link cards change nothing when it does', async () => {
  await withHousehold({}, async (h) => {
    const made = await mint(h.anna);
    await h.anna.post('/api/calendar-feed', {});
    const snapshot = (): unknown => ({
      // (not last_used_at: using the token at the end of the test is allowed to write it)
      tokens: many(h.t.db, 'SELECT id, user_id, name, token_hash FROM api_tokens ORDER BY id'),
      feeds: many(h.t.db, 'SELECT user_id, secret, secret_hash FROM calendar_feeds ORDER BY user_id'),
    });
    const before = snapshot();
    const foreign: Array<Record<string, string>> = [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }];

    // The whole route table: no write route (new ones included) may skip the check. An admin session is the strongest cookie.
    const writes = h.t.app.router.routes.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    assert.ok(writes.length > 30, `${writes.length} write routes were swept`);
    for (const r of writes) {
      const target = r.pattern.replace(/:[a-zA-Z]+/g, '1');
      for (const extra of foreign) {
        const reply = await h.admin.request(r.method, target, r.method === 'DELETE' ? undefined : {}, extra);
        assert.equal(reply.status, 403, `${r.method} ${r.pattern} with ${JSON.stringify(extra)}`);
        assert.equal(reply.body.error.code, 'csrf', `${r.method} ${r.pattern}`);
      }
    }

    // The routes of the two Account cards, with real ids, as their owner.
    const cards: Array<[string, string, unknown]> = [
      ['POST', '/api/tokens', { name: 'evil' }],
      ['DELETE', `/api/tokens/${made.id}`, undefined],
      ['POST', '/api/calendar-feed', {}],
      ['POST', '/api/calendar-feed/new-link', {}],
      ['DELETE', '/api/calendar-feed', undefined],
    ];
    for (const [method, target, body] of cards) {
      for (const extra of foreign) assert.equal((await h.anna.request(method, target, body, extra)).status, 403, `${method} ${target} ${JSON.stringify(extra)}`);
    }
    assert.equal((await h.admin.del(`/api/admin/tokens/${made.id}`, { Origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(snapshot(), before, 'no token and no link was made, replaced or removed');
    assert.equal((await h.t.client().get('/api/v1/me', bearer(made.token))).status, 200, 'the token still works');

    // What an HTML form on a hostile page can send without a preflight is not JSON, and is refused too.
    const cookie = [...h.anna.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
      const form = await rawRequest(h.t.port, 'POST', '/api/tokens', { Cookie: cookie, 'Content-Type': contentType }, 'name=evil');
      assert.equal(form.status, 415, contentType);
    }
    assert.deepEqual(snapshot(), before);

    // And the control: the same call from this site, as the page makes it, works.
    const sameSite = await h.anna.post('/api/tokens', { name: 'mine' }, { Origin: `http://127.0.0.1:${h.t.port}`, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(sameSite.status, 201, sameSite.text);
  });
});
