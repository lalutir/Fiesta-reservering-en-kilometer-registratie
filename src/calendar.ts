// The private calendar feed: an .ics address per person that a calendar app (Google, Apple, Outlook) can subscribe to.
//
// The address is the only credential. It carries a 256-bit secret, so it is as private as the link a person
// shares it through, and the person makes it, copies it, replaces it and turns it off on the Account page (cookie
// session, 'user' level). Everything about handling a secret that lives in a URL is here:
//   - It is never written down by the app: the access log goes through logPath() (http.ts), a log line never holds a
//     request header or body, and no error message contains it. The Caddyfile redacts it from anything Caddy logs.
//   - The answer is Cache-Control: no-store with Referrer-Policy: no-referrer (applySecurityHeaders), and the
//     service worker never touches /api/ (public/sw.js).
//   - Every miss (a secret that was never made, one that was replaced, one of a deactivated person, one of the wrong
//     shape) is the same 404 as any other unknown path, byte for byte, and counts against the address in a limiter of
//     its own (30 per 15 minutes, keyed like the login), checked before the lookup. The counter is separate from the
//     login's and from the token API's, so a stale address that something keeps polling locks nobody out of anything else.
//   - The secret is stored readable (the Account page shows the address again) next to its SHA-256 digest, which is
//     how a request finds it; the comparison is constant-time. A backup therefore holds feed secrets in plain text
//     (docs/DEPLOYMENT.md): replace the links after a backup got into the wrong hands.
//
// What the feed lists: every confirmed reservation in the Agenda window, and the person's OWN suggestions that are
// still waiting (as target or as suggester, not yet started) as TENTATIVE. Declined, lapsed and deleted ones are not
// there. Summary and times only: never a note. The body is the same for every fetch until the data changes, so its
// SHA-256 is a strong ETag and If-None-Match gets a 304.
import crypto from 'node:crypto';
import { LoginLimiter, sha256Hex } from './auth.ts';
import { CALENDAR_NAME, confirmedSummary, tentativeSummary } from './calendar-texts.ts';
import { many, one, run, type CalendarFeedRow, type Db } from './db.ts';
import { HttpError, me, noContent, ok, type Ctx, type Reply, type Req, type Router } from './http.ts';
import { buildIcs, type IcsEvent } from './ics.ts';
import { windowBounds } from './validate.ts';

/** The path of a feed: /api/calendar/<43 characters>.ics. */
export const FEED_PREFIX = '/api/calendar/';
const FILE_RE = /^([A-Za-z0-9_-]{43})\.ics$/;
export const FEED_FAILURES_PER_ADDRESS = 30;
/** The second key of the failure counter (the limiter wants one; the feed has no username). */
const FEED_KEY = 'feed';
const PRODID = '-//Gedeelde auto//Agendafeed//NL';
/** Calendar apps are asked to look again after this long (Google Calendar looks about once a day whatever it says). */
export const REFRESH_HOURS = 1;

export interface FeedDto {
  /** Where the feed is, as a path on this server. The page adds the address of the site (always https). */
  path: string;
  createdAt: string;
}

const feedDto = (row: CalendarFeedRow): FeedDto => ({ path: `${FEED_PREFIX}${row.secret}.ics`, createdAt: row.created_at });

interface FeedReservation {
  id: number;
  status: 'confirmed' | 'pending';
  start_utc: string;
  end_utc: string;
  updated_at: string;
  user_name: string;
}

/** The events one person's feed lists at `now`: see the top of this file. */
export function feedEvents(db: Db, userId: number, now: Date, tz: string, months: number): IcsEvent[] {
  const { from, to } = windowBounds(now, tz, months);
  const rows = many<FeedReservation>(
    db,
    `SELECT r.id, r.status, r.start_utc, r.end_utc, r.updated_at, u.display_name AS user_name
       FROM reservations r JOIN users u ON u.id = r.user_id
      WHERE r.end_utc >= ? AND r.start_utc <= ?
        AND (r.status = 'confirmed'
             OR (r.status = 'pending' AND r.start_utc > ? AND (r.user_id = ? OR r.created_by = ?)))
      ORDER BY r.start_utc, r.id`,
    from,
    to,
    now.toISOString(),
    userId,
    userId,
  );
  return rows.map((r) => ({
    uid: `reservation-${r.id}@gedeelde-auto`,
    summary: r.status === 'confirmed' ? confirmedSummary(r.user_name) : tentativeSummary(r.user_name),
    start: r.start_utc,
    end: r.end_utc,
    modified: r.updated_at,
    status: r.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE',
  }));
}

/** The .ics text for one person at `now`. */
export function feedBody(db: Db, userId: number, now: Date, tz: string, months: number): string {
  return buildIcs({ name: CALENDAR_NAME, prodId: PRODID, refreshHours: REFRESH_HOURS, events: feedEvents(db, userId, now, tz, months) });
}

/** A strong ETag: the digest of the body, in quotes. */
export const etagOf = (body: string): string => `"${sha256Hex(body).slice(0, 32)}"`;

