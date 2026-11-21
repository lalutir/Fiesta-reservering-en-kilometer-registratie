// The odometer chain: every odometer reading the app knows, in time order, and the places where two
// neighbouring readings do not fit. Like who drove a ticket (tickets.ts), none of it is stored: deriveChain()
// works it out from the drive log and the fill-ups on every read, so correcting a drive or a fill-up
// corrects the list with it. The one thing that IS stored is a person's "explained" note on one flagged pair
// (odometer_explained), keyed so that it stops applying the moment either reading changes.
//
// Readings, in time order:
//   - a completed drive gives its start and its end reading (whichever exist: a legacy drive may have none
//     or one, and then contributes only what it has),
//   - an open draft gives its start reading (the drive has no end yet),
//   - a fill-up gives its odometer reading (legacy fill-ups have none and are simply not in the chain).
// The person of a drive reading is the driver (usage.user_id), never whose kilometres they are (km_for): the
// reading is on the dashboard of whoever sat in the car. The person of a fill-up reading is the fueler.
//
// Between two consecutive readings:
//   next is higher   a GAP of N km: the car drove N km that nobody registered between these two readings,
//   next is lower    a MISMATCH of N km: the two readings contradict each other (probably a typo),
//   equal            nothing.
// There is no tolerance (GAP_TOLERANCE_KM = 0): the few kilometres to the pump show up as a small gap. It is
// one constant, so a threshold is a one-line change once real use shows how noisy that is.
//
// A drive's own trip (its start reading to its end reading) is never a gap. A fill-up strictly inside a
// completed drive's span (the pump stop was part of the trip) is not a link in the chain: it is only checked
// against that drive, and is a mismatch when it lies outside the drive's own start..end readings.
//
// Order: by instant, and at the same instant by a fixed rank, so the same data always gives the same list:
//   0 the end of a drive, 1 a zero-length drive (its start before its end), 2 a fill-up, 3 the start of a
//   drive or draft; then by row id. So back-to-back drives read end, start; a fill-up at a boundary falls
//   between the drive that ended and the one that starts.
//
// Window: readings before `windowFrom` (the start of the retention window, the same bound the purge uses) do
// not take part, so the oldest reading has no predecessor and the list does not change when the purge runs.
//
// Explained: item_key names both readings of a pair (source, row id, km, instant, driver of each). Editing
// either reading, reassigning the driver or inserting another reading between them gives the pair a different
// key, so the explanation no longer applies. (The exact same pair coming back re-applies it.)
import { many, one, run, tx, type Db, type OdometerExplainedRow } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import { Fields, windowBounds } from './validate.ts';

/** A next reading more than this many km above (a gap) or below (a mismatch) the previous one is flagged. */
export const GAP_TOLERANCE_KM = 0;

export const EXPLAIN_NOTE_MAX = 500;

export type ReadingSource = 'drive-start' | 'drive-end' | 'draft-start' | 'fuel';

export interface Reading {
  source: ReadingSource;
  /** The id of the usage row or the fill-up. */
  id: number;
  km: number;
  at: string;
  /** The driver of a drive reading, the fueler of a fill-up reading. */
  userId: number;
  userName: string;
  /** The start reading of a drive that has not ended yet. */
  draft: boolean;
}

export interface ChainItem {
  kind: 'gap' | 'mismatch';
  /** How many km are unaccounted for (gap) or contradict each other (mismatch); always above zero. */
  km: number;
  prev: Reading;
  next: Reading;
  /** Names both readings; what an explanation is stored under. */
  key: string;
}

export interface Chain {
  /** Time order; fill-ups inside a completed drive are not in it. */
  readings: Reading[];
  /** Ordered by the time of the later reading, then by key. */
  items: ChainItem[];
}

export interface DriveInput {
  id: number;
  userId: number;
  userName: string;
  start: string;
  /** For a draft this is only a placeholder (equal to start). */
  end: string;
  odometerStart: number | null;
  odometerEnd: number | null;
  draft: boolean;
}

export interface FuelInput {
  id: number;
  userId: number;
  userName: string;
  at: string;
  odometer: number | null;
}

