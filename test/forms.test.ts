// What the person sees and what the app sends, for the views this run added or
// changed: the reservation form, the drive form (drafts, finishing, the link to a
// reservation, the km obligation), the pending banner, the reservation card, the
// history list, the fuel form and payment requests, and the Reminders card.
//
// The real view code runs against a fake DOM, a stubbed fetch and a clock that
// stands still (test/fake-dom.ts). The server rules are tested elsewhere; here the
// point is that the forms send what the server expects and say what is going on.
// What this cannot show (layout at 390 and 320 px, focus rings, real push) stays
// with the headless browser pass and the notes on what was not verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRange, fmtWhen } from '../public/dom.js';
import { S } from '../public/strings.js';
import { render as renderAccount } from '../public/views/account.js';
import { reservationCard } from '../public/views/agenda.js';
import { fmtCents, fmtLitres, fmtPrice, render as renderFuel, shareLinks } from '../public/views/fuel.js';
import { render as renderHistory } from '../public/views/history.js';
import { render as renderReserve } from '../public/views/reserve.js';
import { pendingBanner, render as renderUsage } from '../public/views/usage.js';
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
  hintOf,
  installFakeBrowser,
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

function onlyWrite(api: ApiStub): Call {
  const writes = api.writes();
  assert.equal(writes.length, 1, `expected exactly one write, got ${JSON.stringify(writes.map((c) => `${c.method} ${c.path}`))}`);
  return writes[0] as Call;
}

const submitButton = (view: unknown): FakeElement => one(view, 'button[type="submit"]');
const view = (dom: FakeDom, rendered: unknown): FakeElement => dom.mount(rendered);

// ------------------------------------------------------- the reservation form

const reserveRoutes = (extra: Routes = {}): Routes => ({ 'POST /api/reservations': () => new Reply({ reservation: {} }, 201), ...extra });
const newReservation = (app: ReturnType<typeof makeApp>) => renderReserve(app.app, { arg: undefined });

test('reservation form: the note is recommended, never required, and an empty one only earns a tip after the save', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: reserveRoutes() }, async ({ dom, api }) => {
    const form = view(dom, await newReservation(me));
    const row = fieldRow(form, S.reserve.note);
    assert.match(S.reserve.note, /recommended/i);
    assert.equal(hintOf(row), S.noteHint);
    assert.equal(control(row).required, false);
    assert.equal(control(row).hasAttribute('required'), false);

    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/reservations');
    assert.deepEqual(sent.body, { start: at(60), end: at(180), note: '' }, 'an empty note is sent as an empty note, not held back');
    assert.deepEqual(me.toasts, [{ message: `${S.reserve.created} ${S.noteTip}`, isError: false }]);
    assert.deepEqual(me.navigated, ['#/']);
  });
});

test('reservation form: a filled-in note is sent as typed and earns no tip', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: reserveRoutes() }, async ({ dom, api }) => {
    const form = view(dom, await newReservation(me));
    await typeInto(control(fieldRow(form, S.reserve.note)), 'Market trip');
    await submitForm(form);
    assert.equal(onlyWrite(api).body['note'], 'Market trip');
    assert.deepEqual(me.toasts, [{ message: S.reserve.created, isError: false }]);
  });
});

test('reservation form: choosing someone else makes it a suggestion for them', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: reserveRoutes() }, async ({ dom, api }) => {
    const form = view(dom, await newReservation(me));
    const hint = all(form, 'p.hint').find((p) => p.textContent === S.reserve.suggestionHint);
    assert.ok(hint?.hidden, 'the suggestion hint is hidden while it is for me');
    assert.equal(submitButton(form).textContent, S.reserve.submit);

    const who = control(fieldRow(form, S.reserve.driver));
    who.value = String(BEN.id);
    await who.fire('change');
    assert.equal(submitButton(form).textContent, S.reserve.submitSuggestion);
    assert.equal(hint?.hidden, false);

    await submitForm(form);
    assert.equal(onlyWrite(api).body['userId'], BEN.id);
    assert.equal(me.toasts[0]?.message, `${S.reserve.suggested} ${S.noteTip}`);
  });
});

test('reservation form: a refusal names the booking in the way, marks the field and lets the person try again', async () => {
  const me = makeApp(ANNA);
  const conflict = { userName: 'Ben', start: at(60), end: at(120) };
  let answer: Reply = refuse(409, 'overlap', { conflict });
  await withClient({ now: NOW, routes: reserveRoutes({ 'POST /api/reservations': () => answer }) }, async ({ dom }) => {
    const form = view(dom, await newReservation(me));
    await submitForm(form);
    const message = one(form, 'p.form-error');
    assert.equal(message.hidden, false);
    assert.equal(message.textContent, S.reserve.overlap('Ben', fmtRange(conflict.start, conflict.end, TZ)));
    assert.equal(submitButton(form).disabled, false, 'the person can fix it and send again');
    assert.deepEqual(me.toasts, []);
    assert.deepEqual(me.navigated, []);

    answer = refuse(422, 'validation_failed', { fields: { note: 'too_long' } });
    await submitForm(form);
    assert.equal(errorOf(fieldRow(form, S.reserve.note)), S.fieldErrors.too_long);
    assert.equal(message.textContent, S.errors.validation_failed);
  });
});

test('reservation form: editing keeps the note, can clear it, and a reservation that cannot be edited shows no form', async () => {
  const me = makeApp(ANNA);
  let current = reservation({ note: 'Old note' });
  const routes = reserveRoutes({
    'GET /api/reservations/7': () => ({ reservation: current }),
    'PATCH /api/reservations/7': () => ({ reservation: current }),
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = view(dom, await renderReserve(me.app, { arg: '7' }));
    const note = control(fieldRow(form, S.reserve.note));
    assert.equal(note.value, 'Old note');
    assert.equal(control(fieldRow(form, S.reserve.driver)).disabled, true, 'who it is for cannot change');
    note.value = '';
    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'PATCH /api/reservations/7');
    assert.deepEqual(sent.body, { start: at(20), end: at(180), note: '' }, 'clearing the note is a deliberate empty note');
    assert.equal(me.toasts[0]?.message, `${S.reserve.updated} ${S.noteTip}`);

    current = reservation({ can: { edit: false, cancel: false, approve: false, decline: false } });
    const locked = view(dom, await renderReserve(me.app, { arg: '7' }));
    assert.equal(all(locked, 'form').length, 0);
    assert.ok(all(locked, 'p').some((p) => p.textContent === S.errors.not_editable));
  });
});

// ------------------------------------------------------------- the drive form

function driveRoutes(over: { usage?: Json[]; reservations?: Json[]; pending?: Json; extra?: Routes } = {}): Routes {
  return {
    'GET /api/usage': () => ({ items: over.usage ?? [] }),
    'GET /api/usage/summary': () => ({ items: [], totalKm: 0 }),
    'GET /api/reservations': () => ({ items: over.reservations ?? [] }),
    'GET /api/usage/pending': () => over.pending ?? { items: [], count: 0 },
    'POST /api/usage': () => new Reply({ usage: {} }, 201),
    'PATCH /api/usage/9': () => ({ usage: {} }),
    ...over.extra,
  };
}
const driveForm = (app: ReturnType<typeof makeApp>, query = '') => renderUsage(app.app, { query: new URLSearchParams(query) });
/** The chain a household with Ben's finished drive 3 (41000 to 41120) has. */
const benChain = (): Json => odometerChain([reading({ source: 'drive-start', km: 41000, at: at(-600) }), reading()]);
const startOf = (form: unknown) => dateTime(fieldRow(form, S.usage.start));
const endOf = (form: unknown) => dateTime(fieldRow(form, S.usage.end));
const readingStart = (form: unknown) => control(fieldRow(form, S.usage.odometerStart));
const readingEnd = (form: unknown) => control(fieldRow(form, S.usage.odometerEnd));

test('a drive started from a reservation that has not begun is saved as a draft, linked to it, with only the start reading', async () => {
  const me = makeApp(ANNA);
  const routes = driveRoutes({ usage: [usage()], reservations: [reservation()], extra: odometerRoutes(benChain()) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me, 'res=7'));
    assert.equal(one(form, 'h2').textContent, S.usage.logTitle);
    assert.equal(control(fieldRow(form, S.usage.reservation)).value, '7', 'the reservation from the card is preselected');
    assert.deepEqual([startOf(form).date.value, startOf(form).time.value], ['2026-06-15', '12:00'], 'the drive starts now');
    assert.deepEqual([endOf(form).date.value, endOf(form).time.value], ['', ''], 'the end is left for later');
    assert.equal(readingStart(form).value, '41120', 'the latest known reading is the starting point');
    assert.equal(one(form, '.km-last').textContent, S.kmcheck.lastKnown(41120, 'Ben', fmtWhen(at(-480), TZ)), 'and it says where that reading comes from');
    assert.equal(submitButton(form).textContent, S.usage.submitDraft);
    assert.equal(hintOf(fieldRow(form, S.usage.note)), S.noteHint);

    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/usage');
    assert.deepEqual(sent.body, { status: 'draft', start: NOW, end: null, odometerStart: 41120, odometerEnd: null, note: '', reservationId: 7 });
    assert.deepEqual(me.toasts, [{ message: `${S.usage.savedDraft} ${S.noteTip}`, isError: false }]);
    assert.deepEqual(me.navigated, ['#/usage']);
  });
});

