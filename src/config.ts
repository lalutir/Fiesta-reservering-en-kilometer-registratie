import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTimeZone } from '../shared/time.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export interface Config {
  port: number;
  bindHost: string;
  dataDir: string;
  /** Household time zone (IANA name). All timestamps are stored in UTC. */
  tz: string;
  trustProxy: boolean;
  cookieSecure: boolean;
  adminUsername: string | undefined;
  adminPassword: string | undefined;
  backupKeepDays: number;
  scrypt: ScryptParams;
  /** Size of the visibility and retention window in calendar months. */
  windowMonths: number;
  publicDir: string;
  sharedDir: string;
}

/**
 * Directory that holds package.json. Found by walking up from this file so it
 * works from src/ (dev, tests), dist/src/ (built) and the container image.
 */
export function findProjectRoot(fromUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Project root (package.json) not found');
    dir = parent;
  }
}

type Env = Record<string, string | undefined>;

function intEnv(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function boolEnv(env: Env, name: string, def: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
}

function strEnv(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

/** Parse and validate the environment. Fails fast on bad values. */
export function loadConfig(env: Env, overrides: Partial<Config> = {}): Config {
  const root = findProjectRoot();
  const tz = strEnv(env, 'HOUSEHOLD_TZ') ?? 'Europe/Amsterdam';
  if (!isValidTimeZone(tz)) throw new Error(`HOUSEHOLD_TZ is not a valid IANA time zone: ${tz}`);
  const N = intEnv(env, 'SCRYPT_N', 2 ** 15, 2 ** 10, 2 ** 16);
  if ((N & (N - 1)) !== 0) throw new Error('SCRYPT_N must be a power of two');
  const config: Config = {
    port: intEnv(env, 'PORT', 3000, 1, 65535),
    bindHost: strEnv(env, 'BIND_HOST') ?? '127.0.0.1',
    dataDir: path.resolve(strEnv(env, 'DATA_DIR') ?? path.join(root, 'data')),
    tz,
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    cookieSecure: boolEnv(env, 'COOKIE_SECURE', true),
    adminUsername: strEnv(env, 'ADMIN_USERNAME'),
    adminPassword: strEnv(env, 'ADMIN_PASSWORD'),
    backupKeepDays: intEnv(env, 'BACKUP_KEEP_DAYS', 14, 1, 365),
    scrypt: { N, r: intEnv(env, 'SCRYPT_R', 8, 1, 16), p: intEnv(env, 'SCRYPT_P', 3, 1, 16) },
    windowMonths: 6,
    publicDir: path.resolve(strEnv(env, 'PUBLIC_DIR') ?? path.join(root, 'public')),
    sharedDir: path.resolve(strEnv(env, 'SHARED_DIR') ?? path.join(root, 'shared')),
  };
  return { ...config, ...overrides };
}
