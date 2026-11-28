// The Account page cards for the calendar link and the access tokens (public/views/integrations.js), in the fake page:
// what they say, that the secrets are shown the way they should be (a token once, an https address only), that
// replacing and revoking ask first, that nothing is kept in storage, and that a card whose request fails is just not there.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtWhen } from '../public/dom.js';
import { S } from '../public/strings.js';
import { render as renderAccount } from '../public/views/account.js';
import { calendarCard, feedAddress, tokensCard } from '../public/views/integrations.js';
import { ANNA, NOW, Reply, all, at, byText, control, errorOf, fieldRow, makeApp, one, refuse, typeInto, until, withClient, type FakeElement, type Routes } from './fake-dom.ts';
import type { Json } from './helpers.ts';

const C = S.account.calendar;
const T = S.account.tokens;
const TZ = 'Europe/Amsterdam';
const SECRET_A = 'A'.repeat(43);
const SECRET_B = 'B'.repeat(43);
const TOKEN = `pat_${'t'.repeat(43)}`;

/** A clipboard that works, or one that refuses (no permission): what a page on a phone may get. */
function installClipboard(mode: 'works' | 'refuses'): { written: string[]; uninstall(): void } {
  const g = globalThis as Json;
  const saved = Object.getOwnPropertyDescriptor(g, 'navigator');
  const written: string[] = [];
  const nav = {
    clipboard: {
      writeText: async (text: string) => {
        if (mode === 'refuses') throw new Error('NotAllowedError');
        written.push(text);
      },
    },
  };
  Object.defineProperty(g, 'navigator', { value: nav, configurable: true, writable: true });
  return {
    written,
    uninstall() {
      if (saved) Object.defineProperty(g, 'navigator', saved);
      else delete g['navigator'];
    },
  };
}

const feedOf = (secret: string): Json => ({ path: `/api/calendar/${secret}.ics`, createdAt: at(-5) });

/**
 * Run a test with the page served from https://car.example, the way the installed app is. The window is made before
 * withClient() installs the fake page, which keeps what an existing window already has (installFakeDom adds to it).
 */
