// "Ongedaan maken" in the real app shell (public/app.js). The view tests stub app.refresh() and app.navigate() with
// counters, and undo.test.ts drives undo.js alone, so neither could see the shell sending a deferred delete at once
// (refresh() and every hash change used to flush it, and the toast then offered a button that did nothing).
// Here the real shell runs against the fake page: the real car view, the real refresh and the real hashchange.
//
// public/app.js starts itself when it is loaded and takes #app from the page, so every case loads its own copy of
// the script (the ?shell suffix) into a fresh fake page, like test/admin-actions.test.ts does for the admin page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/strings.js';
import { ANNA, BEN, NOW, Reply, TZ, all, at, byText, doc, draft, one, refuse, until, withClient, type FakeDom, type FakeElement, type Routes } from './fake-dom.ts';
import type { Json } from './helpers.ts';

let seq = 0;

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

const routes = (over: Routes = {}): Routes => ({
  'GET /api/auth/me': () => ({ user: ANNA, timeZone: TZ, windowMonths: 6, serverTime: NOW }),
  'GET /api/users': () => ({ users: [ANNA, BEN] }),
  'GET /api/inbox': () => ({ incoming: [], outgoing: [], incomingCount: 0 }),
  'GET /api/usage/pending': () => ({ items: [], count: 0 }),
  'GET /api/car/apk': () => ({ apk: { expiresOn: null, daysLeft: null, updatedBy: null, updatedAt: null } }),
  // Like the real server: the report is listed until the DELETE has gone out.
  'GET /api/damage': () => ({ items: [report()] }),
  'DELETE /api/damage/1': () => new Reply(null, 204),
  ...over,
});

interface Shell {
  /** Walk to another place the way a tap on a link does: the hash changes, then hashchange fires. */
  go: (hash: string) => void;
  /** The own damage report card of the Car screen (null while it is not on the page). */
  card: () => FakeElement | null;
  toastAction: () => FakeElement | null;
}

const realSetInterval = globalThis.setInterval;

/** Load a fresh copy of the app into the fake page, signed in as Anna, standing on `start` until `ready` says the screen is drawn. */
async function openShell(dom: FakeDom, start = '#/car', ready = (): boolean => doc().querySelector('article#damage-1') !== null): Promise<Shell> {
  const g = globalThis as Json;
  const host = doc().createElement('div') as unknown as FakeElement;
  host.id = 'app';
  dom.mount(host);
  let hash = start;
  Object.defineProperty(g, 'location', {
    configurable: true,
    value: {
      get hash() {
        return hash;
      },
      set hash(value: string) {
        hash = value;
        dom.window.emit('hashchange');
      },
      replace: (to: string) => void (hash = to),
    },
  });
  (g['window'] as Json)['history'] = { replaceState: (_s: unknown, _t: string, to: string) => void (hash = to) };
  // The one-minute refresh is a real timer that would keep the test process alive.
  g['setInterval'] = () => 0;
  await import(`../public/app.js?shell=${++seq}`);
  const shell: Shell = {
    go: (to) => {
      (g['location'] as { hash: string }).hash = to;
    },
    card: () => doc().querySelector('article#damage-1'),
    toastAction: () => doc().querySelector('.toast .toast-action'),
  };
  await until(ready, 'the first screen to open');
  return shell;
}

/** Let what the shell started finish before the fake page goes away, and put the globals back. */
async function closeShell(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  const g = globalThis as Json;
  delete g['location'];
  g['setInterval'] = realSetInterval;
}

test('the real shell: deleting my own report leaves it waiting through the refresh, so Ongedaan maken still works and nothing is sent', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom, api, tick }) => {
    try {
      const shell = await openShell(dom);
      const reads = (): number => api.calls.filter((c) => c.method === 'GET' && c.path === '/api/damage').length;
      assert.equal(reads(), 1);

      await byText(shell.card() as FakeElement, 'button', S.delete).fire('click');
      // The view asked the shell to refresh (the real refresh(), not a counter) and drew the list again ...
      await until(() => reads() === 2 && shell.card() === null, 'the list to be drawn again without the report');
      // ... and the DELETE has NOT gone out: the toast offers to take it back and that has to be true.
      assert.deepEqual(api.writes(), [], 'refresh() must not send a delete that is still in its window');
      assert.equal(shell.toastAction()?.textContent, S.undo.action);

      // Ongedaan maken: the report is back, and nothing is ever sent.
      await shell.toastAction()?.fire('click');
      await until(() => reads() === 3 && shell.card() !== null, 'the list to be drawn again with the report in it');
      tick(20_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.deepEqual(api.writes(), [], 'taken back: never sent');
    } finally {
      await closeShell();
    }
  }));

