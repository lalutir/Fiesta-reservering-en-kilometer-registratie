import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LoginLimiter, authenticate } from './auth.ts';
import type { Clock, Config } from './config.ts';
import type { Db } from './db.ts';
import {
  HttpError,
  Router,
  applySecurityHeaders,
  checkCsrf,
  clientIp,
  errorReply,
  ok,
  sendReply,
  type Ctx,
  type Logger,
} from './http.ts';
import { registerFuelRoutes } from './fuel.ts';
import { startMaintenance, tick } from './maintenance.ts';
import { createNotifier } from './notify.ts';
import { registerOdometerRoutes } from './odometer.ts';
import { createPush, registerPushRoutes } from './push.ts';
import { createReminders, type Reminders } from './reminders.ts';
import { registerReservationRoutes } from './reservations.ts';
import { registerRetentionRoutes } from './retention.ts';
import { serveStatic } from './static.ts';
import { registerTicketRoutes } from './tickets.ts';
import { registerUsageRoutes } from './usage.ts';
import { registerUserRoutes } from './users.ts';

export interface AppDeps {
  db: Db;
  clock: Clock;
  config: Config;
  log: Logger;
  /** Outbound HTTP; defaults to the global fetch. Tests pass a stub so nothing leaves the machine. */
  fetch?: typeof fetch;
}

export interface App {
  server: http.Server;
  ctx: Ctx;
  router: Router;
  listen(port?: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
  /** Resolves when background work started by requests (the push notifications for what somebody else changed) has finished. */
  idle(): Promise<void>;
  /** The daily purge and backup. Nothing runs until start() is called (by server.ts). */
  maintenance: { tick(): boolean; start(): { stop(): void } };
  /** The push reminder scheduler. Nothing runs until start() is called (by server.ts). */
  reminders: Reminders;
}

/**
 * Wire the routes and the request pipeline:
 * security headers -> CSRF -> API router or static files -> error mapper -> access log.
 * No timers are created here.
 */
export function createApp(deps: AppDeps): App {
  const ctx: Ctx = { ...deps, fetch: deps.fetch ?? globalThis.fetch, limiter: new LoginLimiter() };
  const { config, log } = ctx;
  const router = new Router((req) => authenticate(ctx, req), config.trustProxy);

  router.add('GET', '/api/health', 'public', () => {
    ctx.db.prepare('SELECT 1').get();
    return ok({ status: 'ok' });
  });
  const push = createPush(ctx);
  // One notifier for everything somebody else enters, changes or removes on a person's behalf (notify.ts).
  const notifier = createNotifier(ctx, push);
  registerUserRoutes(router, ctx);
  registerReservationRoutes(router, ctx, notifier);
  registerUsageRoutes(router, ctx, notifier);
  registerFuelRoutes(router, ctx, notifier);
  registerTicketRoutes(router, ctx, notifier);
  registerOdometerRoutes(router, ctx);
  registerPushRoutes(router, ctx, push);
  const reminders = createReminders(ctx, push);
  registerRetentionRoutes(router, ctx);

  // The stack goes to the server log only, never to the client.
  function logError(err: unknown, rid?: string): void {
    log({ event: 'error', rid, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  }

  function sendError(res: http.ServerResponse, err: unknown, rid: string): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      sendReply(res, errorReply(err));
      return;
    }
    // `rid` is also the X-Request-Id the caller saw, so a report can be traced.
    logError(err, rid);
    sendReply(res, errorReply(new HttpError(500, 'internal', 'Internal server error')));
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = process.hrtime.bigint();
    const rawUrl = req.url ?? '/';
    const q = rawUrl.indexOf('?');
    const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
    const search = q < 0 ? '' : rawUrl.slice(q + 1);
    const isApi = rawPath === '/api' || rawPath.startsWith('/api/');
    applySecurityHeaders(res, isApi);
    // Always generated here, never taken from the request, so a caller cannot forge log correlation.
    const rid = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', rid);
    res.on('finish', () => {
      // Method, path and status only: never bodies, cookies or query strings.
      log({
        event: 'http',
        rid,
        method: req.method,
        path: rawPath.slice(0, 200),
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        ip: clientIp(req, config.trustProxy),
      });
    });
    try {
      if (!rawPath.startsWith('/')) throw new HttpError(400, 'bad_request', 'Bad request');
      checkCsrf(req);
      if (isApi) {
        sendReply(res, await router.dispatch(req, rawPath, new URLSearchParams(search)));
      } else {
        await serveStatic(req, res, rawPath, {
          publicDir: config.publicDir,
          sharedDir: config.sharedDir,
          getUser: (r) => authenticate(ctx, r),
        });
      }
    } catch (err) {
      sendError(res, err, rid);
    }
  }

  const server = http.createServer((req, res) => {
    // handle() reports its own errors; this is the last net, so that nothing can
    // turn into an unhandled rejection that takes the whole process down.
    handle(req, res).catch((err: unknown) => {
      logError(err);
      res.destroy();
    });
  });
  // keepAliveTimeout is longer than Caddy's idle upstream connection timeout (2 minutes), so Caddy never
  // reuses a connection we just closed; headersTimeout stays above it, as Node recommends. Caddy in
  // front of us already deals with slow clients.
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 130_000;
  server.requestTimeout = 300_000;

  return {
    server,
    ctx,
    router,
    listen(port = config.port, host = config.bindHost) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), 5_000);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      // Let the notifications for a change that was just saved finish (each send has its own timeout).
      await notifier.idle();
    },
    idle: () => notifier.idle(),
    maintenance: { tick: () => tick(ctx), start: () => startMaintenance(ctx) },
    reminders,
  };
}
