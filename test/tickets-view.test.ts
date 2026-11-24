// What the person sees and what the app sends for traffic tickets: the form (the time of the
// offence, an optional price and reason), the list with the driver the server worked out, editing
// and deleting, the link from the Drives tab, the wiring in the app shell, and the retention texts
// the admin page shows for tickets.
//
// The real view code runs against the fake DOM, a stubbed fetch and a clock that stands still
// (test/fake-dom.ts). Who was driving is the server's job and is tested in tickets.test.ts; here the
// point is that the form sends what the server expects and the list says what the server answered.
// Layout at 390 and 320 px and focus rings stay with the headless browser pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtWhen } from '../public/dom.js';
import { PRIMARY, SECONDARY, placeOf, titleOf } from '../public/nav.js';
import { S } from '../public/strings.js';
import { MAX_AMOUNT_CENTS, REASON_MAX, readAmount, render as renderTickets } from '../public/views/tickets.js';
import { render as renderUsage } from '../public/views/usage.js';
import { formatLocal } from '../shared/time.js';
import { MAX_AMOUNT_CENTS as SERVER_MAX_AMOUNT_CENTS, REASON_MAX as SERVER_REASON_MAX } from '../src/tickets.ts';
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
  errorOf,
  fieldRow,
  hintOf,
  makeApp,
  one,
  refuse,
  submitForm,
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

const view = (dom: FakeDom, rendered: unknown): FakeElement => dom.mount(rendered);
const submitButton = (page: unknown): FakeElement => one(page, 'button[type="submit"]');
const ticketsPage = (app: ReturnType<typeof makeApp>, query = '') => renderTickets(app.app, { query: new URLSearchParams(query) });

function onlyWrite(api: ApiStub): Call {
  const writes = api.writes();
  assert.equal(writes.length, 1, `expected exactly one write, got ${JSON.stringify(writes.map((c) => `${c.method} ${c.path}`))}`);
  return writes[0] as Call;
}

/** A ticket as the server sends it: Anna entered it, Ben was driving. */
const ticket = (over: Json = {}): Json => ({
  id: 1,
  at: at(-600),
  amountCents: null,
  reason: '',
  createdBy: ANNA.id,
  createdByName: 'Anna',
  createdAt: at(-5),
  updatedAt: at(-5),
  driver: { id: BEN.id, name: 'Ben' },
  basis: 'drive',
  can: { edit: true, delete: true },
  ...over,
});

const ticketRoutes = (items: Json[] = [], extra: Routes = {}): Routes => ({
  'GET /api/tickets': () => ({ items }),
  'POST /api/tickets': () => new Reply({ ticket: {} }, 201),
  ...extra,
});

const whenRow = (page: unknown) => fieldRow(page, S.tickets.when);
const amountRow = (page: unknown) => fieldRow(page, S.tickets.amount);
const reasonRow = (page: unknown) => fieldRow(page, S.tickets.reason);

// ------------------------------------------------------------------ the form

test('ticket form: the time defaults to now in the household zone, price and reason are optional and explained', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: ticketRoutes() }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    assert.equal(one(page, 'h3').textContent, S.tickets.addTitle);
    // 10:00 UTC is 12:00 in Amsterdam in June.
    const { date, time } = dateTime(whenRow(page));
    assert.deepEqual([date.value, time.value], ['2026-06-15', '12:00']);
    assert.equal(hintOf(whenRow(page)), S.tickets.whenHint, 'it says this is the time of the offence, not of the letter');
    assert.equal(hintOf(amountRow(page)), S.tickets.amountHint);
    assert.equal(hintOf(reasonRow(page)), S.tickets.reasonHint);
    assert.match(S.tickets.amount, /optioneel/i);
    assert.match(S.tickets.reason, /optioneel/i);
    assert.equal(control(amountRow(page)).value, '');
    assert.equal(control(amountRow(page)).getAttribute('inputmode'), 'decimal');
    assert.equal(control(reasonRow(page)).value, '');
    assert.equal(control(reasonRow(page)).getAttribute('maxlength'), String(REASON_MAX));
    assert.equal(control(amountRow(page)).hasAttribute('required'), false);
    assert.equal(control(reasonRow(page)).hasAttribute('required'), false);
    assert.ok(all(page, 'p.hint').some((p) => p.textContent === S.reserve.tzNote(TZ)), 'the zone is stated');
    assert.equal(submitButton(page).textContent, S.tickets.save);
    assert.equal(one(page, 'a.btn[href="#/usage"]').textContent, S.tickets.back);
  });
});

