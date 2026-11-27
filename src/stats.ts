// Monthly statistics: per person and for the household, per calendar month, derived from the records the
// app already keeps (drives, fill-ups, tickets, damage reports, the odometer chain), plus a small table of
// numbers-only totals that outlives the 6-month window (migration 7).
//
// Nothing here is a second implementation of anything. The fuel numbers are what fuelOverview() (fuel.ts)
// says for the Fuel screen, summed per month: the admin pays nothing, the together pool follows the ratio of
// the personal kilometres, deactivated users with kilometres still pay for them. The driver of a ticket is
// whoDrove() (tickets.ts). The unaccounted kilometres are the open gaps of the odometer chain (odometer.ts).
// This file only decides which month each number belongs to and adds them up.
//
// THE ATTRIBUTION RULE, one for everything, in the household time zone (a month starts at local midnight):
//   drive         to the month it STARTED in; the trip to the driver, the kilometres to whose they are
//                 (a person's own, another person's, or together on the household row). A drive that
//                 spans midnight of the 1st belongs to the month it started. Drafts never count; a
//                 finished drive without both readings is a trip and adds no kilometres.
//   fill-up       to the month of the fill-up, and with it everything derived from it: litres and
//                 euros (to the fueler), each share and the kilometres it was split over (to the payer),
//                 and the consumption over the interval that ENDS at this fill-up.
//   ticket        to the month of the offence; to the person whoDrove() names, else to the household row.
//   damage report to the month of noticed_on; to the person who filed it.
//   gap           to the month of its LATER reading, on the household row.
//
// Only the purge writes the stored totals (retention.ts): it freezes a month from the numbers just BEFORE it
// deletes the rows they came from, in the same transaction, so a total never drops because its source is gone.
// GET /api/stats never writes. Everything in a total is an additive component (counts, cents, millilitres,
// kilometres); averages are derived on read, as integers with a fixed scale, so months and people can be added.

import { many, one, getMeta, type Db } from './db.ts';
import { fuelOverview } from './fuel.ts';
import { ok, type Ctx, type Principal, type Router } from './http.ts';
import { loadChain, openGaps } from './odometer.ts';
import { whoDrove } from './tickets.ts';
import { failIfAny, windowBounds } from './validate.ts';
import { addMonthKey, monthKeyOf, parseMonthKey } from '../shared/time.js';

/** Version of the JSON contract of GET /api/stats (docs/STATS-API.md). */
export const STATS_VERSION = 1;

/** The row that holds what belongs to nobody in particular: together kilometres, a ticket without a driver, unaccounted kilometres, consumption. */
export const HOUSEHOLD = 0;

/**
 * The components of a total, in one list. The columns of stats_totals are these names in snake_case (a test
 * compares the two), and docs/STATS-API.md describes each one (a test compares that too).
 */
export const TOTAL_FIELDS = [
  'trips',
  'km',
  'togetherKm',
  'fillUps',
  'millilitres',
  'paidCents',
  'shareCents',
  'costCents',
  'costKm',
  'poolKm',
  'consumptionMl',
  'consumptionKm',
  'tickets',
  'ticketCents',
  'damageReports',
  'unaccountedKm',
] as const;

export type TotalField = (typeof TOTAL_FIELDS)[number];
export type Totals = Record<TotalField, number>;

/** The column of stats_totals for a component: togetherKm -> together_km. */
export const columnOf = (field: TotalField): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The columns of stats_totals that hold the components, in TOTAL_FIELDS order (what the purge writes and the report reads). */
export const TOTAL_COLUMNS: readonly string[] = TOTAL_FIELDS.map(columnOf);

export const emptyTotals = (): Totals => Object.fromEntries(TOTAL_FIELDS.map((f) => [f, 0])) as Totals;

/** What fuelOverview() needs as the person asking: nobody (id 0 matches no user), so it only reads. */
export const SYSTEM_PRINCIPAL: Principal = { id: HOUSEHOLD, username: 'system', displayName: 'system', role: 'member', sessionId: 0 };

/** person id (HOUSEHOLD for the shared row) -> the totals of one month. Rows that are all zero do not exist. */
export type MonthRows = Map<number, Totals>;
/** month ('YYYY-MM') -> its rows. */
export type Months = Map<string, MonthRows>;

// ------------------------------------------------------------- computing the months

