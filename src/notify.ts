// The one place that decides who gets a push notification when somebody else enters, changes or
// removes something that is theirs. It replaces the fill-up notifier that used to be on its own
// (fuel-notify.ts) and is built the same way.
//
// The rule, for every event in the table below: when person A creates, changes or deletes something
// whose owner or subject is person B, B hears about it. A never does, whoever else is on the audience:
// the notifier drops the actor, so no event can forget to. The same goes for people who are
// deactivated, for people without a device signed up for notifications, and for everybody when push
// is switched off. What it does NOT do: change who is allowed to do what (the routes keep their own
// rules and call the notifier only after a change has been saved), or ask anybody for a preference.
//
// How a notification gets out:
//   1. A route saves its change and calls notifier.emit(kind, () => payload) just before it answers.
//      The payload is built at once, from rows the route already has (plain facts and snapshots).
//   2. The notifier does everything else after the response has been written (setImmediate): it
//      asks the event's table row who is told, drops the actor and the inactive, looks up the devices,
//      composes the text (notify-texts.ts, the only file with words in it) and sends one push per device.
//   3. It never throws into the request and never delays it: a failure, in the table row, the
//      text, the database or the push service, is logged by the name of the error (never an endpoint,
//      key, note, price or reason) and dropped. App.idle() and close() wait for the sends in flight.
//
// Adding an event (the damage report that goes to everybody is the next one): add its payload to
// `Events`, add one row to EVENTS (who is told, the text, where a tap goes, the tag), call emit from
// the route. Nothing in the engine below changes: a broadcast row is `who: (e, dir) => dir.activeUserIds()
// .map((userId) => ({ userId }))`. test/notify.test.ts plugs a made-up broadcast event in this way.
//
// Tags: one per record (reservation-7, usage-12, fuel-3, ticket-5), so a later change to the same
// record replaces the notification still on the phone instead of piling up beside it (the service
// worker re-alerts on a replacement). The one exception is the fueler being told that a debtor paid:
// that tag names the debtor too, because two debtors paying one fill-up are two different messages.
import { many, type PushSubscriptionRow } from './db.ts';
import type { Ctx } from './http.ts';
import type { PushMessage, PushService } from './push.ts';
import * as T from './notify-texts.ts';
import { localDateKey } from '../shared/time.js';

// ------------------------------------------------------------------ the payloads

/** Who did it. A route passes its Principal, which has these two fields. */
export interface Actor {
  id: number;
  displayName: string;
}

export interface ReservationSnap {
  id: number;
  /** The person the reservation is for. */
  userId: number;
  userName: string;
  /** The person who made it: somebody else than userId for a suggestion. */
  createdBy: number;
  createdByName: string;
  /** 'expired' is a pending suggestion whose start has passed: nobody can answer it any more. */
  status: 'confirmed' | 'pending' | 'declined' | 'expired';
  start: string;
  end: string;
  note: string;
}

export interface UsageSnap {
  id: number;
  driverId: number;
  driverName: string;
  status: 'draft' | 'completed';
  start: string;
  km: number | null;
  kmFor: 'self' | 'person' | 'together';
  kmUserId: number | null;
  note: string;
  /** The reservation the drive is linked to, and whose it is. */
  reservationId: number | null;
  reservationOwnerId: number | null;
  reservationStart: string | null;
}

/** Enough of a fill-up to name it in a message. */
export interface FuelHead {
  id: number;
  /** The fueler. */
  userId: number;
  userName: string;
  at: string;
  totalCents: number;
}

/** Every share somebody owes, per fill-up: what the fuel view shows, flattened so two moments can be compared. */
export type ShareSnapshot = Array<{ fuelId: number; userId: number; cents: number; dueCents: number }>;

export interface Person {
  id: number;
  name: string;
}

