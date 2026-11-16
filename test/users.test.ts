import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { countRows, openDb, one } from '../src/db.ts';
import { bootstrapAdmin } from '../src/users.ts';
import { createHousehold, createTestApp, PASSWORD } from './helpers.ts';

test('members cannot use any admin route', async () => {
  const { t, anna } = await createHousehold();
  try {
    assert.equal((await anna.get('/api/admin/users')).status, 403);
    assert.equal((await anna.post('/api/admin/users', { username: 'eve', displayName: 'Eve', password: PASSWORD })).status, 403);
    assert.equal((await anna.patch('/api/admin/users/1', { role: 'admin' })).status, 403);
    assert.equal((await anna.post('/api/admin/users/1/password', { password: PASSWORD })).status, 403);
    assert.equal((await anna.get('/api/admin/retention')).status, 403);
    assert.equal((await anna.post('/api/admin/retention/run')).status, 403);
  } finally {
    await t.close();
  }
});

test('admin creates users; usernames are unique, normalised and validated', async () => {
  const t = await createTestApp();
  try {
    const admin = await t.signIn('admin', 'admin');
    const ok = await admin.post('/api/admin/users', { username: ' Dora ', displayName: 'Dora', password: PASSWORD });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.username, 'dora');
    assert.equal(ok.body.user.role, 'member');
    assert.equal(ok.body.user.active, true);
    assert.equal(ok.body.user.passwordHash, undefined);
    assert.equal(ok.body.generatedPassword, undefined);

    const dup = await admin.post('/api/admin/users', { username: 'DORA', displayName: 'Other', password: PASSWORD });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'username_taken');

    const bad = await admin.post('/api/admin/users', { username: 'a b', displayName: '', password: 'short' });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.body.error.fields).sort(), ['displayName', 'password', 'username']);

    const bogusRole = await admin.post('/api/admin/users', { username: 'eve', displayName: 'Eve', password: PASSWORD, role: 'root' });
    assert.equal(bogusRole.status, 422);

    const listed = await admin.get('/api/admin/users');
    assert.deepEqual(listed.body.users.map((u: { username: string }) => u.username).sort(), ['admin', 'dora']);

    const dora = t.client();
    assert.equal((await dora.login('dora')).status, 200);
  } finally {
    await t.close();
  }
});

test('a generated password is returned once and works', async () => {
  const t = await createTestApp();
  try {
    const admin = await t.signIn('admin', 'admin');
    const made = await admin.post('/api/admin/users', { username: 'dora', displayName: 'Dora' });
    assert.equal(made.status, 201);
    assert.ok(made.body.generatedPassword.length >= 10);
    assert.equal((await t.client().login('dora', made.body.generatedPassword)).status, 200);
  } finally {
    await t.close();
  }
});

