// Every question that used to be window.confirm is a confirm sheet now (public/ui.js). What is tested here is what the
// sheet changes: the question is a <dialog> with the action's own name on the yes button, the safe answer has focus,
// "no" sends nothing, and above all that the buttons of the card are still disabled while the request runs, although
// the handler now waits for the sheet (a browser has already cleared event.currentTarget by then).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { S } from '../public/strings.js';
import { reservationCard } from '../public/views/agenda.js';
import { render as renderFuel } from '../public/views/fuel.js';
import { ANNA, NOW, Reply, all, at, byText, doc, makeApp, one, reservation, until, withClient, type FakeElement } from './fake-dom.ts';

const publicDir = path.join(import.meta.dirname, '..', 'public');

/** Let the handlers that were started with void (act: toast, reload, focus) run to their end before the test is over. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let card: FakeElement;
let page: FakeElement;
let disabledDuringRequest: boolean[] = [];

test('Cancel a reservation: the sheet names the action, no sends nothing, yes sends the delete with the buttons of the card disabled meanwhile', () =>
  withClient(
    {
      now: NOW,
      routes: {
        'DELETE /api/reservations/7': () => {
          disabledDuringRequest = all(card, 'button').map((b) => b.disabled);
          return new Reply(null, 204);
        },
      },
    },
    async ({ dom, api }) => {
      const me = makeApp(ANNA);
      card = dom.mount(reservationCard(me.app, reservation() as never, false));
      dom.autoAnswer = false;

      const cancel = byText(card, 'button', S.agenda.cancelReservation);
      const pressed = cancel.fire('click');
      const sheetEl = dom.dialogs[0] as FakeElement;
      assert.equal(sheetEl.querySelector('.sheet-message')?.textContent, S.agenda.confirmCancel);
      assert.equal(sheetEl.querySelector('[data-answer="yes"]')?.textContent, S.agenda.cancelReservation, 'the yes button is the action, not "OK"');
      assert.equal(doc().activeElement, sheetEl.querySelector('[data-answer="no"]'), 'the safe answer has focus');
      await sheetEl.querySelector('[data-answer="no"]')?.fire('click');
      await pressed;
      assert.deepEqual(api.writes(), [], 'no was no');
      assert.deepEqual(all(card, 'button').map((b) => b.disabled), all(card, 'button').map(() => false), 'nothing was left disabled');

      const again = byText(card, 'button', S.agenda.cancelReservation).fire('click');
      const second = dom.dialogs[1] as FakeElement;
      await second.querySelector('[data-answer="yes"]')?.fire('click');
      await again;
      await until(() => me.toasts.length > 0, 'the cancel to be reported');
      assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), ['DELETE /api/reservations/7']);
      assert.ok(disabledDuringRequest.length > 0 && disabledDuringRequest.every(Boolean), 'every button of the card was disabled while the request ran');
      assert.deepEqual(me.toasts, [{ message: S.agenda.cancelled, isError: false }]);
    },
  ));

test('Decline a suggestion: it asks, the yes button says Afwijzen, and Approve (which asks nothing) is one tap', () =>
  withClient({ now: NOW, routes: { 'POST /api/reservations/7/approve': () => ({}), 'POST /api/reservations/7/decline': () => ({}) } }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const suggestion = reservation({ status: 'pending', suggestion: true, createdBy: 2, createdByName: 'Ben', can: { edit: false, cancel: false, approve: true, decline: true } });
    const el = dom.mount(reservationCard(me.app, suggestion as never, false));
    await byText(el, 'button', S.agenda.approve).fire('click');
    assert.deepEqual(dom.confirms, [], 'approving asks nothing');
    await until(() => api.writes().length === 1, 'the approval');
    dom.answer = false;
    await byText(el, 'button', S.agenda.decline).fire('click');
    assert.deepEqual(dom.confirms, [S.agenda.confirmDecline]);
    assert.equal(api.writes().length, 1, 'no was no');
    dom.answer = true;
    await byText(el, 'button', S.agenda.decline).fire('click');
    assert.equal(dom.dialogs.at(-1)?.querySelector('[data-answer="yes"]')?.textContent, S.agenda.decline);
    await until(() => api.writes().length === 2, 'the decline');
    assert.deepEqual(api.writes().map((c) => c.path), ['/api/reservations/7/approve', '/api/reservations/7/decline']);
  }));

test('Withdraw a suggestion of mine: the sheet and its yes button use the words of withdrawing, not of cancelling', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/reservations/7': () => new Reply(null, 204) } }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const mine = reservation({ status: 'pending', suggestion: true, userId: 2, userName: 'Ben', createdBy: 1, createdByName: 'Anna', can: { edit: true, cancel: true, approve: false, decline: false } });
    const el = dom.mount(reservationCard(me.app, mine as never, false));
    await byText(el, 'button', S.agenda.withdraw).fire('click');
    assert.deepEqual(dom.confirms, [S.agenda.confirmWithdraw]);
    assert.equal(dom.dialogs.at(-1)?.querySelector('[data-answer="yes"]')?.textContent, S.agenda.withdraw);
    await until(() => api.writes().length === 1, 'the delete');
    assert.equal(one(el, '.what').textContent.length > 0, true);
  }));

test('nothing in the client (the member app and the admin page) calls window.confirm, alert or prompt any more', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const found = walk(publicDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /(?<![.\w])(?:confirm|alert|prompt)\(/.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
    .map((f) => path.relative(publicDir, f).replace(/\\/g, '/'));
  assert.deepEqual(found, [], 'a file is back on window.confirm, alert or prompt');
});

// ------------------------------------------------------------------ fuel

const fuelItem = (over: Record<string, unknown> = {}) => ({
  id: 5,
  userId: ANNA.id,
  userName: 'Anna',
  at: at(-1440),
  millilitres: 40000,
  totalCents: 8000,
  pricePerLitreMillis: 2000,
  note: '',
  period: { from: at(-20000), to: at(-1440) },
  totalKm: 200,
  equalSplit: false,
  firstInData: false,
  shares: [
    { userId: ANNA.id, userName: 'Anna', km: 100, cents: 4000, owes: false, request: null, can: { request: false, markPaid: false } },
    { userId: 2, userName: 'Ben', km: 100, cents: 4000, owes: true, request: { id: 1, amountCents: 4000, provider: 'manual', message: 'x', link: '', paidAt: at(-100), changed: false }, can: { request: true, markPaid: true } },
  ],
  hasPaidRequests: true,
  can: { edit: false, delete: true },
  ...over,
});

test('Fuel: deleting a fill-up and taking a paid mark off ask first, name the action, and keep the card\'s buttons disabled while the request runs', () => {
  let barDuring: boolean[] = [];
  return withClient(
    {
      now: NOW,
      routes: {
        'GET /api/fuel': () => ({ items: [fuelItem()], balances: [] }),
        'POST /api/fuel/5/requests/2/paid': () => {
          barDuring = all(one(page, 'li.share .actions'), 'button').map((b) => b.disabled);
          return { fuel: {} };
        },
        'DELETE /api/fuel/5': () => new Reply(null, 204),
      },
    },
    async ({ dom, api }) => {
      const me = makeApp(ANNA);
      page = dom.mount(await renderFuel(me.app, { query: new URLSearchParams('') }));
      dom.autoAnswer = false;

      const unpaid = byText(page, 'button', S.fuel.markUnpaid).fire('click');
      const first = dom.dialogs.at(-1) as FakeElement;
      assert.equal(first.querySelector('.sheet-message')?.textContent, S.fuel.confirmUnpaid);
      assert.equal(first.querySelector('[data-answer="yes"]')?.textContent, S.fuel.markUnpaid);
      await first.querySelector('[data-answer="no"]')?.fire('click');
      await unpaid;
      assert.deepEqual(api.writes(), [], 'no was no');

      const again = byText(page, 'button', S.fuel.markUnpaid).fire('click');
      await (dom.dialogs.at(-1) as FakeElement).querySelector('[data-answer="yes"]')?.fire('click');
      await again;
      await until(() => api.writes().length === 1, 'the request');
      await settle();
      assert.ok(barDuring.length > 0 && barDuring.every(Boolean), 'the buttons of that share were disabled while the request ran');
      assert.equal(api.writes()[0]?.path, '/api/fuel/5/requests/2/paid');

      const deleting = byText(page, 'button', S.delete).fire('click');
      const sheetEl = dom.dialogs.at(-1) as FakeElement;
      assert.equal(sheetEl.querySelector('.sheet-message')?.textContent, S.fuel.confirmDelete);
      assert.equal(sheetEl.querySelector('[data-answer="yes"]')?.textContent, S.delete);
      await sheetEl.querySelector('[data-answer="yes"]')?.fire('click');
      await deleting;
      await until(() => api.writes().length === 2, 'the delete');
      await settle();
      assert.equal(api.writes()[1]?.path, '/api/fuel/5');
    },
  );
});
