// The read-only token API: four GET routes under /api/v1/ for the household's own tools (docs/API.md).
//
//   GET /api/v1/status        who has the car, who is next, what is still to register, open damage, the APK
//   GET /api/v1/reservations  the reservations the token's owner may see (same filters as the app)
//   GET /api/v1/stats         the monthly statistics, exactly what GET /api/stats answers
//   GET /api/v1/me            the owner's own kilometres and fuel balances
//
// Nothing here is a new rule. Every route calls the function the app's own route calls, as the token's owner and
// always as a member (tokens are role-blind, even an admin's), so a token can never see more than the app shows
// that person: no user management, no admin data, no password hashes, nobody else's pending suggestion. There is no
// way to write: http.ts refuses any route under /api/v1/ that is not a GET with the token auth level.
//
// "Who has the car now" is the Start screen's rule (carNow in public/views/home.js) worked out on the server: an
// open drive that started in the last 7 days means the car is on the road; otherwise the confirmed reservation that
// covers this moment; otherwise it is free until the next confirmed reservation. test/v1.test.ts runs the real
// browser function next to this one over seeded scenarios. One deliberate difference: the browser only looks 60
// days ahead, this looks as far as the 6-month window.
import { apkOf, openDamageCount } from './car.ts';
import { one, type Db } from './db.ts';
import { fuelOverview } from './fuel.ts';
import { me, ok, type Ctx, type Principal, type Router } from './http.ts';
import { listReservations, type ReservationDto } from './reservations.ts';
import { parseStatsRange, statsReport } from './stats.ts';
import { pendingKmFor, usageSummary } from './usage.ts';
import { windowBounds } from './validate.ts';

const DAY_MS = 86_400_000;
/** An open drive older than this is a forgotten one, not "on the road" (the Start screen looks back the same). */
export const DRIVE_LOOK_BACK_MS = 7 * DAY_MS;

export interface BriefReservation {
  id: number;
  userId: number;
  userName: string;
  start: string;
  end: string;
}

export type CarState = 'driving' | 'reserved' | 'free';

export interface CarNow {
  state: CarState;
  /** Who has it: the driver of the open drive, or the person whose reservation covers now; null when it is free. */
  holder: { id: number; name: string } | null;
  /** When the drive started, or the reservation began; null when it is free. */
  since: string | null;
  /** When the reservation ends; null when it is free or somebody is on the road (no end is known). */
  until: string | null;
  /** While it is free: when the next confirmed reservation starts (the car is free until then); null when none is planned. */
  freeUntil: string | null;
}

interface ReservationPick {
  id: number;
  user_id: number;
  user_name: string;
  start_utc: string;
  end_utc: string;
}

const brief = (row: ReservationPick): BriefReservation => ({ id: row.id, userId: row.user_id, userName: row.user_name, start: row.start_utc, end: row.end_utc });

const PICK = `SELECT r.id, r.user_id, u.display_name AS user_name, r.start_utc, r.end_utc
  FROM reservations r JOIN users u ON u.id = r.user_id`;

/** Who has the car at `now`, and the next confirmed reservation after it. Same rule as carNow() in public/views/home.js. */
export function carNow(db: Db, now: Date): { car: CarNow; next: BriefReservation | null } {
  const nowIso = now.toISOString();
  const lookBack = new Date(now.getTime() - DRIVE_LOOK_BACK_MS).toISOString();
  const lookAhead = new Date(now.getTime() + DAY_MS).toISOString();
  // The latest start wins, then the highest id: somebody who forgot to finish an old drive does not hide a newer one.
  const driving = one<{ id: number; user_id: number; user_name: string; start_utc: string }>(
    db,
    `SELECT g.id, g.user_id, u.display_name AS user_name, g.start_utc
       FROM usage g JOIN users u ON u.id = g.user_id
      WHERE g.status = 'draft' AND g.end_utc >= ? AND g.start_utc <= ?
      ORDER BY g.start_utc DESC, g.id DESC LIMIT 1`,
    lookBack,
    lookAhead,
  );
  const current = one<ReservationPick>(db, `${PICK} WHERE r.status = 'confirmed' AND r.start_utc <= ? AND r.end_utc > ? ORDER BY r.start_utc, r.id LIMIT 1`, nowIso, nowIso);
  const nextRow = one<ReservationPick>(db, `${PICK} WHERE r.status = 'confirmed' AND r.start_utc > ? ORDER BY r.start_utc, r.id LIMIT 1`, nowIso);
  const next = nextRow ? brief(nextRow) : null;
  if (driving) {
    return { car: { state: 'driving', holder: { id: driving.user_id, name: driving.user_name }, since: driving.start_utc, until: null, freeUntil: null }, next };
  }
  if (current) {
    return { car: { state: 'reserved', holder: { id: current.user_id, name: current.user_name }, since: current.start_utc, until: current.end_utc, freeUntil: null }, next };
  }
  return { car: { state: 'free', holder: null, since: null, until: null, freeUntil: next?.start ?? null }, next };
}

