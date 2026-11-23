// Every word of every push notification the server sends lives in this file, and nowhere else. The texts are
// Dutch, like the rest of the interface, and speak to the reader as "je" (see docs/GLOSSARY.md). A text function
// gets plain facts (names, instants, amounts) and returns a title and a body; where a notification opens and which
// tag it carries are routing, not wording, and sit in the event table (notify.ts).
//
// Rules for what goes in a text:
//   * Short. The service worker shows 100 characters of title and 300 of body, and a push
//     message may hold about a kilobyte, so names are shortened here and bodies stay a sentence or two.
//     Dutch is longer than English, so a title holds one person's name at most; a second name goes in the body.
//     test/dutch.test.ts renders every text with two 40-character names of 3-byte characters and checks the caps.
//   * Never a note, a reason or a price that was not already the point of the message. A lock screen
//     is not the place for them; the notification opens the screen that has them. A traffic ticket
//     message has neither its price nor its reason. A damage report is the exception that proves the
//     rule: its description is the point of the message, so a clipped line of it is shown.
//   * Times are written for the household time zone, like everywhere else in the app. Amounts are written
//     "€ 12,50" by shared/format.js, the same as on screen.
//   * No possessive 's: Dutch says "de tankbeurt van Ben".
import { formatEuro as eur, formatKm } from '../shared/format.js';
import { formatLocal } from '../shared/time.js';

export interface Text {
  title: string;
  body: string;
}

/** Names come from users and end up in a notification: keep them short. */
const MAX_NAME = 40;
/** Cut a text to `max` characters, ending in an ellipsis when it was cut. By code point, so it is never cut in the middle of an emoji. */
const clip = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};
export const short = (name: string): string => clip(name, MAX_NAME);

const when = (instant: string, tz: string): string => formatLocal(instant, tz, 'datetime');
const range = (start: string, end: string, tz: string): string => `${when(start, tz)} – ${when(end, tz)}`;

// ------------------------------------------------------------ reminders and tests

export type ReminderKind = 'start' | 'end' | 'repeat';

/** The reminders for a reservation that still needs its kilometres. `time` is a clock time such as "18:00". */
export function reminder(kind: ReminderKind, time: string, hasDraft: boolean): Text {
  if (kind === 'start') return { title: 'Je reservering begint zo', body: `De reservering begint om ${time}. Sla nu de kilometerstand bij het begin op.` };
  const prefix = kind === 'repeat' ? 'Herinnering: ' : '';
  if (hasDraft) return { title: `${prefix}Rond je rit af`, body: `Je reservering eindigde om ${time}. Vul de kilometerstand bij het einde in.` };
  return { title: `${prefix}Registreer je kilometers`, body: `Je reservering eindigde om ${time}. Registreer de kilometers die je hebt gereden.` };
}

/** The Send test notification button on the Account page. */
export function testNotification(): Text {
  return { title: 'Testmelding', body: 'Je herinneringen werken op dit apparaat.' };
}

// ------------------------------------------------------------------- reservations

/** Who is being told: the person the reservation is for, or the person who suggested it. */
export type ReservationAudience = 'owner' | 'target' | 'suggester';

export function reservationSuggested(p: { actor: string; start: string; end: string; tz: string }): Text {
  return {
    title: `${short(p.actor)} stelde een reservering voor je voor`,
    body: `${range(p.start, p.end, p.tz)}. Open de Inbox om het voorstel goed te keuren of af te wijzen voordat het begint.`,
  };
}

