import { many, one, run, tx, type Db, type UsageRow } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import { listConfirmed } from './reservations.ts';
import { Fields, ValidationError, assertInsideWindow, failIfAny, queryRange, queryUserId } from './validate.ts';

/** A usage record may end at most this far in the future (clock skew, "just got back"). */
const FUTURE_SLACK_MS = 5 * 60_000;
const MAX_ODOMETER = 10_000_000;

interface UsageJoin extends UsageRow {
  user_name: string;
}

export interface UsageDto {
  id: number;
  userId: number;
  userName: string;
  start: string;
  end: string;
  odometerStart: number | null;
  odometerEnd: number | null;
  /** Only known when both odometer readings exist. */
  distanceKm: number | null;
  reservationId: number | null;
  note: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  can: { edit: boolean; delete: boolean };
}

const SELECT = `SELECT g.*, u.display_name AS user_name FROM usage g JOIN users u ON u.id = g.user_id`;

function mayChange(actor: Principal, row: UsageRow): boolean {
  return actor.role === 'admin' || actor.id === row.user_id;
}

function toDto(row: UsageJoin, actor: Principal): UsageDto {
  const both = row.odometer_start !== null && row.odometer_end !== null;
  const may = mayChange(actor, row);
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    start: row.start_utc,
    end: row.end_utc,
    odometerStart: row.odometer_start,
    odometerEnd: row.odometer_end,
    distanceKm: both ? (row.odometer_end as number) - (row.odometer_start as number) : null,
    reservationId: row.reservation_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    can: { edit: may, delete: may },
  };
}

function load(db: Db, id: number): UsageJoin {
  const row = one<UsageJoin>(db, `${SELECT} WHERE g.id = ?`, id);
  if (!row) throw new HttpError(404, 'not_found', 'Usage record not found');
  return row;
}

interface UsageInput {
  userId: number;
  start: string;
  end: string;
  odometerStart: number | null;
  odometerEnd: number | null;
  reservationId: number | null;
  note: string;
}