async function atCarExample<R>(fn: () => Promise<R>): Promise<R> {
  const g = globalThis as Json;
  const saved = Object.getOwnPropertyDescriptor(g, 'window');
  Object.defineProperty(g, 'window', { value: { location: { host: 'car.example' } }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(g, 'window', saved);
    else delete g['window'];
  }
}

const textOf = (el: FakeElement): string => el.textContent;
const dialogs = (dom: { dialogs: FakeElement[] }): FakeElement[] => dom.dialogs.filter((d) => d.parent !== null && d.open);

// ---------------------------------------------------------------------- the calendar link

test('feedAddress: an https address on this site, never webcal or plain http', () => {
  assert.equal(feedAddress('/api/calendar/abc.ics', 'car.example'), 'https://car.example/api/calendar/abc.ics');
  assert.doesNotMatch(feedAddress('/api/calendar/abc.ics', 'localhost:3000'), /^(webcal|http:)/);
});

test('calendar card: no link yet offers to make one, then shows an https address that can be copied, replaced (after asking) and turned off (after asking)', async () => {
  const me = makeApp(ANNA);
  let current: string | null = null;
  const routes: Routes = {
    'GET /api/calendar-feed': () => ({ feed: current ? feedOf(current) : null }),
    'POST /api/calendar-feed': () => {
      current = SECRET_A;
      return new Reply({ feed: feedOf(SECRET_A) }, 201);
    },
    'POST /api/calendar-feed/new-link': () => {
      current = SECRET_B;
      return new Reply({ feed: feedOf(SECRET_B) }, 201);
    },
    'DELETE /api/calendar-feed': () => {
      current = null;
      return new Reply(null, 204);
    },
  };
  const clipboard = installClipboard('works');
  try {
    await atCarExample(() =>
      withClient({ now: NOW, routes }, async ({ dom, api }) => {
        const card = dom.mount(await calendarCard(me.app));
        assert.equal(textOf(one(card, 'h3')), C.title);
        assert.ok(all(card, 'p').some((p) => textOf(p) === C.intro));
        assert.ok(all(card, 'p').some((p) => textOf(p) === C.none));
        assert.equal(all(card, 'textarea').length, 0, 'there is no address before there is a link');

        await byText(card, 'button', C.create).fire('click');
        await until(() => all(card, 'textarea').length === 1, 'the link');
        const link = one(card, 'textarea');
        const address = `https://car.example/api/calendar/${SECRET_A}.ics`;
        assert.equal(link.value, address);
        assert.equal(link.readOnly, true, 'the address is for copying, not for typing in');
        assert.ok(all(card, 'label').some((l) => textOf(l) === C.linkLabel), 'the address has a visible label');
        assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), ['POST /api/calendar-feed']);
        assert.deepEqual(me.toasts, [{ message: C.createdToast, isError: false }]);
        assert.equal(dom.focused(), link, 'focus moves to the new link, not to nowhere');
        assert.doesNotMatch(textOf(card), /webcal|http:\/\//, 'only an https address is offered');
        assert.ok(all(card, 'p').some((p) => textOf(p) === C.secretNote), 'it says to keep the link private');
        assert.ok(all(card, 'p').some((p) => textOf(p) === C.slow), 'and that Google is slow to refresh');

        await byText(card, 'button', C.copy).fire('click');
        await until(() => all(card, '[role="status"]').some((p) => textOf(p) === C.copied), 'the copy message');
        assert.deepEqual(clipboard.written, [address]);

        // A new link asks first: no does nothing.
        dom.answer = false;
        await byText(card, 'button', C.renew).fire('click');
        assert.equal(dom.confirms.at(-1), C.confirmRenew);
        assert.equal(api.writes().length, 1, 'a no sends nothing');
        assert.equal(one(card, 'textarea').value, address);
        dom.answer = true;
        await byText(card, 'button', C.renew).fire('click');
        await until(() => one(card, 'textarea').value.includes(SECRET_B), 'the new link');
        assert.equal(api.writes().at(-1)?.path, '/api/calendar-feed/new-link');
        assert.equal(me.toasts.at(-1)?.message, C.renewedToast);
        assert.ok(!textOf(card).includes(SECRET_A) && !one(card, 'textarea').value.includes(SECRET_A), 'the old address is gone from the page');

        // Turning it off asks first as well.
        dom.answer = false;
        await byText(card, 'button', C.turnOff).fire('click');
        assert.equal(dom.confirms.at(-1), C.confirmOff);
        assert.equal(api.writes().length, 2);
        dom.answer = true;
        await byText(card, 'button', C.turnOff).fire('click');
        await until(() => all(card, 'textarea').length === 0, 'the card without a link');
        assert.deepEqual(api.writes().at(-1) && [api.writes().at(-1)?.method, api.writes().at(-1)?.path], ['DELETE', '/api/calendar-feed']);
        assert.equal(me.toasts.at(-1)?.message, C.offToast);
        assert.ok(all(card, 'p').some((p) => textOf(p) === C.none));
        assert.equal(dom.focused(), byText(card, 'button', C.create), 'focus stays in the card');
        assert.equal(dom.storage.data.size, 0, 'nothing is kept in the browser');
      }),
    );
  } finally {
    clipboard.uninstall();
  }
});

test('calendar card: when the clipboard refuses the address is selected for copying by hand', async () => {
  const me = makeApp(ANNA);
  const clipboard = installClipboard('refuses');
  try {
    await atCarExample(() =>
      withClient({ now: NOW, routes: { 'GET /api/calendar-feed': () => ({ feed: feedOf(SECRET_A) }) } }, async ({ dom }) => {
        const card = dom.mount(await calendarCard(me.app));
        await byText(card, 'button', C.copy).fire('click');
        await until(() => all(card, '[role="status"]').some((p) => textOf(p) === C.copyFailed), 'the fallback message');
        assert.equal(dom.focused(), one(card, 'textarea'), 'the address has focus, ready to be copied');
      }),
    );
  } finally {
    clipboard.uninstall();
  }
});

