// The guard of the Dutch interface. Dutch is the only language, so any English that slips in (a new string, a
// hard-coded literal next to the dictionary, a missing or mistyped key, a push text that is too long in Dutch) must
// fail here and not in front of a user. The word lists and the literal reader are in test/dutch-words.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { S } from '../public/strings.js';
import { fit } from '../src/notify.ts';
import * as T from '../src/notify-texts.ts';
import * as CAL from '../src/calendar-texts.ts';
import { requestMessage, tikkieProvider, type PaymentInput } from '../src/payments.ts';
import { REPEAT_AFTER_END_MS, START_LEAD_MS } from '../src/reminders.ts';
import { formatLocal } from '../shared/time.js';
import { ALSO_DUTCH, ENGLISH_FUNCTION_WORDS, FORMER_ENGLISH, englishHits, isTextBearing, literals, wordsOf } from './dutch-words.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** All files below a directory with one of the extensions, as paths relative to the repository root with forward slashes. */
function filesBelow(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesBelow(rel, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out.sort();
}

// ------------------------------------------------------------------ the dictionary, walked

type Leaf = { path: string; value: unknown };

function leavesOf(node: unknown, prefix = ''): Leaf[] {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node).flatMap(([key, value]) => leavesOf(value, prefix ? `${prefix}.${key}` : key));
  }
  return [{ path: prefix, value: node }];
}

/** Arguments for a function of the dictionary: a bounded product of probes so plural, sign and boolean branches all run. */
const PROBES: unknown[] = ['Ben', 1, 0, 2, 1234, true, false, null];
function* argumentSets(arity: number): Generator<unknown[]> {
  if (arity === 0) {
    yield [];
    return;
  }
  const pool = PROBES.slice(0, Math.max(2, Math.min(PROBES.length, Math.floor(4000 ** (1 / arity)))));
  const index = new Array<number>(arity).fill(0);
  for (;;) {
    yield index.map((i) => pool[i]);
    let pos = arity - 1;
    while (pos >= 0 && (index[pos] as number) + 1 === pool.length) index[pos--] = 0;
    if (pos < 0) return;
    index[pos] = (index[pos] as number) + 1;
  }
}

interface Rendered {
  path: string;
  text: string;
}

/** Every text of the dictionary: strings as they are, arrays element by element, functions rendered for every probe. */
function renderDictionary(): { texts: Rendered[]; notStrings: string[]; neverRendered: string[] } {
  const texts: Rendered[] = [];
  const notStrings: string[] = [];
  const neverRendered: string[] = [];
  for (const { path: p, value } of leavesOf(S)) {
    if (typeof value === 'string') texts.push({ path: p, text: value });
    else if (Array.isArray(value)) value.forEach((v, i) => (typeof v === 'string' ? texts.push({ path: `${p}[${i}]`, text: v }) : notStrings.push(`${p}[${i}]`)));
    else if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      let rendered = 0;
      const extra: unknown[][] = [[1, 2, 3, 4, 5, 6, 7, 8], [0, 0, 0, 0, 0, 0, 0, 0], ['Ben', 'Anna', 'Cleo', 'Dirk', 'Els', 'Finn', 'Gijs', 'Hans']];
      for (const args of [...argumentSets(fn.length), ...extra]) {
        let result: unknown;
        try {
          result = fn(...args);
        } catch {
          continue; // an argument of the wrong type for this position: not a text
        }
        // A function may hand an argument back unchanged (dayHeading returns its label): only strings are texts.
        if (typeof result === 'string') {
          rendered++;
          texts.push({ path: `${p}(${args.map((a) => JSON.stringify(a)).join(', ')})`, text: result });
        }
      }
      if (rendered === 0) neverRendered.push(p);
    } else notStrings.push(p);
  }
  return { texts, notStrings, neverRendered };
}

const dictionary = renderDictionary();

/** Every text-bearing literal of a source file, as a Dutch text (for the parts the probes cannot reach). */
function textLiterals(file: string): Array<{ text: string; line: number }> {
  return literals(read(file), file)
    .filter((l) => !l.isKey && isTextBearing(l.text))
    .map(({ text, line }) => ({ text, line }));
}

