// The operator commands from docs/DEPLOYMENT.md, run against a real data directory.
// users.test.ts has the happy path of create-admin / reset-password / backup / purge;
// this file covers restore, argument handling and the secrets rules.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyPassword } from '../src/auth.ts';
import { runCli, type CliIo } from '../src/cli.ts';
import { countRows, many, one, openDb } from '../src/db.ts';
import { createTestApp, PASSWORD } from './helpers.ts';

const ENV = { SCRYPT_N: '1024', SCRYPT_P: '1' };

function harness(stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { readStdin: async () => stdin, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { io, out, err, all: () => [...out, ...err].join('\n') };
}

function dataDir(t: TestContext): { dir: string; env: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-cli2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { dir, env: { ...ENV, DATA_DIR: dir } };
}

function usernames(dir: string): string[] {
  const db = openDb(path.join(dir, 'car.db'));
  try {
    return many<{ username: string }>(db, 'SELECT username FROM users ORDER BY id').map((r) => r.username);
  } finally {
    db.close();
  }
}

test('restore puts a backup back, keeps a copy of what it replaced, and says so', async (t) => {
  const { dir, env } = dataDir(t);
  assert.equal(await runCli(['create-admin', 'lars'], env, harness().io), 0);
  assert.equal(await runCli(['backup'], env, harness().io), 0);
  assert.equal(await runCli(['create-admin', 'later'], env, harness().io), 0);
  assert.deepEqual(usernames(dir), ['lars', 'later']);

  const backups = path.join(dir, 'backups');
  const file = fs.readdirSync(backups).find((f) => /^car-\d{4}-\d{2}-\d{2}\.db$/.test(f)) as string;
  const restore = harness();
  assert.equal(await runCli(['restore', path.join(backups, file)], env, restore.io), 0);
  assert.match(restore.out.join('\n'), /^Restored .*car-\d{4}-\d{2}-\d{2}\.db\. Previous database saved to .*pre-restore-\d{8}T\d{6}Z\.db\.$/);

  assert.deepEqual(usernames(dir), ['lars'], 'the database is the backed-up one');
  const preRestore = fs.readdirSync(backups).find((f) => f.startsWith('pre-restore-')) as string;
  const before = openDb(path.join(backups, preRestore));
  assert.equal(countRows(before, 'users'), 2, 'the safety copy still has the user created after the backup');
  before.close();
});

test('restore without a file, with a missing file or with a corrupt file fails and leaves the database alone', async (t) => {
  const { dir, env } = dataDir(t);
  assert.equal(await runCli(['create-admin', 'lars'], env, harness().io), 0);

  const none = harness();
  assert.equal(await runCli(['restore'], env, none.io), 2);
  assert.match(none.err.join('\n'), /restore needs a backup file/);

  const missing = harness();
  assert.equal(await runCli(['restore', path.join(dir, 'nope.db')], env, missing.io), 1);
  assert.match(missing.err.join('\n'), /Backup file not found/);

  const corrupt = path.join(dir, 'corrupt.db');
  fs.writeFileSync(corrupt, 'not a database '.repeat(100));
  const bad = harness();
  assert.equal(await runCli(['restore', corrupt], env, bad.io), 1);
  assert.match(bad.err.join('\n'), /^error: /m);

  assert.deepEqual(usernames(dir), ['lars']);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false, 'no safety copy is made for a refused restore');
});

test('create-admin and reset-password need a username; an option value is never mistaken for one', async (t) => {
  const { dir, env } = dataDir(t);

  const noName = harness();
  assert.equal(await runCli(['create-admin'], env, noName.io), 2);
  assert.match(noName.err.join('\n'), /create-admin needs a username/);

  const onlyOption = harness();
  assert.equal(await runCli(['create-admin', '--name', 'Display Name'], env, onlyOption.io), 2, '"Display Name" after --name is not the username');

  const noReset = harness();
  assert.equal(await runCli(['reset-password'], env, noReset.io), 2);
  assert.match(noReset.err.join('\n'), /reset-password needs a username/);
  assert.deepEqual(usernames(dir), [], 'nothing was created by the failed attempts');

  // The option may come first.
  const reordered = harness();
  assert.equal(await runCli(['create-admin', '--name', 'Display Name', 'Lars'], env, reordered.io), 0);
  const db = openDb(path.join(dir, 'car.db'));
  const row = one<{ username: string; display_name: string; role: string }>(db, 'SELECT username, display_name, role FROM users');
  db.close();
  assert.deepEqual({ ...row }, { username: 'lars', display_name: 'Display Name', role: 'admin' });
});

