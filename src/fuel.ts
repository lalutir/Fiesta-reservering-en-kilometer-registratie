// Fuel fill-ups: who fuelled, when, how much it cost, and what each person owes
// for it. Money is integer cents, volume integer millilitres, nothing is floating point.
//
// The cost of a fill-up is split by the kilometres each person drove in the
// period it pays for: from the previous fill-up (exclusive) up to this one
// (inclusive), by the end time of completed drives that have both odometer
// readings. The first fill-up in the data covers every drive before it. Shares
// are computed live from the data, so editing a drive or a fill-up changes
// them; a payment request is a snapshot of the amount that was asked. Everybody a
// request was made for stays on the card, also when their share has dropped to
// nothing, and a drive that a request depends on is locked for its owner (usage.ts).
//
// Kilometres count for whoever they are attributed to (usage.km_for): the driver's own,
// another person's, or "together". Together kilometres are a pool that is split in the same
// ratio as the personal kilometres of the period, so the whole fill-up follows the kilometres
// each person drove; only when nobody has personal kilometres (nobody drove, or only together)
// is it split equally over the people who pay.
//
// Admins do not pay for fuel (fuelOverview): their own kilometres are left out of the split, they
// get no share, request or push, and the others pay the whole fill-up. An admin who fuels is still
// owed the money, and kilometres an admin drove for a member (or together) count under that owner.
//
// What a person still owes the same fueler from earlier fill-ups rides along with their
// next share, and a payment request settles those earlier shares when it is paid: the
// rules are in fuel-carry.ts. Registering a fill-up tells everybody who owes money, and what
// somebody else does to a fill-up or a payment mark that concerns you (an edit, a delete, "paid",
// "I have paid") is pushed to you by the central notifier (notify.ts).
import { many, one, run, tx, type Db, type FuelRequestRow, type FuelRow, type KmFor } from './db.ts';
import { carryKey, carryOver } from './fuel-carry.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import type { FuelHead, Notifier, ShareSnapshot } from './notify.ts';
import { gapsOrEmpty, type OpenGap } from './odometer.ts';
import { isHttpsLink, manualProvider, requestMessage, tikkieProvider, withLink, type PaymentInput, type PaymentProvider } from './payments.ts';
import { Fields, MAX_ODOMETER, ValidationError, assertPastInsideWindow, windowBounds } from './validate.ts';
import { formatLitres } from '../shared/format.js';
import { formatLocal } from '../shared/time.js';

export const MAX_MILLILITRES = 200_000;
export const MAX_TOTAL_CENTS = 1_000_000;

// ------------------------------------------------------------- pure maths

export interface ShareFuel {
  id: number;
  atUtc: string;
  totalCents: number;
}

export interface ShareDrive {
  /** Whose kilometres these are (the owner, not necessarily the driver). Ignored for together drives. */
  userId: number;
  /** When the drive ended; decides which fill-up period it belongs to. */
  endUtc: string;
  km: number;
  /** The kilometres belong to the shared pool: split in the ratio of the personal kilometres of the period. */
  together?: boolean;
}

export interface Allocation {
  userId: number;
  km: number;
  cents: number;
}

export interface FuelShares {
  fuelId: number;
  /** Exclusive lower bound of the period; null for the first fill-up (everything before it). */
  fromUtc: string | null;
  /** Inclusive upper bound: the time of the fill-up. */
  toUtc: string;
  /** Personal and together kilometres of the period. */
  totalKm: number;
  /** Of which driven together: a pool split in the same ratio as the personal kilometres. */
  togetherKm: number;
  /** Nobody has personal kilometres in the period (nobody drove, or only together), so the cost is split equally over the people who pay. */
  equalSplit: boolean;
  /** `km` is the person's own kilometres; the together pool is not in it. */
  shares: Allocation[];
}

/**
 * Split `total` cents in proportion to the integer weights with the largest
 * remainder method: everybody gets the floor of their exact share, and the
 * cents left over go one each to the biggest remainders (ties to the lower
 * user id). The parts always add up to the total. BigInt keeps it exact.
 */
export function splitCents(total: number, weights: Array<{ userId: number; weight: number }>): Array<{ userId: number; cents: number }> {
  const sum = weights.reduce((n, w) => n + BigInt(w.weight), 0n);
  if (sum === 0n) return weights.map((w) => ({ userId: w.userId, cents: 0 }));
  const whole = BigInt(total);
  const rows = weights.map((w) => {
    const exact = whole * BigInt(w.weight);
    return { userId: w.userId, base: exact / sum, rest: exact % sum };
  });
  const left = Number(whole - rows.reduce((n, r) => n + r.base, 0n));
  const order = [...rows].sort((a, b) => (a.rest === b.rest ? a.userId - b.userId : a.rest > b.rest ? -1 : 1));
  const extra = new Set(order.slice(0, left).map((r) => r.userId));
  return rows.map((r) => ({ userId: r.userId, cents: Number(r.base) + (extra.has(r.userId) ? 1 : 0) }));
}

