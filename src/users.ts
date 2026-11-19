import {
  clearedSessionCookie,
  createSession,
  destroySession,
  destroyUserSessions,
  generatePassword,
  hashPassword,
  verifyDummy,
  verifyPassword,
} from './auth.ts';
import { countRows, isUniqueViolation, many, one, run, tx, type Role, type UserRow } from './db.ts';
import { HttpError, idParam, me, noContent, ok, type Ctx, type Reply, type Router } from './http.ts';
import { Fields, ValidationError } from './validate.ts';

export interface UserDto {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const ROLES = ['admin', 'member'] as const;

function readUsername(f: Fields): string | undefined {
  const raw = f.string('username', { min: 1, max: 64 });
  if (raw === undefined) return undefined;
  const username = raw.toLowerCase();
  if (!USERNAME_RE.test(username)) {
    f.fail('username', 'invalid_format');
    return undefined;
  }
  return username;
}

/** The one password policy (10 to 200 characters, kept exactly as typed). Also used by the CLI. */
export function readNewPassword(f: Fields, key: string): string | undefined {
  return f.string(key, { min: 10, max: 200, trim: false });
}

/** Store a new password hash and sign the user out everywhere, optionally keeping one session. */
export function storePassword(ctx: Ctx, userId: number, hash: string, keepSessionId?: number): void {
  tx(ctx.db, () => {
    run(ctx.db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, ctx.clock.now().toISOString(), userId);
    destroyUserSessions(ctx, userId, keepSessionId);
  });
}

export interface NewUser {
  username: string;
  displayName: string;
  password: string;
  role: Role;
}

/** Insert a user with a hashed password. Shared by the admin route, the CLI and the env bootstrap. */
export async function createUser(ctx: Ctx, input: NewUser): Promise<UserRow> {
  const f = new Fields({ username: input.username, displayName: input.displayName, password: input.password });
  const username = readUsername(f);
  const displayName = f.string('displayName', { min: 1, max: 60 });
  const password = readNewPassword(f, 'password');
  f.done();
  const hash = await hashPassword(password as string, ctx.config.scrypt);
  const now = ctx.clock.now().toISOString();
  try {
    const { lastInsertRowid } = run(
      ctx.db,
      `INSERT INTO users (username, display_name, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      username as string,
      displayName as string,
      hash,
      input.role,
      now,
      now,
    );
    return one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ?', lastInsertRowid) as UserRow;
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'username_taken', 'That username is already in use');
    throw err;
  }
}

/** Create the first admin from ADMIN_USERNAME / ADMIN_PASSWORD, only while there are no users at all. */
export async function bootstrapAdmin(ctx: Ctx): Promise<boolean> {
  const { adminUsername, adminPassword } = ctx.config;
  if (!adminUsername || !adminPassword) return false;
  if (countRows(ctx.db, 'users') > 0) return false;
  try {
    await createUser(ctx, { username: adminUsername, displayName: adminUsername, password: adminPassword, role: 'admin' });
  } catch (err) {
    // A bare "Validation failed" would crash-loop the container with no hint what to fix.
    // Field names and codes only; the password itself is never echoed.
    if (err instanceof HttpError && err.fields) {
      throw new Error(`ADMIN_USERNAME / ADMIN_PASSWORD rejected: ${JSON.stringify(err.fields)}`, { cause: err });
    }
    throw err;
  }
  ctx.log({ event: 'bootstrap.admin_created', username: adminUsername.toLowerCase() });
  return true;
}

function sessionInfo(ctx: Ctx, user: UserRow): Record<string, unknown> {
  return {
    user: toUserDto(user),
    timeZone: ctx.config.tz,
    windowMonths: ctx.config.windowMonths,
    serverTime: ctx.clock.now().toISOString(),
  };
}

function findUser(ctx: Ctx, id: number): UserRow {
  const row = one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'not_found', 'User not found');
  return row;
}

export function registerUserRoutes(router: Router, ctx: Ctx): void {
  const { db, config } = ctx;

  /** Count a sensitive attempt up front (it stays counted unless succeed() is called) or answer 429. */
  function reserveAttempt(ip: string, key: string, nowMs: number): void {
    const wait = ctx.limiter.attempt(ip, key, nowMs);
    if (wait === 0) return;
    ctx.log({ event: 'auth.rate_limited', ip });
    throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.', {
      headers: { 'Retry-After': String(wait) },
    });
  }

  router.add('POST', '/api/auth/login', 'public', async (req) => {
    const body = await req.json();
    const username = typeof body['username'] === 'string' ? body['username'].trim().toLowerCase().slice(0, 64) : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const nowMs = ctx.clock.now().getTime();
    reserveAttempt(req.ip, username, nowMs);
    const user = one<UserRow>(db, 'SELECT * FROM users WHERE username = ? AND active = 1', username);
    let good = false;
    if (password.length > 0 && password.length <= 200) {
      good = user ? await verifyPassword(password, user.password_hash) : await verifyDummy(password, config.scrypt);
    }
    if (!good || !user) {
      ctx.log({ event: 'auth.login_failed', ip: req.ip });
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    ctx.limiter.succeed(req.ip, username, nowMs);
    const { cookie } = createSession(ctx, user.id);
    ctx.log({ event: 'auth.login', userId: user.id });
    return { status: 200, body: sessionInfo(ctx, user), headers: { 'Set-Cookie': cookie } };
  });

  router.add('POST', '/api/auth/logout', 'user', async (req) => {
    destroySession(ctx, me(req).sessionId);
    return { status: 204, headers: { 'Set-Cookie': clearedSessionCookie(config) } };
  });

  router.add('GET', '/api/auth/me', 'user', (req) => {
    return ok(sessionInfo(ctx, findUser(ctx, me(req).id)));
  });

  router.add('POST', '/api/auth/password', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const current = f.string('currentPassword', { min: 1, max: 200, trim: false });
    const next = readNewPassword(f, 'newPassword');
    f.done();
    const key = `pw:${actor.username}`;
    const nowMs = ctx.clock.now().getTime();
    reserveAttempt(req.ip, key, nowMs);
    const row = findUser(ctx, actor.id);
    if (!(await verifyPassword(current as string, row.password_hash))) {
      throw new ValidationError({ currentPassword: 'incorrect' });
    }
    ctx.limiter.succeed(req.ip, key, nowMs);
    storePassword(ctx, actor.id, await hashPassword(next as string, config.scrypt), actor.sessionId);
    ctx.log({ event: 'auth.password_changed', userId: actor.id });
    return noContent();
  });

  router.add('GET', '/api/users', 'user', () => {
    const rows = many<UserRow>(db, 'SELECT * FROM users WHERE active = 1 ORDER BY display_name COLLATE NOCASE, id');
    return ok({ users: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name })) });
  });

  // ------------------------------------------------------------- admin only

  router.add('GET', '/api/admin/users', 'admin', () => {
    const rows = many<UserRow>(db, 'SELECT * FROM users ORDER BY active DESC, display_name COLLATE NOCASE, id');
    return ok({ users: rows.map(toUserDto) });
  });

  router.add('POST', '/api/admin/users', 'admin', async (req) => {
    const body = await req.json();
    const f = new Fields(body);
    const role = f.oneOf('role', ROLES, { optional: true }) ?? 'member';
    const username = readUsername(f);
    const displayName = f.string('displayName', { min: 1, max: 60 });
    const supplied = f.has('password') ? readNewPassword(f, 'password') : undefined;
    f.done();
    const generated = supplied === undefined ? generatePassword() : undefined;
    const row = await createUser(ctx, {
      username: username as string,
      displayName: displayName as string,
      password: (supplied ?? generated) as string,
      role,
    });
    ctx.log({ event: 'user.created', userId: row.id, by: req.user?.id });
    return ok({ user: toUserDto(row), ...(generated ? { generatedPassword: generated } : {}) }, 201);
  });

  router.add('PATCH', '/api/admin/users/:id', 'admin', async (req) => {
    const id = idParam(req.params['id']);
    const f = new Fields(await req.json());
    const displayName = f.string('displayName', { min: 1, max: 60, optional: true });
    const role = f.oneOf('role', ROLES, { optional: true });
    const active = f.bool('active', { optional: true });
    f.done();
    const updated = tx(db, () => {
      const row = findUser(ctx, id);
      const nextRole = role ?? row.role;
      const nextActive = active ?? row.active === 1;
      const losesAdmin = row.role === 'admin' && row.active === 1 && (nextRole !== 'admin' || !nextActive);
      if (losesAdmin) {
        const others = one<{ n: number }>(
          db,
          "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
          id,
        )?.n;
        if (!others) throw new HttpError(409, 'last_admin', 'The last active admin cannot be deactivated or demoted');
      }
      run(
        db,
        'UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?',
        displayName ?? row.display_name,
        nextRole,
        nextActive ? 1 : 0,
        ctx.clock.now().toISOString(),
        id,
      );
      if (!nextActive) {
        destroyUserSessions(ctx, id);
        // A deactivated person gets no more notifications on their devices.
        run(db, 'DELETE FROM push_subscriptions WHERE user_id = ?', id);
      }
      return findUser(ctx, id);
    });
    // The role decides who pays for fuel (admins do not, fuel.ts), so the role a person ends up with is part of the audit line.
    ctx.log({ event: 'user.updated', userId: id, by: req.user?.id, role: updated.role, active: updated.active === 1 });
    return ok({ user: toUserDto(updated) });
  });

  router.add('POST', '/api/admin/users/:id/password', 'admin', async (req): Promise<Reply> => {
    const id = idParam(req.params['id']);
    const f = new Fields(await req.json());
    const supplied = f.has('password') ? readNewPassword(f, 'password') : undefined;
    f.done();
    findUser(ctx, id);
    const generated = supplied === undefined ? generatePassword() : undefined;
    storePassword(ctx, id, await hashPassword((supplied ?? generated) as string, config.scrypt));
    ctx.log({ event: 'user.password_reset', userId: id, by: req.user?.id });
    return ok(generated ? { generatedPassword: generated } : {});
  });
}
