import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION, many, one, openDb, run, schemaVersion, type Db } from '../src/db.ts';

const GOOD = '2026-06-15T10:00:00.000Z';
const LATER = '2026-06-15T12:00:00.000Z';

function memoryDb(): Db {
  return openDb(':memory:');
}

function addUser(db: Db, username = 'anna'): number {
  return run(
    db,
    "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', 'member', ?, ?)",
    username,
    username,
    GOOD,
    GOOD,
  ).lastInsertRowid;
}

function addReservation(db: Db, userId: number, start = GOOD, end = LATER): number {
  return run(
    db,
    "INSERT INTO reservations (user_id, created_by, status, start_utc, end_utc, created_at, updated_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
    userId,
    userId,
    start,
    end,
    GOOD,
    GOOD,
  ).lastInsertRowid;
}

function addUsage(db: Db, userId: number, start = GOOD, end = LATER): number {
  return run(
    db,
    "INSERT INTO usage (user_id, start_utc, end_utc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    userId,
    start,
    end,
    userId,
    GOOD,
    GOOD,
  ).lastInsertRowid;
}

function tempFile(tctx: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-db-'));
  tctx.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return path.join(dir, 'car.db');
}

// ------------------------------------------------------------------- schema

test('a fresh database is at the current schema version with foreign keys enforced', () => {
  const db = memoryDb();
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.equal(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys, 1);
  db.close();
});

test('time columns only accept the fixed-width UTC shape that text comparison relies on', () => {
  const db = memoryDb();
  const anna = addUser(db);
  const bad = [
    '2026-06-15 10:00:00.000Z', // space instead of T would sort before every same-day value
    '2026-06-15T10:00:00Z', // no milliseconds: 'Z' sorts after '.', so it would compare later than the same instant
    '2026-06-15T10:00:00.000+02:00', // not UTC
    '2026-06-15T10:00', // no zone
    '2026-6-15T10:00:00.000Z', // not zero-padded
    '2026-06-15',
    '',
  ];
  for (const value of bad) {
    assert.throws(() => addReservation(db, anna, value, '2026-06-16T10:00:00.000Z'), /CHECK constraint failed/, `reservation start ${JSON.stringify(value)}`);
    assert.throws(() => addReservation(db, anna, '2026-06-14T10:00:00.000Z', value), /CHECK constraint failed/, `reservation end ${JSON.stringify(value)}`);
    assert.throws(() => addUsage(db, anna, value, '2026-06-16T10:00:00.000Z'), /CHECK constraint failed/, `usage start ${JSON.stringify(value)}`);
    assert.throws(() => addUsage(db, anna, '2026-06-14T10:00:00.000Z', value), /CHECK constraint failed/, `usage end ${JSON.stringify(value)}`);
    assert.throws(
      () => run(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)', `t-${value}`, anna, GOOD, value, GOOD),
      /CHECK constraint failed/,
      `session expiry ${JSON.stringify(value)}`,
    );
  }
  // Updates are checked too, not only inserts.
  const id = addReservation(db, anna);
  assert.throws(() => run(db, 'UPDATE reservations SET end_utc = ? WHERE id = ?', '2026-06-15T13:00:00Z', id), /CHECK constraint failed/);
  assert.equal(many(db, 'SELECT id FROM reservations').length, 1);
  db.close();
});

test('end must follow start for reservations, may equal it for usage, and odometer cannot run backwards', () => {
  const db = memoryDb();
  const anna = addUser(db);
  assert.throws(() => addReservation(db, anna, GOOD, GOOD), /CHECK constraint failed/);
  assert.throws(() => addReservation(db, anna, LATER, GOOD), /CHECK constraint failed/);
  assert.ok(addUsage(db, anna, GOOD, GOOD) > 0, 'a zero-length usage record is allowed');
  assert.throws(() => addUsage(db, anna, LATER, GOOD), /CHECK constraint failed/);
  assert.throws(
    () => run(db, "UPDATE usage SET odometer_start = 200, odometer_end = 100 WHERE user_id = ?", anna),
    /CHECK constraint failed/,
  );
  assert.throws(() => run(db, "UPDATE usage SET odometer_start = -1 WHERE user_id = ?", anna), /CHECK constraint failed/);
  db.close();
});

