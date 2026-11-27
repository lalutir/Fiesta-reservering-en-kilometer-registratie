// The places of the app (public/nav.js) and the page Meer (public/views/more.js): five places in the bar, everything
// else one tap further, every old address and every push deep link still opens a screen, the empty hash is the only
// one that opens Start, and the 60-second refresh leaves a page alone while a sheet is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_ITEM, PRIMARY, SECONDARY, badgeLabel, bareLaunch, buildNav, currentPlaces, placeOf, titleOf } from '../public/nav.js';
import { S } from '../public/strings.js';
import { render as renderMore } from '../public/views/more.js';
import { render as renderUsage } from '../public/views/usage.js';
import { overlayOpen, sheet } from '../public/ui.js';
import { ADMIN, ANNA, NOW, Reply, all, byText, makeApp, one, withClient, type FakeElement } from './fake-dom.ts';

const root = path.join(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const VIEWS = ((): string[] => {
  const literal = /const VIEWS = \{([^}]*)\}/.exec(appSource)?.[1] ?? '';
  return literal.split(',').map((v) => v.trim()).filter(Boolean);
})();

// ------------------------------------------------------------------ the model

test('the bar has five places, each with a short label, and exactly one of them is the raised Boeken button', () => {
  assert.deepEqual(PRIMARY.map((i) => i.name), ['home', 'agenda', 'reserve', 'usage', 'more']);
  assert.ok(PRIMARY.length <= 5, 'five columns fit a 320 px phone');
  for (const item of PRIMARY) assert.ok([...item.label].length <= 8, `${item.label} fits one tab`);
  assert.deepEqual(PRIMARY.filter((i) => i.book).map((i) => [i.name, i.href]), [['reserve', '#/reserve']]);
  assert.equal(new Set(PRIMARY.map((i) => i.href)).size, PRIMARY.length);
  assert.deepEqual(PRIMARY.map((i) => i.label), [S.nav.home, S.nav.agenda, S.nav.reserve, S.nav.usage, S.nav.more]);
});

test('every route of the app has a place: a place of the bar, a place under Meer, or a sub-route of Ritten', () => {
  assert.ok(VIEWS.length >= 11, `parsed ${VIEWS.length} views from app.js`);
  const known = new Set([...PRIMARY, ...SECONDARY].map((i) => i.name));
  for (const route of VIEWS) {
    assert.ok(known.has(route) || ['fuel', 'tickets', 'stats'].includes(route), `${route} has no place in the navigation`);
    assert.ok(known.has(placeOf(route)), `${route} belongs to ${placeOf(route)}, which is not a place of the bar`);
  }
});

test('the places under Meer light Meer, the sub-routes of Ritten light Ritten, and in the rail the place itself is lit too', () => {
  assert.deepEqual(currentPlaces('car'), ['more', 'car']);
  assert.deepEqual(currentPlaces('inbox'), ['more', 'inbox']);
  assert.deepEqual(currentPlaces('more'), ['more']);
  assert.deepEqual(currentPlaces('fuel'), ['usage']);
  assert.deepEqual(currentPlaces('tickets'), ['usage']);
  assert.deepEqual(currentPlaces('stats'), ['usage']);
  assert.deepEqual(currentPlaces('agenda'), ['agenda']);
  assert.deepEqual(currentPlaces('home'), ['home']);
});

test('page titles: the label of the place, or the name of the sub-view; an unknown route has none', () => {
  assert.equal(titleOf('home'), 'Start');
  assert.equal(titleOf('agenda'), 'Agenda');
  assert.equal(titleOf('fuel'), S.fuel.title);
  assert.equal(titleOf('tickets'), S.tickets.title);
  assert.equal(titleOf('stats'), 'Statistieken');
  assert.equal(titleOf('more'), 'Meer');
  assert.equal(titleOf('car'), 'Auto');
  assert.equal(titleOf('nope'), null);
});

test('only an empty hash is a bare launch: "#/" is the Agenda, and every other address is a screen somebody asked for', () => {
  assert.equal(bareLaunch(''), true);
  for (const hash of ['#', '#/', '#/home', '#/?view=week', '#/usage?res=7', '#/inbox', '#/car']) assert.equal(bareLaunch(hash), false, hash);
});

