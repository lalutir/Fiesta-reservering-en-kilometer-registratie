import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { loadConfig, type Clock, type Config } from '../src/config.ts';
import { openDb, run, type Db } from '../src/db.ts';
import type { Ctx } from '../src/http.ts';
import { createUser } from '../src/users.ts';
import { toB64u } from '../src/webpush.ts';
import { decryptPayload } from './webpush-peer.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const PASSWORD = 'correct-horse-battery';
export const DEFAULT_NOW = '2026-06-15T10:00:00.000Z';
/** Valid odometer readings (50 km) for a completed drive; spread into request bodies. */
export const ODO = { odometerStart: 10_000, odometerEnd: 10_050 } as const;
/** A valid odometer reading (km) for a new fill-up, which must have one; spread into request bodies as `odometer: FUEL_ODO`. */
export const FUEL_ODO = 20_000;

export interface TestClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
}

export function makeClock(iso = DEFAULT_NOW): TestClock {
  let ms = Date.parse(iso);
  return {
    now: () => new Date(ms),
    set: (next) => {
      ms = Date.parse(next);
    },
    advance: (delta) => {
      ms += delta;
    },
  };
}

/** ISO string `hours` away from the clock's current time. */
export function at(clock: Clock, hours: number): string {
  return new Date(clock.now().getTime() + hours * 3_600_000).toISOString();
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  body: Json;
}

