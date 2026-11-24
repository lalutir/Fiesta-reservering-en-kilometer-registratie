// Every form of the app, rendered, and what its controls tell a phone: the right keyboard (numeric for an odometer,
// decimal for a price and for litres), the native date and time pickers, the right autocomplete, and a decimal that is
// written with a comma or a dot and sends the same number. The request bodies themselves are asserted by the view tests
// (forms, fuel, tickets, car, odometer): none of them changed with the redesign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/strings.js';
import { render as renderLogin } from '../public/views/login.js';
import { render as renderAccount } from '../public/views/account.js';
import { render as renderCar } from '../public/views/car.js';
import { parseDecimal, render as renderFuel } from '../public/views/fuel.js';
import { render as renderReserve } from '../public/views/reserve.js';
import { readAmount, render as renderTickets } from '../public/views/tickets.js';
import { render as renderUsage } from '../public/views/usage.js';
import { ANNA, NOW, Reply, all, at, byText, control, dateTime, fieldRow, makeApp, one, reservation, submitForm, typeInto, withClient, type FakeElement, type Routes } from './fake-dom.ts';

const attr = (el: FakeElement, name: string): string | null => el.getAttribute(name);
const q = (qs = '') => ({ query: new URLSearchParams(qs) });

const routes = (over: Routes = {}): Routes => ({
  'GET /api/usage': () => ({ items: [] }),
  'GET /api/usage/summary': () => ({ items: [], totalKm: 0 }),
  'GET /api/reservations': () => ({ items: [reservation({ start: at(-90), end: at(60) })] }),
  'GET /api/usage/pending': () => ({ items: [], count: 0 }),
  'GET /api/fuel': () => ({ items: [], balances: [] }),
  'POST /api/fuel': () => new Reply({ fuel: {} }, 201),
  'GET /api/tickets': () => ({ items: [] }),
  'GET /api/car/apk': () => ({ apk: { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null } }),
  'GET /api/damage': () => ({ items: [] }),
  'GET /api/push/key': () => ({ enabled: false }),
  ...over,
});

const isDateTime = (row: FakeElement) => {
  const { date, time } = dateTime(row);
  assert.equal(attr(date, 'type'), 'date', 'the native date picker');
  assert.equal(attr(time, 'type'), 'time', 'the native time picker');
};

test('the reservation form: native date and time pickers, a text note that is not autocompleted', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const form = dom.mount(await renderReserve(makeApp(ANNA).app, { arg: undefined }));
    isDateTime(fieldRow(form, S.reserve.start));
    isDateTime(fieldRow(form, S.reserve.end));
    assert.equal(attr(control(fieldRow(form, S.reserve.note)), 'autocomplete'), 'off');
  }));

test('the drive form: odometer fields are whole numbers on a numeric keypad, with date and time pickers', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const form = dom.mount(await renderUsage(makeApp(ANNA).app, q()));
    for (const label of [S.usage.odometerStart, S.usage.odometerEnd]) {
      const input = control(fieldRow(form, label));
      assert.deepEqual([attr(input, 'type'), attr(input, 'inputmode'), attr(input, 'step'), attr(input, 'min')], ['number', 'numeric', '1', '0'], label);
    }
    isDateTime(fieldRow(form, S.usage.start));
    isDateTime(fieldRow(form, S.usage.end));
  }));

test('the fill-up form: litres and price on a decimal keypad, the odometer on a numeric one, and a comma or a dot sends the same body', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom, api }) => {
    const send = async (litres: string, total: string) => {
      const form = dom.mount(await renderFuel(makeApp(ANNA).app, q()));
      for (const label of [S.fuel.litres, S.fuel.total, S.fuel.pricePerLitre]) {
        const input = control(fieldRow(form, label));
        assert.deepEqual([attr(input, 'type'), attr(input, 'inputmode')], ['text', 'decimal'], label);
      }
      const odo = control(fieldRow(form, S.fuel.odometer));
      assert.deepEqual([attr(odo, 'type'), attr(odo, 'inputmode')], ['number', 'numeric']);
      isDateTime(fieldRow(form, S.fuel.when));
      await typeInto(control(fieldRow(form, S.fuel.litres)), litres);
      await typeInto(control(fieldRow(form, S.fuel.total)), total);
      await typeInto(odo, '41200');
      await submitForm(form);
      dom.body.replaceChildren();
    };
    await send('40,5', '81,25');
    await send('40.5', '81.25');
    const [comma, dot] = api.writes();
    assert.deepEqual(comma?.body, dot?.body, 'the same request whichever separator was typed');
    assert.equal(comma?.body['millilitres'], 40500);
    assert.equal(comma?.body['totalCents'], 8125);
  }));