/** The live numbers of every month that has anything in it, from the records as they are right now. */
export function computeMonths(db: Db, tz: string): Months {
  const months: Months = new Map();
  const add = (month: string, userId: number, field: TotalField, n: number): void => {
    if (n === 0) return;
    let rows = months.get(month);
    if (!rows) months.set(month, (rows = new Map()));
    let totals = rows.get(userId);
    if (!totals) rows.set(userId, (totals = emptyTotals()));
    totals[field] += n;
  };
  const monthOf = (instant: string): string => monthKeyOf(instant, tz);

  // Drives: finished ones only. A draft has not ended, so it is no trip yet.
  const drives = many<{ user_id: number; km_for: string; km_user_id: number | null; start_utc: string; odometer_start: number | null; odometer_end: number | null }>(
    db,
    "SELECT user_id, km_for, km_user_id, start_utc, odometer_start, odometer_end FROM usage WHERE status = 'completed'",
  );
  for (const d of drives) {
    const month = monthOf(d.start_utc);
    add(month, d.user_id, 'trips', 1);
    if (d.odometer_start === null || d.odometer_end === null) continue;
    const km = d.odometer_end - d.odometer_start;
    if (d.km_for === 'together') add(month, HOUSEHOLD, 'togetherKm', km);
    else add(month, d.km_for === 'person' ? (d.km_user_id as number) : d.user_id, 'km', km);
  }

  // Fill-ups, oldest first (fuelOverview lists the newest first).
  const fills = [...fuelOverview(db, SYSTEM_PRINCIPAL).items].reverse();
  fills.forEach((f, i) => {
    const month = monthOf(f.at);
    add(month, f.userId, 'fillUps', 1);
    add(month, f.userId, 'millilitres', f.millilitres);
    add(month, f.userId, 'paidCents', f.totalCents);
    for (const s of f.shares) {
      add(month, s.userId, 'shareCents', s.cents);
      // The cost per kilometre only counts shares that were split over kilometres (not the equal split of a period nobody drove in).
      if (s.km > 0) {
        add(month, s.userId, 'costCents', s.cents);
        add(month, s.userId, 'costKm', s.km);
      }
    }
    // The pool of together kilometres is part of the period's kilometres when the personal kilometres carried the split.
    if (!f.equalSplit) add(month, HOUSEHOLD, 'poolKm', f.togetherKm);
    // Consumption: the litres of this fill-up over the kilometres since the previous one, when both have a reading.
    // The previous fill-up in the full order, never "the previous one that has a reading": a fill-up in between
    // without a reading means the interval is not known.
    const prev = fills[i - 1];
    if (prev && prev.odometer !== null && f.odometer !== null && f.odometer > prev.odometer) {
      add(month, HOUSEHOLD, 'consumptionMl', f.millilitres);
      add(month, HOUSEHOLD, 'consumptionKm', f.odometer - prev.odometer);
    }
  });

  for (const t of many<{ at_utc: string; amount_cents: number | null }>(db, 'SELECT at_utc, amount_cents FROM tickets')) {
    const month = monthOf(t.at_utc);
    // Whoever the drive log and the reservations name; nobody on record goes on the household row.
    const who = whoDrove(db, t.at_utc).driver?.id ?? HOUSEHOLD;
    add(month, who, 'tickets', 1);
    add(month, who, 'ticketCents', t.amount_cents ?? 0);
  }

  // The day a dent was noticed is a calendar date: its month is the first seven characters.
  for (const r of many<{ noticed_on: string; reported_by: number }>(db, 'SELECT noticed_on, reported_by FROM damage_reports')) {
    add(r.noticed_on.slice(0, 7), r.reported_by, 'damageReports', 1);
  }

  // Unaccounted kilometres: the open gaps over ALL retained readings (from '' = no lower bound), not only the
  // window, so the number cannot move with the day the cutoff rolls over.
  for (const gap of openGaps(db, loadChain(db, ''))) add(monthOf(gap.at), HOUSEHOLD, 'unaccountedKm', gap.km);

  return months;
}

/** A text that is equal for two sets of rows exactly when every number in them is equal. '' for no rows. */
export function monthSignature(rows: MonthRows | undefined): string {
  if (!rows) return '';
  return [...rows.keys()]
    .sort((a, b) => a - b)
    .map((userId) => `${userId}:${TOTAL_FIELDS.map((f) => (rows.get(userId) as Totals)[f]).join(',')}`)
    .join(';');
}

// ----------------------------------------------------------- what a purge must freeze