test('a reservation that has ended fills in its own times and asks for both readings', async () => {
  const me = makeApp(ANNA);
  const ended = reservation({ start: at(-300), end: at(-240), note: 'Visit to Oma', kmState: 'missing' });
  await withClient({ now: NOW, routes: driveRoutes({ reservations: [ended] }) }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me, 'res=7'));
    assert.deepEqual([startOf(form).date.value, startOf(form).time.value], ['2026-06-15', '07:00']);
    assert.deepEqual([endOf(form).date.value, endOf(form).time.value], ['2026-06-15', '08:00']);
    assert.equal(control(fieldRow(form, S.usage.note)).value, 'Visit to Oma', 'the reservation note is the starting point');
    assert.equal(readingStart(form).value, '');
    assert.equal(readingEnd(form).value, '');

    // Saved as a finished drive only with both readings.
    await submitForm(form);
    assert.deepEqual(api.writes(), [], 'nothing is sent while a reading is missing');
    assert.equal(errorOf(fieldRow(form, S.usage.odometerStart)), S.fieldErrors.required);

    await typeInto(readingStart(form), '50000');
    await submitForm(form);
    assert.equal(errorOf(fieldRow(form, S.usage.odometerEnd)), S.fieldErrors.required, 'an end time without an end reading is half a registration');
    assert.deepEqual(api.writes(), []);

    await typeInto(readingEnd(form), '50042');
    await submitForm(form);
    assert.deepEqual(onlyWrite(api).body, {
      status: 'completed',
      start: at(-300),
      end: at(-240),
      odometerStart: 50000,
      odometerEnd: 50042,
      note: 'Visit to Oma',
      reservationId: 7,
    });
    assert.equal(me.toasts[0]?.message, S.usage.saved, 'a filled-in note earns no tip');
  });
});

test('finishing an open draft: the form opens in finish mode, the end is now, and an untouched link is never sent', async () => {
  const me = makeApp(ANNA);
  const running = reservation({ start: at(-90), end: at(60), kmState: 'draft', drive: { id: 9, userId: 1, userName: 'Anna', status: 'draft', odometerStart: 41120, odometerEnd: null, distanceKm: null, linked: true } });
  const routes = driveRoutes({ usage: [draft(), usage()], reservations: [running] });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me));
    assert.equal(one(form, 'h2').textContent, S.usage.finishTitle);
    assert.ok(all(form, 'p.hint').some((p) => p.textContent === S.usage.openDraft(fmtWhen(at(-60), TZ))), 'it says which drive is being finished');
    assert.equal(control(fieldRow(form, S.usage.reservation)).value, '7');
    assert.equal(readingStart(form).value, '41120');
    assert.deepEqual([endOf(form).date.value, endOf(form).time.value], ['2026-06-15', '12:00'], 'the end is now unless the person changes it');
    assert.equal(submitButton(form).textContent, S.usage.submitFinish);

    await typeInto(readingEnd(form), '41150');
    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'PATCH /api/usage/9');
    assert.deepEqual(sent.body, { status: 'completed', start: at(-60), end: NOW, odometerStart: 41120, odometerEnd: 41150, note: 'Groceries' }, 'no reservationId: the link on the server stays as it is');
    assert.deepEqual(me.toasts, [{ message: S.usage.finished, isError: false }]);
    assert.deepEqual(me.navigated, ['#/usage']);
  });
});

test('the reservation select is only sent when the person changed it (new link or no link)', async () => {
  const other = reservation({ id: 8, start: at(-1440), end: at(-1300), kmState: 'missing' });
  const running = reservation({ start: at(-90), end: at(60), kmState: 'draft' });
  for (const [choice, expected] of [['8', 8], ['', null]] as const) {
    const me = makeApp(ANNA);
    const routes = driveRoutes({ usage: [draft()], reservations: [running, other] });
    await withClient({ now: NOW, routes }, async ({ dom, api }) => {
      const form = view(dom, await driveForm(me));
      const select = control(fieldRow(form, S.usage.reservation));
      assert.deepEqual(
        all(select, 'option').map((o) => o.value),
        ['', '7', '8'],
        'the picker offers the running and the older confirmed reservation, newest first after "no reservation"',
      );
      select.value = choice;
      await typeInto(readingEnd(form), '41150');
      await submitForm(form);
      assert.equal(onlyWrite(api).body['reservationId'], expected, `choice "${choice}"`);
    });
  }
});

test('editing a finished drive linked to an older reservation keeps that link in the picker and does not resend it', async () => {
  const me = makeApp(ANNA);
  const old = reservation({ id: 4, start: at(-60 * 24 * 40), end: at(-60 * 24 * 40 + 120) }); // outside the 30 day range of the picker
  const mine = usage({ id: 5, userId: ANNA.id, userName: 'Anna', reservationId: 4, can: { edit: true, delete: true }, note: 'Older trip' });
  const routes = driveRoutes({
    usage: [mine],
    reservations: [],
    extra: { 'GET /api/reservations/4': () => ({ reservation: old }), 'PATCH /api/usage/5': () => ({ usage: {} }) },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me, 'edit=5'));
    const select = control(fieldRow(form, S.usage.reservation));
    assert.equal(select.value, '4', 'the link shows although the reservation lies outside the range that was fetched');
    assert.equal(one(form, 'h2').textContent, S.usage.editTitle);
    await typeInto(control(fieldRow(form, S.usage.note)), 'Changed note');
    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(sent.path, '/api/usage/5');
    assert.deepEqual(sent.body, { status: 'completed', start: at(-600), end: at(-480), odometerStart: 41000, odometerEnd: 41120, note: 'Changed note' });
  });
});

test('a new drive needs a start reading, and a draft can leave the end open', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: driveRoutes() }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me));
    assert.equal(one(form, 'h2').textContent, S.usage.logTitle);
    assert.equal(hintOf(fieldRow(form, S.usage.end)), S.usage.endHint, 'the form explains what an empty end means');
    await submitForm(form);
    assert.deepEqual(api.writes(), []);
    assert.equal(errorOf(fieldRow(form, S.usage.odometerStart)), S.fieldErrors.required);
    assert.equal(dom.focused(), readingStart(form), 'keyboard focus goes to the first field to fix');

    await typeInto(readingStart(form), '100');
    assert.equal(submitButton(form).textContent, S.usage.submitDraft);
    await typeInto(readingEnd(form), '140');
    assert.equal(submitButton(form).textContent, S.usage.submit, 'an end reading turns it into a finished drive');
    await submitForm(form);
    assert.equal(errorOf(fieldRow(form, S.usage.end)), S.fieldErrors.required, 'an end reading without an end time is refused too');
    assert.deepEqual(api.writes(), []);
  });
});

test('an older drive without readings can only be saved once both readings are filled in', async () => {
  const me = makeApp(ANNA);
  const legacy = usage({ id: 6, userId: ANNA.id, userName: 'Anna', odometerStart: null, odometerEnd: null, distanceKm: null, note: 'old', can: { edit: true, delete: true } });
  const routes = driveRoutes({ usage: [legacy], extra: { 'PATCH /api/usage/6': () => ({ usage: {} }) } });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me, 'edit=6'));
    await submitForm(form);
    assert.deepEqual(api.writes(), []);
    assert.equal(errorOf(fieldRow(form, S.usage.odometerStart)), S.fieldErrors.required);
    assert.equal(errorOf(fieldRow(form, S.usage.odometerEnd)), S.fieldErrors.required);
    await typeInto(readingStart(form), '50');
    await typeInto(readingEnd(form), '80');
    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(sent.path, '/api/usage/6');
    assert.equal(sent.body['odometerStart'], 50);
    assert.equal(sent.body['odometerEnd'], 80);
    assert.equal(sent.body['status'], 'completed');
  });
});

test('a second open drive is refused with a link to the first, and server field codes land on their fields', async () => {
  const me = makeApp(ANNA);
  let answer: Reply = refuse(409, 'draft_exists', { draftId: 9 });
  await withClient({ now: NOW, routes: driveRoutes({ extra: { 'POST /api/usage': () => answer } }) }, async ({ dom }) => {
    const form = view(dom, await driveForm(me));
    await typeInto(readingStart(form), '100');
    await submitForm(form);
    assert.equal(one(form, 'p.form-error').textContent, S.errors.draft_exists);
    const link = one(form, 'a[href="#/usage?edit=9"]');
    assert.equal(link.hidden, false, 'the way to the drive in progress is offered');
    assert.equal(link.textContent, S.usage.pending.finish);
    assert.equal(submitButton(form).disabled, false);
    assert.deepEqual(me.toasts, []);

    answer = refuse(422, 'validation_failed', { fields: { odometerStart: 'must_be_integer' } });
    await submitForm(form);
    assert.equal(errorOf(fieldRow(form, S.usage.odometerStart)), S.fieldErrors.must_be_integer);
    assert.equal(link.hidden, true, 'the link goes away when it no longer applies');
  });
});

test('an open draft can be deleted after a question, and not when the person says no', async () => {
  const me = makeApp(ANNA);
  const running = reservation({ start: at(-90), end: at(60), kmState: 'draft' });
  const routes = driveRoutes({ usage: [draft()], reservations: [running], extra: { 'DELETE /api/usage/9': () => new Reply(null, 204) } });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me));
    const remove = byText(form, 'button', S.usage.deleteDraft);
    dom.answer = false;
    await remove.fire('click');
    assert.deepEqual(api.writes(), []);
    dom.answer = true;
    await remove.fire('click');
    assert.deepEqual(dom.confirms, [S.usage.confirmDeleteDraft, S.usage.confirmDeleteDraft]);
    assert.equal(onlyWrite(api).path, '/api/usage/9');
    assert.deepEqual(me.toasts, [{ message: S.usage.deleted, isError: false }]);
    assert.deepEqual(me.navigated, ['#/usage']);
  });
});