test('ticket form: saving with only the time sends no price and no reason, then reloads and puts focus on the heading', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: ticketRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me));
    await submitForm(page);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'POST /api/tickets');
    assert.deepEqual(sent.body, { at: NOW, amountCents: null, reason: '' });
    assert.deepEqual(me.toasts, [{ message: S.tickets.saved, isError: false }]);
    assert.equal(me.refreshes(), 1, 'the list is reloaded');
    assert.deepEqual(me.navigated, []);
    assert.equal(dom.focused()?.tagName, 'h2');
    assert.equal(dom.focused()?.textContent, S.tickets.title);
  });
});

test('ticket form: the time picked is sent as the instant it means in the household zone', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: ticketRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me));
    const { date, time } = dateTime(whenRow(page));
    date.value = '2026-06-10';
    time.value = '08:45';
    await submitForm(page);
    assert.equal(onlyWrite(api).body['at'], '2026-06-10T06:45:00.000Z', '08:45 in Amsterdam in June is 06:45 UTC');
  });
});

test('ticket form: the price is typed like a person writes it and sent as whole cents; the reason as typed', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: ticketRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me));
    const price = control(amountRow(page));
    await typeInto(control(reasonRow(page)), 'Speeding on the A4');
    for (const [typed, cents] of [
      ['12,50', 1250],
      ['12.5', 1250],
      [' 7 ', 700],
      ['.5', 50],
      ['0,01', 1],
      ['10000', 1_000_000],
    ] as const) {
      await typeInto(price, typed);
      await submitForm(page);
      assert.equal(api.writes().at(-1)?.body['amountCents'], cents, `"${typed}"`);
    }
    assert.equal(api.writes().at(-1)?.body['reason'], 'Speeding on the A4');
    assert.equal(api.writes().length, 6);
    await typeInto(price, '');
    await submitForm(page);
    assert.equal(api.writes().at(-1)?.body['amountCents'], null, 'emptying the field means no price');
  });
});

test('ticket form: a price that is not a plain amount is refused on the field and nothing is sent', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: ticketRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me));
    const price = control(amountRow(page));
    for (const [typed, code] of [
      ['0', 'too_small'],
      ['0,00', 'too_small'],
      ['abc', 'invalid_amount'],
      ['-5', 'invalid_amount'],
      ['1e3', 'invalid_amount'],
      ['12,345', 'invalid_amount'],
      ['10001', 'too_large'],
      ['10000,01', 'too_large'],
    ] as const) {
      await typeInto(price, typed);
      await submitForm(page);
      assert.equal(errorOf(amountRow(page)), S.fieldErrors[code], `"${typed}"`);
      assert.equal(dom.focused(), price, 'focus goes to the field that needs fixing');
      assert.equal(price.getAttribute('aria-invalid'), 'true');
    }
    assert.deepEqual(api.writes(), [], 'no request was made');

    await typeInto(price, '5');
    await submitForm(page);
    assert.equal(errorOf(amountRow(page)), '', 'the message goes away once the field is right');
    assert.equal(onlyWrite(api).body['amountCents'], 500);
  });
});

test('ticket form: a time that is not a date and time is refused before anything is sent', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: ticketRoutes() }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me));
    dateTime(whenRow(page)).date.value = '';
    await submitForm(page);
    assert.equal(errorOf(whenRow(page)), S.fieldErrors.invalid_datetime);
    assert.deepEqual(api.writes(), []);
    assert.equal(dom.focused()?.getAttribute('aria-invalid'), 'true');
  });
});