const problems = (texts: Array<{ where: string; text: string }>): string[] =>
  texts.flatMap(({ where, text }) => {
    const hits = englishHits(text);
    const bad: string[] = hits.length > 0 ? [`${where}: English "${hits.join('", "')}" in "${text}"`] : [];
    if (/\bEUR\b/.test(text)) bad.push(`${where}: "EUR" in "${text}" (amounts are written with the euro sign)`);
    if (/\bundefined\b|\bNaN\b|\[object /.test(text)) bad.push(`${where}: a stray value in "${text}"`);
    return bad;
  });

// ------------------------------------------------------------------------- canaries

test('canaries: the denylist knows the old English and lets Dutch through', () => {
  assert.deepEqual(englishHits('Fuel and costs'), ['fuel', 'and', 'costs']);
  assert.ok(englishHits('You have not registered any kilometres').length >= 4);
  assert.deepEqual(englishHits('Brandstof en kosten'), []);
  assert.deepEqual(englishHits('Je hebt nog geen ritten geregistreerd.'), []);
  assert.deepEqual(wordsOf("auto's en Ben's fiets"), ['auto', 'en', 'ben', 'fiets']);
  assert.ok(ENGLISH_FUNCTION_WORDS.has('the') && FORMER_ENGLISH.has('fuelled'));
  assert.ok(englishHits('EUR 12.34').includes('eur'));
  assert.ok(englishHits('Uw reservering').includes('uw'), 'formal address is refused');
});

test('the runtime has full ICU: a Dutch month name comes out', () => {
  assert.equal(new Intl.DateTimeFormat('nl-NL', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 2, 5))), 'maart');
  assert.equal(new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 16))), 'maandag');
});

// ------------------------------------------------------------------------ dictionary

test('the dictionary keeps every key of the English version (no key is lost or renamed) and the five added keys exist', () => {
  const expected = read('test/dutch-keys.txt')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = /^(\S+)(?: \((function|array) \d+\))?$/.exec(line);
      assert.ok(m, `bad line in test/dutch-keys.txt: ${line}`);
      return { key: m[1] as string, kind: m[2] ?? 'string' };
    });
  assert.ok(expected.length > 500, 'the key list is not empty');
  const actual = new Map(leavesOf(S).map((l) => [l.path, Array.isArray(l.value) ? 'array' : typeof l.value]));
  const wrong = expected.filter(({ key, kind }) => actual.get(key) !== kind).map(({ key, kind }) => `${key} should be a ${kind}, found ${actual.get(key) ?? 'nothing'}`);
  assert.deepEqual(wrong, []);
  for (const key of ['meLabel', 'meHead', 'nav.label', 'admin.retention.windowValue', 'usage.odometerRange']) assert.ok(actual.has(key), `S.${key} is missing`);
});

test('every text literal in public/strings.js is Dutch (this reaches branches no probe reaches)', () => {
  const found = problems(textLiterals('public/strings.js').map((l) => ({ where: `public/strings.js:${l.line}`, text: l.text })));
  assert.deepEqual(found, []);
  // Short literals such as 'm' or '' are not text-bearing but are still dictionary content: check them as well.
  const short = literals(read('public/strings.js'), 'strings.js').filter((l) => !l.isKey && !isTextBearing(l.text) && l.text !== '');
  const shortProblems = problems(short.map((l) => ({ where: `public/strings.js:${l.line}`, text: l.text })));
  assert.deepEqual(shortProblems, []);
});

test('every text S can produce is Dutch: strings, array items and every function rendered over a product of probe arguments', () => {
  assert.ok(dictionary.texts.length > 1500, `only ${dictionary.texts.length} texts rendered: the walk is not reaching the functions`);
  assert.deepEqual(dictionary.neverRendered, [], 'a function that never returned a string for any probe');
  assert.deepEqual(dictionary.notStrings, [], 'a leaf that is not a string, an array of strings or a function returning a string');
  assert.deepEqual(problems(dictionary.texts.map((t) => ({ where: `S.${t.path}`, text: t.text }))), []);
});