export type Events = {
  /** A suggestion was made for somebody else. */
  'reservation.suggested': { actor: Actor; reservation: ReservationSnap };
  /** The person a suggestion was made for approved or declined it. */
  'reservation.answered': { actor: Actor; reservation: ReservationSnap; decision: 'approved' | 'declined' };
  'reservation.changed': { actor: Actor; before: ReservationSnap; after: ReservationSnap };
  /** Cancelled, or withdrawn when it was a suggestion. `reservation` is what it was. */
  'reservation.deleted': { actor: Actor; reservation: ReservationSnap };
  /** A drive was logged, changed or deleted: `before` is null for a new one, `after` for a deleted one. */
  'usage.changed': { actor: Actor; change: 'created' | 'updated' | 'deleted'; before: UsageSnap | null; after: UsageSnap | null };
  /** A new fill-up: the people who owe money, and the fueler when somebody else registered it. */
  'fuel.created': {
    actor: Actor;
    fuel: FuelHead & { shares: Array<{ userId: number; owes: boolean; cents: number; carriedCents: number; dueCents: number }> };
  };
  /**
   * A fill-up was edited or deleted. The share snapshots are from before and after the change; without
   * both of them only the fueler can be told (nothing is known about the debtors).
   */
  'fuel.changed': {
    actor: Actor;
    change: 'updated' | 'deleted';
    before: FuelHead;
    after: FuelHead | null;
    sharesBefore: ShareSnapshot | undefined;
    sharesAfter: ShareSnapshot | undefined;
  };
  /** A share was marked paid or unpaid, by the debtor (paid only) or by the fueler or an admin. */
  'fuel.paid': { actor: Actor; fuel: FuelHead; debtor: Person; paid: boolean; amountCents: number };
  /** A ticket was entered, changed or deleted; the drivers are who the app derived before and after the change. */
  'ticket.changed': {
    actor: Actor;
    change: 'created' | 'updated' | 'deleted';
    ticket: { id: number; at: string; atBefore: string };
    driverBefore: Person | null;
    driverAfter: Person | null;
  };
};

// ------------------------------------------------------------------- the table

/** Who is on the other end of an audience entry: at least the person. A table row adds what its text needs. */
export interface Audience {
  userId: number;
}

/** What a table row may ask about the household. */
export interface Directory {
  /** An active person. A deactivated person is never told. */
  isActive(userId: number): boolean;
  /** Everybody active, for an event that goes to all (the actor is dropped by the notifier, not here). */
  activeUserIds(): number[];
}

export interface TextEnv {
  tz: string;
}

/** One row of the event table. Method syntax on purpose: a row for one event is accepted where any row is. */
export interface EventSpec<E, A extends Audience = Audience> {
  /** Who is told. May list the actor, the inactive and the same person twice: the first entry per person wins. */
  who(event: E, dir: Directory): A[];
  text(event: E, audience: A, env: TextEnv): T.Text;
  /** Where a tap opens: a hash route of the app, for example "/#/inbox". */
  link(event: E, audience: A, env: TextEnv): string;
  /** Notifications with the same tag replace each other on the phone. At most 64 characters. */
  tag(event: E, audience: A): string;
}

export type EventMap = Record<string, { actor: Actor }>;
export type EventTable<M extends EventMap> = { [K in keyof M]: EventSpec<M[K]> };

/** Keeps the types of one row (event and audience) together; the table itself only needs the general shape. */
export const row = <E, A extends Audience>(spec: EventSpec<E, A>): EventSpec<E, A> => spec;

/** The agenda on the day of a reservation (the Agenda tab reads the view and day from the hash). */
const agendaDay = (instant: string, env: TextEnv): string => `/#/?view=day&date=${localDateKey(instant, env.tz)}`;

const sameTimes = (a: { start: string; end: string }, b: { start: string; end: string }): boolean => a.start === b.start && a.end === b.end;

/** First entry per person wins, in the order given. */
function firstPerUser<A extends Audience>(entries: A[]): Map<number, A> {
  const out = new Map<number, A>();
  for (const entry of entries) if (!out.has(entry.userId)) out.set(entry.userId, entry);
  return out;
}

// ---- reservations

type ReservationAudience = Audience & { audience: T.ReservationAudience };

/** Who a reservation (as it was or is) concerns: its owner when confirmed, the person it is for and the one who suggested it while pending. */
function reservationAudience(r: ReservationSnap): ReservationAudience[] {
  if (r.status === 'confirmed') return [{ userId: r.userId, audience: 'owner' }];
  if (r.status === 'pending') {
    const out: ReservationAudience[] = [{ userId: r.userId, audience: 'target' }];
    if (r.createdBy !== r.userId) out.push({ userId: r.createdBy, audience: 'suggester' });
    return out;
  }
  // Declined and expired suggestions are over: nobody has anything left to do about them.
  return [];
}

