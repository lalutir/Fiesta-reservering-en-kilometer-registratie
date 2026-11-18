// Entry point. The only place (besides cli.ts) that reads process.env, starts
// timers and installs signal handlers.
import { createApp } from './app.ts';
import { loadConfig, systemClock } from './config.ts';
import { countRows, openDb } from './db.ts';
import type { Logger } from './http.ts';
import { dbPath } from './maintenance.ts';
import { bootstrapAdmin } from './users.ts';

const log: Logger = (event) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));
};

const config = loadConfig(process.env);
const db = openDb(dbPath(config.dataDir));
const app = createApp({ db, clock: systemClock, config, log });

if (await bootstrapAdmin(app.ctx)) {
  log({ event: 'server.note', message: 'First admin created from ADMIN_USERNAME/ADMIN_PASSWORD. Remove ADMIN_PASSWORD from the environment.' });
} else if (countRows(db, 'users') === 0) {
  log({ event: 'server.warning', message: 'No users exist. Set ADMIN_USERNAME and ADMIN_PASSWORD, or run the create-admin CLI command.' });
} else if (config.adminPassword) {
  // The bootstrap is a no-op once users exist, but the secret keeps sitting in the container environment.
  log({ event: 'server.warning', message: 'ADMIN_PASSWORD is still set. It is ignored now that users exist; remove it from .env and recreate the container.' });
}
if (!config.cookieSecure) {
  log({ event: 'server.warning', message: 'COOKIE_SECURE is off. Only use this for local development over http.' });
}
if (config.pushEnabled && config.pushSubject === undefined) {
  // Reminders are on by default but need an https address to identify this server to the push services.
  // Without one they stay off, and nothing else would say so.
  log({ event: 'server.warning', message: 'Reminders are off: push needs an https address. Set DOMAIN to a bare host name (such as car.example.com) or set PUSH_CONTACT, or set PUSH_ENABLED=false to silence this.' });
}

const maintenance = app.maintenance.start();
const reminders = app.reminders.start();
const address = await app.listen(config.port, config.bindHost);
log({ event: 'server.listening', host: address.address, port: address.port, timeZone: config.tz });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log({ event: 'server.stopping', signal });
  maintenance.stop();
  reminders.stop();
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
