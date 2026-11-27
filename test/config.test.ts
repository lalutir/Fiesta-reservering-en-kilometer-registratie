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
  assert.equal(c.pushEnabled, true);
  assert.equal(c.pushSubject, undefined, 'reminders need a DOMAIN or PUSH_CONTACT');
  assert.equal(c.tikkie, undefined, 'payment requests are manual unless Tikkie is fully configured');
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
  // The months of statistics totals that are kept: the current month and the ones before it, 24 unless told otherwise.
  assert.equal(loadConfig({}).statsRetentionMonths, 24);
  assert.equal(loadConfig({ STATS_RETENTION_MONTHS: '' }).statsRetentionMonths, 24, 'an empty value counts as unset');
  assert.equal(loadConfig({ STATS_RETENTION_MONTHS: '6' }).statsRetentionMonths, 6);
  assert.equal(loadConfig({ STATS_RETENTION_MONTHS: '120' }).statsRetentionMonths, 120);
  for (const bad of ['5', '121', '0', '-24', 'two years', '24.5', '1e3']) {
    assert.throws(() => loadConfig({ STATS_RETENTION_MONTHS: bad }), /STATS_RETENTION_MONTHS must be an integer between 6 and 120/, `STATS_RETENTION_MONTHS=${bad}`);
  }
  assert.equal(loadConfig({}).windowMonths, 6, 'the window of everything else is not configurable and stays 6');
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

test('push: the subject sent to the push services comes from DOMAIN, PUSH_CONTACT overrides it, PUSH_ENABLED switches it off', () => {
  assert.equal(loadConfig({}).pushEnabled, true);
  assert.equal(loadConfig({}).pushSubject, undefined, 'no DOMAIN, no contact: push stays off');
  assert.equal(loadConfig({ DOMAIN: 'fiesta-reserveringen.lalutir.com' }).pushSubject, 'https://fiesta-reserveringen.lalutir.com');
  assert.equal(loadConfig({ DOMAIN: ' Car.Example.COM ' }).pushSubject, 'https://car.example.com', 'normalised to lower case');
  for (const notAHost of ['localhost', 'car.example.com/path', 'https://car.example.com', 'car example.com', 'car.example.com:8443', '']) {
    assert.equal(loadConfig({ DOMAIN: notAHost }).pushSubject, undefined, `DOMAIN=${JSON.stringify(notAHost)}`);
  }
  assert.equal(loadConfig({ DOMAIN: 'car.example.com', PUSH_CONTACT: 'mailto:me@example.com' }).pushSubject, 'mailto:me@example.com');
  assert.equal(loadConfig({ PUSH_CONTACT: 'https://household.example/contact' }).pushSubject, 'https://household.example/contact');
  assert.equal(loadConfig({ DOMAIN: 'car.example.com', PUSH_CONTACT: '' }).pushSubject, 'https://car.example.com', 'an empty contact means "use DOMAIN"');
  for (const bad of ['http://car.example.com', 'me@example.com', 'mailto:nobody', 'ftp://x.example', 'two words']) {
    assert.throws(() => loadConfig({ PUSH_CONTACT: bad }), /PUSH_CONTACT must be an https:\/\/ URL or a mailto: address/, bad);
  }
  const off = loadConfig({ DOMAIN: 'car.example.com', PUSH_CONTACT: 'mailto:me@example.com', PUSH_ENABLED: 'false' });
  assert.equal(off.pushEnabled, false);
  assert.equal(off.pushSubject, undefined, 'the kill switch wins over everything');
  assert.throws(() => loadConfig({ PUSH_ENABLED: 'perhaps' }), /PUSH_ENABLED must be true or false/);
});

test('the production example file turns reminders on by itself (DOMAIN is already in it), Tikkie stays off', () => {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const active = Object.fromEntries([...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], (m[2] as string).trim()]));
  const config = loadConfig(active);
  assert.equal(config.pushSubject, `https://${active['DOMAIN']}`);
  assert.equal(config.pushEnabled, true);
  assert.equal(config.tikkie, undefined);
  for (const name of ['TIKKIE_API_KEY', 'TIKKIE_ACCESS_TOKEN']) assert.equal(active[name], '', `${name} is empty in the example`);
});

test('Tikkie: all three settings or none; a half configuration and a plain http address fail fast, and no secret is echoed', () => {
  const full = { TIKKIE_PAYMENT_REQUEST_URL: 'https://tikkie.example/v1/payment-requests', TIKKIE_API_KEY: 'key-123456', TIKKIE_ACCESS_TOKEN: 'token-123456' };
  assert.deepEqual(loadConfig(full).tikkie, { url: full.TIKKIE_PAYMENT_REQUEST_URL, apiKey: 'key-123456', accessToken: 'token-123456' });
  assert.equal(loadConfig({ TIKKIE_PAYMENT_REQUEST_URL: '', TIKKIE_API_KEY: '', TIKKIE_ACCESS_TOKEN: '' }).tikkie, undefined, 'empty values count as not set');

  for (const name of Object.keys(full) as Array<keyof typeof full>) {
    const half = { ...full, [name]: '' };
    assert.throws(() => loadConfig(half), new RegExp(`missing: ${name}`), `${name} left empty`);
  }
  assert.throws(() => loadConfig({ TIKKIE_API_KEY: 'only-the-key' }), /TIKKIE_PAYMENT_REQUEST_URL, TIKKIE_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ ...full, TIKKIE_PAYMENT_REQUEST_URL: 'http://tikkie.example/v1' }), /TIKKIE_PAYMENT_REQUEST_URL must start with https:\/\//);
  try {
    loadConfig({ TIKKIE_API_KEY: 'super-secret-key', TIKKIE_ACCESS_TOKEN: 'super-secret-token' });
    assert.fail('a half configuration must throw');
  } catch (err) {
    assert.doesNotMatch((err as Error).message, /super-secret/, 'the error names the variables, never their values');
  }
});