export interface FreezePlanInput {
  /** The live months just before the purge deleted anything. */
  before: Months;
  /** The live months just after (the same object as `before` when nothing was deleted). */
  after: Months;
  /** Months that already have a stored (frozen) total: never touched again. */
  frozen: ReadonlySet<string>;
  /** Months that carry a marker: the purge changed what they show while they were live, so they are incomplete. */
  marked: ReadonlySet<string>;
  /** The current month, and the oldest month that is kept (current - (N - 1)). */
  current: string;
  keepFrom: string;
  /** The month of the purge cutoff: months before it lost all their rows to the purge. */
  cutoffMonth: string;
  /** Set only on the very first purge of a database that was already older than the window: months up to it were cut short before this feature existed. */
  legacyThrough: string | null;
}

export interface FreezePlan {
  /** Months to store, from the BEFORE numbers; complete = false when they were already cut short. */
  freeze: Array<{ month: string; complete: boolean }>;
  /** Live months whose numbers the purge changed: they get a marker, no stored total. */
  mark: string[];
}

/**
 * Which months a purge freezes. Always from the numbers BEFORE the delete, in three cases:
 *   a) the numbers of the month changed between before and after. That is not only "its own rows were
 *      deleted": a fill-up whose earlier fill-up was purged gets a shorter period and other shares, and
 *      deleting an explanation re-opens a gap, without a single row of that month leaving;
 *   b) the first purge of an old database: months up to `legacyThrough` were already partly purged, so what
 *      is left is stored once and flagged incomplete;
 *   c) the month lies wholly before the cutoff (it can only hold what a purge never deletes, such as an open
 *      damage report) and has numbers: they must not depend on that leftover.
 * Months before keepFrom are not kept at all, months already stored are left alone, and the current month is never
 * frozen: a change there only leaves a marker, so the screen can say that it is no longer what it was.
 */
export function planFreeze(input: FreezePlanInput): FreezePlan {
  const plan: FreezePlan = { freeze: [], mark: [] };
  const months = [...new Set([...input.before.keys(), ...input.after.keys()])].sort();
  for (const month of months) {
    if (month < input.keepFrom || month > input.current || input.frozen.has(month)) continue;
    const before = input.before.get(month);
    const changed = monthSignature(before) !== monthSignature(input.after.get(month));
    if (month === input.current) {
      if (changed) plan.mark.push(month);
      continue;
    }
    const wholly = month < input.cutoffMonth && before !== undefined;
    const legacy = input.legacyThrough !== null && month <= input.legacyThrough && before !== undefined;
    if (changed || wholly || legacy) plan.freeze.push({ month, complete: !legacy && !input.marked.has(month) });
  }
  return plan;
}

// --------------------------------------------------------- first month and legacy months

export interface Baseline {
  /** The month of the oldest user: nothing existed before it, so an empty month before it is "not available", not zero. */
  firstMonth: string | null;
  /** On a database that was already older than the window: the last month that was (partly) purged before statistics existed. */
  legacyThrough: string | null;
}

/**
 * What is known about months before the statistics existed, worked out from the records as they are now. The purge
 * stores it once (meta stats_first_month, stats_legacy_through); until then the report derives the same values.
 * An old database is one whose first user is older than the cutoff: the purge of earlier versions already deleted
 * rows from before it. The last cut-short month is the later of the cutoff month (partly purged) and the month of
 * the oldest retained fill-up (its period reaches back into what was purged). Nothing is invented for them.
 */
export function deriveBaseline(db: Db, now: Date, tz: string, windowMonths: number): Baseline {
  const first = one<{ v: string | null }>(db, 'SELECT MIN(created_at) AS v FROM users')?.v ?? null;
  // A user row whose creation time is not a time (the column is free text) tells us nothing: never fail a purge over it.
  if (first === null || !Number.isFinite(Date.parse(first))) return { firstMonth: null, legacyThrough: null };
  const firstMonth = monthKeyOf(first, tz);
  const cutoff = windowBounds(now, tz, windowMonths).from;
  if (first >= cutoff) return { firstMonth, legacyThrough: null };
  const cutoffMonth = monthKeyOf(cutoff, tz);
  const oldestFuel = one<{ v: string | null }>(db, 'SELECT MIN(at_utc) AS v FROM fuel WHERE at_utc >= ?', cutoff)?.v ?? null;
  const fuelMonth = oldestFuel === null ? cutoffMonth : monthKeyOf(oldestFuel, tz);
  return { firstMonth, legacyThrough: fuelMonth > cutoffMonth ? fuelMonth : cutoffMonth };
}