test('a drive that a payment request depends on says why it cannot be changed, and a refusal from the server is explained', async () => {
  const me = makeApp(ANNA);
  const locked = usage({ id: 4, userId: ANNA.id, userName: 'Anna', can: { edit: false, delete: false }, fuelLocked: true });
  const open = usage({ id: 5, userId: ANNA.id, userName: 'Anna', can: { edit: true, delete: true } });
  const routes = driveRoutes({ usage: [locked, open], extra: { 'DELETE /api/usage/5': () => refuse(409, 'fuel_requested') } });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await driveForm(me));
    const [first, second] = all(page, 'article.usage') as [FakeElement, FakeElement];
    assert.equal(one(first, 'p.hint').textContent, S.usage.fuelLocked);
    assert.equal(all(first, 'button').length + all(first, 'a').length, 0, 'no edit or delete is offered for it');
    assert.equal(all(second, 'p.hint').length, 0, 'an ordinary drive carries no such note');

    dom.answer = true;
    await byText(second, 'button', S.delete).fire('click');
    assert.equal(onlyWrite(api).path, '/api/usage/5');
    assert.deepEqual(me.toasts, [{ message: S.errors.fuel_requested, isError: true }]);
  });
});

test('an admin registers a drive for someone else, a member cannot choose the driver', async () => {
  for (const [choice, expected] of [[String(BEN.id), BEN.id], [String(ADMIN.id), undefined]] as const) {
    const admin = makeApp(ADMIN);
    await withClient({ now: NOW, routes: driveRoutes() }, async ({ dom, api }) => {
      const form = view(dom, await driveForm(admin));
      const who = control(fieldRow(form, S.usage.driver));
      assert.equal(who.disabled, false);
      assert.equal(who.value, String(ADMIN.id), 'it starts with the admin themselves');
      who.value = choice;
      await typeInto(readingStart(form), '100');
      await submitForm(form);
      assert.equal(onlyWrite(api).body['userId'], expected, expected === undefined ? 'for themselves nothing extra is sent' : 'for someone else the driver is sent');
    });
  }
  const member = makeApp(BEN);
  await withClient({ now: NOW, routes: driveRoutes() }, async ({ dom }) => {
    const form = view(dom, await driveForm(member));
    assert.equal(all(form, '.field').some((r) => r.children[0]?.textContent === S.usage.driver), false);
  });
});

// ----------------------------------------------------------- the pending banner

test('pending banner: drafts and ended reservations are listed once each, with the way to finish or register them', async () => {
  const me = makeApp(ANNA);
  const missing = reservation({ id: 7, start: at(-300), end: at(-240), note: 'Visit to Oma' });
  const started = reservation({ id: 8, start: at(-200), end: at(-100), kmState: 'draft' });
  const pending = { items: [{ userId: 1, userName: 'Anna', reservations: [missing, started], drafts: [draft()] }], count: 2 };
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const banner = view(dom, pendingBanner(me.app, pending));
    assert.equal(one(banner, 'h3').textContent, S.usage.pending.title(2));
    assert.equal(all(banner, 'li.pending-row').length, 2, 'the reservation that already has a draft is the draft, not a second job');
    assert.equal(one(banner, 'a[href="#/usage?edit=9"]').textContent, S.usage.pending.finish);
    assert.equal(one(banner, 'a[href="#/usage?res=7"]').textContent, S.usage.pending.register);
    assert.equal(all(banner, 'a[href="#/usage?res=8"]').length, 0);
    assert.equal(one(banner, '.note').textContent, 'Visit to Oma', 'the note helps to remember which trip it was');

    assert.equal(pendingBanner(me.app, { items: [], count: 0 }), null);
    assert.equal(pendingBanner(me.app, { items: pending.items, count: 0 }), null);
  });
});

test('pending banner: "car not used" cancels the reservation, but only after a question', async () => {
  const me = makeApp(ANNA);
  const missing = reservation({ id: 7, start: at(-300), end: at(-240) });
  const pending = { items: [{ userId: 1, userName: 'Anna', reservations: [missing], drafts: [] }], count: 1 };
  await withClient({ now: NOW, routes: { 'DELETE /api/reservations/7': () => new Reply(null, 204) } }, async ({ dom, api }) => {
    const banner = view(dom, pendingBanner(me.app, pending));
    const cancel = byText(banner, 'button', S.usage.pending.cancelUnused);
    dom.answer = false;
    await cancel.fire('click');
    assert.deepEqual(api.writes(), []);
    dom.answer = true;
    await cancel.fire('click');
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'DELETE /api/reservations/7');
    assert.deepEqual(dom.confirms, [S.usage.pending.confirmCancelUnused, S.usage.pending.confirmCancelUnused]);
    assert.deepEqual(me.toasts, [{ message: S.usage.pending.cancelled, isError: false }]);
    assert.equal(me.refreshes(), 1, 'the list reloads after the cancel, and not after a "no"');
  });
  // Someone who may not cancel it (an admin looking at another person's list) gets no cancel button.
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const locked = { items: [{ userId: 1, userName: 'Anna', reservations: [reservation({ can: { edit: false, cancel: false, approve: false, decline: false } })], drafts: [] }], count: 1 };
    const banner = view(dom, pendingBanner(makeApp(BEN).app, locked));
    assert.equal(all(banner, 'button').length, 0);
  });
});

// ------------------------------------------------------- the reservation card

const card = (me: ReturnType<typeof makeApp>, r: Json, past = false): FakeElement => reservationCard(me.app, r as never, past) as unknown as FakeElement;

test('card: from 30 minutes before the start it says km are missing and offers Register km; the note is always shown', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const soon = view(dom, card(me, reservation({ note: 'Market' })));
    assert.equal(one(soon, '.km-line.missing').textContent, S.agenda.kmMissing);
    assert.equal(one(soon, 'a[href="#/usage?res=7"]').textContent, S.agenda.registerKm);
    assert.equal(one(soon, '.note').textContent, 'Market');

    const later = view(dom, card(me, reservation({ start: at(120), end: at(240), note: 'Later' })));
    assert.equal(all(later, '.km-line').length, 0, 'nothing about km before the lead time');
    assert.equal(all(later, 'a[href^="#/usage"]').length, 0);
    assert.equal(one(later, '.note').textContent, 'Later');
  });
});

test('card: a registered reservation says who registered how many km, a started drive offers Finish drive to its driver', async () => {
  const me = makeApp(ANNA);
  const drive = (over: Json) => ({ id: 9, userId: BEN.id, userName: 'Ben', status: 'completed', odometerStart: 100, odometerEnd: 220, distanceKm: 120, linked: false, ...over });
  await withClient({ now: NOW, routes: {} }, async ({ dom }) => {
    const done = view(dom, card(me, reservation({ kmState: 'registered', drive: drive({}) })));
    assert.equal(one(done, '.km-line.registered').textContent, S.agenda.kmRegistered(120, 'Ben'));
    assert.equal(all(done, 'a[href^="#/usage"]').length, 0, 'nothing left to register');

    const mineStarted = view(dom, card(me, reservation({ kmState: 'draft', drive: drive({ userId: ANNA.id, userName: 'Anna', status: 'draft', odometerEnd: null, distanceKm: null }) })));
    assert.equal(one(mineStarted, '.km-line.draft').textContent, S.agenda.kmDraft);
    assert.equal(one(mineStarted, 'a[href="#/usage?edit=9"]').textContent, S.agenda.finishDrive);

    const theirs = view(dom, card(me, reservation({ userId: BEN.id, userName: 'Ben', start: at(-30), end: at(60) })));
    assert.equal(one(theirs, 'a[href="#/usage?res=7"]').textContent, S.agenda.iDroveThis, 'another member can register who actually drove, once it has started');
  });
});

test('card: cancelling asks first, runs once, reports and reloads the list', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: { 'DELETE /api/reservations/7': () => new Reply(null, 204) } }, async ({ dom, api }) => {
    const el = view(dom, card(me, reservation()));
    const cancel = byText(el, 'button', S.agenda.cancelReservation);
    dom.answer = false;
    await cancel.fire('click');
    assert.deepEqual(api.writes(), []);
    assert.equal(me.refreshes(), 0);
    dom.answer = true;
    await cancel.fire('click'); // the card runs its action without being awaited, like a tap
    await until(() => !cancel.disabled && me.refreshes() === 1, 'the action to finish and the buttons to come back');
    assert.equal(onlyWrite(api).path, '/api/reservations/7');
    assert.deepEqual(me.toasts, [{ message: S.agenda.cancelled, isError: false }]);
    assert.equal(cancel.disabled, false, 'the buttons come back once the list was reloaded and the card is still there');
  });
});

// ---------------------------------------------------------------- the history

test('history: drives show km, who reserved and the note, an open drive says so, reservations nobody drove are listed', async () => {
  const me = makeApp(ANNA);
  const linked = usage({
    id: 20,
    start: at(-3000),
    end: at(-2900),
    note: 'Airport',
    reservationId: 5,
    reservation: { id: 5, userId: ANNA.id, userName: 'Anna', start: at(-3100), end: at(-2800) },
    sameDriver: false,
  });
  const open = draft({ id: 21, start: at(-120), reservation: null, sameDriver: null, reservationId: null, note: '' });
  const unused = reservation({ id: 30, userId: BEN.id, userName: 'Ben', start: at(-9000), end: at(-8900), note: 'Never used' });
  const registered = reservation({ id: 31, start: at(-7000), end: at(-6900), kmState: 'registered' });
  const routes = { 'GET /api/history': () => ({ usage: [linked, open], reservations: [unused, registered] }), 'GET /api/fuel': () => ({ items: [], balances: [] }) };
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const list = view(dom, await renderHistory(me.app));
    assert.equal(all(list, 'section.card').length, 0, 'nobody owes fuel money, so there is no fuel section');
    const cards = all(list, 'article.history');
    assert.equal(cards.length, 3, 'the registered reservation is not shown as unused');

    // Newest first: the open drive, the linked drive, then the reservation nobody drove.
    const [running, drive, never] = cards as [FakeElement, FakeElement, FakeElement];
    assert.equal(one(drive, '.badge-status.confirmed').textContent, S.usage.km(120));
    assert.equal(one(drive, '.sub').textContent, `${S.history.reservedBy(S.me)} · ${S.history.otherDriver}`);
    assert.equal(one(drive, '.note').textContent, 'Airport');

    assert.equal(one(running, '.badge-status.expired').textContent, S.history.notFinished);
    assert.equal(all(running, '.badge-status.confirmed').length, 0);
    assert.equal(one(running, '.when').textContent, S.usage.started(fmtWhen(at(-120), TZ)));

    assert.equal(one(never, '.badge-status').textContent, S.history.notDriven);
    assert.equal(one(never, '.note').textContent, 'Never used');
  });
});

