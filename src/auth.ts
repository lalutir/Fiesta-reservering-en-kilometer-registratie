import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Config, ScryptParams } from './config.ts';
import { one, run, type Role } from './db.ts';
import { parseCookies, serializeCookie, type Ctx, type Principal } from './http.ts';

// ---------------------------------------------------------------- passwords

const KEYLEN = 32;
const MAX_CONCURRENT_HASHES = 2;
/** Hard caps for parameters read back from a stored hash. */
const MAX_N = 2 ** 16;
const MAX_R = 16;
const MAX_P = 16;

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // The finishing task hands its slot straight to us, so `active` stays put.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const hashGate = new Semaphore(MAX_CONCURRENT_HASHES);

function scryptKey(password: string, salt: Buffer, p: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must be passed explicitly: the default 32 MiB throws at N = 2^15.
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      KEYLEN,
      { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Format: scrypt$N$r$p$saltBase64$hashBase64 (parameters travel with the hash). */
export function hashPassword(password: string, params: ScryptParams): Promise<string> {
  return hashGate.run(async () => {
    const salt = crypto.randomBytes(16);
    const key = await scryptKey(password, salt, params);
    return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
  });
}

export function parseHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined;
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return undefined;
  const salt = Buffer.from(parts[4] as string, 'base64');
  const key = Buffer.from(parts[5] as string, 'base64');
  if (salt.length < 8 || key.length !== KEYLEN) return undefined;
  return { params: { N, r, p }, salt, key };
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return Promise.resolve(false);
  return hashGate.run(async () => {
    const key = await scryptKey(password, parsed.salt, parsed.params);
    return crypto.timingSafeEqual(key, parsed.key);
  });
}

const dummyHashes = new Map<string, Promise<string>>();

/** Burn the same time as a real verification (unknown or deactivated user). */
export async function verifyDummy(password: string, params: ScryptParams): Promise<false> {
  const id = `${params.N}/${params.r}/${params.p}`;
  let hash = dummyHashes.get(id);
  if (!hash) {
    hash = hashPassword(crypto.randomBytes(18).toString('base64'), params);
    dummyHashes.set(id, hash);
  }
  await verifyPassword(password, await hash);
  return false;
}

export function generatePassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

// ------------------------------------------------------------ rate limiting

/**
 * The key the login throttle counts a client under. One IPv6 customer controls a
 * whole /64 (2^64 addresses), so counting full addresses would let a single
 * machine rotate its source address and never hit a limit: IPv6 clients are
 * counted by their /64 prefix instead. IPv4 and IPv4-mapped addresses are keyed
 * as the plain IPv4 address; anything else (such as "unknown") is left alone.
 * Idempotent, so an already collapsed key maps to itself.
 */
export function throttleAddress(ip: string): string {
  const bare = ip.split('%')[0] as string; // an IPv6 zone id is not part of the address
  if (!net.isIPv6(bare)) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1] as string;
  if (bare.includes('.')) return bare; // other embedded-IPv4 notations: keep the exact address
  const halves = bare.toLowerCase().split('::');
  const head = halves[0] ? (halves[0] as string).split(':') : [];
  const tail = halves.length > 1 && halves[1] ? (halves[1] as string).split(':') : [];
  const groups =
    halves.length > 1 ? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0'), ...tail] : head;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * In-memory login throttle on the injected clock: 5 failures per 15 minutes per
 * ip + username and 30 per ip. Checked before any password hashing happens.
 * Clients are keyed with throttleAddress(): IPv6 by /64, IPv4 by address.
 */
export class LoginLimiter {
  private perKey = new Map<string, number[]>();
  private perIp = new Map<string, number[]>();
  readonly windowMs = 15 * 60_000;
  readonly maxPerKey = 5;
  readonly maxPerIp = 30;

  private recent(map: Map<string, number[]>, key: string, now: number): number[] {
    const list = (map.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length === 0) map.delete(key);
    else map.set(key, list);
    return list;
  }

  private sweep(map: Map<string, number[]>, now: number): void {
    if (map.size < 5000) return;
    for (const key of [...map.keys()]) this.recent(map, key, now);
  }

  /** Seconds the caller must wait, or 0 when the attempt may proceed. */
  check(rawIp: string, username: string, now: number): number {
    const ip = throttleAddress(rawIp);
    const byKey = this.recent(this.perKey, `${ip}|${username}`, now);
    const byIp = this.recent(this.perIp, ip, now);
    let wait = 0;
    if (byKey.length >= this.maxPerKey) wait = Math.max(wait, (byKey[0] as number) + this.windowMs - now);
    if (byIp.length >= this.maxPerIp) wait = Math.max(wait, (byIp[0] as number) + this.windowMs - now);
    return wait > 0 ? Math.max(1, Math.ceil(wait / 1000)) : 0;
  }

  fail(rawIp: string, username: string, now: number): void {
    const ip = throttleAddress(rawIp);
    this.sweep(this.perKey, now);
    this.sweep(this.perIp, now);
    const key = `${ip}|${username}`;
    this.perKey.set(key, [...this.recent(this.perKey, key, now), now]);
    this.perIp.set(ip, [...this.recent(this.perIp, ip, now), now]);
  }

  /** A successful login clears the per-username counter (not the per-ip one). */
  reset(rawIp: string, username: string): void {
    this.perKey.delete(`${throttleAddress(rawIp)}|${username}`);
  }

  /**
   * check() and fail() in one synchronous step. Handlers call this BEFORE the
   * slow awaited password check: a burst of parallel guesses is then counted as
   * it arrives. (Recording the failure only after the hash finished let every
   * request in the burst pass check() first.) Returns the wait in seconds; when
   * it is 0 the attempt is on the books until succeed() takes it off again.
   */
  attempt(ip: string, username: string, now: number): number {
    const wait = this.check(ip, username, now);
    if (wait === 0) this.fail(ip, username, now);
    return wait;
  }

  /**
   * The reserved attempt turned out to be right: clear the per-username counter
   * and give this attempt's own per-ip slot back. Earlier failures from the
   * address keep counting, so a valid login never launders guesses.
   */
  succeed(rawIp: string, username: string, now: number): void {
    const ip = throttleAddress(rawIp);
    this.reset(ip, username);
    const list = this.perIp.get(ip);
    const i = list ? list.lastIndexOf(now) : -1;
    if (list && i >= 0) {
      list.splice(i, 1);
      if (list.length === 0) this.perIp.delete(ip);
    }
  }
}

// ----------------------------------------------------------------- sessions

export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
const REFRESH_AFTER_MS = 24 * 3600 * 1000;

export function sessionCookieName(config: Config): string {
  return config.cookieSecure ? '__Host-sid' : 'sid';
}

export function sessionCookie(config: Config, token: string): string {
  return serializeCookie(sessionCookieName(config), token, SESSION_MAX_AGE_S, config.cookieSecure);
}

export function clearedSessionCookie(config: Config): string {
  return serializeCookie(sessionCookieName(config), '', 0, config.cookieSecure);
}

const sessionExpiry = (now: Date): string => new Date(now.getTime() + SESSION_MAX_AGE_S * 1000).toISOString();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(ctx: Ctx, userId: number): { token: string; cookie: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  run(
    ctx.db,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)',
    hashToken(token),
    userId,
    nowIso,
    sessionExpiry(now),
    nowIso,
  );
  return { token, cookie: sessionCookie(ctx.config, token) };
}