/** The stored baseline, or what it would be now when the first purge has not run yet. Writes nothing. */
export function readBaseline(db: Db, now: Date, tz: string, windowMonths: number): Baseline {
  const firstMonth = getMeta(db, 'stats_first_month');
  if (firstMonth === undefined) return deriveBaseline(db, now, tz, windowMonths);
  return { firstMonth, legacyThrough: getMeta(db, 'stats_legacy_through') ?? null };
}

// ----------------------------------------------------------------------- the report

/** One set of totals as the API sends it: the components, and what is derived from them as whole numbers. */
export interface StatsEntry extends Totals {
  /** km + togetherKm. */
  totalKm: number;
  /** Thousandths of a euro per litre (1859 = 1,859 EUR/L): paidCents over millilitres. null without litres. */
  pricePerLitreMillis: number | null;
  /** Thousandths of a euro per kilometre: costCents over costKm + poolKm. null without kilometres. */
  costPerKmMillis: number | null;
  /** Hundredths of a litre per 100 km (650 = 6,50 L/100 km): ten times the millilitres over the kilometres. null without consumption data. */
  consumptionHundredths: number | null;
}

export interface StatsMonthDto {
  month: string;
  /** The current month: still being added to. */
  provisional: boolean;
  /** A stored total: later corrections of its records do not change it. */
  frozen: boolean;
  /** The numbers are known to be short of what happened (cut short by a purge before they were stored). */
  incomplete: boolean;
  /** Nothing is known about this month (before the household started, or purged before statistics existed). null totals. */
  unavailable: boolean;
  household: StatsEntry | null;
  people: Array<StatsEntry & { userId: number }>;
}

export interface StatsReport {
  version: number;
  timeZone: string;
  windowMonths: number;
  retentionMonths: number;
  current: string;
  range: { from: string; to: string };
  users: Array<{ id: number; name: string; active: boolean }>;
  months: StatsMonthDto[];
}

/** a / b rounded half up to a whole number, or null when there is nothing to divide by. */
function ratio(a: number, b: number): number | null {
  return b > 0 ? Math.floor((2 * a + b) / (2 * b)) : null;
}

export function entryOf(t: Totals): StatsEntry {
  return {
    ...t,
    totalKm: t.km + t.togetherKm,
    pricePerLitreMillis: ratio(t.paidCents * 10_000, t.millilitres),
    costPerKmMillis: ratio(t.costCents * 10, t.costKm + t.poolKm),
    consumptionHundredths: ratio(t.consumptionMl * 10, t.consumptionKm),
  };
}

export function sumTotals(rows: Iterable<Totals>): Totals {
  const sum = emptyTotals();
  for (const t of rows) for (const f of TOTAL_FIELDS) sum[f] += t[f];
  return sum;
}

export interface StatsSettings {
  tz: string;
  windowMonths: number;
  statsRetentionMonths: number;
}

/** The stored (frozen) months in a range, with their totals. */
function loadFrozen(db: Db, from: string, to: string): Map<string, { complete: boolean; rows: MonthRows }> {
  const out = new Map<string, { complete: boolean; rows: MonthRows }>();
  for (const m of many<{ month: string; complete: number }>(db, 'SELECT month, complete FROM stats_months WHERE frozen = 1 AND month >= ? AND month <= ?', from, to)) {
    out.set(m.month, { complete: m.complete === 1, rows: new Map() });
  }
  if (out.size === 0) return out;
  const rows = many<Record<string, number | string>>(
    db,
    `SELECT month, user_id, ${TOTAL_COLUMNS.join(', ')} FROM stats_totals WHERE month >= ? AND month <= ?`,
    from,
    to,
  );
  for (const r of rows) {
    const entry = out.get(r['month'] as string);
    if (!entry) continue;
    const totals = emptyTotals();
    TOTAL_FIELDS.forEach((f, i) => void (totals[f] = r[TOTAL_COLUMNS[i] as string] as number));
    entry.rows.set(r['user_id'] as number, totals);
  }
  return out;
}

/**
 * The report for a range of months (both ends inclusive, already validated). The same for everybody: it holds no
 * per-user choice, so a token API can serve the same body. A stored month is read from the table and never
 * recomputed; every other month is computed live. Writes nothing.
 */