test('history: a drive that is somebody else\'s or shared says so, with the note', async () => {
  const me = makeApp(ANNA);
  const forBen = usage({ id: 20, userId: ANNA.id, userName: 'Anna', start: at(-300), end: at(-200), kmFor: 'person', kmUserId: BEN.id, kmUserName: 'Ben', note: 'Took Ben to the station', reservation: null, sameDriver: null });
  const together = usage({ id: 21, userId: ANNA.id, userName: 'Anna', start: at(-100), end: at(-50), kmFor: 'together', kmUserId: null, kmUserName: null, note: 'Shopping for everybody', reservation: null, sameDriver: null });
  const own = usage({ id: 22, userId: ANNA.id, userName: 'Anna', start: at(-30), end: at(-10), kmFor: 'self', kmUserId: null, kmUserName: null, reservation: null, sameDriver: null });
  const routes = { 'GET /api/history': () => ({ usage: [own, together, forBen], reservations: [] }), 'GET /api/fuel': () => ({ items: [], balances: [] }) };
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const cards = all(view(dom, await renderHistory(me.app)), 'article.history');
    assert.equal(cards.length, 3);
    const [ownCard, sharedCard, personCard] = cards as [FakeElement, FakeElement, FakeElement];
    assert.equal(all(ownCard, '.km-owner-line').length, 0, 'the driver\'s own kilometres say nothing extra');
    assert.equal(one(sharedCard, '.km-owner-line').textContent, S.usage.kmOwnerTogether);
    assert.equal(one(sharedCard, '.note').textContent, 'Shopping for everybody');
    assert.equal(one(personCard, '.km-owner-line').textContent, S.usage.kmOwnerPerson('Ben'));
    assert.equal(one(personCard, '.note').textContent, 'Took Ben to the station');
    assert.equal(one(personCard, 'strong').textContent, S.history.drivenBy(S.me), 'Anna is still the driver');
  });
});

/** A fill-up by Anna with Ben's share to pay (Ben is the viewer in the History tests). */
function owedFuel(id: number, share: Json = {}, over: Json = {}): Json {
  return fuelRow({
    id,
    shares: [
      { userId: ANNA.id, userName: 'Anna', km: 100, cents: 4000, owes: false, carriedCents: 0, dueCents: 0, settledBy: null, request: null, can: { request: false, markPaid: false, selfPaid: false } },
      { userId: BEN.id, userName: 'Ben', km: 100, cents: 4000, owes: true, carriedCents: 0, dueCents: 4000, settledBy: null, request: null, can: { request: false, markPaid: false, selfPaid: true }, ...share },
    ],
    ...over,
  });
}
const historyRoutes = (items: Json[], extra: Routes = {}): Routes => ({
  'GET /api/history': () => ({ usage: [], reservations: [] }),
  'GET /api/fuel': () => ({ items, balances: [] }),
  ...extra,
});
const owedSection = (page: unknown): FakeElement => {
  const heading = all(page, 'h3').find((h3) => h3.textContent === S.history.fuelOwed);
  assert.ok(heading?.parent, 'the Fuel you owe section is on the page');
  return heading.parent;
};

test('history: "Fuel you owe" lists what I have to pay with the amount due and carried, and "I have paid this request" says so', async () => {
  const me = makeApp(BEN);
  let paid = false;
  const items = (): Json[] => [
    owedFuel(5, { carriedCents: 1500, dueCents: 5500, ...(paid ? { request: request({ amountCents: 5500, paidAt: at(-1), changed: false }), can: { request: false, markPaid: false, selfPaid: false } } : {}) }, { at: at(-1440) }),
  ];
  const routes = historyRoutes([], {
    'GET /api/fuel': () => ({ items: items(), balances: [] }),
    'POST /api/fuel/5/requests/2/paid': (call) => {
      assert.deepEqual(call.body, { paid: true });
      paid = true;
      return { fuel: {} };
    },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await renderHistory(me.app));
    const section = owedSection(page);
    assert.ok(all(section, 'p.hint').some((p) => p.textContent === S.history.fuelOwedIntro));
    const [row] = all(section, 'li.share') as [FakeElement];
    assert.equal(one(row, 'strong').textContent, S.history.fuelOwedHeader('Anna', fmtWhen(at(-1440), TZ)));
    // The rows add up in order and the total is said once, as the last (emphasised) line.
    const order = [S.history.fuelOwedShare('40.00'), S.fuel.carried('15.00'), S.fuel.due('55.00')].map((line) => row.textContent.indexOf(line));
    assert.ok(order[0]! >= 0 && order[0]! < order[1]! && order[1]! < order[2]!, `this fill-up, what is carried, then the amount due: ${order.join(',')}`);
    assert.equal(all(row, 'div.sub.due').length, 1, 'only the total is emphasised');
    assert.equal(row.textContent.includes(S.history.fuelOwedDue('55.00')), false, 'the total is not repeated above its breakdown');
    assert.equal(all(row, '.chip').length, 0, 'still open: no paid state yet');

    await byText(row, 'button', S.fuel.iPaid).fire('click');
    await until(() => me.toasts.length === 1, 'the answer');
    assert.deepEqual(onlyWrite(api).path, '/api/fuel/5/requests/2/paid');
    assert.deepEqual(me.toasts, [{ message: S.fuel.iPaidSaved, isError: false }]);
    assert.equal(me.refreshes(), 1, 'the screen reloads');
    await until(() => dom.focused()?.id === 'owed-5', 'focus to return to the fill-up that was paid, not to nowhere');

    // After the reload the share is paid: a paid state, no button.
    const again = owedSection(view(dom, await renderHistory(me.app)));
    const [done] = all(again, 'li.share') as [FakeElement];
    assert.equal(one(done, '.chip').textContent, S.fuel.status.paid);
    assert.ok(done.textContent.includes(S.history.fuelOwedPaid('55.00')));
    assert.equal(all(done, 'button').length, 0);
    assert.equal(all(again, 'p.hint').filter((p) => p.textContent === S.history.fuelOwedIntro).length, 0, 'nothing left to press, so no instruction');
  });
});

test('history: open shares come before paid and settled ones, other people\'s shares are not listed, and a failing fuel answer does not take the history down', async () => {
  const me = makeApp(BEN);
  const settled = owedFuel(4, { settledBy: { fuelId: 6, at: at(-100) }, can: { request: false, markPaid: false, selfPaid: false } }, { at: at(-5000) });
  const open = owedFuel(6, {}, { at: at(-100) });
  const others = owedFuel(7, { userId: 3, userName: 'Carla' }); // the second share belongs to somebody else; Ben has none here
  const mine = fuelRow({ id: 8, userId: BEN.id, userName: 'Ben', shares: [{ userId: BEN.id, userName: 'Ben', km: 100, cents: 4000, owes: false, carriedCents: 0, dueCents: 0, settledBy: null, request: null, can: { request: false, markPaid: false, selfPaid: false } }] });
  await withClient({ now: NOW, routes: historyRoutes([settled, open, others, mine]) }, async ({ dom }) => {
    const rows = all(owedSection(view(dom, await renderHistory(me.app))), 'li.share');
    assert.equal(rows.length, 2, 'Carla\'s share and my own fill-up are not mine to pay');
    assert.ok((rows[0] as FakeElement).textContent.includes(S.history.fuelOwedDue('40.00')), 'the open one first');
    assert.equal(one(rows[1], '.chip').textContent, S.fuel.status.settled);
    assert.ok((rows[1] as FakeElement).textContent.includes(S.fuel.settledBy(fmtWhen(at(-100), TZ))));
    assert.equal(all(rows[1], 'button').length, 0, 'nothing to press on a settled share');
  });

  await withClient({ now: NOW, routes: historyRoutes([], { 'GET /api/fuel': () => refuse(500, 'internal') }) }, async ({ dom }) => {
    const page = view(dom, await renderHistory(me.app));
    assert.equal(all(page, 'h3').some((h3) => h3.textContent === S.history.fuelOwed), false);
    assert.equal(one(page, 'h2').textContent, S.history.title, 'the history itself still shows');
  });
});

test('history: when "I have paid this request" is refused (a stale page), the person is told why, the buttons work again and the screen reloads to the truth', async () => {
  const me = makeApp(BEN);
  let settled = false;
  const items = (): Json[] => [
    owedFuel(5, settled ? { settledBy: { fuelId: 6, at: at(-100) }, can: { request: false, markPaid: false, selfPaid: false } } : {}, { at: at(-1440) }),
  ];
  const routes = historyRoutes([], {
    'GET /api/fuel': () => ({ items: items(), balances: [] }),
    'POST /api/fuel/5/requests/2/paid': () => {
      settled = true; // somebody else's payment settled it while this page was open
      return refuse(409, 'already_paid');
    },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await renderHistory(me.app));
    const [row] = all(owedSection(page), 'li.share') as [FakeElement];
    const button = byText(row, 'button', S.fuel.iPaid);
    await button.fire('click');
    await until(() => me.toasts.length === 1, 'the refusal to be reported');
    assert.deepEqual(me.toasts, [{ message: S.errors.already_paid, isError: true }], 'an error, in words');
    assert.equal(onlyWrite(api).path, '/api/fuel/5/requests/2/paid');
    assert.equal(me.refreshes(), 1, 'the screen reloads whatever the answer was');
    await until(() => button.disabled === false, 'the button to be usable again, not stuck busy');
    await until(() => dom.focused()?.id === 'owed-5', 'focus to return to the fill-up');

    // After the reload the truth is on the screen: settled, nothing left to press.
    const [after] = all(owedSection(view(dom, await renderHistory(me.app))), 'li.share') as [FakeElement];
    assert.equal(one(after, '.chip').textContent, S.fuel.status.settled);
    assert.equal(all(after, 'button').length, 0);
  });
});