/**
 * The share of every fill-up per person. Pure: the caller loads the data, this decides.
 *
 * Personal kilometres weigh their owner. Together kilometres are split in the ratio of the personal
 * kilometres of the same period, and that comes down to the same thing as weighing the whole
 * fill-up by personal kilometres: a person's part is total * km / personalKm, and the pool changes
 * nobody's weight. So the weights are the plain personal kilometres, one largest-remainder split
 * keeps the cents exact, and a person without personal kilometres in the period pays none of the
 * pool. Only when nobody has personal kilometres (nobody drove, or only together) the cost is
 * split equally over `payerIds` and flagged. `payerIds` are the people who pay by default; a person
 * with personal kilometres pays for them even when they are not listed (a deactivated user). Which
 * drives are passed in, and who may pay at all (admins do not), is decided by the caller.
 */
export function computeShares(fuels: ShareFuel[], drives: ShareDrive[], payerIds: number[]): FuelShares[] {
  const sorted = [...fuels].sort((a, b) => (a.atUtc < b.atUtc ? -1 : a.atUtc > b.atUtc ? 1 : a.id - b.id));
  const payers = [...new Set(payerIds)].sort((a, b) => a - b);
  return sorted.map((fuel, i) => {
    const fromUtc = i === 0 ? null : (sorted[i - 1] as ShareFuel).atUtc;
    const kmBy = new Map<number, number>();
    let pool = 0;
    for (const d of drives) {
      if (!((fromUtc === null || d.endUtc > fromUtc) && d.endUtc <= fuel.atUtc)) continue;
      if (d.together) pool += d.km;
      else kmBy.set(d.userId, (kmBy.get(d.userId) ?? 0) + d.km);
    }
    const drivers = [...kmBy].filter(([, km]) => km > 0).sort((a, b) => a[0] - b[0]);
    const personalKm = drivers.reduce((n, [, km]) => n + km, 0);
    const totalKm = personalKm + pool;
    const equalSplit = personalKm === 0;
    const weights = equalSplit ? payers.map((userId) => ({ userId, weight: 1 })) : drivers.map(([userId, km]) => ({ userId, weight: km }));
    const shares = splitCents(fuel.totalCents, weights).map((s) => ({ userId: s.userId, km: kmBy.get(s.userId) ?? 0, cents: s.cents }));
    return { fuelId: fuel.id, fromUtc, toUtc: fuel.atUtc, totalKm, togetherKm: pool, equalSplit, shares };
  });
}

/** Thousandths of a euro per litre, from integer cents and millilitres. */
export function pricePerLitreMillis(totalCents: number, millilitres: number): number {
  return Math.round((totalCents * 10_000) / millilitres);
}

// ------------------------------------------------------------------- DTOs

export interface FuelRequestDto {
  id: number;
  amountCents: number;
  provider: 'manual' | 'tikkie';
  message: string;
  link: string;
  createdAt: string;
  paidAt: string | null;
  paidBy: number | null;
  /** The live share differs from the amount that was asked (a drive or the fill-up changed since). */
  changed: boolean;
  /** What a request for this share would ask right now; the share alone for a request made before carry-over existed. */
  currentCents: number;
}

export interface FuelShareDto {
  userId: number;
  userName: string;
  /** The person's own kilometres in the period (their part of the together pool is not in it). */
  km: number;
  cents: number;
  /** Owes the fueler: not the fueler themselves, and either more than zero or a request was made for them. */
  owes: boolean;
  /** Net of the earlier open shares between the fueler and this person: more than zero is still owed to the fueler, less than zero is what the fueler owes them back. */
  carriedCents: number;
  /** What a request for this share asks: the share plus carriedCents, never below zero. */
  dueCents: number;
  /** A payment on a later fill-up settled this share; null when it is not settled. */
  settledBy: { fuelId: number; at: string } | null;
  request: FuelRequestDto | null;
  /** selfPaid: the person can say "I have paid this" for their own share (with or without a request). */
  can: { request: boolean; markPaid: boolean; selfPaid: boolean };
}

