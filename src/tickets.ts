// Traffic tickets: a member records a ticket with the time of the offence and, if they know them,
// the price and the reason. Who was driving at that moment is NOT stored: whoDrove() works it out
// from the drive log and the reservations on every read, so correcting a drive or a reservation
// corrects the ticket with it, and there is no second source of truth to keep in step.
//
// Who was driving, first hit wins:
//   1. drive      a completed drive that covers the moment (start and end inclusive). The driver is the
//                 person who drove (usage.user_id), never whose kilometres they are (km_for): driving
//                 someone else's kilometres, or together, is still driving. Readings are not needed.
//   2. draft      an open draft (a drive that was started and not finished) that began at or before the
//                 moment, no more than 24 hours earlier, with no completed drive started in between
//                 (that one would be the later record of the car's use). Drafts have no end time, so
//                 this is the best answer there is for a drive still in progress.
//   3. reservation  a confirmed reservation that covers the moment. Suggestions that are pending,
//                 declined or expired never count: nobody agreed to them.
//   4. none       nobody is on record.
// When two records of the same kind cover the moment (back-to-back drives share their boundary
// instant) the one that started later wins. A deactivated driver is still named.
import { many, one, run, type Db, type TicketRow } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import { Fields, assertPastInsideWindow } from './validate.ts';

/** The most a ticket can cost, in cents (10,000.00 EUR): the same cap as a fill-up. */
export const MAX_AMOUNT_CENTS = 1_000_000;
export const REASON_MAX = 500;
const DRAFT_LOOKBACK_MS = 24 * 3_600_000;

export type TicketBasis = 'drive' | 'draft' | 'reservation' | 'none';

interface Driver {
  id: number;
  name: string;
}

export interface TicketDto {
  id: number;
  /** The moment of the offence (not the date of the letter). */
  at: string;
  /** Cents; null when the price is not known. */
  amountCents: number | null;
  /** '' when there is none. */
  reason: string;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  /** Who was driving at `at`, derived now; null when nobody is on record. */
  driver: Driver | null;
  basis: TicketBasis;
  can: { edit: boolean; delete: boolean };
}

interface TicketJoin extends TicketRow {
  created_by_name: string;
}

/** Edit and delete: whoever entered the ticket, or an admin. */
function mayManage(actor: Principal, ticket: Pick<TicketRow, 'created_by'>): boolean {
  return actor.role === 'admin' || actor.id === ticket.created_by;
}

/**
 * Who was driving at `atUtc`, and what that is based on (see the top of this file for the rules).
 * Three small indexed queries, run in order; users are joined without an active filter.
 */
export function whoDrove(db: Db, atUtc: string): { driver: Driver | null; basis: TicketBasis } {
  const drive = one<Driver>(
    db,
    `SELECT u.id AS id, u.display_name AS name
       FROM usage g JOIN users u ON u.id = g.user_id
      WHERE g.status = 'completed' AND g.start_utc <= ? AND g.end_utc >= ?
      ORDER BY g.start_utc DESC, g.id DESC LIMIT 1`,
    atUtc,
    atUtc,
  );
  if (drive) return { driver: drive, basis: 'drive' };

  const earliestDraft = new Date(Date.parse(atUtc) - DRAFT_LOOKBACK_MS).toISOString();
  const draft = one<Driver>(
    db,
    `SELECT u.id AS id, u.display_name AS name
       FROM usage d JOIN users u ON u.id = d.user_id
      WHERE d.status = 'draft' AND d.start_utc <= ? AND d.start_utc >= ?
        AND NOT EXISTS (
          SELECT 1 FROM usage c
           WHERE c.status = 'completed' AND c.start_utc > d.start_utc AND c.start_utc <= ?)
      ORDER BY d.start_utc DESC, d.id DESC LIMIT 1`,
    atUtc,
    earliestDraft,
    atUtc,
  );
  if (draft) return { driver: draft, basis: 'draft' };

  const reservation = one<Driver>(
    db,
    `SELECT u.id AS id, u.display_name AS name
       FROM reservations r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'confirmed' AND r.start_utc <= ? AND r.end_utc >= ?
      ORDER BY r.start_utc DESC, r.id DESC LIMIT 1`,
    atUtc,
    atUtc,
  );
  if (reservation) return { driver: reservation, basis: 'reservation' };

  return { driver: null, basis: 'none' };
}

