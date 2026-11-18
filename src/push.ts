// Web Push: which endpoints are acceptable, where the VAPID key lives, how a
// message is sent, and the routes a phone uses to sign up for reminders. The
// cryptography is in webpush.ts (pure); the scheduler that decides *when* to
// send is in reminders.ts.
//
// The server POSTs to a URL a signed-in member supplies, so the endpoint is
// treated as hostile input: https only, port 443, no credentials, no IP
// addresses or localhost, and the host must be one of the four push services the
// browsers actually use. Redirects are not followed and every call has a timeout.
import crypto from 'node:crypto';
import net from 'node:net';
import { getMeta, many, one, run, setMeta, tx, type Db, type PushSubscriptionRow } from './db.ts';
import { HttpError, me, noContent, ok, type Ctx, type Router } from './http.ts';
import { Fields, ValidationError } from './validate.ts';
import { encryptPayload, fromB64u, generateVapidKeys, publicKeyOf, vapidAuthorization, type VapidKeys } from './webpush.ts';

/** Exactly this host (Chrome, Edge and Android Chrome use Firebase Cloud Messaging)... */
const EXACT_HOSTS = ['fcm.googleapis.com'];
/** ...or these hosts and anything below them (Safari/iOS, Firefox, Windows). */
const SUFFIX_HOSTS = ['push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const MAX_ENDPOINT_LENGTH = 2000;
const SEND_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 1000;
const TEST_INTERVAL_MS = 60_000;

/** null when the endpoint is acceptable, otherwise the field code to report. */
export function validateEndpoint(raw: string): 'invalid_endpoint' | 'unsupported_endpoint' | null {
  if (raw.length > MAX_ENDPOINT_LENGTH) return 'invalid_endpoint';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'invalid_endpoint';
  }
  if (url.protocol !== 'https:') return 'invalid_endpoint';
  if (url.username !== '' || url.password !== '') return 'invalid_endpoint';
  if (url.port !== '' && url.port !== '443') return 'invalid_endpoint';
  const host = url.hostname;
  if (host === 'localhost' || host.startsWith('[') || net.isIP(host) !== 0) return 'invalid_endpoint';
  const allowed = EXACT_HOSTS.includes(host) || SUFFIX_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return allowed ? null : 'unsupported_endpoint';
}

const B64U_RE = /^[A-Za-z0-9_-]+$/;

/** Field codes for a subscription's keys: p256dh must be a real P-256 point, auth 16 bytes. */
export function validateKeys(p256dh: string, auth: string): { p256dh?: string; auth?: string } {
  const errors: { p256dh?: string; auth?: string } = {};
  const point = B64U_RE.test(p256dh) ? fromB64u(p256dh) : undefined;
  if (point?.length !== 65 || point[0] !== 4) errors.p256dh = 'invalid_key';
  else {
    try {
      const probe = crypto.createECDH('prime256v1');
      probe.generateKeys();
      probe.computeSecret(point);
    } catch {
      errors.p256dh = 'invalid_key';
    }
  }
  if (!B64U_RE.test(auth) || fromB64u(auth).length !== 16) errors.auth = 'invalid_key';
  return errors;
}

export type SendOutcome = 'ok' | 'gone' | 'retry' | 'rejected';

export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path the notification opens, for example "/#/usage?res=7". */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
}

export interface PushService {
  /** Push is on: not switched off, and there is a subject to identify with. */
  readonly enabled: boolean;
  /** The public key browsers subscribe with (generated on first use). */
  publicKey(): string;
  send(subscription: PushSubscriptionRow, message: PushMessage): Promise<SendOutcome>;
  subscriptionsOf(userId: number): PushSubscriptionRow[];
}

/** The VAPID key pair lives in the meta table, so subscriptions survive restarts and a restore. */
function loadVapidKeys(db: Db): VapidKeys {
  const read = (): VapidKeys | undefined => {
    const stored = getMeta(db, 'vapid_jwk');
    if (stored === undefined) return undefined;
    const privateJwk = JSON.parse(stored) as crypto.JsonWebKey;
    return { privateJwk, publicKey: publicKeyOf(privateJwk) };
  };
  const existing = read();
  if (existing) return existing;
  const fresh = generateVapidKeys();
  tx(db, () => {
    // A second process may have created one while we waited for the lock: keep the first.
    if (getMeta(db, 'vapid_jwk') === undefined) setMeta(db, 'vapid_jwk', JSON.stringify(fresh.privateJwk));
  });
  return read() as VapidKeys;
}

