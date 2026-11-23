// The kilometre check on screen, driven like a person does it with the fake DOM: the reading a new drive
// starts from and where it comes from, the warning that never blocks a save, "Add the missing drive", the
// Kilometre check section with its explain and remove, the markers under drives, the fill-up form and cards,
// and the same overview on the admin page. Plus the pure helpers, tied to the server's derivation (the one
// place the two sides have to agree: which reading is the last known one, and which fill-ups lie in a trip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OdometerChain, OdometerItem, OdometerReading } from '../public/api.js';
import { fmtWhen } from '../public/dom.js';
import { GAP_TOLERANCE_KM as CLIENT_TOLERANCE, gapDefaults, kmCheckSection, kmMarkers, odometerContext, odometerWarning, readingBefore, warningText } from '../public/kmcheck.js';
import { S } from '../public/strings.js';
import { render as renderFuel } from '../public/views/fuel.js';
import { render as renderHistory } from '../public/views/history.js';
import { render as renderUsage } from '../public/views/usage.js';
import { GAP_TOLERANCE_KM as SERVER_TOLERANCE, deriveChain, type DriveInput, type FuelInput } from '../src/odometer.ts';
import {
  ADMIN,
  ANNA,
  BEN,
  NOW,
  Reply,
  TZ,
  all,
  at,
  byText,
  control,
  dateTime,
  draft,
  errorOf,
  fieldRow,
  finding,
  hintOf,
  installFakeDom,
  makeApp,
  odometerChain,
  odometerRoutes,
  one,
  reading,
  refuse,
  reservation,
  submitForm,
  typeInto,
  until,
  usage,
  withClient,
  type ApiStub,
  type Call,
  type FakeDom,
  type FakeElement,
  type Routes,
} from './fake-dom.ts';
import type { Json } from './helpers.ts';

const K = S.kmcheck;

const asChain = (c: Json): OdometerChain => c as unknown as OdometerChain;
const asItem = (i: Json): OdometerItem => i as unknown as OdometerItem;
const asReading = (r: Json): OdometerReading => r as unknown as OdometerReading;
const mount = (dom: FakeDom, rendered: unknown): FakeElement => dom.mount(rendered);

function onlyWrite(api: ApiStub): Call {
  const writes = api.writes();
  assert.equal(writes.length, 1, `expected exactly one write, got ${JSON.stringify(writes.map((c) => `${c.method} ${c.path}`))}`);
  return writes[0] as Call;
}

// ---------------------------------------------------------------- fixtures
// Ben drove 41000 to 41120 (drive 3). Anna's drive 4 starts at 41200: 80 km nobody registered between them.
// Anna filled up at 41300 (fill-up 5): another 40 km after the end of her drive.
const benStart = reading({ source: 'drive-start', id: 3, km: 41000, at: at(-600), userId: 2, userName: 'Ben' });
const benEnd = reading({ source: 'drive-end', id: 3, km: 41120, at: at(-480), userId: 2, userName: 'Ben' });
const annaStart = reading({ source: 'drive-start', id: 4, km: 41200, at: at(-300), userId: 1, userName: 'Anna' });
const annaEnd = reading({ source: 'drive-end', id: 4, km: 41260, at: at(-240), userId: 1, userName: 'Anna' });
const annaFuel = reading({ source: 'fuel', id: 5, km: 41300, at: at(-100), userId: 1, userName: 'Anna' });
const gapBen = finding(benEnd, annaStart);
const gapFuel = finding(annaEnd, annaFuel);
const chainA = (): Json => odometerChain([benStart, benEnd, annaStart, annaEnd, annaFuel], [gapFuel, gapBen]);

function driveRoutes(over: { usage?: Json[]; reservations?: Json[]; extra?: Routes } = {}): Routes {
  return {
    'GET /api/usage': () => ({ items: over.usage ?? [] }),
    'GET /api/usage/summary': () => ({ items: [], totalKm: 0 }),
    'GET /api/reservations': () => ({ items: over.reservations ?? [] }),
    'GET /api/usage/pending': () => ({ items: [], count: 0 }),
    'POST /api/usage': () => new Reply({ usage: {} }, 201),
    'PATCH /api/usage/9': () => ({ usage: {} }),
    'PATCH /api/usage/3': () => ({ usage: {} }),
    ...over.extra,
  };
}
const driveForm = (app: ReturnType<typeof makeApp>, query = '') => renderUsage(app.app, { query: new URLSearchParams(query) });
/** The drive form itself: the Kilometre check above it has small forms of its own (explain), so the first <form> is not it. */
const submitDrive = async (page: unknown): Promise<void> => one(page, 'form.card').fire('submit');
const startOf = (form: unknown) => dateTime(fieldRow(form, S.usage.start));
const endOf = (form: unknown) => dateTime(fieldRow(form, S.usage.end));
const readingStart = (form: unknown) => control(fieldRow(form, S.usage.odometerStart));
const readingEnd = (form: unknown) => control(fieldRow(form, S.usage.odometerEnd));
/** The line under the start reading and the warning region next to it. */
const lastKnown = (form: unknown) => one(fieldRow(form, S.usage.odometerStart), '.km-last').textContent;
const warning = (form: unknown) => one(fieldRow(form, S.usage.odometerStart), 'p.km-warn');

const who = (name: string, me = 'Anna') => (name === me ? S.meLabel : name);
const lastKnownText = (r: Json, me = 'Anna') => K.lastKnown(r['km'] as number, who(r['userName'] as string, me), fmtWhen(r['at'] as string, TZ));

// ============================================================ the pure helpers

test('readingBefore: the latest reading at or before an instant, the later one in chain order at a tie, own readings left out', () => {
  const readings = [benStart, benEnd, annaStart, annaEnd, annaFuel].map(asReading);
  assert.equal(readingBefore(readings, at(-700)), null, 'nothing before the first reading');
  assert.equal(readingBefore(readings, at(-600))?.km, 41000, 'a reading exactly at the instant counts');
  assert.equal(readingBefore(readings, at(-599))?.km, 41000);
  assert.equal(readingBefore(readings, at(-300))?.km, 41200);
  assert.equal(readingBefore(readings, at(0))?.km, 41300);
  assert.equal(readingBefore(readings, '9999-12-31T00:00:00.000Z')?.km, 41300, 'far in the future: the latest reading, like the server');
  assert.equal(readingBefore([], at(0)), null);

  // Two readings at one instant (back-to-back drives): chain order decides, the last one wins.
  const tie = [asReading(reading({ id: 1, km: 100, at: at(-10) })), asReading(reading({ source: 'drive-start', id: 2, km: 150, at: at(-10) }))];
  assert.equal(readingBefore(tie, at(-10))?.km, 150);

  // The drive being edited is not "the reading before" itself; a fill-up with the same id is a different thing.
  assert.equal(readingBefore(readings, at(0), { drive: 4 })?.km, 41300, 'the fill-up is still there');
  assert.equal(readingBefore(readings, at(-200), { drive: 4 })?.km, 41120, 'both readings of drive 4 are skipped');
  assert.equal(readingBefore(readings, at(0), { fuel: 5 })?.km, 41260, 'the fill-up being edited is skipped');
  assert.equal(readingBefore(readings, at(0), { drive: 5 })?.km, 41300, 'drive 5 is not fill-up 5');
  assert.equal(readingBefore(readings, at(0), { drive: null, fuel: null })?.km, 41300);
});