export function statsReport(db: Db, settings: StatsSettings, now: Date, range: { from: string; to: string }): StatsReport {
  const { tz } = settings;
  const current = monthKeyOf(now, tz);
  const frozen = loadFrozen(db, range.from, range.to);
  const markers = new Set(many<{ month: string }>(db, 'SELECT month FROM stats_months WHERE frozen = 0').map((r) => r.month));
  const baseline = readBaseline(db, now, tz, settings.windowMonths);
  const list: string[] = [];
  for (let m = range.from; m <= range.to; m = addMonthKey(m, 1)) list.push(m);
  const live = list.some((m) => !frozen.has(m)) ? computeMonths(db, tz) : new Map<string, MonthRows>();

  const months = list.map((month): StatsMonthDto => {
    const stored = frozen.get(month);
    const rows = stored ? stored.rows : live.get(month);
    const hasData = rows !== undefined && rows.size > 0;
    let unavailable = false;
    let incomplete: boolean;
    if (stored) {
      incomplete = !stored.complete;
    } else {
      const { firstMonth, legacyThrough } = baseline;
      const beforeStart = firstMonth === null ? month < current : month < firstMonth;
      const legacy = legacyThrough !== null && month <= legacyThrough;
      unavailable = !hasData && (beforeStart || legacy);
      incomplete = !unavailable && (markers.has(month) || legacy);
    }
    return {
      month,
      provisional: month === current,
      frozen: stored !== undefined,
      incomplete,
      unavailable,
      household: unavailable ? null : entryOf(sumTotals(rows?.values() ?? [])),
      people:
        unavailable || !rows
          ? []
          : [...rows.keys()]
              .filter((userId) => userId !== HOUSEHOLD)
              .sort((a, b) => a - b)
              .map((userId) => ({ userId, ...entryOf(rows.get(userId) as Totals) })),
    };
  });

  return {
    version: STATS_VERSION,
    timeZone: tz,
    windowMonths: settings.windowMonths,
    retentionMonths: settings.statsRetentionMonths,
    current,
    range,
    users: many<{ id: number; display_name: string; active: number }>(db, 'SELECT id, display_name, active FROM users ORDER BY id').map((u) => ({
      id: u.id,
      name: u.display_name,
      active: u.active === 1,
    })),
    months,
  };
}

// ------------------------------------------------------------------------ the route

/** How many months an omitted range covers. */
export const DEFAULT_RANGE_MONTHS = 12;

/**
 * The `from` and `to` query parameters ('YYYY-MM'). Strict: nothing is clamped silently, a bad range is a 422 with
 * a code per field. Omitted `to` is the current month; omitted `from` is eleven months before `to`, but never older
 * than what is kept.
 */
export function parseStatsRange(query: URLSearchParams, now: Date, tz: string, retentionMonths: number): { from: string; to: string } {
  const current = monthKeyOf(now, tz);
  const floor = addMonthKey(current, -(retentionMonths - 1));
  const fields: Record<string, string> = {};
  const given = (name: string): string | undefined => {
    const raw = query.get(name);
    return raw === null || raw === '' ? undefined : raw;
  };
  const toRaw = given('to');
  const fromRaw = given('from');
  let to = current;
  if (toRaw !== undefined) {
    if (parseMonthKey(toRaw) === null) fields['to'] = 'invalid_month';
    else if (toRaw > current) fields['to'] = 'in_future';
    else if (toRaw < floor) fields['to'] = 'outside_retention';
    else to = toRaw;
  }
  let from: string;
  if (fromRaw === undefined) {
    const back = addMonthKey(to, -(DEFAULT_RANGE_MONTHS - 1));
    from = back < floor ? floor : back;
  } else {
    from = fromRaw;
    if (parseMonthKey(fromRaw) === null) fields['from'] = 'invalid_month';
    else if (fromRaw < floor) fields['from'] = 'outside_retention';
    else if (fields['to'] === undefined && fromRaw > to) fields['from'] = 'after_to';
  }
  failIfAny(fields);
  return { from, to };
}

export function registerStatsRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;
  // Every signed-in member sees the same numbers, like drives and fill-ups. No per-user filter, so the body is the
  // same for everybody, and nothing is written: a stored month is only ever written by the purge.
  router.add('GET', '/api/stats', 'user', (req) => {
    const now = ctx.clock.now();
    const range = parseStatsRange(req.query, now, config.tz, config.statsRetentionMonths);
    return ok(statsReport(db, config, now, range));
  });
}