test('the old addresses all still name a view, and the push deep links of the server open one too', () => {
  for (const route of ['agenda', 'reserve', 'inbox', 'usage', 'fuel', 'tickets', 'stats', 'history', 'car', 'account']) assert.ok(VIEWS.includes(route), route);
  assert.ok(VIEWS.includes('home') && VIEWS.includes('more'), 'routes were added');
  const sources = ['notify.ts', 'push.ts'].map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
  const links = new Set([...sources.matchAll(/'(\/#\/[a-z]*)(?:\?[^']*)?'|`(\/#\/[a-z]*)(?:\?[^`]*)?`/g)].map((m) => m[1] ?? m[2]));
  assert.ok(links.size >= 8, `found ${links.size} deep links in the server`);
  for (const link of links) {
    const name = /^\/#\/([a-z]*)/.exec(link as string)?.[1] ?? '';
    assert.ok(name === '' || VIEWS.includes(name), `${link} opens no screen`);
    assert.equal(bareLaunch(new URL(link as string, 'https://car.example').hash), false, `${link} must not be taken for a bare launch`);
  }
});

test('every destination, the admin page included, is at most two taps away; the bar itself is one', () =>
  withClient(
    {
      now: NOW,
      routes: {
        'GET /api/inbox': () => ({ incoming: [], outgoing: [], incomingCount: 0 }),
        'GET /api/usage': () => ({ items: [] }),
        'GET /api/usage/summary': () => ({ items: [], totalKm: 0 }),
        'GET /api/reservations': () => ({ items: [] }),
        'GET /api/usage/pending': () => ({ items: [], count: 0 }),
      },
    },
    async ({ dom }) => {
      const hrefsOf = (page: unknown): Set<string> => new Set(all(page, 'a').map((a) => a.getAttribute('href') ?? ''));
      const entry = (route: string): string => (route === 'agenda' ? '#/' : `#/${route}`);

      // Tap one: the bar is part of the shell, so these are on every screen. Five places fit a phone at 320 px.
      const bar = new Set(PRIMARY.map((item) => item.href));
      assert.ok(PRIMARY.length <= 5, 'at most five places in the bar, Meer included');
      assert.ok(bar.has(entry('reserve')), 'Boeken is in the bar: one tap from every screen');
      assert.ok(bar.has(entry('more')), 'Meer is in the bar: it is the way to the second tap');

      // Tap two: what the real pages Meer and Ritten link to. Fuel and tickets are not rows of Meer, they hang under Ritten.
      const memberMeer = hrefsOf(dom.mount(await renderMore(makeApp(ANNA).app)));
      dom.body.replaceChildren();
      const adminMeer = hrefsOf(dom.mount(await renderMore(makeApp(ADMIN).app)));
      dom.body.replaceChildren();
      const ritten = hrefsOf(dom.mount(await renderUsage(makeApp(ANNA).app, { query: new URLSearchParams('') })));
      dom.body.replaceChildren();

      const second = new Set([...memberMeer, ...ritten]);
      const taps = (href: string, further: Set<string>): number => (bar.has(href) ? 1 : further.has(href) ? 2 : Infinity);
      for (const route of VIEWS) {
        const n = taps(entry(route), second);
        assert.ok(n <= 2, `${route} (${entry(route)}) is ${n === Infinity ? 'not reachable from the bar, Meer or Ritten' : `${n} taps away`}`);
      }
      assert.equal(taps(entry('inbox'), second), 2, 'Meer, then the row');
      assert.equal(taps(entry('fuel'), second), 2, 'Ritten, then Brandstof en kosten');
      assert.equal(taps(entry('tickets'), second), 2, 'Ritten, then Verkeersboetes');
      assert.equal(taps(entry('stats'), second), 2, 'Ritten, then Statistieken');
      assert.equal(PRIMARY.length, 5, 'Statistieken is no sixth place of the bar');

      // The admin page is its own document: an admin finds it on Meer (tap two), a member does not see it at all.
      assert.equal(taps(ADMIN_ITEM.href, adminMeer), 2);
      assert.equal(memberMeer.has(ADMIN_ITEM.href), false);

      // From 768 px the same links are all in the rail, so there the second tap is gone (below that the rail is hidden by CSS).
      const railOf = (user: typeof ANNA): Set<string> => hrefsOf(buildNav({ user, onSignOut: () => undefined, toast: () => undefined }).rail);
      const railAdmin = railOf(ADMIN);
      for (const item of [...SECONDARY, ADMIN_ITEM]) assert.ok(railAdmin.has(item.href), `${item.label} is a link of the rail`);
      assert.equal(railOf(ANNA).has(ADMIN_ITEM.href), false, 'no Admin link for a member');
    },
  ));

test('the counts: a screen reader hears what a number counts, on the right link', () => {
  assert.equal(badgeLabel('inbox', 1), S.inbox.tabLabel(1));
  assert.equal(badgeLabel('usage', 3), S.usage.tabLabel(3));
  assert.equal(badgeLabel('more', 2), S.more.tabLabel(2));
  assert.match(S.more.tabLabel(2), /^Meer, 2 wachten/);
});

// ------------------------------------------------------------------ the bar

const user = { displayName: 'Anna', role: 'member' };
const build = (u = user) => buildNav({ user: u, toast: () => {}, onSignOut: () => {} });
const links = (rail: unknown) => all(rail, 'a.tab');

test('the bar is a navigation named Hoofdmenu with the five places first, then the places under Meer for the rail', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const nav = build();
    const rail = nav.rail as unknown as FakeElement;
    const bar = one(rail, 'nav');
    assert.equal(bar.getAttribute('aria-label'), 'Hoofdmenu');
    assert.deepEqual(links(nav.rail).map((a) => a.getAttribute('data-tab')), ['home', 'agenda', 'reserve', 'usage', 'more', 'inbox', 'history', 'car', 'account']);
    const phone = links(nav.rail).filter((a) => !a.classList.contains('tab-secondary'));
    assert.deepEqual(phone.map((a) => a.querySelector('.tab-label')?.textContent), ['Start', 'Agenda', 'Boeken', 'Ritten', 'Meer']);
    assert.ok(one(rail, '.tab-book').classList.contains('tab-book'));
    assert.ok(one(rail, '.tab-more'), 'Meer is hidden in the rail');
    assert.equal(all(rail, '.rail-foot').length, 1);
    assert.equal(all(rail, 'h1').length, 1, 'one h1: the name of the app');
  }));

