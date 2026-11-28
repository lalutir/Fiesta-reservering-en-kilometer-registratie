// Personal access tokens: how a household's own tools (Home Assistant, a Google Apps Script) read the app.
//
// A token belongs to one person and is made on the Account page (cookie session only: a token can never make a
// token). It is shown once, when it is created. Only its SHA-256 digest is stored, so a backup or a stolen database
// file cannot be used to call the API, and a lost token cannot be shown again, only replaced. A token works on the
// read-only /api/v1/ prefix and nowhere else (http.ts keeps the prefix and the 'token' auth level welded together),
// and a session cookie does not work there. It acts as its owner, never as an admin: the token API shows what the
// app shows that person.
//
// What a token does not get:
// - Failed attempts (a wrong, malformed or revoked token) are counted per client address, the way the login counts
//   them (an IPv6 customer is counted by its /64), in their OWN limiter, and a counted-out address gets 429 before
//   anything is looked up. A request without an Authorization header is not an attempt and is not counted.
// - One token may make 60 requests a minute; past that only that token gets 429.
// - last_used_at is written at most once an hour per token.
// - A token ends when its owner is deactivated, when an admin resets their password (revokeUserTokens), when the
//   owner or an admin revokes it. Reactivating a person does not bring tokens back. The owner changing their own
//   password does not revoke them (docs/API.md says so).
//
// Log lines carry ids and the client address only: never the token, its digest, its name or a username.
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LoginLimiter, sha256Hex } from './auth.ts';
import { many, one, run, tx, type ApiTokenRow, type Db } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Principal, type Router } from './http.ts';
import { Fields } from './validate.ts';

export const TOKEN_PREFIX = 'pat_';
export const MAX_TOKENS_PER_USER = 5;
export const TOKEN_NAME_MAX = 60;
export const TOKEN_REQUESTS_PER_MINUTE = 60;
/** Failed attempts per client address in one window (the login allows 30 per address as well). */
export const TOKEN_FAILURES_PER_ADDRESS = 30;
const LAST_USED_EVERY_MS = 3_600_000;
const REQUEST_WINDOW_MS = 60_000;
/** The failure counter is per address; this is its fixed second key (the limiter wants one, the token API has no username). */
const BEARER_KEY = 'bearer';
/** pat_ and 43 base64url characters (256 bits). */
const TOKEN_RE = /^pat_[A-Za-z0-9_-]{43}$/;

export interface TokenDto {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AdminTokenDto extends TokenDto {
  userId: number;
  userName: string;
}

const toDto = (row: ApiTokenRow): TokenDto => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at });

/** The tokens of one person die with this (deactivation, an admin password reset). Returns how many there were. */
export function revokeUserTokens(db: Db, userId: number): number {
  return run(db, 'DELETE FROM api_tokens WHERE user_id = ?', userId).changes;
}

interface TokenJoin {
  id: number;
  user_id: number;
  token_hash: string;
  last_used_at: string | null;
  username: string;
  display_name: string;
}

const unauthenticated = (): HttpError =>
  new HttpError(401, 'unauthenticated', 'A valid access token is required', { headers: { 'WWW-Authenticate': 'Bearer' } });

export interface TokenAuth {
  /** Resolve the Authorization header of a /api/v1/ request to the person it belongs to, or throw the 401 or 429. */
  authenticate(req: IncomingMessage, ip: string): Principal;
}

/**
 * The bearer check behind every 'token' route. Its failure counter is its own LoginLimiter, separate from the
 * login's and from the calendar feed's, so a stale feed address that something keeps polling cannot lock a valid
 * token out of the API, and a bad token cannot lock anybody out of the login.
 */