// ----------------------------------------- kilometres that are not the driver's own

const ownerBox =(form: unknown): FakeElement => one(form, '.km-owner-box');
const notMine = (form: unknown): FakeElement => one(form, 'label.check input');
const ownerSelect = (form: unknown): FakeElement => control(fieldRow(form, S.usage.kmWhose));
const optionsOf = (select: FakeElement): string[] => all(select, 'option').map((o) => o.textContent);

test('drive form: "I drove, but the kilometres aren\'t mine" reveals the choice and makes the note required; nothing is sent until both are filled in', async () => {
  const me = makeApp(ANNA);
  const ended = reservation({ start: at(-300), end: at(-240), note: '', kmState: 'missing' });
  await withClient({ now: NOW, routes: driveRoutes({ reservations: [ended] }) }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me, 'res=7'));
    // Off by default: nothing extra to look at, the note is the recommended one.
    assert.equal(notMine(form).checked, false);
    assert.equal(ownerBox(form).hidden, true);
    assert.equal(hintOf(fieldRow(form, S.usage.note)), S.noteHint);
    assert.equal(control(fieldRow(form, S.usage.note)).getAttribute('aria-required'), 'false');
    assert.equal(all(form, 'label.check span')[0]?.textContent, S.usage.kmNotMine);

    await typeInto(readingStart(form), '50000');
    await typeInto(readingEnd(form), '50042');
    notMine(form).checked = true;
    await notMine(form).fire('change');
    assert.equal(ownerBox(form).hidden, false, 'the choice appears');
    assert.deepEqual(optionsOf(ownerSelect(form)), [S.usage.kmPersonNone, S.usage.kmChooseTogether, 'Ben', 'Root'], 'every active person but the driver, and Together');
    const note = fieldRow(form, S.usage.noteRequired);
    assert.equal(hintOf(note), S.usage.noteRequiredHint);
    assert.equal(control(note).getAttribute('aria-required'), 'true');

    // Nothing chosen and no note: both are reported on their fields, no request is made, focus goes to the first.
    await submitForm(form);
    assert.deepEqual(api.writes(), []);
    assert.equal(errorOf(fieldRow(form, S.usage.kmWhose)), S.fieldErrors.required);
    assert.equal(errorOf(note), S.fieldErrors.required);
    assert.equal(dom.focused(), ownerSelect(form), 'focus goes to the first invalid field');

    // Together is chosen: the note is still missing.
    ownerSelect(form).value = 'together';
    await ownerSelect(form).fire('change');
    await submitForm(form);
    assert.deepEqual(api.writes(), []);
    assert.equal(errorOf(fieldRow(form, S.usage.kmWhose)), '', 'the choice is fine now');
    assert.equal(errorOf(note), S.fieldErrors.required);
    await typeInto(control(note), '   ');
    await submitForm(form);
    assert.deepEqual(api.writes(), [], 'a blank note is no note');

    await typeInto(control(note), 'Shopping for everybody');
    await submitForm(form);
    assert.deepEqual(onlyWrite(api).body, {
      status: 'completed',
      start: at(-300),
      end: at(-240),
      odometerStart: 50000,
      odometerEnd: 50042,
      note: 'Shopping for everybody',
      kmFor: 'together',
      kmUserId: null,
      reservationId: 7,
    });
    assert.deepEqual(me.toasts, [{ message: S.usage.saved, isError: false }]);
  });
});

test('drive form: choosing a person sends their id; switching the box off again sends nothing about it', async () => {
  const me = makeApp(ANNA);
  const ended = reservation({ start: at(-300), end: at(-240), note: 'Visit', kmState: 'missing' });
  await withClient({ now: NOW, routes: driveRoutes({ reservations: [ended] }) }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me, 'res=7'));
    await typeInto(readingStart(form), '50000');
    await typeInto(readingEnd(form), '50042');

    notMine(form).checked = true;
    await notMine(form).fire('change');
    ownerSelect(form).value = `person:${BEN.id}`;
    await ownerSelect(form).fire('change');
    await submitForm(form);
    const sent = onlyWrite(api).body;
    assert.deepEqual([sent['kmFor'], sent['kmUserId'], sent['note']], ['person', BEN.id, 'Visit']);

    // Back to "mine": the label returns to the recommended note and the request says nothing about whose kilometres.
    notMine(form).checked = false;
    await notMine(form).fire('change');
    assert.equal(ownerBox(form).hidden, true);
    assert.equal(hintOf(fieldRow(form, S.usage.note)), S.noteHint);
    await typeInto(control(fieldRow(form, S.usage.note)), '');
    await submitForm(form);
    const own = api.writes()[1]?.body as Json;
    assert.equal('kmFor' in own, false);
    assert.equal(own['note'], '', 'the driver\'s own kilometres need no note');
  });
});

test('drive form: editing a drive that is somebody else\'s keeps the choice, and an admin choosing another driver takes that person out of the list', async () => {
  const me = makeApp(ANNA);
  const forBen = usage({ id: 4, userId: ANNA.id, userName: 'Anna', kmFor: 'person', kmUserId: BEN.id, kmUserName: 'Ben', note: 'Took Ben', can: { edit: true, delete: true } });
  const routes = driveRoutes({ usage: [forBen], extra: { 'PATCH /api/usage/4': () => ({ usage: {} }) } });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const form = view(dom, await driveForm(me, 'edit=4'));
    assert.equal(notMine(form).checked, true);
    assert.equal(ownerBox(form).hidden, false);
    assert.equal(ownerSelect(form).value, `person:${BEN.id}`);
    assert.ok(fieldRow(form, S.usage.noteRequired), 'the note is required while it is somebody else\'s');

    await submitForm(form);
    const kept = onlyWrite(api).body;
    assert.deepEqual([kept['kmFor'], kept['kmUserId'], kept['note']], ['person', BEN.id, 'Took Ben']);

    // Taking it back as the driver's own has to be said in the request, since "self" is otherwise left out.
    notMine(form).checked = false;
    await notMine(form).fire('change');
    await submitForm(form);
    const back = api.writes()[1]?.body as Json;
    assert.deepEqual([back['kmFor'], back['kmUserId']], ['self', null]);
  });

  // The person has been deactivated since: still shown and kept while the drive is edited.
  const gone = usage({ id: 4, userId: ANNA.id, userName: 'Anna', kmFor: 'person', kmUserId: 9, kmUserName: 'Dora', note: 'Took Dora', can: { edit: true, delete: true } });
  await withClient({ now: NOW, routes: driveRoutes({ usage: [gone] }) }, async ({ dom }) => {
    const form = view(dom, await driveForm(me, 'edit=4'));
    assert.ok(optionsOf(ownerSelect(form)).includes('Dora'));
    assert.equal(ownerSelect(form).value, 'person:9');
  });

  // An admin registers for somebody else: the driver cannot also be the other person.
  const admin = makeApp(ADMIN);
  await withClient({ now: NOW, routes: driveRoutes() }, async ({ dom }) => {
    const form = view(dom, await driveForm(admin));
    notMine(form).checked = true;
    await notMine(form).fire('change');
    assert.deepEqual(optionsOf(ownerSelect(form)), [S.usage.kmPersonNone, S.usage.kmChooseTogether, 'Anna', 'Ben'], 'the admin is the driver');
    ownerSelect(form).value = `person:${BEN.id}`;
    const who = control(fieldRow(form, S.usage.driver));
    who.value = String(BEN.id);
    await who.fire('change');
    assert.deepEqual(optionsOf(ownerSelect(form)), [S.usage.kmPersonNone, S.usage.kmChooseTogether, 'Anna', `Root (${S.me})`], 'Ben is the driver now, so he is not offered and the choice of him is dropped');
    assert.equal(ownerSelect(form).value, '');
  });
});

test('drive form: a server refusal about whose kilometres shows on the choice, and the list and totals show the owner and Together', async () => {
  const me = makeApp(ANNA);
  const forBen = usage({ id: 4, userId: ANNA.id, userName: 'Anna', kmFor: 'person', kmUserId: BEN.id, kmUserName: 'Ben', note: 'Took Ben', can: { edit: true, delete: true } });
  const shared = usage({ id: 5, userId: ANNA.id, userName: 'Anna', start: at(-900), end: at(-800), kmFor: 'together', kmUserId: null, kmUserName: null, note: 'All of us', can: { edit: true, delete: true } });
  const routes = driveRoutes({
    usage: [forBen, shared],
    extra: {
      'GET /api/usage/summary': () => ({
        items: [{ userId: BEN.id, userName: 'Ben', trips: 0, km: 120 }, { userId: ANNA.id, userName: 'Anna', trips: 2, km: 40 }],
        together: { trips: 1, km: 30 },
        totalKm: 190,
      }),
      'PATCH /api/usage/4': () => refuse(422, 'validation_failed', { fields: { kmUserId: 'same_as_driver' } }),
    },
  });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const form = view(dom, await driveForm(me, 'edit=4'));
    await submitForm(form);
    assert.equal(errorOf(fieldRow(form, S.usage.kmWhose)), S.fieldErrors.same_as_driver);
    assert.equal(one(form, 'p.form-error').textContent, S.errors.validation_failed);

    const page = view(dom, await driveForm(me));
    const cards = all(page, 'article.usage');
    assert.equal(one(cards[0], '.km-owner-line').textContent, S.usage.kmOwnerPerson('Ben'));
    assert.equal(one(cards[1], '.km-owner-line').textContent, S.usage.kmOwnerTogether);
    const totals = all(one(page, 'ul.totals'), 'li').map((li) => li.textContent);
    assert.deepEqual(totals, [`Ben${S.usage.km(120)} · ${S.usage.trips(0)}`, `${S.me}${S.usage.km(40)} · ${S.usage.trips(2)}`, `${S.usage.kmTogetherTotal}${S.usage.km(30)} · ${S.usage.trips(1)}`]);
    assert.ok(all(page, 'p.hint').some((p) => p.textContent === S.usage.kmTogetherNote), 'it explains what together means');
  });
});

