import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STATS_RETENTION_MONTHS } from './config.ts';
import { countRows, getMeta, many, one, run, setMeta, tx, type Db } from './db.ts';
import { ok, type Ctx, type Logger, type Router } from './http.ts';
import { TOTAL_COLUMNS, TOTAL_FIELDS, computeMonths, deriveBaseline, planFreeze, type MonthRows, type Months, type Totals } from './stats.ts';
import { windowBounds, windowStartDate } from './validate.ts';
import { addMonthKey, monthKeyOf } from '../shared/time.js';

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
  /** Damage reports that were repaired before the first day of the window. An open report is never counted here: it is never purged. */
  damageReports: number;
  sessions: number;
  /** Months whose monthly totals were stored (frozen) by this run, before the rows behind them were deleted. */
  statsFrozen: number;
  /** Stored monthly totals older than the statistics retention (STATS_RETENTION_MONTHS) that this run deleted. */
  statsDropped: number;
}

/**
 * Permanently delete everything that ended before the start of the retention
 * window (calendar months back in the household zone), plus expired sessions.
 * The comparison is strictly "end < cutoff": a row ending exactly at the
 * cutoff is still inside the window (validation accepts it) and is kept.
 * Current and future data is never touched.
 * A damage report is the exception to "ended": an open one is kept however old it is, because the damage is
 * still on the car; a repaired one goes when the calendar day it was repaired is before the local day of the
 * cutoff (so one repaired on the cutoff's own day is kept). That is date granularity, coarser than the instants above.
 * The other exception is the monthly statistics (stats.ts): before anything is deleted, the months that this run
 * changes are stored as numbers only, in the same transaction, and stored months older than `statsMonths` months
 * are dropped. If storing fails, nothing is deleted: the rows must not go without their totals.
 */
export function purge(db: Db, now: Date, tz: string, log: Logger, months = 6, statsMonths = DEFAULT_STATS_RETENTION_MONTHS): PurgeResult {
  const cutoff = windowBounds(now, tz, months).from;
  const nowIso = now.toISOString();
  // The statistics line comes out of the transaction with the result and is logged only once it has committed: a
  // rollback must not leave a line behind that says months were stored.
  const { result, statsLine } = tx(db, () => {
    // The live numbers before anything is deleted: what a month that is about to change is stored as.
    const before = computeMonths(db, tz);
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
    // Only repaired reports, and by the day they were repaired: the status filter is what keeps an open one safe.
    const damageReports = run(db, "DELETE FROM damage_reports WHERE status = 'repaired' AND repaired_on < ?", windowStartDate(now, tz, months)).changes;
    const sessions = run(db, 'DELETE FROM sessions WHERE expires_at < ?', nowIso).changes;
    // Any delete can change a month, also one that lost no row of its own (a fill-up whose earlier fill-up went
    // has a shorter period; an explanation that went re-opens a gap). So compare, do not assume. Sessions are in no number.
    const anyDeleted = [usage, reservations, fuel, fuelRequests, tickets, odometerExplained, damageReports].some((n) => n > 0);
    const after = anyDeleted ? computeMonths(db, tz) : before;
    const stats = storeStatistics(db, { before, after, now, tz, cutoff, windowMonths: months, statsMonths });
    const r: PurgeResult = {
      cutoff,
      reservations,
      usage,
      fuel,
      fuelRequests,
      tickets,
      odometerExplained,
      damageReports,
      sessions,
      statsFrozen: stats.frozen,
      statsDropped: stats.dropped,
    };
    setMeta(db, 'last_purge_at', nowIso);
    setMeta(db, 'last_purge', JSON.stringify(r));
    return { result: r, statsLine: stats.line };
  });
  if (statsLine !== null) log(statsLine);
  try {
    // Fold the WAL back so deleted rows do not linger in the -wal file.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log({ event: 'retention.checkpoint_failed', message: err instanceof Error ? err.message : String(err) });
  }
  log({ event: 'retention.purge', ...result });
  return result;
}

// ------------------------------------------------------- monthly statistics

interface StoreInput {
  /** The live months before the purge deleted anything, and after (the same object when nothing was deleted). */
  before: Months;
  after: Months;
  now: Date;
  tz: string;
  cutoff: string;
  windowMonths: number;
  statsMonths: number;
}

const INSERT_TOTALS_SQL = `INSERT INTO stats_totals (month, user_id, ${TOTAL_COLUMNS.join(', ')}) VALUES (?, ?, ${TOTAL_COLUMNS.map(() => '?').join(', ')})`;

/** Store one month as frozen numbers (replacing a marker, if the month had one). */
function writeFrozenMonth(db: Db, month: string, complete: boolean, rows: MonthRows | undefined): void {
  run(db, 'INSERT INTO stats_months (month, complete, frozen) VALUES (?, ?, 1) ON CONFLICT(month) DO UPDATE SET complete = excluded.complete, frozen = 1', month, complete ? 1 : 0);
  for (const [userId, totals] of rows ?? new Map<number, Totals>()) {
    run(db, INSERT_TOTALS_SQL, month, userId, ...TOTAL_FIELDS.map((f) => totals[f]));
  }
}