const reservationSuggested = row<Events['reservation.suggested'], Audience>({
  who: (e) => (e.reservation.status === 'pending' && e.reservation.createdBy !== e.reservation.userId ? [{ userId: e.reservation.userId }] : []),
  text: (e, _a, env) => T.reservationSuggested({ actor: e.actor.displayName, start: e.reservation.start, end: e.reservation.end, tz: env.tz }),
  link: () => '/#/inbox',
  tag: (e) => `reservation-${e.reservation.id}`,
});

const reservationAnswered = row<Events['reservation.answered'], Audience>({
  // To the suggester. The person who answers is the one it was made for, so never the suggester.
  who: (e) => (e.reservation.createdBy !== e.reservation.userId ? [{ userId: e.reservation.createdBy }] : []),
  text: (e, _a, env) => T.reservationAnswered({ actor: e.actor.displayName, decision: e.decision, start: e.reservation.start, end: e.reservation.end, tz: env.tz }),
  link: (e, _a, env) => (e.decision === 'approved' ? agendaDay(e.reservation.start, env) : '/#/inbox'),
  tag: (e) => `reservation-${e.reservation.id}`,
});

const reservationChanged = row<Events['reservation.changed'], ReservationAudience>({
  who: (e) => (sameTimes(e.before, e.after) && e.before.note === e.after.note ? [] : reservationAudience(e.after)),
  text: (e, a, env) =>
    T.reservationChanged({ actor: e.actor.displayName, audience: a.audience, targetName: e.after.userName, before: e.before, after: e.after, tz: env.tz }),
  link: (e, a, env) => (a.audience === 'owner' ? agendaDay(e.after.start, env) : '/#/inbox'),
  tag: (e) => `reservation-${e.after.id}`,
});

const reservationDeleted = row<Events['reservation.deleted'], ReservationAudience>({
  who: (e) => reservationAudience(e.reservation),
  text: (e, a, env) =>
    T.reservationDeleted({
      actor: e.actor.displayName,
      audience: a.audience,
      creatorName: e.reservation.createdByName,
      targetName: e.reservation.userName,
      byCreator: e.actor.id === e.reservation.createdBy,
      start: e.reservation.start,
      end: e.reservation.end,
      tz: env.tz,
    }),
  link: (_e, a) => (a.audience === 'owner' ? '/#/' : '/#/inbox'),
  tag: (e) => `reservation-${e.reservation.id}`,
});

// ---- drives

type DriveEntry = Audience & { audience: T.DriveAudience; variant: T.DriveVariant; snap: UsageSnap };

/** Why somebody is concerned about a drive: they drove it, the kilometres are put on their name, or it is on their reservation. First reason wins. */
function driveRoles(s: UsageSnap | null): Map<number, T.DriveAudience> {
  if (!s) return new Map();
  const roles: Array<Audience & { audience: T.DriveAudience }> = [{ userId: s.driverId, audience: 'driver' }];
  if (s.kmFor === 'person' && s.kmUserId !== null) roles.push({ userId: s.kmUserId, audience: 'km' });
  if (s.reservationOwnerId !== null) roles.push({ userId: s.reservationOwnerId, audience: 'reservation' });
  return new Map([...firstPerUser(roles)].map(([userId, r]) => [userId, r.audience]));
}

const sameDrive = (a: UsageSnap, b: UsageSnap): boolean => JSON.stringify(a) === JSON.stringify(b);

const usageChanged = row<Events['usage.changed'], DriveEntry>({
  who(e) {
    // An edit that changed nothing is not news.
    if (e.change === 'updated' && e.before && e.after && sameDrive(e.before, e.after)) return [];
    const before = driveRoles(e.before);
    const after = driveRoles(e.after);
    const out: DriveEntry[] = [];
    // Everybody the drive concerns now: told about it as new when they were not on it before, as changed when they were.
    if (e.after) for (const [userId, audience] of after) out.push({ userId, audience, variant: before.has(userId) ? 'changed' : 'added', snap: e.after });
    // Everybody it no longer concerns (deleted, taken off their name, moved to another driver or reservation).
    if (e.before) for (const [userId, audience] of before) if (!after.has(userId)) out.push({ userId, audience, variant: 'removed', snap: e.before });
    return out;
  },
  text: (e, a, env) =>
    T.drive({
      actor: e.actor.displayName,
      audience: a.audience,
      variant: a.variant,
      deleted: e.change === 'deleted',
      status: a.snap.status,
      start: a.snap.start,
      km: a.snap.km,
      reservationStart: a.snap.reservationStart,
      tz: env.tz,
    }),
  // The reservation's owner sees reserved against actual on History; the driver and the kilometre owner see the drive on Drives.
  link: (_e, a) => (a.audience === 'reservation' ? '/#/history' : '/#/usage'),
  tag: (_e, a) => `usage-${a.snap.id}`,
});

