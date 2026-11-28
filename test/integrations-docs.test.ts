// The words that go with the access tokens and the calendar feed outside the code: what docs/DEPLOYMENT.md tells an
// operator before the v8 upgrade, a backup, a restore or a log directive, what README.md says the feature is and what
// it is not, and that every name those documents use is one the code (or the Dutch dictionary) really has.
// docs/API.md is pinned field by field in test/v1.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { S } from '../public/strings.js';
import { SCHEMA_VERSION } from '../src/db.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A repository file as text with LF line endings (a Windows checkout may have CRLF). */
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
/** The same with every run of white space as one space, so a line break in the middle of a sentence does not matter. */
const flat = (rel: string): string => read(rel).replace(/\s+/g, ' ');

/** The text of `## <number>.` up to the next `## ` heading. */
function section(text: string, number: number): string {
  const start = text.search(new RegExp(`^## ${number}\\. `, 'm'));
  assert.ok(start >= 0, `section ${number} exists`);
  const rest = text.slice(start + 3);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The v8 subsection of section 18. */
function subsection(): string {
  const guide = read('docs/DEPLOYMENT.md');
  const start = guide.indexOf('### Access tokens and the calendar feed');
  assert.ok(start >= 0, 'the guide has a subsection for the access tokens and the calendar feed');
  const rest = guide.slice(start + 4);
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

test('SCHEMA_VERSION is the 8 that the subsection, the backup copy and the cache name below are written for', () => {
  assert.equal(SCHEMA_VERSION, 8, 'a later migration must write its own subsection: move these checks with it');
});

test('the guide has the v8 upgrade in section 18: the copy written first, the way back, the new cache name, and the section numbers it points at', () => {
  const guide = read('docs/DEPLOYMENT.md');
  const sectionNumber = guide.search(/^## 18\. /m);
  assert.ok(sectionNumber >= 0 && guide.indexOf('### Access tokens and the calendar feed') > sectionNumber, 'it is part of section 18');
  const text = subsection().replace(/\s+/g, ' ');
  for (const needle of [
    'schema v8',
    'two new tables (`api_tokens` and `calendar_feeds`)',
    '/data/backups/pre-migrate-v7.db',
    'once, not rotated',
    '**Going back:**',
    'an older app refuses to open a v8 database',
    'including every access token and calendar link',
    'delete `pre-migrate-v7.db` first',
    'upgrades straight to v8 in one start',
    '(`car-static-v10`)',
  ]) assert.ok(text.includes(needle), `the subsection says "${needle}"`);

  // The cache name it quotes is the one the service worker has, and the file it names is the one the migration writes.
  const cache = /const CACHE = '([^']+)';/.exec(read('public/sw.js'))?.[1];
  assert.equal(cache, 'car-static-v10', 'the service worker has the cache name the guide promises');
  assert.ok(read('src/db.ts').includes('pre-migrate-v'), 'the copy has the pre-migrate-v<from> name');

  // "(section N)" in the subsection points at a heading that exists.
  const headings = new Set([...guide.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1])));
  for (const m of subsection().matchAll(/\(section (\d+)\)|section (\d+)\b/g)) {
    const n = Number(m[1] ?? m[2]);
    assert.ok(headings.has(n), `the subsection points at section ${n}, which exists`);
  }
});

test('the guide warns that backups hold token digests and the feed secrets in plain text, and that a restore brings old tokens and links back', () => {
  const backups = section(read('docs/DEPLOYMENT.md'), 11).replace(/\s+/g, ' ');
  for (const needle of [
    'the SHA-256 digests of the access tokens',
    '**the calendar feed secrets in plain text**',
    'Treat copies like passwords',
    'A restore brings back the tokens and links the backup was taken with',
  ]) assert.ok(backups.includes(needle), `section 11 says "${needle}"`);
  const upgrade = subsection().replace(/\s+/g, ' ');
  for (const needle of ['the feed secrets in plain text', 'every `pre-migrate-*.db` copy', 'every off-site copy', 'revoke tokens in the admin Users tab', '*Nieuwe link maken*']) {
    assert.ok(upgrade.includes(needle), `the subsection says "${needle}"`);
  }
  // The claim is true: a column called secret holds the feed address, and no column of api_tokens can hold a token.
  const db = read('src/db.ts');
  assert.match(db, /secret\s+TEXT NOT NULL CHECK \(length\(secret\) = 43\)/);
  assert.match(db, /token_hash\s+TEXT NOT NULL UNIQUE/);
});

test('the checklist and the troubleshooting table of the guide name the real screens and the real buttons', () => {
  const guide = read('docs/DEPLOYMENT.md');
  const checklist = section(guide, 15).replace(/\s+/g, ' ');
  assert.match(checklist, /\[ \] After an update from the version with the statistics: `docker compose exec app ls -l \/data\/backups` lists `pre-migrate-v7\.db`/);
  const row = section(guide, 16).split('\n').find((l) => l.startsWith('| A calendar app says the address does not work'));
  assert.ok(row, 'the troubleshooting table has the calendar and token row');
  assert.match(row, /401/);
  assert.match(row, /404/);
  assert.match(row, /429/);
  assert.match(row, /`https:\/\/`/);

  // Every card and button that the checklist item and the v8 subsection quote in italics is what the dictionary says,
  // each time it is quoted (a rename in one place only would send an operator looking for a button that is not there).
  const labels = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') labels.add(value);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(S);
  const italics = (text: string): string[] => [...text.matchAll(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g)].map((m) => m[1] as string);
  const item = section(guide, 15).split('\n- [ ] ').find((l) => l.includes('pre-migrate-v7.db')) ?? '';
  const quoted = [...italics(item), ...italics(subsection())];
  assert.ok(quoted.length >= 7, `the two places quote ${quoted.length} labels`);
  for (const label of quoted) assert.ok(labels.has(label), `the guide quotes *${label}*, which no text of the app says`);
  const everywhere = italics(guide);
  for (const label of [S.account.tokens.title, S.account.calendar.title, S.account.calendar.create, S.account.calendar.renew, S.account.calendar.turnOff]) {
    assert.ok(everywhere.includes(label), `the guide mentions *${label}*`);
  }
});

