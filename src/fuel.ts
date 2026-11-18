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
import { many, one, run, tx, type Db, type FuelRequestRow, type FuelRow } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import { isHttpsLink, manualProvider, tikkieProvider, type PaymentProvider } from './payments.ts';
import { Fields, ValidationError, windowBounds } from './validate.ts';
import { formatLocal } from '../shared/time.js';

const FUTURE_SLACK_MS = 5 * 60_000;
export const MAX_MILLILITRES = 200_000;
export const MAX_TOTAL_CENTS = 1_000_000;

// ------------------------------------------------------------- pure maths

export interface ShareFuel {
  id: number;
  atUtc: string;
  totalCents: number;
}

export interface ShareDrive {
  userId: number;
  /** When the drive ended; decides which fill-up period it belongs to. */
  endUtc: string;
  km: number;
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
  totalKm: number;
  /** Nobody drove in the period, so the cost is split equally over the active users. */
  equalSplit: boolean;
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

/** The share of every fill-up per driver. Pure: the caller loads the data, this decides. */
export function computeShares(fuels: ShareFuel[], drives: ShareDrive[], activeUserIds: number[]): FuelShares[] {
  const sorted = [...fuels].sort((a, b) => (a.atUtc < b.atUtc ? -1 : a.atUtc > b.atUtc ? 1 : a.id - b.id));
  const active = [...new Set(activeUserIds)].sort((a, b) => a - b);
  return sorted.map((fuel, i) => {
    const fromUtc = i === 0 ? null : (sorted[i - 1] as ShareFuel).atUtc;
    const kmBy = new Map<number, number>();
    for (const d of drives) {
      if ((fromUtc === null || d.endUtc > fromUtc) && d.endUtc <= fuel.atUtc) kmBy.set(d.userId, (kmBy.get(d.userId) ?? 0) + d.km);
    }
    const drivers = [...kmBy].filter(([, km]) => km > 0).sort((a, b) => a[0] - b[0]);
    const totalKm = drivers.reduce((n, [, km]) => n + km, 0);
    const equalSplit = totalKm === 0;
    const weights = equalSplit ? active.map((userId) => ({ userId, weight: 1 })) : drivers.map(([userId, km]) => ({ userId, weight: km }));
    const shares = splitCents(fuel.totalCents, weights).map((s) => ({ userId: s.userId, km: kmBy.get(s.userId) ?? 0, cents: s.cents }));
    return { fuelId: fuel.id, fromUtc, toUtc: fuel.atUtc, totalKm, equalSplit, shares };
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
}

export interface FuelShareDto {
  userId: number;
  userName: string;
  km: number;
  cents: number;
  /** Owes the fueler: not the fueler themselves, and either more than zero or a request was made for them. */
  owes: boolean;
  request: FuelRequestDto | null;
  can: { request: boolean; markPaid: boolean };
}

export interface FuelDto {
  id: number;
  userId: number;
  userName: string;
  at: string;
  millilitres: number;
  totalCents: number;
  pricePerLitreMillis: number;
  note: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  period: { from: string | null; to: string };
  totalKm: number;
  equalSplit: boolean;
  /** The first fill-up in the data: it also pays for every drive before it. */
  firstInData: boolean;
  shares: FuelShareDto[];
  hasPaidRequests: boolean;
  can: { edit: boolean; delete: boolean };
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

/** Everything the fuel view shows, computed from the current data. */
export function fuelOverview(db: Db, actor: Principal): { items: FuelDto[]; balances: BalanceDto[] } {
  const fuels = many<FuelJoin>(db, 'SELECT f.*, u.display_name AS user_name FROM fuel f JOIN users u ON u.id = f.user_id ORDER BY f.at_utc, f.id');
  const drives = many<{ user_id: number; end_utc: string; km: number }>(
    db,
    `SELECT user_id, end_utc, odometer_end - odometer_start AS km FROM usage
      WHERE status = 'completed' AND odometer_start IS NOT NULL AND odometer_end IS NOT NULL`,
  ).map((d) => ({ userId: d.user_id, endUtc: d.end_utc, km: d.km }));
  const activeIds = many<{ id: number }>(db, 'SELECT id FROM users WHERE active = 1').map((u) => u.id);
  const names = new Map(many<{ id: number; display_name: string }>(db, 'SELECT id, display_name FROM users').map((u) => [u.id, u.display_name]));
  const requests = many<FuelRequestRow>(db, 'SELECT * FROM fuel_requests');
  const requestOf = new Map(requests.map((r) => [`${r.fuel_id}:${r.debtor_id}`, r]));
  const shareOf = new Map(
    computeShares(fuels.map((f) => ({ id: f.id, atUtc: f.at_utc, totalCents: f.total_cents })), drives, activeIds).map((s) => [s.fuelId, s]),
  );

  const items: FuelDto[] = fuels.map((fuel, index) => {
    const calc = shareOf.get(fuel.id) as FuelShares;
    const manage = mayManage(actor, fuel);
    const asked = requests.filter((r) => r.fuel_id === fuel.id);
    const hasPaidRequests = asked.some((r) => r.paid_at !== null);
    // The live shares, plus everybody a request was made for who has no live share any more (their drive was
    // deleted or changed, or a fill-up moved the period): without them the request would vanish from the card.
    const live = new Set(calc.shares.map((s) => s.userId));
    const listed: Allocation[] = [...calc.shares, ...asked.filter((r) => !live.has(r.debtor_id)).map((r) => ({ userId: r.debtor_id, km: 0, cents: 0 }))].sort(
      (a, b) => a.userId - b.userId,
    );
    const shares = listed.map((s): FuelShareDto => {
      const row = requestOf.get(`${fuel.id}:${s.userId}`);
      const owes = s.userId !== fuel.user_id && (s.cents > 0 || row !== undefined);
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
            changed: row.amount_cents !== s.cents,
          }
        : null;
      return {
        userId: s.userId,
        userName: names.get(s.userId) ?? '?',
        km: s.km,
        cents: s.cents,
        owes,
        request,
        // Nothing to ask for when the live share is zero (only the request that was made is left to see and settle).
        can: { request: manage && owes && s.cents > 0 && request?.paidAt == null, markPaid: manage && request !== null },
      };
    });
    return {
      id: fuel.id,
      userId: fuel.user_id,
      userName: fuel.user_name,
      at: fuel.at_utc,
      millilitres: fuel.millilitres,
      totalCents: fuel.total_cents,
      pricePerLitreMillis: pricePerLitreMillis(fuel.total_cents, fuel.millilitres),
      note: fuel.note,
      createdBy: fuel.created_by,
      createdAt: fuel.created_at,
      updatedAt: fuel.updated_at,
      period: { from: calc.fromUtc, to: calc.toUtc },
      totalKm: calc.totalKm,
      equalSplit: calc.equalSplit,
      firstInData: index === 0,
      shares,
      hasPaidRequests,
      can: { edit: manage && !hasPaidRequests, delete: manage && !hasPaidRequests },
    };
  });

  return { items: [...items].reverse(), balances: balancesOf(items, names) };
}

/**
 * Who owes whom, netted per pair. A debt counts at the live share, so the balances always follow
 * the drives that really count (an unpaid request whose share changed is flagged on its card, and
 * counts at what is owed now, not at the amount that was asked). Nothing counts once it is paid;
 * a paid request whose share changed afterwards is flagged on its card with the difference.
 */
function balancesOf(items: FuelDto[], names: Map<number, string>): BalanceDto[] {
  const owed = new Map<string, number>(); // "debtor>creditor" -> cents
  for (const fuel of items) {
    for (const share of fuel.shares) {
      if (!share.owes) continue;
      const cents = share.request?.paidAt ? 0 : share.cents;
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

// ------------------------------------------------------------------- input

function litresText(millilitres: number): string {
  return (millilitres / 1000).toFixed(2);
}

// ------------------------------------------------------------------ routes

export function registerFuelRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;
  // Chosen once: without all three Tikkie settings nothing outbound is ever called.
  const provider: PaymentProvider = config.tikkie ? tikkieProvider(config.tikkie, ctx.fetch, ctx.log) : manualProvider;

  /** The fill-up as the actor sees it (404 when it is gone). */
  const view = (actor: Principal, id: number): FuelDto => {
    const dto = fuelOverview(db, actor).items.find((f) => f.id === id);
    if (!dto) throw new HttpError(404, 'not_found', 'Fill-up not found');
    return dto;
  };

  /** Edit and delete: the fueler or an admin, and never once a payment for it is marked as paid. */
  function guardChange(actor: Principal, fuel: Pick<FuelRow, 'id' | 'user_id'>): void {
    if (!mayManage(actor, fuel)) throw new HttpError(403, 'forbidden', 'Only the person who fuelled or an admin can change a fill-up');
    const paid = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM fuel_requests WHERE fuel_id = ? AND paid_at IS NOT NULL', fuel.id)?.n ?? 0;
    if (paid > 0) throw new HttpError(409, 'has_paid_requests', 'A payment for this fill-up is marked as paid. Mark it unpaid first.');
  }

  /** The time of a fill-up: not in the future (beyond clock slack) and inside the six-month window. */
  function checkAt(at: string, now: Date): void {
    if (Date.parse(at) > now.getTime() + FUTURE_SLACK_MS) throw new ValidationError({ at: 'in_future' });
    const bounds = windowBounds(now, config.tz, config.windowMonths);
    if (at < bounds.from || at > bounds.to) throw new ValidationError({ at: 'outside_window' }, 'outside_window');
  }

  function checkFueler(userId: number): void {
    if (!one<{ id: number }>(db, 'SELECT id FROM users WHERE id = ? AND active = 1', userId)) throw new ValidationError({ userId: 'unknown_user' });
  }

  router.add('GET', '/api/fuel', 'user', (req) => {
    const actor = me(req);
    return ok({ ...fuelOverview(db, actor), window: windowBounds(ctx.clock.now(), config.tz, config.windowMonths) });
  });

  router.add('POST', '/api/fuel', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const userId = f.int('userId', { optional: true, min: 1 }) ?? actor.id;
    const at = f.instant('at');
    const millilitres = f.int('millilitres', { min: 1, max: MAX_MILLILITRES });
    const totalCents = f.int('totalCents', { min: 1, max: MAX_TOTAL_CENTS });
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
        `INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        userId,
        at as string,
        millilitres as number,
        totalCents as number,
        note,
        actor.id,
        nowIso,
        nowIso,
      ).lastInsertRowid;
    });
    ctx.log({ event: 'fuel.created', id, by: actor.id, userId });
    return ok({ fuel: view(actor, id) }, 201);
  });

  router.add('PATCH', '/api/fuel/:id', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const body = await req.json();
    const existing = loadFuel(db, id);
    guardChange(actor, existing);
    const f = new Fields(body);
    const userId = f.int('userId', { optional: true, min: 1 }) ?? existing.user_id;
    const at = f.instant('at', { optional: true });
    const millilitres = f.int('millilitres', { optional: true, min: 1, max: MAX_MILLILITRES }) ?? existing.millilitres;
    const totalCents = f.int('totalCents', { optional: true, min: 1, max: MAX_TOTAL_CENTS }) ?? existing.total_cents;
    const note = f.string('note', { optional: true, max: 500 }) ?? existing.note;
    f.done();
    if (userId !== existing.user_id && actor.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Only an admin can change who fuelled');
    }
    const now = ctx.clock.now();
    if (at !== undefined) checkAt(at, now);
    tx(db, () => {
      guardChange(actor, existing);
      if (userId !== existing.user_id) {
        checkFueler(userId);
        // The money is owed to someone else now: requests addressed to the old fueler no longer make sense.
        run(db, 'DELETE FROM fuel_requests WHERE fuel_id = ?', id);
      }
      run(
        db,
        'UPDATE fuel SET user_id = ?, at_utc = ?, millilitres = ?, total_cents = ?, note = ?, updated_at = ? WHERE id = ?',
        userId,
        at ?? existing.at_utc,
        millilitres,
        totalCents,
        note,
        now.toISOString(),
        id,
      );
    });
    ctx.log({ event: 'fuel.updated', id, by: actor.id });
    return ok({ fuel: view(actor, id) });
  });

  router.add('DELETE', '/api/fuel/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const existing = loadFuel(db, id);
    guardChange(actor, existing);
    run(db, 'DELETE FROM fuel WHERE id = ?', id);
    ctx.log({ event: 'fuel.deleted', id, by: actor.id });
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
    if (!mayManage(actor, { user_id: fuel.userId })) {
      throw new HttpError(403, 'forbidden', 'Only the person who fuelled or an admin can ask for the money');
    }
    const share = fuel.shares.find((s) => s.userId === debtorId);
    if (!share?.owes || share.cents === 0) throw new ValidationError({ debtorId: 'nothing_owed' });
    if (share.request?.paidAt) throw new HttpError(409, 'already_paid', 'That share is already marked as paid');

    const made = await provider.create({
      amountCents: share.cents,
      creditorName: fuel.userName,
      debtorName: share.userName,
      litres: litresText(fuel.millilitres),
      date: formatLocal(fuel.at, config.tz, 'day'),
      km: share.km,
      kmTotal: fuel.totalKm,
      equalSplit: fuel.equalSplit,
      reference: `fuel-${fuel.id}-${share.userId}`,
    });
    const link = pasted ?? made.link ?? '';
    const message = link ? `${made.message} Pay here: ${link}` : made.message;
    const nowIso = ctx.clock.now().toISOString();
    const created = tx(db, () => {
      loadFuel(db, id);
      const current = one<FuelRequestRow>(db, 'SELECT * FROM fuel_requests WHERE fuel_id = ? AND debtor_id = ?', id, share.userId);
      if (current?.paid_at) throw new HttpError(409, 'already_paid', 'That share is already marked as paid');
      if (current) {
        run(
          db,
          'UPDATE fuel_requests SET amount_cents = ?, provider = ?, message = ?, link = ?, updated_at = ? WHERE id = ?',
          share.cents,
          made.provider,
          message,
          link,
          nowIso,
          current.id,
        );
        return false;
      }
      run(
        db,
        `INSERT INTO fuel_requests (fuel_id, debtor_id, amount_cents, provider, message, link, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        share.userId,
        share.cents,
        made.provider,
        message,
        link,
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
    if (!mayManage(actor, fuel)) throw new HttpError(403, 'forbidden', 'Only the person who is owed the money or an admin can mark it as paid');
    const current = one<FuelRequestRow>(db, 'SELECT * FROM fuel_requests WHERE fuel_id = ? AND debtor_id = ?', id, debtorId);
    if (!current) throw new HttpError(404, 'not_found', 'There is no payment request for that person yet');
    // Idempotent: asking for the state it is already in (a double tap, a retry) changes nothing,
    // so the person who first marked it keeps their name and time on it.
    if ((current.paid_at !== null) !== (paid === true)) {
      const nowIso = ctx.clock.now().toISOString();
      run(
        db,
        'UPDATE fuel_requests SET paid_at = ?, paid_by = ?, updated_at = ? WHERE id = ?',
        paid ? nowIso : null,
        paid ? actor.id : null,
        nowIso,
        current.id,
      );
      ctx.log({ event: paid ? 'fuel.paid' : 'fuel.unpaid', id, by: actor.id, debtorId });
    }
    return ok({ fuel: view(actor, id) });
  });
}