// ---- fuel

type FuelAudience = Audience & { audience: 'debtor' | 'fueler' };

const fuelCreated = row<Events['fuel.created'], FuelAudience & { share?: Events['fuel.created']['fuel']['shares'][number] }>({
  who(e) {
    const out: Array<FuelAudience & { share?: Events['fuel.created']['fuel']['shares'][number] }> = [];
    // Everybody who owes money for it. A share of nothing, a debt of nothing and the fueler themselves are not asked.
    for (const share of e.fuel.shares) {
      if (share.userId !== e.fuel.userId && share.owes && share.cents > 0 && share.dueCents > 0) out.push({ userId: share.userId, audience: 'debtor', share });
    }
    // The fueler, for a fill-up somebody else (an admin) registered in their name; the actor is dropped, so nothing for their own.
    out.push({ userId: e.fuel.userId, audience: 'fueler' });
    return out;
  },
  text: (e, a, env) =>
    a.audience === 'debtor' && a.share
      ? T.fuelCreated({ fueler: e.fuel.userName, shareCents: a.share.cents, carriedCents: a.share.carriedCents, dueCents: a.share.dueCents })
      : T.fuelInYourName({ actor: e.actor.displayName, change: 'created', at: e.fuel.at, totalCents: e.fuel.totalCents, tz: env.tz }),
  link: (_e, a) => (a.audience === 'debtor' ? '/#/history' : '/#/fuel'),
  tag: (e) => `fuel-${e.fuel.id}`,
});

const shareKey = (s: { fuelId: number; userId: number }): string => `${s.fuelId}:${s.userId}`;

/** The people whose share of any fill-up differs between two moments, with their share of `fuelId` itself (null when they had none). */
function changedShares(before: ShareSnapshot, after: ShareSnapshot, fuelId: number): Array<{ userId: number; beforeCents: number | null; afterCents: number | null }> {
  const was = new Map(before.map((s) => [shareKey(s), s]));
  const now = new Map(after.map((s) => [shareKey(s), s]));
  const people = new Set<number>();
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(key);
    const b = now.get(key);
    if (a?.cents !== b?.cents || a?.dueCents !== b?.dueCents) people.add((a ?? (b as { userId: number })).userId);
  }
  const own = (list: ShareSnapshot, userId: number): number | null => list.find((s) => s.fuelId === fuelId && s.userId === userId)?.cents ?? null;
  return [...people].sort((x, y) => x - y).map((userId) => ({ userId, beforeCents: own(before, userId), afterCents: own(after, userId) }));
}

type FuelChangedAudience = FuelAudience & { beforeCents?: number | null; afterCents?: number | null };

const fuelChanged = row<Events['fuel.changed'], FuelChangedAudience>({
  who(e) {
    const out: FuelChangedAudience[] = [];
    // The fueler (or, when an admin handed the fill-up to somebody else, both): for somebody else's change to their fill-up.
    for (const userId of new Set([e.before.userId, e.after?.userId ?? e.before.userId])) out.push({ userId, audience: 'fueler' });
    // The debtors whose share of anything moved because of it.
    if (e.sharesBefore && e.sharesAfter) {
      for (const c of changedShares(e.sharesBefore, e.sharesAfter, e.before.id)) out.push({ userId: c.userId, audience: 'debtor', beforeCents: c.beforeCents, afterCents: c.afterCents });
    }
    return out;
  },
  text: (e, a, env) => {
    const head = e.after ?? e.before;
    return a.audience === 'fueler'
      ? T.fuelInYourName({ actor: e.actor.displayName, change: e.change, at: head.at, totalCents: null, tz: env.tz })
      : T.fuelShareChanged({
          actor: e.actor.displayName,
          fueler: head.userName,
          byFueler: e.actor.id === head.userId,
          change: e.change,
          at: head.at,
          beforeCents: a.beforeCents ?? null,
          afterCents: a.afterCents ?? null,
          tz: env.tz,
        });
  },
  link: (_e, a) => (a.audience === 'debtor' ? '/#/history' : '/#/fuel'),
  tag: (e) => `fuel-${e.before.id}`,
});