interface SessionJoin {
  session_id: number;
  refreshed_at: string;
  id: number;
  username: string;
  display_name: string;
  role: Role;
}

/** Resolve the session cookie to an active user, extending the session at most once a day. */
export function authenticate(ctx: Ctx, req: IncomingMessage): Principal | null {
  const token = parseCookies(req.headers.cookie)[sessionCookieName(ctx.config)];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  const row = one<SessionJoin>(
    ctx.db,
    `SELECT s.id AS session_id, s.refreshed_at, u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1 AND s.expires_at > ?`,
    hashToken(token),
    nowIso,
  );
  if (!row) return null;
  const principal: Principal = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    sessionId: row.session_id,
  };
  if (Date.parse(row.refreshed_at) <= now.getTime() - REFRESH_AFTER_MS) {
    run(ctx.db, 'UPDATE sessions SET expires_at = ?, refreshed_at = ? WHERE id = ?', sessionExpiry(now), nowIso, row.session_id);
    principal.setCookie = sessionCookie(ctx.config, token);
  }
  return principal;
}

export function destroySession(ctx: Ctx, sessionId: number): void {
  run(ctx.db, 'DELETE FROM sessions WHERE id = ?', sessionId);
}

/** Delete all sessions of a user, optionally keeping one (the current one). */
export function destroyUserSessions(ctx: Ctx, userId: number, exceptSessionId?: number): void {
  run(ctx.db, 'DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptSessionId ?? -1);
}
