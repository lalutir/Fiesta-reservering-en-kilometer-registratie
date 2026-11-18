import { many, one, run, tx, type Db, type KmFor, type ReservationRow, type ReservationStatus, type UsageStatus, type UserRow } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Req, type Router } from './http.ts';
import { Fields, ValidationError, assertInsideWindow, queryRange, queryUserId, windowBounds } from './validate.ts';

/** 'expired' is never stored: it is a pending suggestion whose start has passed. */
export type EffectiveStatus = ReservationStatus | 'expired';
export type Action = 'edit' | 'cancel' | 'approve' | 'decline';

/** The drive shown on a reservation: the one that registers it, else a linked draft, else a linked older drive. */
export interface ReservationDrive {
  id: number;
  userId: number;
  userName: string;
  status: UsageStatus;
  odometerStart: number | null;
  odometerEnd: number | null;
  distanceKm: number | null;
  /** True when the drive was linked to this reservation; false when it only overlaps it in time. */
  linked: boolean;
  /** Whose kilometres these are: the driver's own, another person's or the shared pool. */
  kmFor: KmFor;
  kmUserId: number | null;
  kmUserName: string | null;
}

/** registered = a completed drive with both readings covers it; draft = a linked drive was started; missing = neither. */
export type KmState = 'registered' | 'draft' | 'missing';

interface ReservationJoin extends ReservationRow {
  user_name: string;
  created_by_name: string;
  registered: number;
  d_id: number | null;
  d_user_id: number | null;
  d_user_name: string | null;
  d_status: UsageStatus | null;
  d_odo_start: number | null;
  d_odo_end: number | null;
  d_reservation_id: number | null;
  d_km_for: KmFor | null;
  d_km_user_id: number | null;
  d_km_user_name: string | null;
}

export interface ReservationDto {
  id: number;
  userId: number;
  userName: string;
  createdBy: number;
  createdByName: string;
  status: EffectiveStatus;
  /** True when someone other than the driver created it (suggestion or approved suggestion). */
  suggestion: boolean;
  start: string;
  end: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  can: Record<Action, boolean>;
  /** The drive that registers this reservation (or the draft/older drive linked to it); null when there is none. */
  drive: ReservationDrive | null;
  /** Invariant: 'registered' always comes with a non-null drive. */
  kmState: KmState;
}

/** A finished drive with both odometer readings: the only kind of drive whose kilometres count. `a` is the usage alias. */
const COUNTED_SQL = (a: string): string => `${a}.status = 'completed' AND ${a}.odometer_start IS NOT NULL AND ${a}.odometer_end IS NOT NULL`;

/**
 * "This reservation has its kilometres registered": a completed drive with both
 * odometer readings that is linked to it or strictly overlaps it (touching ends
 * do not count), by anyone. Alias `r` is the reservation. The one definition
 * behind the reservation card, the pending-km list and the reminder scheduler,
 * so the three can never disagree.
 */
export const REGISTERED_SQL = `EXISTS (SELECT 1 FROM usage x
         WHERE ${COUNTED_SQL('x')}
           AND (x.reservation_id = r.id OR (x.start_utc < r.end_utc AND x.end_utc > r.start_utc)))`;

// Which drive to show on a reservation: first the completed drive with readings that registers it
// (linked ones before merely overlapping ones), then a linked draft, then a linked older drive
// without readings. Every row that REGISTERED_SQL accepts is a candidate of rank 0 or 1, so a
// registered reservation always has a drive. The rank is computed in a derived table because SQLite
// does not resolve a reference to the outer reservation (`r`) inside an ORDER BY.
const DRIVE_PICK_SQL = `(SELECT p.id FROM (
           SELECT g.id AS id, g.start_utc AS start_utc,
                  CASE
                    WHEN ${COUNTED_SQL('g')} AND g.reservation_id = r.id THEN 0
                    WHEN ${COUNTED_SQL('g')} THEN 1
                    WHEN g.status = 'draft' THEN 2
                    ELSE 3
                  END AS rank
             FROM usage g
            WHERE g.reservation_id = r.id
               OR (${COUNTED_SQL('g')} AND g.start_utc < r.end_utc AND g.end_utc > r.start_utc)) p
         ORDER BY p.rank, p.start_utc, p.id
         LIMIT 1)`;