const fuelPaid = row<Events['fuel.paid'], FuelAudience>({
  // "I have paid" goes to the fueler. A mark by the fueler or an admin goes to the person whose share it is.
  who: (e) => (e.actor.id === e.debtor.id ? (e.paid ? [{ userId: e.fuel.userId, audience: 'fueler' }] : []) : [{ userId: e.debtor.id, audience: 'debtor' }]),
  text: (e, a, env) =>
    a.audience === 'fueler'
      ? T.fuelSelfPaid({ debtor: e.debtor.name, at: e.fuel.at, amountCents: e.amountCents, tz: env.tz })
      : T.fuelMarked({ actor: e.actor.displayName, paid: e.paid, at: e.fuel.at, amountCents: e.amountCents, tz: env.tz }),
  link: (_e, a) => (a.audience === 'debtor' ? '/#/history' : '/#/fuel'),
  // The debtor has one share of this fill-up. The fueler may hear from several debtors, which must not replace each other.
  tag: (e, a) => (a.audience === 'debtor' ? `fuel-${e.fuel.id}` : `fuel-${e.fuel.id}-paid-${e.debtor.id}`),
});

// ---- tickets

type TicketEntry = Audience & { variant: 'added' | 'changed' | 'removed' };

const ticketChanged = row<Events['ticket.changed'], TicketEntry>({
  who(e) {
    const out: TicketEntry[] = [];
    if (e.driverAfter && e.change !== 'deleted') out.push({ userId: e.driverAfter.id, variant: e.change === 'created' || e.driverBefore?.id !== e.driverAfter.id ? 'added' : 'changed' });
    // The driver the ticket used to name, when it no longer does (its time moved, or it was deleted).
    if (e.driverBefore && e.change !== 'created' && e.driverBefore.id !== e.driverAfter?.id) out.push({ userId: e.driverBefore.id, variant: 'removed' });
    return out;
  },
  // Never the price or the reason: the lock screen is not the place for them.
  text: (e, a, env) => T.ticket({ actor: e.actor.displayName, variant: a.variant, deleted: e.change === 'deleted', at: a.variant === 'removed' ? e.ticket.atBefore : e.ticket.at, tz: env.tz }),
  link: () => '/#/tickets',
  tag: (e) => `ticket-${e.ticket.id}`,
});

/** The table. Each row is the whole definition of one event. */
export const EVENTS: EventTable<Events> = {
  'reservation.suggested': reservationSuggested,
  'reservation.answered': reservationAnswered,
  'reservation.changed': reservationChanged,
  'reservation.deleted': reservationDeleted,
  'usage.changed': usageChanged,
  'fuel.created': fuelCreated,
  'fuel.changed': fuelChanged,
  'fuel.paid': fuelPaid,
  'ticket.changed': ticketChanged,
};

// ------------------------------------------------------------------- the engine

/** What the service worker shows whole (public/sw.js cuts at these), and what a push message may weigh. */
const MAX_TITLE = 100;
const MAX_BODY = 300;
const MAX_TAG = 64;
const MAX_URL = 300;
const MAX_BYTES = 900;

const clip = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

/** The message as the service worker and the push services will take it: whole, whatever the names are. */
export function fit(message: PushMessage): PushMessage {
  const out: PushMessage = { title: clip(message.title, MAX_TITLE), body: clip(message.body, MAX_BODY), url: clip(message.url, MAX_URL), tag: clip(message.tag, MAX_TAG) };
  // Multi-byte names can still make a short text heavy: shorten the body until it fits.
  while (Buffer.byteLength(JSON.stringify(out)) > MAX_BYTES && out.body.length > 1) out.body = clip(out.body, Math.max(1, [...out.body].length - 20));
  return out;
}

/** An error as the log may say it: the name only, since a message could carry an address, a key or a person's text. */
const reasonOf = (err: unknown): string => (err instanceof Error ? err.name : 'error');