export function reservationAnswered(p: { actor: string; decision: 'approved' | 'declined'; start: string; end: string; tz: string }): Text {
  return p.decision === 'approved'
    ? { title: `${short(p.actor)} keurde je voorstel goed`, body: `${range(p.start, p.end, p.tz)} is nu een bevestigde reservering.` }
    : { title: `${short(p.actor)} wees je voorstel af`, body: `${range(p.start, p.end, p.tz)} gaat niet door.` };
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
    ? `Nu ${range(p.after.start, p.after.end, p.tz)} (was ${range(p.before.start, p.before.end, p.tz)}).`
    : `${range(p.after.start, p.after.end, p.tz)}. Alleen de notitie is gewijzigd.`;
  if (p.audience === 'owner') return { title: `${short(p.actor)} wijzigde je reservering`, body };
  if (p.audience === 'target') return { title: `${short(p.actor)} wijzigde een voorstel voor je`, body: `${body} Open de Inbox om te antwoorden.` };
  return { title: `${short(p.actor)} wijzigde je voorstel`, body: `Voor ${short(p.targetName)}: ${body}` };
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
  if (p.audience === 'owner') return { title: `${short(p.actor)} annuleerde je reservering`, body: `${slot} is niet meer gereserveerd.` };
  if (p.audience === 'target') {
    return p.byCreator
      ? { title: `${short(p.actor)} trok een voorstel voor je in`, body: `${slot} wacht niet meer op je antwoord.` }
      : { title: `${short(p.actor)} annuleerde een voorstel voor je`, body: `Het voorstel van ${short(p.creatorName)} voor ${slot} is verdwenen.` };
  }
  return { title: `${short(p.actor)} annuleerde je voorstel`, body: `Het voorstel voor ${short(p.targetName)} (${slot}) is verwijderd.` };
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
  const km = p.km !== null ? `${formatKm(p.km)} km` : null;
  const at = when(p.start, p.tz);
  const detail = p.status === 'draft' ? `Gestart ${at}.` : `${at}${km ? `, ${km}` : ''}.`;
  switch (p.audience) {
    case 'driver':
      if (p.variant === 'added') return { title: `${who} registreerde een rit op jouw naam`, body: `${detail} Open Ritten om het te controleren.` };
      if (p.variant === 'changed') return { title: `${who} wijzigde een rit op jouw naam`, body: `${detail} Open Ritten om het te controleren.` };
      return p.deleted
        ? { title: `${who} verwijderde een rit op jouw naam`, body: `De rit van ${at} is verwijderd.` }
        : { title: `${who} haalde een rit van jouw naam af`, body: `De rit van ${at} is niet meer van jou.` };
    case 'km':
      if (p.variant === 'added') return { title: `${who} registreerde kilometers op jouw naam`, body: `${km ? `${km} op ${at}` : `Een rit op ${at}`}. Open Ritten om te zien waarom.` };
      if (p.variant === 'changed') return { title: `${who} wijzigde kilometers op jouw naam`, body: `${km ? `${km} op ${at}` : `Een rit op ${at}`}. Open Ritten om ze te controleren.` };
      return { title: `${who} haalde kilometers van jouw naam af`, body: `${km ? `De ${km} op ${at} zijn` : `De rit op ${at} is`} niet meer van jou.` };
    case 'reservation': {
      const slot = p.reservationStart ? `jouw reservering van ${when(p.reservationStart, p.tz)}` : 'jouw reservering';
      if (p.variant === 'added') return { title: `${who} registreerde een rit op je reservering`, body: `${detail} De rit hoort bij ${slot}.` };
      if (p.variant === 'changed') return { title: `${who} wijzigde een rit op je reservering`, body: `${detail} De rit hoort bij ${slot}.` };
      return { title: `${who} haalde een rit van je reservering af`, body: `De rit van ${at} hoort niet meer bij ${slot}.` };
    }
  }
}

// ----------------------------------------------------------------------------- fuel

/** The existing push for a new fill-up: who fuelled, what is due (and what of it is carried), and that it can still change. */
export function fuelCreated(p: { fueler: string; shareCents: number; carriedCents: number; dueCents: number }): Text {
  const fueler = short(p.fueler);
  const parts =
    p.carriedCents > 0
      ? ` (${eur(p.shareCents)} nu plus ${eur(p.carriedCents)} dat nog openstaat van eerder)`
      : p.carriedCents < 0
        ? ` (${eur(p.shareCents)} nu, min ${eur(-p.carriedCents)} dat ${fueler} je van eerder nog schuldig is)`
        : '';
  return {
    title: `${fueler} heeft de auto getankt`,
    body: `Je moet ${fueler} ${eur(p.dueCents)} betalen${parts}. Dit kan nog veranderen als er meer ritten worden geregistreerd.`,
  };
}

