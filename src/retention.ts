import fs from 'node:fs';
import path from 'node:path';
import { countRows, getMeta, one, run, setMeta, tx, type Db } from './db.ts';
import { ok, type Ctx, type Logger, type Router } from './http.ts';
import { windowBounds } from './validate.ts';

export interface PurgeResult {
  cutoff: string;
  reservations: number;
  usage: number;
  sessions: number;
}

/**
 * Permanently delete everything that ended before the start of the retention
 * window (calendar months back in the household zone), plus expired sessions.
 * The comparison is strictly "end < cutoff": a row ending exactly at the
 * cutoff is still inside the window (validation accepts it) and is kept.
 * Current and future data is never touched.
 */
export function purge(db: Db, now: Date, tz: string, log: Logger, months = 6): PurgeResult {
  const cutoff = windowBounds(now, tz, months).from;
  const nowIso = now.toISOString();
  const result = tx(db, () => {
    const usage = run(db, 'DELETE FROM usage WHERE end_utc < ?', cutoff).changes;
    const reservations = run(db, 'DELETE FROM reservations WHERE end_utc < ?', cutoff).changes;
    const sessions = run(db, 'DELETE FROM sessions WHERE expires_at < ?', nowIso).changes;
    const r: PurgeResult = { cutoff, reservations, usage, sessions };
    setMeta(db, 'last_purge_at', nowIso);
    setMeta(db, 'last_purge', JSON.stringify(r));
    return r;
  });
  try {
    // Fold the WAL back so deleted rows do not linger in the -wal file.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log({ event: 'retention.checkpoint_failed', message: err instanceof Error ? err.message : String(err) });
  }
  log({ event: 'retention.purge', ...result });
  return result;
}

// ------------------------------------------------------------ backup listing

export const BACKUP_RE = /^car-(\d{4}-\d{2}-\d{2})\.db$/;

export function backupDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

export interface BackupInfo {
  file: string;
  date: string;
  size: number;
}

/** Backup files (newest first), matching only the names this app writes. */
export function listBackups(dir: string): BackupInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const file of names) {
    const m = BACKUP_RE.exec(file);
    if (!m) continue;
    out.push({ file, date: m[1] as string, size: fs.statSync(path.join(dir, file)).size });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// -------------------------------------------------------------------- routes

export function retentionStatus(ctx: Ctx): Record<string, unknown> {
  const { db, config } = ctx;
  const now = ctx.clock.now();
  const bounds = windowBounds(now, config.tz, config.windowMonths);
  const lastPurgeRaw = getMeta(db, 'last_purge');
  return {
    timeZone: config.tz,
    windowMonths: config.windowMonths,
    window: bounds,
    cutoff: bounds.from,
    lastPurgeAt: getMeta(db, 'last_purge_at') ?? null,
    lastPurge: lastPurgeRaw ? (JSON.parse(lastPurgeRaw) as PurgeResult) : null,
    lastMaintenanceDay: getMeta(db, 'last_maintenance_day') ?? null,
    lastBackupAt: getMeta(db, 'last_backup_at') ?? null,
    lastBackupFile: getMeta(db, 'last_backup_file') ?? null,
    backupKeep: config.backupKeepDays,
    backups: listBackups(backupDir(config.dataDir)),
    counts: {
      reservations: countRows(db, 'reservations'),
      usage: countRows(db, 'usage'),
      sessions: countRows(db, 'sessions'),
    },
    oldest: {
      reservationEnd: one<{ v: string | null }>(db, 'SELECT MIN(end_utc) AS v FROM reservations')?.v ?? null,
      usageEnd: one<{ v: string | null }>(db, 'SELECT MIN(end_utc) AS v FROM usage')?.v ?? null,
    },
  };
}

export function registerRetentionRoutes(router: Router, ctx: Ctx): void {
  router.add('GET', '/api/admin/retention', 'admin', () => ok(retentionStatus(ctx)));

  router.add('POST', '/api/admin/retention/run', 'admin', async (req) => {
    await req.json();
    ctx.log({ event: 'retention.manual_run', by: req.user?.id });
    const result = purge(ctx.db, ctx.clock.now(), ctx.config.tz, ctx.log, ctx.config.windowMonths);
    return ok({ result, status: retentionStatus(ctx) });
  });
}