test('the real shell: the delete goes out when the person walks to another place, before that place asks for anything', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom, api }) => {
    try {
      const shell = await openShell(dom);
      await byText(shell.card() as FakeElement, 'button', S.delete).fire('click');
      await until(() => api.calls.filter((c) => c.path === '/api/damage' && c.method === 'GET').length === 2, 'the refresh');
      assert.deepEqual(api.writes(), []);

      const before = api.calls.length;
      shell.go('#/more');
      await until(() => api.writes().length === 1, 'the delete when the person leaves');
      assert.equal(`${api.writes()[0]?.method} ${api.writes()[0]?.path}`, 'DELETE /api/damage/1');
      await until(() => one(doc().body, 'h2').textContent === S.more.title, 'the next place to be drawn');
      const after = api.calls.slice(before).map((c) => `${c.method} ${c.path}`);
      assert.equal(after[0], 'DELETE /api/damage/1', `the delete goes first, then the next screen asks: ${after.join(', ')}`);
    } finally {
      await closeShell();
    }
  }));

test('the real shell: a move inside the same place (the same route, another query) leaves a waiting delete alone', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom, api }) => {
    try {
      const shell = await openShell(dom);
      await byText(shell.card() as FakeElement, 'button', S.delete).fire('click');
      await until(() => api.calls.filter((c) => c.path === '/api/damage' && c.method === 'GET').length === 2, 'the refresh');
      // #/car?edit=1 is the same place as #/car (the edit form of the same screen): a hashchange, but nobody left.
      shell.go('#/car?edit=1');
      await until(() => api.calls.filter((c) => c.path === '/api/damage' && c.method === 'GET').length === 3, 'the screen to be drawn for the new address');
      assert.deepEqual(api.writes(), [], 'still waiting');
      assert.ok(shell.toastAction(), 'and the toast still offers to take it back');
      assert.equal(all(doc().body, 'article#damage-1').length, 0, 'the report stays off the list while it waits');
    } finally {
      await closeShell();
    }
  }));

// ------------------------------------------------------------------ the Drives list (the other two places defer a delete too)

/** Anna's open drive with nothing else involved (no reservation, her own kilometres): the kind that can be taken back. */
const myDraft = (): Json => draft({ id: 9, reservationId: null });

const drivesRoutes = (over: Routes = {}): Routes =>
  routes({
    'GET /api/usage': () => ({ items: [myDraft()] }),
    'GET /api/usage/summary': () => ({ items: [], together: { trips: 0, km: 0 }, totalKm: 0 }),
    'GET /api/reservations': () => ({ items: [] }),
    // The server still counts the draft until the DELETE has gone out.
    'GET /api/usage/pending': () => ({ items: [{ userId: ANNA.id, userName: 'Anna', reservations: [], drafts: [myDraft()] }], count: 1 }),
    'DELETE /api/usage/9': () => new Reply(null, 204),
    ...over,
  });

