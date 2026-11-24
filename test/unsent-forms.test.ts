// Unsent input survives leaving a form (public/drafts.js, wired into the forms for new records): what was typed comes
// back when the person returns, a line says so and offers to start over, a save or a discard forgets it, another
// person on the same phone never sees it, an edit never uses it, and blocked storage changes nothing but the memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftKey } from '../public/drafts.js';
import { S } from '../public/strings.js';
import { render as renderCar } from '../public/views/car.js';
import { render as renderFuel } from '../public/views/fuel.js';
import { render as renderReserve } from '../public/views/reserve.js';
import { render as renderTickets } from '../public/views/tickets.js';
import { render as renderUsage } from '../public/views/usage.js';
import { ANNA, BEN, NOW, Reply, all, at, byText, control, dateTime, draft, fieldRow, makeApp, one, refuse, reservation, submitForm, typeInto, withClient, type FakeElement, type Routes } from './fake-dom.ts';

const routes = { 'POST /api/reservations': () => new Reply({ reservation: {} }, 201) };
const newReservation = (me = makeApp(ANNA)) => renderReserve(me.app, { arg: undefined });
const stored = (name: string, user = ANNA.id) => JSON.parse(localStorage.getItem(draftKey(user, name)) ?? 'null');

// ------------------------------------------------------------------ the reservation form

test('reservation form: what was typed comes back after leaving the form, with a line that says so', () =>
  withClient({ now: NOW, routes }, async ({ dom }) => {
    const first = dom.mount(await newReservation());
    assert.equal(all(first, '.restored').length, 0, 'a fresh form has nothing to say about restoring');
    await typeInto(control(fieldRow(first, S.reserve.note)), 'Naar de bouwmarkt');
    await typeInto(dateTime(fieldRow(first, S.reserve.start)).date, '2026-06-20');
    assert.deepEqual(Object.keys(stored('reservation').values).sort(), ['note', 'startDate'], 'only what was changed is kept');
    dom.body.replaceChildren();

    const again = dom.mount(await newReservation());
    assert.equal(control(fieldRow(again, S.reserve.note)).value, 'Naar de bouwmarkt');
    assert.equal(dateTime(fieldRow(again, S.reserve.start)).date.value, '2026-06-20');
    const line = one(again, '.restored');
    assert.equal(one(line, 'span').textContent, S.ui.unsaved);
    assert.equal(one(line, 'button').textContent, S.ui.unsavedClear);
  }));

test('reservation form: "Opnieuw beginnen" puts the starting values back, forgets the input and fixes the label that follows a field', () =>
  withClient({ now: NOW, routes }, async ({ dom }) => {
    const first = dom.mount(await newReservation());
    const who = control(fieldRow(first, S.reserve.driver));
    who.value = String(BEN.id);
    await who.fire('change');
    await typeInto(control(fieldRow(first, S.reserve.note)), 'Voor Ben');
    dom.body.replaceChildren();

    const page = dom.mount(await newReservation());
    assert.equal(one(page, 'button[type="submit"]').textContent, S.reserve.submitSuggestion, 'the restored choice of person is reflected in the button');
    await one(page, '.restored button').fire('click');
    assert.equal(all(page, '.restored').length, 0);
    assert.equal(control(fieldRow(page, S.reserve.note)).value, '');
    assert.equal(control(fieldRow(page, S.reserve.driver)).value, String(ANNA.id));
    assert.equal(one(page, 'button[type="submit"]').textContent, S.reserve.submit, 'the label follows the person again');
    assert.equal(localStorage.getItem(draftKey(ANNA.id, 'reservation')), null);
  }));

test('reservation form: a successful save forgets what was kept, a refused one keeps it', () => {
  let refuse = true;
  return withClient(
    { now: NOW, routes: { 'POST /api/reservations': () => (refuse ? new Reply({ error: { code: 'overlap', message: 'x', conflict: null } }, 409) : new Reply({ reservation: {} }, 201)) } },
    async ({ dom }) => {
      const me = makeApp(ANNA);
      const page = dom.mount(await newReservation(me));
      await typeInto(control(fieldRow(page, S.reserve.note)), 'Kruidenier');
      await submitForm(page);
      assert.ok(stored('reservation'), 'refused: still kept, the person is still on the form');
      refuse = false;
      await submitForm(page);
      assert.equal(localStorage.getItem(draftKey(ANNA.id, 'reservation')), null, 'saved: gone');
      assert.deepEqual(me.navigated, ['#/']);
    },
  );
});