test('odometerContext: a fill-up strictly inside a finished drive is compared with that drive only', () => {
  const readings = [benStart, benEnd, annaStart].map(asReading);
  assert.equal(odometerContext(readings, at(-540), {}, true).trip?.start.km, 41000, 'inside the trip of drive 3');
  assert.equal(odometerContext(readings, at(-540), {}, true).trip?.end.km, 41120);
  assert.equal(odometerContext(readings, at(-540), {}, true).last?.km, 41000, 'and the last known reading is still the one before it');
  assert.equal(odometerContext(readings, at(-540), {}, false).trip, null, 'a drive form never has a trip');
  assert.equal(odometerContext(readings, at(-600), {}, true).trip, null, 'at the exact start instant it is a normal link');
  assert.equal(odometerContext(readings, at(-480), {}, true).trip, null, 'and at the exact end instant');
  assert.equal(odometerContext(readings, at(-400), {}, true).trip, null, 'after the end');
  assert.equal(odometerContext(readings, at(-540), { drive: 3 }, true).trip, null, 'a drive being edited has no trip around itself');
  // A drive with one reading only has no span.
  assert.equal(odometerContext([benStart].map(asReading), at(-540), {}, true).trip, null);
  assert.equal(odometerContext([benEnd].map(asReading), at(-540), {}, true).trip, null);
});

test('odometerWarning: lower and higher than the last known reading, outside a trip, nothing for equal, empty or unknown', () => {
  const last = asReading(benEnd);
  const ctx = { last, trip: null };
  assert.deepEqual(odometerWarning(41000, ctx), { kind: 'lower', diff: 120, known: 41120 });
  assert.deepEqual(odometerWarning(41200, ctx), { kind: 'higher', diff: 80 });
  assert.equal(odometerWarning(41120, ctx), null);
  assert.equal(odometerWarning(null, ctx), null);
  assert.equal(odometerWarning(Number.NaN, ctx), null);
  assert.equal(odometerWarning(1, { last: null, trip: null }), null, 'nothing known, nothing to compare with');
  const trip = { last, trip: { start: asReading(benStart), end: asReading(benEnd) } };
  assert.deepEqual(odometerWarning(40999, trip), { kind: 'outside', start: 41000, end: 41120 });
  assert.deepEqual(odometerWarning(41121, trip), { kind: 'outside', start: 41000, end: 41120 });
  assert.equal(odometerWarning(41000, trip), null, 'the trip start itself is fine');
  assert.equal(odometerWarning(41120, trip), null);
  assert.equal(odometerWarning(41050, trip), null);
  assert.equal(warningText(null), '');
  assert.equal(warningText({ kind: 'lower', diff: 120, known: 41120 }), K.warnLower(120, 41120));
  assert.equal(warningText({ kind: 'higher', diff: 80 }), K.warnHigher(80));
  assert.equal(warningText({ kind: 'outside', start: 41000, end: 41120 }), K.warnOutsideDrive(41000, 41120));
});

test('gapDefaults: the two readings, and the times rounded inward to whole minutes so the new drive cannot overlap a neighbour', () => {
  const prev = { ...asReading(benEnd), at: '2026-06-15T06:00:20.500Z' };
  const next = { ...asReading(annaStart), at: '2026-06-15T08:30:40.250Z' };
  const d = gapDefaults({ ...asItem(gapBen), prev, next });
  assert.deepEqual(d, { start: '2026-06-15T06:01:00.000Z', end: '2026-06-15T08:30:00.000Z', odometerStart: 41120, odometerEnd: 41200 });

  const exact = gapDefaults({ ...asItem(gapBen), prev: { ...prev, at: '2026-06-15T06:00:00.000Z' }, next: { ...next, at: '2026-06-15T08:30:00.000Z' } });
  assert.equal(exact.start, '2026-06-15T06:00:00.000Z', 'a neighbour on a whole minute is touched, not overlapped');
  assert.equal(exact.end, '2026-06-15T08:30:00.000Z');

  // Nothing is left between the neighbours once rounded: the readings stay, the times are left to the form's defaults.
  const tight = gapDefaults({ ...asItem(gapBen), prev: { ...prev, at: '2026-06-15T06:00:20.000Z' }, next: { ...next, at: '2026-06-15T06:00:50.000Z' } });
  assert.deepEqual(tight, { start: null, end: null, odometerStart: 41120, odometerEnd: 41200 });
  const same = gapDefaults({ ...asItem(gapBen), prev: { ...prev, at: '2026-06-15T06:00:00.000Z' }, next: { ...next, at: '2026-06-15T06:00:00.000Z' } });
  assert.equal(same.start, null);
});

test('kmMarkers: the findings that touch one drive, in words, and the note of an explanation instead of the warning', () => {
  const M = S.kmcheck.marker;
  const anna = { id: 4, status: 'completed', odometerStart: 41200, odometerEnd: 41260 };
  const text = (els: FakeElement[]) => els.map((e) => e.textContent);
  const mk = (drive: Parameters<typeof kmMarkers>[0], items: Json[]) => text(kmMarkers(drive, items.map(asItem)) as unknown as FakeElement[]);
  // kmMarkers builds elements, so it needs the fake document for the duration of a plain test.
  const dom = installFakeDom();
  try {
    // gapBen ends in Anna's drive start (before it); gapFuel starts at her drive end (after it).
    assert.deepEqual(mk(anna, [gapFuel, gapBen]), [M.gapAfter(40), M.gapBefore(80)]);
    assert.deepEqual(mk({ id: 3, status: 'completed', odometerStart: 41000, odometerEnd: 41120 }, [gapFuel, gapBen]), [M.gapAfter(80)], 'Ben: only the stretch after his drive');
    assert.deepEqual(mk({ id: 99, status: 'completed', odometerStart: 1, odometerEnd: 2 }, [gapFuel, gapBen]), [], 'a drive that is in no finding has no marker');
    // A fill-up has its own id space: fill-up 4 is not drive 4.
    const fuel4 = reading({ source: 'fuel', id: 4, km: 41100, at: at(-500), userId: 1 });
    assert.deepEqual(mk(anna, [finding(benEnd, fuel4)]), [], 'fill-up 4 is not drive 4');

    // A fill-up during a finished drive that reads outside its own readings.
    const below = reading({ source: 'fuel', id: 8, km: 40900, at: at(-540), userId: 2 });
    const above = reading({ source: 'fuel', id: 9, km: 41500, at: at(-500), userId: 2 });
    const ben = { id: 3, status: 'completed', odometerStart: 41000, odometerEnd: 41120 };
    assert.deepEqual(mk(ben, [finding(benStart, below)]), [M.fuelBelow(100)]);
    assert.deepEqual(mk(ben, [finding(above, benEnd)]), [M.fuelAbove(380)]);
    // The same pair on a drive that has only its start reading is "after the drive", not a pump stop inside it.
    assert.deepEqual(mk({ id: 3, status: 'completed', odometerStart: 41000, odometerEnd: null }, [finding(benStart, below)]), [M.mismatchAfter(100)]);

    // A mismatch before the drive and an explained one.
    const lower = finding(annaEnd, reading({ source: 'drive-start', id: 6, km: 41000, at: at(-100), userId: 2 }));
    assert.deepEqual(mk({ id: 6, status: 'completed', odometerStart: 41000, odometerEnd: 41010 }, [lower]), [M.mismatchBefore(260)]);
    const explained = { ...gapBen, explained: { id: 1, note: 'Anna borrowed it', byId: 1, byName: 'Anna', at: at(-30) } };
    assert.deepEqual(mk(anna, [explained]), [M.explained('Anna borrowed it')]);
    // An open draft has no end reading: a finding after its start reading reads as after the drive.
    const draftStart = reading({ source: 'draft-start', id: 9, km: 41120, at: at(-60), userId: 1, draft: true });
    assert.deepEqual(mk({ id: 9, status: 'draft', odometerStart: 41120, odometerEnd: null }, [finding(draftStart, reading({ source: 'fuel', id: 7, km: 41200, at: at(-10), userId: 2 }))]), [M.gapAfter(80)]);
  } finally {
    dom.uninstall();
  }
});