/**
 * Does an If-None-Match header match this ETag? A list of tags, `*` and weak tags (W/"x", compared weakly as
 * the RFC says for GET and HEAD) all count; anything that is not a tag is ignored.
 */
export function ifNoneMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const text = Array.isArray(header) ? header.join(',') : header;
  if (text.trim() === '*') return true;
  return [...text.matchAll(/(?:W\/)?"[^"]*"/g)].some((m) => m[0].replace(/^W\//, '') === etag);
}

/** Replace the feed rows of a person (a new secret) or create the first one. Returns the stored row. */
function storeFeed(db: Db, userId: number, nowIso: string): CalendarFeedRow {
  const secret = crypto.randomBytes(32).toString('base64url');
  run(
    db,
    `INSERT INTO calendar_feeds (user_id, secret, secret_hash, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, secret_hash = excluded.secret_hash, created_at = excluded.created_at`,
    userId,
    secret,
    sha256Hex(secret),
    nowIso,
  );
  return one<CalendarFeedRow>(db, 'SELECT * FROM calendar_feeds WHERE user_id = ?', userId) as CalendarFeedRow;
}

export function registerCalendarRoutes(router: Router, ctx: Ctx): void {
  const { db, log, config } = ctx;
  const failures = new LoginLimiter(FEED_FAILURES_PER_ADDRESS, FEED_FAILURES_PER_ADDRESS);

  // ------------------------------------------------- the person's own link (cookie session)

  const current = (userId: number): CalendarFeedRow | undefined => one<CalendarFeedRow>(db, 'SELECT * FROM calendar_feeds WHERE user_id = ?', userId);

  // No link yet is an answer, not an error: the Account page asks on every visit.
  router.add('GET', '/api/calendar-feed', 'user', (req) => {
    const row = current(me(req).id);
    return ok({ feed: row ? feedDto(row) : null });
  });

  // Idempotent: asking for a link when there is one returns it, so a double tap cannot replace the one just copied.
  router.add('POST', '/api/calendar-feed', 'user', (req) => {
    const actor = me(req);
    const existing = current(actor.id);
    if (existing) return ok({ feed: feedDto(existing) });
    const row = storeFeed(db, actor.id, ctx.clock.now().toISOString());
    log({ event: 'calendar.created', userId: actor.id });
    return ok({ feed: feedDto(row) }, 201);
  });

  // A new secret: the old address stops working at once.
  router.add('POST', '/api/calendar-feed/new-link', 'user', (req) => {
    const actor = me(req);
    const row = storeFeed(db, actor.id, ctx.clock.now().toISOString());
    log({ event: 'calendar.regenerated', userId: actor.id });
    return ok({ feed: feedDto(row) }, 201);
  });

  router.add('DELETE', '/api/calendar-feed', 'user', (req) => {
    const actor = me(req);
    const { changes } = run(db, 'DELETE FROM calendar_feeds WHERE user_id = ?', actor.id);
    if (changes > 0) log({ event: 'calendar.deleted', userId: actor.id });
    return noContent();
  });

  // ---------------------------------------------------------------- the feed itself (public)

  // The same answer for every kind of miss: this is the one 404 of the whole API, down to the byte.
  const miss = (ip: string, nowMs: number): HttpError => {
    failures.fail(ip, FEED_KEY, nowMs);
    log({ event: 'calendar.miss', ip });
    return new HttpError(404, 'not_found', 'Not found');
  };

  function serveFeed(req: Req): Reply {
    const nowMs = ctx.clock.now().getTime();
    // Counted-out addresses are turned away before anything is looked up.
    const wait = failures.check(req.ip, FEED_KEY, nowMs);
    if (wait > 0) {
      log({ event: 'calendar.rate_limited', ip: req.ip });
      throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.', { headers: { 'Retry-After': String(wait) } });
    }
    const secret = FILE_RE.exec(req.params['file'] ?? '')?.[1];
    if (secret === undefined) throw miss(req.ip, nowMs);
    const digest = sha256Hex(secret);
    const row = one<CalendarFeedRow>(
      db,
      `SELECT f.* FROM calendar_feeds f JOIN users u ON u.id = f.user_id WHERE f.secret_hash = ? AND u.active = 1`,
      digest,
    );
    if (!row || row.secret.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(row.secret), Buffer.from(secret))) throw miss(req.ip, nowMs);

    const now = ctx.clock.now();
    const body = feedBody(db, row.user_id, now, config.tz, config.windowMonths);
    const etag = etagOf(body);
    const headers: Record<string, string> = {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="gedeelde-auto.ics"',
      ETag: etag,
    };
    if (ifNoneMatches(req.headers['if-none-match'], etag)) return { status: 304, headers, raw: Buffer.alloc(0) };
    const bytes = Buffer.from(body, 'utf8');
    // HEAD: the length of the body that a GET would send, and no body.
    if (req.method === 'HEAD') return { status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) }, raw: Buffer.alloc(0) };
    return { status: 200, headers, raw: bytes };
  }

  router.add('GET', `${FEED_PREFIX}:file`, 'public', serveFeed);
  router.add('HEAD', `${FEED_PREFIX}:file`, 'public', serveFeed);
}