export interface Notifier<M extends EventMap = Events> {
  /**
   * Tell the people an event concerns. `build` makes the payload and is called at once (so it sees the
   * rows as they are); everything else happens after the response. Returns at once and never throws:
   * nothing is built when push is off.
   */
  emit<K extends keyof M & string>(kind: K, build: () => M[K]): void;
  /** Run `build` for a payload that must be taken before a change is made (a snapshot). undefined when push is off or it threw. */
  capture<T>(build: () => T): T | undefined;
  /** Resolves when the sends that are running have finished (shutdown, tests). */
  idle(): Promise<void>;
}

export function createNotifier(ctx: Ctx, push: PushService): Notifier<Events>;
export function createNotifier<M extends EventMap>(ctx: Ctx, push: PushService, table: EventTable<M>): Notifier<M>;
export function createNotifier(ctx: Ctx, push: PushService, table: EventTable<EventMap> = EVENTS as unknown as EventTable<EventMap>): Notifier<EventMap> {
  const running = new Set<Promise<void>>();
  const env: TextEnv = { tz: ctx.config.tz };

  // A broken logger must not turn into the rejection this module guards against: nothing here may throw into a request
  // or leave an unhandled rejection, which would take the whole server down.
  const log = (event: Record<string, unknown>): void => {
    try {
      ctx.log(event);
    } catch {
      // nothing left to do
    }
  };

  const directory: Directory = {
    isActive: (userId) => many<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE id = ? AND active = 1', userId).length > 0,
    activeUserIds: () => many<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE active = 1 ORDER BY id').map((u) => u.id),
  };

  /** All devices of one person, in parallel; a failure of one device does not stop the others. */
  async function deliver(kind: string, userId: number, devices: PushSubscriptionRow[], message: PushMessage): Promise<void> {
    const outcomes = await Promise.all(
      devices.map(async (subscription) => {
        try {
          return await push.send(subscription, message);
        } catch (err) {
          log({ event: 'notify.error', kind, userId, reason: reasonOf(err) });
          return 'rejected' as const;
        }
      }),
    );
    log({ event: 'notify.sent', kind, userId, sent: outcomes.filter((o) => o === 'ok').length, failed: outcomes.filter((o) => o !== 'ok').length });
  }

  async function dispatch(kind: string, event: { actor: Actor }): Promise<void> {
    const spec = table[kind];
    if (!spec) return;
    let audience: Audience[];
    try {
      audience = spec.who(event, directory);
    } catch (err) {
      log({ event: 'notify.error', kind, reason: reasonOf(err) });
      return;
    }
    // Never the person who did it, and never the same person twice (the first entry wins).
    const told = new Set<number>([event.actor.id]);
    const jobs: Array<Promise<void>> = [];
    for (const entry of audience) {
      if (told.has(entry.userId)) continue;
      told.add(entry.userId);
      try {
        if (!directory.isActive(entry.userId)) continue;
        const devices = push.subscriptionsOf(entry.userId);
        if (devices.length === 0) continue;
        const message = fit({ ...spec.text(event, entry, env), url: spec.link(event, entry, env), tag: spec.tag(event, entry) });
        jobs.push(deliver(kind, entry.userId, devices, message));
      } catch (err) {
        // One person's trouble (a lookup, a text) must not stop the others from being told.
        log({ event: 'notify.error', kind, userId: entry.userId, reason: reasonOf(err) });
      }
    }
    await Promise.all(jobs);
  }

  function track(job: Promise<void>, kind: string): void {
    running.add(job);
    const done = (): void => void running.delete(job);
    job.then(done, (err: unknown) => {
      done();
      log({ event: 'notify.error', kind, reason: reasonOf(err) });
    });
  }

  return {
    emit(kind, build) {
      if (!push.enabled) return;
      try {
        const event = build();
        // After the response: this callback runs once the request handler has returned and its reply has been written.
        // Tracked from now on, so idle() also waits for a job that has not started yet.
        track(new Promise<void>((resolve, reject) => setImmediate(() => void dispatch(kind, event).then(resolve, reject))), kind);
      } catch (err) {
        log({ event: 'notify.error', kind, reason: reasonOf(err) });
      }
    },
    capture(build) {
      if (!push.enabled) return undefined;
      try {
        return build();
      } catch (err) {
        log({ event: 'notify.error', kind: 'capture', reason: reasonOf(err) });
        return undefined;
      }
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}