test('reservation form: another person on the same phone sees a blank form, and an edit never uses the input of a new one', () =>
  withClient({ now: NOW, routes: { ...routes, 'GET /api/reservations/7': () => ({ reservation: reservation({ id: 7, userId: 2, userName: 'Ben', start: at(60), end: at(180), note: 'van de server' }) }) } }, async ({ dom }) => {
    const page = dom.mount(await newReservation());
    await typeInto(control(fieldRow(page, S.reserve.note)), 'privé');
    dom.body.replaceChildren();

    const ben = dom.mount(await newReservation(makeApp(BEN)));
    assert.equal(control(fieldRow(ben, S.reserve.note)).value, '');
    assert.equal(all(ben, '.restored').length, 0);
    dom.body.replaceChildren();

    const edit = await renderReserve(makeApp(ANNA).app, { arg: '7' });
    const editPage = dom.mount(edit);
    assert.equal(control(fieldRow(editPage, S.reserve.note)).value, 'van de server', 'an edit shows what the server has');
    assert.equal(all(editPage, '.restored').length, 0);
    await typeInto(control(fieldRow(editPage, S.reserve.note)), 'gewijzigd');
    assert.equal(stored('reservation').values.note, 'privé', 'typing in an edit does not touch the kept input of a new reservation');
  }));

test('reservation form: with storage blocked the form still works and nothing is kept', () =>
  withClient({ now: NOW, routes }, async ({ dom }) => {
    dom.storage.blocked = true;
    const me = makeApp(ANNA);
    const page = dom.mount(await newReservation(me));
    await typeInto(control(fieldRow(page, S.reserve.note)), 'toch opslaan');
    await submitForm(page);
    assert.deepEqual(me.navigated, ['#/'], 'the save went through');
    assert.equal(all(page, '.restored').length, 0);
  }));

test('reservation form: the kept input is per form: the note of the drive form is not the note of the reservation form', () =>
  withClient({ now: NOW, routes }, async ({ dom }) => {
    localStorage.setItem(draftKey(ANNA.id, 'drive'), JSON.stringify({ at: Date.now(), values: { note: 'rit' } }));
    const page = dom.mount(await newReservation());
    assert.equal(control(fieldRow(page, S.reserve.note)).value, '');
    assert.ok(byText(page, 'button', S.reserve.submit) as FakeElement);
  }));

// ------------------------------------------------------------------ the drive form

const driveRoutes = (over: Routes = {}): Routes => ({
  'GET /api/usage': () => ({ items: [] }),
  'GET /api/usage/summary': () => ({ items: [], totalKm: 0 }),
  'GET /api/reservations': () => ({ items: [reservation({ start: at(-90), end: at(60) })] }),
  'GET /api/usage/pending': () => ({ items: [], count: 0 }),
  'POST /api/usage': () => new Reply({ usage: {} }, 201),
  ...over,
});
const driveForm = (me = makeApp(ANNA), query = '') => renderUsage(me.app, { query: new URLSearchParams(query) });

test('drive form: the readings and the note typed into a blank form come back, and a save forgets them', () =>
  withClient({ now: NOW, routes: driveRoutes() }, async ({ dom }) => {
    const me = makeApp(ANNA);
    const first = dom.mount(await driveForm(me));
    await typeInto(control(fieldRow(first, S.usage.odometerStart)), '41000');
    await typeInto(control(fieldRow(first, S.usage.odometerEnd)), '41042');
    await typeInto(control(fieldRow(first, S.usage.note)), 'Naar de tuin');
    await typeInto(dateTime(fieldRow(first, S.usage.start)).time, '11:00');
    await typeInto(dateTime(fieldRow(first, S.usage.end)).date, '2026-06-15');
    await typeInto(dateTime(fieldRow(first, S.usage.end)).time, '11:40');
    assert.deepEqual(Object.keys(stored('drive').values).sort(), ['endDate', 'endTime', 'note', 'odometerEnd', 'odometerStart', 'startTime']);
    dom.body.replaceChildren();

    const again = dom.mount(await driveForm(me));
    assert.equal(control(fieldRow(again, S.usage.odometerStart)).value, '41000');
    assert.equal(control(fieldRow(again, S.usage.odometerEnd)).value, '41042');
    assert.equal(control(fieldRow(again, S.usage.note)).value, 'Naar de tuin');
    assert.equal(one(again, 'button[type="submit"]').textContent, S.usage.submit, 'the button follows the restored end reading');
    assert.equal(one(again, '.restored span').textContent, S.ui.unsaved);

    await submitForm(again);
    assert.equal(localStorage.getItem(draftKey(ANNA.id, 'drive')), null, 'saved: gone');
  }));

