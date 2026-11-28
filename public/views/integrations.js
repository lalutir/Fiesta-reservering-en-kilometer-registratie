// The two cards of the Account page that let the household's own tools read the app: the private calendar link
// (an .ics address for Google, Apple or Outlook Agenda) and the personal access tokens (a secret for a script).
// Both are secrets in the end, so the rules here are about not leaving them lying around:
//  - A token is shown once, in the sheet that follows making it, and is only ever held in a variable of this
//    module's closure: never in the unsent-input drafts (drafts.js), never in localStorage, never in the page after
//    the sheet closes. The server cannot show it again either: it only stores a digest.
//  - The calendar link is offered as an https address only. A webcal:// address is fetched over plain http first by
//    many clients, which would send the secret in the clear before the redirect to https happens.
//  - Replacing or revoking asks first (a confirm sheet), because the old link or token stops working at once.
//  - A card whose request fails is simply not there (the rest of the page does not depend on it).
import { del, get, post } from '../api.js';
import { field, fmtWhen, h, showFieldErrors } from '../dom.js';
import { S, errorText } from '../strings.js';
import { button, confirmSheet, sheet } from '../ui.js';

/** @typedef {import('../api.js').ApiError} ApiError */

/**
 * The address of a feed as it is pasted into a calendar app: always https, on this site.
 * @param {string} path the path the server gave ('/api/calendar/<secret>.ics')
 * @param {string} host
 */
export function feedAddress(path, host) {
  return `https://${host}${path}`;
}

/**
 * Put text on the clipboard. When the browser refuses (no permission, an insecure page), select the text in its
 * field instead, so the person can copy it by hand.
 * @param {string} text
 * @param {HTMLTextAreaElement} source
 * @returns {Promise<boolean>} true when it was copied
 */
async function copyText(text, source) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    source.focus();
    source.select();
    return false;
  }
}

/**
 * The calendar link card. Null when the server cannot be asked.
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement | null>}
 */
export async function calendarCard(app) {
  const C = S.account.calendar;
  /** @type {import('../api.js').CalendarFeed | null} */
  let feed;
  try {
    /** @type {{ feed: import('../api.js').CalendarFeed | null }} */
    const res = await get('/api/calendar-feed');
    feed = res.feed;
  } catch {
    return null;
  }
  const state = h('div', {});
  const message = h('p', { class: 'hint', role: 'status' });

  /**
   * Run one action with its button disabled; a failure is said under the card.
   * @param {HTMLButtonElement} trigger
   * @param {() => Promise<void>} action
   */
  const guarded = async (trigger, action) => {
    trigger.disabled = true;
    message.textContent = '';
    try {
      await action();
    } catch (err) {
      message.textContent = errorText(/** @type {ApiError} */ (err));
    }
    trigger.disabled = false;
  };

  /** @param {'link' | 'create'} focus where keyboard and screen reader focus goes after the card changed */
  function paint(focus) {
    if (!feed) {
      const create = button({
        label: C.create,
        variant: 'primary',
        onclick: () =>
          void guarded(create, async () => {
            /** @type {{ feed: import('../api.js').CalendarFeed }} */
            const res = await post('/api/calendar-feed');
            feed = res.feed;
            app.toast(C.createdToast);
            paint('link');
          }),
      });
      state.replaceChildren(h('p', { text: C.none }), h('div', { class: 'actions' }, [create]), message);
      if (focus === 'create') create.focus();
      return;
    }
    const address = feedAddress(feed.path, window.location?.host ?? '');
    // 5 rows hold the whole address on a 320 px phone (about 26 characters a line); a browser that can size the box to
    // its text does so (style.css), so there is no hidden part to scroll to and no empty space on a wide screen.
    const link = h('textarea', { readOnly: true, rows: '5', class: 'secret-box', value: address });
    const copy = button({
      label: C.copy,
      variant: 'primary',
      onclick: async () => {
        message.textContent = (await copyText(address, link)) ? C.copied : C.copyFailed;
      },
    });
    const renew = button({
      label: C.renew,
      onclick: async () => {
        if (!(await confirmSheet(C.confirmRenew, { confirmLabel: C.renew }))) return;
        await guarded(renew, async () => {
          /** @type {{ feed: import('../api.js').CalendarFeed }} */
          const res = await post('/api/calendar-feed/new-link');
          feed = res.feed;
          app.toast(C.renewedToast);
          paint('link');
        });
      },
    });
    const off = button({
      label: C.turnOff,
      variant: 'danger',
      onclick: async () => {
        if (!(await confirmSheet(C.confirmOff, { confirmLabel: C.turnOff }))) return;
        await guarded(off, async () => {
          await del('/api/calendar-feed');
          feed = null;
          app.toast(C.offToast);
          paint('create');
        });
      },
    });
    // The answer to a press ("Link gekopieerd.", or what went wrong) stands right under the buttons, not under the notes.
    state.replaceChildren(
      field(C.linkLabel, link).row,
      h('div', { class: 'actions' }, [copy, renew, off]),
      message,
      h('p', { class: 'hint', text: C.secretNote }),
      h('p', { class: 'hint', text: C.slow }),
    );
    if (focus === 'link') link.focus();
  }

  paint('create');
  // The card is built before it is on the page: do not take focus when it first appears.
  return h('section', { class: 'card calendar-card' }, [h('h3', { text: C.title }), h('p', { text: C.intro }), state]);
}