test('ticket form: a refusal from the server shows on its fields, says what went wrong and lets the person try again', async () => {
  const me = makeApp(ANNA);
  let answer: Reply = refuse(422, 'validation_failed', { fields: { at: 'in_future', amountCents: 'too_large', reason: 'too_long' } });
  await withClient({ now: NOW, routes: ticketRoutes([], { 'POST /api/tickets': () => answer }) }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    await submitForm(page);
    assert.equal(errorOf(whenRow(page)), S.fieldErrors.in_future);
    assert.equal(errorOf(amountRow(page)), S.fieldErrors.too_large);
    assert.equal(errorOf(reasonRow(page)), S.fieldErrors.too_long);
    const message = one(page, 'p.form-error');
    assert.equal(message.hidden, false);
    assert.equal(message.textContent, S.errors.validation_failed);
    assert.equal(dom.focused()?.getAttribute('aria-invalid'), 'true', 'focus is on the first field to fix');
    assert.equal(submitButton(page).disabled, false, 'the person can fix it and send again');
    assert.deepEqual(me.toasts, []);
    assert.equal(me.refreshes(), 0);

    answer = refuse(422, 'outside_window', { fields: { at: 'outside_window' } });
    await submitForm(page);
    assert.equal(errorOf(whenRow(page)), S.fieldErrors.outside_window);
    assert.equal(errorOf(amountRow(page)), '', 'earlier messages are cleared on the next try');
    assert.equal(message.textContent, S.errors.outside_window);
  });
});

// ------------------------------------------------------------------ the list

test('ticket list: who was driving and on what basis, the price, the reason and who entered it', async () => {
  const me = makeApp(ANNA);
  const items = [
    ticket({ id: 1, at: at(-600), amountCents: 7500, reason: 'Speeding on the A4', driver: { id: BEN.id, name: 'Ben' }, basis: 'drive', createdBy: ANNA.id, createdByName: 'Anna' }),
    ticket({ id: 2, at: at(-1200), driver: { id: ANNA.id, name: 'Anna' }, basis: 'draft', createdBy: BEN.id, createdByName: 'Ben', can: { edit: false, delete: false } }),
    ticket({ id: 3, at: at(-1800), amountCents: 12000, driver: { id: BEN.id, name: 'Ben' }, basis: 'reservation', createdBy: ADMIN.id, createdByName: 'Root', can: { edit: false, delete: false } }),
    ticket({ id: 4, at: at(-2400), driver: null, basis: 'none', createdBy: BEN.id, createdByName: 'Ben', can: { edit: false, delete: false } }),
  ];
  await withClient({ now: NOW, routes: ticketRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    const card = (id: number): FakeElement => one(page, `article#ticket-${id}`);
    assert.equal(all(page, 'article.ticket').length, 4);
    assert.deepEqual(
      all(page, 'article.ticket').map((a) => a.id),
      ['ticket-1', 'ticket-2', 'ticket-3', 'ticket-4'],
      'in the order the server sent them (newest offence first)',
    );

    assert.equal(one(card(1), 'strong').textContent, S.tickets.driver('Ben'));
    assert.equal(one(card(1), '.badge-status').textContent, S.tickets.price('€\u00a075,00'));
    assert.equal(one(card(1), '.when').textContent, fmtWhen(at(-600), TZ));
    assert.equal(one(card(1), '.note').textContent, 'Speeding on the A4');
    assert.ok(all(card(1), '.sub').some((e) => e.textContent === S.tickets.basis.drive));
    assert.ok(all(card(1), '.sub').some((e) => e.textContent === S.tickets.enteredBy(S.you)), 'entered by the signed-in person says "you"');

    assert.equal(one(card(2), 'strong').textContent, S.tickets.driver(S.tickets.you), 'the signed-in person is named "You"');
    assert.ok(all(card(2), '.sub').some((e) => e.textContent === S.tickets.basis.draft));
    assert.ok(all(card(2), '.sub').some((e) => e.textContent === S.tickets.enteredBy('Ben')));
    assert.equal(all(card(2), '.badge-status').length, 0, 'no price, no badge');
    assert.equal(all(card(2), '.note').length, 0, 'no reason, no note');

    assert.ok(all(card(3), '.sub').some((e) => e.textContent === S.tickets.basis.reservation));
    assert.equal(one(card(3), '.badge-status').textContent, S.tickets.price('€\u00a0120,00'));

    assert.equal(one(card(4), 'strong').textContent, S.tickets.noDriver);
    assert.ok(all(card(4), '.sub').some((e) => e.textContent === S.tickets.basis.none));

    assert.ok(all(page, 'p.hint').some((p) => p.textContent === S.tickets.followsLog), 'it says the driver follows the drive log');
  });
});

