import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION, isUniqueViolation, many, one, openDb, run, schemaVersion, type Db } from '../src/db.ts';

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

// ------------------------------------------------- schema v2 (drafts, fuel, push)

const SOON = '2026-06-15T10:30:00.000Z';

function addDraft(db: Db, userId: number, fields: { start?: string; end?: string; odoStart?: number | null; odoEnd?: number | null; status?: string } = {}): number {
  const start = fields.start ?? GOOD;
  return run(
    db,
    `INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    start,
    fields.end ?? start,
    fields.odoStart === undefined ? 1000 : fields.odoStart,
    fields.odoEnd === undefined ? null : fields.odoEnd,
    fields.status ?? 'draft',
    userId,
    GOOD,
    GOOD,
  ).lastInsertRowid;
}

test('a v1 file with rows upgrades to v2 without losing anything, and leaves a pre-migration copy', (tctx) => {
  const file = tempFile(tctx);
  const v1 = openDb(file, MIGRATIONS.slice(0, 1));
  assert.equal(schemaVersion(v1), 1);
  const anna = addUser(v1, 'anna');
  const ben = addUser(v1, 'ben');
  const res = addReservation(v1, anna);
  const withReadings = run(
    v1,
    'INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, reservation_id, note, created_by, created_at, updated_at) VALUES (?, ?, ?, 100, 160, ?, ?, ?, ?, ?)',
    anna,
    GOOD,
    LATER,
    res,
    'with readings',
    anna,
    GOOD,
    GOOD,
  ).lastInsertRowid;
  const bare = addUsage(v1, ben, '2026-06-14T10:00:00.000Z', '2026-06-14T12:00:00.000Z');
  run(v1, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)', 'tok', anna, GOOD, LATER, GOOD);
  v1.close();

  const copy = path.join(path.dirname(file), 'backups', 'pre-migrate-v1.db');
  assert.equal(fs.existsSync(copy), false, 'opening a database at its own version writes no copy');

  // Pinned to the first two migrations: this test is about the v1 to v2 step, whatever comes after it.
  const v2 = openDb(file, MIGRATIONS.slice(0, 2));
  assert.equal(schemaVersion(v2), 2);
  assert.deepEqual(
    many(v2, 'SELECT id, user_id, odometer_start, odometer_end, reservation_id, note, status FROM usage ORDER BY id'),
    [
      { id: withReadings, user_id: anna, odometer_start: 100, odometer_end: 160, reservation_id: res, note: 'with readings', status: 'completed' },
      { id: bare, user_id: ben, odometer_start: null, odometer_end: null, reservation_id: null, note: '', status: 'completed' },
    ],
    'existing drives, with or without readings, are kept as completed',
  );
  assert.equal(many(v2, 'SELECT id FROM users').length, 2);
  assert.equal(many(v2, 'SELECT id FROM reservations').length, 1);
  assert.equal(many(v2, 'SELECT id FROM sessions').length, 1);
  for (const table of ['fuel', 'fuel_requests', 'push_subscriptions', 'reminders_sent']) {
    assert.equal(many(v2, `SELECT * FROM ${table}`).length, 0, `${table} starts empty`);
  }
  // The new tables hang off the old ones: deleting a reservation drops its reminder claims.
  run(v2, "INSERT INTO reminders_sent (reservation_id, kind, scheduled_utc, sent_at) VALUES (?, 'start', ?, ?)", res, GOOD, GOOD);
  run(v2, 'DELETE FROM reservations WHERE id = ?', res);
  assert.equal(many(v2, 'SELECT * FROM reminders_sent').length, 0);
  v2.close();

  // The copy is a readable v1 database holding the data as it was before the upgrade.
  assert.ok(fs.existsSync(copy), 'backups/pre-migrate-v1.db was written');
  const old = openDb(copy, MIGRATIONS.slice(0, 1));
  assert.equal(schemaVersion(old), 1);
  assert.equal(many(old, 'SELECT id FROM usage').length, 2);
  assert.equal(many(old, 'SELECT id FROM reservations').length, 1, 'the copy still has the reservation');
  old.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(copy)).filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm')),
    ['pre-migrate-v1.db'],
    'no temporary file is left behind',
  );

  // Opening again changes nothing and does not touch the copy.
  const mtime = fs.statSync(copy).mtimeMs;
  openDb(file, MIGRATIONS.slice(0, 2)).close();
  assert.equal(fs.statSync(copy).mtimeMs, mtime);
});

test('an existing pre-migration copy is kept, a brand-new file gets none, and a copy that cannot be written aborts the upgrade', (tctx) => {
  const fresh = tempFile(tctx);
  openDb(fresh).close();
  assert.equal(fs.existsSync(path.join(path.dirname(fresh), 'backups')), false, 'nothing to protect in a new file');

  const file = tempFile(tctx);
  openDb(file, MIGRATIONS.slice(0, 1)).close();
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'pre-migrate-v1.db'), 'earlier copy');
  openDb(file).close();
  assert.equal(fs.readFileSync(path.join(dir, 'pre-migrate-v1.db'), 'utf8'), 'earlier copy', 'an earlier copy is never overwritten');

  // Fail closed: a file where the backups folder should be makes the copy impossible, and the data stays at v1.
  const blocked = tempFile(tctx);
  openDb(blocked, MIGRATIONS.slice(0, 1)).close();
  fs.writeFileSync(path.join(path.dirname(blocked), 'backups'), 'a file, not a folder');
  assert.throws(() => openDb(blocked), /Cannot write the pre-migration copy.*database was not changed/);
  fs.rmSync(path.join(path.dirname(blocked), 'backups'));
  const still = openDb(blocked, MIGRATIONS.slice(0, 1));
  assert.equal(schemaVersion(still), 1);
  still.close();
});

test('the real v2 upgrade is all or nothing: a failure on its last statement leaves the v1 file as it was, and a retry works', (tctx) => {
  const file = tempFile(tctx);
  const v1 = openDb(file, MIGRATIONS.slice(0, 1));
  const anna = addUser(v1);
  const drive = addUsage(v1, anna);
  // Something already sits where the last table of v2 goes, so v2 fails after its ALTER TABLE,
  // its partial index and its other tables have all run inside the transaction.
  v1.exec('CREATE TABLE reminders_sent (stranger INTEGER)');
  v1.close();

  assert.throws(() => openDb(file, MIGRATIONS.slice(0, 2)), /reminders_sent already exists/);

  const names = (db: Db, type: 'table' | 'index'): string[] =>
    many<{ name: string }>(db, 'SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name', type, 'sqlite_%').map((r) => r.name);
  const after = openDb(file, MIGRATIONS.slice(0, 1));
  assert.equal(schemaVersion(after), 1, 'the version was not bumped');
  assert.ok(!many<{ name: string }>(after, 'PRAGMA table_info(usage)').some((c) => c.name === 'status'), 'the ALTER TABLE was rolled back');
  assert.ok(!names(after, 'index').includes('usage_one_draft'), 'the partial index was rolled back');
  for (const table of ['fuel', 'fuel_requests', 'push_subscriptions']) assert.ok(!names(after, 'table').includes(table), `${table} was rolled back`);
  assert.deepEqual(many(after, 'SELECT id, user_id FROM usage'), [{ id: drive, user_id: anna }], 'the data is untouched');
  // The way out is to clear the obstacle: the same upgrade then runs from the top.
  after.exec('DROP TABLE reminders_sent');
  after.close();
  const v2 = openDb(file, MIGRATIONS.slice(0, 2));
  assert.equal(schemaVersion(v2), 2);
  assert.deepEqual(many(v2, 'SELECT id, status FROM usage'), [{ id: drive, status: 'completed' }]);
  v2.close();
});

// ------------------------------------- schema v3 (whose kilometres, what a request covers)

const columnsOf = (db: Db, table: string): string[] => many<{ name: string }>(db, `PRAGMA table_info(${table})`).map((c) => c.name);

test('a v2 file with rows upgrades to v3 without losing anything: every drive stays the driver\'s own, old requests cover nothing, and a pre-migrate-v2 copy is left', (tctx) => {
  const file = tempFile(tctx);
  const v2 = openDb(file, MIGRATIONS.slice(0, 2));
  assert.equal(schemaVersion(v2), 2);
  const anna = addUser(v2, 'anna');
  const ben = addUser(v2, 'ben');
  const drive = run(
    v2,
    'INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, note, created_by, created_at, updated_at) VALUES (?, ?, ?, 100, 160, ?, ?, ?, ?)',
    anna,
    GOOD,
    LATER,
    'a note',
    anna,
    GOOD,
    GOOD,
  ).lastInsertRowid;
  const draft = addDraft(v2, ben, { start: '2026-06-16T08:00:00.000Z' });
  const fuel = run(v2, 'INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, created_by, created_at, updated_at) VALUES (?, ?, 40000, 6000, ?, ?, ?)', anna, LATER, anna, GOOD, GOOD).lastInsertRowid;
  run(v2, "INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, created_at, updated_at) VALUES (?, ?, 1500, 'manual', 'pay up', ?, ?)", fuel, ben, GOOD, GOOD);
  v2.close();

  const copy = path.join(path.dirname(file), 'backups', 'pre-migrate-v2.db');
  assert.equal(fs.existsSync(copy), false, 'opening a database at its own version writes no copy');

  // Pinned to the first three migrations: this test is about the v2 to v3 step, whatever comes after it.
  const v3 = openDb(file, MIGRATIONS.slice(0, 3));
  assert.equal(schemaVersion(v3), 3);
  assert.deepEqual(
    many(v3, 'SELECT id, user_id, odometer_start, odometer_end, note, status, km_for, km_user_id FROM usage ORDER BY id'),
    [
      { id: drive, user_id: anna, odometer_start: 100, odometer_end: 160, note: 'a note', status: 'completed', km_for: 'self', km_user_id: null },
      { id: draft, user_id: ben, odometer_start: 1000, odometer_end: null, note: '', status: 'draft', km_for: 'self', km_user_id: null },
    ],
    'existing drives and drafts read back as the driver\'s own',
  );
  assert.deepEqual(
    many(v3, 'SELECT fuel_id, debtor_id, amount_cents, message, paid_at, covers_fuel_id FROM fuel_requests'),
    [{ fuel_id: fuel, debtor_id: ben, amount_cents: 1500, message: 'pay up', paid_at: null, covers_fuel_id: null }],
    'a request made before v3 settles nothing but itself',
  );
  assert.equal(many(v3, 'SELECT id FROM fuel').length, 1);
  v3.close();

  // The copy is a readable v2 database as it was before the upgrade: no new columns, same rows.
  assert.ok(fs.existsSync(copy), 'backups/pre-migrate-v2.db was written');
  const old = openDb(copy, MIGRATIONS.slice(0, 2));
  assert.equal(schemaVersion(old), 2);
  assert.ok(!columnsOf(old, 'usage').includes('km_for'));
  assert.ok(!columnsOf(old, 'fuel_requests').includes('covers_fuel_id'));
  assert.equal(many(old, 'SELECT id FROM usage').length, 2);
  old.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(copy)).filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm')),
    ['pre-migrate-v2.db'],
    'no temporary file is left behind',
  );

  // Opening again changes nothing and does not touch the copy.
  const mtime = fs.statSync(copy).mtimeMs;
  openDb(file, MIGRATIONS.slice(0, 3)).close();
  assert.equal(fs.statSync(copy).mtimeMs, mtime);
});

test('a v1 file goes straight to v3 in one open, with the one copy of what it was', (tctx) => {
  const file = tempFile(tctx);
  const v1 = openDb(file, MIGRATIONS.slice(0, 1));
  const anna = addUser(v1);
  const drive = addUsage(v1, anna);
  v1.close();

  const v3 = openDb(file, MIGRATIONS.slice(0, 3));
  assert.equal(schemaVersion(v3), 3);
  assert.deepEqual(many(v3, 'SELECT id, status, km_for, km_user_id FROM usage'), [{ id: drive, status: 'completed', km_for: 'self', km_user_id: null }]);
  v3.close();
  assert.deepEqual(
    fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm')),
    ['pre-migrate-v1.db'],
    'one copy, of the version the file was at, before the first step',
  );
});

test('the real v3 upgrade is all or nothing: a failure on its last statement leaves the v2 file as it was, and a retry works', (tctx) => {
  const file = tempFile(tctx);
  const v2 = openDb(file, MIGRATIONS.slice(0, 2));
  const anna = addUser(v2);
  const drive = addUsage(v2, anna);
  // The column the last statement adds is already there, so v3 fails after its two usage columns and its index have run.
  v2.exec('ALTER TABLE fuel_requests ADD COLUMN covers_fuel_id INTEGER');
  v2.close();

  assert.throws(() => openDb(file), /duplicate column name: covers_fuel_id/);

  const after = openDb(file, MIGRATIONS.slice(0, 2));
  assert.equal(schemaVersion(after), 2, 'the version was not bumped');
  assert.ok(!columnsOf(after, 'usage').includes('km_for'), 'the first ALTER TABLE was rolled back');
  assert.ok(!columnsOf(after, 'usage').includes('km_user_id'), 'the second ALTER TABLE was rolled back');
  assert.ok(!many<{ name: string }>(after, "SELECT name FROM sqlite_master WHERE type = 'index'").some((i) => i.name === 'usage_km_user'), 'the index was rolled back');
  assert.deepEqual(many(after, 'SELECT id, user_id FROM usage'), [{ id: drive, user_id: anna }], 'the data is untouched');
  // The way out is to clear the obstacle: the same upgrade then runs from the top.
  after.exec('ALTER TABLE fuel_requests DROP COLUMN covers_fuel_id');
  after.close();
  const v3 = openDb(file, MIGRATIONS.slice(0, 3));
  assert.equal(schemaVersion(v3), 3);
  assert.deepEqual(many(v3, 'SELECT id, km_for FROM usage'), [{ id: drive, km_for: 'self' }]);
  v3.close();
});

test('v3 rows: whose kilometres are tied to the person, who must be a real user; a request covers a real fill-up id or nothing', () => {
  const db = memoryDb();
  const anna = addUser(db, 'anna');
  const ben = addUser(db, 'ben');
  const drive = (kmFor: string, kmUser: number | null): number =>
    run(
      db,
      `INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, km_for, km_user_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 100, 160, ?, ?, ?, ?, ?)`,
      anna,
      GOOD,
      LATER,
      kmFor,
      kmUser,
      anna,
      GOOD,
      GOOD,
    ).lastInsertRowid;
  assert.ok(drive('self', null) > 0);
  assert.ok(drive('together', null) > 0);
  assert.ok(drive('person', ben) > 0);
  for (const [label, kmFor, kmUser] of [
    ['an unknown kind', 'friend', null],
    ['a person without who', 'person', null],
    ['self with a person', 'self', ben],
    ['together with a person', 'together', ben],
  ] as const) {
    assert.throws(() => drive(kmFor, kmUser), /CHECK constraint failed/, label);
  }
  assert.throws(() => drive('person', 999), /FOREIGN KEY constraint failed/, 'the person must exist');
  assert.throws(() => run(db, "UPDATE usage SET km_for = 'person' WHERE km_for = 'self'"), /CHECK constraint failed/, 'switching to a person needs the person in the same statement');
  run(db, "UPDATE usage SET km_for = 'self', km_user_id = NULL WHERE km_for = 'person'");

  const fuel = run(db, 'INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, created_by, created_at, updated_at) VALUES (?, ?, 40000, 6000, ?, ?, ?)', anna, GOOD, anna, GOOD, GOOD).lastInsertRowid;
  const request = (covers: number | null): number =>
    run(db, "INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, covers_fuel_id, created_at, updated_at) VALUES (?, ?, 100, 'manual', 'x', ?, ?, ?)", fuel, ben, covers, GOOD, GOOD).lastInsertRowid;
  assert.throws(() => request(0), /CHECK constraint failed/);
  assert.throws(() => request(-3), /CHECK constraint failed/);
  assert.ok(request(fuel) > 0);
  db.close();
});

test('draft rows: a draft has a start reading, no end reading and a placeholder end; nothing else is allowed', () => {
  const db = memoryDb();
  const anna = addUser(db);
  assert.ok(addDraft(db, anna) > 0, 'a valid draft is accepted');
  const ben = addUser(db, 'ben');
  const bad: Array<[string, Parameters<typeof addDraft>[2]]> = [
    ['with an end reading', { odoEnd: 1100 }],
    ['without a start reading', { odoStart: null }],
    ['with a real end time', { end: LATER }],
    ['with an unknown status', { status: 'open' }],
  ];
  for (const [label, fields] of bad) assert.throws(() => addDraft(db, ben, fields), /CHECK constraint failed/, label);
  // A completed drive keeps working exactly as before, with or without readings.
  assert.ok(addDraft(db, ben, { status: 'completed', end: LATER, odoStart: 1, odoEnd: 5 }) > 0);
  assert.ok(addDraft(db, ben, { status: 'completed', start: SOON, end: LATER, odoStart: null }) > 0);
  assert.throws(
    () => run(db, "UPDATE usage SET status = 'draft' WHERE status = 'completed' AND odometer_end IS NOT NULL"),
    /CHECK constraint failed/,
    'a finished drive cannot be turned back into a draft',
  );
  db.close();
});

test('one open draft per driver: a second one is a unique violation, a finished one makes room', () => {
  const db = memoryDb();
  const anna = addUser(db, 'anna');
  const ben = addUser(db, 'ben');
  const first = addDraft(db, anna);
  assert.ok(addDraft(db, ben) > 0, 'another driver can have their own');
  assert.throws(() => addDraft(db, anna, { start: SOON }), (err: unknown) => isUniqueViolation(err));
  run(db, "UPDATE usage SET status = 'completed', end_utc = ?, odometer_end = 1040 WHERE id = ?", LATER, first);
  assert.ok(addDraft(db, anna, { start: LATER }) > 0);
  db.close();
});

test('fuel rows only accept sane money, volume and times, and requests are one per person per fill-up', () => {
  const db = memoryDb();
  const anna = addUser(db, 'anna');
  const ben = addUser(db, 'ben');
  const insert = (at: string, ml: number, cents: number): number =>
    run(db, 'INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', anna, at, ml, cents, anna, GOOD, GOOD).lastInsertRowid;
  const fuel = insert(GOOD, 40_000, 6_000);
  for (const [label, at, ml, cents] of [
    ['zero litres', GOOD, 0, 6000],
    ['negative litres', GOOD, -1, 6000],
    ['huge litres', GOOD, 200_001, 6000],
    ['zero cents', GOOD, 40_000, 0],
    ['negative cents', GOOD, 40_000, -5],
    ['huge cents', GOOD, 40_000, 1_000_001],
    ['a bad timestamp', '2026-06-15 10:00', 40_000, 6000],
  ] as const) {
    assert.throws(() => insert(at, ml, cents), /CHECK constraint failed/, label);
  }
  const request = (debtor: number, provider = 'manual', cents = 1500): number =>
    run(db, 'INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', fuel, debtor, cents, provider, 'pay up', GOOD, GOOD).lastInsertRowid;
  assert.ok(request(ben) > 0);
  assert.throws(() => request(ben), (err: unknown) => isUniqueViolation(err));
  assert.throws(() => request(anna, 'venmo'), /CHECK constraint failed/);
  assert.throws(() => request(anna, 'manual', 0), /CHECK constraint failed/);
  run(db, 'DELETE FROM fuel WHERE id = ?', fuel);
  assert.equal(many(db, 'SELECT id FROM fuel_requests').length, 0, 'requests go with their fill-up');
  db.close();
});

// ------------------------------------------------ schema v4 (traffic tickets)

const tablesOf = (db: Db): string[] =>
  many<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);

test('a v3 file with rows upgrades to v4 without losing anything, and leaves one pre-migrate-v3 copy', (tctx) => {
  const file = tempFile(tctx);
  const v3 = openDb(file, MIGRATIONS.slice(0, 3));
  assert.equal(schemaVersion(v3), 3);
  const anna = addUser(v3, 'anna');
  const ben = addUser(v3, 'ben');
  const res = addReservation(v3, anna);
  const drive = run(
    v3,
    "INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, km_for, km_user_id, note, created_by, created_at, updated_at) VALUES (?, ?, ?, 100, 160, 'person', ?, 'for ben', ?, ?, ?)",
    anna,
    GOOD,
    LATER,
    ben,
    anna,
    GOOD,
    GOOD,
  ).lastInsertRowid;
  const fuel = run(v3, 'INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, created_by, created_at, updated_at) VALUES (?, ?, 40000, 6000, ?, ?, ?)', anna, LATER, anna, GOOD, GOOD).lastInsertRowid;
  run(v3, "INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, covers_fuel_id, created_at, updated_at) VALUES (?, ?, 1500, 'manual', 'pay up', ?, ?, ?)", fuel, ben, fuel, GOOD, GOOD);
  v3.close();

  const copy = path.join(path.dirname(file), 'backups', 'pre-migrate-v3.db');
  assert.equal(fs.existsSync(copy), false, 'opening a database at its own version writes no copy');

  const v4 = openDb(file);
  assert.equal(schemaVersion(v4), 4);
  assert.equal(schemaVersion(v4), SCHEMA_VERSION);
  assert.deepEqual(many(v4, 'SELECT id FROM tickets'), [], 'the new table starts empty');
  assert.deepEqual(
    many(v4, 'SELECT id, user_id, km_for, km_user_id, note FROM usage'),
    [{ id: drive, user_id: anna, km_for: 'person', km_user_id: ben, note: 'for ben' }],
    'drives are untouched',
  );
  assert.equal(many(v4, 'SELECT id FROM users').length, 2);
  assert.equal(many(v4, 'SELECT id FROM reservations WHERE id = ?', res).length, 1);
  assert.deepEqual(many(v4, 'SELECT fuel_id, debtor_id, amount_cents, covers_fuel_id FROM fuel_requests'), [{ fuel_id: fuel, debtor_id: ben, amount_cents: 1500, covers_fuel_id: fuel }]);
  assert.deepEqual(columnsOf(v4, 'tickets'), ['id', 'at_utc', 'amount_cents', 'reason', 'created_by', 'created_at', 'updated_at'], 'no driver column: who drove is derived');
  v4.close();

  // The copy is a readable v3 database without the new table, holding the data as it was.
  assert.ok(fs.existsSync(copy), 'backups/pre-migrate-v3.db was written');
  const old = openDb(copy, MIGRATIONS.slice(0, 3));
  assert.equal(schemaVersion(old), 3);
  assert.ok(!tablesOf(old).includes('tickets'));
  assert.equal(many(old, 'SELECT id FROM usage').length, 1);
  assert.equal(many(old, 'SELECT id FROM fuel_requests').length, 1);
  old.close();
  assert.deepEqual(
    fs.readdirSync(path.dirname(copy)).filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm')),
    ['pre-migrate-v3.db'],
    'no temporary file is left behind',
  );

  // Opening again changes nothing and does not touch the copy.
  const mtime = fs.statSync(copy).mtimeMs;
  openDb(file).close();
  assert.equal(fs.statSync(copy).mtimeMs, mtime);
});

test('a v1 file goes straight to the current version in one open, with the one copy of what it was', (tctx) => {
  const file = tempFile(tctx);
  const v1 = openDb(file, MIGRATIONS.slice(0, 1));
  const anna = addUser(v1);
  const drive = addUsage(v1, anna);
  v1.close();

  const db = openDb(file);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.ok(tablesOf(db).includes('tickets'));
  assert.deepEqual(many(db, 'SELECT id, status, km_for FROM usage'), [{ id: drive, status: 'completed', km_for: 'self' }]);
  db.close();
  assert.deepEqual(
    fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm')),
    ['pre-migrate-v1.db'],
    'one copy, of the version the file was at, before the first step',
  );
});

test('the real v4 upgrade is all or nothing: a table already in the way leaves the v3 file as it was, and a retry works', (tctx) => {
  const file = tempFile(tctx);
  const v3 = openDb(file, MIGRATIONS.slice(0, 3));
  const anna = addUser(v3);
  const drive = addUsage(v3, anna);
  v3.exec('CREATE TABLE tickets (stranger INTEGER)');
  v3.close();

  assert.throws(() => openDb(file), /table tickets already exists/);

  const after = openDb(file, MIGRATIONS.slice(0, 3));
  assert.equal(schemaVersion(after), 3, 'the version was not bumped');
  assert.deepEqual(columnsOf(after, 'tickets'), ['stranger'], 'the stranger table is untouched');
  assert.deepEqual(many(after, 'SELECT id, user_id FROM usage'), [{ id: drive, user_id: anna }], 'the data is untouched');
  // The way out is to clear the obstacle: the same upgrade then runs from the top.
  after.exec('DROP TABLE tickets');
  after.close();
  const v4 = openDb(file);
  assert.equal(schemaVersion(v4), 4);
  assert.deepEqual(columnsOf(v4, 'tickets'), ['id', 'at_utc', 'amount_cents', 'reason', 'created_by', 'created_at', 'updated_at']);
  v4.close();
});

test('ticket rows only accept the UTC time shape, an amount from 1 cent to 10,000.00, and a real creator', () => {
  const db = memoryDb();
  const anna = addUser(db);
  const insert = (at: string, cents: number | null, by = anna): number =>
    run(db, 'INSERT INTO tickets (at_utc, amount_cents, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', at, cents, by, GOOD, GOOD).lastInsertRowid;
  for (const cents of [null, 1, 1_000_000]) assert.ok(insert(GOOD, cents) > 0, `amount ${cents} is accepted`);
  for (const bad of ['2026-06-15 10:00:00.000Z', '2026-06-15T10:00:00Z', '2026-06-15T10:00:00.000+02:00', '2026-06-15T10:00', '2026-6-15T10:00:00.000Z', '']) {
    assert.throws(() => insert(bad, null), /CHECK constraint failed/, `time ${JSON.stringify(bad)}`);
  }
  for (const cents of [0, -1, 1_000_001]) assert.throws(() => insert(GOOD, cents), /CHECK constraint failed/, `amount ${cents}`);
  assert.throws(() => insert(GOOD, null, 999), /FOREIGN KEY constraint failed/, 'the creator must exist');
  const row = one<{ reason: string }>(db, 'SELECT reason FROM tickets LIMIT 1');
  assert.equal(row?.reason, '', 'the reason defaults to empty');
  db.close();
});