test('decimal parsing accepts a comma or a dot everywhere an amount is typed, and refuses what is not an amount', () => {
  assert.equal(parseDecimal('12,5', 2), 1250);
  assert.equal(parseDecimal('12.5', 2), 1250);
  assert.equal(parseDecimal('12', 2), 1200);
  assert.equal(parseDecimal('1.234,56', 2), null, 'a grouping dot is not a decimal: it is refused, not misread');
  assert.deepEqual(readAmount('75,50'), { ok: true, cents: 7550 });
  assert.deepEqual(readAmount('75.50'), { ok: true, cents: 7550 });
  assert.deepEqual(readAmount(''), { ok: true, cents: null });
  assert.equal(readAmount('abc').ok, false);
});

test('the ticket form: the price is decimal, the time has native pickers; the damage form: a native date, a list and a text area', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const me = makeApp(ANNA);
    const tickets = dom.mount(await renderTickets(me.app, q()));
    const amount = control(fieldRow(tickets, S.tickets.amount));
    assert.deepEqual([attr(amount, 'type'), attr(amount, 'inputmode')], ['text', 'decimal']);
    isDateTime(fieldRow(tickets, S.tickets.when));
    dom.body.replaceChildren();
    const car = dom.mount(await renderCar(me.app, q()));
    assert.equal(attr(control(fieldRow(car, S.car.noticedOn)), 'type'), 'date');
    assert.equal(attr(control(fieldRow(car, S.car.apk.label)), 'type'), 'date');
    assert.equal(control(fieldRow(car, S.car.where)).tagName, 'select');
    assert.equal(control(fieldRow(car, S.car.description)).tagName, 'textarea');
  }));

test('the sign-in and password forms tell the phone what they are for (so a password manager fills them) and never store a password', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const login = dom.mount(renderLogin({ onSuccess: () => {} }));
    const user = control(fieldRow(login, S.login.username));
    assert.deepEqual([attr(user, 'autocomplete'), attr(user, 'autocapitalize'), attr(user, 'spellcheck')], ['username', 'none', 'false']);
    const password = control(fieldRow(login, S.login.password));
    assert.deepEqual([attr(password, 'type'), attr(password, 'autocomplete')], ['password', 'current-password']);
    dom.body.replaceChildren();
    const account = dom.mount(await renderAccount(makeApp(ANNA).app));
    assert.equal(attr(control(fieldRow(account, S.account.currentPassword)), 'autocomplete'), 'current-password');
    const next = control(fieldRow(account, S.account.newPassword));
    assert.deepEqual([attr(next, 'type'), attr(next, 'autocomplete'), attr(next, 'minlength')], ['password', 'new-password', '10']);
    // Typing a password changes nothing in storage.
    await typeInto(next, 'een-geheim-wachtwoord');
    assert.equal(localStorage.length, 0);
    assert.ok(byText(account, 'button', S.account.signOut));
    assert.ok(all(account, 'input[type="password"]').length >= 2);
    assert.equal(one(account, '.seg[aria-pressed="true"]').textContent, 'Systeem');
  }));

test('the sign-in page is its own <main> landmark (there is no shell around it), with the app name as its one h1', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom }) => {
    const login = dom.mount(renderLogin({ onSuccess: () => {} }));
    assert.equal(login.tagName, 'main');
    assert.equal(all(login, 'h1').length, 1);
    assert.equal(one(login, 'h1').textContent, S.appName);
  }));