test('deactivated users cannot log in and lose their sessions; reactivation restores access', async () => {
  const t = await createTestApp();
  try {
    const admin = await t.signIn('admin', 'admin');
    const anna = await t.signIn('anna');
    assert.equal((await anna.get('/api/auth/me')).status, 200);
    const off = await admin.patch(`/api/admin/users/${anna.id}`, { active: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.user.active, false);
    assert.equal((await anna.get('/api/auth/me')).status, 401);
    assert.equal(one<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', anna.id)?.n, 0);
    assert.equal((await t.client().login('anna')).status, 401);
    const users = await admin.get('/api/users');
    assert.deepEqual(users.body.users.map((u: { username: string }) => u.username), ['admin']);

    assert.equal((await admin.patch(`/api/admin/users/${anna.id}`, { active: true })).status, 200);
    assert.equal((await t.client().login('anna')).status, 200);
  } finally {
    await t.close();
  }
});

test('admin resets a password; old password and old sessions stop working', async () => {
  const t = await createTestApp();
  try {
    const admin = await t.signIn('admin', 'admin');
    const anna = await t.signIn('anna');
    const reset = await admin.post(`/api/admin/users/${anna.id}/password`, { password: 'fresh-password-123' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.generatedPassword, undefined);
    assert.equal((await anna.get('/api/auth/me')).status, 401);
    assert.equal((await t.client().login('anna')).status, 401);
    assert.equal((await t.client().login('anna', 'fresh-password-123')).status, 200);

    const generated = await admin.post(`/api/admin/users/${anna.id}/password`, {});
    assert.equal((await t.client().login('anna', generated.body.generatedPassword)).status, 200);
    assert.equal((await admin.post('/api/admin/users/9999/password', {})).status, 404);
    assert.equal((await admin.post(`/api/admin/users/${anna.id}/password`, { password: 'short' })).status, 422);
  } finally {
    await t.close();
  }
});

test('the last active admin cannot be deactivated or demoted', async () => {
  const t = await createTestApp();
  try {
    const admin = await t.signIn('admin', 'admin');
    const off = await admin.patch(`/api/admin/users/${admin.id}`, { active: false });
    assert.equal(off.status, 409);
    assert.equal(off.body.error.code, 'last_admin');
    assert.equal((await admin.patch(`/api/admin/users/${admin.id}`, { role: 'member' })).status, 409);
    assert.equal((await admin.get('/api/auth/me')).status, 200);

    const second = await t.signIn('boss', 'admin');
    assert.equal((await admin.patch(`/api/admin/users/${second.id}`, { role: 'member' })).status, 200);
    assert.equal((await second.get('/api/admin/users')).status, 403, 'role change takes effect immediately');
    assert.equal((await admin.patch(`/api/admin/users/${admin.id}`, { active: false })).status, 409);
    assert.equal((await admin.patch(`/api/admin/users/${admin.id}`, { displayName: 'Chief' })).status, 200);
  } finally {
    await t.close();
  }
});

test('unknown user ids are 404 and ids are validated', async () => {
  const t = await createTestApp();
  try {
    const admin = await t.signIn('admin', 'admin');
    assert.equal((await admin.patch('/api/admin/users/9999', { active: false })).status, 404);
    assert.equal((await admin.patch('/api/admin/users/abc', { active: false })).status, 404);
    assert.equal((await admin.patch('/api/admin/users/1', { active: 'no' })).status, 422);
  } finally {
    await t.close();
  }
});

test('bootstrapAdmin creates the first admin from env only while there are no users', async () => {
  const t = await createTestApp({ env: { ADMIN_USERNAME: 'Root', ADMIN_PASSWORD: 'bootstrap-password-1' } });
  try {
    assert.equal(await bootstrapAdmin(t.ctx), true);
    const row = one<{ username: string; role: string }>(t.db, 'SELECT username, role FROM users');
    assert.deepEqual({ ...row }, { username: 'root', role: 'admin' });
    assert.equal(await bootstrapAdmin(t.ctx), false);
    assert.equal(countRows(t.db, 'users'), 1);
    assert.equal((await t.client().login('root', 'bootstrap-password-1')).status, 200);
  } finally {
    await t.close();
  }
});

test('bootstrapAdmin explains which setting is wrong, without echoing the password', async () => {
  const t = await createTestApp({ env: { ADMIN_USERNAME: 'Root', ADMIN_PASSWORD: 'short-pw' } });
  try {
    await assert.rejects(bootstrapAdmin(t.ctx), (err: Error) => {
      assert.match(err.message, /ADMIN_USERNAME \/ ADMIN_PASSWORD rejected/);
      assert.match(err.message, /"password":"too_short"/);
      assert.doesNotMatch(err.message, /short-pw/);
      return true;
    });
    assert.equal(countRows(t.db, 'users'), 0);
  } finally {
    await t.close();
  }
});

test('bootstrapAdmin does nothing without env, or when users already exist', async () => {
  const none = await createTestApp();
  try {
    assert.equal(await bootstrapAdmin(none.ctx), false);
    assert.equal(countRows(none.db, 'users'), 0);
  } finally {
    await none.close();
  }
  const some = await createTestApp({ env: { ADMIN_USERNAME: 'root', ADMIN_PASSWORD: 'bootstrap-password-1' } });
  try {
    await some.signIn('anna');
    assert.equal(await bootstrapAdmin(some.ctx), false);
    assert.equal(countRows(some.db, 'users'), 1);
  } finally {
    await some.close();
  }
});

// ------------------------------------------------------------------- the CLI

function cliHarness(stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { readStdin: async () => stdin, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { io, out, err };
}

test('CLI: create-admin, reset-password, backup and purge work against the data dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-cli-'));
  const env = { DATA_DIR: dir, SCRYPT_N: '1024', SCRYPT_P: '1', HOUSEHOLD_TZ: 'Europe/Amsterdam' };
  try {
    const stdin = cliHarness('stdin-password-1\n');
    assert.equal(await runCli(['create-admin', 'Lars', '--name', 'Lars T', '--password-stdin'], env, stdin.io), 0);
    assert.match(stdin.out.join('\n'), /Created admin "lars"/);
    assert.doesNotMatch(stdin.out.join('\n'), /stdin-password-1/, 'a supplied password is never echoed');

    const dup = cliHarness();
    assert.equal(await runCli(['create-admin', 'lars'], env, dup.io), 1);
    assert.match(dup.err.join('\n'), /already in use/);

    const generated = cliHarness();
    assert.equal(await runCli(['create-admin', 'second'], env, generated.io), 0);
    assert.match(generated.out.join('\n'), /Generated password \(shown once\): \S{10,}/);

    const reset = cliHarness('another-password-2\n');
    assert.equal(await runCli(['reset-password', 'lars', '--password-stdin'], env, reset.io), 0);
    const missing = cliHarness();
    assert.equal(await runCli(['reset-password', 'ghost'], env, missing.io), 1);
    const weak = cliHarness('short\n');
    assert.equal(await runCli(['reset-password', 'lars', '--password-stdin'], env, weak.io), 1);

    const config = loadConfig(env);
    const db = openDb(path.join(dir, 'car.db'));
    const row = one<{ display_name: string; role: string }>(db, "SELECT display_name, role FROM users WHERE username = 'lars'");
    db.close();
    assert.deepEqual({ ...row }, { display_name: 'Lars T', role: 'admin' });

    const backup = cliHarness();
    assert.equal(await runCli(['backup'], env, backup.io), 0);
    assert.ok(fs.readdirSync(path.join(config.dataDir, 'backups')).some((f) => /^car-\d{4}-\d{2}-\d{2}\.db$/.test(f)));

    const purged = cliHarness();
    assert.equal(await runCli(['purge'], env, purged.io), 0);
    assert.match(purged.out.join('\n'), /Purged 0 reservations, 0 usage records/);

    const usage = cliHarness();
    assert.equal(await runCli([], env, usage.io), 2);
    assert.equal(await runCli(['bogus'], env, usage.io), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
