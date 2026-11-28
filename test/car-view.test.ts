// What the person sees and what the app sends on the Car tab: the APK card (not set, valid, due soon, today,
// expired) and its date form, the damage form (defaults, exact bodies, validation, server refusals), the lists
// with the neutral driver hint, Mark repaired, Reopen, Edit and Delete, and the wiring in the app shell
// (a place under Meer, the page title, the service worker).
//
// The real view code runs against the fake DOM, a stubbed fetch and a clock that stands still
// (test/fake-dom.ts): 12:00 on 15 June 2026 in Amsterdam, so "today" is 2026-06-15. Who was driving before
// the noticed day is the server's job (test/car.test.ts); here the point is that the form sends what the
// server expects and the list words what the server answered, without ever blaming anybody.
// Layout at 390 and 320 px and focus rings stay with the headless browser pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECONDARY, placeOf, titleOf } from '../public/nav.js';
import { S } from '../public/strings.js';
import * as carView from '../public/views/car.js';
import { APK_SOON_DAYS, APK_YEARS_AHEAD, DESCRIPTION_MAX, REPAIR_NOTE_MAX, apkSummary, dateProblem, hintText, render as renderCar } from '../public/views/car.js';
import { addDateKeyYears, formatDateKey } from '../shared/time.js';
import { APK_YEARS_AHEAD as SERVER_APK_YEARS_AHEAD, DESCRIPTION_MAX as SERVER_DESCRIPTION_MAX, REPAIR_NOTE_MAX as SERVER_REPAIR_NOTE_MAX } from '../src/car.ts';
import {
  ANNA,
  BEN,
  NOW,
  Reply,
  ADMIN,
  all,
  at,
  byText,
  control,
  errorOf,
  fieldRow,
  hintOf,
  makeApp,
  one,
  refuse,
  typeInto,
  until,
  withClient,
  type ApiStub,
  type Call,
  type FakeDom,
  type FakeElement,
  type Routes,
} from './fake-dom.ts';
import type { Json } from './helpers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** Today in these tests (12:00 on 15 June 2026 in Amsterdam). */
const TODAY = '2026-06-15';

const view = (dom: FakeDom, rendered: unknown): FakeElement => dom.mount(rendered);
const carPage = (app: ReturnType<typeof makeApp>, query = '') => renderCar(app.app, { query: new URLSearchParams(query) });

function onlyWrite(api: ApiStub): Call {
  const writes = api.writes();
  assert.equal(writes.length, 1, `expected exactly one write, got ${JSON.stringify(writes.map((c) => `${c.method} ${c.path}`))}`);
  return writes[0] as Call;
}

/** The APK as the server sends it. */
const apkAnswer = (expiresOn: string | null, over: Json = {}): Json => ({
  apk: expiresOn
    ? { expiresOn, daysLeft: Math.round((Date.parse(expiresOn) - Date.parse(TODAY)) / 86_400_000), updatedBy: { id: BEN.id, name: 'Ben' }, updatedAt: at(-2000), ...over }
    : { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null },
});

/** A damage report as the server sends it: Anna filed it, and the drive log has Ben driving before that day. */
const report = (over: Json = {}): Json => ({
  id: 1,
  noticedOn: '2026-06-10',
  noticedBy: { id: ANNA.id, name: 'Anna' },
  reportedBy: { id: ANNA.id, name: 'Anna' },
  description: 'Dent in the rear left door',
  location: 'rear',
  status: 'open',
  repairedOn: null,
  repairNote: '',
  createdAt: at(-5),
  updatedAt: at(-5),
  hint: { driver: { id: BEN.id, name: 'Ben' }, basis: 'drive' },
  can: { edit: true, delete: true, repair: true },
  ...over,
});

const repairedReport = (over: Json = {}): Json => report({ id: 2, status: 'repaired', repairedOn: '2026-06-12', repairNote: 'Fixed at the garage', can: { edit: true, delete: true, repair: false }, ...over });

const carRoutes = (reports: Json[] = [], apk: Json = apkAnswer(null), extra: Routes = {}): Routes => ({
  'GET /api/car/apk': () => apk,
  'GET /api/damage': () => ({ items: reports }),
  'POST /api/damage': () => new Reply({ report: {} }, 201),
  ...extra,
});

const apkCard = (page: unknown): FakeElement => one(page, 'section.apk-card');
const apkForm = (page: unknown): FakeElement => one(apkCard(page), 'form');
const damageForm = (page: unknown): FakeElement => one(page, 'form.card');
const apkRow = (page: unknown): FakeElement => fieldRow(apkForm(page), S.car.apk.label);
const noticedOnRow = (page: unknown): FakeElement => fieldRow(damageForm(page), S.car.noticedOn);
const noticedByRow = (page: unknown): FakeElement => fieldRow(damageForm(page), S.car.noticedBy);
const whereRow = (page: unknown): FakeElement => fieldRow(damageForm(page), S.car.where);
const descriptionRow = (page: unknown): FakeElement => fieldRow(damageForm(page), S.car.description);
const damageCard = (page: unknown, id: number): FakeElement => one(page, `article#damage-${id}`);
const optionTexts = (select: FakeElement): string[] => select.descendants().filter((e) => e.tagName === 'option').map((o) => o.textContent);
const optionValues = (select: FakeElement): string[] => select.descendants().filter((e) => e.tagName === 'option').map((o) => o.value);
const submit = (form: FakeElement): Promise<void> => form.fire('submit');

// ------------------------------------------------------------ the pure helpers

test('dateProblem: empty, not a real day, outside 2000 to 2100, after the latest day and before the earliest each give their own code', () => {
  assert.equal(dateProblem('', TODAY), 'required');
  for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-5', '15-06-2026', '2026-06-15T10:00', 'abc']) assert.equal(dateProblem(bad, '2100-12-31'), 'invalid_date', bad);
  assert.equal(dateProblem('1999-12-31', TODAY), 'invalid_date');
  assert.equal(dateProblem('2101-01-01', '2200-01-01'), 'invalid_date');
  assert.equal(dateProblem('2026-06-16', TODAY), 'in_future');
  assert.equal(dateProblem('2026-06-15', TODAY), null, 'the latest day itself is fine');
  assert.equal(dateProblem('2028-02-29', '2031-06-15', undefined, { tooLate: 'too_far_ahead' }), null, 'a leap day exists');
  assert.equal(dateProblem('2031-06-16', '2031-06-15', undefined, { tooLate: 'too_far_ahead' }), 'too_far_ahead');
  assert.equal(dateProblem('2026-06-09', TODAY, '2026-06-10', { tooLate: 'in_future', tooEarly: 'before_noticed' }), 'before_noticed');
  assert.equal(dateProblem('2026-06-10', TODAY, '2026-06-10', { tooLate: 'in_future', tooEarly: 'before_noticed' }), null, 'the same day as it was noticed is fine');
});