test('the client repeats the server tolerance, and a typed reading is judged like two chained readings', () => {
  assert.equal(CLIENT_TOLERANCE, SERVER_TOLERANCE, 'one zero-tolerance rule on both sides');
  let seed = 7;
  const next = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  for (let i = 0; i < 100; i++) {
    const a = 1000 + next(9000);
    const b = a + next(400) - 200;
    const earlier = asReading(reading({ source: 'drive-end', id: 1, km: a, at: at(-100), userId: 2 }));
    // The server's view of the same two readings: a drive ending at a km, then a fill-up at b km.
    const drives: DriveInput[] = [{ id: 1, userId: 2, userName: 'Ben', start: at(-200), end: at(-100), odometerStart: a - 10, odometerEnd: a, draft: false }];
    const fuels: FuelInput[] = [{ id: 1, userId: 1, userName: 'Anna', at: at(-50), odometer: b }];
    const serverItem = deriveChain(drives, fuels, at(-1000)).items[0];
    const w = odometerWarning(b, { last: earlier, trip: null });
    if (b === a) {
      assert.equal(serverItem, undefined);
      assert.equal(w, null);
    } else {
      assert.equal(w?.kind === 'higher' ? 'gap' : 'mismatch', serverItem?.kind, `${a} then ${b}`);
      assert.equal(w && 'diff' in w ? w.diff : undefined, serverItem?.km);
    }
  }
});

test('the client and the server agree on the last known reading and on which fill-ups lie inside a trip (200 seeded households)', () => {
  let seed = 11;
  const next = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  const HOUR = 3_600_000;
  const base = Date.parse('2026-03-01T00:00:00.000Z');
  const windowFrom = '2026-01-01T00:00:00.000Z';
  for (let household = 0; household < 200; household++) {
    const drives: DriveInput[] = [];
    const fuels: FuelInput[] = [];
    let km = 20_000 + next(5000);
    let t = base;
    for (let d = 0; d < 6; d++) {
      const start = t + next(5) * HOUR;
      const end = start + (1 + next(4)) * HOUR;
      const legacy = next(7) === 0;
      const startKm = km + (next(3) === 0 ? next(50) : 0);
      const endKm = startKm + next(100);
      drives.push({
        id: d + 1,
        userId: 1 + next(2),
        userName: 'X',
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        odometerStart: legacy && next(2) === 0 ? null : startKm,
        odometerEnd: legacy ? null : endKm,
        draft: false,
      });
      km = endKm;
      t = end;
    }
    for (let f = 0; f < 5; f++) {
      fuels.push({
        id: f + 1,
        userId: 1,
        userName: 'X',
        at: new Date(base + next(40) * HOUR).toISOString(),
        odometer: next(6) === 0 ? null : 20_000 + next(5200),
      });
    }
    const chain = deriveChain(drives, fuels, windowFrom);
    const readings = chain.readings as unknown as OdometerReading[];
    assert.deepEqual(readingBefore(readings, '9999-12-31T00:00:00.000Z'), readings[readings.length - 1] ?? null, `household ${household}: the latest reading is the server's latest`);
    for (const probe of [0, 7, 13, 21, 33, 45]) {
      const iso = new Date(base + probe * HOUR).toISOString();
      const model = [...readings].reverse().find((r) => r.at <= iso) ?? null;
      assert.deepEqual(readingBefore(readings, iso), model, `household ${household}, at hour ${probe}`);
    }
    for (const f of fuels) {
      if (f.odometer === null) continue;
      const inChain = readings.some((r) => r.source === 'fuel' && r.id === f.id);
      const trip = odometerContext(readings, f.at, { fuel: f.id }, true).trip;
      assert.equal(trip !== null, !inChain, `household ${household}: fill-up ${f.id} is ${inChain ? 'a link in the chain' : 'inside a trip'} on the server`);
    }
  }
});

// ============================================================ the drive form

