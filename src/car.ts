// The Car tab: damage reports and the APK expiry date of the one car.
//
// Damage reports follow the traffic-ticket pattern (tickets.ts). Anyone signed in can add one and
// everybody sees all of them; the person who filed a report or an admin edits and deletes it; any member can
// mark one repaired (a repair is something anybody may have seen done). The dates are calendar days
// ('YYYY-MM-DD', see shared/time.js), not instants: the day a dent was noticed means the same day to everybody.
//
// The driver hint is NOT stored. On every read the server asks tickets.ts whoDrove() who was driving at the
// start of the noticed local day (drive log first, then an open draft, then a confirmed reservation) and, when
// that finds nobody, takes the driver of the most recent completed drive that ended before that moment. It is
// information, never blame: the screen says what it is based on, and it follows a corrected drive on the next read.
//
// The APK record is one row (id = 1) and no history table: the audit trail is the apk.updated log line. Free text
// (a description, a repair note) is never written to a log line.
//
// Retention (retention.ts): an open report is never purged, however old; a repaired one is deleted when its
// repaired date is before the first day of the window.
import { many, one, run, type ApkRow, type DamageRow, type DamageStatus, type Db } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import type { Notifier, Person } from './notify.ts';
import { whoDrove, type TicketBasis } from './tickets.ts';
import { Fields, isFutureDate, windowStartDate } from './validate.ts';
import { addDateKeyYears, daysBetween, localDateKey, startOfLocalDay } from '../shared/time.js';

/** Where on the car. The database CHECK has the same list written out (a migration never changes), and a test compares the two. */
export const LOCATIONS = ['front', 'rear', 'left', 'right', 'roof', 'interior', 'wheels_tyres', 'windows', 'mechanical', 'other'] as const;
export type Location = (typeof LOCATIONS)[number];
export const DESCRIPTION_MAX = 1000;
export const REPAIR_NOTE_MAX = 500;
/** The APK date may lie this many calendar years ahead of today (the Dutch inspection interval is at most four). */
export const APK_YEARS_AHEAD = 5;
const STATUSES: readonly DamageStatus[] = ['open', 'repaired'];

/** What the driver hint rests on: the ticket bases, plus the last drive before the day when no record covers it. */
export type HintBasis = TicketBasis | 'last_drive';

export interface DriverHint {
  /** The person the log has down; null when it has nobody. */
  driver: Person | null;
  basis: HintBasis;
}

export interface DamageDto {
  id: number;
  /** The day it was first noticed ('YYYY-MM-DD'). */
  noticedOn: string;
  /** Who noticed it; null means unknown. */
  noticedBy: Person | null;
  reportedBy: Person;
  description: string;
  location: Location;
  status: DamageStatus;
  /** The day it was repaired; null while the report is open. */
  repairedOn: string | null;
  /** '' when there is none (and always while the report is open). */
  repairNote: string;
  createdAt: string;
  updatedAt: string;
  /** Who was driving before the noticed day, worked out now. Information, not a finding of fault. */
  hint: DriverHint;
  can: { edit: boolean; delete: boolean; repair: boolean };
}

export interface ApkDto {
  /** The expiry date ('YYYY-MM-DD'); null while nobody has entered it. */
  expiresOn: string | null;
  /** Calendar days from today (household zone) to the expiry; negative when it has passed. */
  daysLeft: number | null;
  updatedBy: Person | null;
  updatedAt: string | null;
}

interface DamageJoin extends DamageRow {
  noticed_by_name: string | null;
  reported_by_name: string;
}

const SELECT_DAMAGE = `SELECT d.*, nb.display_name AS noticed_by_name, rb.display_name AS reported_by_name
  FROM damage_reports d
  LEFT JOIN users nb ON nb.id = d.noticed_by
  JOIN users rb ON rb.id = d.reported_by`;

/** Edit and delete: whoever filed the report, or an admin. */
function mayManage(actor: Principal, row: Pick<DamageRow, 'reported_by'>): boolean {
  return actor.role === 'admin' || actor.id === row.reported_by;
}

/**
 * Who was driving before a day, and what that rests on. The start of the local day goes through whoDrove();
 * a day with nobody on record falls back to the driver of the last completed drive that ended before it.
 * Drives on the day itself are not counted: the question is who had the car before it was noticed.
 */