const SELECT = `SELECT r.*, u.display_name AS user_name, c.display_name AS created_by_name,
         (${REGISTERED_SQL}) AS registered,
         d.id AS d_id, d.user_id AS d_user_id, du.display_name AS d_user_name, d.status AS d_status,
         d.odometer_start AS d_odo_start, d.odometer_end AS d_odo_end, d.reservation_id AS d_reservation_id,
         d.km_for AS d_km_for, d.km_user_id AS d_km_user_id, dku.display_name AS d_km_user_name
  FROM reservations r
  JOIN users u ON u.id = r.user_id
  JOIN users c ON c.id = r.created_by
  LEFT JOIN usage d ON d.id = ${DRIVE_PICK_SQL}
  LEFT JOIN users du ON du.id = d.user_id
  LEFT JOIN users dku ON dku.id = d.km_user_id`;

// ------------------------------------------------------------- permissions
// One place decides who may do what. The same functions guard the mutating
// routes and fill the `can` flags the clients render, so they cannot drift.

export function effectiveStatus(row: ReservationRow, nowIso: string): EffectiveStatus {
  return row.status === 'pending' && row.start_utc <= nowIso ? 'expired' : row.status;
}

export function isVisible(actor: Principal, row: ReservationRow): boolean {
  return row.status === 'confirmed' || actor.role === 'admin' || actor.id === row.created_by || actor.id === row.user_id;
}

/** Role rule only: would this actor be allowed to do this, ignoring the state of the row? */
export function roleMay(action: Action, actor: Principal, row: ReservationRow): boolean {
  const admin = actor.role === 'admin';
  switch (action) {
    case 'edit':
    case 'cancel':
      // Confirmed: the driver (owner) or an admin. Pending/declined: the creator or an admin.
      return row.status === 'confirmed' ? admin || actor.id === row.user_id : admin || actor.id === row.created_by;
    case 'approve':
    case 'decline':
      // Only the target decides. Admins get no override.
      return actor.id === row.user_id;
  }
}

/** State rule: returns the 409 to throw when the row is in the wrong state, else undefined. */
export function stateProblem(action: Action, row: ReservationRow, nowIso: string): HttpError | undefined {
  const lapsed = row.status === 'pending' && row.start_utc <= nowIso;
  switch (action) {
    case 'cancel':
      return undefined;
    case 'edit':
      if (row.status === 'confirmed' || (row.status === 'pending' && !lapsed)) return undefined;
      return new HttpError(409, 'not_editable', 'Declined or expired suggestions cannot be edited');
    case 'approve':
    case 'decline':
      if (row.status !== 'pending') return new HttpError(409, 'not_pending', 'Only pending suggestions can be answered');
      if (lapsed) return new HttpError(409, 'suggestion_expired', 'This suggestion has already started and lapsed');
      return undefined;
  }
}

function canFlags(actor: Principal, row: ReservationRow, nowIso: string): Record<Action, boolean> {
  const flag = (a: Action): boolean => roleMay(a, actor, row) && stateProblem(a, row, nowIso) === undefined;
  return { edit: flag('edit'), cancel: flag('cancel'), approve: flag('approve'), decline: flag('decline') };
}