test('ticket list: a reason that looks like markup is shown as text, never as markup', async () => {
  const me = makeApp(ANNA);
  const sneaky = '<img src=x onerror=alert(1)><b>bold</b>';
  await withClient({ now: NOW, routes: ticketRoutes([ticket({ reason: sneaky, driver: { id: BEN.id, name: '<i>Ben</i>' } })]) }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    const card = one(page, 'article#ticket-1');
    assert.equal(one(card, '.note').textContent, sneaky);
    assert.equal(one(card, 'strong').textContent, S.tickets.driver('<i>Ben</i>'));
    for (const tag of ['img', 'b', 'i']) assert.equal(all(card, tag).length, 0, `no <${tag}> element was created`);
  });
});

test('ticket list: Edit and Delete are there only where the server says they are allowed', async () => {
  const me = makeApp(ANNA);
  const items = [
    ticket({ id: 1, can: { edit: true, delete: true } }),
    ticket({ id: 2, can: { edit: false, delete: false } }),
    ticket({ id: 3, can: { edit: true, delete: false } }),
    ticket({ id: 4, can: { edit: false, delete: true } }),
  ];
  await withClient({ now: NOW, routes: ticketRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    const actions = (id: number) => {
      const card = one(page, `article#ticket-${id}`);
      return {
        edit: all(card, 'a').filter((a) => a.textContent === S.edit).map((a) => a.getAttribute('href')),
        remove: all(card, 'button').filter((b) => b.textContent === S.delete).length,
        bar: all(card, '.actions').length,
      };
    };
    assert.deepEqual(actions(1), { edit: ['#/tickets?edit=1'], remove: 1, bar: 1 });
    assert.deepEqual(actions(2), { edit: [], remove: 0, bar: 0 }, 'someone else\'s ticket has no buttons at all');
    assert.deepEqual(actions(3), { edit: ['#/tickets?edit=3'], remove: 0, bar: 1 });
    assert.deepEqual(actions(4), { edit: [], remove: 1, bar: 1 });
  });
});

test('ticket list: Edit and Delete keep their visible words but each has a name that tells the tickets apart', async () => {
  const me = makeApp(ANNA);
  const items = [ticket({ id: 1, at: at(-600) }), ticket({ id: 2, at: at(-1200) })];
  await withClient({ now: NOW, routes: ticketRoutes(items) }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    const names = (id: number) => {
      const card = one(page, `article#ticket-${id}`);
      const link = one(card, 'a.btn');
      const button = one(card, 'button.danger');
      return { edit: link.getAttribute('aria-label'), remove: button.getAttribute('aria-label'), words: [link.textContent, button.textContent] };
    };
    const first = names(1);
    assert.equal(first.edit, S.tickets.editLabel(fmtWhen(at(-600), TZ)));
    assert.equal(first.remove, S.tickets.deleteLabel(fmtWhen(at(-600), TZ)));
    assert.deepEqual(first.words, [S.edit, S.delete]);
    assert.notEqual(names(2).edit, first.edit, 'two tickets never share a button name');
    assert.notEqual(names(2).remove, first.remove);
    // A name that does not contain the visible word breaks voice control ("click Edit").
    assert.ok(S.tickets.editLabel('x').startsWith(S.edit) && S.tickets.deleteLabel('x').startsWith(S.delete));
  });
});

test('ticket list: with no tickets it says so', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: ticketRoutes([]) }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    assert.equal(all(page, 'article.ticket').length, 0);
    assert.equal(one(page, '.empty p').textContent, S.tickets.none);
  });
});

// ------------------------------------------------------------- edit and delete