/**
 * The access tokens card. Null when the server cannot be asked.
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement | null>}
 */
export async function tokensCard(app) {
  const T = S.account.tokens;
  /** @type {{ items: import('../api.js').AccessToken[], max: number }} */
  let list;
  try {
    list = await get('/api/tokens');
  } catch {
    return null;
  }
  let items = list.items;
  const max = list.max;
  const state = h('div', {});
  const message = h('p', { class: 'hint', role: 'status' });
  /** @type {HTMLButtonElement | null} */
  let createButton = null;

  /** Focus goes to the button that makes a token, or to the first button when the limit has switched it off (a disabled button cannot take focus). */
  function focusCard() {
    (createButton && !createButton.disabled ? createButton : state.querySelector('button'))?.focus();
  }

  /** @param {boolean} focus put focus on the button that makes a token */
  function paint(focus) {
    const rows = items.map((token) => {
      const revoke = button({
        label: T.revoke,
        variant: 'danger',
        attrs: { 'aria-label': T.revokeLabel(token.name) },
        onclick: async () => {
          if (!(await confirmSheet(T.confirmRevoke(token.name), { confirmLabel: T.revoke }))) return;
          revoke.disabled = true;
          try {
            await del(`/api/tokens/${token.id}`);
            items = items.filter((t) => t.id !== token.id);
            message.textContent = '';
            app.toast(T.revokedToast);
            paint(true);
          } catch (err) {
            message.textContent = errorText(/** @type {ApiError} */ (err));
            revoke.disabled = false;
          }
        },
      });
      return h('li', { class: 'token-row' }, [
        h('div', { class: 'token-main' }, [
          h('span', { class: 'token-name', text: token.name }),
          h('span', { class: 'token-meta', text: T.made(fmtWhen(token.createdAt, app.tz)) }),
          h('span', { class: 'token-meta', text: token.lastUsedAt ? T.lastUsed(fmtWhen(token.lastUsedAt, app.tz)) : T.neverUsed }),
        ]),
        revoke,
      ]);
    });
    const full = items.length >= max;
    const create = button({ label: T.create, variant: 'primary', disabled: full, onclick: () => openCreate() });
    createButton = create;
    state.replaceChildren(
      items.length === 0 ? h('p', { text: T.none }) : h('ul', { class: 'token-list' }, rows),
      h('div', { class: 'actions' }, [create]),
      ...(full ? [h('p', { class: 'hint', text: T.limit })] : []),
    );
    if (focus) focusCard();
  }

  /** The sheet that follows making a token: the only place the token is ever shown. @param {string} token */
  function showOnce(token) {
    const box = h('textarea', { readOnly: true, rows: '3', class: 'secret-box', value: token });
    const status = h('p', { class: 'hint', role: 'status' });
    const copy = button({
      label: T.copy,
      variant: 'primary',
      onclick: async () => {
        status.textContent = (await copyText(token, box)) ? T.copied : T.copyFailed;
      },
    });
    const done = button({ label: T.done, onclick: () => panel.close() });
    const panel = sheet({
      title: T.shownTitle,
      body: [h('p', { text: T.shownIntro }), field(T.tokenLabel, box).row, status, h('p', { class: 'hint', text: T.secretNote })],
      footer: [copy, done],
      // Nothing of it stays in the page once the sheet is gone.
      onClose: () => {
        box.value = '';
        focusCard();
      },
      focus: () => copy,
    });
    panel.open();
  }

  function openCreate() {
    const input = h('input', { type: 'text', name: 'name', maxlength: '60', autocomplete: 'off', required: true });
    const f = field(T.nameLabel, input, T.nameHint);
    const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = button({ label: T.create, variant: 'primary', type: 'submit' });
    /** @type {ReturnType<typeof sheet> | null} */
    let panel = null;
    const form = h(
      'form',
      {
        novalidate: true,
        onsubmit: async (/** @type {Event} */ e) => {
          e.preventDefault();
          f.setError(null);
          formError.hidden = true;
          const name = input.value.trim();
          if (name === '') {
            f.setError('required');
            input.focus();
            return;
          }
          submit.disabled = true;
          try {
            /** @type {{ item: import('../api.js').AccessToken, token: string }} */
            const res = await post('/api/tokens', { name });
            items = [...items, res.item];
            panel?.close();
            paint(false);
            showOnce(res.token);
          } catch (err) {
            const apiErr = /** @type {ApiError} */ (err);
            showFieldErrors({ name: f }, apiErr);
            formError.textContent = errorText(apiErr);
            formError.hidden = false;
            submit.disabled = false;
          }
        },
      },
      [f.row, formError, h('div', { class: 'actions' }, [submit, button({ label: S.cancel, onclick: () => panel?.close() })])],
    );
    panel = sheet({ title: T.makeTitle, body: form, focus: () => input });
    panel.open();
  }

  paint(false);
  return h('section', { class: 'card tokens-card' }, [h('h3', { text: T.title }), h('p', { text: T.intro }), state, message]);
}