// ------------------------------------------------------------- pure derivation

const readingKey = (r: Reading): string => `${r.source}:${r.id}:${r.km}:${r.at}:${r.userId}`;

/** The pair of readings an explanation is about. */
export function itemKey(prev: Reading, next: Reading): string {
  return `${readingKey(prev)}>${readingKey(next)}`;
}

/** The finding for two consecutive readings, or null when they fit. */
function compare(prev: Reading, next: Reading): ChainItem | null {
  const diff = next.km - prev.km;
  if (diff > GAP_TOLERANCE_KM) return { kind: 'gap', km: diff, prev, next, key: itemKey(prev, next) };
  if (diff < -GAP_TOLERANCE_KM) return { kind: 'mismatch', km: -diff, prev, next, key: itemKey(prev, next) };
  return null;
}

interface Slot {
  reading: Reading;
  /** Order at the same instant: 0 end of a drive, 1 zero-length drive, 2 fill-up, 3 start of a drive or draft. */
  rank: number;
  /** Order within one drive at the same instant (a zero-length drive): start before end. */
  part: number;
}

function driveReading(d: DriveInput, which: 'start' | 'end'): Reading {
  const start = which === 'start';
  return {
    source: start ? (d.draft ? 'draft-start' : 'drive-start') : 'drive-end',
    id: d.id,
    km: (start ? d.odometerStart : d.odometerEnd) as number,
    at: start ? d.start : d.end,
    userId: d.userId,
    userName: d.userName,
    draft: d.draft,
  };
}

function fuelReading(f: FuelInput): Reading {
  return { source: 'fuel', id: f.id, km: f.odometer as number, at: f.at, userId: f.userId, userName: f.userName, draft: false };
}

/** Plain code-unit order (the fixed-width UTC strings and keys sort the way they read). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function bySlot(a: Slot, b: Slot): number {
  return cmp(a.reading.at, b.reading.at) || a.rank - b.rank || a.reading.id - b.reading.id || a.part - b.part;
}

/**
 * The odometer chain, its gaps and its mismatches. Pure: no database, no clock. The caller decides which
 * rows to pass in (loadChain keeps exactly what the purge keeps); `windowFrom` drops the readings before it.
 */
export function deriveChain(drives: DriveInput[], fuels: FuelInput[], windowFrom: string): Chain {
  const slots: Slot[] = [];
  const items: ChainItem[] = [];
  // Only a completed drive with both readings has a span a fill-up can fall inside.
  const spans = drives.filter((d) => !d.draft && d.odometerStart !== null && d.odometerEnd !== null);

  for (const f of fuels) {
    if (f.odometer === null || f.at < windowFrom) continue;
    const reading = fuelReading(f);
    const trip = spans.find((d) => d.start < f.at && f.at < d.end);
    if (!trip) {
      slots.push({ reading, rank: 2, part: 0 });
      continue;
    }
    // A pump stop during a trip: only the drive's own readings can contradict it. A drive reading from
    // before the window does not take part.
    const start = driveReading(trip, 'start');
    const end = driveReading(trip, 'end');
    const found =
      reading.km < start.km ? (start.at >= windowFrom ? compare(start, reading) : null) : reading.km > end.km ? compare(reading, end) : null;
    if (found) items.push(found);
  }

  for (const d of drives) {
    const zero = !d.draft && d.start === d.end;
    if (d.odometerStart !== null && d.start >= windowFrom) slots.push({ reading: driveReading(d, 'start'), rank: zero ? 1 : 3, part: 0 });
    if (!d.draft && d.odometerEnd !== null && d.end >= windowFrom) slots.push({ reading: driveReading(d, 'end'), rank: zero ? 1 : 0, part: 1 });
  }

  slots.sort(bySlot);
  const readings = slots.map((s) => s.reading);
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1] as Reading;
    const next = readings[i] as Reading;
    // The trip itself is what the drive's two readings are for, not a finding.
    if (prev.source === 'drive-start' && next.source === 'drive-end' && prev.id === next.id) continue;
    const found = compare(prev, next);
    if (found) items.push(found);
  }
  items.sort((a, b) => cmp(a.next.at, b.next.at) || cmp(a.key, b.key));
  return { readings, items };
}