function driverBefore(db: Db, tz: string, noticedOn: string): DriverHint {
  const dayStart = startOfLocalDay(noticedOn, tz);
  const found = whoDrove(db, dayStart);
  if (found.driver) return found;
  const last = one<Person>(
    db,
    `SELECT u.id AS id, u.display_name AS name
       FROM usage g JOIN users u ON u.id = g.user_id
      WHERE g.status = 'completed' AND g.end_utc < ?
      ORDER BY g.end_utc DESC, g.id DESC LIMIT 1`,
    dayStart,
  );
  return last ? { driver: last, basis: 'last_drive' } : { driver: null, basis: 'none' };
}

/** `hints` remembers the answer per noticed day for the length of one request: several reports often share a day. */
function toDto(db: Db, tz: string, row: DamageJoin, actor: Principal, hints: Map<string, DriverHint>): DamageDto {
  let hint = hints.get(row.noticed_on);
  if (!hint) {
    hint = driverBefore(db, tz, row.noticed_on);
    hints.set(row.noticed_on, hint);
  }
  const manage = mayManage(actor, row);
  return {
    id: row.id,
    noticedOn: row.noticed_on,
    noticedBy: row.noticed_by === null ? null : { id: row.noticed_by, name: row.noticed_by_name ?? '' },
    reportedBy: { id: row.reported_by, name: row.reported_by_name },
    description: row.description,
    location: row.location as Location,
    status: row.status,
    repairedOn: row.repaired_on,
    repairNote: row.repair_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hint,
    can: { edit: manage, delete: manage, repair: row.status === 'open' },
  };
}

function loadRow(db: Db, id: number): DamageJoin {
  const row = one<DamageJoin>(db, `${SELECT_DAMAGE} WHERE d.id = ?`, id);
  if (!row) throw new HttpError(404, 'not_found', 'Damage report not found');
  return row;
}

const isActiveUser = (db: Db, id: number): boolean => one<{ id: number }>(db, 'SELECT id FROM users WHERE id = ? AND active = 1', id) !== undefined;

/**
 * SQLite's length() stops at a NUL character, so a text made of NULs would pass the length checks and then fail
 * the table's CHECK as a 500 (odometer.ts has the same guard). Not text a person typed: a normal 422 instead.
 */
function refuseNul(f: Fields, key: string, value: string | undefined): void {
  if (value?.includes('\0')) f.fail(key, 'invalid_value');
}

/** The APK record as the screens and the token API show it: the date, the days left, who entered it. */
export function apkOf(db: Db, tz: string, now: Date): ApkDto {
  const row = one<ApkRow & { updated_by_name: string }>(
    db,
    'SELECT a.*, u.display_name AS updated_by_name FROM car_apk a JOIN users u ON u.id = a.updated_by WHERE a.id = 1',
  );
  if (!row) return { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null };
  return {
    expiresOn: row.expires_on,
    daysLeft: daysBetween(localDateKey(now, tz), row.expires_on),
    updatedBy: { id: row.updated_by, name: row.updated_by_name },
    updatedAt: row.updated_at,
  };
}

/** How many damage reports are open (the number the Start screen and the token API show). */
export function openDamageCount(db: Db): number {
  return one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM damage_reports WHERE status = 'open'")?.n ?? 0;
}