test('errors: an unknown code shows the Dutch generic sentence, never the English server message', async () => {
  const { errorText, fieldErrorText } = await import('../public/strings.js');
  assert.equal(errorText({ code: 'no_such_code', message: 'Server said so' }), S.errors.error);
  assert.equal(errorText({}), S.errors.error);
  assert.equal(fieldErrorText('no_such_code'), S.errors.error);
});

// -------------------------------------------------------------------- hard-coded literals

/**
 * Literals in the browser code that are not in the dictionary but look like text for a person: a capitalised word
 * followed by more text (or on its own), an English phrase word (the, and, you, ...) or a unit word after a space
 * (" km", " months"). Class names, selectors, URLs, events and header names do not match. A literal that is really
 * code, or a message for a developer, goes in this exact list with the reason.
 */
const LITERAL_ALLOWED: Readonly<Record<string, string>> = {
  'public/calendar.js: Not a date key: ': 'a programmer error thrown for a malformed date key, never shown to a person',
  'public/views/account.js: Notification': 'the name of the browser API, in a feature check',
};
const PHRASE_WORDS = new Set('the and you your with not are this that have will please eur'.split(' '));

test('no hard-coded English next to the dictionary: browser code, service worker, HTML and manifest', () => {
  const found: string[] = [];
  const files = filesBelow('public', ['.js']).filter((f) => f !== 'public/strings.js' && f !== 'public/sw.js');
  assert.ok(files.length >= 15, 'the scan sees the browser files');
  for (const file of files) {
    for (const { text, line } of literals(read(file), file)) {
      if (text.trim() === '') continue;
      if (Object.hasOwn(LITERAL_ALLOWED, `${file}: ${text}`)) continue;
      const hits = wordsOf(text).filter((w) => PHRASE_WORDS.has(w) && !Object.hasOwn(ALSO_DUTCH, w));
      if (/^\s*[A-Z][a-z]+(?:\s|[.,:!?…]|$)/.test(text)) hits.push('a capitalised word');
      if (/[\s\d](km|months?|minutes?|eur)([\s,.:;)]|$)/i.test(text)) hits.push('a unit word');
      if (hits.length > 0) found.push(`${file}:${line}: ${JSON.stringify(text)} (${hits.join(', ')})`);
    }
  }
  assert.deepEqual(found, [], 'move this text into public/strings.js, or add the exact literal to LITERAL_ALLOWED with the reason');
});

test('the service worker fallbacks, the HTML pages and the manifest are Dutch', () => {
  const sw = textLiterals('public/sw.js');
  assert.ok(sw.length >= 2, 'the two fallback texts are found');
  assert.deepEqual(problems(sw.map((l) => ({ where: `public/sw.js:${l.line}`, text: l.text }))), []);
  for (const file of ['public/index.html', 'public/admin/index.html']) {
    const html = read(file);
    assert.match(html, /<html lang="nl"/, `${file} is marked as Dutch`);
    const visible = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    // The attributes people can read or hear (not the meta tags that are code, such as the viewport).
    const attrs = [...visible.matchAll(/\b(?:aria-label|alt|placeholder|title)="([^"]*)"/g)].map((m) => m[1] as string);
    const appTitle = /name="apple-mobile-web-app-title"\s+content="([^"]*)"/.exec(html)?.[1];
    if (file === 'public/index.html') {
      assert.ok(appTitle, 'the home screen name is set');
      attrs.push(appTitle);
    }
    const text = visible.replace(/<[^>]+>/g, ' ');
    assert.deepEqual(problems([...attrs, text].map((t, i) => ({ where: `${file}#${i}`, text: t }))), []);
  }
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, unknown>;
  assert.equal(manifest['lang'], 'nl');
  for (const key of ['name', 'short_name', 'description']) assert.deepEqual(problems([{ where: `manifest ${key}`, text: String(manifest[key]) }]), []);
});