test('the real shell: deleting my own open drive from the Drives list waits through the refresh, and the Ritten count leaves the draft out at once', () =>
  withClient({ now: NOW, routes: drivesRoutes() }, async ({ dom, api, tick }) => {
    try {
      const rows = (): FakeElement[] => all(doc().body, 'article.usage');
      const badge = (): FakeElement => one(doc().body, 'a[href="#/usage"] .badge');
      const shell = await openShell(dom, '#/usage', () => rows().length === 1);
      await until(() => badge().hidden === false && badge().textContent === '1', 'the count of kilometres still to register');

      await byText(rows()[0] as FakeElement, 'button', S.delete).fire('click');
      assert.deepEqual(dom.confirms, [], 'no question: it can be taken back');
      await until(() => rows().length === 0, 'the list to be drawn again without the drive');
      await until(() => badge().hidden === true, 'the count to leave the draft out');
      assert.deepEqual(api.writes(), [], 'the refresh did not send the delete');
      assert.equal(shell.toastAction()?.textContent, S.undo.action);

      await shell.toastAction()?.fire('click');
      await until(() => rows().length === 1, 'the drive to be back');
      tick(20_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.deepEqual(api.writes(), [], 'taken back: never sent');
    } finally {
      await closeShell();
    }
  }));

test('the real shell: the Delete button on the edit form of my open drive goes back to the list and the delete still waits', () =>
  withClient({ now: NOW, routes: drivesRoutes() }, async ({ dom, api }) => {
    try {
      const shell = await openShell(dom, '#/usage?edit=9', () => all(doc().body, 'form').length > 0 && all(doc().body, 'button').some((b) => b.textContent === S.usage.deleteDraft));
      await byText(doc().body, 'button', S.usage.deleteDraft).fire('click');
      // #/usage?edit=9 -> #/usage is a hashchange inside the same place: it must not send the delete.
      await until(() => !all(doc().body, 'button').some((b) => b.textContent === S.usage.deleteDraft), 'the list to be drawn without the open drive');
      assert.deepEqual(api.writes(), [], 'a move back to the list is not leaving it');
      assert.equal(shell.toastAction()?.textContent, S.undo.action);

      // Walking somewhere else is leaving, and sends it.
      shell.go('#/more');
      await until(() => api.writes().length === 1, 'the delete when the person leaves');
      assert.equal(`${api.writes()[0]?.method} ${api.writes()[0]?.path}`, 'DELETE /api/usage/9');
    } finally {
      await closeShell();
    }
  }));

// ------------------------------------------------------------------ the offer ends with the delete

test('the real shell: walking away sends the delete and takes Ongedaan maken off the screen, so there is no button left that does nothing', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom, api }) => {
    try {
      const shell = await openShell(dom);
      await byText(shell.card() as FakeElement, 'button', S.delete).fire('click');
      await until(() => api.calls.filter((c) => c.path === '/api/damage' && c.method === 'GET').length === 2, 'the refresh');
      const toast = (): FakeElement => one(doc().body, '.toast');
      assert.match(toast().className, /\bshow\b/, 'the offer is on screen while the delete waits');

      shell.go('#/more');
      await until(() => api.writes().length === 1, 'the delete when the person leaves');
      await until(() => one(doc().body, 'h2').textContent === S.more.title, 'the next place to be drawn');
      assert.doesNotMatch(toast().className, /\bshow\b/, 'the delete is on its way: the offer is withdrawn');

      // Back on the Car screen and a press on whatever is left of the button changes nothing.
      await shell.toastAction()?.fire('click');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.equal(api.writes().length, 1, 'no second request');
      assert.equal(one(doc().body, '.toast .toast-text').textContent, S.undo.damage, 'and no "hersteld" message');
    } finally {
      await closeShell();
    }
  }));

// ------------------------------------------------------------------ a refresh of the same place keeps the page

interface Slow {
  /** Hold every read of the damage list until the returned function is called. */
  hold: () => () => void;
}

/** Wrap the stubbed fetch so a test can keep an answer waiting (the stub itself answers at once). */
function slowDamageReads(): Slow {
  const g = globalThis as Json;
  const real = g['fetch'] as (url: string, init?: Json) => Promise<Response>;
  let gate: Promise<void> | null = null;
  g['fetch'] = async (url: string, init?: Json) => {
    const wait = gate;
    if (wait && url.split('?')[0] === '/api/damage' && (init?.['method'] ?? 'GET') === 'GET') await wait;
    return real(url, init);
  };
  return {
    hold: () => {
      let open = (): void => {};
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

const skeletons = (): number => all(doc().body, '.skeleton').length;

test('the real shell: a refresh of the same place keeps the page while the answer is slow (no skeleton, so the scroll position survives)', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom, tick }) => {
    const slow = slowDamageReads();
    let release = (): void => {};
    try {
      const shell = await openShell(dom);
      release = slow.hold();
      // Delete my own report: the view calls the real app.refresh(), and that answer is held back.
      void byText(shell.card() as FakeElement, 'button', S.delete).fire('click');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      tick(1000); // far beyond the 120 ms after which a slow answer used to swap the page for a skeleton
      assert.equal(skeletons(), 0, 'the old page stays until the new one is ready');
      assert.ok(shell.card(), 'the list the person was scrolling is still there');
      release();
      await until(() => shell.card() === null, 'the list to be drawn without the report once the answer is in');
      assert.equal(skeletons(), 0);
    } finally {
      release();
      await closeShell();
    }
  }));