test('a new drive starts from the latest known reading and says where it comes from; the warning is a polite status, never an alert', async () => {
  const me = makeApp(ANNA);
  const routes = driveRoutes({ extra: odometerRoutes(asChain(chainA()) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = mount(dom, await driveForm(me));
    assert.equal(readingStart(form).value, '41300', 'the fill-up is the latest reading');
    assert.equal(lastKnown(form), lastKnownText(annaFuel));
    assert.match(lastKnown(form), /^Laatst bekend: 41\.300 km, jij, /, 'thousands dot and "jij" for the signed-in person');
    const region = warning(form);
    assert.equal(region.getAttribute('role'), 'status');
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.equal(region.textContent, '', 'always in the page, empty while everything fits');
    assert.equal(all(fieldRow(form, S.usage.odometerStart), '[role="alert"]').filter((e) => e.textContent !== '').length, 0, 'no alert on load');

    await typeInto(readingStart(form), '41000');
    assert.equal(region.textContent, K.warnLower(300, 41300));
    assert.equal(region.getAttribute('role'), 'status', 'still a status, never an alert');
    await typeInto(readingStart(form), '41500');
    assert.equal(region.textContent, K.warnHigher(200));
    await typeInto(readingStart(form), '41300');
    assert.equal(region.textContent, '');

    // A warning never blocks the save: the lower value goes to the server as typed, with no new refusal to fear.
    await typeInto(readingStart(form), '41000');
    await submitDrive(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/usage');
    assert.equal(sent.body['odometerStart'], 41000);
    assert.equal(sent.body['status'], 'draft');
  });
});

test('a household without readings has no prefill and no hint, and a failing kilometre check does not break the form', async () => {
  const me = makeApp(ANNA);
  for (const routes of [driveRoutes(), driveRoutes({ extra: { 'GET /api/odometer': () => refuse(500, 'internal') } })]) {
    await withClient({ now: NOW, routes }, async ({ dom, api }) => {
      const form = mount(dom, await driveForm(me));
      assert.equal(readingStart(form).value, '');
      assert.equal(lastKnown(form), '');
      assert.equal(warning(form).textContent, '');
      assert.equal(all(form, 'section.km-check').length, 0, 'nothing to check yet');
      await typeInto(readingStart(form), '100');
      await submitForm(form);
      assert.equal(onlyWrite(api).body['odometerStart'], 100);
    });
  }
});

test('a drive from an ended reservation starts from the reading before the reservation, not before now', async () => {
  const me = makeApp(ANNA);
  const ended = reservation({ start: at(-420), end: at(-360), note: 'Visit', kmState: 'missing' });
  const routes = driveRoutes({ reservations: [ended], extra: odometerRoutes(asChain(chainA()) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const form = mount(dom, await driveForm(me, 'res=7'));
    assert.deepEqual([startOf(form).date.value, startOf(form).time.value], ['2026-06-15', '05:00']);
    assert.equal(readingStart(form).value, '41120', 'Ben ended at 41120 before the reservation started; later readings do not count');
    assert.equal(lastKnown(form), lastKnownText(benEnd));
  });
});

test('Register km and I drove this (an upcoming reservation) start now, from the latest reading', async () => {
  const me = makeApp(BEN);
  const upcoming = reservation({ id: 7, userId: 1, userName: 'Anna', start: at(20), end: at(180) });
  const routes = driveRoutes({ reservations: [upcoming], extra: odometerRoutes(asChain(chainA()) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const form = mount(dom, await driveForm(me, 'res=7'));
    assert.equal(control(fieldRow(form, S.usage.reservation)).value, '7');
    assert.equal(readingStart(form).value, '41300');
    assert.equal(lastKnown(form), lastKnownText(annaFuel, 'Ben'), 'Ben sees Anna by name');
  });
});

test('an open draft keeps its own start reading and is compared with its predecessor; its own reading is never "the last known"', async () => {
  const me = makeApp(ANNA);
  // Ben ended at 41100; Anna's draft starts at 41120, 20 km further on.
  const bensEnd = reading({ ...benEnd, km: 41100 });
  const draftStart = reading({ source: 'draft-start', id: 9, km: 41120, at: at(-60), userId: 1, userName: 'Anna', draft: true });
  const routes = driveRoutes({
    usage: [draft(), usage()],
    reservations: [reservation()],
    extra: odometerRoutes(asChain(odometerChain([benStart, bensEnd, draftStart], [finding(bensEnd, draftStart)])) as unknown as Json),
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = mount(dom, await driveForm(me));
    assert.equal(one(form, 'h2').textContent, S.usage.finishTitle);
    assert.equal(readingStart(form).value, '41120', 'its own value stays');
    assert.equal(lastKnown(form), lastKnownText(bensEnd), 'compared with Ben\'s end, not with itself');
    assert.equal(warning(form).textContent, K.warnHigher(20));

    await typeInto(readingEnd(form), '41150');
    await submitDrive(form);
    assert.equal(onlyWrite(api).body['odometerStart'], 41120, 'saved as it is: the warning did not block');
  });
});

test('editing a finished drive leaves its own readings out of "the reading before"', async () => {
  const me = makeApp(BEN);
  const before = reading({ source: 'drive-end', id: 2, km: 40990, at: at(-900), userId: 1, userName: 'Anna' });
  const routes = driveRoutes({ usage: [usage()], extra: odometerRoutes(asChain(odometerChain([before, benStart, benEnd])) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const form = mount(dom, await driveForm(me, 'edit=3'));
    assert.equal(readingStart(form).value, '41000');
    assert.equal(lastKnown(form), lastKnownText(before, 'Ben'));
    assert.equal(warning(form).textContent, K.warnHigher(10), 'the drive\'s own two readings are not the predecessor');
  });
});

test('a new drive follows its start time: the prefill changes only while nobody typed over it', async () => {
  const me = makeApp(ANNA);
  const routes = driveRoutes({ extra: odometerRoutes(asChain(chainA()) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const form = mount(dom, await driveForm(me));
    assert.equal(readingStart(form).value, '41300');
    // 03:00 local is 01:00 UTC, 540 minutes before now: only Ben's start (41000) is that old.
    await typeInto(startOf(form).time, '03:00');
    assert.equal(readingStart(form).value, '41000', 'untouched, so it follows the start');
    assert.equal(lastKnown(form), lastKnownText(benStart));
    // 01:00 local is 23:00 UTC the evening before: nothing was read yet.
    await typeInto(startOf(form).time, '01:00');
    assert.equal(readingStart(form).value, '', 'nothing known before the first reading: the field is emptied again');
    assert.equal(lastKnown(form), '');

    await typeInto(startOf(form).time, '12:00');
    assert.equal(readingStart(form).value, '41300');
    await typeInto(readingStart(form), '41350');
    await typeInto(startOf(form).time, '03:00');
    assert.equal(readingStart(form).value, '41350', 'typed over: the start time no longer changes it');
    assert.equal(lastKnown(form), lastKnownText(benStart), 'but the hint and the warning follow the start');
    assert.equal(warning(form).textContent, K.warnHigher(350));
  });
});

// ------------------------------------------------------------- Add the missing drive

test('Add the missing drive: the form opens with the gap\'s readings and its times (whole minutes), no reservation, and saves like any drive', async () => {
  const me = makeApp(ANNA);
  const prev = reading({ source: 'drive-end', id: 3, km: 41120, at: '2026-06-15T06:00:20.500Z', userId: 2, userName: 'Ben' });
  const next = reading({ source: 'drive-start', id: 4, km: 41200, at: '2026-06-15T08:30:40.250Z', userId: 1, userName: 'Anna' });
  const gap = finding(prev, next);
  // Anna has a reservation running now: it must not be preselected for a gap in the past.
  const running = reservation({ start: at(-30), end: at(60) });
  const routes = driveRoutes({ reservations: [running], extra: odometerRoutes(asChain(odometerChain([prev, next], [gap])) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = mount(dom, await driveForm(me, `gap=${encodeURIComponent(gap['key'] as string)}`));
    assert.equal(one(form, 'h2').textContent, S.usage.logTitle);
    assert.ok(all(form, 'p.hint').some((p) => p.textContent === K.gapForm), 'it says where the values come from');
    assert.deepEqual([startOf(form).date.value, startOf(form).time.value], ['2026-06-15', '08:01'], '06:01 UTC, rounded up');
    assert.deepEqual([endOf(form).date.value, endOf(form).time.value], ['2026-06-15', '10:30'], '08:30 UTC, rounded down');
    assert.equal(readingStart(form).value, '41120');
    assert.equal(readingEnd(form).value, '41200');
    assert.equal(control(fieldRow(form, S.usage.reservation)).value, '', 'no reservation is preselected');
    assert.equal(all(form, 'p.hint').filter((p) => p.textContent === K.stale).length, 0);

    await submitDrive(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/usage', 'the normal route, with its normal overlap rules');
    assert.deepEqual(sent.body, { status: 'completed', start: '2026-06-15T06:01:00.000Z', end: '2026-06-15T08:30:00.000Z', odometerStart: 41120, odometerEnd: 41200, note: '' });
    assert.deepEqual(me.navigated, ['#/usage'], 'back to the list, where the gap is gone');
  });
});

test('a gap with nothing left between its neighbours keeps the readings and the normal default times; a stale key says so and gives the plain form', async () => {
  const me = makeApp(ANNA);
  const prev = reading({ source: 'drive-end', id: 3, km: 41120, at: '2026-06-15T06:00:20.000Z', userId: 2, userName: 'Ben' });
  const next = reading({ source: 'drive-start', id: 4, km: 41200, at: '2026-06-15T06:00:50.000Z', userId: 1, userName: 'Anna' });
  const gap = finding(prev, next);
  const routes = driveRoutes({ extra: odometerRoutes(asChain(odometerChain([prev, next], [gap])) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const form = mount(dom, await driveForm(me, `gap=${encodeURIComponent(gap['key'] as string)}`));
    assert.deepEqual([startOf(form).date.value, startOf(form).time.value], ['2026-06-15', '12:00'], 'the form\'s own default: now');
    assert.deepEqual([endOf(form).date.value, endOf(form).time.value], ['', '']);
    assert.equal(readingStart(form).value, '41120');
    assert.equal(readingEnd(form).value, '41200');

    const stale = mount(dom, await driveForm(me, 'gap=not-a-flagged-stretch'));
    const message = all(stale, 'p.hint').find((p) => p.textContent === K.stale);
    assert.ok(message, 'the stretch is not flagged any more');
    assert.equal(message.getAttribute('role'), 'status');
    assert.equal(readingEnd(stale).value, '', 'the form is the normal one');
    assert.equal(readingStart(stale).value, '41200', 'prefilled from the latest reading as usual');
  });
});

test('the gap link is ignored while a drive is being edited', async () => {
  const me = makeApp(ANNA);
  const routes = driveRoutes({ usage: [draft()], reservations: [reservation()], extra: odometerRoutes(asChain(chainA()) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const form = mount(dom, await driveForm(me, `edit=9&gap=${encodeURIComponent(gapBen['key'] as string)}`));
    assert.equal(one(form, 'h2').textContent, S.usage.finishTitle);
    assert.equal(readingStart(form).value, '41120', 'the draft\'s own reading');
    assert.equal(all(form, 'p.hint').filter((p) => p.textContent === K.gapForm || p.textContent === K.stale).length, 0);
  });
});

// ============================================== the Kilometre check section

const section = (root: unknown): FakeElement => one(root, 'section.km-check');
const items = (root: unknown): FakeElement[] => all(root, 'li.km-item');
const linkTexts = (root: unknown): string[] => all(root, 'a').map((a) => a.textContent);

test('the section names both neighbours of every finding and offers the fix, for everybody; it is not there without any reading', async () => {
  const me = makeApp(ANNA);
  const routes = driveRoutes({ extra: odometerRoutes(asChain(chainA()) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = mount(dom, await driveForm(me));
    const s = section(page);
    assert.equal(s.getAttribute('aria-labelledby'), 'km-check-title');
    const heading = one(s, 'h3');
    assert.equal(heading.textContent, K.title);
    assert.equal(heading.id, 'km-check-title');
    assert.equal(heading.getAttribute('tabindex'), '-1', 'a target for focus after a change');
    const rows = items(s);
    assert.equal(rows.length, 2);
    assert.equal(all(s, 'article').length, 0, 'list items, never articles (an article is a reservation or a drive)');

    const first = rows[0] as FakeElement;
    assert.equal(one(first, 'strong').textContent, K.gap(40, fmtWhen(annaEnd['at'] as string, TZ), fmtWhen(annaFuel['at'] as string, TZ)));
    assert.deepEqual(
      all(first, 'div.sub').map((d) => d.textContent),
      [K.neighbour(K.source['drive-end'], 41260, S.meLabel, fmtWhen(annaEnd['at'] as string, TZ)), K.neighbour(K.source.fuel, 41300, S.meLabel, fmtWhen(annaFuel['at'] as string, TZ))],
      'both ends: what kind of reading, how many km, whose and when',
    );
    assert.equal(byText(first, 'a', K.addMissing).getAttribute('href'), `#/usage?gap=${encodeURIComponent(gapFuel['key'] as string)}`);
    assert.equal(byText(first, 'a', K.editEarlier).getAttribute('href'), '#/usage?edit=4');
    assert.equal(byText(first, 'a', K.editLater).getAttribute('href'), '#/fuel?edit=5');

    // Ben's reading cannot be edited by Anna; hers can.
    const second = rows[1] as FakeElement;
    assert.deepEqual(linkTexts(second).sort(), [K.addMissing, K.editLater].sort());
    assert.equal(byText(second, 'a', K.editLater).getAttribute('href'), '#/usage?edit=4');
    assert.ok(one(second, 'details.km-explain'), 'Anna is involved, so she can explain it');
  });

  // Without a single reading there is nothing to check.
  assert.equal(kmCheckSectionOutsideDom(odometerChain()), null);
  const flat = odometerChain([benStart, benEnd]);
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const s = mount(dom, kmCheckSection(asChain(flat), { meId: 1, isAdmin: false, tz: TZ, hrefBase: '', toast: () => undefined, onChange: async () => undefined }));
    assert.equal(items(s).length, 0);
    assert.equal(one(s, 'p.km-ok').textContent, K.allAddUp, 'readings that add up say so');
  });
});

function kmCheckSectionOutsideDom(chain: Json): unknown {
  return kmCheckSection(asChain(chain), { meId: 1, isAdmin: false, tz: TZ, hrefBase: '', toast: () => undefined, onChange: async () => undefined });
}

test('a mismatch is flagged but has no "missing drive" to add; a gap after an open draft says the drive is not finished and offers Finish', async () => {
  const me = makeApp(ANNA);
  const lower = finding(annaEnd, reading({ source: 'drive-start', id: 6, km: 41000, at: at(-100), userId: 2, userName: 'Ben' }));
  const draftStart = reading({ source: 'draft-start', id: 9, km: 41120, at: at(-60), userId: 1, userName: 'Anna', draft: true });
  const afterDraft = finding(draftStart, reading({ source: 'fuel', id: 7, km: 41210, at: at(-10), userId: 2, userName: 'Ben' }));
  const routes = driveRoutes({ extra: odometerRoutes(asChain(odometerChain([annaEnd, draftStart], [afterDraft, lower])) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = mount(dom, await driveForm(me));
    const [draftRow, mismatchRow] = items(section(page)) as [FakeElement, FakeElement];
    assert.equal(one(mismatchRow, 'strong').textContent, K.mismatch(260, fmtWhen(annaEnd['at'] as string, TZ), fmtWhen(at(-100), TZ)));
    assert.ok((mismatchRow.className).includes('mismatch'));
    assert.equal(linkTexts(mismatchRow).includes(K.addMissing), false, 'a contradiction is not a missing drive');
    assert.ok(one(mismatchRow, 'details.km-explain'), 'but it can be explained');

    assert.ok(all(draftRow, 'div.hint').some((d) => d.textContent === K.draftHint));
    assert.equal(linkTexts(draftRow).includes(K.addMissing), false, 'the drive is already there, only unfinished');
    assert.equal(byText(draftRow, 'a', K.finishDrive).getAttribute('href'), '#/usage?edit=9', 'Anna may finish her own draft');
  });

  // Somebody else's draft: only an admin gets the link.
  const ben = makeApp(BEN);
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = mount(dom, await driveForm(ben));
    const draftRow = items(section(page)).find((li) => all(li, 'div.hint').some((d) => d.textContent === K.draftHint)) as FakeElement;
    assert.equal(linkTexts(draftRow).includes(K.finishDrive), false);
  });
});

test('Mark as explained needs a note and sends nothing without one; with one it posts the key and the trimmed note, then reloads and focuses the heading', async () => {
  const me = makeApp(ANNA);
  const routes = driveRoutes({
    extra: { ...odometerRoutes(asChain(chainA()) as unknown as Json), 'POST /api/odometer/explain': () => new Reply({ item: {} }, 201) },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = mount(dom, await driveForm(me));
    const row = items(section(page))[0] as FakeElement;
    assert.equal(one(row, 'summary').textContent, K.explainSummary);
    const noteRow = fieldRow(row, K.explainLabel);
    assert.equal(hintOf(noteRow), K.explainHint);
    assert.equal(K.explainLabel, 'Waarom is dit toegelicht? (verplicht)');

    await submitForm(row);
    assert.deepEqual(api.writes(), [], 'nothing is sent without a reason');
    assert.equal(errorOf(noteRow), S.fieldErrors.required);
    assert.equal(dom.focused(), control(noteRow), 'focus goes to the field');
    await typeInto(control(noteRow), '   ');
    await submitForm(row);
    assert.deepEqual(api.writes(), [], 'blank is still blank');

    await typeInto(control(noteRow), '  Borrowed by a neighbour  ');
    const refreshesBefore = me.refreshes();
    await submitForm(row);
    assert.deepEqual(onlyWrite(api), { method: 'POST', path: '/api/odometer/explain', query: '', body: { key: gapFuel['key'], note: 'Borrowed by a neighbour' } });
    assert.deepEqual(me.toasts, [{ message: K.explainSaved, isError: false }]);
    assert.equal(me.refreshes(), refreshesBefore + 1, 'the view is reloaded');
    assert.equal(dom.focused(), one(page, 'h3'), 'focus is back on the section heading, not lost with the rebuilt view');
  });
});

test('a refused explanation shows the reason on the field and the form and lets the person try again', async () => {
  const me = makeApp(ANNA);
  let answer: Reply = refuse(422, 'validation_failed', { fields: { note: 'too_long' } });
  const routes = driveRoutes({ extra: { ...odometerRoutes(asChain(chainA()) as unknown as Json), 'POST /api/odometer/explain': () => answer } });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = mount(dom, await driveForm(me));
    const row = items(section(page))[0] as FakeElement;
    await typeInto(control(fieldRow(row, K.explainLabel)), 'x');
    await submitForm(row);
    assert.equal(errorOf(fieldRow(row, K.explainLabel)), S.fieldErrors.too_long);
    assert.equal(one(row, 'p.form-error').textContent, S.errors.validation_failed);
    assert.equal(byText(row, 'button', K.explainSave).disabled, false);

    answer = refuse(404, 'not_found');
    await submitForm(row);
    assert.equal(one(row, 'p.form-error').hidden, false);
    assert.equal(one(row, 'p.form-error').textContent, S.errors.not_found, 'a stretch that is not flagged any more');
    assert.deepEqual(me.toasts, []);
  });
});

test('explained findings fold away with their note and who wrote it; whoever may can remove the explanation, after asking', async () => {
  const me = makeApp(ANNA);
  const explained = { ...gapBen, explained: { id: 11, note: 'An outsider drove it', byId: 2, byName: 'Ben', at: at(-30) }, can: { explain: true, unexplain: true } };
  const routes = driveRoutes({
    extra: { ...odometerRoutes(asChain(odometerChain([benStart, benEnd, annaStart, annaEnd, annaFuel], [gapFuel, explained])) as unknown as Json), 'DELETE /api/odometer/explained/11': () => new Reply(null, 204) },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = mount(dom, await driveForm(me));
    const s = section(page);
    assert.equal(items(s).length, 2, 'the explained one is in the page, folded');
    const folds = all(s, 'details.km-more');
    assert.equal(folds.length, 1);
    assert.equal(one(folds[0], 'summary').textContent, K.explainedHeading(1));
    const row = items(folds[0])[0] as FakeElement;
    assert.equal(one(row, 'div.note').textContent, 'An outsider drove it');
    assert.equal(all(row, 'div.sub').some((d) => d.textContent === K.explainedBy('Ben')), true);
    assert.equal(linkTexts(row).length, 0, 'an explained stretch offers no fix');
    assert.equal(all(row, 'details.km-explain').length, 0);
    assert.equal(all(items(s)[0] as FakeElement, 'details.km-explain').length, 1, 'the open one still can be explained');

    dom.answer = false;
    await byText(row, 'button', K.removeExplanation).fire('click');
    assert.deepEqual(dom.confirms, [K.confirmRemove]);
    assert.deepEqual(api.writes(), [], 'nothing is removed when the person says no');

    dom.answer = true;
    await byText(row, 'button', K.removeExplanation).fire('click');
    assert.deepEqual(onlyWrite(api), { method: 'DELETE', path: '/api/odometer/explained/11', query: '', body: undefined });
    assert.deepEqual(me.toasts, [{ message: K.removed, isError: false }]);
    assert.equal(dom.focused(), one(page, 'h3'));
  });

  // Somebody who is not involved sees the note but gets no button.
  const outsider = { ...explained, can: { explain: false, unexplain: false } };
  const quiet = driveRoutes({ extra: odometerRoutes(asChain(odometerChain([benStart, benEnd, annaStart], [outsider])) as unknown as Json) });
  await withClient({ now: NOW, routes: quiet }, async ({ dom }) => {
    const page = mount(dom, await driveForm(makeApp(ADMIN)));
    assert.equal(all(section(page), 'button').filter((b) => b.textContent === K.removeExplanation).length, 0);
    assert.equal(one(section(page), 'div.note').textContent, 'An outsider drove it');
  });
});

test('the newest three open findings show, the rest fold away', async () => {
  const me = makeApp(ANNA);
  const chain: Json[] = [];
  const found: Json[] = [];
  let km = 1000;
  for (let i = 0; i < 5; i++) {
    const a = reading({ source: 'drive-end', id: 10 + i, km, at: at(-1000 + i * 100), userId: 1, userName: 'Anna' });
    const b = reading({ source: 'drive-start', id: 20 + i, km: km + 10, at: at(-950 + i * 100), userId: 1, userName: 'Anna' });
    chain.push(a, b);
    found.unshift(finding(a, b));
    km += 500;
  }
  const routes = driveRoutes({ extra: odometerRoutes(asChain(odometerChain(chain, found)) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const s = section(mount(dom, await driveForm(me)));
    const direct = all(s, 'ul.km-list');
    assert.equal(direct.length, 2, 'the visible list and the folded one');
    assert.equal(items(direct[0]).length, 3);
    const folded = one(s, 'details.km-more');
    assert.equal(one(folded, 'summary').textContent, K.showMore(2));
    assert.equal(items(folded).length, 2);
    assert.equal(items(s).length, 5, 'all of them are in the page');
  });
});

// ------------------------------------------------------------ the markers

test('drives in the Drives list and in History carry the findings that touch them', async () => {
  const M = S.kmcheck.marker;
  const me = makeApp(ANNA);
  const annaDrive = usage({ id: 4, userId: 1, userName: 'Anna', start: at(-300), end: at(-240), odometerStart: 41200, odometerEnd: 41260, distanceKm: 60 });
  const benDrive = usage();
  const routes = driveRoutes({ usage: [annaDrive, benDrive], extra: odometerRoutes(asChain(chainA()) as unknown as Json) });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = mount(dom, await driveForm(me));
    const [annaCard, benCard] = all(page, 'article.usage') as [FakeElement, FakeElement];
    assert.deepEqual(all(annaCard, 'div.km-flag').map((d) => d.textContent), [M.gapAfter(40), M.gapBefore(80)]);
    assert.deepEqual(all(benCard, 'div.km-flag').map((d) => d.textContent), [M.gapAfter(80)]);
  });

  const history = {
    'GET /api/history': () => ({ usage: [{ ...annaDrive, reservation: null, sameDriver: null }, { ...benDrive, reservation: null, sameDriver: null }], reservations: [] }),
    'GET /api/fuel': () => ({ items: [], balances: [] }),
    ...odometerRoutes(asChain(chainA()) as unknown as Json),
  };
  await withClient({ now: NOW, routes: history }, async ({ dom }) => {
    const page = mount(dom, await renderHistory(me.app));
    const cards = all(page, 'article.history');
    assert.equal(cards.length, 2);
    assert.deepEqual(all(cards[0] as FakeElement, 'div.km-flag').map((d) => d.textContent), [M.gapAfter(40), M.gapBefore(80)]);
    assert.deepEqual(all(cards[1] as FakeElement, 'div.km-flag').map((d) => d.textContent), [M.gapAfter(80)]);
  });

  // The history is still there when the kilometre check cannot be loaded.
  const broken = { ...history, 'GET /api/odometer': () => refuse(500, 'internal') };
  await withClient({ now: NOW, routes: broken }, async ({ dom }) => {
    const page = mount(dom, await renderHistory(me.app));
    assert.equal(all(page, 'article.history').length, 2);
    assert.equal(all(page, 'div.km-flag').length, 0);
  });
});

// ============================================================ the fill-up form and cards

function fuelCard(over: Json = {}): Json {
  return {
    id: 5,
    userId: ANNA.id,
    userName: 'Anna',
    at: at(-100),
    millilitres: 40000,
    totalCents: 8000,
    pricePerLitreMillis: 2000,
    odometer: 41300,
    unaccountedKm: 0,
    note: '',
    period: { from: at(-20000), to: at(-100) },
    totalKm: 200,
    equalSplit: false,
    firstInData: false,
    shares: [{ userId: ANNA.id, userName: 'Anna', km: 100, cents: 4000, owes: false, request: null, can: { request: false, markPaid: false } }],
    hasPaidRequests: false,
    can: { edit: true, delete: true },
    canOdometer: true,
    ...over,
  };
}
const fuelRoutes = (items: Json[] = [], extra: Routes = {}): Routes => ({
  'GET /api/fuel': () => ({ items, balances: [] }),
  'POST /api/fuel': () => new Reply({ fuel: {} }, 201),
  'PATCH /api/fuel/5': () => ({ fuel: {} }),
  ...extra,
});
const fuelForm = (app: ReturnType<typeof makeApp>, query = '') => renderFuel(app.app, { query: new URLSearchParams(query) });
const fuelOdometer = (form: unknown) => control(fieldRow(form, S.fuel.odometer));
const fuelWarning = (form: unknown) => one(fieldRow(form, S.fuel.odometer), 'p.km-warn');

test('fill-up form: the odometer is required for a new fill-up, checked against the reading before, and sent as typed', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: fuelRoutes([], odometerRoutes(asChain(chainA()) as unknown as Json)) }, async ({ dom, api }) => {
    const form = mount(dom, await fuelForm(me));
    const row = fieldRow(form, S.fuel.odometer);
    assert.equal(S.fuel.odometer, 'Huidige kilometerstand (km)');
    assert.equal(hintOf(row), S.fuel.odometerHint);
    assert.equal(fuelOdometer(form).value, '', 'never prefilled: the point is to read it off the dashboard');
    assert.equal(one(row, '.km-last').textContent, lastKnownText(annaFuel), 'but the last known reading is shown');
    assert.equal(fuelWarning(form).getAttribute('role'), 'status');
    assert.equal(fuelWarning(form).getAttribute('aria-live'), 'polite');

    await typeInto(control(fieldRow(form, S.fuel.litres)), '40');
    await typeInto(control(fieldRow(form, S.fuel.total)), '80');
    await submitForm(form);
    assert.deepEqual(api.writes(), [], 'nothing is sent without the reading');
    assert.equal(errorOf(row), S.fieldErrors.required);
    assert.equal(dom.focused(), fuelOdometer(form), 'focus goes to the field that is missing');

    await typeInto(fuelOdometer(form), '41000');
    assert.equal(fuelWarning(form).textContent, K.warnLower(300, 41300));
    await typeInto(fuelOdometer(form), '41340');
    assert.equal(fuelWarning(form).textContent, K.warnHigher(40));
    await typeInto(fuelOdometer(form), '41300');
    assert.equal(fuelWarning(form).textContent, '');

    await typeInto(fuelOdometer(form), '41000');
    await submitForm(form);
    assert.deepEqual(onlyWrite(api).body, { at: NOW, millilitres: 40000, totalCents: 8000, note: '', odometer: 41000 }, 'the warning does not block the save');
  });
});

test('fill-up form: the required reading is reported together with other missing figures, and a refusal from the server shows on its field', async () => {
  const me = makeApp(ANNA);
  const routes = fuelRoutes([], { 'POST /api/fuel': () => refuse(422, 'validation_failed', { fields: { odometer: 'too_large' } }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = mount(dom, await fuelForm(me));
    await submitForm(form);
    assert.deepEqual(api.writes(), []);
    assert.equal(errorOf(fieldRow(form, S.fuel.odometer)), S.fieldErrors.required, 'shown even while the litres are still missing');
    assert.equal(errorOf(fieldRow(form, S.fuel.total)), S.fieldErrors.needs_two);

    await typeInto(control(fieldRow(form, S.fuel.litres)), '40');
    await typeInto(control(fieldRow(form, S.fuel.total)), '80');
    await typeInto(fuelOdometer(form), '99999999');
    await submitForm(form);
    assert.equal(errorOf(fieldRow(form, S.fuel.odometer)), S.fieldErrors.too_large);
    assert.equal(one(form, 'p.form-error').textContent, S.errors.validation_failed);
    assert.equal(byText(form, 'button', S.fuel.save).disabled, false);
  });
});

test('fill-up form: a fill-up during a trip is compared with that drive\'s own readings', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: fuelRoutes([], odometerRoutes(asChain(chainA()) as unknown as Json)) }, async ({ dom }) => {
    const form = mount(dom, await fuelForm(me));
    // 03:00 local is 01:00 UTC: inside Ben's drive 3 (00:00 to 02:00 UTC, 41000 to 41120).
    await typeInto(dateTime(fieldRow(form, S.fuel.when)).time, '03:00');
    assert.equal(one(fieldRow(form, S.fuel.odometer), '.km-last').textContent, lastKnownText(benStart), 'the reading before it is the start of the drive');
    await typeInto(fuelOdometer(form), '41300');
    assert.equal(fuelWarning(form).textContent, K.warnOutsideDrive(41000, 41120));
    await typeInto(fuelOdometer(form), '41060');
    assert.equal(fuelWarning(form).textContent, '', 'between the drive\'s own readings: nothing to say');
  });
});