test('drive form: a form that arrives with a link (a reservation card, a gap) or that edits something never uses kept input', () =>
  withClient({ now: NOW, routes: driveRoutes({ 'GET /api/usage': () => ({ items: [draft()] }) }) }, async ({ dom }) => {
    localStorage.setItem(draftKey(ANNA.id, 'drive'), JSON.stringify({ at: Date.now(), values: { note: 'oud', odometerStart: '1' } }));
    const preset = dom.mount(await driveForm(makeApp(ANNA), 'res=7'));
    assert.equal(all(preset, '.restored').length, 0, 'a link says what to fill in');
    assert.notEqual(control(fieldRow(preset, S.usage.odometerStart)).value, '1');
    dom.body.replaceChildren();
    // Anna has an open drive: the form is for finishing it, and shows what the server has.
    const finishing = dom.mount(await driveForm(makeApp(ANNA)));
    assert.equal(all(finishing, '.restored').length, 0);
    assert.equal(control(fieldRow(finishing, S.usage.note)).value, 'Groceries');
    assert.ok(localStorage.getItem(draftKey(ANNA.id, 'drive')), 'what was kept for a new drive is still there for the next one');
  }));

test('drive form: another person on the same phone sees none of it, and typing a start time later does not overwrite a restored reading', () =>
  withClient({ now: NOW, routes: driveRoutes() }, async ({ dom }) => {
    localStorage.setItem(draftKey(ANNA.id, 'drive'), JSON.stringify({ at: Date.now(), values: { odometerStart: '5000' } }));
    const ben = dom.mount(await driveForm(makeApp(BEN)));
    assert.notEqual(control(fieldRow(ben, S.usage.odometerStart)).value, '5000');
    dom.body.replaceChildren();
    const anna = dom.mount(await driveForm(makeApp(ANNA)));
    const odo = control(fieldRow(anna, S.usage.odometerStart));
    assert.equal(odo.value, '5000');
    await typeInto(dateTime(fieldRow(anna, S.usage.start)).time, '08:00');
    assert.equal(odo.value, '5000', 'a reading the person typed is theirs, a changed start time leaves it alone');
  }));

// ------------------------------------------------------------------ the fill-up form

test('fill-up form: litres, price and the reading come back, the worked-out line follows them, and an edit never uses them', () =>
  withClient({ now: NOW, routes: { 'GET /api/fuel': () => ({ items: [], balances: [] }), 'POST /api/fuel': () => new Reply({ fuel: {} }, 201) } }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const first = dom.mount(await renderFuel(me.app, { query: new URLSearchParams('') }));
    await typeInto(control(fieldRow(first, S.fuel.litres)), '40,5');
    await typeInto(control(fieldRow(first, S.fuel.total)), '81');
    await typeInto(control(fieldRow(first, S.fuel.odometer)), '41200');
    assert.deepEqual(Object.keys(stored('fuel').values).sort(), ['litres', 'odometer', 'total']);
    dom.body.replaceChildren();

    const again = dom.mount(await renderFuel(me.app, { query: new URLSearchParams('') }));
    assert.equal(control(fieldRow(again, S.fuel.litres)).value, '40,5');
    assert.equal(control(fieldRow(again, S.fuel.total)).value, '81');
    assert.equal(control(fieldRow(again, S.fuel.odometer)).value, '41200');
    assert.equal(one(again, 'p.hint[aria-live="polite"]').textContent.length > 0, true, 'the worked-out price per litre is shown for the restored numbers');
    assert.equal(one(again, '.restored span').textContent, S.ui.unsaved);

    await submitForm(again);
    assert.equal(api.writes().length, 1);
    assert.equal(localStorage.getItem(draftKey(ANNA.id, 'fuel')), null, 'saved: gone');
  }));

// ------------------------------------------------------------------ the ticket and damage forms