test('calendar card: the answer to a press stands right under the buttons, before the notes, with a link and without one', async () => {
  const me = makeApp(ANNA);
  const clipboard = installClipboard('works');
  try {
    await atCarExample(() =>
      withClient({ now: NOW, routes: { 'GET /api/calendar-feed': () => ({ feed: feedOf(SECRET_A) }) } }, async ({ dom }) => {
        const card = dom.mount(await calendarCard(me.app));
        const status = one(card, '[role="status"]');
        const parts = (status.parent as FakeElement).children;
        assert.equal(parts[parts.indexOf(status) - 1], one(card, '.actions'), 'the message follows the buttons directly');
        assert.equal(textOf(parts[parts.indexOf(status) + 1] as FakeElement), C.secretNote, 'and the notes come after it');
        await byText(card, 'button', C.copy).fire('click');
        await until(() => textOf(status) === C.copied, 'the copy message');
      }),
    );
  } finally {
    clipboard.uninstall();
  }
  await withClient({ now: NOW, routes: { 'GET /api/calendar-feed': () => ({ feed: null }) } }, async ({ dom }) => {
    const card = dom.mount(await calendarCard(me.app));
    const status = one(card, '[role="status"]');
    const parts = (status.parent as FakeElement).children;
    assert.equal(parts[parts.indexOf(status) - 1], one(card, '.actions'), 'also under the Make button, where an error would show');
  });
});

test('calendar card: a refused request says so under the card and keeps the link', async () => {
  const me = makeApp(ANNA);
  await atCarExample(() =>
    withClient(
      {
        now: NOW,
        routes: {
          'GET /api/calendar-feed': () => ({ feed: feedOf(SECRET_A) }),
          'POST /api/calendar-feed/new-link': () => refuse(500, 'internal'),
        },
      },
      async ({ dom }) => {
        const card = dom.mount(await calendarCard(me.app));
        await byText(card, 'button', C.renew).fire('click');
        await until(() => all(card, '[role="status"]').some((p) => textOf(p) === S.errors.internal), 'the error');
        assert.ok(one(card, 'textarea').value.includes(SECRET_A), 'the link is still the old one');
        assert.equal(byText(card, 'button', C.renew).disabled, false, 'and the button works again');
      },
    ),
  );
});

// ------------------------------------------------------------------------- access tokens

const token = (over: Json = {}): Json => ({ id: 1, name: 'Woonkamerscherm', createdAt: at(-1000), lastUsedAt: null, ...over });

test('tokens card: lists each token with its name, when it was made and when it was last used, and a Revoke button that names the token', async () => {
  const me = makeApp(ANNA);
  const items = [token({ id: 1, name: 'Woonkamerscherm', lastUsedAt: at(-30) }), token({ id: 2, name: 'Google-script', createdAt: at(-5000) })];
  await withClient({ now: NOW, routes: { 'GET /api/tokens': () => ({ items, max: 5 }) } }, async ({ dom }) => {
    const card = dom.mount(await tokensCard(me.app));
    assert.equal(textOf(one(card, 'h3')), T.title);
    assert.ok(all(card, 'p').some((p) => textOf(p) === T.intro));
    const rows = all(card, 'li');
    assert.equal(rows.length, 2);
    assert.deepEqual(all(rows[0], '.token-name').map(textOf), ['Woonkamerscherm']);
    assert.deepEqual(all(rows[0], '.token-meta').map(textOf), [T.made(fmtWhen(at(-1000), TZ)), T.lastUsed(fmtWhen(at(-30), TZ))]);
    assert.deepEqual(all(rows[1], '.token-meta').map(textOf), [T.made(fmtWhen(at(-5000), TZ)), T.neverUsed]);
    assert.deepEqual(
      all(card, 'li button').map((b) => b.getAttribute('aria-label')),
      [T.revokeLabel('Woonkamerscherm'), T.revokeLabel('Google-script')],
      'each Revoke button says which token it is for',
    );
    for (const b of all(card, 'li button')) {
      assert.ok((b.getAttribute('aria-label') ?? '').startsWith(textOf(b)), 'the accessible name starts with the visible text (WCAG 2.5.3, as on the other row buttons)');
    }
    assert.ok(!all(card, 'p').some((p) => textOf(p) === T.none));
    assert.equal(byText(card, 'button', T.create).disabled, false);
    assert.ok(!textOf(card).includes('pat_'), 'a list never shows a token');
  });
});