test('editing: the form opens with the ticket, sends the whole picture and goes back to the list', async () => {
  const me = makeApp(ANNA);
  const items = [ticket({ id: 1, at: at(-600), amountCents: 7500, reason: 'Speeding' })];
  await withClient({ now: NOW, routes: ticketRoutes(items, { 'PATCH /api/tickets/1': () => ({ ticket: {} }) }) }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me, 'edit=1'));
    assert.equal(one(page, 'h3').textContent, S.tickets.editTitle);
    // at(-600) is 00:00 UTC on the 15th, 02:00 in Amsterdam.
    assert.deepEqual([dateTime(whenRow(page)).date.value, dateTime(whenRow(page)).time.value], ['2026-06-15', '02:00']);
    assert.equal(control(amountRow(page)).value, '75,00');
    assert.equal(control(reasonRow(page)).value, 'Speeding');
    assert.equal(one(page, 'a.btn[href="#/tickets"]').textContent, S.cancel, 'there is a way out of editing');

    await typeInto(control(amountRow(page)), '80');
    await submitForm(page);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'PATCH /api/tickets/1');
    assert.deepEqual(sent.body, { at: at(-600), amountCents: 8000, reason: 'Speeding' });
    assert.deepEqual(me.toasts, [{ message: S.tickets.saved, isError: false }]);
    assert.deepEqual(me.navigated, ['#/tickets']);
  });
});

test('editing: the price is prefilled with a comma and no grouping, also the largest one, and saving again keeps it', async () => {
  const me = makeApp(ANNA);
  const items = [ticket({ id: 1, at: at(-600), amountCents: 1_000_000, reason: '' })];
  await withClient({ now: NOW, routes: ticketRoutes(items, { 'PATCH /api/tickets/1': () => ({ ticket: {} }) }) }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me, 'edit=1'));
    assert.equal(control(amountRow(page)).value, '10000,00', 'a field shows no grouping dot: it would not parse back');
    await submitForm(page);
    assert.equal(onlyWrite(api).body['amountCents'], 1_000_000);
  });
});

test('editing: emptying the price and the reason clears them (null and an empty string are sent)', async () => {
  const me = makeApp(ANNA);
  const items = [ticket({ id: 1, amountCents: 7500, reason: 'Speeding' })];
  await withClient({ now: NOW, routes: ticketRoutes(items, { 'PATCH /api/tickets/1': () => ({ ticket: {} }) }) }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me, 'edit=1'));
    await typeInto(control(amountRow(page)), '');
    await typeInto(control(reasonRow(page)), '');
    await submitForm(page);
    assert.deepEqual(onlyWrite(api).body, { at: at(-600), amountCents: null, reason: '' });
  });
});

test('editing: a ticket that cannot be edited, or does not exist, gives the blank form instead', async () => {
  const me = makeApp(ANNA);
  const items = [ticket({ id: 1, can: { edit: true, delete: true } }), ticket({ id: 2, amountCents: 5000, reason: 'Not mine', can: { edit: false, delete: false } })];
  await withClient({ now: NOW, routes: ticketRoutes(items) }, async ({ dom }) => {
    for (const edit of ['2', '99', 'abc', '0']) {
      const page = view(dom, await ticketsPage(me, `edit=${edit}`));
      assert.equal(one(page, 'h3').textContent, S.tickets.addTitle, `edit=${edit}`);
      assert.equal(control(amountRow(page)).value, '');
      assert.equal(control(reasonRow(page)).value, '');
      assert.equal(all(page, 'a.btn').filter((a) => a.textContent === S.cancel).length, 0);
    }
  });
});

test('deleting: it asks first, does nothing on "no", and on "yes" deletes, says so, reloads and puts focus on the heading', async () => {
  const me = makeApp(ANNA);
  const routes = ticketRoutes([ticket({ id: 1 })], { 'DELETE /api/tickets/1': () => new Reply(null, 204) });
  await withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const page = view(dom, await ticketsPage(me));
    const remove = byText(one(page, 'article#ticket-1'), 'button', S.delete);
    dom.answer = false;
    await remove.fire('click');
    assert.deepEqual(api.writes(), [], 'declining the question changes nothing');
    assert.deepEqual(me.toasts, []);

    dom.answer = true;
    await remove.fire('click');
    await until(() => me.toasts.length === 1, 'the delete to finish');
    assert.deepEqual(dom.confirms, [S.tickets.confirmDelete, S.tickets.confirmDelete]);
    const sent = onlyWrite(api);
    assert.equal(`${sent.method} ${sent.path}`, 'DELETE /api/tickets/1');
    assert.deepEqual(me.toasts, [{ message: S.tickets.deleted, isError: false }]);
    assert.equal(me.refreshes(), 1);
    await until(() => dom.focused()?.textContent === S.tickets.title, 'focus to return to the heading');
    assert.equal(remove.disabled, false, 'the buttons are usable again');
  });
});

