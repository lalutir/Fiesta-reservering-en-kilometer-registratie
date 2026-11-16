// Docker is not available on every dev machine (and not in CI for this repo), so the
// container files cannot be built here. These tests read them as text and check what
// can go wrong silently: files that disagree with each other (port, data directory),
// a build input that .dockerignore removes, a secret that could end up in git or in
// the image, and a deployment guide that names commands or variables that do not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, type CliIo } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A repository file as text with LF line endings (.gitattributes lets Windows check out CRLF). */
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
/** Non-empty, non-comment lines, trimmed. */
const activeLines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
const escapeRe = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------ compose helpers

/** The lines of one service under `services:` (2-space keys, 4-space properties). */
function serviceBlock(compose: string, name: string): string {
  const all = compose.split('\n');
  const start = all.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `service "${name}" is defined`);
  const out: string[] = [];
  for (const line of all.slice(start + 1)) {
    if (line.trim() !== '' && !line.trim().startsWith('#') && !/^ {3,}/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

/** Items of a 4-space list property such as `ports:`, without quotes and trailing comments. */
function listUnder(block: string, key: string): string[] {
  const all = block.split('\n');
  const i = all.indexOf(`    ${key}:`);
  if (i < 0) return [];
  const out: string[] = [];
  for (const line of all.slice(i + 1)) {
    const m = /^ {6}- (.+?)\s*(?:#.*)?$/.exec(line);
    if (!m) break;
    out.push((m[1] as string).replace(/^"(.*)"$/, '$1'));
  }
  return out;
}

/** KEY: "value" pairs of a service's `environment:` map. */
function environmentOf(block: string): Record<string, string> {
  const all = block.split('\n');
  const i = all.indexOf('    environment:');
  const out: Record<string, string> = {};
  if (i < 0) return out;
  for (const line of all.slice(i + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = /^ {6}([A-Z][A-Z0-9_]*):\s*"?([^"#]*?)"?\s*(?:#.*)?$/.exec(line);
    if (!m) break;
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** Names under the top-level `volumes:` key. */
function topLevelVolumes(compose: string): string[] {
  const all = compose.split('\n');
  const i = all.indexOf('volumes:');
  assert.ok(i >= 0, 'compose declares named volumes');
  const out: string[] = [];
  for (const line of all.slice(i + 1)) {
    const m = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (!m) break;
    out.push(m[1] as string);
  }
  return out;
}

// --------------------------------------------------------- Dockerfile helpers

/** KEY=value pairs of the Dockerfile's (multi-line) ENV instruction. */
function dockerEnv(dockerfile: string): Record<string, string> {
  const start = dockerfile.split('\n').findIndex((l) => l.startsWith('ENV '));
  assert.ok(start >= 0, 'Dockerfile has an ENV instruction');
  const lines = dockerfile.split('\n').slice(start);
  const out: Record<string, string> = {};
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Z][A-Z0-9_]*)=(\S+?)(?=\s|\\|$)/g)) out[m[1] as string] = m[2] as string;
    if (!line.trimEnd().endsWith('\\')) break;
  }
  return out;
}

/**
 * Does a .dockerignore / .gitignore (patterns in order, "!" re-includes) exclude this
 * top-level path? Supports the plain names, trailing slashes and "*" wildcards used here.
 */
function isIgnored(file: string, patterns: string[]): boolean {
  let ignored = false;
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const pattern = (negate ? raw.slice(1) : raw).replace(/\/$/, '');
    const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('[^/]*')}(?:/.*)?$`);
    if (re.test(file)) ignored = !negate;
  }
  return ignored;
}

/** Environment variables src/config.ts reads. */
function configVariables(): string[] {
  const source = read('src/config.ts');
  return [...source.matchAll(/(?:intEnv|boolEnv|strEnv)\(env, '([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] as string);
}

// ------------------------------------------------------------------- compose

test('compose: only Caddy publishes ports; the app is internal and keeps its data on a named volume', () => {
  const compose = read('docker-compose.yml');
  const app = serviceBlock(compose, 'app');
  const caddy = serviceBlock(compose, 'caddy');

  assert.doesNotMatch(app, /^ {4}ports:/m, 'the app publishes nothing to the host');
  assert.deepEqual(listUnder(app, 'expose'), ['3000']);
  assert.deepEqual(listUnder(app, 'volumes'), ['app_data:/data'], 'SQLite lives on a named volume, not in the container layer or a bind mount');
  assert.match(app, /^ {4}restart: unless-stopped$/m);
  assert.match(app, /^ {4}env_file: \.env$/m, 'secrets come from .env, not from the compose file');

  const ports = listUnder(caddy, 'ports');
  assert.ok(ports.includes('80:80') && ports.includes('443:443'), 'HTTP (for the certificate challenge and redirect) and HTTPS');
  assert.ok(ports.every((p) => /^(80:80|443:443|443:443\/udp)$/.test(p)), `no other published port: ${ports.join(', ')}`);
  assert.match(caddy, /^ {4}restart: unless-stopped$/m);
  assert.ok(listUnder(caddy, 'volumes').includes('./Caddyfile:/etc/caddy/Caddyfile:ro'));
  assert.ok(listUnder(caddy, 'volumes').includes('caddy_data:/data'), 'certificates survive a container re-create');
  assert.match(caddy, /^ {4}depends_on:\n {6}app:\n {8}condition: service_healthy$/m, 'Caddy waits for a healthy app');
  assert.match(caddy, /DOMAIN: \$\{DOMAIN:\?/, 'compose refuses to start without a DOMAIN');

  const volumes = topLevelVolumes(compose);
  assert.ok(volumes.includes('app_data') && volumes.includes('caddy_data'), `declared volumes: ${volumes.join(', ')}`);
});

test('compose: the app container is locked down', () => {
  const app = serviceBlock(read('docker-compose.yml'), 'app');
  assert.match(app, /^ {4}read_only: true$/m);
  assert.deepEqual(listUnder(app, 'cap_drop'), ['ALL']);
  assert.deepEqual(listUnder(app, 'security_opt'), ['no-new-privileges:true']);
  assert.match(app, /^ {4}mem_limit: \d+m$/m, 'a memory cap protects the 512 MiB droplet');
});

test('compose, Dockerfile and Caddyfile agree on the port, the data directory and the health check', () => {
  const compose = read('docker-compose.yml');
  const app = serviceBlock(compose, 'app');
  const dockerfile = read('Dockerfile');
  const env = dockerEnv(dockerfile);

  assert.equal(env['PORT'], '3000');
  assert.deepEqual(listUnder(app, 'expose'), [env['PORT']], 'the exposed port is the one the app listens on');
  assert.match(read('Caddyfile'), new RegExp(`reverse_proxy app:${env['PORT']}\\b`), 'Caddy proxies to that port');
  assert.equal(env['BIND_HOST'], '0.0.0.0', 'listens on all interfaces so the Caddy container can reach it');

  const mount = listUnder(app, 'volumes')[0]?.split(':')[1];
  assert.equal(mount, env['DATA_DIR'], 'the volume is mounted where the app writes');
  assert.match(dockerfile, new RegExp(`^VOLUME ${escapeRe(env['DATA_DIR'] as string)}$`, 'm'));

  // depends_on: service_healthy only works if the image defines a health check.
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /\/api\/health/);
});

test('the environment compose and the Dockerfile give the app is accepted by the config loader', () => {
  const compose = read('docker-compose.yml');
  const fromCompose = environmentOf(serviceBlock(compose, 'app'));
  assert.equal(fromCompose['TRUST_PROXY'], '1', 'behind Caddy the client address comes from X-Forwarded-For');
  const config = loadConfig({ ...dockerEnv(read('Dockerfile')), ...fromCompose });
  assert.equal(config.trustProxy, true);
  assert.equal(config.bindHost, '0.0.0.0');
  assert.equal(config.port, 3000);
  assert.equal(config.cookieSecure, true, 'production keeps Secure cookies');
  assert.doesNotMatch(compose, /COOKIE_SECURE/, 'compose never turns Secure cookies off');
  assert.doesNotMatch(compose + read('Dockerfile') + read('Caddyfile'), /PASSWORD\s*[:=]\s*[^\s$]/, 'no password value is written into a container file');
});

// ------------------------------------------------------------------ Caddyfile

test('Caddyfile: automatic HTTPS for $DOMAIN in front of the app, with HSTS', () => {
  const caddyfile = activeLines(read('Caddyfile')).join('\n');
  assert.match(caddyfile, /^\{\$DOMAIN\} \{$/m, 'the site address is a host name, which is what makes Caddy fetch a certificate');
  assert.match(caddyfile, /^reverse_proxy app:3000$/m);
  assert.match(caddyfile, /Strict-Transport-Security "max-age=\d{7,}"/);
  assert.doesNotMatch(caddyfile, /auto_https\s+(off|disable_redirects)|tls\s+internal|http:\/\//, 'nothing switches automatic HTTPS off');
});

// ----------------------------------------------------------------- Dockerfile

test('Dockerfile: pinned Node that satisfies engines, two stages, unprivileged runtime user, reproducible install', () => {
  const dockerfile = read('Dockerfile');
  const stages = [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)];
  assert.deepEqual(stages.map((m) => m[2]), ['build', 'runtime']);
  for (const m of stages) assert.equal(m[1], 'node:${NODE_VERSION}-alpine', 'both stages use the one pinned Node version');

  const pin = /^ARG NODE_VERSION=(\d+)\.(\d+)$/m.exec(dockerfile);
  assert.ok(pin, 'NODE_VERSION is pinned to a minor, not just a major or "latest"');
  const engines = /^>=(\d+)\.(\d+)/.exec(JSON.parse(read('package.json')).engines.node as string);
  assert.ok(engines, 'package.json engines.node is ">=major.minor"');
  const [pinMajor, pinMinor, minMajor, minMinor] = [pin[1], pin[2], engines[1], engines[2]].map(Number) as [number, number, number, number];
  assert.ok(pinMajor > minMajor || (pinMajor === minMajor && pinMinor >= minMinor), `image Node ${pinMajor}.${pinMinor} satisfies engines >=${minMajor}.${minMinor}`);

  assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
  assert.match(dockerfile, /^RUN npm ci$/m, 'installs exactly what the lock file says');
  const runtime = dockerfile.slice(dockerfile.indexOf(' AS runtime'));
  assert.doesNotMatch(runtime, /\bnpm\b/, 'the runtime stage installs nothing (no runtime dependencies)');
  assert.ok(dockerfile.indexOf('chown node:node /data') > 0 && dockerfile.indexOf('chown node:node /data') < dockerfile.indexOf('USER node'), 'the data directory is made writable, then privileges are dropped');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^CMD \["node", .*"dist\/src\/server\.js"\]$/m);
  assert.doesNotMatch(dockerfile, /^COPY[^\n]*\.env/m, '.env is never copied into the image');
});

test('every file the Dockerfile copies from the build context exists and is not removed by .dockerignore', () => {
  const dockerfile = read('Dockerfile');
  const patterns = activeLines(read('.dockerignore'));
  const copies = [...dockerfile.matchAll(/^COPY (?!--from)(.+)$/gm)].map((m) => (m[1] as string).trim().split(/\s+/).filter((a) => !a.startsWith('--')));
  assert.ok(copies.length >= 5, 'the build and runtime stages copy their inputs');
  const sources = new Set(copies.flatMap((parts) => parts.slice(0, -1)));
  for (const needed of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src', 'shared', 'public']) {
    assert.ok(sources.has(needed), `${needed} is copied`);
  }
  for (const src of sources) {
    assert.ok(fs.existsSync(path.join(root, src)), `${src} exists`);
    assert.equal(isIgnored(src, patterns), false, `${src} is needed by the image but excluded by .dockerignore`);
  }
  // What tsc compiles in the image is exactly what the build stage copies in.
  const build = JSON.parse(read('tsconfig.build.json')) as { include: string[] };
  for (const dir of build.include) assert.ok(sources.has(dir), `tsconfig.build.json includes ${dir}, so the build stage must copy it`);
});

test('.dockerignore and .gitignore keep secrets, databases and dependencies out', () => {
  const docker = activeLines(read('.dockerignore'));
  const git = activeLines(read('.gitignore'));
  for (const [name, patterns] of [['.dockerignore', docker], ['.gitignore', git]] as const) {
    for (const secret of ['.env', '.env.local', '.env.production', 'car.db', 'car.db-wal', 'car.db-shm', 'node_modules', 'data']) {
      assert.equal(isIgnored(secret, patterns), true, `${name} ignores ${secret}`);
    }
    assert.equal(isIgnored('.env.example', patterns), false, `${name} keeps .env.example`);
    assert.equal(isIgnored('src', patterns), false);
    assert.equal(isIgnored('package.json', patterns), false);
  }
  assert.equal(isIgnored('dist', git), true, 'build output is not committed');
  assert.equal(isIgnored('.git', docker), true, 'the repository history is not sent to the build');
});

// --------------------------------------------------------------- .env.example

test('.env.example is complete, free of secrets, and accepted by the config loader as is', () => {
  const raw = read('.env.example');
  const active: Record<string, string> = {};
  for (const m of raw.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) active[m[1] as string] = (m[2] as string).trim();

  for (const name of ['DOMAIN', 'HOUSEHOLD_TZ', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'BACKUP_KEEP_DAYS']) {
    assert.ok(name in active, `${name} is in .env.example`);
  }
  for (const [name, value] of Object.entries(active)) {
    if (/PASSWORD|SECRET|TOKEN|KEY/.test(name)) assert.equal(value, '', `${name} must be empty in the committed example`);
  }
  assert.match(active['DOMAIN'] as string, /(^|\.)example\.(com|org|net)$/, 'DOMAIN is an obvious placeholder');
  assert.ok(!('COOKIE_SECURE' in active), 'insecure cookies are never switched on by copying the example');

  // Every variable named there (also the commented samples) is really read by something.
  const known = new Set([...configVariables(), 'DOMAIN']);
  const mentioned = [...raw.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string);
  assert.ok(mentioned.length >= 8);
  for (const name of mentioned) assert.ok(known.has(name), `${name} in .env.example is not read by the app or compose`);

  // Copied unchanged it works, and it does not create an account with a known password.
  const config = loadConfig(active);
  const defaults = loadConfig({});
  assert.equal(config.adminPassword, undefined);
  assert.equal(config.adminUsername, 'admin');
  assert.equal(config.tz, defaults.tz);
  assert.equal(config.backupKeepDays, defaults.backupKeepDays);
  assert.equal(config.cookieSecure, true);

  // The commented "defaults shown" really are the defaults.
  const sample = Object.fromEntries([...raw.matchAll(/^# ([A-Z][A-Z0-9_]*)=(\S*)$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual([sample['SCRYPT_N'], sample['SCRYPT_R'], sample['SCRYPT_P']].map(Number), [defaults.scrypt.N, defaults.scrypt.r, defaults.scrypt.p]);
  assert.equal(Number(sample['PORT']), defaults.port);
  assert.equal(loadConfig({ COOKIE_SECURE: sample['COOKIE_SECURE'] as string }).cookieSecure, false, 'the commented dev setting is a valid value');
});

// ------------------------------------------------------------ secrets in git

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'data', 'coverage']);
const TEXT_FILE = /\.(ts|js|mjs|json|md|yml|yaml|html|css|webmanifest|example|txt)$|^(Dockerfile|Caddyfile|\.gitignore|\.dockerignore|\.gitattributes)$/;

function textFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : textFiles(full);
    return TEXT_FILE.test(e.name) ? [full] : [];
  });
}

test('no private key or well-known API token is in any file that could be committed', () => {
  const patterns: Array<[string, RegExp]> = [
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
    ['DigitalOcean token', /\bdo[opr]_v1_[a-f0-9]{64}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
    ['Anthropic/OpenAI style key', /\bsk-[A-Za-z0-9_-]{32,}\b/],
  ];
  const files = textFiles(root);
  assert.ok(files.length > 30, `scanned ${files.length} files`);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, re] of patterns) assert.doesNotMatch(text, re, `${label} found in ${path.relative(root, file)}`);
  }
});

// ----------------------------------------------------------- deployment guide

test('the deployment guide covers droplet, DNS, first admin, backups, updates and cost, and mentions Hetzner', () => {
  const guide = read('docs/DEPLOYMENT.md');
  const headings = [...guide.matchAll(/^## (.+)$/gm)].map((m) => m[1] as string);
  for (const topic of [/droplet/i, /domain and dns/i, /first admin/i, /backups/i, /updating/i, /cost estimate/i, /phones/i]) {
    assert.ok(headings.some((h) => topic.test(h)), `a section matching ${topic}: ${headings.join(' | ')}`);
  }
  assert.match(guide, /DigitalOcean/);
  const cost = guide.slice(guide.search(/^## .*cost estimate/im));
  assert.match(cost, /\$\d/, 'the estimate gives a monthly figure');
  assert.match(cost, /per month/i);
  assert.match(cost, /Hetzner/, 'the cost section names the cheaper alternative');
  assert.match(guide, /not verified|unverified/i, 'prices are flagged as unverified');
  assert.match(guide, /BACKUP_KEEP_DAYS/, 'backup rotation is explained');
});

test('every CLI command in the guide exists, and the guide shows the operator workflows', () => {
  const guide = read('docs/DEPLOYMENT.md');
  // Ask the real CLI what it supports: with no command it prints its usage.
  const lines: string[] = [];
  const io: CliIo = { readStdin: async () => '', out: (l) => lines.push(l), err: (l) => lines.push(l) };
  return runCli([], {}, io).then((code) => {
    assert.equal(code, 2);
    const supported = new Set([...lines.join('\n').matchAll(/^ {2}([a-z-]+)/gm)].map((m) => m[1] as string));
    for (const c of ['create-admin', 'reset-password', 'backup', 'restore', 'purge']) assert.ok(supported.has(c), `CLI supports ${c}`);
    const used = [...guide.matchAll(/node dist\/src\/cli\.js\s+([a-z-]+)/g)].map((m) => m[1] as string);
    assert.ok(used.length >= 4);
    for (const c of used) assert.ok(supported.has(c), `the guide uses "${c}", which the CLI does not have`);
    for (const c of ['create-admin', 'reset-password', 'backup', 'restore']) assert.ok(used.includes(c), `the guide shows ${c}`);
  });
});

test('every variable the guide names is one the app or compose reads, and the setup table lists the required ones', () => {
  const guide = read('docs/DEPLOYMENT.md');
  const dockerfile = read('Dockerfile');
  const known = new Set([...configVariables(), 'DOMAIN', ...Object.keys(dockerEnv(dockerfile)), 'NODE_VERSION']);
  const named = new Set([...guide.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|DOMAIN)`/g)].map((m) => m[1] as string).filter((n) => !n.startsWith('YOUR_')));
  assert.ok(named.size >= 5);
  for (const name of named) assert.ok(known.has(name), `the guide names ${name}, which nothing reads`);
  const table = [...guide.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  for (const required of ['DOMAIN', 'HOUSEHOLD_TZ', 'ADMIN_USERNAME', 'ADMIN_PASSWORD']) assert.ok(table.includes(required), `${required} is in the setup table`);
});

test('relative links in the README and the docs point at files that exist', () => {
  for (const doc of ['README.md', 'docs/DEPLOYMENT.md']) {
    const text = read(doc);
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] as string).filter((l) => !/^(https?:|mailto:|#)/.test(l));
    for (const link of links) {
      const target = path.resolve(path.dirname(path.join(root, doc)), link.split('#')[0] as string);
      assert.ok(fs.existsSync(target), `${doc} links to ${link}, which does not exist`);
    }
  }
  assert.match(read('README.md'), /\]\(docs\/DEPLOYMENT\.md\)/, 'the README points at the deployment guide');
});
