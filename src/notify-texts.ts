// Every word of every push notification the server sends lives in this file, and nowhere else:
// the Dutch translation is a single edit here. A text function gets plain facts (names, instants,
// amounts) and returns a title and a body; where a notification opens and which tag it carries are
// routing, not wording, and sit in the event table (notify.ts).
//
// Rules for what goes in a text:
//   * Short. The service worker shows 100 characters of title and 300 of body, and a push
//     message may hold about a kilobyte, so names are shortened here and bodies stay a sentence or two.
//   * Never a note, a reason or a price that was not already the point of the message. A lock screen
//     is not the place for them; the notification opens the screen that has them. A traffic ticket
//     message has neither its price nor its reason.
//   * Times are written for the household time zone, like everywhere else in the app.
import { formatLocal } from '../shared/time.js';
import { formatCents } from './payments.ts';

export interface Text {
  title: string;
  body: string;
}

/** Names come from users and end up in a notification: keep them short. */
const MAX_NAME = 40;
export const short = (name: string): string => {
  // By code point, so a name is never cut in the middle of an emoji.
  const chars = [...name];
  return chars.length > MAX_NAME ? `${chars.slice(0, MAX_NAME - 1).join('')}…` : name;
};

const when = (instant: string, tz: string): string => formatLocal(instant, tz, 'datetime');
const range = (start: string, end: string, tz: string): string => `${when(start, tz)} – ${when(end, tz)}`;
const eur = (cents: number): string => `EUR ${formatCents(cents)}`;

// ------------------------------------------------------------ reminders and tests

export type ReminderKind = 'start' | 'end' | 'repeat';

/** The reminders for a reservation that still needs its kilometres. `time` is a clock time such as "18:00". */
export function reminder(kind: ReminderKind, time: string, hasDraft: boolean): Text {
  if (kind === 'start') return { title: 'Your car reservation starts soon', body: `It starts at ${time}. Save your starting odometer reading now.` };
  const prefix = kind === 'repeat' ? 'Reminder: ' : '';
  if (hasDraft) return { title: `${prefix}Finish your drive`, body: `Your reservation ended at ${time}. Enter the end odometer reading.` };
  return { title: `${prefix}Register your kilometres`, body: `Your reservation ended at ${time}. Register the kilometres you drove.` };
}

/** The Send test notification button on the Account page. */
export function testNotification(): Text {
  return { title: 'Test notification', body: 'Reminders work on this device.' };
}

// ------------------------------------------------------------------- reservations

/** Who is being told: the person the reservation is for, or the person who suggested it. */
export type ReservationAudience = 'owner' | 'target' | 'suggester';

export function reservationSuggested(p: { actor: string; start: string; end: string; tz: string }): Text {
  return {
    title: `${short(p.actor)} suggested a reservation for you`,
    body: `${range(p.start, p.end, p.tz)}. Open the Inbox to approve or decline it before it starts.`,
  };
}

export function reservationAnswered(p: { actor: string; decision: 'approved' | 'declined'; start: string; end: string; tz: string }): Text {
  return p.decision === 'approved'
    ? { title: `${short(p.actor)} approved your suggestion`, body: `${range(p.start, p.end, p.tz)} is now a confirmed reservation.` }
    : { title: `${short(p.actor)} declined your suggestion`, body: `${range(p.start, p.end, p.tz)} was not accepted.` };
}

export function reservationChanged(p: {
  actor: string;
  audience: ReservationAudience;
  /** The person the reservation is for, for the one who suggested it. */
  targetName: string;
  before: { start: string; end: string };
  after: { start: string; end: string };
  tz: string;
}): Text {
  const timeChanged = p.before.start !== p.after.start || p.before.end !== p.after.end;
  const body = timeChanged
    ? `Now ${range(p.after.start, p.after.end, p.tz)} (was ${range(p.before.start, p.before.end, p.tz)}).`
    : `${range(p.after.start, p.after.end, p.tz)}. Only the note changed.`;
  if (p.audience === 'owner') return { title: `${short(p.actor)} changed your reservation`, body };
  if (p.audience === 'target') return { title: `${short(p.actor)} changed a suggestion for you`, body: `${body} Open the Inbox to answer it.` };
  return { title: `${short(p.actor)} changed your suggestion for ${short(p.targetName)}`, body };
}