test('a password piped in on Windows (CRLF) works, and no password is ever echoed or stored in plain text', async (t) => {
  const { dir, env } = dataDir(t);
  const piped = harness('windows-password-1\r\n');
  assert.equal(await runCli(['create-admin', 'lars', '--password-stdin'], env, piped.io), 0);
  const db = openDb(path.join(dir, 'car.db'));
  const stored = one<{ password_hash: string }>(db, "SELECT password_hash FROM users WHERE username = 'lars'")?.password_hash as string;
  db.close();
  assert.equal(await verifyPassword('windows-password-1', stored), true, 'the line ending is not part of the password');
  assert.equal(await verifyPassword('windows-password-1\r', stored), false);
  assert.doesNotMatch(stored, /windows-password-1/);
  assert.doesNotMatch(piped.all(), /windows-password-1/);

  // Rejected passwords: exit 1, nothing changes, and the text of the password is not repeated.
  const weakNew = harness('pw-xyz\n');
  assert.equal(await runCli(['create-admin', 'second', '--password-stdin'], env, weakNew.io), 1);
  assert.match(weakNew.err.join('\n'), /"password":"too_short"/);
  assert.doesNotMatch(weakNew.all(), /pw-xyz/);
  assert.deepEqual(usernames(dir), ['lars'], 'no account is left behind by a rejected password');

  const weakReset = harness('pw-abc\n');
  assert.equal(await runCli(['reset-password', 'lars', '--password-stdin'], env, weakReset.io), 1);
  assert.doesNotMatch(weakReset.all(), /pw-abc/);
  const db1 = openDb(path.join(dir, 'car.db'));
  const unchanged = one<{ password_hash: string }>(db1, "SELECT password_hash FROM users WHERE username = 'lars'")?.password_hash as string;
  db1.close();
  assert.equal(unchanged, stored, 'the stored hash is untouched by a rejected reset');

  // A generated password is shown once, is strong enough to be accepted, and is what gets stored.
  const generated = harness();
  assert.equal(await runCli(['reset-password', 'lars'], env, generated.io), 0);
  const shown = /Generated password \(shown once\): (\S+)/.exec(generated.out.join('\n'))?.[1] as string;
  assert.ok(shown && shown.length >= 12);
  const db2 = openDb(path.join(dir, 'car.db'));
  const after = one<{ password_hash: string }>(db2, "SELECT password_hash FROM users WHERE username = 'lars'")?.password_hash as string;
  db2.close();
  assert.equal(await verifyPassword(shown, after), true);
  assert.equal(await verifyPassword('windows-password-1', after), false);
});

test('the forgotten-password flow from the guide: reset on the command line signs the user out of a running app', async () => {
  const t = await createTestApp();
  try {
    const anna = await t.signIn('anna');
    assert.equal((await anna.get('/api/auth/me')).status, 200);

    const reset = harness('brand-new-password-9\n');
    assert.equal(await runCli(['reset-password', 'Anna', '--password-stdin'], { ...ENV, DATA_DIR: t.dir }, reset.io), 0, 'the username is case-insensitive');
    assert.match(reset.out.join('\n'), /Password reset for "anna"; all their sessions were signed out\./);

    assert.equal((await anna.get('/api/auth/me')).status, 401, 'the old session no longer works');
    assert.equal((await t.client().login('anna', PASSWORD)).status, 401, 'the old password no longer works');
    assert.equal((await t.client().login('anna', 'brand-new-password-9')).status, 200);
  } finally {
    await t.close();
  }
});

test('reset-password on the command line also revokes the access tokens of that person, and says how many', async () => {
  const t = await createTestApp();
  try {
    const anna = await t.signIn('anna');
    const ben = await t.signIn('ben');
    const made = [await anna.post('/api/tokens', { name: 'one' }), await anna.post('/api/tokens', { name: 'two' }), await ben.post('/api/tokens', { name: 'other' })];
    const [first, second, other] = made.map((r) => r.body.token as string);
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
    assert.equal((await t.client().get('/api/v1/me', bearer(first as string))).status, 200);

    const reset = harness();
    assert.equal(await runCli(['reset-password', 'anna'], { ...ENV, DATA_DIR: t.dir }, reset.io), 0);
    assert.match(reset.out.join('\n'), /Password reset for "anna"; all their sessions were signed out\. 2 access tokens were revoked\./);
    assert.equal((await t.client().get('/api/v1/me', bearer(first as string))).status, 401);
    assert.equal((await t.client().get('/api/v1/me', bearer(second as string))).status, 401);
    assert.equal((await t.client().get('/api/v1/me', bearer(other as string))).status, 200, 'somebody else keeps theirs');

    // With no token the sentence does not mention them.
    const again = harness();
    assert.equal(await runCli(['reset-password', 'anna'], { ...ENV, DATA_DIR: t.dir }, again.io), 0);
    assert.doesNotMatch(again.out.join('\n'), /access token/);
  } finally {
    await t.close();
  }
});
