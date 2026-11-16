import fs from 'node:fs';
import path from 'node:path';
import type { Config, Clock } from './config.ts';
import { SCHEMA_VERSION, checkDbFile, getMeta, setMeta, vacuumFileInto, vacuumInto, type Db } from './db.ts';
import type { Logger } from './http.ts';
import { BACKUP_RE, backupDir, listBackups, purge } from './retention.ts';
import { localDateKey } from '../shared/time.js';

export interface MaintCtx {
  db: Db;
  clock: Clock;
  config: Config;
  log: Logger;
}

export const DB_FILE = 'car.db';

export function dbPath(dataDir: string): string {
  return path.join(dataDir, DB_FILE);
}

/**
 * Write today's backup (car-YYYY-MM-DD.db, local date) with VACUUM INTO a
 * temporary name and rename it into place, then rotate old backups.
 */
export function createBackup(ctx: MaintCtx): { file: string; path: string; size: number; deleted: string[] } {
  const { db, config } = ctx;
  const now = ctx.clock.now();
  const dir = backupDir(config.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = `car-${localDateKey(now, config.tz)}.db`;
  const finalPath = path.join(dir, file);
  const tmpPath = `${finalPath}.tmp`;
  fs.rmSync(tmpPath, { force: true });
  vacuumInto(db, tmpPath);
  fs.renameSync(tmpPath, finalPath);
  setMeta(db, 'last_backup_at', now.toISOString());
  setMeta(db, 'last_backup_file', file);
  const deleted = rotateBackups(dir, config.backupKeepDays);
  const size = fs.statSync(finalPath).size;
  ctx.log({ event: 'backup.created', file, size, rotated: deleted.length });
  return { file, path: finalPath, size, deleted };
}

/**
 * Keep the newest `keep` backups (by the date in the file name) and delete the
 * rest. Only files named car-YYYY-MM-DD.db are ever touched, plus leftover
 * car-*.db.tmp files from an interrupted backup.
 */
export function rotateBackups(dir: string, keep: number): string[] {
  const deleted: string[] = [];
  for (const b of listBackups(dir).slice(keep)) {
    fs.rmSync(path.join(dir, b.file), { force: true });
    deleted.push(b.file);
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // no backup directory yet
  }
  for (const name of names) {
    if (name.endsWith('.tmp') && BACKUP_RE.test(name.slice(0, -4))) {
      const p = path.join(dir, name);
      // an in-flight backup is seconds old; anything older than an hour is a leftover
      if (Date.now() - fs.statSync(p).mtimeMs > 3_600_000) fs.rmSync(p, { force: true });
    }
  }
  return deleted;
}

/**
 * Restore a backup file over the live database. The app must be stopped. The
 * candidate is integrity-checked first, the current database is copied to
 * backups/pre-restore-<timestamp>.db, and stale -wal/-shm files are removed.
 */
export function restoreBackup(config: Config, backupFile: string, now: Date): { preRestore: string | undefined } {
  const source = path.resolve(backupFile);
  if (!fs.existsSync(source)) throw new Error(`Backup file not found: ${source}`);
  const check = checkDbFile(source);
  if (!check.ok) throw new Error(`Backup failed integrity_check: ${check.detail}`);
  if (check.version < 1 || check.version > SCHEMA_VERSION) {
    throw new Error(`Backup has schema version ${check.version}, this app supports up to ${SCHEMA_VERSION}`);
  }
  const target = dbPath(config.dataDir);
  fs.mkdirSync(config.dataDir, { recursive: true });
  let preRestore: string | undefined;
  if (fs.existsSync(target)) {
    const dir = backupDir(config.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    preRestore = path.join(dir, `pre-restore-${stamp}.db`);
    try {
      vacuumFileInto(target, preRestore);
    } catch {
      fs.copyFileSync(target, preRestore);
    }
  }
  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
  const staging = `${target}.restore.tmp`;
  fs.copyFileSync(source, staging);
  fs.renameSync(staging, target);
  return { preRestore };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Daily maintenance: purge, then back up, once per local calendar day. Cheap
 * enough to call every 30 minutes; it does nothing when today is already done.
 */
export function tick(ctx: MaintCtx): boolean {
  const { db, config } = ctx;
  const now = ctx.clock.now();
  const today = localDateKey(now, config.tz);
  if (getMeta(db, 'last_maintenance_day') === today) return false;
  try {
    purge(db, now, config.tz, ctx.log, config.windowMonths);
    createBackup(ctx);
    setMeta(db, 'last_maintenance_day', today);
    return true;
  } catch (err) {
    // last_maintenance_day stays unset, so the next tick retries.
    ctx.log({ event: 'maintenance.error', message: errMessage(err) });
    return false;
  }
}

/** Purge at startup, back up if there is none for today, then check every 30 minutes. */
export function startMaintenance(ctx: MaintCtx): { stop(): void } {
  const { db, config } = ctx;
  try {
    const now = ctx.clock.now();
    const today = localDateKey(now, config.tz);
    purge(db, now, config.tz, ctx.log, config.windowMonths);
    if (!fs.existsSync(path.join(backupDir(config.dataDir), `car-${today}.db`))) createBackup(ctx);
    setMeta(db, 'last_maintenance_day', today);
  } catch (err) {
    ctx.log({ event: 'maintenance.error', message: errMessage(err) });
  }
  const timer = setInterval(() => tick(ctx), 30 * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