test('every S.path the browser code reads exists in the dictionary', () => {
  const missing: string[] = [];
  for (const file of filesBelow('public', ['.js']).filter((f) => f !== 'public/strings.js')) {
    for (const m of read(file).matchAll(/\bS\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g)) {
      let node: unknown = S;
      for (const part of (m[1] as string).split('.')) {
        if (node === null || typeof node !== 'object' || !(part in (node as object))) {
          node = undefined;
          break;
        }
        node = (node as Record<string, unknown>)[part];
      }
      if (node === undefined) missing.push(`${file}: S.${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

// ------------------------------------------------------------------ tab bar

test('every label of the bar is short enough for five columns at 320 px (at most 8 characters)', () => {
  for (const key of ['home', 'agenda', 'reserve', 'usage', 'more'] as const) {
    assert.ok([...S.nav[key]].length <= 8, S.nav[key] + ' (S.nav.' + key + ') is longer than 8 characters');
  }
  assert.ok(S.nav.label.length > 0, 'the tab bar has a Dutch accessible name');
});

test('the browser suite looks for the tab bar by the name the app gives it', () => {
  const name = /export const NAV_NAME = '([^']+)';/.exec(read('e2e/fixtures.ts'))?.[1];
  assert.equal(name, S.nav.label, 'NAV_NAME in e2e/fixtures.ts is S.nav.label');
});

test('the text literals of the server texts (push messages, payment request) are Dutch, whichever branch they sit in', () => {
  // An exact list of literals that are code and not words for a person.
  const allowed = new Set(['Bearer ', 'API-Key', 'Content-Type']);
  const found: string[] = [];
  for (const file of ['src/notify-texts.ts', 'src/payments.ts', 'src/calendar-texts.ts']) {
    for (const l of literals(read(file), file)) {
      if (l.isKey || !isTextBearing(l.text) || allowed.has(l.text)) continue;
      for (const p of problems([{ where: `${file}:${l.line}`, text: l.text }])) found.push(p);
    }
  }
  assert.deepEqual(found, []);
});

test('the calendar feed texts (src/calendar-texts.ts) are Dutch, whatever the name is', () => {
  const texts = [CAL.CALENDAR_NAME, CAL.confirmedSummary('Ben'), CAL.tentativeSummary('Ben'), CAL.confirmedSummary(WHO_LONG), CAL.tentativeSummary(WHO_LONG)];
  assert.deepEqual(problems(texts.map((text, i) => ({ where: `calendar text #${i}`, text }))), []);
  assert.equal(CAL.confirmedSummary('Ben'), 'Auto: Ben');
  assert.equal(CAL.tentativeSummary('Ben'), 'Voorstel: Ben');
  assert.equal(CAL.CALENDAR_NAME, 'Gedeelde auto');
  assert.ok(!/[!]/.test(texts.join(' ')), 'no exclamation mark');
});

// ------------------------------------------------------------------------ push texts

const WHO_LONG = 'Zoë '.repeat(15).trim();
const WHO ='€'.repeat(40); // 40 characters of 3 bytes each: the worst case for the byte cap
const OTHER = `${'é'.repeat(20)}${'–'.repeat(20)}`;
const TZ = 'Europe/Amsterdam';
const A = '2026-11-16T13:05:00.000Z';
const B = '2026-11-16T15:30:00.000Z';
const C = '2026-11-17T08:00:00.000Z';

interface Case {
  name: string;
  text: T.Text;
}

function pushCases(): Case[] {
  const cases: Case[] = [];
  const add = (name: string, text: T.Text): void => void cases.push({ name, text });
  for (const kind of ['start', 'end', 'repeat'] as const) for (const draft of [false, true]) add(`reminder ${kind} ${draft}`, T.reminder(kind, '18:00', draft));
  add('testNotification', T.testNotification());
  add('reservationSuggested', T.reservationSuggested({ actor: WHO, start: A, end: B, tz: TZ }));
  for (const decision of ['approved', 'declined'] as const) add(`reservationAnswered ${decision}`, T.reservationAnswered({ actor: WHO, decision, start: A, end: B, tz: TZ }));
  for (const audience of ['owner', 'target', 'suggester'] as const) {
    for (const [before, after] of [[{ start: A, end: B }, { start: C, end: C }], [{ start: A, end: B }, { start: A, end: B }]] as const) {
      add(`reservationChanged ${audience} ${before.start === after.start}`, T.reservationChanged({ actor: WHO, audience, targetName: OTHER, before, after, tz: TZ }));
    }
    for (const byCreator of [true, false]) add(`reservationDeleted ${audience} ${byCreator}`, T.reservationDeleted({ actor: WHO, audience, creatorName: OTHER, targetName: OTHER, byCreator, start: A, end: B, tz: TZ }));
  }
  for (const audience of ['driver', 'km', 'reservation'] as const) {
    for (const variant of ['added', 'changed', 'removed'] as const) {
      for (const deleted of [true, false]) {
        for (const status of ['draft', 'completed'] as const) {
          for (const km of [null, 123_456]) {
            for (const reservationStart of [null, B]) {
              add(`drive ${audience} ${variant} ${deleted} ${status} ${km} ${reservationStart}`, T.drive({ actor: WHO, audience, variant, deleted, status, start: A, km, reservationStart, tz: TZ }));
            }
          }
        }
      }
    }
  }
  for (const carriedCents of [0, 2_500, -2_500]) add(`fuelCreated ${carriedCents}`, T.fuelCreated({ fueler: WHO, shareCents: 123_456, carriedCents, dueCents: 123_456 + carriedCents }));
  for (const change of ['created', 'updated', 'deleted'] as const) for (const totalCents of [null, 1_000_000]) add(`fuelInYourName ${change} ${totalCents}`, T.fuelInYourName({ actor: WHO, change, at: A, totalCents, tz: TZ }));
  for (const change of ['updated', 'deleted'] as const) {
    for (const byFueler of [true, false]) {
      for (const [beforeCents, afterCents] of [[1_000, 2_000], [null, 2_000], [1_000, null], [null, null]] as const) {
        add(`fuelShareChanged ${change} ${byFueler} ${beforeCents} ${afterCents}`, T.fuelShareChanged({ actor: WHO, fueler: OTHER, byFueler, change, at: A, beforeCents, afterCents, tz: TZ }));
      }
    }
  }
  for (const paid of [true, false]) add(`fuelMarked ${paid}`, T.fuelMarked({ actor: WHO, paid, at: A, amountCents: 1_000_000, tz: TZ }));
  add('fuelSelfPaid', T.fuelSelfPaid({ debtor: WHO, at: A, amountCents: 1_000_000, tz: TZ }));
  for (const [variant, deleted] of [['added', false], ['changed', false], ['removed', true], ['removed', false]] as const) add(`ticket ${variant} ${deleted}`, T.ticket({ actor: WHO, variant, deleted, at: A, tz: TZ }));
  for (const location of [...Object.keys(T.LOCATION_LABEL), 'nowhere']) {
    add(`damageReported ${location}`, T.damageReported({ actor: WHO, location, description: 'Een deuk in de linkerachterdeur, ontstaan op de parkeerplaats. '.repeat(10) }));
  }
  return cases;
}

test('every function of src/notify-texts.ts is in the table below (a new text cannot skip the guard)', () => {
  const covered = new Set(pushCases().map((c) => c.name.split(' ')[0]));
  const exported = Object.entries(T)
    .filter(([name, value]) => typeof value === 'function' && name !== 'short')
    .map(([name]) => name);
  assert.deepEqual(
    exported.filter((name) => !covered.has(name)),
    [],
    'add the new function to pushCases() in test/dutch.test.ts',
  );
  assert.ok(pushCases().length > 150);
});

test('every push text is Dutch, speaks to "je" and has no English possessive', () => {
  const bad: string[] = [];
  for (const { name, text } of pushCases()) {
    const all = `${text.title} ${text.body}`;
    for (const p of problems([{ where: `${name}`, text: all }])) bad.push(p);
    if (/\p{L}'s\b/u.test(all.replace(/auto's/g, ''))) bad.push(`${name}: an English possessive in "${all}"`);
    if (!/\b(je|jouw|jij|jou)\b/i.test(all)) bad.push(`${name}: does not speak to the reader: "${all}"`);
  }
  assert.deepEqual(bad, []);
});

test('with two 40-character names of 3-byte characters every push text stays within the caps (title 100, body 300, payload 1000 bytes)', () => {
  const bad: string[] = [];
  for (const { name, text } of pushCases()) {
    if ([...text.title].length > 100) bad.push(`${name}: title is ${[...text.title].length} characters`);
    const fitted = fit({ ...text, url: '/#/history', tag: 'fuel-123456' });
    const bytes = Buffer.byteLength(JSON.stringify(fitted), 'utf8');
    if (bytes > 1000) bad.push(`${name}: ${bytes} bytes after fit()`);
    if (fitted.title.endsWith('…') && !text.title.endsWith('…')) bad.push(`${name}: the title had to be clipped: "${text.title}"`);
  }
  assert.deepEqual(bad, []);
});

test('the notification texts never clip a title, and bodies that are clipped still end in an ellipsis', () => {
  for (const { name, text } of pushCases()) {
    const body = [...text.body].length;
    if (body > 300) assert.ok(fit({ ...text, url: '/', tag: 't' }).body.endsWith('…'), `${name}: body of ${body} characters is cut without an ellipsis`);
  }
});

// -------------------------------------------------------------- payment request and Tikkie

const INPUT: PaymentInput = {
  amountCents: 2_000,
  creditorName: 'Anna',
  debtorName: 'Ben',
  litres: '40,50',
  date: 'maandag 16 november',
  km: 150,
  kmTotal: 400,
  equalSplit: false,
  reference: 'fuel-1-2',
};

test('the payment request is Dutch in every variant and writes amounts with the euro sign', () => {
  const variants: PaymentInput[] = [
    INPUT,
    { ...INPUT, shareCents: 1_500, carriedCents: 500 },
    { ...INPUT, shareCents: 1_500, carriedCents: -500, amountCents: 1_000 },
    { ...INPUT, togetherKm: 100 },
    { ...INPUT, equalSplit: true },
    { ...INPUT, equalSplit: true, togetherKm: 100 },
    { ...INPUT, amountCents: 123_456_700 },
  ];
  const bad: string[] = [];
  variants.forEach((v, i) => {
    const text = requestMessage(v);
    bad.push(...problems([{ where: `requestMessage #${i}`, text }]));
    if (!text.includes('€')) bad.push(`requestMessage #${i} has no euro sign: ${text}`);
    if (/\d\.\d{2}\b/.test(text)) bad.push(`requestMessage #${i} writes a decimal dot: ${text}`);
    if (!/\bje\b|\bjouw\b/i.test(text)) bad.push(`requestMessage #${i} does not speak to "je": ${text}`);
  });
  assert.deepEqual(bad, []);
});

test('the Tikkie description is Dutch and stays within 35 characters at the longest weekday and month', async () => {
  const sent: Array<{ description: string }> = [];
  const provider = tikkieProvider(
    { url: 'https://tikkie.example/requests', apiKey: 'k', accessToken: 't' },
    (async (_url: unknown, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as { description: string });
      return new Response(JSON.stringify({ url: 'https://tikkie.me/pay/x' }), { status: 200 });
    }) as unknown as typeof fetch,
    () => undefined,
  );
  let longest = '';
  for (let day = 0; day < 366; day++) {
    const label = formatLocal(new Date(Date.UTC(2026, 0, 1 + day, 12)).toISOString(), TZ, 'day');
    if (label.length > longest.length) longest = label;
  }
  await provider.create({ ...INPUT, date: longest });
  await provider.create({ ...INPUT, date: 'maandag 16 november' });
  assert.equal(sent.length, 2);
  for (const { description } of sent) {
    assert.deepEqual(problems([{ where: 'tikkie description', text: description }]), []);
    assert.ok(description.length <= 35, `"${description}" is ${description.length} characters`);
  }
  assert.equal(sent[1]?.description, 'Tankbeurt maandag 16 november');
});