export interface FuelDto {
  id: number;
  userId: number;
  userName: string;
  at: string;
  millilitres: number;
  totalCents: number;
  pricePerLitreMillis: number;
  /** The odometer reading (km) at the pump; null for a fill-up made before the kilometre check existed. */
  odometer: number | null;
  note: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  period: { from: string | null; to: string };
  totalKm: number;
  /**
   * Kilometres the odometer chain shows were driven but not registered, in gaps that end inside this period
   * and that nobody explained. Display only: the split still counts registered kilometres and nothing else.
   */
  unaccountedKm: number;
  /** Of totalKm: driven together, a pool split in the same ratio as the personal kilometres. */
  togetherKm: number;
  /** Split equally because nobody has personal kilometres in the period. */
  equalSplit: boolean;
  /** The first fill-up in the data: it also pays for every drive before it. */
  firstInData: boolean;
  shares: FuelShareDto[];
  hasPaidRequests: boolean;
  /** A payment on a later fill-up settled a share of this one: it is locked like one with a paid request. */
  settledByLater: boolean;
  can: { edit: boolean; delete: boolean };
  /**
   * The fueler or an admin may correct the odometer reading, also on a fill-up that is locked for every other change:
   * the reading moves no money. A separate flag so `can` stays what it was.
   */
  canOdometer: boolean;
}

export interface BalanceDto {
  fromUserId: number;
  fromName: string;
  toUserId: number;
  toName: string;
  cents: number;
}

interface FuelJoin extends FuelRow {
  user_name: string;
}

/** What the notifier needs to name a fill-up. */
function headOfRow(row: FuelJoin): FuelHead {
  return { id: row.id, userId: row.user_id, userName: row.user_name, at: row.at_utc, totalCents: row.total_cents };
}
const headOfDto = (dto: FuelDto): FuelHead => ({ id: dto.id, userId: dto.userId, userName: dto.userName, at: dto.at, totalCents: dto.totalCents });

/**
 * Every share somebody owes, per fill-up, flattened so that the moments before and after an edit or a
 * delete can be compared: the people whose share moved are told (notify.ts). Admins and the fueler
 * themselves never owe, so they are not in it.
 */
export function shareSnapshot(db: Db, actor: Principal): ShareSnapshot {
  return fuelOverview(db, actor).items.flatMap((f) =>
    f.shares.filter((s) => s.owes).map((s) => ({ fuelId: f.id, userId: s.userId, cents: s.cents, dueCents: s.dueCents })),
  );
}

function mayManage(actor: Principal, fuel: Pick<FuelRow, 'user_id'>): boolean {
  return actor.role === 'admin' || actor.id === fuel.user_id;
}

function loadFuel(db: Db, id: number): FuelJoin {
  const row = one<FuelJoin>(db, 'SELECT f.*, u.display_name AS user_name FROM fuel f JOIN users u ON u.id = f.user_id WHERE f.id = ?', id);
  if (!row) throw new HttpError(404, 'not_found', 'Fill-up not found');
  return row;
}

/**
 * Whether a drive that ended at a given time belongs to a fill-up that payment requests were made
 * for. The fill-up that pays for it is the first one at or after that time (the same rule as the
 * periods in computeShares). Loads the fill-ups once, so a list of drives costs one query.
 */
export function requestedPeriods(db: Db): (endUtc: string) => boolean {
  const fuels = many<{ at_utc: string; requested: number }>(
    db,
    'SELECT f.at_utc, EXISTS (SELECT 1 FROM fuel_requests r WHERE r.fuel_id = f.id) AS requested FROM fuel f ORDER BY f.at_utc, f.id',
  );
  return (endUtc) => fuels.find((f) => f.at_utc >= endUtc)?.requested === 1;
}

/**
 * Everything the fuel view shows, computed from the current data. `gaps` are the open odometer gaps
 * (odometer.ts); they only fill the unaccountedKm note on the cards and change nothing else here.
 */
