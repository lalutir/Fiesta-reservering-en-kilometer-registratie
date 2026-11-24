// Start (public/views/home.js): the pure rules behind each block (who has the car, my next reservation, what I owe,
// damage) and the screen itself against a stubbed API: every block with data, with nothing to say, and failing alone
// with its own retry, for a member and for an admin. It asks the server for nothing that no other screen asks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEuro } from '../public/dom.js';
import { S } from '../public/strings.js';
import { NEW_DAMAGE_MS, carNow, damageSummary, myNext, owedSummary, render as renderHome } from '../public/views/home.js';
import { ADMIN, ANNA, BEN, NOW, all, at, draft, makeApp, one, refuse, reservation, until, usage, withClient, type Call, type FakeDom, type FakeElement, type Routes } from './fake-dom.ts';
import type { Json } from './helpers.ts';

const slot = (page: unknown, id: string): FakeElement => one(page, `[data-block="${id}"]`);
const texts = (el: FakeElement, selector: string): string[] => all(el, selector).map((e) => e.textContent);

const apk = (expiresOn: string | null): Json => ({ apk: expiresOn ? { expiresOn, daysLeft: 120, updatedBy: { id: 2, name: 'Ben' }, updatedAt: at(-2000) } : { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null } });
const report = (over: Json = {}): Json => ({
  id: 1,
  noticedOn: '2026-06-10',
  noticedBy: { id: 1, name: 'Anna' },
  reportedBy: { id: 1, name: 'Anna' },
  description: 'Kras',
  location: 'rear',
  status: 'open',
  repairedOn: null,
  repairNote: '',
  createdAt: at(-5),
  hint: { driver: null, basis: 'none' },
  can: { edit: true, delete: true, repair: true },
  ...over,
});
/** Ben filled up; Anna's share is 25.00, asked for and not paid yet. */
const fuelItem = (over: Json = {}): Json => ({
  id: 5,
  userId: 2,
  userName: 'Ben',
  at: at(-3000),
  totalCents: 7500,
  shares: [{ userId: 1, userName: 'Anna', km: 100, cents: 2500, owes: true, settledBy: null, carriedCents: 0, dueCents: 2500, request: { id: 1, amountCents: 2500, provider: 'manual', message: '', link: '', paidAt: null, changed: false }, can: { request: false, markPaid: false, selfPaid: true } }],
  ...over,
});

/** The seven answers Start asks for, all with something in them. */
const full = (over: Routes = {}): Routes => ({
  'GET /api/reservations': () => ({ items: [reservation({ id: 7, start: at(-30), end: at(120), userId: 2, userName: 'Ben', createdBy: 2, createdByName: 'Ben' }), reservation({ id: 8, start: at(1500), end: at(1600) })] }),
  'GET /api/usage': () => ({ items: [draft({ id: 9, userId: 2, userName: 'Ben', start: at(-30) })] }),
  'GET /api/usage/pending': () => ({ count: 0, items: [] }),
  'GET /api/inbox': () => ({ incoming: [], outgoing: [], incomingCount: 2 }),
  'GET /api/fuel': () => ({ items: [fuelItem()], balances: [{ fromUserId: 1, fromName: 'Anna', toUserId: 2, toName: 'Ben', cents: 2500 }, { fromUserId: 2, fromName: 'Ben', toUserId: 1, toName: 'Anna', cents: 400 }] }),
  'GET /api/car/apk': () => apk('2026-12-01'),
  'GET /api/damage': () => ({ items: [report({ id: 1 }), report({ id: 2, createdAt: at(-60 * 24 * 30) })] }),
  ...over,
});
/** Nothing at all: a free car, nothing waiting, nothing owed, no APK date, no damage. */
const empty = (over: Routes = {}): Routes => ({
  'GET /api/reservations': () => ({ items: [] }),
  'GET /api/usage': () => ({ items: [] }),
  'GET /api/usage/pending': () => ({ count: 0, items: [] }),
  'GET /api/inbox': () => ({ incoming: [], outgoing: [], incomingCount: 0 }),
  'GET /api/fuel': () => ({ items: [], balances: [] }),
  'GET /api/car/apk': () => apk(null),
  'GET /api/damage': () => ({ items: [] }),
  ...over,
});

const mount = async (dom: FakeDom, me = makeApp(ANNA)) => dom.mount(await renderHome(me.app));

// ------------------------------------------------------------------ the rules