test('apkSummary: valid, due soon, today and expired, counted in calendar days', () => {
  const at30 = apkSummary('2026-07-15', TODAY);
  assert.deepEqual([at30.kind, at30.daysLeft, at30.badge], ['soon', APK_SOON_DAYS, S.car.apk.badge.soon], 'exactly 30 days is already due soon');
  assert.equal(at30.headline, S.car.apk.expiresOn(formatDateKey('2026-07-15')));
  assert.equal(at30.detail, S.car.apk.inDays(30));
  assert.equal(apkSummary('2026-07-16', TODAY).kind, 'ok', '31 days is still comfortable');
  assert.equal(apkSummary('2026-07-16', TODAY).badge, S.car.apk.badge.ok);
  assert.equal(apkSummary('2026-06-16', TODAY).detail, S.car.apk.inDays(1));
  assert.match(S.car.apk.inDays(1), /morgen/);
  const today = apkSummary(TODAY, TODAY);
  assert.deepEqual([today.kind, today.daysLeft, today.badge, today.detail], ['today', 0, S.car.apk.badge.today, S.car.apk.todayDetail]);
  const yesterday = apkSummary('2026-06-14', TODAY);
  assert.deepEqual([yesterday.kind, yesterday.daysLeft, yesterday.badge], ['expired', -1, S.car.apk.badge.expired]);
  assert.equal(yesterday.headline, S.car.apk.expiredOn(formatDateKey('2026-06-14')));
  assert.equal(yesterday.detail, S.car.apk.expiredDays(1));
  assert.match(S.car.apk.expiredDays(1), /gisteren/);
  assert.equal(apkSummary('2026-03-01', TODAY).detail, S.car.apk.expiredDays(106), 'longer ago');
  // Across the clock change of 29 March 2026 a day is still one day.
  assert.equal(apkSummary('2026-03-30', '2026-03-28').daysLeft, 2);
  assert.equal(apkSummary('2026-10-26', '2026-10-24').daysLeft, 2);
});

test('hintText: says what the records show and what it rests on, for every basis, and says so when nobody is on record', () => {
  const ben = { id: BEN.id, name: 'Ben' };
  assert.equal(hintText({ driver: ben, basis: 'drive' }), S.car.hint.drive('Ben'));
  assert.equal(hintText({ driver: ben, basis: 'draft' }), S.car.hint.draft('Ben'));
  assert.equal(hintText({ driver: ben, basis: 'reservation' }), S.car.hint.reservation('Ben'));
  assert.equal(hintText({ driver: ben, basis: 'last_drive' }), S.car.hint.last_drive('Ben'));
  assert.equal(hintText({ driver: null, basis: 'none' }), S.car.hint.none);
  assert.equal(hintText({ driver: null, basis: 'drive' }), S.car.hint.none, 'a hint without a person never names anybody');
});

test('the words of the hint are neutral: information with its basis, never a conclusion or an accusation', () => {
  const sentences = [
    S.car.hint.drive('Ben'),
    S.car.hint.draft('Ben'),
    S.car.hint.reservation('Ben'),
    S.car.hint.last_drive('Ben'),
    S.car.hint.none,
    S.car.hint.note,
    S.car.intro,
  ].join(' ');
  assert.doesNotMatch(sentences, /\b(schuld|schuldig|schuldige|verantwoordelijk|dader|veroorzaakt door|gebroken door|beschadigd door)\b/i);
  assert.match(S.car.hint.note, /zegt niets|alleen ter informatie/i);
  // Each basis says what it rests on: the drive log, an unfinished drive, a reservation, the last logged drive.
  assert.match(S.car.hint.drive('Ben'), /ritlogboek/);
  assert.match(S.car.hint.draft('Ben'), /niet is afgerond/);
  assert.match(S.car.hint.reservation('Ben'), /gereserveerd/);
  assert.match(S.car.hint.last_drive('Ben'), /laatste rit die/);
});

// ------------------------------------------------------------------ the APK card

test('APK card: when the date was never entered it says so, asks for it and offers to save it', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes() }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    const card = apkCard(page);
    assert.equal(one(card, 'h3').textContent, S.car.apk.title);
    const notice = one(card, '.apk-state.notice');
    assert.equal(one(notice, 'strong').textContent, S.car.apk.notSet);
    assert.ok(all(notice, 'div').some((d) => d.textContent === S.car.apk.prompt), 'a clear prompt to enter it');
    assert.equal(all(card, '.badge-status').length, 0, 'no state badge without a date');
    assert.equal(one(apkForm(page), 'button[type="submit"]').textContent, S.car.apk.save);
    const input = control(apkRow(page));
    assert.equal(input.value, '');
    assert.equal(input.getAttribute('type'), 'date');
    assert.equal(input.getAttribute('min'), '2000-01-01');
    assert.equal(input.getAttribute('max'), addDateKeyYears(TODAY, APK_YEARS_AHEAD), 'the picker stops at the same day as the server: today plus five years, clamped');
    assert.equal(hintOf(apkRow(page)), S.car.apk.hint);
  });
});

test('APK card: a date shows the date, how many days are left, a state badge and who entered it and when', async () => {
  const me = makeApp(ANNA);
  const cases: Array<[string, string, string, string]> = [
    ['2026-09-30', 'ok', 'confirmed', S.car.apk.badge.ok],
    ['2026-07-01', 'soon', 'pending', S.car.apk.badge.soon],
    [TODAY, 'today', 'pending', S.car.apk.badge.today],
    ['2026-06-01', 'expired', 'declined', S.car.apk.badge.expired],
  ];
  for (const [expiresOn, kind, badgeClass, badge] of cases) {
    await withClient({ now: NOW, routes: carRoutes([], apkAnswer(expiresOn, { updatedBy: { id: BEN.id, name: 'Ben' }, updatedAt: '2026-06-01T10:00:00.000Z' })) }, async ({ dom }) => {
      const page = view(dom, await carPage(me));
      const state = one(apkCard(page), '.apk-state');
      const expected = apkSummary(expiresOn, TODAY);
      assert.equal(expected.kind, kind);
      assert.equal(one(state, 'strong').textContent, expected.headline);
      assert.equal(one(state, '.badge-status').textContent, badge);
      assert.ok(one(state, '.badge-status').className.split(/\s+/).includes(badgeClass), `${kind}: ${badgeClass}`);
      assert.ok(all(state, '.sub').some((e) => e.textContent === expected.detail), kind);
      assert.ok(all(state, '.sub').some((e) => e.textContent === S.car.apk.updatedBy('Ben', formatDateKey('2026-06-01'))), 'who entered it, and on which day');
      assert.equal(all(apkCard(page), '.notice').length, 0, 'the "not set" prompt is gone');
      assert.equal(control(apkRow(page)).value, expiresOn, 'the form starts with the stored date');
      assert.equal(one(apkForm(page), 'button[type="submit"]').textContent, S.car.apk.update);
    });
  }
});

test('APK card: Save date is the main button only while the date is missing; once it is set the main action of the page is Save report', async () => {
  const me = makeApp(ANNA);
  const isPrimary = (button: FakeElement) => button.className.split(/\s+/).includes('primary');
  const main = (page: unknown) => ({ apk: isPrimary(one(apkForm(page), 'button[type="submit"]')), report: isPrimary(one(damageForm(page), 'button[type="submit"]')) });
  await withClient({ now: NOW, routes: carRoutes([], apkAnswer(null)) }, async ({ dom }) => {
    assert.deepEqual(main(view(dom, await carPage(me))), { apk: true, report: true }, 'asking for the date is the thing to do while it is missing');
  });
  await withClient({ now: NOW, routes: carRoutes([], apkAnswer('2026-09-30')) }, async ({ dom }) => {
    assert.deepEqual(main(view(dom, await carPage(me))), { apk: false, report: true }, 'one main action per view');
  });
});