export function fuelOverview(db: Db, actor: Principal, gaps: OpenGap[] = []): { items: FuelDto[]; balances: BalanceDto[] } {
  const fuels = many<FuelJoin>(db, 'SELECT f.*, u.display_name AS user_name FROM fuel f JOIN users u ON u.id = f.user_id ORDER BY f.at_utc, f.id');
  // Admins do not pay for fuel: every user with the admin role, active or not, is left out of the split.
  // Payers are the active people who are not admins; a deactivated member with personal kilometres in the
  // period still pays for them (computeShares).
  const users = many<{ id: number; display_name: string; role: 'admin' | 'member'; active: number }>(db, 'SELECT id, display_name, role, active FROM users');
  const names = new Map(users.map((u) => [u.id, u.display_name]));
  const admins = new Set(users.filter((u) => u.role === 'admin').map((u) => u.id));
  const payerIds = users.filter((u) => u.active === 1 && u.role !== 'admin').map((u) => u.id);
  const drives = many<{ user_id: number; km_for: KmFor; km_user_id: number | null; end_utc: string; km: number }>(
    db,
    `SELECT user_id, km_for, km_user_id, end_utc, odometer_end - odometer_start AS km FROM usage
      WHERE status = 'completed' AND odometer_start IS NOT NULL AND odometer_end IS NOT NULL`,
  )
    .map((d) => ({
      // The kilometres count for their owner; the driver only matters for the registration, not for the money.
      userId: d.km_for === 'person' ? (d.km_user_id as number) : d.user_id,
      endUtc: d.end_utc,
      km: d.km,
      together: d.km_for === 'together',
    }))
    // An admin's own kilometres are left out; kilometres an admin drove for a member (or together) stay under that owner.
    .filter((d) => d.together || !admins.has(d.userId));
  const requests = many<FuelRequestRow>(db, 'SELECT * FROM fuel_requests');
  const requestOf = new Map(requests.map((r) => [`${r.fuel_id}:${r.debtor_id}`, r]));
  const shareOf = new Map(
    computeShares(fuels.map((f) => ({ id: f.id, atUtc: f.at_utc, totalCents: f.total_cents })), drives, payerIds).map((s) => [s.fuelId, s]),
  );
  // The live shares, plus everybody a request was made for who has no live share any more (their drive was
  // deleted or changed, or a fill-up moved the period): without them the request would vanish from the card.
  const listedOf = new Map<number, Allocation[]>(
    fuels.map((fuel) => {
      const calc = shareOf.get(fuel.id) as FuelShares;
      const live = new Set(calc.shares.map((s) => s.userId));
      const asked = requests.filter((r) => r.fuel_id === fuel.id && !live.has(r.debtor_id));
      return [fuel.id, [...calc.shares, ...asked.map((r) => ({ userId: r.debtor_id, km: 0, cents: 0 }))].sort((a, b) => a.userId - b.userId)];
    }),
  );
  const carry = carryOver(
    fuels.map((f) => ({ id: f.id, userId: f.user_id, atUtc: f.at_utc })),
    fuels.flatMap((f) => (listedOf.get(f.id) as Allocation[]).filter((s) => s.userId !== f.user_id).map((s) => ({ fuelId: f.id, debtorId: s.userId, cents: s.cents }))),
    requests.map((r) => ({ fuelId: r.fuel_id, debtorId: r.debtor_id, paid: r.paid_at !== null, coversFuelId: r.covers_fuel_id })),
  );
  const atOf = new Map(fuels.map((f) => [f.id, f.at_utc]));

  const items: FuelDto[] = fuels.map((fuel, index) => {
    const calc = shareOf.get(fuel.id) as FuelShares;
    const manage = mayManage(actor, fuel);
    const hasPaidRequests = requests.some((r) => r.fuel_id === fuel.id && r.paid_at !== null);
    const shares = (listedOf.get(fuel.id) as Allocation[]).map((s): FuelShareDto => {
      const row = requestOf.get(`${fuel.id}:${s.userId}`);
      // An admin owes nothing: no request, no push and no "I have paid" (a request made before this rule
      // stays visible on the fueler's card, where it can still be marked paid or unpaid).
      const owes = s.userId !== fuel.user_id && !admins.has(s.userId) && (s.cents > 0 || row !== undefined);
      const c = carry.get(carryKey(fuel.id, s.userId));
      const carried = c?.carriedCents ?? 0;
      const due = c?.dueCents ?? 0;
      const settled = c?.settledBy ?? null;
      // A request made before carry-over existed asked for the share alone.
      const currentCents = row?.covers_fuel_id === null ? s.cents : due;
      const request: FuelRequestDto | null = row
        ? {
            id: row.id,
            amountCents: row.amount_cents,
            provider: row.provider,
            message: row.message,
            link: row.link,
            createdAt: row.created_at,
            paidAt: row.paid_at,
            paidBy: row.paid_by,
            changed: row.amount_cents !== currentCents,
            currentCents,
          }
        : null;
      // Still to be paid: not paid itself and not settled by a later payment.
      const open = settled === null && request?.paidAt == null;
      return {
        userId: s.userId,
        userName: names.get(s.userId) ?? '?',
        km: s.km,
        cents: s.cents,
        owes,
        carriedCents: carried,
        dueCents: due,
        settledBy: settled ? { fuelId: settled.fuelId, at: atOf.get(settled.fuelId) as string } : null,
        request,
        can: {
          // Nothing to ask for when the live share is zero (only the request that was made is left to see and settle).
          request: manage && owes && s.cents > 0 && due > 0 && open,
          markPaid: manage && request !== null && settled === null,
          selfPaid: actor.id === s.userId && owes && open && (request !== null || due > 0),
        },
      };
    });
    const settledByLater = shares.some((s) => s.settledBy !== null);
    return {
      id: fuel.id,
      userId: fuel.user_id,
      userName: fuel.user_name,
      at: fuel.at_utc,
      millilitres: fuel.millilitres,
      totalCents: fuel.total_cents,
      pricePerLitreMillis: pricePerLitreMillis(fuel.total_cents, fuel.millilitres),
      odometer: fuel.odometer,
      note: fuel.note,
      createdBy: fuel.created_by,
      createdAt: fuel.created_at,
      updatedAt: fuel.updated_at,
      period: { from: calc.fromUtc, to: calc.toUtc },
      totalKm: calc.totalKm,
      // A gap belongs to the period that contains its later reading: the same (previous fill-up, this one] rule as the split.
      unaccountedKm: gaps.filter((g) => (calc.fromUtc === null || g.at > calc.fromUtc) && g.at <= calc.toUtc).reduce((n, g) => n + g.km, 0),
      togetherKm: calc.togetherKm,
      equalSplit: calc.equalSplit,
      firstInData: index === 0,
      shares,
      hasPaidRequests,
      settledByLater,
      can: { edit: manage && !hasPaidRequests && !settledByLater, delete: manage && !hasPaidRequests && !settledByLater },
      canOdometer: manage,
    };
  });

  return { items: [...items].reverse(), balances: balancesOf(items, names) };
}