export function reservationDeleted(p: {
  actor: string;
  audience: ReservationAudience;
  /** The person who made the suggestion, for the one it was made for. */
  creatorName: string;
  /** The person the reservation is for, for the one who suggested it. */
  targetName: string;
  /** The person who withdrew it is the one who suggested it (and not, say, an admin). */
  byCreator: boolean;
  start: string;
  end: string;
  tz: string;
}): Text {
  const slot = range(p.start, p.end, p.tz);
  if (p.audience === 'owner') return { title: `${short(p.actor)} cancelled your reservation`, body: `${slot} is no longer reserved.` };
  if (p.audience === 'target') {
    return p.byCreator
      ? { title: `${short(p.actor)} withdrew a suggestion for you`, body: `${slot} is no longer waiting for your answer.` }
      : { title: `${short(p.actor)} cancelled a suggestion made for you`, body: `${short(p.creatorName)}'s suggestion for ${slot} is gone.` };
  }
  return { title: `${short(p.actor)} cancelled your suggestion for ${short(p.targetName)}`, body: `${slot} was removed.` };
}

// ------------------------------------------------------------------------- drives

/** Why a drive concerns this person: they drove, the kilometres are put on their name, or it is on their reservation. */
export type DriveAudience = 'driver' | 'km' | 'reservation';
/** What happened to the drive as far as this person is concerned. */
export type DriveVariant = 'added' | 'changed' | 'removed';

export function drive(p: {
  actor: string;
  audience: DriveAudience;
  variant: DriveVariant;
  /** A removed drive that was deleted, or only taken away from this person (another driver, other kilometres, another reservation). */
  deleted: boolean;
  status: 'draft' | 'completed';
  start: string;
  km: number | null;
  /** Start of the reservation the drive is on, for the owner of that reservation. */
  reservationStart: string | null;
  tz: string;
}): Text {
  const who = short(p.actor);
  const km = p.km !== null ? `${p.km} km` : null;
  const at = when(p.start, p.tz);
  const detail = p.status === 'draft' ? `Started ${at}.` : `${at}${km ? `, ${km}` : ''}.`;
  switch (p.audience) {
    case 'driver':
      if (p.variant === 'added') return { title: `${who} logged a drive in your name`, body: `${detail} Open Drives to check it.` };
      if (p.variant === 'changed') return { title: `${who} changed a drive in your name`, body: `${detail} Open Drives to check it.` };
      return p.deleted
        ? { title: `${who} deleted a drive in your name`, body: `The drive of ${at} is gone.` }
        : { title: `${who} took a drive off your name`, body: `The drive of ${at} is no longer yours.` };
    case 'km':
      if (p.variant === 'added') return { title: `${who} registered kilometres as yours`, body: `${km ? `${km} on ${at}` : `A drive on ${at}`}. Open Drives to see why.` };
      if (p.variant === 'changed') return { title: `${who} changed kilometres registered as yours`, body: `${km ? `${km} on ${at}` : `A drive on ${at}`}. Open Drives to check them.` };
      return { title: `${who} removed kilometres that were yours`, body: `${km ? `The ${km} on ${at} are` : `The drive on ${at} is`} no longer yours.` };
    case 'reservation': {
      const slot = p.reservationStart ? `your reservation of ${when(p.reservationStart, p.tz)}` : 'your reservation';
      if (p.variant === 'added') return { title: `${who} registered a drive on your reservation`, body: `${detail} It is on ${slot}.` };
      if (p.variant === 'changed') return { title: `${who} changed a drive on your reservation`, body: `${detail} It is on ${slot}.` };
      return { title: `${who} removed a drive from your reservation`, body: `The drive of ${at} is no longer on ${slot}.` };
    }
  }
}

// ----------------------------------------------------------------------------- fuel

/** The existing push for a new fill-up: who fuelled, what is due (and what of it is carried), and that it can still change. */
export function fuelCreated(p: { fueler: string; shareCents: number; carriedCents: number; dueCents: number }): Text {
  const fueler = short(p.fueler);
  const parts =
    p.carriedCents > 0
      ? ` (${eur(p.shareCents)} now plus ${eur(p.carriedCents)} still open from earlier)`
      : p.carriedCents < 0
        ? ` (${eur(p.shareCents)} now, minus ${eur(-p.carriedCents)} that ${fueler} owes you from earlier)`
        : '';
  return {
    title: `${fueler} fuelled the car`,
    body: `You owe ${fueler} ${eur(p.dueCents)}${parts}. This can still change when more drives are registered.`,
  };
}

