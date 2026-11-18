import { isUniqueViolation, many, one, run, tx, type Db, type KmFor, type UsageRow, type UsageStatus } from './db.ts';
import { requestedPeriods } from './fuel.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import { listConfirmed, listUnregistered } from './reservations.ts';
import { Fields, ValidationError, assertInsideWindow, failIfAny, queryRange, queryUserId, windowBounds } from './validate.ts';

/** A usage record may end (a draft may start) at most this far in the future (clock skew, "just got back"). */
const FUTURE_SLACK_MS = 5 * 60_000;
const MAX_ODOMETER = 10_000_000;
const STATUSES = ['draft', 'completed'] as const;
const KM_FORS = ['self', 'person', 'together'] as const;
/** How far back the pending-km list looks by default; the admin can ask for the whole window. */
const PENDING_DEFAULT_DAYS = 14;
const PENDING_MAX_DAYS = 190;
const DAY_MS = 86_400_000;

interface UsageJoin extends UsageRow {
  user_name: string;
  /** The person whose kilometres these are, when km_for is 'person'. */
  km_user_name: string | null;
}

export interface UsageDto {
  id: number;
  userId: number;
  userName: string;
  status: UsageStatus;
  start: string;
  /** Null for a draft: the drive has not ended yet. */
  end: string | null;
  odometerStart: number | null;
  odometerEnd: number | null;
  /** Only known when both odometer readings exist. */
  distanceKm: number | null;
  reservationId: number | null;
  /** Whose kilometres these are: the driver's own, another person's (kmUserId) or the shared pool. The driver stays the driver. */
  kmFor: KmFor;
  kmUserId: number | null;
  kmUserName: string | null;
  note: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  can: { edit: boolean; delete: boolean };
  /** The owner cannot change it: a payment request was made for the fill-up it belongs to (an admin still can). */
  fuelLocked: boolean;
}

const SELECT = `SELECT g.*, u.display_name AS user_name, ku.display_name AS km_user_name
  FROM usage g JOIN users u ON u.id = g.user_id LEFT JOIN users ku ON ku.id = g.km_user_id`;

function mayChange(actor: Principal, row: UsageRow): boolean {
  return actor.role === 'admin' || actor.id === row.user_id;
}

function toDto(row: UsageJoin, actor: Principal, locked: boolean): UsageDto {
  const both = row.odometer_start !== null && row.odometer_end !== null;
  const may = mayChange(actor, row);
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    status: row.status,
    start: row.start_utc,
    // A draft stores end = start as a placeholder; it never leaves the server.
    end: row.status === 'draft' ? null : row.end_utc,
    odometerStart: row.odometer_start,
    odometerEnd: row.odometer_end,
    distanceKm: both ? (row.odometer_end as number) - (row.odometer_start as number) : null,
    reservationId: row.reservation_id,
    kmFor: row.km_for,
    kmUserId: row.km_user_id,
    kmUserName: row.km_user_name,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    can: { edit: may && !locked, delete: may && !locked },
    fuelLocked: may && locked,
  };
}

/**
 * Which drives are locked for this person. A completed drive that falls in the period of a fill-up
 * with a payment request has been billed: changing its driver, time or kilometres would change what
 * the request asked, so only an admin can (the fuel card then flags the difference). Registering a
 * new drive stays open to everybody. Loads the fill-ups once per call.
 */
function lockedFor(db: Db, actor: Principal): (row: UsageRow) => boolean {
  if (actor.role === 'admin') return () => false;
  const covered = requestedPeriods(db);
  return (row) => row.status === 'completed' && covered(row.end_utc);
}

function fuelRequestedError(): HttpError {
  return new HttpError(409, 'fuel_requested', 'A payment request was made for the fill-up this drive belongs to. Ask an admin to change it.');
}

/** The 409 for a member who edits, moves or deletes a locked drive. `newEnd` is where an edit would put it. */
function assertNotFuelLocked(db: Db, actor: Principal, existing: UsageRow, newEnd: string | null): void {
  if (actor.role === 'admin' || existing.status !== 'completed') return;
  const covered = requestedPeriods(db);
  if (covered(existing.end_utc) || (newEnd !== null && covered(newEnd))) throw fuelRequestedError();
}