test('tokens card: with no tokens it says so; at the maximum the Make button is off and the card says why', async () => {
  const me = makeApp(ANNA);
  await withClient({ now: NOW, routes: { 'GET /api/tokens': () => ({ items: [], max: 5 }) } }, async ({ dom }) => {
    const card = dom.mount(await tokensCard(me.app));
    assert.ok(all(card, 'p').some((p) => textOf(p) === T.none));
    assert.equal(all(card, 'li').length, 0);
    assert.ok(!all(card, 'p').some((p) => textOf(p) === T.limit));
  });
  const five = [1, 2, 3, 4, 5].map((id) => token({ id, name: `Token ${id}` }));
  await withClient({ now: NOW, routes: { 'GET /api/tokens': () => ({ items: five, max: 5 }) } }, async ({ dom }) => {
    const card = dom.mount(await tokensCard(me.app));
    assert.equal(byText(card, 'button', T.create).disabled, true);
    assert.ok(all(card, 'p').some((p) => textOf(p) === T.limit));
  });
});

test('tokens card: revoking asks first, and a yes removes the token from the list and puts focus back in the card', async () => {
  const me = makeApp(ANNA);
  let items = [token({ id: 1, name: 'Woonkamerscherm' }), token({ id: 2, name: 'Google-script' })];
  await withClient(
    {
      now: NOW,
      routes: {
        'GET /api/tokens': () => ({ items, max: 5 }),
        'DELETE /api/tokens/1': () => {
          items = items.filter((t) => t.id !== 1);
          return new Reply(null, 204);
        },
      },
    },
    async ({ dom, api }) => {
      const card = dom.mount(await tokensCard(me.app));
      dom.answer = false;
      await one(card, 'li button').fire('click');
      assert.equal(dom.confirms.at(-1), T.confirmRevoke('Woonkamerscherm'));
      assert.deepEqual(api.writes(), [], 'a no revokes nothing');
      assert.equal(all(card, 'li').length, 2);
      dom.answer = true;
      await one(card, 'li button').fire('click');
      await until(() => all(card, 'li').length === 1, 'the list without the revoked token');
      assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), ['DELETE /api/tokens/1']);
      assert.deepEqual(all(card, '.token-name').map(textOf), ['Google-script']);
      assert.equal(me.toasts.at(-1)?.message, T.revokedToast);
      assert.equal(dom.focused(), byText(card, 'button', T.create), 'the revoked row is gone: focus goes to the Make button');
    },
  );
});