test('APK card: the person who entered the date is called "you", and the day is the household day of the update, not the UTC one', async () => {
  const me = makeApp(ANNA);
  // 23:30 UTC on 10 June is 01:30 on 11 June in Amsterdam.
  await withClient({ now: NOW, routes: carRoutes([], apkAnswer('2026-09-30', { updatedBy: { id: ANNA.id, name: 'Anna' }, updatedAt: '2026-06-10T23:30:00.000Z' })) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    assert.ok(all(apkCard(page), '.sub').some((e) => e.textContent === S.car.apk.updatedBy(S.you, formatDateKey('2026-06-11'))));
  });
});

test('"today" is the household day: at half past midnight in Amsterdam the form, the limits and the APK all say 16 June although it is still 15 June in UTC', async () => {
  const me = makeApp(ANNA);
  const justAfterMidnight = '2026-06-15T22:30:00.000Z'; // 00:30 on 16 June in Amsterdam
  const routes = carRoutes([report({ id: 1, noticedOn: '2026-06-15', can: { edit: false, delete: false, repair: true } })], apkAnswer('2026-06-16'));
  await withClient({ now: justAfterMidnight, routes }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    assert.equal(control(noticedOnRow(page)).value, '2026-06-16', 'a new report is noticed on the household day');
    assert.equal(control(noticedOnRow(page)).getAttribute('max'), '2026-06-16');
    // The APK runs out on the household's today, not tomorrow.
    const state = apkSummary('2026-06-16', '2026-06-16');
    assert.equal(one(apkCard(page), '.apk-state strong').textContent, state.headline);
    assert.equal(one(apkCard(page), '.badge-status').textContent, S.car.apk.badge.today);
    assert.ok(all(apkCard(page), '.sub').some((e) => e.textContent === S.car.apk.todayDetail));
    // And the repair form starts on that day, with the same limit.
    await byText(damageCard(page, 1), 'button', S.car.markRepaired).fire('click');
    const repairedOn = control(fieldRow(one(damageCard(page, 1), 'form.repair-form'), S.car.repairedOn));
    assert.equal(repairedOn.value, '2026-06-16');
    assert.equal(repairedOn.getAttribute('max'), '2026-06-16');
  });
});

test('APK form: saving sends the date as a plain calendar day, says so, reloads and puts focus on the heading', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes([], apkAnswer(null), { 'PATCH /api/car/apk': () => apkAnswer('2027-03-01') }) }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    await typeInto(control(apkRow(page)), '2027-03-01');
    await submit(apkForm(page));
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'PATCH /api/car/apk');
    assert.deepEqual(sent.body, { expiresOn: '2027-03-01' }, 'a date with no time and no zone');
    assert.deepEqual(me.toasts, [{ message: S.car.apk.saved, isError: false }]);
    assert.equal(me.refreshes(), 1);
    assert.equal(dom.focused()?.tagName, 'h2');
    assert.equal(dom.focused()?.textContent, S.car.title);
  });
});

test('APK form: a date that is empty, not a real day, too far ahead or before 2000 is refused on the field and nothing is sent', async () => {
  const me = makeApp(ANNA);
  const limit = addDateKeyYears(TODAY, APK_YEARS_AHEAD);
  const dayAfterLimit = addDateKeyYears(TODAY, APK_YEARS_AHEAD).replace(/-(\d\d)$/, (_m, d: string) => `-${String(Number(d) + 1).padStart(2, '0')}`);
  await withClient({ now: NOW, routes: carRoutes([], apkAnswer(null), { 'PATCH /api/car/apk': () => apkAnswer('2027-03-01') }) }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    const input = control(apkRow(page));
    for (const [typed, code] of [
      ['', 'required'],
      ['2027-02-29', 'invalid_date'],
      ['2026-13-01', 'invalid_date'],
      ['1999-12-31', 'invalid_date'],
      [dayAfterLimit, 'too_far_ahead'],
    ] as const) {
      await typeInto(input, typed);
      await submit(apkForm(page));
      assert.equal(errorOf(apkRow(page)), S.fieldErrors[code], `"${typed}"`);
      assert.equal(dom.focused(), input, 'focus goes to the field that needs fixing');
      assert.equal(input.getAttribute('aria-invalid'), 'true');
    }
    assert.deepEqual(api.writes(), [], 'no request was made');
    // The limit itself, a leap day and a day in the past are all fine (an APK may already have run out).
    for (const typed of [limit, '2028-02-29', '2026-01-01']) {
      await typeInto(input, typed);
      await submit(apkForm(page));
      assert.equal(errorOf(apkRow(page)), '', `"${typed}" is accepted`);
    }
    assert.deepEqual(api.writes().map((c) => c.body['expiresOn']), [limit, '2028-02-29', '2026-01-01']);
  });
});

test('APK form: a refusal from the server shows on the field and as a message, and the button works again', async () => {
  const me = makeApp(ANNA);
  const answer = refuse(422, 'validation_failed', { fields: { expiresOn: 'too_far_ahead' } });
  await withClient({ now: NOW, routes: carRoutes([], apkAnswer(null), { 'PATCH /api/car/apk': () => answer }) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    await typeInto(control(apkRow(page)), '2027-03-01');
    await submit(apkForm(page));
    assert.equal(errorOf(apkRow(page)), S.fieldErrors.too_far_ahead);
    const message = one(apkForm(page), 'p.form-error');
    assert.equal(message.hidden, false);
    assert.equal(message.textContent, S.errors.validation_failed);
    assert.equal(dom.focused()?.getAttribute('aria-invalid'), 'true');
    assert.equal(one(apkForm(page), 'button[type="submit"]').disabled, false);
    assert.deepEqual(me.toasts, []);
    assert.equal(me.refreshes(), 0);
    assert.match(S.fieldErrors.too_far_ahead, new RegExp(`\\b${APK_YEARS_AHEAD}\\b`), 'the sentence names the same number of years as the rule');
  });
});

// ------------------------------------------------------------- the damage form

test('damage form: noticed on today in the household day, by me first, then the others and Unknown; place and description empty', async () => {
  const me = makeApp(BEN);
  await withClient({ now: NOW, routes: carRoutes() }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    assert.equal(one(damageForm(page), 'h3').textContent, S.car.addTitle);
    const date = control(noticedOnRow(page));
    assert.equal(date.value, TODAY);
    assert.equal(date.getAttribute('max'), TODAY, 'a day in the future cannot be picked');
    assert.equal(date.getAttribute('min'), '2000-01-01');
    assert.equal(hintOf(noticedOnRow(page)), S.car.noticedOnHint);

    const who = control(noticedByRow(page));
    assert.deepEqual(optionTexts(who), [`Ben (${S.meLabel})`, 'Anna', 'Root', S.car.unknown], 'me first, the others in their order, Unknown last');
    assert.deepEqual(optionValues(who), [String(BEN.id), String(ANNA.id), String(ADMIN.id), 'unknown']);
    assert.equal(who.value, String(BEN.id), 'the reporter is the default noticer');

    const where = control(whereRow(page));
    assert.deepEqual(optionValues(where), ['', ...carView.LOCATIONS]);
    assert.deepEqual(optionTexts(where), [S.car.wherePick, ...carView.LOCATIONS.map((l) => S.car.location[l])]);
    assert.equal(where.value, '');
    assert.equal(where.required, true);

    const text = control(descriptionRow(page));
    assert.equal(text.tagName, 'textarea');
    assert.equal(text.value, '');
    assert.equal(text.getAttribute('maxlength'), String(DESCRIPTION_MAX));
    assert.equal(hintOf(descriptionRow(page)), S.car.descriptionHint);
    assert.equal(one(damageForm(page), 'button[type="submit"]').textContent, S.car.save);
    assert.equal(all(damageForm(page), 'a.btn').length, 0, 'no Cancel link while adding');
    assert.equal(all(damageForm(page), 'form, .repair-form').length, 0);
  });
});