export function registerCarRoutes(router: Router, ctx: Ctx, notifier?: Notifier): void {
  const { db, config } = ctx;
  const tz = config.tz;

  const view = (actor: Principal, id: number): DamageDto => toDto(db, tz, loadRow(db, id), actor, new Map());

  // ------------------------------------------------------------ damage reports

  // Every signed-in member sees every report, including ones filed by somebody who has been deactivated since.
  // There is no cap: open reports are kept until they are repaired, and each distinct day costs four indexed lookups.
  router.add('GET', '/api/damage', 'user', (req) => {
    const actor = me(req);
    const hints = new Map<string, DriverHint>();
    const rows = many<DamageJoin>(db, `${SELECT_DAMAGE} ORDER BY d.noticed_on DESC, d.id DESC`);
    return ok({ items: rows.map((row) => toDto(db, tz, row, actor, hints)) });
  });

  router.add('POST', '/api/damage', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const noticedOn = f.date('noticedOn');
    // Absent: the reporter noticed it. null: nobody knows. A number: that person, who must be active.
    const noticedByIn = f.nullableInt('noticedBy', { min: 1 });
    const description = f.string('description', { min: 1, max: DESCRIPTION_MAX });
    refuseNul(f, 'description', description);
    const location = f.oneOf('location', LOCATIONS);
    const now = ctx.clock.now();
    if (noticedOn !== undefined && isFutureDate(noticedOn, now, tz)) f.fail('noticedOn', 'in_future');
    const noticedBy = noticedByIn === undefined ? actor.id : noticedByIn;
    if (noticedBy !== null && noticedBy !== actor.id && !isActiveUser(db, noticedBy)) f.fail('noticedBy', 'unknown_user');
    f.done();
    // reportedBy is never read from the body: it is whoever is signed in.
    const nowIso = now.toISOString();
    const id = run(
      db,
      `INSERT INTO damage_reports (noticed_on, noticed_by, reported_by, description, location, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      noticedOn as string,
      noticedBy,
      actor.id,
      description as string,
      location as string,
      nowIso,
      nowIso,
    ).lastInsertRowid;
    const created = view(actor, id);
    // Ids and the place only: never the description, which is free text about people.
    ctx.log({ event: 'damage.created', id, by: actor.id, location: created.location, basis: created.hint.basis });
    // Everybody else who is active hears of it, once. Never on edit, delete or repair.
    notifier?.emit('damage.created', () => ({ actor, report: { id, location: created.location, description: created.description } }));
    return ok({ report: created }, 201);
  });

  router.add('PATCH', '/api/damage/:id', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    // Authorize before looking at the body: somebody else's report is a 403 whatever they sent.
    if (!mayManage(actor, loadRow(db, id))) throw new HttpError(403, 'forbidden', 'Only the person who filed a damage report or an admin can change it');
    const f = new Fields(await req.json());
    // The body took time to arrive and the report may have changed meanwhile (repaired, moved to another day, deleted).
    // Merge into it as it is now, or the write below would put the old status and dates back. Nothing awaits between
    // here and the UPDATE, and the person who filed a report never changes, so the check above still stands.
    const existing = loadRow(db, id);
    const now = ctx.clock.now();

    // Absent keeps what is stored. The merged row is validated as a whole further down.
    const noticedOnIn = f.date('noticedOn', { optional: true });
    const noticedByIn = f.nullableInt('noticedBy', { min: 1 });
    const description = f.string('description', { optional: true, min: 1, max: DESCRIPTION_MAX });
    refuseNul(f, 'description', description);
    const location = f.oneOf('location', LOCATIONS, { optional: true });
    const statusIn = f.oneOf('status', STATUSES, { optional: true });
    // repairedOn: null is how an edit says "no date", which is what an open report has.
    const repairedOnSent = f.input['repairedOn'] !== undefined && f.input['repairedOn'] !== null;
    const repairedOnIn = repairedOnSent ? f.date('repairedOn') : undefined;
    const repairNoteIn = f.string('repairNote', { optional: true, max: REPAIR_NOTE_MAX });
    refuseNul(f, 'repairNote', repairNoteIn);

    // Only a date that is being changed is checked against today: an old report must stay editable.
    const noticedOn = noticedOnIn ?? existing.noticed_on;
    if (noticedOnIn !== undefined && noticedOnIn !== existing.noticed_on && isFutureDate(noticedOnIn, now, tz)) f.fail('noticedOn', 'in_future');
    // The same for the person: somebody who has been deactivated since can stay named, but cannot be newly picked.
    const noticedBy = noticedByIn === undefined ? existing.noticed_by : noticedByIn;
    if (noticedBy !== null && noticedBy !== existing.noticed_by && !isActiveUser(db, noticedBy)) f.fail('noticedBy', 'unknown_user');

    const status = statusIn ?? existing.status;
    let repairedOn: string | null = null;
    let repairNote = '';
    if (status === 'repaired') {
      repairedOn = repairedOnIn ?? existing.repaired_on;
      repairNote = repairNoteIn ?? existing.repair_note;
      // A report that is repaired has a date: null cannot take it away, and nothing stored cannot stand in for it.
      if (repairedOn === null || f.input['repairedOn'] === null) f.fail('repairedOn', 'required');
      else if (repairedOn < noticedOn) f.fail('repairedOn', 'before_noticed');
      else if (repairedOn !== existing.repaired_on) checkRepairedOn(f, repairedOn, now, tz, config.windowMonths);
      // (a repaired date that is not being changed is not checked against today or the window again)
    } else {
      // Setting a report back to open clears the date and the note; sending them with "open" is a mistake.
      if (repairedOnSent) f.fail('repairedOn', 'only_when_repaired');
      if (repairNoteIn) f.fail('repairNote', 'only_when_repaired');
    }
    f.done();

    run(
      db,
      `UPDATE damage_reports SET noticed_on = ?, noticed_by = ?, description = ?, location = ?, status = ?, repaired_on = ?, repair_note = ?, updated_at = ?
        WHERE id = ?`,
      noticedOn,
      noticedBy,
      description ?? existing.description,
      location ?? existing.location,
      status,
      repairedOn,
      repairNote,
      now.toISOString(),
      id,
    );
    const updated = view(actor, id);
    ctx.log({ event: 'damage.updated', id, by: actor.id, status, reopened: existing.status === 'repaired' && status === 'open' });
    return ok({ report: updated });
  });

  router.add('DELETE', '/api/damage/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    const existing = loadRow(db, id);
    if (!mayManage(actor, existing)) throw new HttpError(403, 'forbidden', 'Only the person who filed a damage report or an admin can delete it');
    run(db, 'DELETE FROM damage_reports WHERE id = ?', id);
    ctx.log({ event: 'damage.deleted', id, by: actor.id, status: existing.status });
    return noContent();
  });

  // Any member can say it was repaired. A second tap (or a stale screen) is a 409, so it cannot overwrite the date.
  const alreadyRepaired = (): HttpError => new HttpError(409, 'already_repaired', 'That damage report is already marked as repaired');
  router.add('POST', '/api/damage/:id/repair', 'user', async (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    // A report that is already repaired is answered without reading the body.
    if (loadRow(db, id).status === 'repaired') throw alreadyRepaired();
    const f = new Fields(await req.json());
    // Look again once the body is in: somebody may have repaired it, moved its noticed day or deleted it meanwhile, and
    // the checks below (the repaired day against the noticed day) must be made against the report as it is now.
    const existing = loadRow(db, id);
    if (existing.status === 'repaired') throw alreadyRepaired();
    const repairedOn = f.date('repairedOn');
    const repairNote = f.string('repairNote', { optional: true, max: REPAIR_NOTE_MAX }) ?? '';
    refuseNul(f, 'repairNote', repairNote);
    const now = ctx.clock.now();
    if (repairedOn !== undefined) {
      if (repairedOn < existing.noticed_on) f.fail('repairedOn', 'before_noticed');
      else checkRepairedOn(f, repairedOn, now, tz, config.windowMonths);
    }
    f.done();
    // Nothing awaits since the re-read, so this cannot find the report repaired; the condition stays as a guard so it
    // remains true if somebody adds an await above.
    const result = run(
      db,
      "UPDATE damage_reports SET status = 'repaired', repaired_on = ?, repair_note = ?, updated_at = ? WHERE id = ? AND status = 'open'",
      repairedOn as string,
      repairNote,
      now.toISOString(),
      id,
    );
    if (result.changes === 0) throw alreadyRepaired();
    ctx.log({ event: 'damage.repaired', id, by: actor.id });
    return ok({ report: view(actor, id) });
  });

  // ------------------------------------------------------------------- the APK date

  router.add('GET', '/api/car/apk', 'user', () => ok({ apk: apkOf(db, tz, ctx.clock.now()) }));

  // Any active member can enter the date when the car has been through the inspection again.
  router.add('PATCH', '/api/car/apk', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const expiresOn = f.date('expiresOn');
    const now = ctx.clock.now();
    // A past date is fine (the APK may already have expired); one many years ahead is a typo.
    if (expiresOn !== undefined && expiresOn > addDateKeyYears(localDateKey(now, tz), APK_YEARS_AHEAD)) f.fail('expiresOn', 'too_far_ahead');
    f.done();
    const before = one<{ expires_on: string }>(db, 'SELECT expires_on FROM car_apk WHERE id = 1')?.expires_on ?? null;
    run(
      db,
      `INSERT INTO car_apk (id, expires_on, updated_by, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET expires_on = excluded.expires_on, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      expiresOn as string,
      actor.id,
      now.toISOString(),
    );
    // The audit trail: who, and the old and the new date. Dates only, no free text exists here.
    ctx.log({ event: 'apk.updated', by: actor.id, from: before, to: expiresOn });
    return ok({ apk: apkOf(db, tz, now) });
  });
}

/** A repaired date must not be in the future, and not older than the window (it would be purged at once). */
function checkRepairedOn(f: Fields, repairedOn: string, now: Date, tz: string, months: number): void {
  if (isFutureDate(repairedOn, now, tz)) f.fail('repairedOn', 'in_future');
  else if (repairedOn < windowStartDate(now, tz, months)) f.fail('repairedOn', 'outside_window');
}