function driveOf(row: ReservationJoin): ReservationDrive | null {
  if (row.d_id === null) return null;
  const both = row.d_odo_start !== null && row.d_odo_end !== null;
  return {
    id: row.d_id,
    userId: row.d_user_id as number,
    userName: row.d_user_name as string,
    status: row.d_status as UsageStatus,
    odometerStart: row.d_odo_start,
    odometerEnd: row.d_odo_end,
    distanceKm: both ? (row.d_odo_end as number) - (row.d_odo_start as number) : null,
    linked: row.d_reservation_id === row.id,
    kmFor: row.d_km_for as KmFor,
    kmUserId: row.d_km_user_id,
    kmUserName: row.d_km_user_name,
  };
}

export function toDto(row: ReservationJoin, actor: Principal, nowIso: string): ReservationDto {
  const drive = driveOf(row);
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    status: effectiveStatus(row, nowIso),
    suggestion: row.created_by !== row.user_id,
    start: row.start_utc,
    end: row.end_utc,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    can: canFlags(actor, row, nowIso),
    drive,
    kmState: row.registered === 1 ? 'registered' : drive?.status === 'draft' ? 'draft' : 'missing',
  };
}

// --------------------------------------------------------------- data access

function load(db: Db, id: number): ReservationJoin {
  const row = one<ReservationJoin>(db, `${SELECT} WHERE r.id = ?`, id);
  if (!row) throw new HttpError(404, 'not_found', 'Reservation not found');
  return row;
}

/** Load for a mutation: 404 if unknown, 403 if the actor may not see it or may not do `action`. */
function loadFor(db: Db, actor: Principal, id: number, action: Action): ReservationJoin {
  const row = load(db, id);
  if (!isVisible(actor, row) || !roleMay(action, actor, row)) {
    throw new HttpError(403, 'forbidden', 'You are not allowed to do that');
  }
  return row;
}

/**
 * The first confirmed reservation that overlaps [start, end). Touching ends do
 * not overlap. Only confirmed rows count; pending suggestions never block.
 * Must run inside tx() so the check and the write are atomic.
 */
export function findOverlap(
  db: Db,
  start: string,
  end: string,
  excludeId = -1,
): { id: number; start: string; end: string; userName: string } | undefined {
  const row = one<{ id: number; start_utc: string; end_utc: string; user_name: string }>(
    db,
    `SELECT r.id, r.start_utc, r.end_utc, u.display_name AS user_name
       FROM reservations r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'confirmed' AND r.id != ? AND r.start_utc < ? AND ? < r.end_utc
      ORDER BY r.start_utc LIMIT 1`,
    excludeId,
    end,
    start,
  );
  return row && { id: row.id, start: row.start_utc, end: row.end_utc, userName: row.user_name };
}

/** Confirmed reservations touching [from, to], for the reserved-versus-actual history. */
export function listConfirmed(db: Db, actor: Principal, nowIso: string, from: string, to: string): ReservationDto[] {
  const rows = many<ReservationJoin>(
    db,
    `${SELECT} WHERE r.status = 'confirmed' AND r.end_utc >= ? AND r.start_utc <= ? ORDER BY r.start_utc, r.id`,
    from,
    to,
  );
  return rows.map((r) => toDto(r, actor, nowIso));
}

/**
 * Confirmed reservations of one driver that have ended (since `from`) and have no
 * completed drive with both readings: the kilometres still to register.
 */
export function listUnregistered(db: Db, actor: Principal, nowIso: string, userId: number, from: string): ReservationDto[] {
  const rows = many<ReservationJoin>(
    db,
    `${SELECT} WHERE r.status = 'confirmed' AND r.user_id = ? AND r.end_utc <= ? AND r.end_utc >= ? AND NOT ${REGISTERED_SQL}
      ORDER BY r.start_utc, r.id`,
    userId,
    nowIso,
    from,
  );
  return rows.map((r) => toDto(r, actor, nowIso));
}

function overlapError(conflict: NonNullable<ReturnType<typeof findOverlap>>): HttpError {
  return new HttpError(409, 'overlap', `That time overlaps a reservation by ${conflict.userName}`, {
    extra: { conflict },
  });
}