// ------------------------------------------------------------- the fuel view

function fuelRow(over: Json = {}): Json {
  return {
    id: 5,
    userId: ANNA.id,
    userName: 'Anna',
    at: at(-1440),
    millilitres: 40000,
    totalCents: 8000,
    pricePerLitreMillis: 2000,
    note: 'Shell',
    period: { from: at(-20000), to: at(-1440) },
    totalKm: 200,
    equalSplit: false,
    firstInData: false,
    shares: [
      { userId: ANNA.id, userName: 'Anna', km: 100, cents: 4000, owes: false, request: null, can: { request: false, markPaid: false } },
      { userId: BEN.id, userName: 'Ben', km: 100, cents: 4000, owes: true, request: null, can: { request: true, markPaid: false } },
    ],
    hasPaidRequests: false,
    can: { edit: true, delete: true },
    ...over,
  };
}
const request = (over: Json = {}): Json => ({ id: 1, amountCents: 4000, provider: 'manual', message: 'Hi Ben, your share of the fuel is 40.00 euro.', link: '', paidAt: null, changed: false, ...over });
const withRequest = (req: Json, can: Json = { request: true, markPaid: true }): Json =>
  fuelRow({ shares: [(fuelRow().shares as Json[])[0], { userId: BEN.id, userName: 'Ben', km: 100, cents: 4000, owes: true, request: req, can }] });
const fuelRoutes = (items: Json[] = [], extra: Routes = {}): Routes => ({
  'GET /api/fuel': () => ({ items, balances: [] }),
  'POST /api/fuel': () => new Reply({ fuel: {} }, 201),
  ...extra,
});
const fuelForm = (app: ReturnType<typeof makeApp>, query = '') => renderFuel(app.app, { query: new URLSearchParams(query) });

test('fuel form: two of litres, total and price are enough; the app works out the rest and sends whole millilitres and cents', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: fuelRoutes() }, async ({ dom, api }) => {
    const form = view(dom, await fuelForm(me));
    assert.match(S.reserve.note, /recommended/i, 'the same recommended note as the other forms');
    assert.equal(hintOf(fieldRow(form, S.reserve.note)), S.noteHint);
    await typeInto(control(fieldRow(form, S.fuel.litres)), '40,5');
    await typeInto(control(fieldRow(form, S.fuel.total)), '81');
    await typeInto(control(fieldRow(form, S.fuel.odometer)), '41200');
    assert.equal(one(form, 'p.hint[aria-live="polite"]').textContent, S.fuel.worked(fmtLitres(40500), fmtCents(8100), fmtPrice(2000)), 'the figures worked out are shown before saving');

    await submitForm(form);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/fuel');
    assert.deepEqual(sent.body, { at: NOW, millilitres: 40500, totalCents: 8100, note: '', odometer: 41200 });
    assert.deepEqual(me.toasts, [{ message: `${S.fuel.saved} ${S.noteTip}`, isError: false }]);
    assert.deepEqual(me.navigated, ['#/fuel']);
  });
});

test('fuel form: one figure is not enough, and nothing is sent until the figures make sense', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: fuelRoutes() }, async ({ dom, api }) => {
    const form = view(dom, await fuelForm(me));
    await typeInto(control(fieldRow(form, S.fuel.litres)), '40');
    await submitForm(form);
    assert.deepEqual(api.writes(), []);
    assert.equal(errorOf(fieldRow(form, S.fuel.total)), S.fieldErrors.needs_two);
    assert.equal(errorOf(fieldRow(form, S.fuel.pricePerLitre)), S.fieldErrors.needs_two);
    assert.equal(dom.focused()?.getAttribute('aria-invalid'), 'true');

    await typeInto(control(fieldRow(form, S.fuel.total)), '12,345');
    await submitForm(form);
    assert.equal(errorOf(fieldRow(form, S.fuel.total)), S.fieldErrors.invalid_amount, 'half cents are refused, not rounded away');
    assert.deepEqual(api.writes(), []);
  });
});

test('fuel form: an admin records a fill-up for someone else, and a server refusal shows on its field', async () => {
  const admin = makeApp(ADMIN);
  let answer: Reply = new Reply({ fuel: {} }, 201);
  await withClient({ now: NOW, routes: fuelRoutes([], { 'POST /api/fuel': () => answer }) }, async ({ dom, api }) => {
    const form = view(dom, await fuelForm(admin));
    control(fieldRow(form, S.fuel.who)).value = String(BEN.id);
    await typeInto(control(fieldRow(form, S.fuel.litres)), '40');
    await typeInto(control(fieldRow(form, S.fuel.total)), '80');
    await typeInto(control(fieldRow(form, S.fuel.odometer)), '41200');
    answer = refuse(422, 'validation_failed', { fields: { at: 'in_future' } });
    await submitForm(form);
    assert.equal(api.writes()[0]?.body['userId'], BEN.id);
    assert.equal(errorOf(fieldRow(form, S.fuel.when)), S.fieldErrors.in_future);
    assert.equal(one(form, 'p.form-error').textContent, S.errors.validation_failed);
    assert.equal(submitButton(form).disabled, false);
  });
});

test('payment request: create it, get the message ready to text or WhatsApp, optionally with a pasted link', async () => {
  const me = makeApp(ANNA);
  const made = request({ message: 'Hi Ben, your share is 40.00 euro. Pay here: https://tikkie.me/pay/abc', link: 'https://tikkie.me/pay/abc' });
  let answer: Reply = new Reply({ fuel: withRequest(made, { request: true, markPaid: true }) });
  const routes = fuelRoutes([fuelRow()], { 'POST /api/fuel/5/requests': () => answer });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await fuelForm(me));
    const bens = all(page, 'li.share')[1] as FakeElement;
    assert.equal(one(bens, '.chip').textContent, S.fuel.status.none);
    await byText(bens, 'button', S.fuel.request).fire('click');
    assert.equal(one(page, 'h4').textContent, S.fuel.panelTitle('Ben'));
    assert.equal(dom.focused(), one(page, 'h4'), 'keyboard focus moves into the panel');

    await byText(page, 'button', S.fuel.panelCreate).fire('click');
    assert.deepEqual(onlyWrite(api).body, { debtorId: BEN.id }, 'no link unless one was pasted');
    assert.equal(me.toasts[0]?.message, S.fuel.requestSaved);
    assert.equal(one(page, 'textarea').value, made.message);
    assert.equal(one(page, 'a[href^="sms:"]').getAttribute('href'), shareLinks(made.message).sms);
    assert.equal(one(page, 'a[href^="https://wa.me/"]').getAttribute('href'), shareLinks(made.message).whatsapp);
    assert.ok(all(page, 'p.hint').some((p) => p.textContent === S.fuel.providerManual), 'it says the app only wrote the message');

    await typeInto(one(page, 'input[type="url"]'), ' https://tikkie.me/pay/abc ');
    await byText(page, 'button', S.fuel.panelCreate).fire('click');
    assert.deepEqual(api.writes()[1]?.body, { debtorId: BEN.id, link: 'https://tikkie.me/pay/abc' });

    answer = refuse(422, 'validation_failed', { fields: { link: 'invalid_link' } });
    await byText(page, 'button', S.fuel.panelCreate).fire('click');
    assert.equal(errorOf(fieldRow(page, S.fuel.panelLink)), S.fieldErrors.invalid_link);
    assert.equal(one(page, 'div.panel-box p.form-error').textContent, S.errors.validation_failed);
  });
});

test('payment request: marking paid and unpaid reports, reloads and keeps focus on the fill-up; unpaid asks first', async () => {
  const me = makeApp(ANNA);
  let paid = false;
  const routes = fuelRoutes([fuelRow()], {
    'GET /api/fuel': () => ({ items: [withRequest(request({ paidAt: paid ? at(-5) : null }))], balances: [] }),
    'POST /api/fuel/5/requests/2/paid': (call) => {
      paid = call.body.paid;
      return { fuel: {} };
    },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    let page = view(dom, await fuelForm(me));
    await byText(page, 'button', S.fuel.markPaid).fire('click');
    await until(() => dom.focused()?.id === 'fuel-5', 'focus to return to the fill-up that was worked on');
    assert.deepEqual(onlyWrite(api).body, { paid: true });
    assert.deepEqual(me.toasts.at(-1), { message: S.fuel.paidSaved, isError: false });
    assert.equal(me.refreshes(), 1);

    page = view(dom, await fuelForm(me));
    assert.equal(one(all(page, 'li.share')[1], '.chip').textContent, S.fuel.status.paid);
    const undo = byText(page, 'button', S.fuel.markUnpaid);
    dom.answer = false;
    await undo.fire('click');
    assert.equal(api.writes().length, 1, 'declining the question changes nothing');
    dom.answer = true;
    await undo.fire('click');
    await until(() => me.toasts.at(-1)?.message === S.fuel.unpaidSaved, 'the unpaid answer');
    assert.deepEqual(api.writes()[1]?.body, { paid: false });
    assert.deepEqual(dom.confirms, [S.fuel.confirmUnpaid, S.fuel.confirmUnpaid]);
  });
});

