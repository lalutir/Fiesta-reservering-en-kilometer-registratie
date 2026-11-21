import fs from 'node:fs';
import path from 'node:path';
import { countRows, getMeta, one, run, setMeta, tx, type Db } from './db.ts';
import { ok, type Ctx, type Logger, type Router } from './http.ts';
import { windowBounds } from './validate.ts';

export interface PurgeResult {
  cutoff: string;
  reservations: number;
  usage: number;
  /** Fill-ups older than the window, and (with them) their payment requests. */
  fuel: number;
  fuelRequests: number;
  /** Traffic tickets whose offence time is older than the window. */
  tickets: number;
  /** "Explained" notes on odometer findings whose earlier reading is older than the window: the pair can no longer be flagged. */
  odometerExplained: number;
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
    // Count the requests first: the cascade removes them with their fill-up, and an unpaid
    // request older than the window goes with it (the window is the whole retention promise).
    const fuelRequests =
      one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM fuel_requests WHERE fuel_id IN (SELECT id FROM fuel WHERE at_utc < ?)', cutoff)?.n ?? 0;
    const fuel = run(db, 'DELETE FROM fuel WHERE at_utc < ?', cutoff).changes;
    // A ticket goes by the time of the offence. A completed drive or a reservation that names the
    // driver ends no earlier than that time, so it outlives the ticket. The one exception is an open
    // draft, whose end is its start: one forgotten for six months is purged on its own and can stop
    // answering for a ticket in the first day after the cutoff (the ticket then shows no driver).
    const tickets = run(db, 'DELETE FROM tickets WHERE at_utc < ?', cutoff).changes;
    // An explanation belongs to a pair of readings; the odometer chain only looks at readings from the cutoff
    // on (odometer.ts), so once the earlier reading is older than that the pair can never be flagged again.
    const odometerExplained = run(db, 'DELETE FROM odometer_explained WHERE prev_at < ?', cutoff).changes;
    const sessions = run(db, 'DELETE FROM sessions WHERE expires_at < ?', nowIso).changes;
    const r: PurgeResult = { cutoff, reservations, usage, fuel, fuelRequests, tickets, odometerExplained, sessions };
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
      fuel: countRows(db, 'fuel'),
      fuelRequests: countRows(db, 'fuel_requests'),
      tickets: countRows(db, 'tickets'),
      odometerExplained: countRows(db, 'odometer_explained'),
      sessions: countRows(db, 'sessions'),
    },
    oldest: {
      reservationEnd: one<{ v: string | null }>(db, 'SELECT MIN(end_utc) AS v FROM reservations')?.v ?? null,
      usageEnd: one<{ v: string | null }>(db, 'SELECT MIN(end_utc) AS v FROM usage')?.v ?? null,
      fuelAt: one<{ v: string | null }>(db, 'SELECT MIN(at_utc) AS v FROM fuel')?.v ?? null,
      ticketAt: one<{ v: string | null }>(db, 'SELECT MIN(at_utc) AS v FROM tickets')?.v ?? null,
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