test('damage form: saving sends exactly the four fields, says so, reloads and puts focus on the heading', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    await typeInto(control(noticedOnRow(page)), '2026-06-12');
    control(whereRow(page)).value = 'rear';
    await typeInto(control(descriptionRow(page)), 'Scratch on the rear bumper');
    await submit(damageForm(page));
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/damage');
    assert.deepEqual(sent.body, { noticedOn: '2026-06-12', noticedBy: ANNA.id, location: 'rear', description: 'Scratch on the rear bumper' });
    assert.ok(!('reportedBy' in sent.body), 'the reporter is whoever is signed in: it is never sent');
    assert.deepEqual(me.toasts, [{ message: S.car.saved, isError: false }]);
    assert.equal(me.refreshes(), 1);
    assert.deepEqual(me.navigated, []);
    assert.equal(dom.focused()?.tagName, 'h2');
    assert.equal(dom.focused()?.textContent, S.car.title);
  });
});

test('damage form: somebody else, or nobody, can be the one who noticed it', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    control(whereRow(page)).value = 'front';
    await typeInto(control(descriptionRow(page)), 'Chip in the windscreen');
    const who = control(noticedByRow(page));
    who.value = String(BEN.id);
    await submit(damageForm(page));
    who.value = 'unknown';
    await submit(damageForm(page));
    assert.deepEqual(api.writes().map((c) => c.body['noticedBy']), [BEN.id, null], 'a person by id; Unknown is null, which is not the same as leaving it out');
  });
});

test('damage form: a missing place, an empty or too long description, a day in the future or not a day are refused on their fields and nothing is sent', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    const date = control(noticedOnRow(page));
    const where = control(whereRow(page));
    const text = control(descriptionRow(page));

    await submit(damageForm(page));
    assert.equal(errorOf(whereRow(page)), S.fieldErrors.required);
    assert.equal(errorOf(descriptionRow(page)), S.fieldErrors.required);
    assert.equal(errorOf(noticedOnRow(page)), '', 'today is fine');
    assert.equal(dom.focused(), where, 'focus goes to the first field to fix');

    where.value = 'roof';
    await typeInto(text, '   ');
    await submit(damageForm(page));
    assert.equal(errorOf(whereRow(page)), '');
    assert.equal(errorOf(descriptionRow(page)), S.fieldErrors.required, 'only spaces is empty');
    assert.equal(dom.focused(), text);

    await typeInto(text, 'x'.repeat(DESCRIPTION_MAX + 1));
    await submit(damageForm(page));
    assert.equal(errorOf(descriptionRow(page)), S.fieldErrors.too_long);

    await typeInto(text, 'x'.repeat(DESCRIPTION_MAX));
    for (const [typed, code] of [
      ['2026-06-16', 'in_future'],
      ['2026-02-30', 'invalid_date'],
      ['', 'required'],
      ['1999-12-31', 'invalid_date'],
    ] as const) {
      await typeInto(date, typed);
      await submit(damageForm(page));
      assert.equal(errorOf(noticedOnRow(page)), S.fieldErrors[code], `"${typed}"`);
      assert.equal(dom.focused(), date);
    }
    assert.deepEqual(api.writes(), [], 'no request was made');

    await typeInto(date, '2026-06-01');
    await submit(damageForm(page));
    assert.equal(errorOf(noticedOnRow(page)), '', 'the message goes away once the field is right');
    assert.equal(onlyWrite(api).body['description'], 'x'.repeat(DESCRIPTION_MAX), 'exactly the maximum is accepted');
  });
});

test('damage form: a refusal from the server shows on its fields, says what went wrong and lets the person try again', async () => {
  const me = makeApp(ANNA);
  let answer: Reply = refuse(422, 'validation_failed', { fields: { noticedOn: 'in_future', location: 'invalid_value', description: 'too_long', noticedBy: 'unknown_user' } });
  await withClient({ now: NOW, routes: carRoutes([], apkAnswer(null), { 'POST /api/damage': () => answer }) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    control(whereRow(page)).value = 'rear';
    await typeInto(control(descriptionRow(page)), 'A dent');
    await submit(damageForm(page));
    assert.equal(errorOf(noticedOnRow(page)), S.fieldErrors.in_future);
    assert.equal(errorOf(whereRow(page)), S.fieldErrors.invalid_value);
    assert.equal(errorOf(descriptionRow(page)), S.fieldErrors.too_long);
    assert.equal(errorOf(noticedByRow(page)), S.fieldErrors.unknown_user);
    const message = one(damageForm(page), 'p.form-error');
    assert.equal(message.hidden, false);
    assert.equal(message.textContent, S.errors.validation_failed);
    assert.equal(dom.focused()?.getAttribute('aria-invalid'), 'true');
    assert.equal(one(damageForm(page), 'button[type="submit"]').disabled, false, 'the person can fix it and send again');
    assert.deepEqual(me.toasts, []);
    assert.equal(me.refreshes(), 0);

    answer = refuse(403, 'forbidden');
    await submit(damageForm(page));
    assert.equal(errorOf(noticedOnRow(page)), '', 'earlier messages are cleared on the next try');
    assert.equal(message.textContent, S.errors.forbidden);
  });
});

// ------------------------------------------------------------------ the lists

test('lists: open reports first with a count, then the repaired ones; each card has the place, status, who noticed it, the text, who filed it and the hint', async () => {
  const me = makeApp(ANNA);
  const items = [
    report({ id: 1, location: 'rear', noticedOn: '2026-06-10' }),
    report({ id: 3, location: 'roof', noticedOn: '2026-06-05', noticedBy: null, reportedBy: { id: BEN.id, name: 'Ben' }, hint: { driver: null, basis: 'none' }, can: { edit: false, delete: false, repair: true } }),
    repairedReport({ id: 2, location: 'front', noticedOn: '2026-05-30' }),
  ];
  await withClient({ now: NOW, routes: carRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    assert.deepEqual(
      all(page, 'article.damage').map((a) => a.id),
      ['damage-1', 'damage-3', 'damage-2'],
      'open ones first, then repaired, each in the order the server sent them',
    );
    const headings = all(page, 'h3').map((h) => h.textContent);
    assert.ok(headings.includes(S.car.open(2)));
    assert.ok(headings.includes(S.car.repairedList(1)));

    const open = damageCard(page, 1);
    assert.equal(one(open, 'strong').textContent, S.car.location.rear);
    assert.equal(one(open, '.badge-status').textContent, S.car.status.open);
    assert.ok(open.className.split(/\s+/).includes('open'));
    assert.equal(one(open, '.when').textContent, S.car.noticedLine(formatDateKey('2026-06-10'), S.you), 'the signed-in person is "you"');
    assert.equal(one(open, 'p.damage-text').textContent, 'Dent in the rear left door');
    assert.ok(all(open, '.sub').some((e) => e.textContent === S.car.reportedBy(S.you)));
    assert.equal(one(open, '.damage-hint').textContent, `${S.car.hint.drive('Ben')} ${S.car.hint.note}`, 'the hint with what it rests on, and that it is information only');

    const unknown = damageCard(page, 3);
    assert.equal(one(unknown, '.when').textContent, S.car.noticedUnknown(formatDateKey('2026-06-05')));
    assert.ok(all(unknown, '.sub').some((e) => e.textContent === S.car.reportedBy('Ben')));
    assert.equal(one(unknown, '.damage-hint').textContent, `${S.car.hint.none} ${S.car.hint.note}`, 'with nobody on record it says so and names nobody');

    const done = damageCard(page, 2);
    assert.equal(one(done, '.badge-status').textContent, S.car.status.repaired);
    assert.ok(done.className.split(/\s+/).includes('repaired'));
    assert.ok(all(done, '.sub').some((e) => e.textContent.startsWith(S.car.repairedLine(formatDateKey('2026-06-12')))));
    assert.ok(all(done, 'div.damage-text').some((e) => e.textContent === 'Fixed at the garage'), 'the repair note is shown');
  });
});