// ---------------------------------------------------------------- the database

/** The start of the retention window: readings before it are not part of the chain. */
export function chainWindowFrom(ctx: Ctx): string {
  return windowBounds(ctx.clock.now(), ctx.config.tz, ctx.config.windowMonths).from;
}

/**
 * Load what the purge keeps (drives and drafts ending at or after `from`, fill-ups at or after it) and
 * derive the chain. A draft counts by its placeholder end, as in the purge.
 */
export function loadChain(db: Db, from: string): Chain {
  const drives = many<{
    id: number;
    user_id: number;
    user_name: string;
    start_utc: string;
    end_utc: string;
    odometer_start: number | null;
    odometer_end: number | null;
    status: string;
  }>(
    db,
    `SELECT g.id, g.user_id, u.display_name AS user_name, g.start_utc, g.end_utc, g.odometer_start, g.odometer_end, g.status
       FROM usage g JOIN users u ON u.id = g.user_id
      WHERE g.end_utc >= ?`,
    from,
  ).map(
    (g): DriveInput => ({
      id: g.id,
      userId: g.user_id,
      userName: g.user_name,
      start: g.start_utc,
      end: g.end_utc,
      odometerStart: g.odometer_start,
      odometerEnd: g.odometer_end,
      draft: g.status === 'draft',
    }),
  );
  const fuels = many<{ id: number; user_id: number; user_name: string; at_utc: string; odometer: number }>(
    db,
    `SELECT f.id, f.user_id, u.display_name AS user_name, f.at_utc, f.odometer
       FROM fuel f JOIN users u ON u.id = f.user_id
      WHERE f.odometer IS NOT NULL AND f.at_utc >= ?`,
    from,
  ).map((f): FuelInput => ({ id: f.id, userId: f.user_id, userName: f.user_name, at: f.at_utc, odometer: f.odometer }));
  return deriveChain(drives, fuels, from);
}

interface ExplainedJoin extends OdometerExplainedRow {
  by_name: string;
}

function loadExplained(db: Db): Map<string, ExplainedJoin> {
  const rows = many<ExplainedJoin>(
    db,
    'SELECT e.*, u.display_name AS by_name FROM odometer_explained e JOIN users u ON u.id = e.created_by',
  );
  return new Map(rows.map((r) => [r.item_key, r]));
}

export interface OpenGap {
  km: number;
  /** The time of the later reading: the fuel period a gap belongs to is the one that ends at or after it. */
  at: string;
}

/** The gaps nobody explained (mismatches are not unaccounted kilometres). */
export function openGaps(db: Db, chain: Chain): OpenGap[] {
  const explained = loadExplained(db);
  return chain.items.filter((i) => i.kind === 'gap' && !explained.has(i.key)).map((i) => ({ km: i.km, at: i.next.at }));
}

/**
 * openGaps(loadChain(...)) for the fuel cards, which only show a note about it: a failure here is logged and
 * answers "no gaps", so it can never turn a fill-up that was just saved into a 500. Only GET /api/odometer
 * itself may fail.
 */