/** The first confirmed reservation of this person that has not ended (one that is going on now counts). */
export function myNextReservation(db: Db, userId: number, nowIso: string): BriefReservation | null {
  const row = one<ReservationPick>(db, `${PICK} WHERE r.status = 'confirmed' AND r.user_id = ? AND r.end_utc >= ? ORDER BY r.start_utc, r.id LIMIT 1`, userId, nowIso);
  return row ? brief(row) : null;
}

/** What the answer says about one person: their own kilometres in the window and who they owe or are owed by. */
function meBody(ctx: Ctx, owner: Principal): Record<string, unknown> {
  const now = ctx.clock.now();
  const window = windowBounds(now, ctx.config.tz, ctx.config.windowMonths);
  const mine = usageSummary(ctx, window).items.find((p) => p.userId === owner.id);
  const balances = fuelOverview(ctx.db, owner).balances;
  const owe = balances.filter((b) => b.fromUserId === owner.id).map((b) => ({ userId: b.toUserId, userName: b.toName, cents: b.cents }));
  const owed = balances.filter((b) => b.toUserId === owner.id).map((b) => ({ userId: b.fromUserId, userName: b.fromName, cents: b.cents }));
  const sum = (rows: Array<{ cents: number }>): number => rows.reduce((n, r) => n + r.cents, 0);
  return {
    user: { id: owner.id, username: owner.username, displayName: owner.displayName },
    km: { trips: mine?.trips ?? 0, tripsWithKm: mine?.tripsWithKm ?? 0, km: mine?.km ?? 0, window },
    fuel: { owe, owed, oweTotalCents: sum(owe), owedTotalCents: sum(owed) },
  };
}

/** A reservation as the token API shows it: what the app shows, without the buttons (`can`), which mean nothing to a script. */
function withoutCan(item: ReservationDto): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...item };
  delete copy['can'];
  return copy;
}

export function registerV1Routes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;

  router.add('GET', '/api/v1/status', 'token', (req) => {
    const owner = me(req);
    const now = ctx.clock.now();
    const { car, next } = carNow(db, now);
    return ok({
      now: now.toISOString(),
      car,
      next,
      myNext: myNextReservation(db, owner.id, now.toISOString()),
      kmToRegister: pendingKmFor(ctx, owner, owner.id, undefined, now).count,
      openDamage: openDamageCount(db),
      apk: apkOf(db, config.tz, now),
    });
  });

  router.add('GET', '/api/v1/reservations', 'token', (req) => {
    const { items, window } = listReservations(ctx, me(req), req.query);
    return ok({ items: items.map(withoutCan), window });
  });

  // The same function, the same answer, byte for byte, as the cookie route (test/v1.test.ts compares them).
  router.add('GET', '/api/v1/stats', 'token', (req) => {
    const now = ctx.clock.now();
    return ok(statsReport(db, config, now, parseStatsRange(req.query, now, config.tz, config.statsRetentionMonths)));
  });

  router.add('GET', '/api/v1/me', 'token', (req) => ok(meBody(ctx, me(req))));
}