test('fill-up form: a fill-up from before the kilometre check may stay without a reading, one that has a reading cannot lose it', async () => {
  const me = makeApp(ANNA);
  const legacy = fuelCard({ odometer: null });
  await withClient({ now: NOW, routes: fuelRoutes([legacy]) }, async ({ dom, api }) => {
    const form = mount(dom, await fuelForm(me, 'edit=5'));
    assert.equal(fuelOdometer(form).value, '');
    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'PATCH /api/fuel/5');
    assert.equal('odometer' in sent.body, false, 'no reading typed, so the key is left out and the old row stays as it is');
    assert.equal(errorOf(fieldRow(form, S.fuel.odometer)), '');

    await typeInto(fuelOdometer(form), '41290');
    await submitForm(form);
    assert.equal(api.writes()[1]?.body['odometer'], 41290, 'setting it later is allowed');
  });

  const set = fuelCard({ odometer: 41300 });
  await withClient({ now: NOW, routes: fuelRoutes([set]) }, async ({ dom, api }) => {
    const form = mount(dom, await fuelForm(me, 'edit=5'));
    assert.equal(fuelOdometer(form).value, '41300');
    await typeInto(fuelOdometer(form), '');
    await submitForm(form);
    assert.deepEqual(api.writes(), [], 'it cannot be cleared');
    assert.equal(errorOf(fieldRow(form, S.fuel.odometer)), S.fieldErrors.required);
    await typeInto(fuelOdometer(form), '41310');
    await submitForm(form);
    assert.equal(onlyWrite(api).body['odometer'], 41310);
  });
});

