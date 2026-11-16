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
import { startMaintenance, tick } from './maintenance.ts';
import { registerReservationRoutes } from './reservations.ts';
import { registerRetentionRoutes } from './retention.ts';
import { serveStatic } from './static.ts';
import { registerUsageRoutes } from './usage.ts';
import { registerUserRoutes } from './users.ts';

export interface AppDeps {
  db: Db;
  clock: Clock;
  config: Config;
  log: Logger;
}

export interface App {
  server: http.Server;
  ctx: Ctx;
  router: Router;
  listen(port?: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
  /** The daily purge and backup. Nothing runs until start() is called (by server.ts). */
  maintenance: { tick(): boolean; start(): { stop(): void } };
}

/**
 * Wire the routes and the request pipeline:
 * security headers -> CSRF -> API router or static files -> error mapper -> access log.
 * No timers are created here.
 */
export function createApp(deps: AppDeps): App {
  const ctx: Ctx = { ...deps, limiter: new LoginLimiter() };
  const { config, log } = ctx;
  const router = new Router((req) => authenticate(ctx, req), config.trustProxy);

  router.add('GET', '/api/health', 'public', () => {
    ctx.db.prepare('SELECT 1').get();
    return ok({ status: 'ok' });
  });
  registerUserRoutes(router, ctx);
  registerReservationRoutes(router, ctx);
  registerUsageRoutes(router, ctx);
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
    close() {
      return new Promise((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), 5_000);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
    maintenance: { tick: () => tick(ctx), start: () => startMaintenance(ctx) },
  };
}