/**
 * Who owes whom, netted per pair. A debt counts at the live share, so the balances always follow
 * the drives that really count (an unpaid request whose share changed is flagged on its card, and
 * counts at what is owed now, not at the amount that was asked). Nothing counts once it is paid or
 * settled by a later payment (fuel-carry.ts); a paid request whose amount changed afterwards is
 * flagged on its card with the difference. The carried amount is not added here: the earlier shares
 * it consists of are already counted, once, in their own fill-ups.
 */
function balancesOf(items: FuelDto[], names: Map<number, string>): BalanceDto[] {
  const owed = new Map<string, number>(); // "debtor>creditor" -> cents
  for (const fuel of items) {
    for (const share of fuel.shares) {
      if (!share.owes) continue;
      const cents = share.request?.paidAt || share.settledBy ? 0 : share.cents;
      if (cents === 0) continue;
      const key = `${share.userId}>${fuel.userId}`;
      owed.set(key, (owed.get(key) ?? 0) + cents);
    }
  }
  const out: BalanceDto[] = [];
  for (const [key, cents] of owed) {
    const [debtor = 0, creditor = 0] = key.split('>').map(Number);
    const back = owed.get(`${creditor}>${debtor}`) ?? 0;
    // Report each pair once, in the direction of the bigger debt.
    if (cents > back) {
      out.push({ fromUserId: debtor, fromName: names.get(debtor) ?? '?', toUserId: creditor, toName: names.get(creditor) ?? '?', cents: cents - back });
    }
  }
  return out.sort((a, b) => b.cents - a.cents || a.fromUserId - b.fromUserId || a.toUserId - b.toUserId);
}

// ------------------------------------------------------------------ routes

/** What a payment request for one share says; the amount is what is due (the share plus what is carried). */
function paymentInputOf(fuel: FuelDto, share: FuelShareDto, tz: string): PaymentInput {
  return {
    amountCents: share.dueCents,
    shareCents: share.cents,
    carriedCents: share.carriedCents,
    creditorName: fuel.userName,
    debtorName: share.userName,
    litres: formatLitres(fuel.millilitres),
    date: formatLocal(fuel.at, tz, 'day'),
    km: share.km,
    kmTotal: fuel.totalKm,
    togetherKm: fuel.togetherKm,
    equalSplit: fuel.equalSplit,
    reference: `fuel-${fuel.id}-${share.userId}`,
  };
}