test('fill-up form: while a payment depends on the fill-up only the reading can be corrected, and exactly that is sent', async () => {
  const me = makeApp(ANNA);
  const locked = fuelCard({ hasPaidRequests: true, can: { edit: false, delete: false }, canOdometer: true, note: 'Shell' });
  await withClient({ now: NOW, routes: fuelRoutes([locked]) }, async ({ dom, api }) => {
    const form = mount(dom, await fuelForm(me, 'edit=5'));
    assert.ok(all(form, 'p.hint').some((p) => p.textContent === S.fuel.odometerOnlyHint), 'it says why only one field is open');
    for (const label of [S.fuel.litres, S.fuel.total, S.fuel.pricePerLitre, S.reserve.note]) {
      assert.equal(control(fieldRow(form, label)).disabled, true, `${label} is locked`);
    }
    for (const input of all(fieldRow(form, S.fuel.when), 'input')) assert.equal(input.disabled, true, 'the time is locked');
    assert.equal(fuelOdometer(form).disabled, false);

    await typeInto(fuelOdometer(form), '');
    await submitForm(form);
    assert.deepEqual(api.writes(), [], 'the reading is what is being corrected: it cannot be empty');
    assert.equal(errorOf(fieldRow(form, S.fuel.odometer)), S.fieldErrors.required);

    await typeInto(fuelOdometer(form), '41310');
    await submitForm(form);
    assert.deepEqual(onlyWrite(api).body, { odometer: 41310 }, 'exactly the reading, nothing else of a locked fill-up');
  });

  // Somebody who is not the fueler (and no admin) does not get the form for it.
  const notMine = fuelCard({ userId: BEN.id, userName: 'Ben', can: { edit: false, delete: false }, canOdometer: false });
  await withClient({ now: NOW, routes: fuelRoutes([notMine]) }, async ({ dom }) => {
    const page = mount(dom, await fuelForm(me, 'edit=5'));
    assert.equal(one(page, 'form').querySelector('h3')?.textContent, S.fuel.addTitle, 'it opens the empty form instead');
  });
});