export function createPush(ctx: Ctx): PushService {
  const { db, config } = ctx;
  const enabled = config.pushEnabled && config.pushSubject !== undefined;
  let keys: VapidKeys | undefined;
  const vapid = (): VapidKeys => (keys ??= loadVapidKeys(db));

  return {
    enabled,
    publicKey: () => vapid().publicKey,
    subscriptionsOf: (userId) => many<PushSubscriptionRow>(db, 'SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id', userId),
    async send(subscription, message) {
      if (!enabled) return 'rejected';
      // Checked again here: a row could have been written by something other than the subscribe route.
      if (validateEndpoint(subscription.endpoint) !== null) return 'rejected';
      const payload = Buffer.from(JSON.stringify(message));
      if (payload.length > MAX_PAYLOAD_BYTES) throw new Error('Push payload too large');
      // Never log the endpoint (it is a capability URL) or keys: only the push service's host and the status.
      const host = new URL(subscription.endpoint).hostname;
      try {
        const body = encryptPayload(payload, fromB64u(subscription.p256dh), fromB64u(subscription.auth));
        const res = await ctx.fetch(subscription.endpoint, {
          method: 'POST',
          headers: {
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '3600',
            Urgency: 'normal',
            Authorization: vapidAuthorization(subscription.endpoint, config.pushSubject as string, vapid(), ctx.clock.now().getTime()),
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        const status = res.status;
        // The answer body is never read: a push service has nothing we need in it.
        void res.body?.cancel().catch(() => undefined);
        if (status === 200 || status === 201 || status === 202) return 'ok';
        if (status === 404 || status === 410) {
          run(db, 'DELETE FROM push_subscriptions WHERE id = ?', subscription.id);
          ctx.log({ event: 'push.subscription_gone', host, status });
          return 'gone';
        }
        ctx.log({ event: 'push.send_failed', host, status });
        return status === 429 || status >= 500 ? 'retry' : 'rejected';
      } catch (err) {
        ctx.log({ event: 'push.send_failed', host, status: 0, reason: err instanceof Error ? err.name : 'error' });
        return 'retry';
      }
    },
  };
}

// ------------------------------------------------------------------- routes

export function registerPushRoutes(router: Router, ctx: Ctx, push: PushService): void {
  const { db } = ctx;
  const lastTest = new Map<number, number>();

  router.add('GET', '/api/push/key', 'user', () => {
    return ok(push.enabled ? { enabled: true, publicKey: push.publicKey() } : { enabled: false });
  });

  router.add('POST', '/api/push/subscribe', 'user', async (req) => {
    const actor = me(req);
    const body = await req.json();
    if (!push.enabled) throw new HttpError(409, 'push_disabled', 'Reminders are switched off on this server');
    const keysInput = body['keys'] !== null && typeof body['keys'] === 'object' && !Array.isArray(body['keys']) ? (body['keys'] as Record<string, unknown>) : {};
    const f = new Fields({ endpoint: body['endpoint'], p256dh: keysInput['p256dh'], auth: keysInput['auth'] });
    const endpoint = f.string('endpoint', { min: 1, max: MAX_ENDPOINT_LENGTH, trim: false });
    const p256dh = f.string('p256dh', { min: 1, max: 200, trim: false });
    const auth = f.string('auth', { min: 1, max: 100, trim: false });
    f.done();
    const problems: Record<string, string> = {};
    const endpointProblem = validateEndpoint(endpoint as string);
    if (endpointProblem) problems['endpoint'] = endpointProblem;
    Object.assign(problems, validateKeys(p256dh as string, auth as string));
    if (Object.keys(problems).length > 0) throw new ValidationError(problems);

    const nowIso = ctx.clock.now().toISOString();
    tx(db, () => {
      const known = one<{ user_id: number }>(db, 'SELECT user_id FROM push_subscriptions WHERE endpoint = ?', endpoint as string);
      if (known?.user_id !== actor.id) {
        const mine = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', actor.id)?.n ?? 0;
        if (mine >= MAX_SUBSCRIPTIONS_PER_USER) {
          throw new HttpError(409, 'too_many_subscriptions', `At most ${MAX_SUBSCRIPTIONS_PER_USER} devices can get reminders per person`);
        }
      }
      // A device that signs in as someone else takes the subscription over: it belongs to whoever uses the device now.
      run(
        db,
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
        actor.id,
        endpoint as string,
        p256dh as string,
        auth as string,
        nowIso,
      );
    });
    ctx.log({ event: 'push.subscribed', userId: actor.id, host: new URL(endpoint as string).hostname });
    return ok({ subscribed: true, devices: push.subscriptionsOf(actor.id).length }, 201);
  });

  router.add('POST', '/api/push/unsubscribe', 'user', async (req) => {
    const actor = me(req);
    const f = new Fields(await req.json());
    const endpoint = f.string('endpoint', { min: 1, max: MAX_ENDPOINT_LENGTH, trim: false });
    f.done();
    // Own subscriptions only; the answer is the same whether or not there was one.
    run(db, 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint as string, actor.id);
    ctx.log({ event: 'push.unsubscribed', userId: actor.id });
    return noContent();
  });

  // A way for the owner to see that delivery really works on their own phone; real delivery cannot be tested from the server.
  router.add('POST', '/api/push/test', 'user', async (req) => {
    const actor = me(req);
    await req.json();
    if (!push.enabled) throw new HttpError(409, 'push_disabled', 'Reminders are switched off on this server');
    const nowMs = ctx.clock.now().getTime();
    const last = lastTest.get(actor.id);
    if (last !== undefined && nowMs - last < TEST_INTERVAL_MS) {
      throw new HttpError(429, 'too_many_attempts', 'Wait a minute before sending another test', {
        headers: { 'Retry-After': String(Math.ceil((TEST_INTERVAL_MS - (nowMs - last)) / 1000)) },
      });
    }
    const subs = push.subscriptionsOf(actor.id);
    if (subs.length === 0) throw new HttpError(409, 'no_subscription', 'No device of yours is signed up for reminders');
    lastTest.set(actor.id, nowMs);
    let sent = 0;
    for (const sub of subs) {
      const outcome = await push.send(sub, { title: 'Test notification', body: 'Reminders work on this device.', url: '/#/account', tag: 'test' });
      if (outcome === 'ok') sent++;
    }
    return ok({ sent, devices: subs.length });
  });
}