export function registerFuelRoutes(router: Router, ctx: Ctx, notifier?: Notifier): void {
  const { db, config } = ctx;
  // Chosen once: without all three Tikkie settings nothing outbound is ever called.
  const provider: PaymentProvider = config.tikkie ? tikkieProvider(config.tikkie, ctx.fetch, ctx.log) : manualProvider;

  /** The fill-up as the actor sees it (404 when it is gone). */
  const view = (actor: Principal, id: number): FuelDto => {
    // gapsOrEmpty never throws: a failure of the odometer chain must not turn a saved fill-up into a 500.
    const dto = fuelOverview(db, actor, gapsOrEmpty(ctx)).items.find((f) => f.id === id);
    if (!dto) throw new HttpError(404, 'not_found', 'Fill-up not found');
    return dto;
  };

  /** The highest fill-up id there is: what a request made right now covers (ids are creation order). */
  const newestFuelId = (): number => one<{ id: number | null }>(db, 'SELECT MAX(id) AS id FROM fuel')?.id ?? 0;

  /**
   * Edit and delete: the fueler or an admin, and never once a payment for it is marked as paid, or a
   * later payment settled a share of it (mark that one unpaid first).
   */
  function guardChange(actor: Principal, fuel: Pick<FuelRow, 'id' | 'user_id'>, odometerOnly = false): void {
    if (!mayManage(actor, fuel)) throw new HttpError(403, 'forbidden', 'Only the person who fuelled or an admin can change a fill-up');
    // Correcting the odometer reading moves no money, so a payment that is marked as paid does not lock it.
    if (odometerOnly) return;
    const dto = fuelOverview(db, actor).items.find((f) => f.id === fuel.id);
    if (dto && (dto.hasPaidRequests || dto.settledByLater)) {
      throw new HttpError(409, 'has_paid_requests', 'A payment for this fill-up, or a later one that settled it, is marked as paid. Mark it unpaid first.');
    }
  }

  /** The time of a fill-up: not in the future (beyond clock slack) and inside the six-month window. */
  function checkAt(at: string, now: Date): void {
    assertPastInsideWindow(at, now, config.tz, config.windowMonths);
  }

  function checkFueler(userId: number): void {
    if (!one<{ id: number }>(db, 'SELECT id FROM users WHERE id = ? AND active = 1', userId)) throw new ValidationError({ userId: 'unknown_user' });
  }

  router.add('GET', '/api/fuel', 'user', (req) => {
    const actor = me(req);
    return ok({ ...fuelOverview(db, actor, gapsOrEmpty(ctx)), window: windowBounds(ctx.clock.now(), config.tz, config.windowMonths) });
  });

  router.add('POST', '/api/fuel', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const userId = f.int('userId', { optional: true, min: 1 }) ?? actor.id;
    const at = f.instant('at');
    const millilitres = f.int('millilitres', { min: 1, max: MAX_MILLILITRES });
    const totalCents = f.int('totalCents', { min: 1, max: MAX_TOTAL_CENTS });
    // The reading at the pump is required for a new fill-up (absent = 'required'); only fill-ups from before it existed have none.
    const odometer = f.int('odometer', { min: 0, max: MAX_ODOMETER });
    const note = f.string('note', { optional: true, max: 500 }) ?? '';
    f.done();
    if (userId !== actor.id && actor.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only an admin can record a fill-up for someone else');
    }
    const now = ctx.clock.now();
    const nowIso = now.toISOString();
    checkAt(at as string, now);
    const id = tx(db, () => {
      checkFueler(userId);
      return run(
        db,
        `INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, odometer, note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId,
        at as string,
        millilitres as number,
        totalCents as number,
        odometer as number,
        note,
        actor.id,
        nowIso,
        nowIso,
      ).lastInsertRowid;
    });
    const created = view(actor, id);
    // shares: how many people the cost was split over (0 when nobody pays, for example a household of admins).
    ctx.log({ event: 'fuel.created', id, by: actor.id, userId, shares: created.shares.length, equalSplit: created.equalSplit });
    // Everybody who owes money hears about it, and the fueler when somebody else registered it in their name.
    // Fire and forget: the fill-up is saved, so a slow or broken push service can neither delay nor fail this answer.
    notifier?.emit('fuel.created', () => ({ actor, fuel: created }));
    return ok({ fuel: created }, 201);
  });

  router.add('PATCH', '/api/fuel/:id', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const body = await req.json();
    const existing = loadFuel(db, id);
    // A body that only carries the odometer reading is a correction of that reading: no money moves, so
    // the paid-request lock does not apply (the fueler-or-admin check still does).
    const keys = Object.keys(body);
    const odometerOnly = keys.length === 1 && keys[0] === 'odometer';
    guardChange(actor, existing, odometerOnly);
    const f = new Fields(body);
    const userId = f.int('userId', { optional: true, min: 1 }) ?? existing.user_id;
    const at = f.instant('at', { optional: true });
    const millilitres = f.int('millilitres', { optional: true, min: 1, max: MAX_MILLILITRES }) ?? existing.millilitres;
    const totalCents = f.int('totalCents', { optional: true, min: 1, max: MAX_TOTAL_CENTS }) ?? existing.total_cents;
    // Absent keeps what is stored (also a legacy null); null is not a number, so the reading can be set or changed but never cleared.
    const odometer = f.int('odometer', { optional: true, min: 0, max: MAX_ODOMETER }) ?? existing.odometer;
    const note = f.string('note', { optional: true, max: 500 }) ?? existing.note;
    f.done();
    if (userId !== existing.user_id && actor.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only an admin can change who fuelled');
    }
    const now = ctx.clock.now();
    if (at !== undefined) checkAt(at, now);
    // What everybody owed before the change, to tell the people whose share it moves (taken before anything is written).
    const sharesBefore = notifier?.capture(() => shareSnapshot(db, actor));
    tx(db, () => {
      guardChange(actor, existing, odometerOnly);
      if (userId !== existing.user_id) {
        checkFueler(userId);
        // The money is owed to someone else now: requests addressed to the old fueler no longer make sense.
        run(db, 'DELETE FROM fuel_requests WHERE fuel_id = ?', id);
      }
      run(
        db,
        'UPDATE fuel SET user_id = ?, at_utc = ?, millilitres = ?, total_cents = ?, odometer = ?, note = ?, updated_at = ? WHERE id = ?',
        userId,
        at ?? existing.at_utc,
        millilitres,
        totalCents,
        odometer,
        note,
        now.toISOString(),
        id,
      );
    });
    // odometerOnly marks the one change that skips the paid-request lock, so it can be told apart in the log.
    ctx.log({ event: 'fuel.updated', id, by: actor.id, odometerOnly });
    const updated = view(actor, id);
    notifier?.emit('fuel.changed', () => ({
      actor,
      change: 'updated',
      before: headOfRow(existing),
      after: headOfDto(updated),
      sharesBefore,
      sharesAfter: shareSnapshot(db, actor),
    }));
    return ok({ fuel: updated });
  });

  router.add('DELETE', '/api/fuel/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const existing = loadFuel(db, id);
    guardChange(actor, existing);
    const sharesBefore = notifier?.capture(() => shareSnapshot(db, actor));
    run(db, 'DELETE FROM fuel WHERE id = ?', id);
    ctx.log({ event: 'fuel.deleted', id, by: actor.id });
    notifier?.emit('fuel.changed', () => ({
      actor,
      change: 'deleted',
      before: headOfRow(existing),
      after: null,
      sharesBefore,
      sharesAfter: shareSnapshot(db, actor),
    }));
    return noContent();
  });

  // Make (or redo) the payment request for one person's share. The provider call is the only
  // await; the write afterwards is one synchronous transaction.
  router.add('POST', '/api/fuel/:id/requests', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const f = new Fields(await req.json());
    const debtorId = f.int('debtorId', { min: 1 });
    const pasted = f.string('link', { optional: true, max: 500 }) || undefined;
    if (pasted !== undefined && !isHttpsLink(pasted)) f.fail('link', 'invalid_link');
    f.done();
    const fuel = view(actor, id);
    // Taken together with the view, with nothing awaited in between: a fill-up registered while the
    // provider answers has an id above this, so it is not covered by an amount that does not include it.
    const covers = newestFuelId();
    if (!mayManage(actor, { user_id: fuel.userId })) {
      throw new HttpError(403, 'forbidden', 'Only the person who fuelled or an admin can ask for the money');
    }
    const share = fuel.shares.find((s) => s.userId === debtorId);
    if (!share?.owes || share.cents === 0 || share.dueCents === 0) throw new ValidationError({ debtorId: 'nothing_owed' });
    if (share.request?.paidAt || share.settledBy) throw new HttpError(409, 'already_paid', 'That share is already marked as paid');

    const made = await provider.create(paymentInputOf(fuel, share, config.tz));
    const link = pasted ?? made.link ?? '';
    const message = withLink(made.message, link);
    const nowIso = ctx.clock.now().toISOString();
    const created = tx(db, () => {
      loadFuel(db, id);
      const current = one<FuelRequestRow>(db, 'SELECT * FROM fuel_requests WHERE fuel_id = ? AND debtor_id = ?', id, share.userId);
      if (current?.paid_at) throw new HttpError(409, 'already_paid', 'That share is already marked as paid');
      if (current) {
        run(
          db,
          'UPDATE fuel_requests SET amount_cents = ?, provider = ?, message = ?, link = ?, covers_fuel_id = ?, updated_at = ? WHERE id = ?',
          share.dueCents,
          made.provider,
          message,
          link,
          covers,
          nowIso,
          current.id,
        );
        return false;
      }
      run(
        db,
        `INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, link, covers_fuel_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        share.userId,
        share.dueCents,
        made.provider,
        message,
        link,
        covers,
        nowIso,
        nowIso,
      );
      return true;
    });
    ctx.log({ event: 'fuel.request', id, by: actor.id, debtorId: share.userId, provider: made.provider });
    return ok({ fuel: view(actor, id) }, created ? 201 : 200);
  });

  router.add('POST', '/api/fuel/:id/requests/:debtorId/paid', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const debtorId = idParam(req.params['debtorId']);
    const f = new Fields(await req.json());
    const paid = f.bool('paid');
    f.done();
    const fuel = loadFuel(db, id);
    // The person who is owed (or an admin) marks either way. The debtor may only say "I have paid"
    // for their own share: it is a self-report, and undoing one stays with the person who is owed.
    const manager = mayManage(actor, fuel);
    const selfPaid = actor.id === debtorId && paid === true;
    if (!manager && !selfPaid) throw new HttpError(403, 'forbidden', 'Only the person who is owed the money or an admin can change whether it is paid');
    const nowIso = ctx.clock.now().toISOString();
    // One transaction: the optional snapshot and the paid mark go in together or not at all. What the
    // payment settles of earlier fill-ups follows from this one flag (fuel-carry.ts), nothing else is written.
    const changed = tx(db, () => {
      let current = one<FuelRequestRow>(db, 'SELECT * FROM fuel_requests WHERE fuel_id = ? AND debtor_id = ?', id, debtorId);
      if (!current) {
        if (!selfPaid) throw new HttpError(404, 'not_found', 'There is no payment request for that person yet');
        // Paid without a request: record what is due now as a manual request nobody sent, so the lock and the snapshot behave as always.
        const dto = view(actor, id);
        const share = dto.shares.find((s) => s.userId === debtorId);
        if (!share?.owes || share.dueCents <= 0) throw new ValidationError({ debtorId: 'nothing_owed' });
        if (share.settledBy) throw new HttpError(409, 'already_paid', 'That share is already settled by a later payment');
        run(
          db,
          `INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, link, covers_fuel_id, created_at, updated_at)
           VALUES (?, ?, ?, 'manual', ?, '', ?, ?, ?)`,
          id,
          debtorId,
          share.dueCents,
          requestMessage(paymentInputOf(dto, share, config.tz)),
          newestFuelId(),
          nowIso,
          nowIso,
        );
        current = one<FuelRequestRow>(db, 'SELECT * FROM fuel_requests WHERE fuel_id = ? AND debtor_id = ?', id, debtorId) as FuelRequestRow;
      } else if (paid === true && current.paid_at === null) {
        // A share that a later payment already settled has no button on any card; the server says the same
        // (a stale page or a retry must not count the payment twice, and the later request would then be flagged as changed).
        const settledBy = view(actor, id).shares.find((s) => s.userId === debtorId)?.settledBy;
        if (settledBy) throw new HttpError(409, 'already_paid', 'That share is already settled by a later payment');
      }
      // Idempotent: asking for the state it is already in (a double tap, a retry) changes nothing,
      // so the person who first marked it keeps their name and time on it.
      if ((current.paid_at !== null) === (paid === true)) return false;
      run(
        db,
        'UPDATE fuel_requests SET paid_at = ?, paid_by = ?, updated_at = ? WHERE id = ?',
        paid ? nowIso : null,
        paid ? actor.id : null,
        nowIso,
        current.id,
      );
      return true;
    });
    if (changed) ctx.log({ event: paid ? 'fuel.paid' : 'fuel.unpaid', id, by: actor.id, debtorId });
    const dto = view(actor, id);
    // The debtor hears when the fueler or an admin marks their share, the fueler when the debtor says "I have paid".
    // Only a real change: a double tap or a retry changed nothing and says nothing.
    if (changed) {
      notifier?.emit('fuel.paid', () => {
        const share = dto.shares.find((s) => s.userId === debtorId);
        if (!share) throw new Error('the share is not on the fill-up');
        return { actor, fuel: headOfDto(dto), debtor: { id: debtorId, name: share.userName }, paid: paid === true, amountCents: share.request?.amountCents ?? share.dueCents };
      });
    }
    return ok({ fuel: dto });
  });
}