const SELECT_TICKET = 'SELECT t.*, u.display_name AS created_by_name FROM tickets t JOIN users u ON u.id = t.created_by';

function toDto(db: Db, row: TicketJoin, actor: Principal): TicketDto {
  const { driver, basis } = whoDrove(db, row.at_utc);
  const manage = mayManage(actor, row);
  return {
    id: row.id,
    at: row.at_utc,
    amountCents: row.amount_cents,
    reason: row.reason,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    driver,
    basis,
    can: { edit: manage, delete: manage },
  };
}

function loadTicket(db: Db, id: number): TicketJoin {
  const row = one<TicketJoin>(db, `${SELECT_TICKET} WHERE t.id = ?`, id);
  if (!row) throw new HttpError(404, 'not_found', 'Ticket not found');
  return row;
}

export function registerTicketRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;

  const view = (actor: Principal, id: number): TicketDto => toDto(db, loadTicket(db, id), actor);

  // Every signed-in member sees every ticket, like drives and fill-ups. There is no cap: the
  // six-month purge keeps the list small, and each ticket costs three indexed lookups.
  router.add('GET', '/api/tickets', 'user', (req) => {
    const actor = me(req);
    const rows = many<TicketJoin>(db, `${SELECT_TICKET} ORDER BY t.at_utc DESC, t.id DESC`);
    return ok({ items: rows.map((row) => toDto(db, row, actor)) });
  });

  router.add('POST', '/api/tickets', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const at = f.instant('at');
    const amountCents = f.nullableInt('amountCents', { min: 1, max: MAX_AMOUNT_CENTS });
    const reason = f.string('reason', { optional: true, max: REASON_MAX }) ?? '';
    f.done();
    const now = ctx.clock.now();
    assertPastInsideWindow(at as string, now, config.tz, config.windowMonths);
    const nowIso = now.toISOString();
    const id = run(
      db,
      'INSERT INTO tickets (at_utc, amount_cents, reason, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      at as string,
      amountCents ?? null,
      reason,
      actor.id,
      nowIso,
      nowIso,
    ).lastInsertRowid;
    const created = view(actor, id);
    // Never the reason or the price: a log line is not the place for them.
    ctx.log({ event: 'ticket.created', id, by: actor.id, basis: created.basis });
    return ok({ ticket: created }, 201);
  });

  router.add('PATCH', '/api/tickets/:id', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const body = await req.json();
    const existing = loadTicket(db, id);
    // Authorize before looking at the body: someone else's ticket is a 403 whatever they sent.
    if (!mayManage(actor, existing)) throw new HttpError(403, 'forbidden', 'Only the person who entered a ticket or an admin can change it');
    const f = new Fields(body);
    // Absent keeps the stored time. null is not an instant, so it is a 422 like any other bad value:
    // the time of the offence can be corrected but never wiped.
    const at = f.instant('at', { optional: true });
    // undefined keeps what is stored, null clears the price, '' clears the reason.
    const amountCents = f.nullableInt('amountCents', { min: 1, max: MAX_AMOUNT_CENTS });
    const reason = f.string('reason', { optional: true, max: REASON_MAX });
    f.done();
    const now = ctx.clock.now();
    // Only a time that is being changed is checked: a ticket that has aged toward the edge of the
    // window must still be able to get its price or reason corrected.
    if (at !== undefined && at !== existing.at_utc) assertPastInsideWindow(at, now, config.tz, config.windowMonths);
    run(
      db,
      'UPDATE tickets SET at_utc = ?, amount_cents = ?, reason = ?, updated_at = ? WHERE id = ?',
      at ?? existing.at_utc,
      amountCents === undefined ? existing.amount_cents : amountCents,
      reason ?? existing.reason,
      now.toISOString(),
      id,
    );
    const updated = view(actor, id);
    ctx.log({ event: 'ticket.updated', id, by: actor.id, basis: updated.basis });
    return ok({ ticket: updated });
  });

  router.add('DELETE', '/api/tickets/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const existing = loadTicket(db, id);
    if (!mayManage(actor, existing)) throw new HttpError(403, 'forbidden', 'Only the person who entered a ticket or an admin can delete it');
    const { basis } = whoDrove(db, existing.at_utc);
    run(db, 'DELETE FROM tickets WHERE id = ?', id);
    ctx.log({ event: 'ticket.deleted', id, by: actor.id, basis });
    return noContent();
  });
}
