// What the admin page does, one action at a time, on the redesigned page: every tab loads, a user is added (and a
// generated password is shown once), deactivating and resetting ask first, renaming is a field in a drawer (it used to be
// a browser prompt), a reservation is changed in a drawer and cancelled after a question, a drive is deleted after a
// question, and the retention run asks before it deletes. test/admin.test.ts walks the drives tab in more detail.
//
// public/admin/admin.js starts itself when it is loaded and takes #admin and #toast from the page, so every case loads
// its own copy of the script (the ?case suffix) into a fresh fake page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../public/strings.js';
import { resetTableStates } from '../public/admin/table.js';
import { fmtWhen } from '../public/dom.js';
import { ADMIN, ANNA, BEN, NOW, Reply, TZ, all, at, byText, control, doc, fieldRow, finding, odometerChain, one, reading, refuse, reservation, typeInto, until, usage, withClient, type FakeDom, type FakeElement, type Routes } from './fake-dom.ts';
import type { Json } from './helpers.ts';

const A = S.admin;
let seq = 0;

const retention = {
  window: { from: at(-100_000), to: at(100_000) },
  windowMonths: 6,
  timeZone: TZ,
  cutoff: at(-90_000),
  lastPurgeAt: null,
  lastPurge: null,
  lastMaintenanceDay: '2026-06-15',
  lastBackupAt: at(-600),
  lastBackupFile: 'car-2026-06-15.db',
  counts: { reservations: 3, usage: 4, fuel: 1, fuelRequests: 0, tickets: 0, odometerExplained: 0, damageReports: 0 },
  oldest: { reservationEnd: at(-5000), usageEnd: at(-4000), fuelAt: null, ticketAt: null, damageRepairedOn: null },
  backups: [{ file: 'car-2026-06-15.db', size: 20480 }],
  backupKeep: 7,
};

const baseRoutes = (over: Routes = {}): Routes => ({
  'GET /api/auth/me': () => ({ user: ADMIN, timeZone: TZ, windowMonths: 6, serverTime: NOW }),
  'GET /api/admin/users': () => ({ users: [ANNA, BEN, ADMIN] }),
  'GET /api/reservations': () => ({ items: [reservation({ id: 7, start: at(-300), end: at(-240), note: 'Visit to Oma' })] }),
  'GET /api/usage': () => ({ items: [usage({ id: 3, can: { edit: true, delete: true } })] }),
  'GET /api/usage/pending': () => ({ items: [], count: 0 }),
  'GET /api/admin/retention': () => retention,
  ...over,
});