/**
 * The 409 for a member who puts kilometres that are not their own (another person's, or the shared
 * pool) into the period of a fill-up with a payment request: it would lower their own share and raise
 * someone else's after the money was asked for or paid. A drive of their own (kmFor 'self') stays open
 * to everybody, as before: the fuel card flags the difference. An admin can do both. This covers
 * creating a completed drive and finishing a draft (a draft is not billed to anyone until then);
 * changing a drive that is already completed is assertNotFuelLocked.
 */
function assertNotBilledToOthers(db: Db, actor: Principal, input: UsageInput): void {
  if (actor.role === 'admin' || input.status !== 'completed' || input.kmFor === 'self' || input.end === null) return;
  if (requestedPeriods(db)(input.end)) throw fuelRequestedError();
}

function load(db: Db, id: number): UsageJoin {
  const row = one<UsageJoin>(db, `${SELECT} WHERE g.id = ?`, id);
  if (!row) throw new HttpError(404, 'not_found', 'Usage record not found');
  return row;
}

interface UsageInput {
  userId: number;
  status: UsageStatus;
  start: string;
  /** Null for a draft. */
  end: string | null;
  odometerStart: number | null;
  odometerEnd: number | null;
  reservationId: number | null;
  kmFor: KmFor;
  /** Only set when kmFor is 'person'. */
  kmUserId: number | null;
  note: string;
}

/**
 * The kilometre obligation, as pure rules over one drive. A completed drive
 * has an end time and both odometer readings (the end reading not below the
 * start reading); a draft is a drive that has started: it needs the start
 * reading and nothing that belongs to the end. Returns one code per field.
 */