test('carNow: an open drive means the car is on the road, a current reservation means it is reserved, otherwise it is free; the next reservation is named', () => {
  const confirmed = [reservation({ id: 1, start: at(-30), end: at(60) }), reservation({ id: 2, start: at(600), end: at(700), userId: 2, userName: 'Ben' }), reservation({ id: 3, status: 'pending', start: at(100), end: at(200) })] as never[];
  const road = carNow(confirmed, [draft({ id: 9 })] as never[], NOW);
  assert.equal(road.state, 'driving');
  assert.equal(road.driving?.id, 9);
  assert.equal(road.next?.id, 2, 'a pending suggestion is nobody\'s next');
  assert.equal(carNow(confirmed, [usage()] as never[], NOW).state, 'reserved', 'a finished drive is not "on the road"');
  assert.equal(carNow(confirmed, [], NOW).current?.id, 1);
  const free = carNow([reservation({ id: 2, start: at(600), end: at(700) })] as never[], [], NOW);
  assert.deepEqual([free.state, free.current, free.next?.id], ['free', null, 2]);
  assert.deepEqual(carNow([], [], NOW), { state: 'free', driving: null, current: null, next: null });
  // Two open drives (it cannot happen, but a stale one must not hide the newer): the latest start wins.
  assert.equal(carNow([], [draft({ id: 1, start: at(-300) }), draft({ id: 2, start: at(-10) })] as never[], NOW).driving?.id, 2);
  // A reservation that ends exactly now is over, one that starts exactly now has begun.
  assert.equal(carNow([reservation({ start: at(-60), end: at(0) })] as never[], [], NOW).state, 'free');
  assert.equal(carNow([reservation({ start: at(0), end: at(60) })] as never[], [], NOW).state, 'reserved');
});

test('myNext: my first confirmed reservation that has not ended, the one going on now included; never pending or someone else\'s', () => {
  const list = [
    reservation({ id: 1, userId: 2, start: at(10), end: at(20) }),
    reservation({ id: 2, status: 'pending', start: at(5), end: at(6) }),
    reservation({ id: 3, start: at(500), end: at(600) }),
    reservation({ id: 4, start: at(-30), end: at(-10) }),
    reservation({ id: 5, start: at(-10), end: at(30) }),
  ] as never[];
  assert.equal(myNext(list, ANNA.id, NOW)?.id, 5);
  assert.equal(myNext(list, BEN.id, NOW)?.id, 1);
  assert.equal(myNext([], ANNA.id, NOW), null);
});

test('owedSummary: what I pay and what I get from the server\'s balances, and how many asked-for requests wait for me', () => {
  const balances = [
    { fromUserId: 1, fromName: 'Anna', toUserId: 2, toName: 'Ben', cents: 2500 },
    { fromUserId: 1, fromName: 'Anna', toUserId: 4, toName: 'Cor', cents: 100 },
    { fromUserId: 3, fromName: 'Root', toUserId: 1, toName: 'Anna', cents: 800 },
    { fromUserId: 2, fromName: 'Ben', toUserId: 4, toName: 'Cor', cents: 900 },
  ] as never[];
  const sum = owedSummary(balances, [fuelItem(), fuelItem({ id: 6, shares: [{ ...fuelItem().shares[0], request: null }] })] as never[], ANNA.id);
  assert.deepEqual(sum.owe, [{ name: 'Ben', cents: 2500 }, { name: 'Cor', cents: 100 }]);
  assert.deepEqual(sum.get, [{ name: 'Root', cents: 800 }]);
  assert.deepEqual([sum.oweTotal, sum.getTotal], [2600, 800]);
  assert.equal(sum.open, 1, 'only the share that was asked for counts: the other has no request yet');
  assert.deepEqual(owedSummary([], [], ANNA.id), { owe: [], get: [], oweTotal: 0, getTotal: 0, open: 0 });
});

test('damageSummary: the open reports, the newest one, and "new" only inside a week', () => {
  const reports = [report({ id: 1, createdAt: at(-100) }), report({ id: 2, createdAt: at(-10) }), report({ id: 3, status: 'repaired', createdAt: at(-1) })] as never[];
  const sum = damageSummary(reports, NOW);
  assert.deepEqual([sum.open, sum.newest?.id, sum.fresh], [2, 2, true]);
  const old = damageSummary([report({ createdAt: new Date(Date.parse(NOW) - NEW_DAMAGE_MS - 1000).toISOString() })] as never[], NOW);
  assert.equal(old.fresh, false);
  assert.deepEqual(damageSummary([report({ status: 'repaired' })] as never[], NOW), { open: 0, newest: null, fresh: false });
});

// ------------------------------------------------------------------ the screen