// ------------------------------------------------------------------------- glossary

test('docs/GLOSSARY.md: the terms to use occur in the texts and the discouraged synonyms do not', () => {
  const rows = read('docs/GLOSSARY.md')
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*(Concept|-)/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  assert.ok(rows.length >= 30, `only ${rows.length} glossary rows found`);
  const corpus = [
    ...textLiterals('public/strings.js').map((l) => l.text),
    ...literals(read('public/strings.js'), 'strings.js').filter((l) => !l.isKey).map((l) => l.text),
    ...textLiterals('src/notify-texts.ts').map((l) => l.text),
    ...textLiterals('src/payments.ts').map((l) => l.text),
    ...textLiterals('src/calendar-texts.ts').map((l) => l.text),
  ].join('\n');
  const lower = corpus.toLowerCase();
  const terms = (cell: string): string[] => cell.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const missing: string[] = [];
  const present: string[] = [];
  for (const row of rows) {
    assert.equal(row.length, 5, `a glossary row has ${row.length} cells: ${row.join(' | ')}`);
    for (const term of terms(row[2] as string)) if (!lower.includes(term)) missing.push(`"${term}" (${row[0]})`);
    for (const term of terms(row[3] as string)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'iu').test(corpus)) present.push(`"${term}" (${row[0]})`);
    }
  }
  assert.deepEqual(missing, [], 'a term of the glossary that no text uses');
  assert.deepEqual(present, [], 'a term the glossary says not to use');
});