export function shapeErrors(i: {
  status: UsageStatus;
  start: string | undefined;
  end: string | null;
  odometerStart: number | null;
  odometerEnd: number | null;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (i.status === 'draft') {
    if (i.odometerStart === null) errors['odometerStart'] = 'required';
    if (i.end !== null) errors['end'] = 'must_be_empty';
    if (i.odometerEnd !== null) errors['odometerEnd'] = 'must_be_empty';
    return errors;
  }
  if (i.end === null) errors['end'] = 'required';
  else if (i.start !== undefined && i.end < i.start) errors['end'] = 'must_not_be_before_start';
  if (i.odometerStart === null) errors['odometerStart'] = 'required';
  if (i.odometerEnd === null) errors['odometerEnd'] = 'required';
  else if (i.odometerStart !== null && i.odometerEnd < i.odometerStart) errors['odometerEnd'] = 'must_not_be_below_start';
  return errors;
}

/**
 * Whose kilometres a drive is, as pure rules. 'person' needs another person than the driver;
 * 'self' and 'together' take no person; anything but the driver's own kilometres needs a note
 * (the reason), also on a draft: the rule belongs to the row, not to its status. Returns one code
 * per field. That the person exists and is active is checked against the database (checkUsage).
 */
export function attributionErrors(i: { kmFor: KmFor; kmUserId: number | null; driverId: number; note: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (i.kmFor === 'person') {
    if (i.kmUserId === null) errors['kmUserId'] = 'required';
    else if (i.kmUserId === i.driverId) errors['kmUserId'] = 'same_as_driver';
  } else if (i.kmUserId !== null) {
    errors['kmUserId'] = 'only_for_person';
  }
  if (i.kmFor !== 'self' && i.note.trim() === '') errors['note'] = 'required';
  return errors;
}

/** The 409 for a driver who already has a drive in progress (other than `excludeId`), or undefined when there is none. */
function openDraftError(db: Db, userId: number, excludeId: number): HttpError | undefined {
  const open = one<{ id: number }>(db, "SELECT id FROM usage WHERE user_id = ? AND status = 'draft' AND id != ?", userId, excludeId);
  return open && new HttpError(409, 'draft_exists', 'There is already a drive in progress for this driver', { extra: { draftId: open.id } });
}

/** Cross-field rules shared by create and update. Throws 422/409. */
function checkUsage(ctx: Ctx, input: UsageInput, now: Date, excludeId: number, previousKmUserId: number | null): void {
  if (!one<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE id = ?', input.userId)) throw new ValidationError({ userId: 'unknown_user' });
  // The person must be active when chosen; one who was deactivated after the choice stays as it was.
  if (input.kmUserId !== null && input.kmUserId !== previousKmUserId && !one<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE id = ? AND active = 1', input.kmUserId)) {
    throw new ValidationError({ kmUserId: 'unknown_user' });
  }
  const nowMs = now.getTime();
  const errors = shapeErrors(input);
  if (input.status === 'draft') {
    if (Date.parse(input.start) > nowMs + FUTURE_SLACK_MS) errors['start'] ??= 'in_future';
  } else if (input.end !== null && Date.parse(input.end) > nowMs + FUTURE_SLACK_MS) {
    errors['end'] ??= 'in_future';
  }
  failIfAny(errors);
  assertInsideWindow(input.start, input.end ?? input.start, now, ctx.config.tz, ctx.config.windowMonths);
  // The overlap check and the write that follow must share one transaction;
  // callers invoke this from inside tx().
  if (input.reservationId !== null) {
    const res = one<{ status: string }>(ctx.db, 'SELECT status FROM reservations WHERE id = ?', input.reservationId);
    if (res?.status !== 'confirmed') throw new ValidationError({ reservationId: 'unknown_reservation' });
  }
  if (input.status === 'draft') {
    const open = openDraftError(ctx.db, input.userId, excludeId);
    if (open) throw open;
  }
  // Only finished drives take part: a draft has no end yet, so it never blocks anyone, and it may
  // only not start in the middle of a finished drive (its placeholder end is its start). The
  // same-range clause is for finished drives only: a zero-length drive at a draft's start is no clash.
  const end = input.end ?? input.start;
  const clash = one<{ id: number; start_utc: string; end_utc: string; user_name: string }>(
    ctx.db,
    `SELECT g.id, g.start_utc, g.end_utc, u.display_name AS user_name
       FROM usage g JOIN users u ON u.id = g.user_id
      WHERE g.id != ? AND g.status = 'completed'
        AND ((g.start_utc < ? AND ? < g.end_utc) OR (? AND g.start_utc = ? AND g.end_utc = ?))
      ORDER BY g.start_utc LIMIT 1`,
    excludeId,
    end,
    input.start,
    input.end === null ? 0 : 1,
    input.start,
    end,
  );
  if (clash) {
    throw new HttpError(409, 'overlap', `That time overlaps a usage record by ${clash.user_name}`, {
      extra: { conflict: { id: clash.id, start: clash.start_utc, end: clash.end_utc, userName: clash.user_name } },
    });
  }
}

function readOdometer(f: Fields, key: string): number | null | undefined {
  return f.nullableInt(key, { min: 0, max: MAX_ODOMETER });
}

/** undefined = absent, null = explicitly none (what a draft sends). */
function readEnd(f: Fields): string | null | undefined {
  if (f.input['end'] === null) return null;
  return f.instant('end', { optional: true });
}

/** A unique violation can only mean the one-open-draft index; say so instead of a 500. */
function mapDraftRace(db: Db, userId: number, err: unknown): never {
  if (isUniqueViolation(err)) {
    throw openDraftError(db, userId, -1) ?? new HttpError(409, 'draft_exists', 'There is already a drive in progress for this driver');
  }
  throw err;
}

function readDays(query: URLSearchParams): number {
  const raw = query.get('days');
  if (raw === null || raw === '') return PENDING_DEFAULT_DAYS;
  if (!/^\d{1,5}$/.test(raw)) throw new ValidationError({ days: 'must_be_integer' });
  const n = Number(raw);
  if (n < 1) throw new ValidationError({ days: 'too_small' });
  if (n > PENDING_MAX_DAYS) throw new ValidationError({ days: 'too_large' });
  return n;
}

export function registerUsageRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;

  router.add('GET', '/api/usage', 'user', (req) => {
    const actor = me(req);
    const range = queryRange(req.query, ctx.clock.now(), config.tz, config.windowMonths);
    const where = ['g.end_utc >= ?', 'g.start_utc <= ?'];
    const params: Array<string | number> = [range.from, range.to];
    const userId = queryUserId(req.query);
    if (userId !== undefined) {
      where.push('g.user_id = ?');
      params.push(userId);
    }
    const rows = many<UsageJoin>(db, `${SELECT} WHERE ${where.join(' AND ')} ORDER BY g.start_utc DESC, g.id DESC`, ...params);
    const locked = lockedFor(db, actor);
    return ok({ items: rows.map((r) => toDto(r, actor, locked(r))), window: range });
  });

  // Kilometres per person. Only finished drives count; a draft is a drive that has not ended yet.
  // Trips follow the driver (every drive is one trip, counted once, so totalTrips includes the
  // together drives); kilometres follow whose they are: the driver's own, another person's, or the
  // shared "together" pool, which is reported on its own. totalKm is items plus together.
  router.add('GET', '/api/usage/summary', 'user', (req) => {
    const range = queryRange(req.query, ctx.clock.now(), config.tz, config.windowMonths);
    const rows = many<{ user_id: number; km_for: KmFor; km_user_id: number | null; trips: number; trips_with_km: number; km: number }>(
      db,
      `SELECT g.user_id, g.km_for, g.km_user_id, COUNT(*) AS trips,
              SUM(CASE WHEN g.odometer_start IS NOT NULL AND g.odometer_end IS NOT NULL THEN 1 ELSE 0 END) AS trips_with_km,
              COALESCE(SUM(CASE WHEN g.odometer_start IS NOT NULL AND g.odometer_end IS NOT NULL
                                THEN g.odometer_end - g.odometer_start END), 0) AS km
         FROM usage g
        WHERE g.status = 'completed' AND g.end_utc >= ? AND g.start_utc <= ?
        GROUP BY g.user_id, g.km_for, g.km_user_id`,
      range.from,
      range.to,
    );
    const names = new Map(many<{ id: number; display_name: string }>(db, 'SELECT id, display_name FROM users').map((u) => [u.id, u.display_name]));
    const people = new Map<number, { userId: number; userName: string; trips: number; tripsWithKm: number; km: number }>();
    const person = (userId: number) => {
      let entry = people.get(userId);
      if (!entry) people.set(userId, (entry = { userId, userName: names.get(userId) ?? '?', trips: 0, tripsWithKm: 0, km: 0 }));
      return entry;
    };
    const together = { trips: 0, tripsWithKm: 0, km: 0 };
    for (const r of rows) {
      const driver = person(r.user_id);
      driver.trips += r.trips;
      driver.tripsWithKm += r.trips_with_km;
      if (r.km_for === 'together') {
        together.trips += r.trips;
        together.tripsWithKm += r.trips_with_km;
        together.km += r.km;
      } else {
        person(r.km_for === 'person' ? (r.km_user_id as number) : r.user_id).km += r.km;
      }
    }
    const items = [...people.values()].sort((a, b) => b.km - a.km || b.trips - a.trips || (a.userName < b.userName ? -1 : a.userName > b.userName ? 1 : 0));
    return ok({
      items,
      together,
      totalTrips: items.reduce((n, r) => n + r.trips, 0),
      totalKm: items.reduce((n, r) => n + r.km, 0) + together.km,
      window: range,
    });
  });

  // The kilometres still to register: unfinished drafts, and ended reservations with no completed
  // registration. The same REGISTERED_SQL as the reservation card and the push reminders.
  router.add('GET', '/api/usage/pending', 'user', (req) => {
    const actor = me(req);
    const now = ctx.clock.now();
    const nowIso = now.toISOString();
    const days = readDays(req.query);
    const all = ['1', 'true'].includes(req.query.get('all') ?? '');
    const asked = queryUserId(req.query);
    const isAdmin = actor.role === 'admin';
    if (!isAdmin && (all || (asked !== undefined && asked !== actor.id))) {
      throw new HttpError(403, 'forbidden', 'You can only see your own kilometres to register');
    }
    const windowStart = windowBounds(now, config.tz, config.windowMonths).from;
    const lookBack = new Date(now.getTime() - days * DAY_MS).toISOString();
    const from = lookBack > windowStart ? lookBack : windowStart;

    const targets = all
      ? many<{ id: number; display_name: string }>(db, 'SELECT id, display_name FROM users WHERE active = 1 ORDER BY display_name COLLATE NOCASE, id')
      : [one<{ id: number; display_name: string }>(db, 'SELECT id, display_name FROM users WHERE id = ?', asked ?? actor.id)];
    if (targets.some((t) => t === undefined)) throw new ValidationError({ userId: 'unknown_user' });

    const entries = (targets as Array<{ id: number; display_name: string }>).map((u) => {
      const reservations = listUnregistered(db, actor, nowIso, u.id, from);
      const drafts = many<UsageJoin>(db, `${SELECT} WHERE g.user_id = ? AND g.status = 'draft' ORDER BY g.start_utc, g.id`, u.id).map((d) => toDto(d, actor, false)); // a draft is not billed to anyone yet
      return { userId: u.id, userName: u.display_name, reservations, drafts };
    });
    // A reservation that already has a draft is the same piece of work as that draft.
    const items = all ? entries.filter((e) => e.reservations.length > 0 || e.drafts.length > 0) : entries;
    const count = items.reduce((n, e) => n + e.drafts.length + e.reservations.filter((r) => r.kmState !== 'draft').length, 0);
    return ok({ items, count });
  });

  router.add('GET', '/api/history', 'user', (req) => {
    const actor = me(req);
    const now = ctx.clock.now();
    const range = queryRange(req.query, now, config.tz, config.windowMonths);
    const rows = many<
      UsageJoin & { r_id: number | null; r_user_id: number | null; r_user_name: string | null; r_start: string | null; r_end: string | null }
    >(
      db,
      `SELECT g.*, u.display_name AS user_name, ku.display_name AS km_user_name,
              r.id AS r_id, r.user_id AS r_user_id, ru.display_name AS r_user_name, r.start_utc AS r_start, r.end_utc AS r_end
         FROM usage g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN users ku ON ku.id = g.km_user_id
         LEFT JOIN reservations r ON r.id = g.reservation_id
         LEFT JOIN users ru ON ru.id = r.user_id
        WHERE g.end_utc >= ? AND g.start_utc <= ?
        ORDER BY g.start_utc DESC, g.id DESC`,
      range.from,
      range.to,
    );
    const locked = lockedFor(db, actor);
    const usage = rows.map((row) => {
      const linked = row.r_id !== null;
      return {
        ...toDto(row, actor, locked(row)),
        reservation: linked
          ? { id: row.r_id, userId: row.r_user_id, userName: row.r_user_name, start: row.r_start, end: row.r_end }
          : null,
        sameDriver: linked ? row.r_user_id === row.user_id : null,
      };
    });
    return ok({ usage, reservations: listConfirmed(db, actor, now.toISOString(), range.from, range.to), window: range });
  });

  router.add('POST', '/api/usage', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const status = f.oneOf('status', STATUSES, { optional: true }) ?? 'completed';
    const userId = f.int('userId', { optional: true, min: 1 }) ?? actor.id;
    const start = f.instant('start');
    const end = readEnd(f);
    const odometerStart = readOdometer(f, 'odometerStart');
    const odometerEnd = readOdometer(f, 'odometerEnd');
    const reservationId = f.nullableInt('reservationId', { min: 1 });
    const kmFor = f.oneOf('kmFor', KM_FORS, { optional: true }) ?? 'self';
    const kmUserId = f.nullableInt('kmUserId', { min: 1 }) ?? null;
    const note = f.string('note', { optional: true, max: 500 }) ?? '';
    // Type errors above win (fail keeps the first code); these are the km obligation, the draft shape and whose km they are.
    const rules = {
      ...shapeErrors({ status, start, end: end ?? null, odometerStart: odometerStart ?? null, odometerEnd: odometerEnd ?? null }),
      ...attributionErrors({ kmFor, kmUserId, driverId: userId, note }),
    };
    for (const [key, code] of Object.entries(rules)) f.fail(key, code);
    f.done();
    if (userId !== actor.id && actor.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only an admin can log usage for someone else');
    }
    const input: UsageInput = {
      userId,
      status,
      start: start as string,
      end: end ?? null,
      odometerStart: odometerStart ?? null,
      odometerEnd: odometerEnd ?? null,
      reservationId: reservationId ?? null,
      kmFor,
      kmUserId,
      note,
    };
    const now = ctx.clock.now();
    const nowIso = now.toISOString();
    let created: UsageJoin;
    try {
      created = tx(db, () => {
        assertNotBilledToOthers(db, actor, input);
        checkUsage(ctx, input, now, -1, null);
        const { lastInsertRowid } = run(
          db,
          `INSERT INTO usage (user_id, status, start_utc, end_utc, odometer_start, odometer_end, reservation_id, km_for, km_user_id, note, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.userId,
          input.status,
          input.start,
          input.end ?? input.start,
          input.odometerStart,
          input.odometerEnd,
          input.reservationId,
          input.kmFor,
          input.kmUserId,
          input.note,
          actor.id,
          nowIso,
          nowIso,
        );
        return load(db, lastInsertRowid);
      });
    } catch (err) {
      return mapDraftRace(db, userId, err);
    }
    ctx.log({ event: 'usage.created', id: created.id, by: actor.id, userId, status: created.status });
    return ok({ usage: toDto(created, actor, lockedFor(db, actor)(created)) }, 201);
  });

  router.add('PATCH', '/api/usage/:id', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const body = await req.json();
    const existing = load(db, id);
    if (!mayChange(actor, existing)) throw new HttpError(403, 'forbidden', 'You are not allowed to change that record');
    const f = new Fields(body);
    const status = f.oneOf('status', STATUSES, { optional: true }) ?? existing.status;
    const userId = f.int('userId', { optional: true, min: 1 }) ?? existing.user_id;
    const start = f.instant('start', { optional: true });
    const end = readEnd(f);
    const odometerStart = readOdometer(f, 'odometerStart');
    const odometerEnd = readOdometer(f, 'odometerEnd');
    const reservationId = f.nullableInt('reservationId', { min: 1 });
    const kmForIn = f.oneOf('kmFor', KM_FORS, { optional: true });
    const kmUserIdIn = f.nullableInt('kmUserId', { min: 1 });
    const note = f.string('note', { optional: true, max: 500 });
    // The person carries over only while the drive stays "someone else's"; any other choice clears it.
    const kmFor = kmForIn ?? existing.km_for;
    const kmUserId = kmUserIdIn !== undefined ? kmUserIdIn : kmFor === 'person' ? existing.km_user_id : null;
    const input: UsageInput = {
      userId,
      status,
      start: start ?? existing.start_utc,
      // The stored end of a draft is only a placeholder: finishing one must bring a real end.
      end: end !== undefined ? end : existing.status === 'completed' ? existing.end_utc : null,
      odometerStart: odometerStart === undefined ? existing.odometer_start : odometerStart,
      odometerEnd: odometerEnd === undefined ? existing.odometer_end : odometerEnd,
      reservationId: reservationId === undefined ? existing.reservation_id : reservationId,
      kmFor,
      kmUserId,
      note: note ?? existing.note,
    };
    if (existing.status === 'completed' && status === 'draft') {
      f.fail('status', 'cannot_reopen');
    } else {
      for (const [key, code] of Object.entries(shapeErrors(input))) f.fail(key, code);
    }
    for (const [key, code] of Object.entries(attributionErrors({ kmFor, kmUserId, driverId: userId, note: input.note }))) f.fail(key, code);
    f.done();
    if (userId !== existing.user_id && actor.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only an admin can reassign a usage record');
    }
    const now = ctx.clock.now();
    let updated: UsageJoin;
    try {
      updated = tx(db, () => {
        assertNotFuelLocked(db, actor, existing, input.end);
        // A draft is not billed to anyone yet, so finishing one is a new registration (a completed drive was checked above).
        if (existing.status === 'draft') assertNotBilledToOthers(db, actor, input);
        checkUsage(ctx, input, now, id, existing.km_user_id);
        run(
          db,
          `UPDATE usage SET user_id = ?, status = ?, start_utc = ?, end_utc = ?, odometer_start = ?, odometer_end = ?,
                  reservation_id = ?, km_for = ?, km_user_id = ?, note = ?, updated_at = ? WHERE id = ?`,
          input.userId,
          input.status,
          input.start,
          input.end ?? input.start,
          input.odometerStart,
          input.odometerEnd,
          input.reservationId,
          input.kmFor,
          input.kmUserId,
          input.note,
          now.toISOString(),
          id,
        );
        return load(db, id);
      });
    } catch (err) {
      return mapDraftRace(db, input.userId, err);
    }
    ctx.log({ event: 'usage.updated', id, by: actor.id, status: updated.status });
    return ok({ usage: toDto(updated, actor, lockedFor(db, actor)(updated)) });
  });

  router.add('DELETE', '/api/usage/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const row = load(db, id);
    if (!mayChange(actor, row)) throw new HttpError(403, 'forbidden', 'You are not allowed to delete that record');
    assertNotFuelLocked(db, actor, row, null);
    run(db, 'DELETE FROM usage WHERE id = ?', id);
    ctx.log({ event: 'usage.deleted', id, by: actor.id, userId: row.user_id });
    return noContent();
  });
}