/** Cross-field rules shared by create and update. Throws 422/409. */
function checkUsage(ctx: Ctx, input: UsageInput, now: Date, excludeId: number): void {
  if (!one<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE id = ?', input.userId)) throw new ValidationError({ userId: 'unknown_user' });
  const nowMs = now.getTime();
  const errors: Record<string, string> = {};
  if (input.end < input.start) errors['end'] = 'must_not_be_before_start';
  else if (Date.parse(input.end) > nowMs + FUTURE_SLACK_MS) errors['end'] = 'in_future';
  if (
    input.odometerStart !== null &&
    input.odometerEnd !== null &&
    input.odometerEnd < input.odometerStart
  ) {
    errors['odometerEnd'] = 'must_not_be_below_start';
  }
  failIfAny(errors);
  assertInsideWindow(input.start, input.end, now, ctx.config.tz, ctx.config.windowMonths);
  // The overlap check and the write that follows must share one transaction;
  // callers invoke this from inside tx().
  if (input.reservationId !== null) {
    const res = one<{ status: string }>(ctx.db, 'SELECT status FROM reservations WHERE id = ?', input.reservationId);
    if (res?.status !== 'confirmed') throw new ValidationError({ reservationId: 'unknown_reservation' });
  }
  const clash = one<{ id: number; start_utc: string; end_utc: string; user_name: string }>(
    ctx.db,
    `SELECT g.id, g.start_utc, g.end_utc, u.display_name AS user_name
       FROM usage g JOIN users u ON u.id = g.user_id
      WHERE g.id != ?
        AND ((g.start_utc < ? AND ? < g.end_utc) OR (g.start_utc = ? AND g.end_utc = ?))
      ORDER BY g.start_utc LIMIT 1`,
    excludeId,
    input.end,
    input.start,
    input.start,
    input.end,
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
    return ok({ items: rows.map((r) => toDto(r, actor)), window: range });
  });

  router.add('GET', '/api/usage/summary', 'user', (req) => {
    const range = queryRange(req.query, ctx.clock.now(), config.tz, config.windowMonths);
    const rows = many<{ user_id: number; user_name: string; trips: number; trips_with_km: number; km: number }>(
      db,
      `SELECT g.user_id, u.display_name AS user_name, COUNT(*) AS trips,
              SUM(CASE WHEN g.odometer_start IS NOT NULL AND g.odometer_end IS NOT NULL THEN 1 ELSE 0 END) AS trips_with_km,
              COALESCE(SUM(CASE WHEN g.odometer_start IS NOT NULL AND g.odometer_end IS NOT NULL
                                THEN g.odometer_end - g.odometer_start END), 0) AS km
         FROM usage g JOIN users u ON u.id = g.user_id
        WHERE g.end_utc >= ? AND g.start_utc <= ?
        GROUP BY g.user_id, u.display_name
        ORDER BY km DESC, trips DESC, u.display_name`,
      range.from,
      range.to,
    );
    const items = rows.map((r) => ({ userId: r.user_id, userName: r.user_name, trips: r.trips, tripsWithKm: r.trips_with_km, km: r.km }));
    return ok({
      items,
      totalTrips: items.reduce((n, r) => n + r.trips, 0),
      totalKm: items.reduce((n, r) => n + r.km, 0),
      window: range,
    });
  });

  router.add('GET', '/api/history', 'user', (req) => {
    const actor = me(req);
    const now = ctx.clock.now();
    const range = queryRange(req.query, now, config.tz, config.windowMonths);
    const rows = many<
      UsageJoin & { r_id: number | null; r_user_id: number | null; r_user_name: string | null; r_start: string | null; r_end: string | null }
    >(
      db,
      `SELECT g.*, u.display_name AS user_name,
              r.id AS r_id, r.user_id AS r_user_id, ru.display_name AS r_user_name, r.start_utc AS r_start, r.end_utc AS r_end
         FROM usage g
         JOIN users u ON u.id = g.user_id
         LEFT JOIN reservations r ON r.id = g.reservation_id
         LEFT JOIN users ru ON ru.id = r.user_id
        WHERE g.end_utc >= ? AND g.start_utc <= ?
        ORDER BY g.start_utc DESC, g.id DESC`,
      range.from,
      range.to,
    );
    const usage = rows.map((row) => {
      const linked = row.r_id !== null;
      return {
        ...toDto(row, actor),
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
    const userId = f.int('userId', { optional: true, min: 1 }) ?? actor.id;
    const start = f.instant('start');
    const end = f.instant('end');
    const odometerStart = readOdometer(f, 'odometerStart');
    const odometerEnd = readOdometer(f, 'odometerEnd');
    const reservationId = f.nullableInt('reservationId', { min: 1 });
    const note = f.string('note', { optional: true, max: 500 }) ?? '';
    f.done();
    if (userId !== actor.id && actor.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only an admin can log usage for someone else');
    }
    const input: UsageInput = {
      userId,
      start: start as string,
      end: end as string,
      odometerStart: odometerStart ?? null,
      odometerEnd: odometerEnd ?? null,
      reservationId: reservationId ?? null,
      note,
    };
    const now = ctx.clock.now();
    const nowIso = now.toISOString();
    const created = tx(db, () => {
      checkUsage(ctx, input, now, -1);
      const { lastInsertRowid } = run(
        db,
        `INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, reservation_id, note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.userId,
        input.start,
        input.end,
        input.odometerStart,
        input.odometerEnd,
        input.reservationId,
        input.note,
        actor.id,
        nowIso,
        nowIso,
      );
      return load(db, lastInsertRowid);
    });
    ctx.log({ event: 'usage.created', id: created.id, by: actor.id, userId });
    return ok({ usage: toDto(created, actor) }, 201);
  });

  router.add('PATCH', '/api/usage/:id', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const body = await req.json();
    const existing = load(db, id);
    if (!mayChange(actor, existing)) throw new HttpError(403, 'forbidden', 'You are not allowed to change that record');
    const f = new Fields(body);
    const userId = f.int('userId', { optional: true, min: 1 }) ?? existing.user_id;
    const start = f.instant('start', { optional: true });
    const end = f.instant('end', { optional: true });
    const odometerStart = readOdometer(f, 'odometerStart');
    const odometerEnd = readOdometer(f, 'odometerEnd');
    const reservationId = f.nullableInt('reservationId', { min: 1 });
    const note = f.string('note', { optional: true, max: 500 });
    f.done();
    if (userId !== existing.user_id && actor.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only an admin can reassign a usage record');
    }
    const input: UsageInput = {
      userId,
      start: start ?? existing.start_utc,
      end: end ?? existing.end_utc,
      odometerStart: odometerStart === undefined ? existing.odometer_start : odometerStart,
      odometerEnd: odometerEnd === undefined ? existing.odometer_end : odometerEnd,
      reservationId: reservationId === undefined ? existing.reservation_id : reservationId,
      note: note ?? existing.note,
    };
    const now = ctx.clock.now();
    const updated = tx(db, () => {
      checkUsage(ctx, input, now, id);
      run(
        db,
        `UPDATE usage SET user_id = ?, start_utc = ?, end_utc = ?, odometer_start = ?, odometer_end = ?,
                reservation_id = ?, note = ?, updated_at = ? WHERE id = ?`,
        input.userId,
        input.start,
        input.end,
        input.odometerStart,
        input.odometerEnd,
        input.reservationId,
        input.note,
        now.toISOString(),
        id,
      );
      return load(db, id);
    });
    ctx.log({ event: 'usage.updated', id, by: actor.id });
    return ok({ usage: toDto(updated, actor) });
  });

  router.add('DELETE', '/api/usage/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const row = load(db, id);
    if (!mayChange(actor, row)) throw new HttpError(403, 'forbidden', 'You are not allowed to delete that record');
    run(db, 'DELETE FROM usage WHERE id = ?', id);
    ctx.log({ event: 'usage.deleted', id, by: actor.id, userId: row.user_id });
    return noContent();
  });
}