// ------------------------------------------------------------------- the exception list

test('ALSO_DUTCH stays honest: every entry is a former English word, has a reason and is really used in a Dutch text', () => {
  const used = new Set<string>();
  const add = (text: string): void => wordsOf(text).forEach((w) => used.add(w));
  dictionary.texts.forEach((t) => add(t.text));
  for (const file of ['public/strings.js', 'src/notify-texts.ts', 'src/payments.ts', 'src/calendar-texts.ts', 'public/sw.js']) textLiterals(file).forEach((l) => add(l.text));
  pushCases().forEach((c) => add(`${c.text.title} ${c.text.body}`));
  const stale: string[] = [];
  for (const [word, reason] of Object.entries(ALSO_DUTCH)) {
    if (!FORMER_ENGLISH.has(word)) stale.push(`${word}: not a former English word, remove it`);
    if (reason.trim().length < 10) stale.push(`${word}: give a reason`);
    if (!used.has(word)) stale.push(`${word}: no Dutch text uses it, remove it`);
  }
  assert.deepEqual(stale, []);
});

// ----------------------------------------------------------------- added by the test stage

test('the tone and typography rules of the glossary hold for every text: no exclamation mark, no formal "u", no double space, no three dots', () => {
  const requests = [INPUT, { ...INPUT, shareCents: 1_500, carriedCents: 500 }, { ...INPUT, shareCents: 1_500, carriedCents: -500, amountCents: 1_000 }, { ...INPUT, togetherKm: 100 }, { ...INPUT, equalSplit: true }].map(requestMessage);
  const texts = [
    ...dictionary.texts.map((t) => ({ where: `S.${t.path}`, text: t.text })),
    ...pushCases().map((c) => ({ where: `push ${c.name}`, text: `${c.text.title}\n${c.text.body}` })),
    ...requests.map((text, i) => ({ where: `requestMessage #${i}`, text })),
  ];
  assert.ok(texts.length > 1500);
  const rules: Array<[string, RegExp]> = [
    ['an exclamation mark (the glossary: no exclamation marks)', /!/],
    ['the formal "u" or "uw" (the glossary: never "u")', /(^|[^\p{L}])[Uu]w?(?![\p{L}])/u],
    ['a double space', /[^\s] {2,}[^\s]/],
    ['three dots instead of an ellipsis', /\.\.\./],
  ];
  const found: string[] = [];
  for (const { where, text } of texts) for (const [rule, re] of rules) if (re.test(text)) found.push(`${where} has ${rule}: ${JSON.stringify(text)}`);
  assert.deepEqual([...new Set(found.map((f) => f.replace(/\(.*?\) has/, ' has')))].slice(0, 20), []);
});