test('deleting: a refusal is reported as an error and the list is reloaded anyway', async () => {
  const me = makeApp(ANNA);
  const routes = ticketRoutes([ticket({ id: 1 })], { 'DELETE /api/tickets/1': () => refuse(404, 'not_found') });
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = view(dom, await ticketsPage(me));
    await byText(page, 'button', S.delete).fire('click');
    await until(() => me.toasts.length === 1, 'the answer');
    assert.deepEqual(me.toasts, [{ message: S.errors.not_found, isError: true }]);
    assert.equal(me.refreshes(), 1, 'it may already be gone, so the list is reloaded');
  });
});

// ------------------------------------------------------ the Drives tab and shell

test('the Drives view has links to both Fuel and costs and Traffic tickets beside its title', async () => {
  const me = makeApp(ANNA);
  const routes: Routes = {
    'GET /api/usage': () => ({ items: [] }),
    'GET /api/usage/summary': () => ({ items: [], totalKm: 0 }),
    'GET /api/reservations': () => ({ items: [] }),
    'GET /api/usage/pending': () => ({ items: [], count: 0 }),
  };
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = view(dom, await renderUsage(me.app, { query: new URLSearchParams('') }));
    const head = one(page, '.view-head');
    assert.equal((head.children[0] as FakeElement).tagName, 'h2', 'the title comes first');
    const links = all(one(head, '.actions'), 'a.btn.small');
    assert.deepEqual(
      links.map((a) => [a.getAttribute('href'), a.textContent]),
      [
        ['#/fuel', S.usage.fuelLink],
        ['#/tickets', S.usage.ticketsLink],
      ],
    );
  });
});

test('the app shell: tickets is a view, sits under the Drives place, has its own page title, and is not a place of the bar', () => {
  const app = readSource('public/app.js');
  assert.match(app, /import \* as tickets from '\.\/views\/tickets\.js';/);
  assert.match(app, /const VIEWS = \{[^}]*\btickets\b[^}]*\};/);
  assert.equal(placeOf('tickets'), 'usage', 'the Drives place stays lit on both sub-views');
  assert.equal(placeOf('fuel'), 'usage');
  assert.equal(titleOf('tickets'), S.tickets.title);
  assert.equal(titleOf('fuel'), S.fuel.title);
  assert.ok(![...PRIMARY, ...SECONDARY].some((item) => item.name === 'tickets'), 'tickets is reached from Drives, not from the bar');
  assert.equal(S.tickets.title, S.usage.ticketsLink, 'the link and the page carry the same name');
});

test('the view is a sub-route that is not re-rendered in the background (it holds a form)', async () => {
  const mod = await import('../public/views/tickets.js');
  assert.equal(mod.live, false);
});

// ------------------------------------------------------------ the limits

test('the price parser: empty is no price, plain amounts are cents, everything else is refused with a code', () => {
  assert.deepEqual(readAmount(''), { ok: true, cents: null });
  assert.deepEqual(readAmount('   '), { ok: true, cents: null });
  assert.deepEqual(readAmount('12,50'), { ok: true, cents: 1250 });
  assert.deepEqual(readAmount('0,01'), { ok: true, cents: 1 });
  assert.deepEqual(readAmount('10000'), { ok: true, cents: MAX_AMOUNT_CENTS });
  assert.deepEqual(readAmount('0'), { ok: false, code: 'too_small' });
  assert.deepEqual(readAmount('10000,01'), { ok: false, code: 'too_large' });
  assert.deepEqual(readAmount('x'), { ok: false, code: 'invalid_amount' });
  assert.deepEqual(readAmount('1,2,3'), { ok: false, code: 'invalid_amount' });
});

test('the limits in the browser are the limits on the server', () => {
  assert.equal(MAX_AMOUNT_CENTS, SERVER_MAX_AMOUNT_CENTS);
  assert.equal(REASON_MAX, SERVER_REASON_MAX);
  // The codes the form itself can show (before anything is sent) each have a sentence.
  const fieldErrors = S.fieldErrors as Record<string, string>;
  for (const code of ['invalid_amount', 'too_small', 'too_large', 'invalid_datetime']) assert.ok(fieldErrors[code], `a sentence for ${code}`);
});