test('ticket form: the time, the price and the reason come back; a report of damage keeps what was typed too; an edit uses neither', () =>
  withClient(
    {
      now: NOW,
      routes: {
        'GET /api/tickets': () => ({ items: [] }),
        'GET /api/car/apk': () => ({ apk: { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null } }),
        'GET /api/damage': () => ({ items: [] }),
        'POST /api/tickets': () => new Reply({ ticket: {} }, 201),
      },
    },
    async ({ dom, api }) => {
      const me = makeApp(ANNA);
      const first = dom.mount(await renderTickets(me.app, { query: new URLSearchParams('') }));
      await typeInto(control(fieldRow(first, S.tickets.amount)), '75,50');
      await typeInto(control(fieldRow(first, S.tickets.reason)), 'Te hard op de A2');
      dom.body.replaceChildren();
      const again = dom.mount(await renderTickets(me.app, { query: new URLSearchParams('') }));
      assert.equal(control(fieldRow(again, S.tickets.amount)).value, '75,50');
      assert.equal(control(fieldRow(again, S.tickets.reason)).value, 'Te hard op de A2');
      assert.equal(one(again, '.restored span').textContent, S.ui.unsaved);
      await submitForm(again);
      assert.equal(api.writes().length, 1);
      assert.equal(localStorage.getItem(draftKey(ANNA.id, 'ticket')), null, 'saved: gone');

      // The damage form on the Car page.
      const car = dom.mount(await renderCar(me.app, { query: new URLSearchParams('') }));
      await typeInto(control(fieldRow(car, S.car.description)), 'Kras op de bumper');
      dom.body.replaceChildren();
      const carAgain = dom.mount(await renderCar(me.app, { query: new URLSearchParams('') }));
      assert.equal(control(fieldRow(carAgain, S.car.description)).value, 'Kras op de bumper');
      assert.equal(one(carAgain, '.restored span').textContent, S.ui.unsaved);
      assert.deepEqual(Object.keys(stored('damage').values), ['description'], 'only what was changed');
    },
  ));

// ------------------------------------------------------------------ a refused save, a correction and blocked storage, on the other forms

/** The form that holds a field, found from the field's label: a page also has other forms (the APK date, the cards). */
function formOfField(page: unknown, label: string): FakeElement {
  let node: FakeElement | null = fieldRow(page, label);
  while (node && node.tagName !== 'form') node = node.parent;
  assert.ok(node, `the field "${label}" is inside a form`);
  return node;
}
const keep = (name: string, values: Record<string, string>, user = ANNA.id): void =>
  localStorage.setItem(draftKey(user, name), JSON.stringify({ at: Date.now(), values }));

const fuelItem = (over: Record<string, unknown> = {}) => ({
  id: 5,
  userId: ANNA.id,
  userName: 'Anna',
  at: at(-1440),
  millilitres: 40000,
  totalCents: 8000,
  pricePerLitreMillis: 2000,
  odometer: 41000,
  note: 'Shell',
  period: { from: at(-20000), to: at(-1440) },
  totalKm: 0,
  equalSplit: false,
  firstInData: false,
  shares: [],
  hasPaidRequests: false,
  can: { edit: true, delete: true },
  ...over,
});
const ticketItem = (over: Record<string, unknown> = {}) => ({
  id: 1,
  at: at(-600),
  amountCents: 12050,
  reason: 'Van de server',
  createdBy: ANNA.id,
  createdByName: 'Anna',
  createdAt: at(-5),
  updatedAt: at(-5),
  driver: { id: BEN.id, name: 'Ben' },
  basis: 'drive',
  can: { edit: true, delete: true },
  ...over,
});
const damageItem = (over: Record<string, unknown> = {}) => ({
  id: 1,
  noticedOn: '2026-06-10',
  noticedBy: { id: ANNA.id, name: 'Anna' },
  reportedBy: { id: ANNA.id, name: 'Anna' },
  description: 'Van de server',
  location: 'rear',
  status: 'open',
  repairedOn: null,
  repairNote: '',
  createdAt: at(-5),
  updatedAt: at(-5),
  hint: { driver: null, basis: 'none' },
  can: { edit: true, delete: true, repair: true },
  ...over,
});
const apkNone = { apk: { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null } };
const noQuery = () => ({ query: new URLSearchParams('') });