test('ids of deleted rows are never handed out again', () => {
  const db = memoryDb();
  const anna = addUser(db);

  const r1 = addReservation(db, anna);
  run(db, 'DELETE FROM reservations WHERE id = ?', r1);
  const r2 = addReservation(db, anna);
  assert.ok(r2 > r1, `reservation id ${r2} must not reuse ${r1}`);

  const u1 = addUsage(db, anna);
  run(db, 'DELETE FROM usage WHERE id = ?', u1);
  const u2 = addUsage(db, anna);
  assert.ok(u2 > u1, `usage id ${u2} must not reuse ${u1}`);
  db.close();
});

test('deleting a reservation unlinks its usage records but keeps them', () => {
  const db = memoryDb();
  const anna = addUser(db);
  const res = addReservation(db, anna);
  const usage = addUsage(db, anna);
  run(db, 'UPDATE usage SET reservation_id = ? WHERE id = ?', res, usage);
  run(db, 'DELETE FROM reservations WHERE id = ?', res);
  assert.equal(one<{ reservation_id: number | null }>(db, 'SELECT reservation_id FROM usage WHERE id = ?', usage)?.reservation_id, null);
  db.close();
});

test('a user with reservations or usage cannot be deleted, a session goes with its user', () => {
  const db = memoryDb();
  const anna = addUser(db, 'anna');
  const ben = addUser(db, 'ben');
  addReservation(db, anna);
  addUsage(db, ben);
  assert.throws(() => run(db, 'DELETE FROM users WHERE id = ?', anna), /FOREIGN KEY constraint failed/);
  assert.throws(() => run(db, 'DELETE FROM users WHERE id = ?', ben), /FOREIGN KEY constraint failed/);

  const carla = addUser(db, 'carla');
  run(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)', 'tok', carla, GOOD, LATER, GOOD);
  run(db, 'DELETE FROM users WHERE id = ?', carla);
  assert.equal(many(db, 'SELECT id FROM sessions').length, 0);
  db.close();
});

// --------------------------------------------------------------- migrations
// These use tiny hand-written migration lists so the upgrade path is exercised
// even though the app itself has only one migration so far.

const M1 = 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)';
const M2 = "ALTER TABLE t ADD COLUMN extra TEXT NOT NULL DEFAULT 'x'";

const columns = (db: Db): string[] => many<{ name: string }>(db, 'PRAGMA table_info(t)').map((c) => c.name);

test('upgrading an existing file applies only the new migration and keeps the data', (tctx) => {
  const file = tempFile(tctx);
  const v1 = openDb(file, [M1]);
  run(v1, "INSERT INTO t (name) VALUES ('kept')");
  assert.equal(schemaVersion(v1), 1);
  v1.close();

  const v2 = openDb(file, [M1, M2]);
  assert.equal(schemaVersion(v2), 2);
  assert.deepEqual(many(v2, 'SELECT name, extra FROM t'), [{ name: 'kept', extra: 'x' }]);
  v2.close();

  // Opening again with nothing new is a no-op (M1 would fail if it ran again).
  const again = openDb(file, [M1, M2]);
  assert.equal(schemaVersion(again), 2);
  again.close();
});

test('a failing migration changes nothing: schema and user_version stay as they were', (tctx) => {
  const file = tempFile(tctx);
  openDb(file, [M1]).close();
  const half = 'ALTER TABLE t ADD COLUMN a TEXT; SELECT * FROM does_not_exist';
  assert.throws(() => openDb(file, [M1, half]), /does_not_exist/);

  const db = openDb(file, [M1]);
  assert.equal(schemaVersion(db), 1);
  assert.deepEqual(columns(db), ['id', 'name'], 'the first statement of the failed step was rolled back');
  db.close();
});

test('a database written by a newer app is refused, not downgraded', (tctx) => {
  const file = tempFile(tctx);
  openDb(file, [M1, M2]).close();
  assert.throws(() => openDb(file, [M1]), /newer than this app/);
});

test('a migration another process applied while we waited for the lock is skipped, not run twice', (tctx) => {
  const file = tempFile(tctx);
  let raced = false;
  // migrate() reads the version, then touches migrations.length; at that moment
  // a second "process" opens the same file and applies step 1 first.
  const racing = new Proxy([M1], {
    get(target, prop, receiver) {
      if (prop === 'length' && !raced) {
        raced = true;
        openDb(file, [M1]).close();
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const db = openDb(file, racing);
  assert.ok(raced, 'the interleaving did not happen, so this test proved nothing');
  assert.equal(schemaVersion(db), 1);
  assert.deepEqual(columns(db), ['id', 'name']);
  db.close();
});
