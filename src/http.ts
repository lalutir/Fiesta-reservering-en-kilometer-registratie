import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Clock, Config } from './config.ts';
import type { Db, Role } from './db.ts';
import type { LoginLimiter } from './auth.ts';

export type Logger = (event: Record<string, unknown>) => void;

/** Everything a route handler needs; created once in createApp. */
export interface Ctx {
  db: Db;
  clock: Clock;
  config: Config;
  log: Logger;
  limiter: LoginLimiter;
}

export interface Principal {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  sessionId: number;
  /** Set when the session was just extended; the router adds it to the reply. */
  setCookie?: string;
}

export class HttpError extends Error {
  status: number;
  code: string;
  fields: Record<string, string> | undefined;
  extra: Record<string, unknown> | undefined;
  headers: Record<string, string> | undefined;

  constructor(
    status: number,
    code: string,
    message: string = code,
    opts: { fields?: Record<string, string>; extra?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = opts.fields;
    this.extra = opts.extra;
    this.headers = opts.headers;
  }
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export const ok = (body: unknown, status = 200): Reply => ({ status, body });
export const noContent = (): Reply => ({ status: 204 });

export type AuthLevel = 'public' | 'user' | 'admin';

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  cookies: Record<string, string>;
  ip: string;
  user: Principal | null;
  /** Parsed JSON object body ({} when empty). Enforces size, type and syntax. */
  json(): Promise<Record<string, unknown>>;
}

/** The signed-in user on a 'user' or 'admin' route; the router has already turned anonymous callers away. */
export const me = (req: Req): Principal => req.user as Principal;

export type Handler = (req: Req) => Reply | Promise<Reply>;

export interface RouteInfo {
  method: string;
  pattern: string;
  auth: AuthLevel;
}

interface Route extends RouteInfo {
  segments: string[];
  handler: Handler;
}

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Route table. Authentication is enforced here, before the handler runs, so a
 * handler can never forget it. `routes` is exposed so tests can sweep it.
 */
export class Router {
  readonly routes: RouteInfo[] = [];
  private entries: Route[] = [];
  private authenticate: (req: IncomingMessage) => Principal | null;
  private trustProxy: boolean;

  constructor(authenticate: (req: IncomingMessage) => Principal | null, trustProxy: boolean) {
    this.authenticate = authenticate;
    this.trustProxy = trustProxy;
  }

  add(method: string, pattern: string, auth: AuthLevel, handler: Handler): void {
    const info: RouteInfo = { method, pattern, auth };
    this.routes.push(info);
    this.entries.push({ ...info, segments: pattern.split('/').filter(Boolean), handler });
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.entries) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let good = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i] as string;
        const part = parts[i] as string;
        if (seg.startsWith(':')) params[seg.slice(1)] = part;
        else if (seg !== part) {
          good = false;
          break;
        }
      }
      if (good) return { route, params };
    }
    return undefined;
  }

  async dispatch(req: IncomingMessage, path: string, query: URLSearchParams): Promise<Reply> {
    const method = req.method ?? 'GET';
    const found = this.match(method, path);
    if (!found) throw new HttpError(404, 'not_found', 'Not found');
    const { route, params } = found;
    let user: Principal | null = null;
    if (route.auth !== 'public') {
      user = this.authenticate(req);
      if (!user) throw new HttpError(401, 'unauthenticated', 'Authentication required');
      if (route.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Admin only');
    }
    const request: Req = {
      method,
      path,
      query,
      params,
      headers: req.headers,
      cookies: parseCookies(req.headers.cookie),
      ip: clientIp(req, this.trustProxy),
      user,
      json: () => readJson(req),
    };
    const reply = await route.handler(request);
    if (user?.setCookie) {
      const existing = reply.headers?.['Set-Cookie'];
      const cookies = Array.isArray(existing) ? existing : existing ? [existing] : [];
      return { ...reply, headers: { ...reply.headers, 'Set-Cookie': [...cookies, user.setCookie] } };
    }
    return reply;
  }
}

/** Positive integer id from a path segment; anything else is a 404. */
export function idParam(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d{0,14}$/.test(raw)) throw new HttpError(404, 'not_found', 'Not found');
  return Number(raw);
}

const contentType = (req: IncomingMessage): string | undefined =>
  (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
const notJson = (): HttpError => new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
const tooLarge = (): HttpError =>
  new HttpError(413, 'payload_too_large', 'Request body too large', { headers: { Connection: 'close' } });

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (contentType(req) !== 'application/json') throw notJson();
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'bad_json', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name === '' || name in out) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    out[name] = value;
  }
  return out;
}

/** The app's only cookie: site-wide (the __Host- prefix needs Path=/), HttpOnly and SameSite=Lax. */
export function serializeCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return [`${name}=${value}`, 'Path=/', `Max-Age=${Math.floor(maxAge)}`, 'HttpOnly', ...(secure ? ['Secure'] : []), 'SameSite=Lax'].join('; ');
}

/**
 * Client address. X-Forwarded-For is only honoured when TRUST_PROXY is set
 * (the app sits behind Caddy), and then only its last entry, which is the one
 * the trusted proxy appended.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    const last = raw?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function applySecurityHeaders(res: ServerResponse, isApi: boolean): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isApi) res.setHeader('Cache-Control', 'no-store');
}

/**
 * CSRF defence for state-changing requests. Browsers cannot send
 * application/json cross-origin without a preflight, which this server never
 * answers; on top of that the Fetch-Metadata and Origin headers are checked
 * when the browser supplies them.
 */
export function checkCsrf(req: IncomingMessage): void {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') {
    throw new HttpError(403, 'csrf', 'Cross-site request rejected');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host: string | undefined;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      host = undefined;
    }
    if (host === undefined || host !== (req.headers.host ?? '').toLowerCase()) {
      throw new HttpError(403, 'csrf', 'Origin does not match host');
    }
  }
  if (contentType(req) !== 'application/json') throw notJson();
}

export function sendReply(res: ServerResponse, reply: Reply): void {
  for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
  if (reply.body === undefined || reply.status === 204) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(reply.body), 'utf8');
  res.writeHead(reply.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

export function errorReply(err: HttpError): Reply {
  return {
    status: err.status,
    headers: err.headers ?? {},
    body: { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}), ...err.extra } },
  };
}