test('lists: with no reports it says so, and with only repaired ones it says there are no open ones', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes([]) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    assert.equal(all(page, 'article.damage').length, 0);
    assert.equal(one(page, '.empty p').textContent, S.car.none);
    assert.ok(all(page, 'h3').some((h) => h.textContent === S.car.open(0)));
    assert.ok(!all(page, 'h3').some((h) => h.textContent.startsWith('Repaired')), 'no empty "Repaired" heading');
  });
  await withClient({ now: NOW, routes: carRoutes([repairedReport()]) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    assert.equal(one(page, '.empty p').textContent, S.car.noneOpen);
    assert.equal(all(page, 'article.damage').length, 1);
  });
});

test('lists: text that looks like markup is shown as text, never as markup', async () => {
  const me = makeApp(ANNA);
  const sneaky = '<img src=x onerror=alert(1)><b>bold</b>';
  const items = [report({ description: sneaky, noticedBy: { id: BEN.id, name: '<i>Ben</i>' }, hint: { driver: { id: BEN.id, name: '<u>Ben</u>' }, basis: 'drive' } }), repairedReport({ repairNote: sneaky })];
  await withClient({ now: NOW, routes: carRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    assert.equal(one(damageCard(page, 1), 'p.damage-text').textContent, sneaky);
    assert.equal(one(damageCard(page, 1), '.when').textContent, S.car.noticedLine(formatDateKey('2026-06-10'), '<i>Ben</i>'));
    assert.match(one(damageCard(page, 1), '.damage-hint').textContent, /<u>Ben<\/u>/);
    for (const tag of ['img', 'b', 'i', 'u']) assert.equal(all(page, `article ${tag}`).length, 0, `no <${tag}> element was created`);
  });
});

test('lists: Mark repaired is for everybody on an open report, Edit and Delete only where the server says, Reopen only for those who can edit a repaired one', async () => {
  const me = makeApp(BEN);
  const items = [
    report({ id: 1, can: { edit: true, delete: true, repair: true } }),
    report({ id: 2, can: { edit: false, delete: false, repair: true } }),
    repairedReport({ id: 3, can: { edit: true, delete: true, repair: false } }),
    repairedReport({ id: 4, can: { edit: false, delete: false, repair: false } }),
    report({ id: 5, can: { edit: true, delete: false, repair: true } }),
  ];
  await withClient({ now: NOW, routes: carRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    const actions = (id: number) => {
      const card = damageCard(page, id);
      return {
        repair: all(card, 'button').filter((b) => b.textContent === S.car.markRepaired).length,
        reopen: all(card, 'button').filter((b) => b.textContent === S.car.reopen).length,
        edit: all(card, 'a').filter((a) => a.textContent === S.edit).map((a) => a.getAttribute('href')),
        remove: all(card, 'button').filter((b) => b.textContent === S.delete).length,
        bar: all(card, '.actions').filter((a) => a.parent === card).length,
      };
    };
    assert.deepEqual(actions(1), { repair: 1, reopen: 0, edit: ['#/car?edit=1'], remove: 1, bar: 1 });
    assert.deepEqual(actions(2), { repair: 1, reopen: 0, edit: [], remove: 0, bar: 1 }, 'somebody else\'s open report: anybody can still mark it repaired');
    assert.deepEqual(actions(3), { repair: 0, reopen: 1, edit: ['#/car?edit=3'], remove: 1, bar: 1 });
    assert.deepEqual(actions(4), { repair: 0, reopen: 0, edit: [], remove: 0, bar: 0 }, 'somebody else\'s repaired report has no buttons at all');
    assert.deepEqual(actions(5), { repair: 1, reopen: 0, edit: ['#/car?edit=5'], remove: 0, bar: 1 });
  });
});

test('lists: the buttons keep their visible words but each has a name that says which report it is, and no two reports share one', async () => {
  const me = makeApp(ANNA);
  const items = [report({ id: 1, location: 'rear', noticedOn: '2026-06-10' }), report({ id: 2, location: 'roof', noticedOn: '2026-06-11' }), repairedReport({ id: 3, location: 'front', noticedOn: '2026-05-01' })];
  await withClient({ now: NOW, routes: carRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    const names = (id: number) => {
      const card = damageCard(page, id);
      return all(card, 'button, a.btn')
        .filter((e) => e.getAttribute('aria-label') !== null)
        .map((e) => [e.textContent, e.getAttribute('aria-label')]);
    };
    const day = formatDateKey('2026-06-10');
    assert.deepEqual(names(1), [
      [S.car.markRepaired, S.car.repairLabel(S.car.location.rear, day)],
      [S.edit, S.car.editLabel(S.car.location.rear, day)],
      [S.delete, S.car.deleteLabel(S.car.location.rear, day)],
    ]);
    const labels = [1, 2, 3].flatMap((id) => names(id).map((n) => n[1]));
    assert.equal(new Set(labels).size, labels.length, 'every button name is different');
    assert.deepEqual(names(3).map((n) => n[0]), [S.car.reopen, S.edit, S.delete]);
    // A name that does not start with the visible word breaks voice control ("click Edit").
    assert.ok(S.car.editLabel('x', 'y').startsWith(S.edit) && S.car.deleteLabel('x', 'y').startsWith(S.delete) && S.car.reopenLabel('x', 'y').startsWith(S.car.reopen));
    assert.ok(S.car.repairLabel('x', 'y').startsWith(S.car.markRepaired), 'the whole visible text opens the name, not only its first word');
  });
});

// -------------------------------------------------------------- mark repaired