test("fill-up form: a refused save keeps what was typed, a saved one forgets it, and a correction shows the server's numbers, never the kept input", () => {
  let failing = true;
  const routes: Routes = {
    'GET /api/fuel': () => ({ items: [fuelItem()], balances: [] }),
    'POST /api/fuel': () => (failing ? refuse(500, 'internal') : new Reply({ fuel: {} }, 201)),
  };
  return withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const page = dom.mount(await renderFuel(me.app, noQuery()));
    await typeInto(control(fieldRow(page, S.fuel.litres)), '40,5');
    await typeInto(control(fieldRow(page, S.fuel.total)), '81');
    await typeInto(control(fieldRow(page, S.fuel.odometer)), '41200');
    await formOfField(page, S.fuel.litres).fire('submit');
    assert.equal(api.writes().length, 1, 'the save was sent');
    assert.deepEqual(me.navigated, [], 'refused: the person is still on the form');
    assert.deepEqual(Object.keys(stored('fuel').values).sort(), ['litres', 'odometer', 'total'], 'refused: what was typed is still kept');
    failing = false;
    await formOfField(page, S.fuel.litres).fire('submit');
    assert.equal(localStorage.getItem(draftKey(ANNA.id, 'fuel')), null, 'saved: gone');
    assert.deepEqual(me.navigated, ['#/fuel']);
    dom.body.replaceChildren();

    // A correction of fill-up 5 shows what the server has, even while an older new fill-up is kept on the device.
    keep('fuel', { litres: '99', odometer: '1' });
    const edit = dom.mount(await renderFuel(makeApp(ANNA).app, { query: new URLSearchParams('edit=5') }));
    assert.equal(all(edit, '.restored').length, 0, 'a correction never offers kept input');
    assert.notEqual(control(fieldRow(edit, S.fuel.litres)).value, '99');
    assert.equal(control(fieldRow(edit, S.fuel.odometer)).value, '41000');
    await typeInto(control(fieldRow(edit, S.fuel.litres)), '41');
    assert.equal(stored('fuel').values.litres, '99', 'typing in a correction does not touch what is kept for a new fill-up');
  });
});

test("ticket form: a refused save keeps what was typed, a saved one forgets it, and a correction shows the server's ticket, never the kept input", () => {
  let failing = true;
  const routes: Routes = {
    'GET /api/tickets': () => ({ items: [ticketItem()] }),
    'POST /api/tickets': () => (failing ? refuse(500, 'internal') : new Reply({ ticket: {} }, 201)),
  };
  return withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const page = dom.mount(await renderTickets(me.app, noQuery()));
    await typeInto(control(fieldRow(page, S.tickets.amount)), '75,50');
    await typeInto(control(fieldRow(page, S.tickets.reason)), 'Te hard op de A2');
    await formOfField(page, S.tickets.amount).fire('submit');
    assert.equal(api.writes().length, 1, 'the save was sent');
    assert.deepEqual(Object.keys(stored('ticket').values).sort(), ['amount', 'reason'], 'refused: what was typed is still kept');
    failing = false;
    await formOfField(page, S.tickets.amount).fire('submit');
    assert.equal(localStorage.getItem(draftKey(ANNA.id, 'ticket')), null, 'saved: gone');
    dom.body.replaceChildren();

    keep('ticket', { amount: '5,00', reason: 'oud' });
    const edit = dom.mount(await renderTickets(makeApp(ANNA).app, { query: new URLSearchParams('edit=1') }));
    assert.equal(all(edit, '.restored').length, 0, 'a correction never offers kept input');
    assert.equal(control(fieldRow(edit, S.tickets.reason)).value, 'Van de server');
    assert.equal(control(fieldRow(edit, S.tickets.amount)).value, '120,50');
    await typeInto(control(fieldRow(edit, S.tickets.reason)), 'anders');
    assert.equal(stored('ticket').values.reason, 'oud', 'typing in a correction does not touch what is kept for a new ticket');
  });
});

test("damage form: a refused save keeps what was typed, a saved one forgets it, and a correction shows the server's report, never the kept input", () => {
  let failing = true;
  const routes: Routes = {
    'GET /api/car/apk': () => apkNone,
    'GET /api/damage': () => ({ items: [damageItem()] }),
    'POST /api/damage': () => (failing ? refuse(500, 'internal') : new Reply({ report: {} }, 201)),
  };
  return withClient({ now: NOW, routes }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const page = dom.mount(await renderCar(me.app, noQuery()));
    const where = control(fieldRow(page, S.car.where));
    where.value = 'front';
    await where.fire('change');
    await typeInto(control(fieldRow(page, S.car.description)), 'Kras op de bumper');
    assert.deepEqual(Object.keys(stored('damage').values).sort(), ['description', 'location']);
    await formOfField(page, S.car.description).fire('submit');
    assert.equal(api.writes().length, 1, 'the save was sent');
    assert.ok(stored('damage'), 'refused: what was typed is still kept');
    failing = false;
    await formOfField(page, S.car.description).fire('submit');
    assert.equal(api.writes().length, 2);
    assert.equal(localStorage.getItem(draftKey(ANNA.id, 'damage')), null, 'saved: gone');
    dom.body.replaceChildren();

    keep('damage', { description: 'oud', location: 'roof' });
    const edit = dom.mount(await renderCar(makeApp(ANNA).app, { query: new URLSearchParams('edit=1') }));
    assert.equal(all(edit, '.restored').length, 0, 'a correction never offers kept input');
    assert.equal(control(fieldRow(edit, S.car.description)).value, 'Van de server');
    assert.equal(control(fieldRow(edit, S.car.where)).value, 'rear');
    await typeInto(control(fieldRow(edit, S.car.description)), 'anders');
    assert.equal(stored('damage').values.description, 'oud', 'typing in a correction does not touch what is kept for a new report');
  });
});