// ------------------------------------------------- retention texts (admin page)

test('retention texts include tickets, and counts an older stored result does not have default to 0', () => {
  const r = S.admin.retention;
  assert.equal(r.lastPurgeCounts(1, 2, 3, 4, 5, 6, 7, 8), '1 reserveringen, 2 ritten, 4 tankbeurten, 5 betaalverzoeken, 6 verkeersboetes, 7 kilometertoelichtingen, 8 gerepareerde schademeldingen, 3 verlopen sessies');
  assert.equal(r.lastPurgeCounts(1, 2, 3), '1 reserveringen, 2 ritten, 0 tankbeurten, 0 betaalverzoeken, 0 verkeersboetes, 0 kilometertoelichtingen, 0 gerepareerde schademeldingen, 3 verlopen sessies', 'a result stored before tankbeurten and verkeersboetes existed');
  assert.equal(r.lastPurgeCounts(1, 2, 3, 4, 5, 6), '1 reserveringen, 2 ritten, 4 tankbeurten, 5 betaalverzoeken, 6 verkeersboetes, 0 kilometertoelichtingen, 0 gerepareerde schademeldingen, 3 verlopen sessies', 'a result stored before the kilometre check existed');
  assert.equal(r.lastPurgeCounts(1, 2, 3, 4, 5, 6, 7), '1 reserveringen, 2 ritten, 4 tankbeurten, 5 betaalverzoeken, 6 verkeersboetes, 7 kilometertoelichtingen, 0 gerepareerde schademeldingen, 3 verlopen sessies', 'a result stored before the Car tab existed');
  assert.equal(r.countsText(1, 2, 3, 4, 5, 6, 7), '1 reserveringen, 2 ritten, 3 tankbeurten, 4 betaalverzoeken, 5 verkeersboetes, 6 kilometertoelichtingen, 7 schademeldingen (open en gerepareerd)');
  assert.equal(r.countsText(1, 2), '1 reserveringen, 2 ritten, 0 tankbeurten, 0 betaalverzoeken, 0 verkeersboetes, 0 kilometertoelichtingen, 0 schademeldingen (open en gerepareerd)');
  assert.equal(r.done(1, 2, 3, 4, 5, 6), 'Verwijderd: 1 reserveringen, 2 ritten, 3 tankbeurten, 4 verkeersboetes, 5 kilometertoelichtingen en 6 gerepareerde schademeldingen.');
  assert.equal(r.done(1, 2), 'Verwijderd: 1 reserveringen, 2 ritten, 0 tankbeurten, 0 verkeersboetes, 0 kilometertoelichtingen en 0 gerepareerde schademeldingen.');
  assert.match(r.cutoff, /schademelding pas als ze is gerepareerd/, 'the cutoff line says that open damage reports are not deleted');
  assert.match(r.damageNote, /Open schademeldingen worden nooit verwijderd/);
});