test('Start with everything to say: who is on the road, the answers, my reservation, what I owe, the APK and the damage, in that order', () =>
  withClient({ now: NOW, routes: full() }, async ({ dom, api }) => {
    const page = await mount(dom);
    assert.equal(one(page, 'h2').textContent, 'Start');
    assert.deepEqual(all(page, '[data-block]').map((s) => s.getAttribute('data-block')), ['car', 'answers', 'km', 'mine', 'money', 'apk', 'damage', 'quick']);

    const car = slot(page, 'car');
    assert.ok(one(car, '.car-now').classList.contains('out'), 'the signal colour: the car is out');
    assert.equal(one(car, '.big').textContent, S.home.driving('Ben'));
    assert.equal(texts(car, '.sub')[0], S.home.since(one(car, '.sub').textContent.replace(/^Sinds /, '')));
    assert.match(texts(car, '.sub')[1] ?? '', /^Daarna: Jij, /, 'the next reservation is mine');

    assert.equal(one(slot(page, 'answers'), '.big').textContent, S.home.answersWaiting(2));
    assert.equal(one(slot(page, 'answers'), 'a').getAttribute('href'), '#/inbox');

    assert.equal(slot(page, 'km').children.length, 0, 'nothing to register: the block is not there');

    const mine = slot(page, 'mine');
    assert.equal(one(mine, 'h3').textContent, S.home.mine);
    assert.ok(one(mine, 'article.card.reservation'), 'the same card as on the Agenda');

    const money = slot(page, 'money');
    assert.deepEqual(texts(money, 'h4'), [S.home.youPay, S.home.youGet]);
    assert.deepEqual(texts(money, 'li'), [`${S.home.to('Ben')}${formatEuro(2500)}`, `${S.home.from('Ben')}${formatEuro(400)}`]);
    assert.equal(one(money, '.km-line').textContent, S.home.openRequests(1));
    assert.equal(one(money, 'a').getAttribute('href'), '#/history');

    const apkBlock = slot(page, 'apk');
    assert.equal(one(apkBlock, '.badge-status').textContent, S.car.apk.badge.ok);

    const damage = slot(page, 'damage');
    assert.equal(one(damage, '.badge-status').textContent, S.home.damageNew);
    assert.equal(one(damage, '.big').textContent, S.home.damageOpen(2));
    assert.match(one(damage, '.sub').textContent, /^Nieuwste: Achterkant, gemeld op /);

    assert.deepEqual(all(slot(page, 'quick'), 'a.list-row').map((a) => a.getAttribute('href')), ['#/fuel', '#/car']);

    // It asks for what other screens ask for, once each, and writes nothing.
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`).sort(), ['GET /api/car/apk', 'GET /api/damage', 'GET /api/fuel', 'GET /api/inbox', 'GET /api/reservations', 'GET /api/usage', 'GET /api/usage/pending']);
    assert.deepEqual(api.writes(), []);
    const reservationsCall = api.calls.find((c) => c.path === '/api/reservations');
    assert.match(reservationsCall?.query ?? '', /^status=confirmed&from=.+&to=.+$/, 'only confirmed reservations, and only the days around now');
  }));

test('Start with nothing to say: a free car, nothing planned, nothing owed, no APK date and no damage each say so and what to do', () =>
  withClient({ now: NOW, routes: empty() }, async ({ dom }) => {
    const page = await mount(dom);
    const car = slot(page, 'car');
    assert.ok(!one(car, '.car-now').classList.contains('out'));
    assert.deepEqual([one(car, '.big').textContent, texts(car, '.sub')[0]], [S.home.free, S.home.nothingPlanned]);
    assert.equal(slot(page, 'answers').children.length, 0);
    assert.equal(slot(page, 'km').children.length, 0);
    const mine = slot(page, 'mine');
    assert.equal(one(mine, '.sub').textContent, S.home.mineNone);
    assert.equal(one(mine, 'a').getAttribute('href'), '#/reserve');
    assert.equal(one(slot(page, 'money'), '.sub').textContent, S.home.moneyNone);
    assert.equal(one(slot(page, 'apk'), '.sub').textContent, S.car.apk.notSet);
    assert.equal(one(slot(page, 'apk'), 'a').getAttribute('href'), '#/car');
    assert.equal(one(slot(page, 'damage'), '.sub').textContent, S.car.noneOpen);
  }));

test('Start: while someone has a reservation but is not on the road, the car is theirs until the end; free is shown only when it is', () =>
  withClient({ now: NOW, routes: empty({ 'GET /api/reservations': () => ({ items: [reservation({ id: 7, start: at(-30), end: at(120), userId: 2, userName: 'Ben' })] }) }) }, async ({ dom }) => {
    const page = await mount(dom);
    const car = slot(page, 'car');
    assert.equal(one(car, '.big').textContent, S.home.hasIt('Ben'));
    assert.match(one(car, '.sub').textContent, /^Gereserveerd tot /);
    assert.ok(one(car, '.car-now').classList.contains('out'));
  }));

test('Start: my own open drive offers to finish it, an admin may finish anybody\'s, another member gets no button', () =>
  withClient({ now: NOW, routes: empty({ 'GET /api/usage': () => ({ items: [draft({ id: 9 })] }) }) }, async ({ dom }) => {
    const mine = slot(await mount(dom, makeApp(ANNA)), 'car');
    assert.equal(one(mine, '.big').textContent, S.home.drivingMe);
    assert.equal(one(mine, 'a').getAttribute('href'), '#/usage?edit=9');
    assert.equal(one(mine, 'a').textContent, S.home.finishDrive);
    assert.equal(all(slot(await mount(dom, makeApp(ADMIN)), 'car'), 'a').length, 1, 'an admin can finish it');
    const other = slot(await mount(dom, makeApp(BEN)), 'car');
    assert.equal(one(other, '.big').textContent, S.home.driving('Anna'));
    assert.equal(all(other, 'a').length, 0);
  }));

test('Start: the kilometres to register come with the same banner and buttons as on Ritten', () =>
  withClient({ now: NOW, routes: empty({ 'GET /api/usage/pending': () => ({ count: 1, items: [{ userId: 1, userName: 'Anna', reservations: [reservation({ id: 7, start: at(-300), end: at(-200) })], drafts: [] }] }) }) }, async ({ dom }) => {
    const page = await mount(dom);
    const banner = one(slot(page, 'km'), 'section.banner');
    assert.equal(one(banner, 'h3').textContent, S.usage.pending.title(1));
    assert.equal(one(banner, 'a.btn').getAttribute('href'), '#/usage?res=7');
  }));

test('Start: one request that fails only costs its block, which says so and retries just what failed', () => {
  let fuelCalls = 0;
  return withClient(
    {
      now: NOW,
      routes: full({
        'GET /api/fuel': () => {
          fuelCalls++;
          return fuelCalls === 1 ? refuse(500, 'internal') : { items: [], balances: [] };
        },
      }),
    },
    async ({ dom, api }) => {
      const page = await mount(dom);
      const money = slot(page, 'money');
      assert.equal(one(money, 'h3').textContent, S.home.money);
      assert.equal(one(money, '[role="alert"] p').textContent.length > 0, true, 'it says what happened');
      assert.ok(slot(page, 'apk').querySelector('.badge-status'), 'the other blocks are untouched');
      assert.ok(slot(page, 'car').querySelector('.car-now'));
      const before = api.calls.length;
      await one(money, 'button').fire('click');
      await until(() => slot(page, 'money').querySelector('.sub') !== null, 'the retried block');
      assert.equal(one(slot(page, 'money'), '.sub').textContent, S.home.moneyNone);
      assert.deepEqual(api.calls.slice(before).map((c) => c.path), ['/api/fuel'], 'only the failed request is asked again');
    },
  );
});

test('Start: a request shared by two blocks is asked once, and if it fails both blocks say so', () =>
  withClient({ now: NOW, routes: empty({ 'GET /api/reservations': () => refuse(500, 'internal') }) }, async ({ dom, api }) => {
    const page = await mount(dom);
    assert.equal(api.calls.filter((c) => c.path === '/api/reservations').length, 1);
    for (const id of ['car', 'mine']) assert.ok(slot(page, id).querySelector('[role="alert"]'), `${id} failed`);
    assert.ok(slot(page, 'apk').children.length > 0);
  }));

// ------------------------------------------------------------------ the background refresh

/** Every answer of `routes` until `down.on` is set, and a 500 after that: the phone is awake before its network is. */
const flaky = (routes: Routes, down: { on: boolean }, except: string[] = []): Routes =>
  Object.fromEntries(Object.entries(routes).map(([key, handler]) => [key, (call: Call) => (down.on && !except.includes(key) ? refuse(500, 'internal') : handler(call))]));

const BLOCK_IDS = ['car', 'answers', 'km', 'mine', 'money', 'apk', 'damage', 'quick'];
/** What each block shows, as text, so two renderings of the page can be compared. */
const shown = (page: unknown): string[] => BLOCK_IDS.map((id) => slot(page, id).textContent);

test('Start: a background refresh that cannot reach the server keeps every block it showed, instead of turning into error blocks', () => {
  const down = { on: false };
  return withClient({ now: NOW, routes: flaky(full(), down) }, async ({ dom, api }) => {
    const me = makeApp(ANNA);
    const before = await mount(dom, me);
    const was = shown(before);
    assert.equal(all(before, '[role="alert"]').length, 0);

    down.on = true;
    const calls = api.calls.length;
    const page = dom.mount(await renderHome(me.app, undefined, { silent: true }));
    assert.ok(api.calls.length > calls, 'it did ask: the answers failed, they were not skipped');
    assert.equal(all(page, '[role="alert"]').length, 0, 'no block says it could not load');
    assert.deepEqual(shown(page), was, 'every block reads as it did');
    assert.ok(one(slot(page, 'car'), '.car-now'));
    assert.ok(one(slot(page, 'money'), 'a'), 'and the buttons are the live ones, drawn again, not a copy of the old page');
    assert.equal(slot(page, 'km').children.length, 0, 'a block that had nothing to say is still not there');
  });
});

test('Start: in a background refresh only the block whose request failed falls back to its last answer, the others show the new one', () => {
  const down = { on: false };
  let waiting = 2;
  return withClient({ now: NOW, routes: flaky(full({ 'GET /api/inbox': () => ({ incoming: [], outgoing: [], incomingCount: waiting }) }), down, ['GET /api/inbox']) }, async ({ dom }) => {
    const me = makeApp(ANNA);
    const first = await mount(dom, me);
    assert.equal(one(slot(first, 'answers'), '.big').textContent, S.home.answersWaiting(2));
    const money = slot(first, 'money').textContent;

    down.on = true; // the fuel request fails now, the inbox still answers
    waiting = 5;
    const page = dom.mount(await renderHome(me.app, undefined, { silent: true }));
    assert.equal(one(slot(page, 'answers'), '.big').textContent, S.home.answersWaiting(5), 'what came back is new');
    assert.equal(slot(page, 'money').textContent, money, 'what did not is the last answer');
    assert.equal(all(page, '[role="alert"]').length, 0);
  });
});

test('Start: a block that never had an answer still says so in a background refresh, with its retry; and a visit or a retry never falls back to old answers', () => {
  const down = { on: false };
  return withClient({ now: NOW, routes: flaky(full(), down) }, async ({ dom }) => {
    const me = makeApp(ANNA);
    await mount(dom, me);
    down.on = true;
    // A visit (not silent) is what the server says now: the failure shows, whatever was there a moment ago.
    const visit = dom.mount(await renderHome(me.app));
    assert.equal(all(visit, '[role="alert"]').length, 7, 'seven blocks ask for something, and each says it could not');
    // The visit threw the old answers away: a background refresh right after it has nothing to fall back on either.
    const silent = dom.mount(await renderHome(me.app, undefined, { silent: true }));
    assert.equal(all(silent, '[role="alert"]').length, 7);
    assert.equal(all(silent, 'button').filter((b) => b.textContent === S.retry).length, 7, 'each with its own retry');
  });
});

test('Start: the last answers of one person are never shown to the next, not even by a background refresh that fails', () => {
  const down = { on: false };
  return withClient({ now: NOW, routes: flaky(full(), down) }, async ({ dom }) => {
    await mount(dom, makeApp(ANNA));
    down.on = true;
    const ben = makeApp(BEN);
    const page = dom.mount(await renderHome(ben.app, undefined, { silent: true }));
    assert.equal(all(page, '[role="alert"]').length, 7, 'Ben has nothing of his own to show: no part of Anna\'s page');
    assert.equal(slot(page, 'car').querySelector('.car-now'), null);
  });
});

test('Start: long names and long notes stay inside their blocks (they wrap, nothing is cut)', () =>
  withClient({ now: NOW, routes: full({ 'GET /api/usage': () => ({ items: [draft({ id: 9, userId: 2, userName: 'Maximiliaan-Bartholomeus van der Wiel-Janssen', start: at(-30) })] }) }) }, async ({ dom }) => {
    const page = await mount(dom);
    assert.equal(one(slot(page, 'car'), '.big').textContent, 'Maximiliaan-Bartholomeus van der Wiel-Janssen is onderweg');
  }));

test('the blocks that ask for something (the car, the answers, the kilometres) and the quick rows take a whole row of the grid, so a tablet has no hole beside them', () =>
  withClient({ now: NOW, routes: full() }, async ({ dom }) => {
    const page = await mount(dom);
    const wide = all(page, '[data-block]').filter((s) => s.classList.contains('wide')).map((s) => s.getAttribute('data-block'));
    assert.deepEqual(wide, ['car', 'answers', 'km', 'quick']);
  }));