test('fuel cards show the reading, the unaccounted kilometres of their period, and Correct odometer only where it is the one thing left', async () => {
  const me = makeApp(ANNA);
  const plain = fuelCard({ id: 5, odometer: 41300, unaccountedKm: 40 });
  const legacy = fuelCard({ id: 4, odometer: null, unaccountedKm: undefined });
  const locked = fuelCard({ id: 3, hasPaidRequests: true, can: { edit: false, delete: false }, canOdometer: true, unaccountedKm: 0 });
  const other = fuelCard({ id: 2, userId: BEN.id, userName: 'Ben', can: { edit: false, delete: false }, canOdometer: false });
  await withClient({ now: NOW, routes: fuelRoutes([plain, legacy, locked, other]) }, async ({ dom }) => {
    const page = mount(dom, await fuelForm(me));
    const card = (id: number): FakeElement => one(page, `#fuel-${id}`);
    assert.ok(all(card(5), 'div.sub').some((d) => d.textContent === S.fuel.odometerLine(41300)));
    assert.equal(S.fuel.unaccounted(40), '40 km niet geregistreerd in deze periode; de verdeling telt alleen geregistreerde km');
    assert.ok(all(card(5), 'div.km-flag').some((d) => d.textContent === S.fuel.unaccounted(40)));
    assert.equal(all(card(5), 'a').some((a) => a.textContent === S.fuel.correctOdometer), false, 'an editable fill-up has Edit instead');

    assert.equal(all(card(4), 'div.sub').some((d) => d.textContent.startsWith('Odometer:')), false, 'a legacy fill-up has no reading line');
    assert.equal(all(card(4), 'div.km-flag').length, 0, 'and an older server answer without the field shows nothing');

    assert.equal(all(card(3), 'div.km-flag').length, 0, 'no gap, no note');
    assert.equal(byText(card(3), 'a', S.fuel.correctOdometer).getAttribute('href'), '#/fuel?edit=3');
    assert.equal(all(card(2), 'a').some((a) => a.textContent === S.fuel.correctOdometer), false, 'somebody else\'s fill-up');
  });
});

