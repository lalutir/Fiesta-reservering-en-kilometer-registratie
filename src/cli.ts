// Operator commands, run inside the container or on the dev machine:
//   node dist/src/cli.js create-admin <username> [--name "Display name"] [--password-stdin]
//   node dist/src/cli.js reset-password <username> [--password-stdin]
//   node dist/src/cli.js backup
//   node dist/src/cli.js restore <backup-file>      (stop the app first)
//   node dist/src/cli.js purge
// Without --password-stdin a strong password is generated and printed once.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoginLimiter, generatePassword, hashPassword } from './auth.ts';
import { loadConfig, systemClock, type Clock } from './config.ts';
import { openDb, one, type UserRow } from './db.ts';
import { HttpError, type Ctx, type Logger } from './http.ts';
import { createBackup, dbPath, restoreBackup } from './maintenance.ts';
import { purge } from './retention.ts';
import { createUser, readNewPassword, storePassword } from './users.ts';
import { Fields } from './validate.ts';

export interface CliIo {
  readStdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage:
  create-admin <username> [--name "Display name"] [--password-stdin]
  reset-password <username> [--password-stdin]
  backup
  restore <backup-file>   (stop the app first)
  purge`;

async function readPassword(args: string[], io: CliIo): Promise<{ password: string; generated: boolean }> {
  if (args.includes('--password-stdin')) {
    const password = (await io.readStdin()).replace(/\r?\n$/, '');
    return { password, generated: false };
  }
  return { password: generatePassword(), generated: true };
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Runs one command and returns the process exit code. */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  clock: Clock = systemClock,
): Promise<number> {
  const [command, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--name');
  if (!command || !['create-admin', 'reset-password', 'backup', 'restore', 'purge'].includes(command)) {
    io.err(USAGE);
    return 2;
  }
  try {
    const config = loadConfig(env);
    if (command === 'restore') {
      const file = positional[0];
      if (!file) {
        io.err('restore needs a backup file');
        return 2;
      }
      const { preRestore } = restoreBackup(config, file, clock.now());
      io.out(`Restored ${path.resolve(file)}.${preRestore ? ` Previous database saved to ${preRestore}.` : ''}`);
      return 0;
    }

    const log: Logger = (event) => io.err(JSON.stringify(event));
    const db = openDb(dbPath(config.dataDir));
    try {
      const ctx: Ctx = { db, clock, config, log, limiter: new LoginLimiter(), fetch: globalThis.fetch };
      switch (command) {
        case 'create-admin': {
          const username = positional[0];
          if (!username) {
            io.err('create-admin needs a username');
            return 2;
          }
          const { password, generated } = await readPassword(rest, io);
          const row = await createUser(ctx, {
            username,
            displayName: option(rest, '--name') ?? username,
            password,
            role: 'admin',
          });
          io.out(`Created admin "${row.username}".`);
          if (generated) io.out(`Generated password (shown once): ${password}`);
          return 0;
        }
        case 'reset-password': {
          const username = positional[0]?.toLowerCase();
          if (!username) {
            io.err('reset-password needs a username');
            return 2;
          }
          const user = one<UserRow>(db, 'SELECT * FROM users WHERE username = ?', username);
          if (!user) {
            io.err(`No such user: ${username}`);
            return 1;
          }
          const { password, generated } = await readPassword(rest, io);
          const f = new Fields({ password });
          readNewPassword(f, 'password');
          f.done();
          storePassword(ctx, user.id, await hashPassword(password, config.scrypt));
          io.out(`Password reset for "${user.username}"; all their sessions were signed out.`);
          if (generated) io.out(`Generated password (shown once): ${password}`);
          return 0;
        }
        case 'backup': {
          const b = createBackup(ctx);
          io.out(`Backup written: ${b.path} (${b.size} bytes)`);
          return 0;
        }
        default: {
          const r = purge(db, clock.now(), config.tz, log, config.windowMonths);
          io.out(
            `Purged ${r.reservations} reservations, ${r.usage} usage records, ${r.fuel} fill-ups (${r.fuelRequests} payment requests) and ${r.sessions} expired sessions older than ${r.cutoff}.`,
          );
          return 0;
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof HttpError && err.fields) {
      io.err(`error: ${err.message}: ${JSON.stringify(err.fields)}`);
    } else {
      io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await runCli(process.argv.slice(2), process.env, {
    readStdin: readAllStdin,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}