test('the log events the guide tells an operator to watch are the ones the code writes, and nothing it names is made up', () => {
  const source = ['src/tokens.ts', 'src/calendar.ts'].map(read).join('\n');
  const emitted = new Set([...source.matchAll(/event: '((?:token|calendar)\.[a-z_]+)'/g)].map((m) => m[1] as string));
  assert.ok(emitted.size >= 8, `the code writes ${[...emitted].join(', ')}`);
  const guide = subsection();
  const named = new Set([...guide.matchAll(/`((?:token|calendar)\.[a-z_]+)`/g)].map((m) => m[1] as string));
  for (const event of named) assert.ok(emitted.has(event), `the guide names ${event}, which nothing logs`);
  // The ones that mean something went wrong or somebody is guessing are all named.
  for (const event of ['token.auth_failed', 'token.rate_limited', 'token.last_used_failed', 'calendar.miss', 'calendar.rate_limited']) {
    assert.ok(named.has(event), `the guide tells the operator about ${event}`);
  }
  // The fields it names are the ones the lines carry.
  assert.match(guide, /`tokensRevoked`/);
  assert.ok(read('src/users.ts').includes('tokensRevoked'), 'the user lines carry tokensRevoked');
  assert.ok(guide.includes('/api/calendar/[redacted]'), 'the guide quotes the redacted path');
  assert.ok(read('src/http.ts').includes('[redacted]'), 'and the code writes it');
});

test('the guide says what Caddy logs and what it does not, and the Caddyfile agrees with every word of it', () => {
  const text = subsection().replace(/\s+/g, ' ');
  for (const needle of [
    '**Caddy writes no access log today**',
    'give it the same `request>uri` filter',
    '`Authorization` header, which Caddy logs as `REDACTED`',
    '`log_credentials`',
    '`caddy validate` runs in the CI Docker job',
    'nobody has watched a running Caddy write a redacted line',
    '**Use `https://` addresses only**',
    '`webcal://`',
  ]) assert.ok(text.includes(needle), `the subsection says "${needle}"`);
  const caddyfile = read('Caddyfile');
  assert.match(caddyfile, /request>uri regexp /, 'the filter the guide talks about exists');
  assert.doesNotMatch(caddyfile.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /log_credentials/, 'and the option the guide forbids is not on');
});

test('the README says what the feature is, where its files are, and what it is not; every file it names exists', () => {
  const readme = flat('README.md');
  for (const needle of [
    '**Read-only API and calendar feed.**',
    'up to 5 **personal access tokens**',
    'four `GET` routes under `/api/v1/`',
    'always as a member (also for an admin)',
    'stored only as a SHA-256 digest',
    'private **calendar link**',
    'with no notes',
    '[docs/API.md](docs/API.md)',
    'were never run on the real systems',
  ]) assert.ok(readme.includes(needle), `the README says "${needle}"`);

  const limits = readme.slice(readme.indexOf('**Tokens and the calendar feed.**'));
  assert.ok(limits.length > 100, 'the known limits have a paragraph for the tokens and the feed');
  for (const needle of [
    'no scopes, no expiry, no CORS',
    'no global off switch',
    'reset when the app restarts',
    '**a backup holds it in plain text**',
    'Changing your own password does not revoke your tokens (an admin reset does)',
    'Google Calendar refreshes a subscription only a few times a day',
    'was only syntax-checked in CI',
    'Nothing was tried with a real calendar app, Home Assistant, Apps Script or a real phone',
  ]) assert.ok(limits.includes(needle), `the known limits say "${needle}"`);

  // The layout names the new files; they are there.
  for (const file of ['src/tokens.ts', 'src/v1.ts', 'src/calendar.ts', 'src/ics.ts', 'src/calendar-texts.ts', 'public/views/integrations.js', 'docs/API.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
    assert.ok(readme.includes(path.basename(file)), `the README layout names ${path.basename(file)}`);
  }
  assert.ok(readme.includes(`schema v${SCHEMA_VERSION}`), 'and the schema it is at');
});

test('the Dutch glossary has the two new terms, and the dictionary uses the words it fixes', () => {
  const glossary = read('docs/GLOSSARY.md');
  const rows = glossary.split('\n').filter((l) => l.startsWith('|'));
  const tokenRow = rows.find((l) => l.includes('| toegangstoken |'));
  const feedRow = rows.find((l) => l.includes('| agendalink |'));
  assert.ok(tokenRow, 'a row for the access token');
  assert.ok(feedRow, 'a row for the calendar link');
  // The terms the rows say not to use are not what the cards say.
  const cards = JSON.stringify([S.account.tokens, S.account.calendar]).toLowerCase();
  for (const bad of ['api-sleutel', 'toegangscode', 'agendafeed', 'ics-link']) assert.ok(!cards.includes(bad), `the cards never say "${bad}"`);
  assert.ok(cards.includes('toegangstoken') && cards.includes('agendalink'), 'and they use the glossary words');
});