test('tokens card: a token is made in a sheet, shown once in the next one, copied, and gone from the page and from storage when that closes', async () => {
  const me = makeApp(ANNA);
  const items: Json[] = [];
  const clipboard = installClipboard('works');
  try {
    await withClient(
      {
        now: NOW,
        routes: {
          'GET /api/tokens': () => ({ items, max: 5 }),
          'POST /api/tokens': (call) => {
            const made = token({ id: 7, name: (call.body as Json).name });
            items.push(made);
            return new Reply({ item: made, token: TOKEN }, 201);
          },
        },
      },
      async ({ dom, api }) => {
        const card = dom.mount(await tokensCard(me.app));
        await byText(card, 'button', T.create).fire('click');
        const makeSheet = dialogs(dom).at(-1) as FakeElement;
        assert.equal(textOf(one(makeSheet, 'h2')), T.makeTitle);
        const form = one(makeSheet, 'form');
        const row = fieldRow(form, T.nameLabel);
        assert.equal(row.querySelector('small.hint')?.textContent, T.nameHint);
        assert.equal(control(row).getAttribute('maxlength'), '60');

        // Empty is refused on the field, and nothing is sent.
        await form.fire('submit');
        assert.equal(errorOf(row), S.fieldErrors.required);
        assert.deepEqual(api.writes(), []);

        await typeInto(control(row), '  Slimme display  ');
        await form.fire('submit');
        await until(() => dialogs(dom).some((d) => textOf(one(d, 'h2')) === T.shownTitle), 'the sheet that shows the token');
        assert.deepEqual(api.writes().map((c) => [c.method, c.path, c.body]), [['POST', '/api/tokens', { name: 'Slimme display' }]], 'the name is sent trimmed');
        assert.equal(makeSheet.open, false, 'the form sheet is closed');
        const shown = dialogs(dom).at(-1) as FakeElement;
        const box = one(shown, 'textarea');
        assert.equal(box.value, TOKEN, 'the token is in the sheet, and only there');
        assert.equal(box.readOnly, true);
        assert.ok(all(shown, 'p').some((p) => textOf(p) === T.shownIntro), 'it says it is shown once');
        assert.equal(all(card, 'li').length, 1, 'the list behind the sheet already has the new token');
        assert.equal(textOf(one(card, '.token-name')), 'Slimme display');
        assert.ok(!textOf(card).includes(TOKEN), 'not in the card');

        await byText(shown, 'button', T.copy).fire('click');
        await until(() => all(shown, '[role="status"]').some((p) => textOf(p) === T.copied), 'the copy message');
        assert.deepEqual(clipboard.written, [TOKEN]);

        await byText(shown, 'button', T.done).fire('click');
        assert.equal(box.value, '', 'the field is emptied when the sheet closes');
        assert.equal(shown.parent, null, 'the sheet is no longer in the page');
        assert.ok(!dom.body.textContent.includes(TOKEN), 'the token is nowhere in the page any more');
        assert.equal(dom.storage.data.size, 0, 'nothing was written to local storage, and so not to the unsent-input drafts either');
        assert.equal(dom.focused(), byText(card, 'button', T.create), 'focus returns to the card');
      },
    );
  } finally {
    clipboard.uninstall();
  }
});

test('tokens card: making the fifth token switches the Make button off, and focus then goes to a button that can take it', async () => {
  const me = makeApp(ANNA);
  const items: Json[] = [1, 2, 3, 4].map((id) => token({ id, name: `Token ${id}` }));
  await withClient(
    {
      now: NOW,
      routes: {
        'GET /api/tokens': () => ({ items, max: 5 }),
        'POST /api/tokens': (call) => {
          const made = token({ id: 5, name: (call.body as Json).name });
          items.push(made);
          return new Reply({ item: made, token: TOKEN }, 201);
        },
      },
    },
    async ({ dom }) => {
      const card = dom.mount(await tokensCard(me.app));
      await byText(card, 'button', T.create).fire('click');
      const form = one(dialogs(dom).at(-1), 'form');
      await typeInto(control(fieldRow(form, T.nameLabel)), 'De vijfde');
      await form.fire('submit');
      await until(() => dialogs(dom).some((d) => textOf(one(d, 'h2')) === T.shownTitle), 'the sheet that shows the token');
      const shown = dialogs(dom).at(-1) as FakeElement;
      await byText(shown, 'button', T.done).fire('click');
      assert.equal(byText(card, 'button', T.create).disabled, true, 'five is the limit');
      assert.ok(all(card, 'p').some((p) => textOf(p) === T.limit), 'and it says why');
      assert.notEqual(dom.focused(), byText(card, 'button', T.create), 'a disabled button cannot take focus');
      assert.equal(dom.focused(), all(card, 'button')[0], 'focus stays in the card, on its first button');
    },
  );
});

test('tokens card: a refused creation says why in the sheet, which stays open, and changes nothing in the list', async () => {
  const me = makeApp(ANNA);
  await withClient(
    { now: NOW, routes: { 'GET /api/tokens': () => ({ items: [], max: 5 }), 'POST /api/tokens': () => refuse(409, 'too_many_tokens', { max: 5 }) } },
    async ({ dom }) => {
      const card = dom.mount(await tokensCard(me.app));
      await byText(card, 'button', T.create).fire('click');
      const makeSheet = dialogs(dom).at(-1) as FakeElement;
      const form = one(makeSheet, 'form');
      await typeInto(control(fieldRow(form, T.nameLabel)), 'Nog een');
      await form.fire('submit');
      await until(() => all(makeSheet, '.form-error').some((e) => !e.hidden && textOf(e) === S.errors.too_many_tokens), 'the refusal');
      assert.equal(makeSheet.open, true, 'the sheet stays open');
      assert.equal(byText(makeSheet, 'button', T.create).disabled, false, 'and can be tried again');
      assert.equal(all(card, 'li').length, 0);
      assert.equal(dialogs(dom).length, 1, 'no second sheet with a token');
    },
  );
});