test('mark repaired: the form opens in place with today, sends the date and the note, says so, reloads and puts focus on the heading', async () => {
  const me = makeApp(BEN);
  const routes = carRoutes([report({ id: 1, noticedOn: '2026-06-10', can: { edit: false, delete: false, repair: true } })], apkAnswer(null), { 'POST /api/damage/1/repair': () => ({ report: {} }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    const card = damageCard(page, 1);
    const form = one(card, 'form.repair-form');
    const opener = byText(card, 'button', S.car.markRepaired);
    assert.equal(form.hidden, true, 'closed until asked for');
    assert.equal(opener.getAttribute('aria-expanded'), 'false');
    await opener.fire('click');
    assert.equal(form.hidden, false);
    assert.equal(opener.getAttribute('aria-expanded'), 'true');
    const date = control(fieldRow(form, S.car.repairedOn));
    assert.equal(date.value, TODAY, 'today by default');
    assert.equal(date.getAttribute('min'), '2026-06-10', 'not before it was noticed');
    assert.equal(date.getAttribute('max'), TODAY);
    assert.equal(dom.focused(), date, 'focus moves into the form that opened');
    const note = control(fieldRow(form, S.car.repairNote));
    assert.equal(note.getAttribute('maxlength'), String(REPAIR_NOTE_MAX));
    assert.equal(hintOf(fieldRow(form, S.car.repairNote)), S.car.repairNoteHint);

    await typeInto(date, '2026-06-14');
    await typeInto(note, 'New door fitted');
    await submit(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/damage/1/repair');
    assert.deepEqual(sent.body, { repairedOn: '2026-06-14', repairNote: 'New door fitted' });
    assert.deepEqual(me.toasts, [{ message: S.car.repaired, isError: false }]);
    assert.equal(me.refreshes(), 1);
    assert.equal(dom.focused()?.textContent, S.car.title);
  });
});

test('mark repaired: the note is optional, Cancel closes the form and gives focus back to the button, and nothing is sent', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1 })], apkAnswer(null), { 'POST /api/damage/1/repair': () => ({ report: {} }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    const card = damageCard(page, 1);
    const form = one(card, 'form.repair-form');
    const opener = byText(card, 'button', S.car.markRepaired);
    await opener.fire('click');
    assert.equal(opener.getAttribute('aria-expanded'), 'true', 'open while the form is');
    await byText(form, 'button', S.cancel).fire('click');
    assert.equal(form.hidden, true);
    assert.equal(opener.getAttribute('aria-expanded'), 'false', 'the button that opened it says it is closed again');
    assert.equal(dom.focused(), opener);
    assert.deepEqual(api.writes(), []);
    await opener.fire('click');
    await submit(form);
    assert.deepEqual(onlyWrite(api).body, { repairedOn: TODAY, repairNote: '' });
  });
});

test('mark repaired: a day before it was noticed, in the future or not a day is refused on the field and nothing is sent', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1, noticedOn: '2026-06-10' })], apkAnswer(null), { 'POST /api/damage/1/repair': () => ({ report: {} }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    const card = damageCard(page, 1);
    const form = one(card, 'form.repair-form');
    await byText(card, 'button', S.car.markRepaired).fire('click');
    const row = fieldRow(form, S.car.repairedOn);
    for (const [typed, code] of [
      ['2026-06-09', 'before_noticed'],
      ['2026-06-16', 'in_future'],
      ['2026-02-30', 'invalid_date'],
      ['', 'required'],
    ] as const) {
      await typeInto(control(row), typed);
      await submit(form);
      assert.equal(errorOf(row), S.fieldErrors[code], `"${typed}"`);
      assert.equal(dom.focused(), control(row));
    }
    assert.deepEqual(api.writes(), []);
    await typeInto(control(row), '2026-06-10');
    await submit(form);
    assert.equal(onlyWrite(api).body['repairedOn'], '2026-06-10', 'the day it was noticed is fine');
  });
});

test('mark repaired: when somebody was quicker (409) it says so, reloads the list and does not leave the form half done', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1 })], apkAnswer(null), { 'POST /api/damage/1/repair': () => refuse(409, 'already_repaired') });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    const card = damageCard(page, 1);
    await byText(card, 'button', S.car.markRepaired).fire('click');
    await submit(one(card, 'form.repair-form'));
    assert.deepEqual(me.toasts, [{ message: S.errors.already_repaired, isError: true }]);
    assert.equal(me.refreshes(), 1, 'the list is reloaded so it shows how it is now');
    assert.equal(one(card, 'p.form-error').hidden, true, 'no inline error on top of the toast');
    assert.match(S.errors.already_repaired, /al als gerepareerd/);
  });
});

test('mark repaired: a server refusal on a field shows there and the button works again', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1 })], apkAnswer(null), {
    'POST /api/damage/1/repair': () => refuse(422, 'outside_window', { fields: { repairedOn: 'outside_window' } }),
  });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    const card = damageCard(page, 1);
    const form = one(card, 'form.repair-form');
    await byText(card, 'button', S.car.markRepaired).fire('click');
    await submit(form);
    assert.equal(errorOf(fieldRow(form, S.car.repairedOn)), S.fieldErrors.outside_window);
    assert.equal(one(form, 'p.form-error').textContent, S.errors.outside_window);
    assert.equal(byText(form, 'button', S.car.confirmRepaired).disabled, false);
    assert.equal(me.refreshes(), 0);
  });
});

test('reopen: asks the server to set the report back to open and nothing else, says so and reloads', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([repairedReport({ id: 2 })], apkAnswer(null), { 'PATCH /api/damage/2': () => ({ report: {} }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    const button = byText(damageCard(page, 2), 'button', S.car.reopen);
    await button.fire('click');
    await until(() => me.toasts.length === 1, 'the reopen to finish');
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'PATCH /api/damage/2');
    assert.deepEqual(sent.body, { status: 'open' }, 'the server clears the date and the note itself');
    assert.deepEqual(me.toasts, [{ message: S.car.reopened, isError: false }]);
    assert.equal(me.refreshes(), 1);
    assert.equal(button.disabled, false, 'the buttons are usable again');
  });
});

// ----------------------------------------------------------- edit and delete

test('editing an open report: the form opens with it, sends the whole picture without any repair fields, and goes back to the list', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1, location: 'roof', description: 'Old dent', noticedOn: '2026-06-03', noticedBy: { id: BEN.id, name: 'Ben' } })], apkAnswer(null), { 'PATCH /api/damage/1': () => ({ report: {} }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me, 'edit=1'));
    assert.equal(one(damageForm(page), 'h3').textContent, S.car.editTitle);
    assert.equal(control(noticedOnRow(page)).value, '2026-06-03');
    assert.equal(control(noticedByRow(page)).value, String(BEN.id));
    assert.equal(control(whereRow(page)).value, 'roof');
    assert.equal(control(descriptionRow(page)).value, 'Old dent');
    assert.equal(all(damageForm(page), '.field').length, 4, 'an open report has no repair fields to edit');
    assert.equal(one(damageForm(page), 'a.btn[href="#/car"]').textContent, S.cancel, 'there is a way out of editing');

    await typeInto(control(descriptionRow(page)), 'Bigger dent');
    await submit(damageForm(page));
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'PATCH /api/damage/1');
    assert.deepEqual(sent.body, { noticedOn: '2026-06-03', noticedBy: BEN.id, location: 'roof', description: 'Bigger dent' });
    assert.deepEqual(me.toasts, [{ message: S.car.saved, isError: false }]);
    assert.deepEqual(me.navigated, ['#/car']);
  });
});