test('the real shell: walking to a place shows a skeleton once its answer is slow, and not before', () =>
  withClient({ now: NOW, routes: routes() }, async ({ dom, tick }) => {
    const slow = slowDamageReads();
    let release = (): void => {};
    try {
      const shell = await openShell(dom);
      release = slow.hold();
      shell.go('#/car?edit=1'); // a walk (hashchange), the same screen with another address
      for (let i = 0; i < 20; i++) await Promise.resolve();
      tick(100);
      assert.equal(skeletons(), 0, 'a quick answer must not flash a skeleton');
      tick(100);
      assert.equal(skeletons(), 1, 'a slow one shows it');
      release();
      await until(() => skeletons() === 0, 'the screen to be drawn once the answer is in');
    } finally {
      release();
      await closeShell();
    }
  }));

// ------------------------------------------------------------------ the background refresh keeps Start when the network is not there yet

test('the real shell: when the app comes back to the front and the network is not ready, Start keeps its blocks instead of turning into error blocks', () => {
  const down = { on: false };
  const base = routes({
    'GET /api/reservations': () => ({ items: [] }),
    'GET /api/usage': () => ({ items: [] }),
    'GET /api/fuel': () => ({ items: [], balances: [] }),
  });
  // Everything but the sign-in check fails once `down` is set: what a phone sees for a moment after it wakes up.
  const flaky: Routes = Object.fromEntries(Object.entries(base).map(([key, handler]) => [key, (call: Parameters<typeof handler>[0]) => (down.on && key !== 'GET /api/auth/me' ? refuse(503, 'unavailable') : handler(call))]));
  return withClient({ now: NOW, routes: flaky }, async ({ dom, api }) => {
    try {
      await openShell(dom, '#/home', () => doc().querySelector('.car-now') !== null);
      const reads = (path: string): number => api.calls.filter((c) => c.method === 'GET' && c.path === path).length;
      const blocks = (): string[] => all(doc().body, '[data-block]').map((b) => b.textContent);
      const was = blocks();
      assert.equal(all(doc().body, '[role="alert"]').length, 0);

      down.on = true;
      dom.emitDocument('visibilitychange');
      await until(() => reads('/api/damage') === 2 && reads('/api/car/apk') === 2 && reads('/api/fuel') === 2, 'the refresh to ask again');
      for (let i = 0; i < 40; i++) await Promise.resolve();
      assert.equal(all(doc().body, '[role="alert"]').length, 0, 'no block says it could not be loaded');
      assert.deepEqual(blocks(), was, 'the page reads as it did');
      assert.ok(doc().querySelector('.car-now'));
    } finally {
      await closeShell();
    }
  });
});

test('the real shell: Opnieuw proberen on an error page shows a skeleton while it tries again', () =>
  withClient({ now: NOW, routes: routes({ 'GET /api/damage': () => refuse(500, 'internal_error') }) }, async ({ dom, tick }) => {
    const slow = slowDamageReads();
    let release = (): void => {};
    try {
      await openShell(dom, '#/car', () => doc().querySelector('.error-card') !== null);
      release = slow.hold();
      void byText(doc().body, 'button', S.retry).fire('click');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      tick(200);
      assert.equal(skeletons(), 1, 'there is nothing worth keeping on an error page: the retry shows that it is working');
      assert.equal(all(doc().body, '.error-card').length, 0);
      release();
      await until(() => doc().querySelector('.error-card') !== null, 'the error page again (the stub still fails)');
    } finally {
      release();
      await closeShell();
    }
  }));