/** Somebody else registered, changed or deleted a fill-up in the fueler's name. */
export function fuelInYourName(p: { actor: string; change: 'created' | 'updated' | 'deleted'; at: string; totalCents: number | null; tz: string }): Text {
  const who = short(p.actor);
  const day = when(p.at, p.tz);
  if (p.change === 'created') {
    return {
      title: `${who} registreerde een tankbeurt op jouw naam`,
      body: `${p.totalCents !== null ? `${eur(p.totalCents)} op ${day}` : `De tankbeurt van ${day}`}. Open Brandstof en kosten om het te controleren.`,
    };
  }
  if (p.change === 'updated') return { title: `${who} wijzigde je tankbeurt`, body: `De tankbeurt van ${day}. Open Brandstof en kosten om het te controleren.` };
  return { title: `${who} verwijderde je tankbeurt`, body: `De tankbeurt van ${day} is verwijderd.` };
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
  // One name in the title (the actor); the fueler, when somebody else changed the fill-up, is named in the body.
  const fillUp = p.byFueler ? `tankbeurt van ${day}` : `tankbeurt van ${short(p.fueler)} (${day})`;
  if (p.change === 'deleted') {
    return {
      title: `${short(p.actor)} verwijderde een tankbeurt`,
      body: `De ${fillUp} is verwijderd en je aandeel in de brandstofkosten is veranderd. Open Historie om te zien wat je moet betalen.`,
    };
  }
  const same = p.beforeCents !== null && p.afterCents !== null;
  return {
    title: `${short(p.actor)} wijzigde een tankbeurt`,
    body: same
      ? `Je aandeel in de ${fillUp} ging van ${eur(p.beforeCents as number)} naar ${eur(p.afterCents as number)}.`
      : `Je aandeel in de brandstofkosten is veranderd. Open Historie om te zien wat je moet betalen.`,
  };
}

/** The fueler or an admin marked this person's share as paid, or took the mark off again. */
export function fuelMarked(p: { actor: string; paid: boolean; at: string; amountCents: number; tz: string }): Text {
  const day = when(p.at, p.tz);
  return p.paid
    ? { title: `${short(p.actor)} markeerde je brandstofaandeel als betaald`, body: `De tankbeurt van ${day}: ${eur(p.amountCents)}. Je hoeft er niets meer voor te betalen.` }
    : {
        title: `${short(p.actor)} markeerde je brandstofaandeel als niet betaald`,
        body: `De tankbeurt van ${day}: ${eur(p.amountCents)} staat weer open. Open Historie om te zien wat je moet betalen.`,
      };
}

/** The debtor pressed "Ik heb betaald": a self-report the fueler may want to check. */
export function fuelSelfPaid(p: { debtor: string; at: string; amountCents: number; tz: string }): Text {
  return {
    title: `${short(p.debtor)} zegt dat de brandstof betaald is`,
    body: `De tankbeurt van ${when(p.at, p.tz)}: ${eur(p.amountCents)}. Controleer het bij Brandstof en kosten; je kunt het ook weer als niet betaald markeren.`,
  };
}

// --------------------------------------------------------------------------- tickets

/** A traffic ticket was entered, changed or deleted for a moment the app has this person down as the driver. Never the price or the reason. */
export function ticket(p: { actor: string; variant: 'added' | 'changed' | 'removed'; deleted: boolean; at: string; tz: string }): Text {
  const who = short(p.actor);
  const at = when(p.at, p.tz);
  if (p.variant === 'added') return { title: `${who} voerde een verkeersboete in`, body: `De boete is van ${at} en volgens de app was jij toen de bestuurder. Open Verkeersboetes om de boete te bekijken.` };
  if (p.variant === 'changed') return { title: `${who} wijzigde een verkeersboete`, body: `De boete is van ${at} en volgens de app was jij toen de bestuurder. Open Verkeersboetes om de boete te bekijken.` };
  return p.deleted
    ? { title: `${who} verwijderde een verkeersboete`, body: `De verkeersboete van ${at}, die aan jou was gekoppeld, is verwijderd.` }
    : { title: `${who} wijzigde een verkeersboete`, body: `De verkeersboete van ${at} is niet meer aan jou gekoppeld.` };
}

// ---------------------------------------------------------------------- damage reports

/**
 * Where on the car, as a message says it. The keys are the locations of src/car.ts and the words are those of
 * S.car.location in public/strings.js; test/car.test.ts keeps the three lists equal.
 */
export const LOCATION_LABEL: Readonly<Record<string, string>> = {
  front: 'Voorkant',
  rear: 'Achterkant',
  left: 'Linkerkant',
  right: 'Rechterkant',
  roof: 'Dak',
  interior: 'Interieur',
  wheels_tyres: 'Wielen en banden',
  windows: 'Ruiten',
  mechanical: 'Techniek',
  other: 'Overig',
};

/** How much of a damage description goes on a lock screen. */
const MAX_DESCRIPTION = 120;

/** Somebody reported damage to the car: who, where on it and the start of what they wrote (one line, cut by code point). */
export function damageReported(p: { actor: string; location: string; description: string }): Text {
  const where = LOCATION_LABEL[p.location] ?? 'Overig';
  const what = clip(p.description.replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION);
  return { title: `${short(p.actor)} meldde schade aan de auto`, body: `${where}: ${what} Je vindt de schademelding bij Auto.` };
}