test('an admin also has the Admin link in the rail, a member does not', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const member = links(build().rail).map((a) => a.getAttribute('href'));
    const admin = links(build({ displayName: 'Root', role: 'admin' }).rail).map((a) => a.getAttribute('href'));
    assert.equal(ADMIN_ITEM.href, '/admin/');
    assert.ok(!member.includes('/admin/'));
    assert.ok(admin.includes('/admin/'));
  }));

test('setCurrent marks exactly the places of the route with aria-current, and clears the others', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const nav = build();
    const current = () => links(nav.rail).filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('data-tab'));
    nav.setCurrent('agenda');
    assert.deepEqual(current(), ['agenda']);
    nav.setCurrent('car');
    assert.deepEqual(current(), ['more', 'car'], 'Meer on a phone, Auto in the rail');
    nav.setCurrent('fuel');
    assert.deepEqual(current(), ['usage']);
    nav.setCurrent('home');
    assert.deepEqual(current(), ['home']);
  }));

test('the counts ride on Ritten, on Inbox (rail) and on Meer (phone), each with its own spoken name, and go away at zero', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    const nav = build();
    const link = (name: string) => links(nav.rail).find((a) => a.getAttribute('data-tab') === name) as FakeElement;
    nav.setBadge('inbox', 2);
    nav.setBadge('usage', 3);
    assert.equal(link('inbox').getAttribute('aria-label'), S.inbox.tabLabel(2));
    assert.equal(link('more').getAttribute('aria-label'), S.more.tabLabel(2));
    assert.equal(link('usage').getAttribute('aria-label'), S.usage.tabLabel(3));
    assert.equal(link('usage').querySelector('.badge')?.textContent, '3');
    assert.equal(link('usage').querySelector('.badge')?.hidden, false);
    nav.setBadge('inbox', 0);
    assert.equal(link('inbox').getAttribute('aria-label'), null);
    assert.equal(link('more').querySelector('.badge')?.hidden, true);
    assert.equal(link('agenda').querySelector('.badge'), null, 'a place without a count has no badge');
  }));