test('editing: the form comes right under the page heading, above the APK card; a blank form stays under the damage heading', async () => {
  // Pressing Edit lands on the top of the page. In its usual place the form is under the APK card, below the fold on a
  // 320 px phone, so it would look as if Edit did nothing (measured in Chromium at 320x568: the heading sat at y=612).
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes([report({ id: 1 })]) }, async ({ dom }) => {
    // The page is the heading and two columns (side by side on a wide screen, one after the other on a phone): the
    // order of the elements in the page is what a person and a screen reader meet, so that order is what is compared.
    const order = (page: FakeElement) => {
      assert.ok(page.className.split(/\s+/).includes('car-view'), 'the mounted element is the view itself');
      const all = page.descendants();
      return { form: all.indexOf(damageForm(page)), apk: all.indexOf(apkCard(page)), heading: all.indexOf(one(page, 'h2')), first: (page.children[0] as FakeElement).tagName };
    };
    const editing = order(view(dom, await carPage(me, 'edit=1')));
    assert.equal(editing.first, 'h2', 'the heading comes first');
    assert.ok(editing.form > editing.heading && editing.form < editing.apk, 'then the form, and the APK card follows');
    const blank = order(view(dom, await carPage(me)));
    assert.ok(blank.apk >= 0 && blank.form > blank.apk, 'a blank form stays in its place under the APK card');
    assert.equal(one(damageForm(view(dom, await carPage(me, 'edit=1'))), 'h3').textContent, S.car.editTitle);
  });
});

test('editing a repaired report also edits its repair, and a noticed date of "unknown" is sent as null', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([repairedReport({ id: 2, noticedBy: null, noticedOn: '2026-06-01', repairedOn: '2026-06-12', repairNote: 'Fixed' })], apkAnswer(null), { 'PATCH /api/damage/2': () => ({ report: {} }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me, 'edit=2'));
    assert.equal(control(noticedByRow(page)).value, 'unknown');
    const repairedOn = control(fieldRow(damageForm(page), S.car.repairedOn));
    assert.equal(repairedOn.value, '2026-06-12');
    assert.equal(repairedOn.getAttribute('min'), '2026-06-01');
    assert.equal(control(fieldRow(damageForm(page), S.car.repairNote)).value, 'Fixed');
    await typeInto(control(fieldRow(damageForm(page), S.car.repairNote)), 'Fixed properly');
    await submit(damageForm(page));
    assert.deepEqual(onlyWrite(api).body, {
      noticedOn: '2026-06-01',
      noticedBy: null,
      location: 'rear',
      description: 'Dent in the rear left door',
      repairedOn: '2026-06-12',
      repairNote: 'Fixed properly',
    });
    // A repaired date before the noticed day is refused here, before anything is sent.
    await typeInto(repairedOn, '2026-05-31');
    await submit(damageForm(page));
    assert.equal(errorOf(fieldRow(damageForm(page), S.car.repairedOn)), S.fieldErrors.before_noticed);
    assert.equal(api.writes().length, 1);
  });
});

test('editing: somebody who has been deactivated since stays selectable as the noticer, so saving does not drop them', async () => {
  const me = makeApp(ANNA, [ANNA, ADMIN]);
  const routes = carRoutes([report({ id: 1, noticedBy: { id: BEN.id, name: 'Ben' } })], apkAnswer(null), { 'PATCH /api/damage/1': () => ({ report: {} }) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me, 'edit=1'));
    const who = control(noticedByRow(page));
    assert.deepEqual(optionTexts(who), [`Anna (${S.meLabel})`, 'Root', 'Ben', S.car.unknown]);
    assert.equal(who.value, String(BEN.id));
    await submit(damageForm(page));
    assert.equal(onlyWrite(api).body['noticedBy'], BEN.id);
  });
});

test('editing: a report that cannot be edited, or does not exist, gives the blank form instead', async () => {
  const me = makeApp(ANNA);
  const items = [report({ id: 1 }), report({ id: 2, description: 'Not mine', can: { edit: false, delete: false, repair: true } })];
  await withClient({ now: NOW, routes: carRoutes(items) }, async ({ dom }) => {
    for (const edit of ['2', '99', 'abc', '0']) {
      const page = view(dom, await carPage(me, `edit=${edit}`));
      assert.equal(one(damageForm(page), 'h3').textContent, S.car.addTitle, `edit=${edit}`);
      assert.equal(control(descriptionRow(page)).value, '');
      assert.equal(all(damageForm(page), 'a.btn').length, 0);
    }
  });
});

test('deleting my own report asks nothing: it goes at once, "Ongedaan maken" brings it back, and the DELETE goes out after six seconds', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1 })], apkAnswer(null), { 'DELETE /api/damage/1': () => new Reply(null, 204) });
  await withClient({ now: NOW, routes }, async ({ dom, api, tick }) => {
    const page = view(dom, await carPage(me));
    await byText(damageCard(page, 1), 'button', S.delete).fire('click');
    assert.deepEqual(dom.confirms, [], 'nothing is asked: it can be taken back');
    assert.deepEqual(api.writes(), [], 'nothing is sent yet');
    assert.equal(me.refreshes(), 1, 'the list is rebuilt at once without it');
    assert.equal(me.toasts[0]?.message, S.undo.damage);
    assert.equal(me.toasts[0]?.action?.label, S.undo.action);
    tick(6000);
    await until(() => api.writes().length === 1, 'the delete after the window');
    assert.equal(`${onlyWrite(api).method} ${onlyWrite(api).path}`, 'DELETE /api/damage/1');
  });
  const again = makeApp(ANNA);
  await withClient({ now: NOW, routes }, async ({ dom, api, tick }) => {
    const page = view(dom, await carPage(again));
    await byText(damageCard(page, 1), 'button', S.delete).fire('click');
    again.toasts[0]?.action?.run();
    tick(20_000);
    assert.deepEqual(api.writes(), [], 'taken back: never sent');
    assert.equal(again.refreshes(), 2, 'and the list is rebuilt with the report in it again');
  });
  // The server says no when the delete finally goes out: the report comes back and the person is told.
  const refused = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes([report({ id: 1 })], apkAnswer(null), { 'DELETE /api/damage/1': () => refuse(403, 'forbidden') }) }, async ({ dom, tick }) => {
    const page = view(dom, await carPage(refused));
    await byText(damageCard(page, 1), 'button', S.delete).fire('click');
    tick(6000);
    await until(() => refused.toasts.some((t) => t.isError), 'the refusal');
    assert.equal(refused.toasts.at(-1)?.message, S.errors.forbidden);
    assert.equal(refused.refreshes(), 2, 'the list is reloaded and shows how things are now');
  });
});

test('deleting somebody else\'s report (an admin cleaning up) asks first, does nothing on "no", and on "yes" deletes, says so, reloads and keeps focus on the page', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1, reportedBy: { id: BEN.id, name: 'Ben' } })], apkAnswer(null), { 'DELETE /api/damage/1': () => new Reply(null, 204) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await carPage(me));
    const remove = byText(damageCard(page, 1), 'button', S.delete);
    dom.answer = false;
    await remove.fire('click');
    assert.deepEqual(api.writes(), [], 'declining the question changes nothing');
    assert.deepEqual(me.toasts, []);

    dom.answer = true;
    await remove.fire('click');
    await until(() => me.toasts.length === 1, 'the delete to finish');
    assert.deepEqual(dom.confirms, [S.car.confirmDelete, S.car.confirmDelete]);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'DELETE /api/damage/1');
    assert.deepEqual(me.toasts, [{ message: S.car.deleted, isError: false }]);
    assert.equal(me.refreshes(), 1);
    await until(() => dom.focused()?.textContent === S.car.title, 'focus to return to the heading');
    assert.equal(remove.disabled, false, 'the buttons are usable again');
  });
});