// ================================================================ the admin page

test('admin page: the same Kilometre check on the Drives tab, with links into the member app, and the tab still works without it', async () => {
  const session = { user: ADMIN, timeZone: TZ, windowMonths: 6, serverTime: NOW };
  let answer: Json | Reply = chainA();
  const explained: Json[] = [];
  const asAdmin = (c: Json): Json => ({ ...c, items: (c['items'] as Json[]).map((i) => ({ ...i, can: { explain: true, unexplain: false } })) });
  const routes: Routes = {
    'GET /api/auth/me': () => session,
    'GET /api/admin/users': () => ({ users: [ANNA, BEN, ADMIN] }),
    'GET /api/usage': () => ({ items: [usage()] }),
    'GET /api/usage/pending': () => ({ items: [], count: 0 }),
    'GET /api/reservations': () => ({ items: [] }),
    'GET /api/odometer': () => (answer instanceof Reply ? answer : asAdmin(answer)),
    'POST /api/odometer/explain': (call) => {
      explained.push(call.body);
      return new Reply({ item: {} }, 201);
    },
  };
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = (id: string): FakeElement => {
      const el = (globalThis as Json)['document'].createElement('div') as FakeElement;
      el.id = id;
      return dom.mount(el);
    };
    const root = page('admin');
    page('toast');
    Object.defineProperty(globalThis, 'location', { value: { replace: () => undefined }, configurable: true, writable: true });
    await import('../public/admin/admin.js');
    await until(() => all(root, '.admin-tabs button').length === 4 && all(root, 'table').length > 0, 'the admin page to start');
    const odometerCalls = () => api.calls.filter((c) => c.path === '/api/odometer').length;
    assert.equal(odometerCalls(), 0, 'the users tab does not ask for it');

    await one(root, 'button[data-tab="usage"]').fire('click');
    await until(() => all(root, 'section.km-check').length === 1, 'the Kilometre check on the Drives tab');
    const s = section(root);
    assert.equal(one(s, 'h2').textContent, K.title, 'a section heading like the others on the admin page');
    assert.equal(items(s).length, 2);
    const first = items(s)[0] as FakeElement;
    assert.equal(byText(first, 'a', K.addMissing).getAttribute('href'), `/#/usage?gap=${encodeURIComponent(gapFuel['key'] as string)}`, 'the form lives in the member app');
    assert.equal(byText(first, 'a', K.editLater).getAttribute('href'), '/#/fuel?edit=5', 'an admin may edit anybody\'s reading');
    assert.equal(byText(first, 'a', K.editEarlier).getAttribute('href'), '/#/usage?edit=4');

    // An admin explains from here; the tab reloads and the overview is asked for again.
    const before = odometerCalls();
    await typeInto(control(fieldRow(first, K.explainLabel)), 'Pump detour');
    await submitForm(first);
    await until(() => odometerCalls() > before, 'the tab to reload');
    assert.deepEqual(explained, [{ key: gapFuel['key'], note: 'Pump detour' }]);

    // Without the check (the call fails) the tab still lists the drives.
    answer = refuse(500, 'internal');
    await one(root, 'button[data-tab="reservations"]').fire('click');
    await until(() => all(root, 'section.km-check').length === 0, 'the other tab');
    await one(root, 'button[data-tab="usage"]').fire('click');
    await until(() => all(root, 'table').length > 0 && all(root, 'section.km-check').length === 0, 'the Drives tab without the check');
    assert.equal(all(root, 'table').length > 0, true);
  });
});