export function gapsOrEmpty(ctx: Ctx): OpenGap[] {
  try {
    return openGaps(ctx.db, loadChain(ctx.db, chainWindowFrom(ctx)));
  } catch (err) {
    ctx.log({ event: 'odometer.chain_failed', message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// ----------------------------------------------------------------------- DTOs

export interface OdometerItemDto {
  key: string;
  kind: 'gap' | 'mismatch';
  km: number;
  prev: Reading;
  next: Reading;
  /** Who said why this is fine, and what they said; null while it is open. */
  explained: { id: number; note: string; byId: number; byName: string; at: string } | null;
  /** The driver or fueler of either reading, and admins; unexplain only when there is a note to remove. */
  can: { explain: boolean; unexplain: boolean };
}

/** Whoever drove or fuelled at either end of the pair, or an admin. */
function involved(actor: Principal, item: ChainItem): boolean {
  return actor.role === 'admin' || actor.id === item.prev.userId || actor.id === item.next.userId;
}

function toDto(item: ChainItem, explained: Map<string, ExplainedJoin>, actor: Principal): OdometerItemDto {
  const row = explained.get(item.key);
  const may = involved(actor, item);
  return {
    key: item.key,
    kind: item.kind,
    km: item.km,
    prev: item.prev,
    next: item.next,
    explained: row ? { id: row.id, note: row.note, byId: row.created_by, byName: row.by_name, at: row.updated_at } : null,
    can: { explain: may, unexplain: may && row !== undefined },
  };
}

// --------------------------------------------------------------------- routes

export function registerOdometerRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;

  // Every signed-in member sees the whole chain, like drives and fill-ups: the point is that everybody
  // can see what is missing. Newest first.
  router.add('GET', '/api/odometer', 'user', (req) => {
    const actor = me(req);
    const now = ctx.clock.now();
    const window = windowBounds(now, config.tz, config.windowMonths);
    const chain = loadChain(db, window.from);
    const explained = loadExplained(db);
    return ok({
      window,
      readings: chain.readings,
      items: [...chain.items].reverse().map((i) => toDto(i, explained, actor)),
      latest: chain.readings[chain.readings.length - 1] ?? null,
    });
  });

  router.add('POST', '/api/odometer/explain', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const key = f.string('key', { min: 1, max: 300 });
    const note = f.string('note', { min: 1, max: EXPLAIN_NOTE_MAX });
    // SQLite's length() stops at a NUL character, so a note made of NULs would pass the checks above and then
    // fail the table's length CHECK as a 500. Not a note a person typed: refuse it here with a normal 422.
    if (note?.includes('\0')) f.fail('note', 'invalid_value');
    f.done();
    const nowIso = ctx.clock.now().toISOString();
    const { dto, created } = tx(db, () => {
      // Looked up again inside the transaction: the pair must still be flagged right now.
      const item = loadChain(db, chainWindowFrom(ctx)).items.find((i) => i.key === key);
      if (!item) throw new HttpError(404, 'not_found', 'That stretch is not flagged any more');
      if (!involved(actor, item)) throw new HttpError(403, 'forbidden', 'Only someone who drove or fuelled at one end of this stretch, or an admin, can explain it');
      const existing = one<{ id: number }>(db, 'SELECT id FROM odometer_explained WHERE item_key = ?', item.key);
      if (existing) {
        run(db, 'UPDATE odometer_explained SET note = ?, created_by = ?, updated_at = ? WHERE id = ?', note as string, actor.id, nowIso, existing.id);
      } else {
        run(
          db,
          'INSERT INTO odometer_explained (item_key, prev_at, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          item.key,
          item.prev.at,
          note as string,
          actor.id,
          nowIso,
          nowIso,
        );
      }
      return { dto: toDto(item, loadExplained(db), actor), created: !existing };
    });
    // Ids and the size of the stretch only: never the note, which is free text about people.
    ctx.log({ event: 'odometer.explained', by: actor.id, kind: dto.kind, km: dto.km, replaced: !created });
    return ok({ item: dto }, created ? 201 : 200);
  });

  router.add('DELETE', '/api/odometer/explained/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const kind = tx(db, () => {
      const row = one<OdometerExplainedRow>(db, 'SELECT * FROM odometer_explained WHERE id = ?', id);
      if (!row) throw new HttpError(404, 'not_found', 'Explanation not found');
      // A note whose pair no longer exists has nobody left to answer for it (it is purged with the window).
      const item = loadChain(db, chainWindowFrom(ctx)).items.find((i) => i.key === row.item_key);
      if (!item) throw new HttpError(404, 'not_found', 'That stretch is not flagged any more');
      if (!involved(actor, item)) throw new HttpError(403, 'forbidden', 'Only someone who drove or fuelled at one end of this stretch, or an admin, can remove an explanation');
      run(db, 'DELETE FROM odometer_explained WHERE id = ?', id);
      return item.kind;
    });
    ctx.log({ event: 'odometer.unexplained', id, by: actor.id, kind });
    return noContent();
  });
}