test('fill-up card: a request stays on the card when the share changed or dropped to nothing, and a paid one can still be marked unpaid', async () => {
  const me = makeApp(ANNA);
  const bens = (cents: number, req: Json, can: Json): Json => ({ userId: BEN.id, userName: 'Ben', km: 0, cents, owes: true, request: req, can });
  const base = (fuelRow().shares as Json[])[0];
  let paid = true;
  const routes = fuelRoutes([], {
    // Ben asked for 40.00 and paid it; his share is 0.00 now (his drive was changed afterwards).
    'GET /api/fuel': () => ({
      items: [fuelRow({ shares: [base, bens(0, request({ paidAt: paid ? at(-5) : null, changed: true }), { request: false, markPaid: true })] })],
      balances: [],
    }),
    'POST /api/fuel/5/requests/2/paid': (call) => {
      paid = call.body.paid;
      return { fuel: {} };
    },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await fuelForm(me));
    const row = all(page, 'li.share')[1] as FakeElement;
    assert.equal(one(row, '.chip').textContent, S.fuel.status.paidChanged);
    assert.ok(one(row, '.chip').classList.contains('changed'), 'it is drawn like the other changed shares');
    assert.equal(one(row, '.sub').textContent, S.fuel.changedPaid('40.00', '0.00', false, '40.00'), 'it says by how much');
    assert.equal(all(row, 'button').filter((b) => b.textContent === S.fuel.request || b.textContent === S.fuel.shareRequest).length, 0, 'nothing to ask for when the share is 0.00');
    dom.answer = true;
    await byText(row, 'button', S.fuel.markUnpaid).fire('click');
    await until(() => me.toasts.at(-1)?.message === S.fuel.unpaidSaved, 'the unpaid answer');
    assert.deepEqual(onlyWrite(api).body, { paid: false }, 'the button follows paidAt, not the chip');
  });

  // Not paid yet: the request is still visible, flagged, and says what changed.
  const open = fuelRoutes([fuelRow({ shares: [base, bens(6000, request({ amountCents: 4000, changed: true }), { request: true, markPaid: true })] })]);
  await withClient({ now: NOW, routes: open }, async ({ dom }) => {
    const row = all(view(dom, await fuelForm(me)), 'li.share')[1] as FakeElement;
    assert.equal(one(row, '.chip').textContent, S.fuel.status.changed);
    assert.equal(one(row, '.sub').textContent, S.fuel.changedAsked('40.00', '60.00', true, '20.00'));
    assert.ok(byText(row, 'button', S.fuel.shareRequest), 'it can be redone for the new amount');
  });
});

test('fill-up card: shows who fuelled, the note and each share; delete asks first', async () => {
  const me = makeApp(ANNA);
  const routes = fuelRoutes([fuelRow()], { 'DELETE /api/fuel/5': () => new Reply(null, 204) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await fuelForm(me));
    const cardEl = one(page, 'article#fuel-5');
    assert.equal(one(cardEl, 'strong').textContent, S.fuel.header(S.me, fmtLitres(40000), fmtCents(8000)));
    assert.equal(one(cardEl, '.note').textContent, 'Shell');
    assert.equal(all(cardEl, 'li.share').length, 2);
    assert.equal(one(all(cardEl, 'li.share')[0], '.chip').textContent, S.fuel.paidTheBill);

    const remove = byText(cardEl, 'button', S.delete);
    dom.answer = false;
    await remove.fire('click');
    assert.deepEqual(api.writes(), []);
    dom.answer = true;
    await remove.fire('click');
    await until(() => me.toasts.at(-1)?.message === S.fuel.deleted, 'the delete to be reported');
    assert.equal(onlyWrite(api).path, '/api/fuel/5');
  });
});

test('fill-up card: carried amounts, together kilometres and settled shares are explained, and "I have paid" replaces "Mark paid" on my own share', async () => {
  const admin = makeApp(ADMIN);
  const base = { km: 100, owes: true, settledBy: null, carriedCents: 0, dueCents: 0 };
  const shares = [
    { ...base, userId: ANNA.id, userName: 'Anna', cents: 4000, owes: false, request: null, can: { request: false, markPaid: false, selfPaid: false } },
    // Ben: 40.00 plus 15.00 still open from earlier; the fueler can ask.
    { ...base, userId: BEN.id, userName: 'Ben', cents: 4000, carriedCents: 1500, dueCents: 5500, request: null, can: { request: true, markPaid: false, selfPaid: false } },
    // The admin owes too and has a request: as an admin they could also mark it paid, but for their own share only "I have paid" is offered.
    { ...base, userId: ADMIN.id, userName: 'Root', cents: 2000, dueCents: 1000, carriedCents: -1000, request: request({ amountCents: 1000, changed: false }), can: { request: true, markPaid: true, selfPaid: true } },
  ];
  const settled = fuelRow({
    id: 4,
    at: at(-3000),
    settledByLater: true,
    togetherKm: 0,
    shares: [{ ...base, userId: BEN.id, userName: 'Ben', cents: 3000, owes: true, settledBy: { fuelId: 5, at: at(-1440) }, request: null, can: { request: false, markPaid: false, selfPaid: false } }],
    can: { edit: false, delete: false },
  });
  const newest = fuelRow({ id: 5, togetherKm: 80, shares });
  let paid = false;
  const routes = fuelRoutes([], {
    'GET /api/fuel': () => ({ items: [newest, settled], balances: [] }),
    'POST /api/fuel/5/requests/3/paid': (call) => {
      paid = call.body.paid === true;
      return { fuel: {} };
    },
  });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await fuelForm(admin));
    const card = one(page, 'article#fuel-5');
    assert.ok(all(card, 'div.sub').some((d) => d.textContent === S.fuel.togetherNote(80)), 'together kilometres are explained');
    const [, ben, root] = all(card, 'li.share') as [FakeElement, FakeElement, FakeElement];
    assert.deepEqual(all(ben, 'div.sub').map((d) => d.textContent), [S.fuel.carried('15.00'), S.fuel.due('55.00')]);
    assert.deepEqual(all(root, 'div.sub').map((d) => d.textContent), [S.fuel.carriedBack('Anna', S.me, '10.00'), S.fuel.due('10.00')], 'what the fueler owes back is taken off');
    assert.deepEqual(all(root, 'button').map((b) => b.textContent), [S.fuel.shareRequest, S.fuel.iPaid], 'their own share: I have paid, not Mark paid');

    await byText(root, 'button', S.fuel.iPaid).fire('click');
    await until(() => admin.toasts.at(-1)?.message === S.fuel.iPaidSaved, 'the answer');
    assert.equal(paid, true);
    assert.equal(onlyWrite(api).path, '/api/fuel/5/requests/3/paid');
    assert.equal(admin.refreshes(), 1);

    // A fill-up whose share a later payment settled: the state is named, the lock is explained, and nothing can be pressed on it.
    const old = one(page, 'article#fuel-4');
    assert.equal(one(old, '.chip').textContent, S.fuel.status.settled);
    assert.ok(all(old, 'div.sub').some((d) => d.textContent === S.fuel.settledBy(fmtWhen(at(-1440), TZ))));
    assert.ok(all(old, 'p.hint').some((p) => p.textContent === S.fuel.settledLocked), 'and why it cannot be changed');
    assert.equal(all(old, 'button').length, 0);
    assert.equal(all(old, 'a').filter((a) => a.textContent === S.edit).length, 0);
  });
});

test('fill-up card: an equal split says why (nothing counted, or only kilometres driven together), and the pool is described as following the ratio only when kilometres weigh', async () => {
  const me = makeApp(ANNA);
  const items = [
    fuelRow({ id: 7, equalSplit: true, totalKm: 0, togetherKm: 0 }),
    fuelRow({ id: 6, equalSplit: true, totalKm: 50, togetherKm: 50 }),
    fuelRow({ id: 5, equalSplit: false, totalKm: 200, togetherKm: 80 }),
    fuelRow({ id: 4, equalSplit: false, totalKm: 200, togetherKm: 0 }),
  ];
  await withClient({ now: NOW, routes: fuelRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await fuelForm(me));
    const notes = (id: number): string[] => all(one(page, `article#fuel-${id}`), 'div.sub').map((d) => d.textContent);
    const has = (id: number, text: string): boolean => notes(id).includes(text);
    const together80 = S.fuel.togetherNote(80);

    assert.deepEqual([has(7, S.fuel.equalSplit), has(7, S.fuel.equalSplitTogether), has(7, S.fuel.togetherNote(0))], [true, false, false], 'nothing counted');
    assert.deepEqual([has(6, S.fuel.equalSplit), has(6, S.fuel.equalSplitTogether), has(6, S.fuel.togetherNote(50))], [false, true, false], 'only the pool: an equal split, and no ratio to follow');
    assert.deepEqual([has(5, S.fuel.equalSplit), has(5, S.fuel.equalSplitTogether), has(5, together80)], [false, false, true], 'personal kilometres plus a pool: the pool follows their ratio');
    assert.deepEqual([has(4, S.fuel.equalSplit), has(4, S.fuel.equalSplitTogether)], [false, false], 'plain kilometres: nothing to explain');
    assert.equal(notes(4).some((t) => t.includes('together')), false);

    for (const text of [S.fuel.equalSplit, S.fuel.equalSplitTogether, together80, S.usage.kmTogetherNote]) {
      assert.doesNotMatch(text, /equal part|equally over everybody/, 'no text still says the pool is split equally over everybody');
    }
    assert.ok(all(page, 'p.hint').some((p) => p.textContent === S.fuel.adminNote), 'the list says that admins do not pay for fuel');
  });
});