test('numbers and dates are written by the shared formatters only: no toFixed, no toLocale*, and no Intl locale but DISPLAY_LOCALE, apart from the two en-US readers of numbers', () => {
  /** Source without comments (a comment may talk about en-US), so only code is scanned. */
  const code = (file: string): string =>
    read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const files = [...filesBelow('public', ['.js']), ...filesBelow('shared', ['.js']), ...filesBelow('src', ['.ts'])];
  assert.ok(files.length > 40, 'the scan sees the browser, shared and server code');
  const found: string[] = [];
  const numberReaders: string[] = [];
  for (const file of files) {
    const text = code(file);
    for (const m of text.matchAll(/\.toFixed\(|\.toLocale(?:String|DateString|TimeString)\(|\.localeCompare\(|\bIntl\.(?:NumberFormat|RelativeTimeFormat|ListFormat|PluralRules|Collator|DisplayNames)\b/g)) {
      found.push(`${file}: ${m[0]} (a person's language or a float decides the text)`);
    }
    for (const m of text.matchAll(/new Intl\.DateTimeFormat\(\s*([^,)]*)/g)) {
      const locale = (m[1] as string).trim();
      if (locale === 'DISPLAY_LOCALE') continue;
      if (file === 'shared/time.js' && locale === "'en-US'") numberReaders.push(file);
      else found.push(`${file}: new Intl.DateTimeFormat(${locale}...) is neither DISPLAY_LOCALE nor a number reader of shared/time.js`);
    }
    for (const m of text.matchAll(/['"`][a-z]{2}-[A-Z]{2}['"`]/g)) {
      const allowed = file === 'shared/time.js' && (m[0] === "'en-US'" || m[0] === "'nl-NL'");
      if (!allowed) found.push(`${file}: the locale literal ${m[0]} (use DISPLAY_LOCALE)`);
    }
  }
  assert.deepEqual(found, []);
  assert.equal(numberReaders.length, 2, 'zonedParts and isValidTimeZone read numbers with en-US, whatever the display language is');
});

test('the Account page tells the real reminder timing and has a line for every family of push text, and the test button matches the test notification', () => {
  const minutes = START_LEAD_MS / 60_000;
  assert.ok(Number.isInteger(minutes), 'the lead is a whole number of minutes');
  const first = S.account.notifications.items[0] as string;
  assert.ok(S.account.reminders.intro.includes(`${minutes} minuten voordat`), `the Reminders card says ${minutes} minutes: START_LEAD_MS changed, so change the text`);
  assert.ok(first.includes(`${minutes} minuten voordat`), 'and so does the first line of the list');
  assert.equal(REPEAT_AFTER_END_MS, 3_600_000, 'the second reminder is an hour after the end: the list says "een uur later", change both together');
  assert.ok(first.includes('een uur later'));

  const families: Record<string, string[]> = {
    reservering: ['reservationSuggested', 'reservationAnswered', 'reservationChanged', 'reservationDeleted'],
    rit: ['drive'],
    tankbeurt: ['fuelCreated', 'fuelInYourName', 'fuelShareChanged', 'fuelMarked', 'fuelSelfPaid'],
    verkeersboete: ['ticket'],
    schade: ['damageReported'],
    herinnering: ['reminder'],
  };
  const exported = Object.entries(T)
    .filter(([name, value]) => typeof value === 'function' && name !== 'short' && name !== 'testNotification')
    .map(([name]) => name);
  const placed = new Set(Object.values(families).flat());
  assert.deepEqual(
    exported.filter((name) => !placed.has(name)),
    [],
    'a new push text: say which line of S.account.notifications.items it belongs to, and add its family here',
  );
  const list = S.account.notifications.items.join('\n').toLowerCase();
  for (const noun of Object.keys(families)) assert.ok(list.includes(noun), `the list on the Account page does not mention "${noun}" but the server sends it`);

  assert.ok(S.account.reminders.test.startsWith(T.testNotification().title), 'the button "Testmelding sturen" sends the "Testmelding" notification');
});

test('the README points at the glossary, and the glossary names the reserved terms and the words that stay as they are', () => {
  assert.match(read('README.md'), /\]\(docs\/GLOSSARY\.md\)/, 'README links to docs/GLOSSARY.md');
  const glossary = read('docs/GLOSSARY.md');
  assert.match(glossary, /\| Concept \| English name \| Use \| Do not use \| Notes \|/, 'the table has use and do-not-use columns');
  for (const term of ['reservering', 'ritregistratie', 'kilometerstand', 'tankbeurt', 'verkeersboete', 'schademelding', 'Ik heb betaald', 'APK', 'Tikkie']) {
    assert.ok(glossary.includes(term), `the glossary lists "${term}"`);
  }
  assert.match(glossary, /never "u"/, 'the tone rule: je and jouw, never u');
  assert.match(glossary, /no language switcher/, 'the glossary says there is one language');
});