// -------------------------------------------------------------------- routes

export function registerReservationRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;
  const nowDate = (): Date => ctx.clock.now();

  router.add('GET', '/api/reservations', 'user', (req) => {
    const actor = me(req);
    const now = nowDate();
    const nowIso = now.toISOString();
    const range = queryRange(req.query, now, config.tz, config.windowMonths);
    const where = ['r.end_utc >= ?', 'r.start_utc <= ?'];
    const params: Array<string | number> = [range.from, range.to];
    if (actor.role !== 'admin') {
      where.push("(r.status = 'confirmed' OR r.created_by = ? OR r.user_id = ?)");
      params.push(actor.id, actor.id);
    }
    const status = req.query.get('status');
    if (status !== null && status !== '') {
      if (status === 'expired') {
        where.push("r.status = 'pending' AND r.start_utc <= ?");
        params.push(nowIso);
      } else if (status === 'pending') {
        where.push("r.status = 'pending' AND r.start_utc > ?");
        params.push(nowIso);
      } else if (status === 'confirmed' || status === 'declined') {
        where.push('r.status = ?');
        params.push(status);
      } else {
        throw new ValidationError({ status: 'invalid_value' });
      }
    }
    const userId = queryUserId(req.query);
    if (userId !== undefined) {
      where.push('r.user_id = ?');
      params.push(userId);
    }
    const rows = many<ReservationJoin>(db, `${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.start_utc, r.id`, ...params);
    return ok({ items: rows.map((r) => toDto(r, actor, nowIso)), window: range });
  });

  router.add('GET', '/api/inbox', 'user', (req) => {
    const actor = me(req);
    const now = nowDate();
    const nowIso = now.toISOString();
    const { from } = windowBounds(now, config.tz, config.windowMonths);
    const incoming = many<ReservationJoin>(
      db,
      `${SELECT} WHERE r.status = 'pending' AND r.user_id = ? AND r.created_by != r.user_id
         AND r.start_utc > ? AND r.end_utc >= ? ORDER BY r.start_utc, r.id`,
      actor.id,
      nowIso,
      from,
    );
    const outgoing = many<ReservationJoin>(
      db,
      `${SELECT} WHERE r.created_by = ? AND r.user_id != r.created_by AND r.status IN ('pending', 'declined')
         AND r.end_utc >= ? ORDER BY r.start_utc, r.id`,
      actor.id,
      from,
    );
    return ok({
      incoming: incoming.map((r) => toDto(r, actor, nowIso)),
      outgoing: outgoing.map((r) => toDto(r, actor, nowIso)),
      incomingCount: incoming.length,
    });
  });

  router.add('GET', '/api/reservations/:id', 'user', (req) => {
    const actor = me(req);
    const row = load(db, idParam(req.params['id']));
    if (!isVisible(actor, row)) throw new HttpError(403, 'forbidden', 'You are not allowed to see that');
    return ok({ reservation: toDto(row, actor, nowDate().toISOString()) });
  });

  router.add('POST', '/api/reservations', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const targetId = f.int('userId', { optional: true, min: 1 }) ?? actor.id;
    const start = f.instant('start');
    const end = f.instant('end');
    const note = f.string('note', { optional: true, max: 500 }) ?? '';
    f.done();
    const s = start as string;
    const e = end as string;
    if (s >= e) throw new ValidationError({ end: 'must_be_after_start' });
    const now = nowDate();
    const nowIso = now.toISOString();
    assertInsideWindow(s, e, now, config.tz, config.windowMonths);

    const created = tx(db, () => {
      let status: ReservationStatus;
      if (targetId === actor.id) {
        // Own reservation: confirmed at once, unless it collides.
        const conflict = findOverlap(db, s, e);
        if (conflict) throw overlapError(conflict);
        status = 'confirmed';
      } else {
        // Someone else's slot is only ever a suggestion the target must approve.
        const target = one<UserRow>(db, 'SELECT * FROM users WHERE id = ? AND active = 1', targetId);
        if (!target) throw new ValidationError({ userId: 'unknown_user' });
        if (s <= nowIso) throw new ValidationError({ start: 'must_be_in_future' });
        status = 'pending';
      }
      const { lastInsertRowid } = run(
        db,
        `INSERT INTO reservations (user_id, created_by, status, start_utc, end_utc, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        targetId,
        actor.id,
        status,
        s,
        e,
        note,
        nowIso,
        nowIso,
      );
      return load(db, lastInsertRowid);
    });
    ctx.log({ event: 'reservation.created', id: created.id, by: actor.id, userId: created.user_id, status: created.status });
    return ok({ reservation: toDto(created, actor, nowIso) }, 201);
  });

  router.add('PATCH', '/api/reservations/:id', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const body = await req.json();
    const existing = loadFor(db, actor, id, 'edit');
    const now = nowDate();
    const nowIso = now.toISOString();
    const problem = stateProblem('edit', existing, nowIso);
    if (problem) throw problem;

    const f = new Fields(body);
    const start = f.instant('start', { optional: true }) ?? existing.start_utc;
    const end = f.instant('end', { optional: true }) ?? existing.end_utc;
    const note = f.string('note', { optional: true, max: 500 }) ?? existing.note;
    if (f.has('userId') && body['userId'] !== existing.user_id) f.fail('userId', 'immutable');
    f.done();
    if (start >= end) throw new ValidationError({ end: 'must_be_after_start' });
    assertInsideWindow(start, end, now, config.tz, config.windowMonths);

    const updated = tx(db, () => {
      const fresh = load(db, id);
      const again = stateProblem('edit', fresh, nowIso);
      if (again) throw again;
      if (fresh.status === 'confirmed') {
        const conflict = findOverlap(db, start, end, id);
        if (conflict) throw overlapError(conflict);
      } else if (start <= nowIso) {
        throw new ValidationError({ start: 'must_be_in_future' });
      }
      run(db, 'UPDATE reservations SET start_utc = ?, end_utc = ?, note = ?, updated_at = ? WHERE id = ?', start, end, note, nowIso, id);
      return load(db, id);
    });
    ctx.log({ event: 'reservation.updated', id, by: actor.id });
    return ok({ reservation: toDto(updated, actor, nowIso) });
  });

  router.add('DELETE', '/api/reservations/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const row = loadFor(db, actor, id, 'cancel');
    run(db, 'DELETE FROM reservations WHERE id = ?', id);
    ctx.log({ event: 'reservation.deleted', id, by: actor.id, status: row.status, userId: row.user_id });
    return noContent();
  });

  function decide(decision: 'approve' | 'decline') {
    return async (req: Req) => {
      const actor = me(req);
      const id = idParam(req.params['id']);
      await req.json(); // body is ignored but still validated as JSON
      loadFor(db, actor, id, decision);
      const nowIso = nowDate().toISOString();
      const updated = tx(db, () => {
        const row = load(db, id);
        const problem = stateProblem(decision, row, nowIso);
        if (problem) throw problem;
        if (decision === 'approve') {
          // The slot may have been taken since the suggestion was made.
          const conflict = findOverlap(db, row.start_utc, row.end_utc, id);
          if (conflict) throw overlapError(conflict);
        }
        run(
          db,
          'UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?',
          decision === 'approve' ? 'confirmed' : 'declined',
          nowIso,
          id,
        );
        return load(db, id);
      });
      ctx.log({ event: `reservation.${decision}d`, id, by: actor.id });
      return ok({ reservation: toDto(updated, actor, nowIso) });
    };
  }

  router.add('POST', '/api/reservations/:id/approve', 'user', decide('approve'));
  router.add('POST', '/api/reservations/:id/decline', 'user', decide('decline'));
}