export function createTokenAuth(ctx: Ctx): TokenAuth {
  const { db, log } = ctx;
  const failures = new LoginLimiter(TOKEN_FAILURES_PER_ADDRESS, TOKEN_FAILURES_PER_ADDRESS);
  const windows = new Map<number, { start: number; count: number }>();

  function fail(ip: string, nowMs: number): HttpError {
    failures.fail(ip, BEARER_KEY, nowMs);
    log({ event: 'token.auth_failed', ip });
    return unauthenticated();
  }

  return {
    authenticate(req, ip) {
      const header = req.headers.authorization;
      // No header at all is not a guess: it is answered, never counted.
      if (header === undefined) throw unauthenticated();
      const nowMs = ctx.clock.now().getTime();
      const wait = failures.check(ip, BEARER_KEY, nowMs);
      if (wait > 0) {
        log({ event: 'token.rate_limited', ip });
        throw new HttpError(429, 'too_many_attempts', 'Too many failed attempts. Try again later.', { headers: { 'Retry-After': String(wait) } });
      }
      const match = /^Bearer ([^\s]+)$/i.exec(header);
      const token = match?.[1];
      if (token === undefined || !TOKEN_RE.test(token)) throw fail(ip, nowMs);

      const digest = sha256Hex(token);
      const row = one<TokenJoin>(
        db,
        `SELECT t.id, t.user_id, t.token_hash, t.last_used_at, u.username, u.display_name
           FROM api_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ? AND u.active = 1`,
        digest,
      );
      // The lookup already matched on the digest; the comparison itself is constant-time all the same.
      if (!row || !crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(digest, 'hex'))) throw fail(ip, nowMs);

      // One token, 60 requests a minute (a fixed window on the injected clock).
      let window = windows.get(row.id);
      if (!window || nowMs - window.start >= REQUEST_WINDOW_MS) {
        if (windows.size > 1000) for (const [id, w] of windows) if (nowMs - w.start >= REQUEST_WINDOW_MS) windows.delete(id);
        window = { start: nowMs, count: 0 };
        windows.set(row.id, window);
      }
      window.count++;
      if (window.count > TOKEN_REQUESTS_PER_MINUTE) {
        log({ event: 'token.rate_limited', tokenId: row.id });
        throw new HttpError(429, 'rate_limited', 'Too many requests for this token. Try again in a minute.', {
          headers: { 'Retry-After': String(Math.max(1, Math.ceil((window.start + REQUEST_WINDOW_MS - nowMs) / 1000))) },
        });
      }

      // At most one write an hour per token. A read-only GET must not take SQLite's write lock on every call (a
      // second process, such as `purge` from the CLI, may hold it for up to the 5 s busy timeout), so the hour is
      // checked on the row that was just read, and the condition stays in the statement as well. The write is
      // bookkeeping: if it fails, the request is still answered and the failure is logged (id only).
      const staleBefore = new Date(nowMs - LAST_USED_EVERY_MS).toISOString();
      if (row.last_used_at === null || row.last_used_at <= staleBefore) {
        try {
          run(db, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)', new Date(nowMs).toISOString(), row.id, staleBefore);
        } catch {
          log({ event: 'token.last_used_failed', tokenId: row.id });
        }
      }
      // Role-blind: whatever the person is in the app, their token is a member's.
      return { id: row.user_id, username: row.username, displayName: row.display_name, role: 'member', sessionId: 0, tokenId: row.id };
    },
  };
}

export function registerTokenRoutes(router: Router, ctx: Ctx): void {
  const { db, log } = ctx;

  router.add('GET', '/api/tokens', 'user', (req) => {
    const rows = many<ApiTokenRow>(db, 'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY id', me(req).id);
    return ok({ items: rows.map(toDto), max: MAX_TOKENS_PER_USER });
  });

  // Cookie session only (level 'user'): a token cannot create, list or revoke tokens.
  router.add('POST', '/api/tokens', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const name = f.string('name', { min: 1, max: TOKEN_NAME_MAX });
    if (name?.includes('\0')) f.fail('name', 'invalid_value');
    f.done();
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const nowIso = ctx.clock.now().toISOString();
    const row = tx(db, () => {
      // Counted inside the transaction, so two requests at once cannot both take the last slot.
      const have = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?', actor.id)?.n ?? 0;
      if (have >= MAX_TOKENS_PER_USER) {
        throw new HttpError(409, 'too_many_tokens', `At most ${MAX_TOKENS_PER_USER} access tokens per person`, { extra: { max: MAX_TOKENS_PER_USER } });
      }
      const { lastInsertRowid } = run(
        db,
        'INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)',
        actor.id,
        name as string,
        sha256Hex(token),
        nowIso,
      );
      return one<ApiTokenRow>(db, 'SELECT * FROM api_tokens WHERE id = ?', lastInsertRowid) as ApiTokenRow;
    });
    log({ event: 'token.created', id: row.id, userId: actor.id });
    // The only time the token is in an answer. It is not stored, so it cannot be shown again.
    return ok({ item: toDto(row), token }, 201);
  });

  router.add('DELETE', '/api/tokens/:id', 'user', (req) => {
    const actor = me(req);
    const id = idParam(req.params['id']);
    // Somebody else's token is a 404, not a 403: it does not say that the number exists.
    const { changes } = run(db, 'DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, actor.id);
    if (changes === 0) throw new HttpError(404, 'not_found', 'Token not found');
    log({ event: 'token.revoked', id, userId: actor.id, by: actor.id });
    return noContent();
  });

  // ------------------------------------------------------------- admin only

  // Every token in the household, to see which tools are connected and to cut one off. Never the token itself:
  // nobody, the admin included, can read a token back.
  router.add('GET', '/api/admin/tokens', 'admin', () => {
    const rows = many<ApiTokenRow & { user_name: string }>(
      db,
      `SELECT t.*, u.display_name AS user_name FROM api_tokens t JOIN users u ON u.id = t.user_id
        ORDER BY u.display_name COLLATE NOCASE, t.id`,
    );
    const items: AdminTokenDto[] = rows.map((r) => ({ ...toDto(r), userId: r.user_id, userName: r.user_name }));
    return ok({ items, max: MAX_TOKENS_PER_USER });
  });

  router.add('DELETE', '/api/admin/tokens/:id', 'admin', (req) => {
    const id = idParam(req.params['id']);
    const row = one<{ user_id: number }>(db, 'SELECT user_id FROM api_tokens WHERE id = ?', id);
    if (!row) throw new HttpError(404, 'not_found', 'Token not found');
    run(db, 'DELETE FROM api_tokens WHERE id = ?', id);
    log({ event: 'token.revoked', id, userId: row.user_id, by: me(req).id });
    return noContent();
  });
}