// ------------------------------------------------------- the Reminders card

const KEY = 'AQIDBA'; // the bytes 1, 2, 3, 4 in base64url
const accountRoutes = (extra: Routes = {}): Routes => ({ 'GET /api/push/key': () => ({ enabled: true, publicKey: KEY }), ...extra });
const accountPage = (app: ReturnType<typeof makeApp>) => renderAccount(app.app);
const remindersCard = (page: unknown): FakeElement => {
  const heading = all(page, 'h3').find((h3) => h3.textContent === S.account.reminders.title);
  assert.ok(heading?.parent, 'the Reminders card is on the page');
  return heading.parent;
};

test('reminders: enabling asks permission, subscribes with the server key, tells the server and keeps focus in the card', async () => {
  const R = S.account.reminders;
  const me = makeApp(ANNA);
  const browser = installFakeBrowser();
  try {
    await withClient({ now: NOW, routes: accountRoutes({ 'POST /api/push/subscribe': () => new Reply({ ok: true }, 201) }) }, async ({ dom, api }) => {
      const card = remindersCard(view(dom, await accountPage(me)));
      assert.ok(all(card, 'p').some((p) => p.textContent === R.off));
      await byText(card, 'button', R.enable).fire('click');
      await until(() => dom.focused()?.textContent === R.disable, 'the card to show the disable button');

      assert.equal(browser.asked, 1);
      assert.equal(browser.subscribeCalls.length, 1);
      assert.equal(browser.subscribeCalls[0]?.userVisibleOnly, true);
      assert.deepEqual(Array.from(browser.subscribeCalls[0]?.applicationServerKey as Uint8Array), [1, 2, 3, 4]);
      const sent = onlyWrite(api);
      assert.equal(`${sent.method} ${sent.path}`, 'POST /api/push/subscribe');
      assert.deepEqual(sent.body, browser.subscription?.toJSON());
      assert.deepEqual(me.toasts, [{ message: R.enabledToast, isError: false }]);
      assert.ok(all(card, 'p').some((p) => p.textContent === R.on));
      assert.equal(all(card, 'button').length, 2, 'now it offers disable and test');
      assert.equal(dom.focused(), byText(card, 'button', R.disable), 'the button that was pressed is gone, focus moves to the card, not to nowhere');
    });
  } finally {
    browser.uninstall();
  }
});

test('reminders: a blocked or refused permission subscribes nothing and says how to fix it', async () => {
  const R = S.account.reminders;
  const me = makeApp(ANNA);
  const browser = installFakeBrowser({ answer: 'denied' });
  try {
    await withClient({ now: NOW, routes: accountRoutes() }, async ({ dom, api }) => {
      const card = remindersCard(view(dom, await accountPage(me)));
      await byText(card, 'button', R.enable).fire('click');
      await until(() => all(card, 'p').some((p) => p.textContent === R.denied));
      assert.equal(browser.subscribeCalls.length, 0);
      assert.deepEqual(api.writes(), []);
      assert.ok(all(card, 'p').some((p) => p.textContent === R.fallback), 'the Drives tab still shows what is waiting');
      assert.equal(all(card, 'button').length, 0);
    });
  } finally {
    browser.uninstall();
  }
});

test('reminders: a subscription the server refuses is not kept in the browser, and the person is told why', async () => {
  const R = S.account.reminders;
  const me = makeApp(ANNA);
  const browser = installFakeBrowser();
  try {
    const routes = accountRoutes({ 'POST /api/push/subscribe': () => refuse(422, 'validation_failed', { fields: { endpoint: 'unsupported_endpoint' } }) });
    await withClient({ now: NOW, routes }, async ({ dom }) => {
      const card = remindersCard(view(dom, await accountPage(me)));
      await byText(card, 'button', R.enable).fire('click');
      await until(() => one(card, 'p[role="status"]').textContent !== '');
      assert.equal(one(card, 'p[role="status"]').textContent, R.unsupportedEndpoint);
      assert.equal(browser.unsubscribed, 1);
      assert.equal(browser.subscription, null);
      assert.deepEqual(me.toasts, []);
      assert.equal(byText(card, 'button', R.enable).disabled, false, 'the person can try again');
    });
  } finally {
    browser.uninstall();
  }
});

test('reminders: disabling tells the server and the browser; the test notification says whether anything was delivered', async () => {
  const R = S.account.reminders;
  const me = makeApp(ANNA);
  const browser = installFakeBrowser({ subscribed: true, permission: 'granted' });
  let sent = 1;
  try {
    const routes = accountRoutes({ 'POST /api/push/test': () => ({ sent }), 'POST /api/push/unsubscribe': () => new Reply(null, 204) });
    await withClient({ now: NOW, routes }, async ({ dom, api }) => {
      const card = remindersCard(view(dom, await accountPage(me)));
      assert.ok(all(card, 'p').some((p) => p.textContent === R.on));

      await byText(card, 'button', R.test).fire('click');
      await until(() => me.toasts.length === 1);
      assert.deepEqual(me.toasts[0], { message: R.testSent, isError: false });

      sent = 0;
      await byText(card, 'button', R.test).fire('click');
      await until(() => one(card, 'p[role="status"]').textContent === R.testNotDelivered);

      await byText(card, 'button', R.disable).fire('click');
      await until(() => all(card, 'p').some((p) => p.textContent === R.off));
      assert.deepEqual(api.writes().at(-1)?.body, { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1' });
      assert.equal(api.writes().at(-1)?.path, '/api/push/unsubscribe');
      assert.equal(browser.unsubscribed, 1);
      assert.equal(me.toasts.at(-1)?.message, R.disabledToast);
      assert.ok(byText(card, 'button', R.enable));
    });
  } finally {
    browser.uninstall();
  }
});

test('reminders: where push cannot work the card says why (iPhone in a Safari tab, other browsers, a service worker that never starts) and the server can switch it off', async () => {
  const R = S.account.reminders;
  const notices = (card: FakeElement) => all(card, 'p.notice').map((p) => p.textContent);

  for (const [setup, expected] of [
    [{ push: false, ios: true }, R.iosInstall],
    [{ push: false, ios: false }, R.unsupported],
  ] as const) {
    const browser = installFakeBrowser(setup);
    try {
      await withClient({ now: NOW, routes: accountRoutes() }, async ({ dom }) => {
        const card = remindersCard(view(dom, await accountPage(makeApp(ANNA))));
        assert.deepEqual(notices(card), [expected]);
        assert.ok(all(card, 'p').some((p) => p.textContent === R.fallback));
        assert.equal(all(card, 'button').length, 0);
      });
    } finally {
      browser.uninstall();
    }
  }

  const stuck = installFakeBrowser({ serviceWorker: 'never' });
  try {
    await withClient({ now: NOW, routes: accountRoutes() }, async ({ dom, tick }) => {
      let rendered: unknown;
      void accountPage(makeApp(ANNA)).then((v) => (rendered = v));
      await until(() => {
        tick(4000); // the wait for the service worker is four seconds, then the browser counts as one without reminders
        return rendered !== undefined;
      });
      assert.deepEqual(notices(remindersCard(view(dom, rendered))), [R.unsupported]);
    });
  } finally {
    stuck.uninstall();
  }

  const browser = installFakeBrowser();
  try {
    for (const routes of [accountRoutes({ 'GET /api/push/key': () => ({ enabled: false }) }), accountRoutes({ 'GET /api/push/key': () => refuse(500, 'internal') })]) {
      await withClient({ now: NOW, routes }, async ({ dom }) => {
        const page = view(dom, await accountPage(makeApp(ANNA)));
        assert.equal(all(page, 'h3').some((h3) => h3.textContent === R.title), false, 'no card when the server has reminders off or cannot say');
        assert.ok(all(page, 'p').some((p) => p.textContent === S.account.installIos), 'the rest of the page is still there');
      });
    }
  } finally {
    browser.uninstall();
  }
});

test("sign out: this device stops getting the signed-out person's reminders first, and signing out works whatever happens to that", async () => {
  for (const [name, unsubscribeAnswer, expectedUnsubscribed] of [
    ['clean-up works', new Reply(null, 204), 1],
    ['clean-up fails', refuse(500, 'internal'), 0],
  ] as const) {
    const me = makeApp(ANNA);
    const browser = installFakeBrowser({ subscribed: true, permission: 'granted' });
    try {
      const routes = accountRoutes({ 'POST /api/push/unsubscribe': () => unsubscribeAnswer, 'POST /api/auth/logout': () => new Reply(null, 204) });
      await withClient({ now: NOW, routes }, async ({ dom, api }) => {
        const page = view(dom, await accountPage(me));
        await byText(page, 'button', S.account.signOut).fire('click');
        assert.deepEqual(
          api.writes().map((c) => c.path),
          ['/api/push/unsubscribe', '/api/auth/logout'],
          `${name}: the server still knows whose device it is when it is told, and the session ends after`,
        );
        assert.equal(browser.unsubscribed, expectedUnsubscribed, name);
        assert.deepEqual(me.signedOut, [true], `${name}: signing out always happens`);
      });
    } finally {
      browser.uninstall();
    }
  }

  // A device that never signed up for reminders just signs out.
  const me = makeApp(ANNA);
  const browser = installFakeBrowser({ permission: 'default' });
  try {
    await withClient({ now: NOW, routes: accountRoutes({ 'POST /api/auth/logout': () => new Reply(null, 204) }) }, async ({ dom, api }) => {
      const page = view(dom, await accountPage(me));
      await byText(page, 'button', S.account.signOut).fire('click');
      assert.deepEqual(api.writes().map((c) => c.path), ['/api/auth/logout']);
      assert.deepEqual(me.signedOut, [true]);
    });
  } finally {
    browser.uninstall();
  }
});
