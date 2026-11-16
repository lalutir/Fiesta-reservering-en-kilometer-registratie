import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { getMeta, many, one, openDb, run, type Db } from '../src/db.ts';
import { createBackup, dbPath, restoreBackup, rotateBackups, startMaintenance, tick, type MaintCtx } from '../src/maintenance.ts';
import { backupDir, listBackups } from '../src/retention.ts';
import { makeClock, type TestClock } from './helpers.ts';

interface Env {
  dir: string;
  config: Config;
  db: Db;
  clock: TestClock;
  logs: Array<Record<string, unknown>>;
  ctx: MaintCtx;
}

/** A bare database + maintenance context without the HTTP app. */
function setup(tctx: TestContext, now = '2026-06-15T10:00:00.000Z', env: Record<string, string> = {}): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-maint-'));
  const config = loadConfig({ DATA_DIR: dir, SCRYPT_N: '1024', ...env });
  const db = openDb(dbPath(dir));
  const clock = makeClock(now);
  const logs: Array<Record<string, unknown>> = [];
  const e: Env = { dir, config, db, clock, logs, ctx: { db, clock, config, log: (x) => logs.push(x) } };
  tctx.after(() => {
    try {
      e.db.close();
    } catch {
      // already closed by the test
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return e;
}

function addUser(db: Db, username: string): void {
  run(db, "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'member', 'now', 'now')", username, username);
}

function addReservation(db: Db, start: string, end: string): void {
  addUser(db, `u${start}`);
  const id = one<{ id: number }>(db, 'SELECT MAX(id) AS id FROM users')?.id;
  run(db, "INSERT INTO reservations (user_id, created_by, status, start_utc, end_utc, created_at, updated_at) VALUES (?, ?, 'confirmed', ?, ?, 'now', 'now')", id!, id!, start, end);
}

const usernames = (db: Db): string[] => many<{ username: string }>(db, 'SELECT username FROM users ORDER BY id').map((r) => r.username);

test('createBackup writes car-<local date>.db via a temp file, with the live data in it', (tctx) => {
  // 22:30 UTC in June is 00:30 the next day in Amsterdam.
  const e = setup(tctx, '2026-06-15T22:30:00.000Z');
  addUser(e.db, 'anna');
  const b = createBackup(e.ctx);
  assert.equal(b.file, 'car-2026-06-16.db');
  assert.equal(b.path, path.join(e.dir, 'backups', 'car-2026-06-16.db'));
  assert.ok(b.size > 0);
  assert.deepEqual(fs.readdirSync(backupDir(e.dir)), ['car-2026-06-16.db'], 'no .tmp file is left behind');
  assert.equal(getMeta(e.db, 'last_backup_file'), 'car-2026-06-16.db');
  assert.equal(getMeta(e.db, 'last_backup_at'), '2026-06-15T22:30:00.000Z');
  assert.equal(e.logs.filter((l) => l['event'] === 'backup.created').length, 1);

  const copy = openDb(b.path);
  assert.deepEqual(usernames(copy), ['anna']);
  copy.close();

  // A second backup on the same day replaces the first with fresh data.
  addUser(e.db, 'ben');
  createBackup(e.ctx);
  const again = openDb(b.path);
  assert.deepEqual(usernames(again), ['anna', 'ben']);
  again.close();
  assert.equal(listBackups(backupDir(e.dir)).length, 1);
});

test('rotateBackups keeps the newest N by file-name date and touches nothing else', (tctx) => {
  const e = setup(tctx);
  const dir = backupDir(e.dir);
  fs.mkdirSync(dir, { recursive: true });
  for (let day = 1; day <= 20; day++) fs.writeFileSync(path.join(dir, `car-2026-05-${String(day).padStart(2, '0')}.db`), 'x');
  for (const other of ['notes.txt', 'car-2026-05-01.db.bak', 'pre-restore-20260101T000000Z.db', 'car-latest.db', 'xcar-2026-01-01.db']) {
    fs.writeFileSync(path.join(dir, other), 'keep me');
  }
  const deleted = rotateBackups(dir, 14);
  assert.deepEqual(deleted.sort(), [1, 2, 3, 4, 5, 6].map((d) => `car-2026-05-0${d}.db`));
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.filter((f) => /^car-2026-05-\d\d\.db$/.test(f)).length, 14);
  assert.ok(left.includes('car-2026-05-07.db') && left.includes('car-2026-05-20.db'));
  for (const other of ['notes.txt', 'car-2026-05-01.db.bak', 'pre-restore-20260101T000000Z.db', 'car-latest.db', 'xcar-2026-01-01.db']) {
    assert.ok(left.includes(other), other);
  }
  assert.deepEqual(rotateBackups(dir, 14), [], 'nothing more to delete');
  assert.deepEqual(rotateBackups(path.join(e.dir, 'missing'), 14), []);
});

test('rotateBackups clears the temp file of a crashed backup, but not an in-flight one or a look-alike', (tctx) => {
  const e = setup(tctx);
  const dir = backupDir(e.dir);
  fs.mkdirSync(dir, { recursive: true });
  const crashed = path.join(dir, 'car-2026-06-01.db.tmp');
  const inFlight = path.join(dir, 'car-2026-06-02.db.tmp');
  const lookAlike = path.join(dir, 'notes.db.tmp');
  for (const f of [crashed, inFlight, lookAlike]) fs.writeFileSync(f, 'x');
  // The age check uses the real clock and the file's mtime.
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  fs.utimesSync(crashed, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(lookAlike, twoHoursAgo, twoHoursAgo);

  assert.deepEqual(rotateBackups(dir, 14), [], 'temp files are not counted as rotated backups');
  assert.equal(fs.existsSync(crashed), false, 'a leftover older than an hour is removed');
  assert.equal(fs.existsSync(inFlight), true, 'a backup that is still being written is left alone');
  assert.equal(fs.existsSync(lookAlike), true, 'only the app\'s own temp names are touched');
});

test('createBackup rotates according to BACKUP_KEEP_DAYS', (tctx) => {
  const e = setup(tctx, '2026-06-10T10:00:00.000Z', { BACKUP_KEEP_DAYS: '3' });
  for (let i = 0; i < 5; i++) {
    createBackup(e.ctx);
    e.clock.advance(24 * 3_600_000);
  }
  assert.deepEqual(listBackups(backupDir(e.dir)).map((b) => b.file), ['car-2026-06-14.db', 'car-2026-06-13.db', 'car-2026-06-12.db']);
});

test('restoreBackup brings back the backed-up data and keeps a copy of what it replaced', (tctx) => {
  const e = setup(tctx);
  addUser(e.db, 'anna');
  const backup = createBackup(e.ctx);
  addUser(e.db, 'ben');
  e.db.close();

  const { preRestore } = restoreBackup(e.config, backup.path, e.clock.now());
  assert.ok(preRestore && fs.existsSync(preRestore));
  assert.match(path.basename(preRestore), /^pre-restore-20260615T100000Z\.db$/);
  assert.equal(fs.existsSync(`${dbPath(e.dir)}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath(e.dir)}-shm`), false);
  assert.equal(fs.existsSync(`${dbPath(e.dir)}.restore.tmp`), false);

  const restored = openDb(dbPath(e.dir));
  assert.deepEqual(usernames(restored), ['anna']);
  assert.equal(one<{ integrity_check: string }>(restored, 'PRAGMA integrity_check')?.integrity_check, 'ok');
  restored.close();
  const before = openDb(preRestore);
  assert.deepEqual(usernames(before), ['anna', 'ben'], 'the pre-restore copy has the data that was replaced');
  before.close();
  assert.equal(listBackups(backupDir(e.dir)).length, 1, 'pre-restore copies are not mistaken for rotating backups');
});

test('restoreBackup refuses missing, corrupt and too-new backups and leaves the live database alone', (tctx) => {
  const e = setup(tctx);
  addUser(e.db, 'anna');
  e.db.close();
  const corrupt = path.join(e.dir, 'corrupt.db');
  fs.writeFileSync(corrupt, 'this is definitely not a sqlite database '.repeat(50));
  const future = path.join(e.dir, 'future.db');
  const f = openDb(future);
  f.exec('PRAGMA user_version = 99');
  f.close();

  assert.throws(() => restoreBackup(e.config, path.join(e.dir, 'nope.db'), e.clock.now()), /not found/);
  assert.throws(() => restoreBackup(e.config, corrupt, e.clock.now()));
  assert.throws(() => restoreBackup(e.config, future, e.clock.now()), /schema version 99/);
  const still = openDb(dbPath(e.dir));
  assert.deepEqual(usernames(still), ['anna']);
  still.close();
  assert.equal(fs.existsSync(backupDir(e.dir)), false, 'no pre-restore copy is made when the restore is refused');
});

test('restoreBackup works on a fresh data dir with nothing to replace', (tctx) => {
  const e = setup(tctx);
  addUser(e.db, 'anna');
  const backup = createBackup(e.ctx);
  e.db.close();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'car-fresh-'));
  tctx.after(() => fs.rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const { preRestore } = restoreBackup({ ...e.config, dataDir: empty }, backup.path, e.clock.now());
  assert.equal(preRestore, undefined);
  const db = openDb(dbPath(empty));
  assert.deepEqual(usernames(db), ['anna']);
  db.close();
});

test('tick purges and backs up once per local day', (tctx) => {
  const e = setup(tctx, '2026-06-15T10:00:00.000Z');
  addReservation(e.db, '2025-01-01T08:00:00.000Z', '2025-01-01T10:00:00.000Z'); // far older than six months
  addReservation(e.db, '2026-06-20T08:00:00.000Z', '2026-06-20T10:00:00.000Z');
  const purges = () => e.logs.filter((l) => l['event'] === 'retention.purge').length;

  assert.equal(tick(e.ctx), true);
  assert.equal(purges(), 1);
  const log = e.logs.find((l) => l['event'] === 'retention.purge');
  assert.equal(log?.['reservations'], 1, 'the deleted-row count is logged');
  assert.equal(getMeta(e.db, 'last_maintenance_day'), '2026-06-15');
  assert.deepEqual(listBackups(backupDir(e.dir)).map((b) => b.file), ['car-2026-06-15.db']);
  const copy = openDb(path.join(backupDir(e.dir), 'car-2026-06-15.db'));
  assert.equal(one<{ n: number }>(copy, 'SELECT COUNT(*) AS n FROM reservations')?.n, 1, 'the backup is taken after the purge');
  copy.close();

  e.clock.advance(3_600_000);
  assert.equal(tick(e.ctx), false);
  e.clock.advance(10 * 3_600_000); // now 21:00 UTC, which is 23:00 in Amsterdam
  assert.equal(tick(e.ctx), false, 'still the same local day');
  e.clock.advance(3_600_000); // 22:00 UTC is midnight in Amsterdam in June
  assert.equal(tick(e.ctx), true, 'a new local day');
  assert.equal(purges(), 2);
  assert.equal(getMeta(e.db, 'last_maintenance_day'), '2026-06-16');
  assert.equal(listBackups(backupDir(e.dir)).length, 2);
});

test('tick follows local days across the spring-forward and fall-back days', (tctx) => {
  const e = setup(tctx, '2026-03-28T23:30:00.000Z'); // 00:30 on 29 March, the short day
  assert.equal(tick(e.ctx), true);
  assert.equal(getMeta(e.db, 'last_maintenance_day'), '2026-03-29');
  e.clock.set('2026-03-29T21:59:00.000Z'); // 23:59 CEST, still the 29th
  assert.equal(tick(e.ctx), false);
  e.clock.set('2026-03-29T22:00:00.000Z'); // 00:00 CEST on the 30th
  assert.equal(tick(e.ctx), true);
  assert.equal(getMeta(e.db, 'last_maintenance_day'), '2026-03-30');

  e.clock.set('2026-10-24T22:30:00.000Z'); // 00:30 CEST on 25 October, the long day
  assert.equal(tick(e.ctx), true);
  e.clock.set('2026-10-25T01:30:00.000Z'); // 02:30 CET, the repeated hour
  assert.equal(tick(e.ctx), false);
  e.clock.set('2026-10-25T22:59:00.000Z'); // 23:59 CET
  assert.equal(tick(e.ctx), false);
  e.clock.set('2026-10-25T23:00:00.000Z'); // 00:00 CET on the 26th
  assert.equal(tick(e.ctx), true);
  assert.equal(getMeta(e.db, 'last_maintenance_day'), '2026-10-26');
});

test('tick never touches current or future data', (tctx) => {
  const e = setup(tctx);
  addReservation(e.db, '2026-06-15T08:00:00.000Z', '2026-06-15T12:00:00.000Z');
  addReservation(e.db, '2026-12-01T08:00:00.000Z', '2026-12-01T10:00:00.000Z');
  tick(e.ctx);
  assert.equal(one<{ n: number }>(e.db, 'SELECT COUNT(*) AS n FROM reservations')?.n, 2);
});

test('a failed tick is logged, leaves the day unmarked and retries on the next tick', (tctx) => {
  const e = setup(tctx);
  fs.writeFileSync(backupDir(e.dir), 'a file where the backup directory should be');
  assert.equal(tick(e.ctx), false);
  assert.ok(e.logs.some((l) => l['event'] === 'maintenance.error'));
  assert.equal(getMeta(e.db, 'last_maintenance_day'), undefined);
  fs.rmSync(backupDir(e.dir));
  e.clock.advance(30 * 60_000);
  assert.equal(tick(e.ctx), true);
});

test('startMaintenance purges on startup and backs up only if there is no backup for today', (tctx) => {
  const e = setup(tctx);
  addReservation(e.db, '2025-01-01T08:00:00.000Z', '2025-01-01T10:00:00.000Z');
  const backups = () => e.logs.filter((l) => l['event'] === 'backup.created').length;

  const first = startMaintenance(e.ctx);
  first.stop();
  assert.equal(one<{ n: number }>(e.db, 'SELECT COUNT(*) AS n FROM reservations')?.n, 0, 'purged at startup');
  assert.equal(backups(), 1);
  assert.equal(getMeta(e.db, 'last_maintenance_day'), '2026-06-15');

  const restart = startMaintenance(e.ctx);
  restart.stop();
  assert.equal(backups(), 1, 'a restart on the same day does not pile up backups');
  assert.equal(e.logs.filter((l) => l['event'] === 'retention.purge').length, 2, 'but it still purges');

  e.clock.advance(24 * 3_600_000);
  startMaintenance(e.ctx).stop();
  assert.equal(backups(), 2, 'a new day gets a new backup');
});

test('startMaintenance keeps the process free to exit (the timer is unref-ed) and can be stopped', (tctx) => {
  const e = setup(tctx);
  const handle = startMaintenance(e.ctx);
  assert.equal(typeof handle.stop, 'function');
  handle.stop();
  handle.stop();
});