test('a change that the server refuses is shown as an error toast and the list is reloaded, so it shows how things are now', async () => {
  const me = makeApp(ANNA);
  const routes = carRoutes([report({ id: 1, reportedBy: { id: BEN.id, name: 'Ben' } })], apkAnswer(null), { 'DELETE /api/damage/1': () => refuse(403, 'forbidden') });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = view(dom, await carPage(me));
    await byText(damageCard(page, 1), 'button', S.delete).fire('click');
    await until(() => me.toasts.length === 1, 'the refusal');
    assert.deepEqual(me.toasts, [{ message: S.errors.forbidden, isError: true }]);
    assert.equal(me.refreshes(), 1);
  });
});

// ------------------------------------------------------------ busy states

test('while a request is on its way the buttons that sent it are disabled, so a second tap cannot send it twice, and they work again afterwards', async () => {
  const me = makeApp(ANNA);
  // Report 3 is Ben's, so deleting it asks first (a sheet): the buttons of the report must still be disabled after the question.
  const reports = [report({ id: 1 }), report({ id: 3, description: 'Chip in the windscreen', location: 'windows', reportedBy: { id: BEN.id, name: 'Ben' } })];
  // The stub answers while the view is waiting for it, so what the buttons look like in that moment can be read here.
  let page: FakeElement | undefined;
  let removeButton: FakeElement | undefined;
  const during: Record<string, boolean> = {};
  const routes = carRoutes(reports, apkAnswer(null), {
    'PATCH /api/car/apk': () => {
      during['apk'] = one(apkForm(page), 'button[type="submit"]').disabled;
      return apkAnswer('2027-03-01');
    },
    'POST /api/damage': () => {
      during['report'] = one(damageForm(page), 'button[type="submit"]').disabled;
      return new Reply({ report: {} }, 201);
    },
    'POST /api/damage/1/repair': () => {
      during['repair'] = byText(damageCard(page, 1), 'button', S.car.confirmRepaired).disabled;
      return { report: {} };
    },
    'DELETE /api/damage/3': () => {
      // The row of buttons of the report (Mark repaired and Delete; Edit is a link), not the buttons of its repair form.
      const bar = all(removeButton?.closest('.actions') ?? damageCard(page, 3), 'button');
      during['delete'] = bar.length === 2 && bar.every((b) => b.disabled);
      return new Reply(null, 204);
    },
  });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    page = view(dom, await carPage(me));

    await typeInto(control(apkRow(page)), '2027-03-01');
    await submit(apkForm(page));

    await typeInto(control(noticedOnRow(page)), '2026-06-12');
    control(whereRow(page)).value = 'rear';
    await typeInto(control(descriptionRow(page)), 'Scratch on the rear bumper');
    await submit(damageForm(page));

    const card = damageCard(page, 1);
    await byText(card, 'button', S.car.markRepaired).fire('click');
    await submit(one(card, 'form.repair-form'));

    dom.answer = true;
    const remove = byText(damageCard(page, 3), 'button', S.delete);
    removeButton = remove;
    await remove.fire('click');
    await until(() => me.toasts.some((t) => t.message === S.car.deleted), 'the delete to finish');

    assert.deepEqual(during, { apk: true, report: true, repair: true, delete: true }, 'each send had its button (the whole row of buttons for a change to one report) switched off');
    assert.equal(remove.disabled, false, 'and the row of buttons of a report is usable again once the list is reloaded');
  });
});

// ------------------------------------------------------------ what it asks for

test('opening the Car tab asks for the APK and the damage list and changes nothing', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: carRoutes([report()], apkAnswer('2026-09-30')) }, async ({ dom, api }) => {
    view(dom, await carPage(me));
    assert.deepEqual(api.calls.filter((c) => c.path !== '/api/odometer').map((c) => `${c.method} ${c.path}`).sort(), ['GET /api/car/apk', 'GET /api/damage']);
    assert.deepEqual(api.writes(), []);
  });
});

// --------------------------------------------------------------- the shell

test('the limits in the browser are the limits on the server', () => {
  assert.equal(DESCRIPTION_MAX, SERVER_DESCRIPTION_MAX);
  assert.equal(REPAIR_NOTE_MAX, SERVER_REPAIR_NOTE_MAX);
  assert.equal(APK_YEARS_AHEAD, SERVER_APK_YEARS_AHEAD);
  assert.equal(carView.MIN_YEAR, 2000);
  assert.equal(carView.MAX_YEAR, 2100);
});

test('the view is not re-rendered in the background while a form may be open', () => {
  assert.equal(carView.live, false);
});

test('the app shell: Car is a view under Meer (a row of that page, a link of the rail), with its own page title', () => {
  const app = readSource('public/app.js');
  assert.match(app, /import \* as car from '\.\/views\/car\.js';/);
  assert.match(app, /const VIEWS = \{[^}]*\bcar\b[^}]*\};/);
  assert.ok(SECONDARY.some((item) => item.name === 'car' && item.label === S.nav.car && item.href === '#/car'));
  assert.equal(placeOf('car'), 'more', 'the Meer tab is the one that is lit on the Car page');
  assert.equal(titleOf('car'), 'Auto', 'the page title comes from the label of the place');
  assert.equal(S.nav.car, 'Auto');
  // The names the end-to-end suite looks for are unchanged.
  assert.deepEqual([S.nav.agenda, S.nav.reserve, S.nav.usage, S.nav.history], ['Agenda', 'Boeken', 'Ritten', 'Historie']);
});

test('the stylesheet styles the damage reports: open and repaired cards, and a long word in a description cannot widen the page', () => {
  const css = readSource('public/style.css');
  assert.match(css, /\.card\.damage\.open \{/);
  assert.match(css, /\.card\.damage\.repaired \{/);
  assert.match(css, /\.damage-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/, 'a long word in a description cannot widen the page');
});

test('the deployment guide and the README describe the v6 upgrade, going back, how it works and what is kept', () => {
  const guide = readSource('docs/DEPLOYMENT.md').replace(/\s+/g, ' ');
  const readme = readSource('README.md');
  for (const needle of [
    'pre-migrate-v5.db',
    'car-static-v6',
    '**Going back:**',
    'refuses to open a v6 database',
    'An **open damage report is never deleted**',
    'No photos of the damage',
    'apk.updated',
    'damage-4',
  ]) {
    assert.ok(guide.includes(needle), `the guide mentions "${needle}"`);
  }
  assert.match(guide, /pre-migrate-v5\.db[\s\S]*Car tab: damage reports and the APK date|Car tab: damage reports and the APK date[\s\S]*pre-migrate-v5\.db/);
  assert.match(guide, /\[ \] After an update from the version with the kilometre check:[^\n]*pre-migrate-v5\.db/, 'a line in the smoke checklist');
  for (const needle of ['schema v8', '**Car tab.**', 'damage.created', 'Calendar dates are not instants', 'photo of the damage']) {
    assert.ok(readme.includes(needle), `the README mentions "${needle}"`);
  }
  assert.doesNotMatch(readme, /damage report for everybody is next/, 'the design note no longer calls the damage report a future event');
});

test('the view never writes markup, never uses inline styles and never touches storage', () => {
  const source = readSource('public/views/car.js');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(source, /\.style\b|setAttribute\('style'|style:/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
});