/** Somebody else registered, changed or deleted a fill-up in the fueler's name. */
export function fuelInYourName(p: { actor: string; change: 'created' | 'updated' | 'deleted'; at: string; totalCents: number | null; tz: string }): Text {
  const who = short(p.actor);
  const day = when(p.at, p.tz);
  if (p.change === 'created') return { title: `${who} registered a fill-up in your name`, body: `${p.totalCents !== null ? `${eur(p.totalCents)} on ${day}` : `The fill-up of ${day}`}. Open Fuel to check it.` };
  if (p.change === 'updated') return { title: `${who} changed your fill-up`, body: `The fill-up of ${day}. Open Fuel to check it.` };
  return { title: `${who} deleted your fill-up`, body: `The fill-up of ${day} is gone.` };
}

/** A fill-up that was edited or deleted changed what this person owes. `before` and `after` are their share of that very fill-up, when they had one. */
export function fuelShareChanged(p: {
  actor: string;
  fueler: string;
  /** The one who changed it is the fueler themselves. */
  byFueler: boolean;
  change: 'updated' | 'deleted';
  at: string;
  beforeCents: number | null;
  afterCents: number | null;
  tz: string;
}): Text {
  const day = when(p.at, p.tz);
  const whose = p.byFueler ? 'their fill-up' : `${short(p.fueler)}'s fill-up`;
  if (p.change === 'deleted') {
    return { title: `${short(p.actor)} deleted ${whose}`, body: `The fill-up of ${day} is gone and your share of the fuel costs changed. Open History to see what you owe.` };
  }
  const same = p.beforeCents !== null && p.afterCents !== null;
  return {
    title: `${short(p.actor)} changed ${whose}`,
    body: same
      ? `Your share of the fill-up of ${day} went from ${eur(p.beforeCents as number)} to ${eur(p.afterCents as number)}.`
      : `Your share of the fuel costs changed. Open History to see what you owe.`,
  };
}

/** The fueler or an admin marked this person's share as paid, or took the mark off again. */
export function fuelMarked(p: { actor: string; paid: boolean; at: string; amountCents: number; tz: string }): Text {
  const day = when(p.at, p.tz);
  return p.paid
    ? { title: `${short(p.actor)} marked your fuel share as paid`, body: `The fill-up of ${day}: ${eur(p.amountCents)}. Nothing more to pay for it.` }
    : { title: `${short(p.actor)} marked your fuel share as not paid`, body: `The fill-up of ${day}: ${eur(p.amountCents)} is open again. Open History to see what you owe.` };
}

/** The debtor pressed "I have paid this request": a self-report the fueler may want to check. */
export function fuelSelfPaid(p: { debtor: string; at: string; amountCents: number; tz: string }): Text {
  return {
    title: `${short(p.debtor)} says the fuel is paid`,
    body: `The fill-up of ${when(p.at, p.tz)}: ${eur(p.amountCents)}. Open Fuel to check it, or to mark it unpaid.`,
  };
}

// --------------------------------------------------------------------------- tickets

/** A traffic ticket was entered, changed or deleted for a moment the app has this person down as the driver. Never the price or the reason. */
export function ticket(p: { actor: string; variant: 'added' | 'changed' | 'removed'; deleted: boolean; at: string; tz: string }): Text {
  const who = short(p.actor);
  const at = when(p.at, p.tz);
  if (p.variant === 'added') return { title: `${who} entered a traffic ticket`, body: `It is dated ${at}, and the app has you down as the driver then. Open Tickets to see it.` };
  if (p.variant === 'changed') return { title: `${who} changed a traffic ticket`, body: `It is dated ${at}, and the app has you down as the driver then. Open Tickets to see it.` };
  return p.deleted
    ? { title: `${who} deleted a traffic ticket`, body: `The ticket dated ${at}, which was linked to you, is gone.` }
    : { title: `${who} changed a traffic ticket`, body: `The ticket dated ${at} is no longer linked to you.` };
}