/**
 * The statistics part of a purge, inside its transaction and after its deletes: write the baseline once, freeze the
 * months the plan says (always from `before`), leave a marker on a live month that changed, and drop stored months
 * older than the statistics retention. A throw here rolls the whole purge back. It logs nothing itself: it returns
 * the log line (or null when there is nothing to say) for the caller to write once the transaction has committed.
 */
function storeStatistics(db: Db, p: StoreInput): { frozen: number; dropped: number; line: Record<string, unknown> | null } {
  const current = monthKeyOf(p.now, p.tz);
  const keepFrom = addMonthKey(current, -(p.statsMonths - 1));

  // What is known about months before the statistics existed, stored once. Only the run that stores it can
  // freeze "legacy" months (already cut short by earlier purges); with no user yet nothing is known, so it waits.
  let legacyThrough: string | null = null;
  if (getMeta(db, 'stats_first_month') === undefined) {
    const baseline = deriveBaseline(db, p.now, p.tz, p.windowMonths);
    if (baseline.firstMonth !== null) {
      setMeta(db, 'stats_first_month', baseline.firstMonth);
      if (baseline.legacyThrough !== null) {
        setMeta(db, 'stats_legacy_through', baseline.legacyThrough);
        legacyThrough = baseline.legacyThrough;
      }
    }
  }

  const stored = many<{ month: string; frozen: number }>(db, 'SELECT month, frozen FROM stats_months');
  const plan = planFreeze({
    before: p.before,
    after: p.after,
    frozen: new Set(stored.filter((m) => m.frozen === 1).map((m) => m.month)),
    marked: new Set(stored.filter((m) => m.frozen === 0).map((m) => m.month)),
    current,
    keepFrom,
    cutoffMonth: monthKeyOf(p.cutoff, p.tz),
    legacyThrough,
  });
  for (const m of plan.freeze) writeFrozenMonth(db, m.month, m.complete, p.before.get(m.month));
  for (const month of plan.mark) run(db, 'INSERT OR IGNORE INTO stats_months (month, complete, frozen) VALUES (?, 0, 0)', month);

  // Totals older than the statistics retention go (their totals cascade). Markers older than that go with them.
  const dropped = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM stats_months WHERE frozen = 1 AND month < ?', keepFrom)?.n ?? 0;
  run(db, 'DELETE FROM stats_months WHERE month < ?', keepFrom);

  // Month keys and counts only, like every log line: no number of a person.
  const line =
    plan.freeze.length > 0 || plan.mark.length > 0 || dropped > 0
      ? { event: 'retention.stats', frozen: plan.freeze.map((m) => m.month), incomplete: plan.freeze.filter((m) => !m.complete).map((m) => m.month), marked: plan.mark, dropped }
      : null;
  return { frozen: plan.freeze.length, dropped, line };
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
    statsRetentionMonths: config.statsRetentionMonths,
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
      damageReports: countRows(db, 'damage_reports'),
      // Stored months only: a marker row (a live month the purge changed) is not a stored total.
      statsMonths: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM stats_months WHERE frozen = 1')?.n ?? 0,
      sessions: countRows(db, 'sessions'),
    },
    oldest: {
      reservationEnd: one<{ v: string | null }>(db, 'SELECT MIN(end_utc) AS v FROM reservations')?.v ?? null,
      usageEnd: one<{ v: string | null }>(db, 'SELECT MIN(end_utc) AS v FROM usage')?.v ?? null,
      fuelAt: one<{ v: string | null }>(db, 'SELECT MIN(at_utc) AS v FROM fuel')?.v ?? null,
      ticketAt: one<{ v: string | null }>(db, 'SELECT MIN(at_utc) AS v FROM tickets')?.v ?? null,
      // A calendar date ('YYYY-MM-DD'), not an instant, so it has its own row on the admin page. Open reports have none.
      damageRepairedOn: one<{ v: string | null }>(db, "SELECT MIN(repaired_on) AS v FROM damage_reports WHERE status = 'repaired'")?.v ?? null,
      // A month ('YYYY-MM'), not an instant: the oldest stored monthly total.
      statsMonth: one<{ v: string | null }>(db, 'SELECT MIN(month) AS v FROM stats_months WHERE frozen = 1')?.v ?? null,
    },
  };
}

export function registerRetentionRoutes(router: Router, ctx: Ctx): void {
  router.add('GET', '/api/admin/retention', 'admin', () => ok(retentionStatus(ctx)));

  router.add('POST', '/api/admin/retention/run', 'admin', async (req) => {
    await req.json();
    ctx.log({ event: 'retention.manual_run', by: req.user?.id });
    const result = purge(ctx.db, ctx.clock.now(), ctx.config.tz, ctx.log, ctx.config.windowMonths, ctx.config.statsRetentionMonths);
    return ok({ result, status: retentionStatus(ctx) });
  });
}