/** Load a fresh copy of the admin page into the fake page and wait for its first tab. */
async function openAdmin(dom: FakeDom): Promise<{ root: FakeElement; toastEl: FakeElement; tab: (name: string) => FakeElement }> {
  resetTableStates();
  const make = (id: string): FakeElement => {
    const el = doc().createElement('div') as unknown as FakeElement;
    el.id = id;
    return dom.mount(el);
  };
  const root = make('admin');
  const toastEl = make('toast');
  Object.defineProperty(globalThis, 'location', { value: { replace: () => {} }, configurable: true, writable: true });
  await import(`../public/admin/admin.js?case=${++seq}`);
  await until(() => all(root, '.admin-tabs button').length === 4 && all(root, 'table').length > 0, 'the admin page to start');
  return { root, toastEl, tab: (name) => one(root, `button[data-tab="${name}"]`) };
}
/** Let the page finish what an action started (every action reloads its tab) before the fake page goes away. */
async function closeAdmin(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  delete (globalThis as Json)['location'];
}
/** Wait until the users tab has been asked for `times` times and drawn (every action reloads the tab; two reloads at once would race). */
async function usersReloaded(api: { calls: Array<{ method: string; path: string }> }, times: number): Promise<void> {
  await until(() => api.calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/users').length >= times, 'the users tab to be asked for');
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
const wrapOf = (root: FakeElement, label: string): FakeElement => {
  const wrap = all(root, '.table-wrap').find((w) => w.getAttribute('aria-label') === label);
  assert.ok(wrap, `the table "${label}" is on the page`);
  return wrap;
};
const bodyRows = (wrap: FakeElement): FakeElement[] => all(wrap, 'tbody tr');
const rowOf = (wrap: FakeElement, text: string): FakeElement => {
  const row = bodyRows(wrap).find((tr) => tr.textContent.includes(text));
  assert.ok(row, `a row with "${text}"`);
  return row;
};

test('admin: every tab loads and says which one is open; the page is a header, four sections and the theme choice', () =>
  withClient({ now: NOW, routes: baseRoutes() }, async ({ dom }) => {
    try {
      const { root, tab } = await openAdmin(dom);
      assert.equal(one(root, 'h1').textContent, A.title);
      assert.ok(all(root, 'a').some((a) => a.getAttribute('href') === '/' && a.textContent === A.backToApp));
      assert.deepEqual(all(root, '.seg').map((b) => b.textContent), ['Systeem', 'Licht', 'Donker'], 'the theme choice is on the admin page too');
      assert.deepEqual(all(root, '.admin-tabs button').map((b) => b.textContent), [A.tabs.users, A.tabs.reservations, A.tabs.usage, A.tabs.retention]);
      for (const [name, probe] of [
        ['users', () => wrapOf(root, A.tabs.users)],
        ['reservations', () => wrapOf(root, A.tabs.reservations)],
        ['usage', () => wrapOf(root, A.tabs.usage)],
        ['retention', () => one(root, 'dl.kv')],
      ] as const) {
        await tab(name).fire('click');
        await until(() => {
          try {
            probe();
            return true;
          } catch {
            return false;
          }
        }, `the ${name} tab`);
        assert.equal(tab(name).getAttribute('aria-pressed'), 'true', `${name} is marked as the open one`);
        assert.equal(all(root, '.admin-tabs button').filter((b) => b.getAttribute('aria-pressed') === 'true').length, 1);
      }
      assert.ok(all(root, 'h2').some((h2) => h2.textContent === A.retention.title));
    } finally {
      await closeAdmin();
    }
  }));

test('admin users: adding a user sends the form, shows a generated password once in a card that takes focus, and nothing else leaks it', () =>
  withClient(
    {
      now: NOW,
      routes: baseRoutes({ 'POST /api/admin/users': () => new Reply({ user: { id: 9, displayName: 'Cor' }, generatedPassword: 'abc-def-ghi-jkl' }, 201) }),
    },
    async ({ dom, api }) => {
      try {
        const { root, toastEl } = await openAdmin(dom);
        const form = one(root, 'form');
        await typeInto(control(fieldRow(form, A.users.username)), 'cor');
        await typeInto(control(fieldRow(form, A.users.displayName)), 'Cor');
        await form.fire('submit');
        await until(() => all(root, '.secret-card').length === 1, 'the generated password');
        assert.deepEqual(api.writes().map((c) => [c.method, c.path, c.body]), [['POST', '/api/admin/users', { username: 'cor', displayName: 'Cor', role: 'member' }]]);
        assert.equal(one(root, '.secret').textContent, 'abc-def-ghi-jkl');
        assert.equal(toastEl.textContent, A.users.created);
        assert.equal(doc().activeElement, one(root, '.secret-card'), 'focus goes to the password card');
      } finally {
        await closeAdmin();
      }
    },
  ));

test('admin users: deactivating asks first, a role change asks nothing, resetting a password asks and then shows the new one once', () =>
  withClient(
    {
      now: NOW,
      routes: baseRoutes({
        'PATCH /api/admin/users/2': () => ({ user: BEN }),
        'POST /api/admin/users/2/password': () => new Reply({ generatedPassword: 'new-pass-word-123' }),
      }),
    },
    async ({ dom, api }) => {
      try {
        const { root } = await openAdmin(dom);
        const ben = () => rowOf(wrapOf(root, A.tabs.users), 'Ben');
        dom.answer = false;
        await byText(ben(), 'button', A.users.deactivate).fire('click');
        assert.deepEqual(api.writes(), [], 'no was no');
        assert.equal(dom.dialogs.at(-1)?.querySelector('[data-answer="yes"]')?.textContent, A.users.deactivate, 'the sheet names the action');
        dom.answer = true;
        await byText(ben(), 'button', A.users.deactivate).fire('click');
        await until(() => api.writes().length === 1, 'the deactivation');
        assert.deepEqual(api.writes()[0]?.body, { active: false });
        assert.deepEqual(dom.confirms, [A.users.confirmDeactivate, A.users.confirmDeactivate]);

        await usersReloaded(api, 2);
        await byText(ben(), 'button', A.users.makeAdmin).fire('click');
        await until(() => api.writes().length === 2, 'the role change');
        assert.deepEqual(api.writes()[1]?.body, { role: 'admin' });
        assert.equal(dom.confirms.length, 2, 'making somebody admin asks nothing');

        await usersReloaded(api, 3);
        await byText(ben(), 'button', A.users.resetPassword).fire('click');
        await until(() => all(root, '.secret-card').length === 1, 'the new password');
        assert.equal(dom.confirms.at(-1), A.users.confirmReset);
        assert.equal(one(root, '.secret').textContent, 'new-pass-word-123');
      } finally {
        await closeAdmin();
      }
    },
  ));

const adminToken = (id: number, userName: string, name: string, over: Json = {}): Json => ({ id, userId: id, userName, name, createdAt: at(-1000), lastUsedAt: null, ...over });

test('admin users: every access token of the household is listed under the users, and revoking one asks first; the page still has exactly four tabs', () =>
  withClient(
    {
      now: NOW,
      routes: baseRoutes({
        'GET /api/admin/tokens': () => ({ items: [adminToken(5, 'Anna', 'Woonkamerscherm', { lastUsedAt: at(-30) }), adminToken(6, 'Ben', 'Google-script')], max: 5 }),
        'DELETE /api/admin/tokens/5': () => new Reply(null, 204),
      }),
    },
    async ({ dom, api }) => {
      try {
        const { root, toastEl } = await openAdmin(dom);
        assert.equal(all(root, '.admin-tabs button').length, 4, 'the tokens are a section of the users tab, not a tab of their own');
        assert.ok(all(root, 'h2').some((h2) => h2.textContent === A.tokens.title));
        assert.ok(all(root, 'p.hint').some((p) => p.textContent === A.tokens.intro));
        const wrap = wrapOf(root, A.tokens.title);
        assert.deepEqual(all(wrap, 'th').map((th) => th.textContent), [A.tokens.person, A.tokens.name, A.tokens.made, A.tokens.lastUsed, A.actions], 'the actions column is named for a screen reader');
        assert.equal(bodyRows(wrap).length, 2);
        const anna = rowOf(wrap, 'Anna');
        assert.ok(anna.textContent.includes('Woonkamerscherm') && anna.textContent.includes(fmtWhen(at(-30), TZ)), 'who, what, and when it was last used');
        assert.ok(rowOf(wrap, 'Ben').textContent.includes(A.tokens.neverUsed));
        assert.ok(!root.textContent.includes('pat_'), 'never a token');
        assert.equal(byText(anna, 'button', A.tokens.revoke).getAttribute('aria-label'), A.tokens.revokeLabel('Anna', 'Woonkamerscherm'));
        assert.ok(A.tokens.revokeLabel('Anna', 'Woonkamerscherm').startsWith(A.tokens.revoke), 'the accessible name starts with the visible text (WCAG 2.5.3)');

        dom.answer = false;
        await byText(anna, 'button', A.tokens.revoke).fire('click');
        assert.equal(dom.confirms.at(-1), A.tokens.confirmRevoke('Anna', 'Woonkamerscherm'));
        assert.deepEqual(api.writes(), [], 'a no revokes nothing');
        dom.answer = true;
        await byText(anna, 'button', A.tokens.revoke).fire('click');
        await until(() => api.writes().length === 1, 'the revoke');
        assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), ['DELETE /api/admin/tokens/5']);
        await until(() => toastEl.textContent === A.tokens.revokedToast, 'the toast');
        await usersReloaded(api, 2);
        assert.ok(api.calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/tokens').length >= 2, 'the list was asked for again');
      } finally {
        await closeAdmin();
      }
    },
  ));

test('admin users: with no tokens the section says so, and when the token list cannot be loaded the users tab still works', async () => {
  await withClient({ now: NOW, routes: baseRoutes() }, async ({ dom }) => {
    try {
      const { root } = await openAdmin(dom);
      assert.ok(all(root, 'h2').some((h2) => h2.textContent === A.tokens.title));
      assert.ok(all(root, '.empty p').some((p) => p.textContent === A.tokens.none));
    } finally {
      await closeAdmin();
    }
  });
  await withClient({ now: NOW, routes: baseRoutes({ 'GET /api/admin/tokens': () => refuse(500, 'internal') }) }, async ({ dom }) => {
    try {
      const { root } = await openAdmin(dom);
      assert.equal(wrapOf(root, A.tabs.users).getAttribute('role'), 'region', 'the users table is there');
      assert.ok(!all(root, 'h2').some((h2) => h2.textContent === A.tokens.title), 'and the section is left out');
    } finally {
      await closeAdmin();
    }
  });
});

test('admin users: renaming is a field in a drawer, an empty name is refused on the field, and a name is sent trimmed', () =>
  withClient({ now: NOW, routes: baseRoutes({ 'PATCH /api/admin/users/2': () => ({ user: BEN }) }) }, async ({ dom, api }) => {
    try {
      const { root, toastEl } = await openAdmin(dom);
      await byText(rowOf(wrapOf(root, A.tabs.users), 'Ben'), 'button', A.users.rename).fire('click');
      const drawer = one(dom.body, 'dialog.drawer');
      assert.equal(one(drawer, '.sheet-title').textContent, A.users.rename);
      assert.equal(dom.confirms.length, 0, 'no browser prompt');
      const form = one(drawer, 'form.editor');
      const input = control(fieldRow(form, A.users.renamePrompt));
      assert.equal(input.value, 'Ben');
      assert.equal(doc().activeElement, input, 'the field has focus');
      await typeInto(input, '   ');
      await form.fire('submit');
      assert.deepEqual(api.writes(), [], 'nothing is sent for an empty name');
      assert.equal(one(fieldRow(form, A.users.renamePrompt), '.field-error').textContent, S.fieldErrors.required);
      await typeInto(input, '  Benjamin ');
      await form.fire('submit');
      await until(() => api.writes().length === 1, 'the rename');
      assert.deepEqual(api.writes()[0]?.body, { displayName: 'Benjamin' });
      await until(() => toastEl.textContent === A.users.updated, 'the confirmation');
      assert.equal(all(dom.body, 'dialog').length, 0, 'the drawer closed');
    } finally {
      await closeAdmin();
    }
  }));

test('admin reservations: Wijzigen opens a drawer with the editor, saving sends the change and closes it; cancelling asks first', () =>
  withClient(
    {
      now: NOW,
      routes: baseRoutes({ 'PATCH /api/reservations/7': () => ({ reservation: {} }), 'DELETE /api/reservations/7': () => new Reply(null, 204) }),
    },
    async ({ dom, api }) => {
      try {
        const { root, tab, toastEl } = await openAdmin(dom);
        await tab('reservations').fire('click');
        await until(() => all(root, '.table-wrap').some((w) => w.getAttribute('aria-label') === A.tabs.reservations), 'the reservations');
        const row = () => rowOf(wrapOf(root, A.tabs.reservations), 'Visit to Oma');
        await byText(row(), 'button', S.edit).fire('click');
        const drawer = one(dom.body, 'dialog.drawer');
        assert.match(one(drawer, '.sheet-title').textContent, new RegExp(`^${A.reservations.editTitle} #7`));
        const form = one(drawer, 'form.editor');
        await typeInto(control(fieldRow(form, S.reserve.note)), 'Oma, en terug');
        await form.fire('submit');
        await until(() => api.writes().length === 1, 'the change');
        assert.equal(api.writes()[0]?.path, '/api/reservations/7');
        assert.equal(api.writes()[0]?.body['note'], 'Oma, en terug');
        await until(() => toastEl.textContent === A.reservations.saved && all(dom.body, 'dialog').length === 0, 'the drawer to close');

        dom.answer = false;
        await byText(row(), 'button', A.reservations.cancelReservation).fire('click');
        assert.equal(api.writes().length, 1, 'no was no');
        dom.answer = true;
        await byText(row(), 'button', A.reservations.cancelReservation).fire('click');
        await until(() => api.writes().length === 2, 'the cancel');
        assert.equal(api.writes()[1]?.path, '/api/reservations/7');
        assert.deepEqual(dom.confirms, [A.reservations.confirmCancel, A.reservations.confirmCancel]);
      } finally {
        await closeAdmin();
      }
    },
  ));

test('admin drives: deleting asks first; the drive drawer opens with its title and cancels without sending anything', () =>
  withClient({ now: NOW, routes: baseRoutes({ 'DELETE /api/usage/3': () => new Reply(null, 204) }) }, async ({ dom, api }) => {
    try {
      const { root, tab } = await openAdmin(dom);
      await tab('usage').fire('click');
      await until(() => all(root, '.table-wrap').some((w) => w.getAttribute('aria-label') === A.tabs.usage), 'the drives');
      const row = () => bodyRows(wrapOf(root, A.tabs.usage))[0] as FakeElement;

      await byText(row(), 'button', S.edit).fire('click');
      const drawer = one(dom.body, 'dialog.drawer');
      assert.equal(one(drawer, '.sheet-title').textContent, `${A.usage.editTitle} #3`);
      await byText(drawer, 'button', S.cancel).fire('click');
      assert.equal(all(dom.body, 'dialog').length, 0, 'Annuleren closes the drawer');
      assert.deepEqual(api.writes(), [], 'and sends nothing');

      dom.answer = false;
      await byText(row(), 'button', S.delete).fire('click');
      assert.deepEqual(api.writes(), []);
      dom.answer = true;
      await byText(row(), 'button', S.delete).fire('click');
      await until(() => api.writes().length === 1, 'the delete');
      assert.equal(api.writes()[0]?.path, '/api/usage/3');
      assert.equal(dom.dialogs.at(-1)?.querySelector('[data-answer="yes"]')?.textContent, S.delete);
    } finally {
      await closeAdmin();
    }
  }));

// The kilometre check is shared with the member app, so the admin page can take an explanation back with "Ongedaan maken"
// (a deferred delete, public/undo.js). Its links open the member app, a full page load: the delete must not be lost to that.
const explainedChain = () => {
  const prev = reading({ source: 'drive-end', id: 3, km: 41120, at: at(-480), userId: 2, userName: 'Ben' });
  const next = reading({ source: 'drive-start', id: 4, km: 41300, at: at(-300), userId: 1, userName: 'Anna' });
  const item = finding(prev, next, { explained: { id: 11, note: 'An outsider drove it', byId: 2, byName: 'Ben', at: at(-30) }, can: { explain: true, unexplain: true } });
  return odometerChain([prev, next], [item]);
};
const removeButtons = (root: FakeElement): FakeElement[] => all(root, 'button').filter((b) => b.textContent === S.kmcheck.removeExplanation);

test('admin drives: taking an explanation back is undoable, and the delete is sent when the page goes away, not lost', () =>
  withClient({ now: NOW, routes: baseRoutes({ 'GET /api/odometer': () => explainedChain(), 'DELETE /api/odometer/explained/11': () => new Reply(null, 204) }) }, async ({ dom, api }) => {
    try {
      const { root, toastEl, tab } = await openAdmin(dom);
      await tab('usage').fire('click');
      await until(() => removeButtons(root).length === 1, 'the kilometre check with its explained finding');
      const reads = (): number => api.calls.filter((c) => c.method === 'GET' && c.path === '/api/odometer').length;
      const before = reads();

      await (removeButtons(root)[0] as FakeElement).fire('click');
      assert.deepEqual(dom.confirms, [], 'no question: it can be taken back instead');
      assert.deepEqual(api.writes(), [], 'nothing is sent yet');
      assert.equal(toastEl.querySelector('.toast-action')?.textContent, S.undo.action);
      // The tab is rebuilt at once (the finding is open again) and the rebuild did not send the delete.
      await until(() => reads() > before && removeButtons(root).length === 0, 'the tab to be drawn again with the finding open');
      assert.deepEqual(api.writes(), [], 'a reload of the tab must not send a delete that is still in its window');

      // The person follows a link to the member app (or closes the tab): the page goes away and the delete goes with it.
      dom.window.emit('pagehide');
      await until(() => api.writes().length === 1, 'the delete when the page goes away');
      assert.equal(`${api.writes()[0]?.method} ${api.writes()[0]?.path}`, 'DELETE /api/odometer/explained/11');
    } finally {
      await closeAdmin();
    }
  }));

test('admin drives: Ongedaan maken brings the explanation back and nothing is ever sent', () =>
  withClient({ now: NOW, routes: baseRoutes({ 'GET /api/odometer': () => explainedChain() }) }, async ({ dom, api, tick }) => {
    try {
      const { root, toastEl, tab } = await openAdmin(dom);
      await tab('usage').fire('click');
      await until(() => removeButtons(root).length === 1, 'the explained finding');
      await (removeButtons(root)[0] as FakeElement).fire('click');
      await until(() => removeButtons(root).length === 0, 'the finding to be open again');
      await toastEl.querySelector('.toast-action')?.fire('click');
      await until(() => removeButtons(root).length === 1, 'the explanation to be back');
      tick(20_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.deepEqual(api.writes(), [], 'taken back: the explanation stays');
    } finally {
      await closeAdmin();
    }
  }));

test('admin retention: running the clean-up asks first and says what it will do; the backups are listed', () =>
  withClient(
    {
      now: NOW,
      routes: baseRoutes({ 'POST /api/admin/retention/run': () => ({ result: { reservations: 1, usage: 2, fuel: 0, tickets: 0, odometerExplained: 0, damageReports: 0 } }) }),
    },
    async ({ dom, api }) => {
      try {
        const { root, tab } = await openAdmin(dom);
        await tab('retention').fire('click');
        await until(() => all(root, 'dl.kv').length === 1, 'the retention tab');
        assert.ok(wrapOf(root, A.retention.backups).textContent.includes('car-2026-06-15.db'));
        dom.answer = false;
        await byText(root, 'button', A.retention.runNow).fire('click');
        assert.deepEqual(api.writes(), []);
        assert.equal(dom.confirms.at(-1), A.retention.confirmRun);
        dom.answer = true;
        await byText(root, 'button', A.retention.runNow).fire('click');
        await until(() => api.writes().length === 1, 'the run');
        assert.equal(api.writes()[0]?.path, '/api/admin/retention/run');
        assert.equal(dom.dialogs.at(-1)?.querySelector('[data-answer="yes"]')?.textContent, A.retention.runNow);
      } finally {
        await closeAdmin();
      }
    },
  ));

test('admin users: a header sorts the table, and the choice survives the rebuild after an action', () =>
  withClient({ now: NOW, routes: baseRoutes({ 'PATCH /api/admin/users/2': () => ({ user: BEN }) }) }, async ({ dom }) => {
    try {
      const { root } = await openAdmin(dom);
      const names = (): string[] => bodyRows(wrapOf(root, A.tabs.users)).map((tr) => (all(tr, 'td')[0] as FakeElement).textContent.replace(/\(.*\)/, '').trim());
      assert.deepEqual(names(), ['Anna', 'Ben', 'Root']);
      const sort = (): FakeElement => all(root, 'button.sort').find((b) => b.getAttribute('aria-label') === S.ui.sortBy(A.users.name)) as FakeElement;
      await sort().fire('click');
      await sort().fire('click');
      assert.deepEqual(names(), ['Root', 'Ben', 'Anna'], 'descending');
      await byText(rowOf(wrapOf(root, A.tabs.users), 'Ben'), 'button', A.users.makeAdmin).fire('click');
      await until(() => dom.body.querySelectorAll('th[aria-sort]').length === 1, 'the rebuilt table');
      assert.deepEqual(names(), ['Root', 'Ben', 'Anna'], 'the order is kept after the rebuild');
    } finally {
      await closeAdmin();
    }
  }));