test('drive form: a refused save keeps the readings and the note, so nothing typed is lost to an overlap or a lost connection', () => {
  let failing = true;
  return withClient(
    { now: NOW, routes: driveRoutes({ 'POST /api/usage': () => (failing ? refuse(409, 'overlap', { conflict: null }) : new Reply({ usage: {} }, 201)) }) },
    async ({ dom, api }) => {
      const me = makeApp(ANNA);
      const page = dom.mount(await driveForm(me));
      await typeInto(control(fieldRow(page, S.usage.odometerStart)), '41000');
      await typeInto(control(fieldRow(page, S.usage.odometerEnd)), '41042');
      await typeInto(control(fieldRow(page, S.usage.note)), 'Naar de tuin');
      await typeInto(dateTime(fieldRow(page, S.usage.start)).time, '11:00');
      await typeInto(dateTime(fieldRow(page, S.usage.end)).date, '2026-06-15');
      await typeInto(dateTime(fieldRow(page, S.usage.end)).time, '11:40');
      await submitForm(page);
      assert.equal(api.writes().length, 1, 'the save was sent');
      assert.equal(stored('drive').values.odometerEnd, '41042', 'refused: still kept');
      assert.equal(stored('drive').values.note, 'Naar de tuin');
      failing = false;
      await submitForm(page);
      assert.equal(api.writes().length, 2);
      assert.equal(localStorage.getItem(draftKey(ANNA.id, 'drive')), null, 'saved: gone');
    },
  );
});

test('with storage blocked the fill-up, ticket and damage forms still save, and none of them shows a restored line', () =>
  withClient(
    {
      now: NOW,
      routes: {
        'GET /api/fuel': () => ({ items: [], balances: [] }),
        'POST /api/fuel': () => new Reply({ fuel: {} }, 201),
        'GET /api/tickets': () => ({ items: [] }),
        'POST /api/tickets': () => new Reply({ ticket: {} }, 201),
        'GET /api/car/apk': () => apkNone,
        'GET /api/damage': () => ({ items: [] }),
        'POST /api/damage': () => new Reply({ report: {} }, 201),
      },
    },
    async ({ dom, api }) => {
      dom.storage.blocked = true;
      const me = makeApp(ANNA);

      const fuel = dom.mount(await renderFuel(me.app, noQuery()));
      await typeInto(control(fieldRow(fuel, S.fuel.litres)), '40,5');
      await typeInto(control(fieldRow(fuel, S.fuel.total)), '81');
      await typeInto(control(fieldRow(fuel, S.fuel.odometer)), '41200');
      assert.equal(all(fuel, '.restored').length, 0);
      await formOfField(fuel, S.fuel.litres).fire('submit');
      dom.body.replaceChildren();

      const tickets = dom.mount(await renderTickets(me.app, noQuery()));
      await typeInto(control(fieldRow(tickets, S.tickets.amount)), '75,50');
      assert.equal(all(tickets, '.restored').length, 0);
      await formOfField(tickets, S.tickets.amount).fire('submit');
      dom.body.replaceChildren();

      const car = dom.mount(await renderCar(me.app, noQuery()));
      control(fieldRow(car, S.car.where)).value = 'rear';
      await typeInto(control(fieldRow(car, S.car.description)), 'Kras');
      assert.equal(all(car, '.restored').length, 0);
      await formOfField(car, S.car.description).fire('submit');

      assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), ['POST /api/fuel', 'POST /api/tickets', 'POST /api/damage']);
    },
  ));
