// The only module that imports node:sqlite. node:sqlite is experimental on
// Node 22, so everything that touches it is confined here: rows are copied to
// plain objects (node:sqlite returns null-prototype objects), lastInsertRowid is
// returned as a Number, and transactions use BEGIN IMMEDIATE.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;
export type Param = SQLInputValue;

export type Role = 'admin' | 'member';
export type ReservationStatus = 'confirmed' | 'pending' | 'declined';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ReservationRow {
  id: number;
  user_id: number;
  created_by: number;
  status: ReservationStatus;
  start_utc: string;
  end_utc: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export type UsageStatus = 'draft' | 'completed';

export interface UsageRow {
  id: number;
  user_id: number;
  start_utc: string;
  /** For a draft this is a placeholder equal to start_utc (the drive has not ended yet). */
  end_utc: string;
  odometer_start: number | null;
  odometer_end: number | null;
  reservation_id: number | null;
  note: string;
  created_by: number;
  status: UsageStatus;
  created_at: string;
  updated_at: string;
}

/** A fill-up: who fuelled, when, how much and what it cost. Money is integer cents, volume integer millilitres. */
export interface FuelRow {
  id: number;
  user_id: number;
  at_utc: string;
  millilitres: number;
  total_cents: number;
  note: string;
  created_by: number;
  created_at: string;
  updated_at: string;
}

/** One payment request per debtor per fill-up; amount and text are a snapshot taken when it was made. */
export interface FuelRequestRow {
  id: number;
  fuel_id: number;
  debtor_id: number;
  amount_cents: number;
  provider: 'manual' | 'tikkie';
  message: string;
  link: string;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  paid_by: number | null;
}

export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

// Overlap, window and purge logic compares timestamps as text, which is only
// correct for one fixed-width UTC shape (2026-06-15T10:00:00.000Z, what
// Date#toISOString and parseInstant produce). SQLite has no date type, so this
// CHECK is the type: a hand-edited '2026-06-15 10:00' fails loudly instead of
// silently sorting before every same-day value.
const UTC_MS = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

// Append-only once released: never edit an entry that has shipped, add the next
// one (additive first; a table rebuild needs foreign_keys=OFF outside the
// transaction, which migrate() does not do yet). Each entry runs in its own
// transaction together with the user_version bump, so a failure changes nothing.
export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL CHECK (expires_at GLOB ${UTC_MS}),
    refreshed_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  -- user_id is the driver (the person the reservation is for). created_by is
  -- who made it; they differ for suggestions and approved suggestions.
  -- AUTOINCREMENT: ids are shown to users and written to the log, so a deleted
  -- row's id must never come back for a different reservation (a stale
  -- "approve" tap must not hit someone else's suggestion).
  CREATE TABLE reservations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL CHECK (status IN ('confirmed', 'pending', 'declined')),
    start_utc  TEXT NOT NULL CHECK (start_utc GLOB ${UTC_MS}),
    end_utc    TEXT NOT NULL CHECK (end_utc GLOB ${UTC_MS}),
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (start_utc < end_utc)
  );
  CREATE INDEX reservations_range ON reservations(status, start_utc, end_utc);
  CREATE INDEX reservations_end ON reservations(end_utc);
  CREATE INDEX reservations_user ON reservations(user_id);
  CREATE INDEX reservations_creator ON reservations(created_by);

  CREATE TABLE usage (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    start_utc      TEXT NOT NULL CHECK (start_utc GLOB ${UTC_MS}),
    end_utc        TEXT NOT NULL CHECK (end_utc GLOB ${UTC_MS}),
    odometer_start INTEGER CHECK (odometer_start IS NULL OR odometer_start >= 0),
    odometer_end   INTEGER CHECK (odometer_end IS NULL OR odometer_end >= 0),
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    note           TEXT NOT NULL DEFAULT '',
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    CHECK (end_utc >= start_utc),
    CHECK (odometer_start IS NULL OR odometer_end IS NULL OR odometer_end >= odometer_start)
  );
  CREATE INDEX usage_range ON usage(start_utc, end_utc);
  CREATE INDEX usage_end ON usage(end_utc);
  CREATE INDEX usage_user ON usage(user_id);
  CREATE INDEX usage_reservation ON usage(reservation_id);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // 2: km registration drafts, fuel fill-ups with payment requests, web push.
  // Additive only (no table rebuild): no other table references usage.
  // A draft is a usage row whose drive has not ended yet: it carries only the
  // start reading, and end_utc holds start_utc as a placeholder (the API shows
  // it as end: null). The CHECK keeps that placeholder from leaking into a
  // completed row, and the partial unique index allows one open draft per driver.
  `
  ALTER TABLE usage ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('draft', 'completed'))
    CHECK (status = 'completed' OR (odometer_start IS NOT NULL AND odometer_end IS NULL AND end_utc = start_utc));
  CREATE UNIQUE INDEX usage_one_draft ON usage(user_id) WHERE status = 'draft';

  -- user_id is who fuelled (and is owed). Money is integer cents, volume integer millilitres.
  CREATE TABLE fuel (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    at_utc      TEXT NOT NULL CHECK (at_utc GLOB ${UTC_MS}),
    millilitres INTEGER NOT NULL CHECK (millilitres BETWEEN 1 AND 200000),
    total_cents INTEGER NOT NULL CHECK (total_cents BETWEEN 1 AND 1000000),
    note        TEXT NOT NULL DEFAULT '',
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX fuel_at ON fuel(at_utc, id);
  CREATE INDEX fuel_user ON fuel(user_id);

  -- A snapshot of what was asked of one person for one fill-up.
  CREATE TABLE fuel_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fuel_id      INTEGER NOT NULL REFERENCES fuel(id) ON DELETE CASCADE,
    debtor_id    INTEGER NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    provider     TEXT NOT NULL CHECK (provider IN ('manual', 'tikkie')),
    message      TEXT NOT NULL,
    link         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    paid_at      TEXT CHECK (paid_at IS NULL OR paid_at GLOB ${UTC_MS}),
    paid_by      INTEGER REFERENCES users(id),
    UNIQUE (fuel_id, debtor_id)
  );
  CREATE INDEX fuel_requests_debtor ON fuel_requests(debtor_id);

  CREATE TABLE push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

  -- One row per reminder that was claimed for sending; the primary key is what
  -- makes a reminder go out once, also across restarts.
  CREATE TABLE reminders_sent (
    reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('start', 'end', 'repeat')),
    scheduled_utc  TEXT NOT NULL CHECK (scheduled_utc GLOB ${UTC_MS}),
    sent_at        TEXT NOT NULL,
    PRIMARY KEY (reservation_id, kind, scheduled_utc)
  ) WITHOUT ROWID;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Open (and migrate) the database file; use ':memory:' for a throwaway one.
 * `migrations` is only overridden by tests that exercise the upgrade path.
 */
export function openDb(file: string, migrations: readonly string[] = MIGRATIONS): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // busy_timeout first, so switching to WAL waits for a process that is mid-write instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA secure_delete = ON');
    if (file !== ':memory:') copyBeforeMigrating(db, file, migrations);
    migrate(db, migrations);
  } catch (err) {
    // Do not leave the file locked behind a failed open (a refused or failed migration).
    db.close();
    throw err;
  }
  return db;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Before the first migration step that changes an existing database, write
 * backups/pre-migrate-v<from>.db next to it (VACUUM INTO), so an upgrade can be
 * undone with the restore command. A brand-new file has nothing to protect, an
 * existing copy (another process, an earlier start) is kept, and a copy that
 * cannot be written aborts the open with the data untouched (fail closed).
 * The folder is computed here, not imported from retention.ts (that would be a cycle).
 */
function copyBeforeMigrating(db: Db, file: string, migrations: readonly string[]): void {
  const from = schemaVersion(db);
  // `migrations.length` is only read once there is something to protect: the
  // migration-race test hooks that read to interleave a second process.
  if (from === 0 || from >= migrations.length) return;
  const dir = path.join(path.dirname(file), 'backups');
  const dest = path.join(dir, `pre-migrate-v${from}.db`);
  if (fs.existsSync(dest)) return;
  const tmp = `${dest}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(tmp, { force: true });
    vacuumInto(db, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot write the pre-migration copy ${dest}; the database was not changed: ${why}`, { cause: err });
  }
}

/** Apply the migrations the file has not seen yet. */
function migrate(db: Db, migrations: readonly string[]): void {
  const tooNew = (found: number): Error =>
    new Error(`Database schema v${found} is newer than this app (v${migrations.length})`);
  const seen = schemaVersion(db);
  if (seen > migrations.length) throw tooNew(seen);
  for (let v = seen; v < migrations.length; v++) {
    tx(db, () => {
      // Look again now that we hold the write lock: a second process (the CLI
      // next to the server, say) may have applied this step while we waited,
      // and running a CREATE TABLE twice would crash it.
      const found = schemaVersion(db);
      if (found > migrations.length) throw tooNew(found);
      if (found > v) return;
      db.exec(migrations[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/**
 * Run fn inside BEGIN IMMEDIATE ... COMMIT (ROLLBACK on throw). fn must be
 * synchronous: it is the only thing that makes check-then-write sequences such
 * as the overlap check atomic. Nested calls join the outer transaction.
 */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the original error is the interesting one
    }
    throw err;
  }
}

function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

/** First row as a plain object, or undefined. */
export function one<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  const row = db.prepare(sql).get(...params);
  return row === undefined ? undefined : plain<T>(row);
}

/** All rows as plain objects. */
export function many<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params).map((r) => plain<T>(r));
}

/** Run a write statement. */
export function run(db: Db, sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** SQLITE_CONSTRAINT_UNIQUE (2067) or SQLITE_CONSTRAINT_PRIMARYKEY (1555). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { errcode?: number } | null)?.errcode;
  return code === 2067 || code === 1555;
}

export function getMeta(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, 'SELECT value FROM meta WHERE key = ?', key)?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  run(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

/** Write a consistent, compacted copy of a live database to a new file (VACUUM INTO). */
export function vacuumInto(db: Db, file: string): void {
  db.prepare('VACUUM INTO ?').run(file);
}

/** Copy a database file that no process has open (used by restore for the pre-restore copy). */
export function vacuumFileInto(srcFile: string, destFile: string): void {
  const db = new DatabaseSync(srcFile);
  try {
    vacuumInto(db, destFile);
  } finally {
    db.close();
  }
}

/** PRAGMA integrity_check on a database file, plus its schema version. */
export function checkDbFile(file: string): { ok: boolean; detail: string; version: number } {
  const db = new DatabaseSync(file);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const detail = rows.map((r) => String(Object.values(r)[0])).join('; ');
    return { ok: rows.length === 1 && detail === 'ok', detail, version: schemaVersion(db) };
  } finally {
    db.close();
  }
}

export function countRows(
  db: Db,
  table: 'users' | 'reservations' | 'usage' | 'sessions' | 'fuel' | 'fuel_requests' | 'push_subscriptions',
): number {
  return one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
}