test('admin retention tab: tickets are counted, the oldest one counts for the oldest item, and a purge result stored before tickets existed still renders', async () => {
  const session = { user: ADMIN, timeZone: TZ, windowMonths: 6, serverTime: NOW };
  const base = {
    timeZone: TZ,
    windowMonths: 6,
    window: { from: at(-100_000), to: at(100_000) },
    cutoff: at(-100_000),
    lastPurgeAt: at(-60),
    lastMaintenanceDay: '2026-06-15',
    lastBackupAt: null,
    lastBackupFile: null,
    backupKeep: 14,
    backups: [],
  };
  // First what the previous release stored (no fill-up and ticket keys at all), then the new shape.
  let current: Json = {
    ...base,
    lastPurge: { cutoff: at(-100_000), reservations: 1, usage: 2, sessions: 3 },
    counts: { reservations: 4, usage: 5, sessions: 6 },
    oldest: { reservationEnd: at(-3000), usageEnd: null, fuelAt: null },
  };
  const routes: Routes = {
    'GET /api/auth/me': () => session,
    'GET /api/admin/users': () => ({ users: [ANNA, BEN, ADMIN] }),
    'GET /api/admin/retention': () => current,
    'POST /api/admin/retention/run': () => {
      current = {
        ...base,
        lastPurge: { cutoff: at(-100_000), reservations: 1, usage: 2, fuel: 3, fuelRequests: 0, tickets: 7, odometerExplained: 4, damageReports: 5, sessions: 3 },
        counts: { reservations: 4, usage: 5, fuel: 1, fuelRequests: 0, tickets: 2, odometerExplained: 6, damageReports: 3, sessions: 6 },
        oldest: { reservationEnd: at(-3000), usageEnd: null, fuelAt: null, ticketAt: at(-5000), damageRepairedOn: '2026-01-02' },
      };
      return { result: { cutoff: at(-100_000), reservations: 1, usage: 2, fuel: 3, fuelRequests: 0, tickets: 7, odometerExplained: 4, damageReports: 5, sessions: 3 }, status: current };
    },
  };
  await withClient({ now: NOW, routes }, async ({ dom }) => {
    const page = (id: string): FakeElement => {
      const el = (globalThis as Json)['document'].createElement('div') as FakeElement;
      el.id = id;
      return dom.mount(el);
    };
    const adminRoot = page('admin');
    const toastEl = page('toast');
    Object.defineProperty(globalThis, 'location', { value: { replace: () => undefined }, configurable: true, writable: true });
    await import('../public/admin/admin.js');
    await until(() => all(adminRoot, '.admin-tabs button').length === 4 && all(adminRoot, 'table').length > 0, 'the admin page to start');
    const dd = (label: string): string => {
      const dts = all(adminRoot, 'dt');
      const i = dts.findIndex((e) => e.textContent === label);
      assert.ok(i >= 0, `no "${label}" row`);
      return (all(adminRoot, 'dd')[i] as FakeElement).textContent;
    };

    await one(adminRoot, 'button[data-tab="retention"]').fire('click');
    await until(() => all(adminRoot, 'dt').length > 0, 'the retention tab');
    assert.ok(dd(S.admin.retention.lastPurge).endsWith('1 reserveringen, 2 ritten, 0 tankbeurten, 0 betaalverzoeken, 0 verkeersboetes, 0 kilometertoelichtingen, 0 gerepareerde schademeldingen, 3 verlopen sessies'), 'an old stored result shows zero verkeersboetes, explanations and schademeldingen');
    assert.equal(dd(S.admin.retention.counts), '4 reserveringen, 5 ritten, 0 tankbeurten, 0 betaalverzoeken, 0 verkeersboetes, 0 kilometertoelichtingen, 0 schademeldingen (open en gerepareerd)');
    assert.equal(dd(S.admin.retention.oldest), formatLocal(at(-3000), TZ));
    assert.equal(dd(S.admin.retention.oldestRepaired), '–', 'no repaired damage report yet (an old server answer has no such figure at all)');

    await byText(adminRoot, 'button', S.admin.retention.runNow).fire('click');
    await until(() => toastEl.textContent === S.admin.retention.done(1, 2, 3, 7, 4, 5), 'the purge to report its tickets, explanations and repaired damage reports');
    await until(() => all(adminRoot, 'dd').some((e) => e.textContent.endsWith('3 schademeldingen (open en gerepareerd)')), 'the tab to reload');
    assert.ok(dd(S.admin.retention.lastPurge).endsWith('3 tankbeurten, 0 betaalverzoeken, 7 verkeersboetes, 4 kilometertoelichtingen, 5 gerepareerde schademeldingen, 3 verlopen sessies'));
    assert.equal(dd(S.admin.retention.counts), '4 reserveringen, 5 ritten, 1 tankbeurten, 0 betaalverzoeken, 2 verkeersboetes, 6 kilometertoelichtingen, 3 schademeldingen (open en gerepareerd)');
    assert.equal(dd(S.admin.retention.oldest), formatLocal(at(-5000), TZ), 'the oldest ticket is the oldest item');
    assert.equal(dd(S.admin.retention.oldestRepaired), '2 jan 2026', 'the repaired date is a calendar day with its own row: it is not an instant and is not mixed into the oldest item');
  });
});
