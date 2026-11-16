import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findProjectRoot, loadConfig } from '../src/config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('defaults: Amsterdam household, secure cookies, no proxy trust, 14 backups, six-month window', () => {
  const c = loadConfig({});
  assert.equal(c.tz, 'Europe/Amsterdam');
  assert.equal(c.port, 3000);
  assert.equal(c.bindHost, '127.0.0.1', 'listens on localhost unless told otherwise');
  assert.equal(c.cookieSecure, true);
  assert.equal(c.trustProxy, false);
  assert.equal(c.backupKeepDays, 14);
  assert.equal(c.windowMonths, 6);
  assert.deepEqual(c.scrypt, { N: 32768, r: 8, p: 3 });
  assert.equal(c.adminUsername, undefined);
  assert.equal(c.adminPassword, undefined);
  assert.equal(c.dataDir, path.join(root, 'data'));
  assert.equal(c.publicDir, path.join(root, 'public'));
  assert.equal(c.sharedDir, path.join(root, 'shared'));
});

test('HOUSEHOLD_TZ is configurable and must be a real IANA zone', () => {
  assert.equal(loadConfig({ HOUSEHOLD_TZ: 'America/New_York' }).tz, 'America/New_York');
  assert.equal(loadConfig({ HOUSEHOLD_TZ: 'UTC' }).tz, 'UTC');
  assert.equal(loadConfig({ HOUSEHOLD_TZ: '' }).tz, 'Europe/Amsterdam', 'an empty value means "use the default"');
  assert.throws(() => loadConfig({ HOUSEHOLD_TZ: 'Mars/Olympus' }), /HOUSEHOLD_TZ is not a valid IANA time zone: Mars\/Olympus/);
  assert.throws(() => loadConfig({ HOUSEHOLD_TZ: 'Amsterdam' }), /HOUSEHOLD_TZ/);
});

test('numbers are range-checked and fail fast, naming the variable', () => {
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
  assert.equal(loadConfig({ PORT: '1' }).port, 1);
  assert.equal(loadConfig({ PORT: '65535' }).port, 65535);
  for (const bad of ['0', '65536', 'abc', '3000.5', '-1', '1e3x']) {
    assert.throws(() => loadConfig({ PORT: bad }), /PORT must be an integer between 1 and 65535/, `PORT=${bad}`);
  }
  assert.equal(loadConfig({ BACKUP_KEEP_DAYS: '1' }).backupKeepDays, 1);
  assert.equal(loadConfig({ BACKUP_KEEP_DAYS: '365' }).backupKeepDays, 365);
  for (const bad of ['0', '366', 'many']) {
    assert.throws(() => loadConfig({ BACKUP_KEEP_DAYS: bad }), /BACKUP_KEEP_DAYS must be an integer between 1 and 365/, `BACKUP_KEEP_DAYS=${bad}`);
  }
  assert.throws(() => loadConfig({ SCRYPT_R: '0' }), /SCRYPT_R/);
  assert.throws(() => loadConfig({ SCRYPT_P: '17' }), /SCRYPT_P/);
  assert.equal(loadConfig({ PORT: '  ' }).port, 3000, 'whitespace only counts as unset');
});

test('SCRYPT_N must be a power of two inside the allowed range', () => {
  assert.equal(loadConfig({ SCRYPT_N: '1024' }).scrypt.N, 1024);
  assert.equal(loadConfig({ SCRYPT_N: '65536' }).scrypt.N, 65536);
  assert.throws(() => loadConfig({ SCRYPT_N: '3000' }), /SCRYPT_N must be a power of two/);
  assert.throws(() => loadConfig({ SCRYPT_N: '512' }), /SCRYPT_N must be an integer between 1024 and 65536/);
  assert.throws(() => loadConfig({ SCRYPT_N: '131072' }), /SCRYPT_N must be an integer between 1024 and 65536/);
});

test('booleans accept the usual spellings and reject anything else', () => {
  for (const yes of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    assert.equal(loadConfig({ TRUST_PROXY: yes }).trustProxy, true, `TRUST_PROXY=${yes}`);
  }
  for (const no of ['0', 'false', 'No', 'off']) {
    assert.equal(loadConfig({ TRUST_PROXY: no }).trustProxy, false, `TRUST_PROXY=${no}`);
  }
  assert.throws(() => loadConfig({ TRUST_PROXY: 'maybe' }), /TRUST_PROXY must be true or false/);
  assert.equal(loadConfig({ COOKIE_SECURE: 'false' }).cookieSecure, false, 'local development can opt out');
  assert.equal(loadConfig({ COOKIE_SECURE: '' }).cookieSecure, true, 'blank keeps the secure default');
  assert.throws(() => loadConfig({ COOKIE_SECURE: 'nope' }), /COOKIE_SECURE must be true or false/);
});

test('empty strings count as unset, paths become absolute and the window is not tunable from the environment', () => {
  const c = loadConfig({ ADMIN_USERNAME: '', ADMIN_PASSWORD: '', DATA_DIR: 'some/relative/dir', WINDOW_MONTHS: '1' });
  assert.equal(c.adminUsername, undefined, 'an empty ADMIN_PASSWORD line (as in .env.example) must not create an admin');
  assert.equal(c.adminPassword, undefined);
  assert.ok(path.isAbsolute(c.dataDir));
  assert.equal(c.dataDir, path.resolve('some/relative/dir'));
  assert.equal(c.windowMonths, 6, 'retention stays six months however the environment is set');
  const both = loadConfig({ ADMIN_USERNAME: 'root', ADMIN_PASSWORD: 'long-and-random-1' });
  assert.deepEqual([both.adminUsername, both.adminPassword], ['root', 'long-and-random-1']);
});

test('overrides win over the environment, and only the ones given', () => {
  const c = loadConfig({ PORT: '4000', HOUSEHOLD_TZ: 'UTC' }, { port: 1234 });
  assert.equal(c.port, 1234);
  assert.equal(c.tz, 'UTC');
});

test('findProjectRoot walks up to package.json from src, dist/src and nested folders', () => {
  assert.equal(findProjectRoot(), root);
  assert.equal(findProjectRoot(pathToFileURL(path.join(root, 'dist', 'src', 'config.js')).href), root);
  assert.equal(findProjectRoot(pathToFileURL(path.join(root, 'public', 'views', 'x.js')).href), root);
});

/** True when some folder above `dir` holds a package.json (then "no project here" cannot be tested). */
function hasPackageJsonAbove(dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

// Outside any project it must say so instead of looping or guessing. The path does not need
// to exist (only existsSync is used while walking up), so nothing is created; it sits directly
// under the file system root, which makes the result independent of where the repo or the
// temp directory live. Skipped only if the root itself holds a package.json.
const nowhere = path.join(path.parse(os.tmpdir()).root, 'car-no-such-project', 'x.js');
test('findProjectRoot throws when there is no package.json anywhere above', { skip: hasPackageJsonAbove(path.dirname(nowhere)) && 'a package.json exists at the file system root' }, () => {
  assert.throws(() => findProjectRoot(pathToFileURL(nowhere).href), /package\.json\) not found/);
});