test('tokens card: when the clipboard refuses the token is selected for copying by hand', async () => {
  const me = makeApp(ANNA);
  const clipboard = installClipboard('refuses');
  try {
    await withClient(
      {
        now: NOW,
        routes: { 'GET /api/tokens': () => ({ items: [], max: 5 }), 'POST /api/tokens': () => new Reply({ item: token(), token: TOKEN }, 201) },
      },
      async ({ dom }) => {
        const card = dom.mount(await tokensCard(me.app));
        await byText(card, 'button', T.create).fire('click');
        const form = one(dialogs(dom).at(-1), 'form');
        await typeInto(control(fieldRow(form, T.nameLabel)), 'x');
        await form.fire('submit');
        await until(() => dialogs(dom).some((d) => textOf(one(d, 'h2')) === T.shownTitle), 'the sheet that shows the token');
        const shown = dialogs(dom).at(-1) as FakeElement;
        await byText(shown, 'button', T.copy).fire('click');
        await until(() => all(shown, '[role="status"]').some((p) => textOf(p) === T.copyFailed), 'the fallback message');
        assert.equal(dom.focused(), one(shown, 'textarea'));
      },
    );
  } finally {
    clipboard.uninstall();
  }
});

// ------------------------------------------------------------------------- the Account page

const accountRoutes = (extra: Routes = {}): Routes => ({ 'GET /api/push/key': () => ({ enabled: false }), ...extra });

test('the Account page shows both cards, between the notification list and the password form, and no webcal anywhere', async () => {
  await atCarExample(() =>
    withClient(
      {
        now: NOW,
        routes: accountRoutes({ 'GET /api/tokens': () => ({ items: [token()], max: 5 }), 'GET /api/calendar-feed': () => ({ feed: feedOf(SECRET_A) }) }),
      },
      async ({ dom }) => {
        const page = dom.mount(await renderAccount(makeApp(ANNA).app));
        const order = all(page, 'h3').map(textOf);
        assert.ok(order.indexOf(C.title) >= 0 && order.indexOf(T.title) > order.indexOf(C.title), 'the calendar card, then the tokens card');
        assert.ok(order.indexOf(T.title) < order.indexOf(S.account.changePassword), 'before the password form');
        assert.doesNotMatch(page.textContent, /webcal/i);
        assert.equal(all(page, 'textarea').filter((t) => t.value.startsWith('https://car.example/api/calendar/')).length, 1);
      },
    ),
  );
});

test('the Account page leaves a card out when its request fails, and the rest of the page is untouched', async () => {
  await withClient(
    { now: NOW, routes: accountRoutes({ 'GET /api/tokens': () => refuse(500, 'internal'), 'GET /api/calendar-feed': () => refuse(500, 'internal') }) },
    async ({ dom }) => {
      const page = dom.mount(await renderAccount(makeApp(ANNA).app));
      const headings = all(page, 'h3').map(textOf);
      assert.ok(!headings.includes(C.title) && !headings.includes(T.title));
      assert.ok(headings.includes(S.account.changePassword), 'the password form is still there');
      assert.ok(byText(page, 'button', S.account.signOut));
    },
  );
  await withClient({ now: NOW, routes: accountRoutes({ 'GET /api/tokens': () => refuse(500, 'internal') }) }, async ({ dom }) => {
    const headings = all(dom.mount(await renderAccount(makeApp(ANNA).app)), 'h3').map(textOf);
    assert.ok(headings.includes(C.title) && !headings.includes(T.title), 'one card can be there without the other');
  });
});