/** Raw HTTP request (no URL normalisation, free control of every header). */
export function rawRequest(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: Json = undefined;
        if ((res.headers['content-type'] ?? '').includes('json') && text !== '') {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Cookie-jar client for the JSON API. */
export class Client {
  port: number;
  id = 0;
  cookies = new Map<string, string>();

  constructor(port: number) {
    this.port = port;
  }

  async request(method: string, target: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const h: Record<string, string> = { ...headers };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (method !== 'GET' && method !== 'HEAD' && h['Content-Type'] === undefined && h['content-type'] === undefined) {
      h['Content-Type'] = 'application/json';
    }
    if (payload !== undefined) h['Content-Length'] = String(Buffer.byteLength(payload));
    if (this.cookies.size > 0 && h['Cookie'] === undefined) {
      h['Cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const reply = await rawRequest(this.port, method, target, h, payload);
    const setCookie = reply.headers['set-cookie'] ?? [];
    for (const line of setCookie) {
      const [pair = '', ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (attrs.some((a) => a.toLowerCase() === 'max-age=0') || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return reply;
  }

  get(target: string, headers?: Record<string, string>): Promise<Reply> {
    return this.request('GET', target, undefined, headers);
  }
  post(target: string, body: unknown = {}, headers?: Record<string, string>): Promise<Reply> {
    return this.request('POST', target, body, headers);
  }
  patch(target: string, body: unknown = {}, headers?: Record<string, string>): Promise<Reply> {
    return this.request('PATCH', target, body, headers);
  }
  del(target: string, headers?: Record<string, string>): Promise<Reply> {
    return this.request('DELETE', target, undefined, headers);
  }

  login(username: string, password = PASSWORD): Promise<Reply> {
    return this.post('/api/auth/login', { username, password });
  }
}

export interface TestApp {
  app: App;
  ctx: Ctx;
  db: Db;
  config: Config;
  clock: TestClock;
  logs: Array<Record<string, unknown>>;
  dir: string;
  port: number;
  client(): Client;
  /** Create a user (cheap scrypt) and return a signed-in client. */
  signIn(username: string, role?: 'admin' | 'member'): Promise<Client>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  now?: string;
  env?: Record<string, string>;
  overrides?: Partial<Config>;
  /** Replaces the global fetch the app uses for outbound calls (push services, Tikkie). */
  fetch?: typeof fetch;
}

export interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  /** How the caller asked redirects to be handled, and whether it set a timeout signal. */
  redirect: string | undefined;
  hasSignal: boolean;
}

export interface StubFetch {
  fetch: typeof fetch;
  calls: StubCall[];
  /** Replace the scripted answer for the following calls. */
  respond(handler: (call: StubCall) => Response | Promise<Response>): void;
}

/** A fetch that records every call and answers 201 unless told otherwise. No network is ever touched. */
export function stubFetch(handler?: (call: StubCall) => Response | Promise<Response>): StubFetch {
  const calls: StubCall[] = [];
  let answer: (call: StubCall) => Response | Promise<Response> = handler ?? (() => new Response(null, { status: 201 }));
  const stub: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k.toLowerCase()] = v;
    const raw = init?.body;
    const body = raw === undefined || raw === null ? undefined : typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw as Uint8Array);
    const call: StubCall = { url: String(input), method: init?.method ?? 'GET', headers, body, redirect: init?.redirect, hasSignal: init?.signal != null };
    calls.push(call);
    return answer(call);
  };
  return { fetch: stub, calls, respond: (next) => void (answer = next) };
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-test-'));
  const config = loadConfig(
    { DATA_DIR: dir, SCRYPT_N: '1024', SCRYPT_R: '8', SCRYPT_P: '1', ...opts.env },
    opts.overrides,
  );
  const clock = makeClock(opts.now);
  const logs: Array<Record<string, unknown>> = [];
  const db = openDb(path.join(dir, 'car.db'));
  const app = createApp({ db, clock, config, log: (event) => logs.push(event), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const address = await app.listen(0, '127.0.0.1');
  const port = address.port;
  const t: TestApp = {
    app,
    ctx: app.ctx,
    db,
    config,
    clock,
    logs,
    dir,
    port,
    client: () => new Client(port),
    async signIn(username, role = 'member') {
      const row = await createUser(app.ctx, { username, displayName: username[0]!.toUpperCase() + username.slice(1), password: PASSWORD, role });
      const client = new Client(port);
      const res = await client.login(username);
      if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${res.text}`);
      client.id = row.id;
      return client;
    },
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return t;
}

export interface ReservationSeed {
  userId: number;
  createdBy?: number;
  status?: 'confirmed' | 'pending' | 'declined';
  start: string;
  end: string;
  note?: string;
}

/** Insert a reservation row directly, bypassing the API rules (for fixtures). */
export function insertReservation(t: TestApp, seed: ReservationSeed): number {
  const now = t.clock.now().toISOString();
  return run(
    t.db,
    `INSERT INTO reservations (user_id, created_by, status, start_utc, end_utc, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    seed.userId,
    seed.createdBy ?? seed.userId,
    seed.status ?? 'confirmed',
    seed.start,
    seed.end,
    seed.note ?? '',
    now,
    now,
  ).lastInsertRowid;
}

export interface UsageSeed {
  userId: number;
  start: string;
  end: string;
  odometerStart?: number | null;
  odometerEnd?: number | null;
  reservationId?: number | null;
  /** Whose kilometres these are; absent means the driver's own. 'person' needs kmUserId. */
  kmFor?: 'self' | 'person' | 'together';
  kmUserId?: number | null;
}

/** Insert a usage row directly, bypassing the API rules (for fixtures). */
export function insertUsage(t: TestApp, seed: UsageSeed): number {
  const now = t.clock.now().toISOString();
  return run(
    t.db,
    `INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, reservation_id, km_for, km_user_id, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    seed.userId,
    seed.start,
    seed.end,
    seed.odometerStart ?? null,
    seed.odometerEnd ?? null,
    seed.reservationId ?? null,
    seed.kmFor ?? 'self',
    seed.kmUserId ?? null,
    seed.userId,
    now,
    now,
  ).lastInsertRowid;
}

/** A pretend browser: a push subscription with real keys, so the messages sent to it can be decrypted. */
export interface Subscriber {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** What PushSubscription.toJSON() gives, ready to POST to /api/push/subscribe. */
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  /** The JSON message inside a push request made to this subscriber. */
  read(call: StubCall): Json;
}

export function makeSubscriber(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(9).toString('hex')}`): Subscriber {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const p256dh = toB64u(ecdh.getPublicKey());
  const auth = toB64u(authSecret);
  return {
    endpoint,
    p256dh,
    auth,
    subscription: { endpoint, keys: { p256dh, auth } },
    read: (call) => JSON.parse(decryptPayload(call.body as Buffer, ecdh.getPrivateKey(), ecdh.getPublicKey(), authSecret).toString('utf8')) as Json,
  };
}

export interface DraftSeed {
  userId: number;
  start: string;
  odometerStart?: number;
  reservationId?: number | null;
}

/** Insert an open draft (start reading only; end_utc holds the start as placeholder) directly. */
export function insertDraft(t: TestApp, seed: DraftSeed): number {
  const now = t.clock.now().toISOString();
  return run(
    t.db,
    `INSERT INTO usage (user_id, start_utc, end_utc, odometer_start, odometer_end, reservation_id, note, created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, '', ?, 'draft', ?, ?)`,
    seed.userId,
    seed.start,
    seed.start,
    seed.odometerStart ?? ODO.odometerStart,
    seed.reservationId ?? null,
    seed.userId,
    now,
    now,
  ).lastInsertRowid;
}

export interface FuelSeed {
  userId: number;
  at: string;
  millilitres?: number;
  totalCents?: number;
  /** The odometer reading; absent means none (a fill-up made before the kilometre check existed). */
  odometer?: number | null;
  note?: string;
}

/** Insert a fill-up directly, bypassing the API rules (for fixtures). Defaults: 40.000 L for 60.00, no odometer reading. */
export function insertFuel(t: TestApp, seed: FuelSeed): number {
  const now = t.clock.now().toISOString();
  return run(
    t.db,
    `INSERT INTO fuel (user_id, at_utc, millilitres, total_cents, odometer, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seed.userId,
    seed.at,
    seed.millilitres ?? 40_000,
    seed.totalCents ?? 6_000,
    seed.odometer ?? null,
    seed.note ?? '',
    seed.userId,
    now,
    now,
  ).lastInsertRowid;
}

export interface TicketSeed {
  userId: number;
  at: string;
  amountCents?: number | null;
  reason?: string;
}

/** Insert a ticket directly, bypassing the API rules (for fixtures such as an out-of-window time). */
export function insertTicket(t: TestApp, seed: TicketSeed): number {
  const now = t.clock.now().toISOString();
  return run(
    t.db,
    'INSERT INTO tickets (at_utc, amount_cents, reason, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    seed.at,
    seed.amountCents ?? null,
    seed.reason ?? '',
    seed.userId,
    now,
    now,
  ).lastInsertRowid;
}

export interface DamageSeed {
  /** Who filed it. */
  reportedBy: number;
  /** The day it was noticed ('YYYY-MM-DD'). Default 2026-06-10. */
  noticedOn?: string;
  /** Who noticed it; absent or null means unknown. */
  noticedBy?: number | null;
  description?: string;
  location?: string;
  /** The day it was repaired; setting it makes the report repaired, absent leaves it open. */
  repairedOn?: string | null;
  repairNote?: string;
}

/** Insert a damage report directly, bypassing the API rules (for fixtures such as an old or a repaired one). */
export function insertDamage(t: TestApp, seed: DamageSeed): number {
  const now = t.clock.now().toISOString();
  const repaired = seed.repairedOn !== undefined && seed.repairedOn !== null;
  return run(
    t.db,
    `INSERT INTO damage_reports (noticed_on, noticed_by, reported_by, description, location, status, repaired_on, repair_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seed.noticedOn ?? '2026-06-10',
    seed.noticedBy ?? null,
    seed.reportedBy,
    seed.description ?? 'A dent',
    seed.location ?? 'front',
    repaired ? 'repaired' : 'open',
    repaired ? (seed.repairedOn as string) : null,
    repaired ? (seed.repairNote ?? '') : '',
    now,
    now,
  ).lastInsertRowid;
}

/** Set the APK record directly, bypassing the API rules (for fixtures such as a date the API would not take). */
export function insertApk(t: TestApp, seed: { userId: number; expiresOn: string }): void {
  run(
    t.db,
    `INSERT INTO car_apk (id, expires_on, updated_by, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET expires_on = excluded.expires_on, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    seed.expiresOn,
    seed.userId,
    t.clock.now().toISOString(),
  );
}

export interface Household {
  t: TestApp;
  admin: Client;
  anna: Client;
  ben: Client;
  carla: Client;
}

/** An admin and three members, all signed in. */
export async function createHousehold(opts: TestAppOptions = {}): Promise<Household> {
  const t = await createTestApp(opts);
  const admin = await t.signIn('admin', 'admin');
  const anna = await t.signIn('anna');
  const ben = await t.signIn('ben');
  const carla = await t.signIn('carla');
  return { t, admin, anna, ben, carla };
}