test('the rail has the theme choice and a sign-out button, which asks the shell to sign out', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    let out = 0;
    const nav = buildNav({ user, toast: () => {}, onSignOut: () => void out++ });
    const foot = one(nav.rail, '.rail-foot');
    assert.deepEqual(all(foot, '.seg').map((b) => b.textContent), ['Systeem', 'Licht', 'Donker']);
    await byText(foot, 'button', S.account.signOut).fire('click');
    assert.equal(out, 1);
  }));

// ------------------------------------------------------------------ the page Meer

test('Meer lists the places that are not in the bar as rows with a line under each, the inbox count, the theme and the way out', () =>
  withClient({ now: NOW, routes: { 'GET /api/inbox': () => ({ incoming: [], outgoing: [], incomingCount: 2 }) } }, async ({ dom }) => {
    const me = makeApp(ANNA);
    const page = dom.mount(await renderMore(me.app));
    assert.equal(one(page, 'h2').textContent, 'Meer');
    const rows = all(page, 'a.list-row');
    assert.deepEqual(rows.map((r) => r.getAttribute('href')), ['#/inbox', '#/history', '#/car', '#/account']);
    assert.deepEqual(rows.map((r) => r.querySelector('.row-title')?.textContent), ['Inbox', 'Historie', 'Auto', 'Account']);
    assert.ok(rows.every((r) => (r.querySelector('.row-sub')?.textContent ?? '') !== ''), 'every row says what is behind it');
    assert.equal(rows[0]?.querySelector('.badge')?.textContent, '2');
    assert.equal(rows[0]?.querySelector('.badge')?.getAttribute('aria-label'), S.inbox.tabLabel(2));
    assert.deepEqual(all(page, '.seg').map((b) => b.textContent), ['Systeem', 'Licht', 'Donker']);
    assert.ok(byText(page, 'button', S.account.signOut));
    assert.equal(all(page, 'a').some((a) => a.getAttribute('href') === '/admin/'), false, 'a member has no Admin row');
  }));

test('Meer: an admin has the Admin row, and a failing inbox request only loses the count', () =>
  withClient({ now: NOW, routes: { 'GET /api/inbox': () => new Reply({ error: { code: 'error', message: 'x' } }, 500) } }, async ({ dom }) => {
    const me = makeApp(ADMIN);
    const page = dom.mount(await renderMore(me.app));
    assert.ok(all(page, 'a.list-row').some((a) => a.getAttribute('href') === '/admin/'));
    assert.equal(all(page, '.badge').length, 0);
  }));

// ------------------------------------------------------------------ the refresh

test('the 60-second refresh leaves the page alone while a sheet or a field is open', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    // app.js has side effects at load, so its rule is read from source and the part it relies on is exercised here.
    const refresh = /function backgroundRefresh\(\) \{([\s\S]*?)\n\}/.exec(appSource)?.[1] ?? '';
    assert.match(refresh, /isEditing\(\)/);
    assert.match(refresh, /overlayOpen\(\)/);
    assert.ok(refresh.indexOf('overlayOpen()') < refresh.indexOf('renderCurrent'), 'the check comes before any re-render');
    assert.equal(overlayOpen(), false);
    const panel = sheet({ title: 'Gebruiker', body: 'x' });
    panel.open();
    assert.equal(overlayOpen(), true, 'a sheet counts');
    panel.close();
    assert.equal(overlayOpen(), false);
  }));

test('the shell keeps the pieces other tests rely on: the VIEWS literal, a skip link that does not touch the hash, a walk to another place before a render', () => {
  assert.match(appSource, /const VIEWS = \{ home, more, agenda, reserve, inbox, usage, fuel, tickets, stats, history, car, account \};/);
  assert.match(appSource, /class: 'skip-link', href: '#view', onclick: \(\/\*\* @type \{Event\} \*\/ e\) => \(e\.preventDefault\(\)/);
  // What it does is run by test/shell-undo.test.ts (the real shell) and test/undo.test.ts; this only keeps the call from being dropped,
  // and a flush on every render (the cause of an Ongedaan maken that did nothing) from coming back.
  assert.match(appSource, /await enterPlace\(route\.name\)/);
  assert.doesNotMatch(appSource, /flushPending/, 'a render must not flush by itself: only walking to another place does (undo.js enterPlace)');
  assert.match(appSource, /clearAllDrafts\(\)/, 'sign-out and a ended session forget unsent input');
  assert.match(appSource, /window\.history\.replaceState\(null, '', '#\/home'\)/, 'a bare launch opens Start without a second render');
});
