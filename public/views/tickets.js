// Traffic tickets: enter a ticket with the time of the offence (and, if known, the price and the
// reason) and see who was driving at that moment. The driver is worked out by the server from the
// drive log and the reservations; nothing here decides it. Reached from the Drives tab (it is not
// a tab itself). Money is whole cents; nothing here uses floating point to decide an amount.
import { del, get, patch, post } from '../api.js';
import { dateTimeField, field, fmtWhen, focusFirstInvalid, h, setBusy, showFieldErrors } from '../dom.js';
import { S, errorText } from '../strings.js';
import { fmtCents, parseDecimal } from './fuel.js';

// Contains a form, so it is not re-rendered in the background.
export const live = false;

// The same limits as the server (src/tickets.ts); test/tickets-view.test.ts keeps the two equal.
export const MAX_AMOUNT_CENTS = 1_000_000;
export const REASON_MAX = 500;

/**
 * The optional price a person typed ("12,50", "12.5") as whole cents; empty means no price.
 * Anything that is not a plain amount is refused instead of being rounded away.
 * @param {string} text
 * @returns {{ ok: true, cents: number | null } | { ok: false, code: 'invalid_amount' | 'too_small' | 'too_large' }}
 */
export function readAmount(text) {
  if (text.trim() === '') return { ok: true, cents: null };
  const cents = parseDecimal(text, 2);
  if (cents === null) return { ok: false, code: 'invalid_amount' };
  if (cents < 1) return { ok: false, code: 'too_small' };
  if (cents > MAX_AMOUNT_CENTS) return { ok: false, code: 'too_large' };
  return { ok: true, cents };
}

/**
 * @param {import('../api.js').App} app
 * @param {{ query: URLSearchParams }} route
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  const me = app.session.user;
  /** @type {{ items: import('../api.js').Ticket[] }} */
  const data = await get('/api/tickets');
  const editId = Number(route.query.get('edit') ?? 0) || null;
  // Only a ticket this person may change opens for editing; anything else falls back to a blank form.
  const existing = editId ? (data.items.find((t) => t.id === editId && t.can.edit) ?? null) : null;

  // ------------------------------------------------------------------ form
  const nowMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const when = dateTimeField(S.tickets.when, existing?.at ?? nowMinute, app.tz, { hint: S.tickets.whenHint });
  const amount = h('input', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    value: existing && existing.amountCents !== null ? fmtCents(existing.amountCents) : '',
  });
  const reason = h('input', { type: 'text', maxlength: String(REASON_MAX), autocomplete: 'off', value: existing?.reason ?? '' });
  const fAmount = field(S.tickets.amount, amount, S.tickets.amountHint);
  const fReason = field(S.tickets.reason, reason, S.tickets.reasonHint);
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, S.tickets.save);

  /** After the view is rebuilt, focus goes back to the page heading rather than to nowhere. */
  const focusHeading = () => {
    const target = document.querySelector('.tickets-view h2');
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        for (const f of [fAmount, fReason, when]) f.setError(null);
        formError.hidden = true;
        const at = when.getIso();
        if (!at) when.setError('invalid_datetime');
        const price = readAmount(amount.value);
        if (!price.ok) fAmount.setError(price.code);
        if (!at || !price.ok) {
          focusFirstInvalid(form);
          return;
        }
        // The price and the reason are always sent: null and '' are how an edit clears them.
        const body = { at, amountCents: price.cents, reason: reason.value };
        submit.disabled = true;
        try {
          if (existing) await patch(`/api/tickets/${existing.id}`, body);
          else await post('/api/tickets', body);
          app.toast(S.tickets.saved);
          if (existing) app.navigate('#/tickets');
          else {
            await app.refresh();
            focusHeading();
          }
        } catch (err) {
          const apiErr = /** @type {import('../api.js').ApiError} */ (err);
          showFieldErrors({ at: when, amountCents: fAmount, reason: fReason }, apiErr);
          formError.textContent = errorText(apiErr);
          formError.hidden = false;
          focusFirstInvalid(form);
          submit.disabled = false;
        }
      },
    },
    [
      h('h3', { text: existing ? S.tickets.editTitle : S.tickets.addTitle }),
      when.row,
      fAmount.row,
      fReason.row,
      h('p', { class: 'hint', text: S.reserve.tzNote(app.tz) }),
      formError,
      h('div', { class: 'actions' }, [submit, existing ? h('a', { class: 'btn', href: '#/tickets' }, S.cancel) : null]),
    ],
  );

  // --------------------------------------------------------------- the list
  /**
   * Delete after asking, with the buttons disabled while the request runs, then reload the list.
   * @param {Event} event the click that started it
   * @param {import('../api.js').Ticket} ticket
   */
  const remove = async (event, ticket) => {
    if (!confirm(S.tickets.confirmDelete)) return;
    const target = event.currentTarget;
    const bar = target instanceof Element ? target.closest('.actions') : null;
    if (bar) setBusy(bar, true);
    try {
      await del(`/api/tickets/${ticket.id}`);
      app.toast(S.tickets.deleted);
    } catch (err) {
      app.toast(errorText(/** @type {Error} */ (err)), true);
    }
    await app.refresh();
    if (bar?.isConnected) setBusy(bar, false);
    focusHeading();
  };

  /** @param {import('../api.js').Ticket} t */
  const driverText = (t) => (t.driver ? S.tickets.driver(t.driver.id === me.id ? S.tickets.you : t.driver.name) : S.tickets.noDriver);

  /** @param {import('../api.js').Ticket} t */
  const card = (t) => {
    const whenText = fmtWhen(t.at, app.tz);
    return h('article', { class: 'card ticket', id: `ticket-${t.id}` }, [
      h('div', { class: 'row' }, [
        h('strong', { text: driverText(t) }),
        t.amountCents !== null ? h('span', { class: 'badge-status', text: S.tickets.price(fmtCents(t.amountCents)) }) : null,
      ]),
      h('div', { class: 'when', text: whenText }),
      h('div', { class: 'sub', text: S.tickets.basis[t.basis] }),
      // Text only: a reason is typed by a person and never treated as markup.
      t.reason ? h('div', { class: 'note', text: t.reason }) : null,
      h('div', { class: 'sub', text: S.tickets.enteredBy(t.createdBy === me.id ? S.you : t.createdByName) }),
      t.can.edit || t.can.delete
        ? h('div', { class: 'actions' }, [
            t.can.edit ? h('a', { class: 'btn', href: `#/tickets?edit=${t.id}`, 'aria-label': S.tickets.editLabel(whenText) }, S.edit) : null,
            t.can.delete
              ? h('button', { class: 'btn danger', type: 'button', 'aria-label': S.tickets.deleteLabel(whenText), onclick: (/** @type {Event} */ e) => void remove(e, t) }, S.delete)
              : null,
          ])
        : null,
    ]);
  };

  return h('div', { class: 'tickets-view' }, [
    h('h2', { text: S.tickets.title }),
    h('p', {}, [h('a', { class: 'btn', href: '#/usage' }, S.tickets.back)]),
    h('p', { class: 'hint', text: S.tickets.intro }),
    form,
    h('h2', { text: S.tickets.list }),
    h('p', { class: 'hint', text: S.tickets.followsLog }),
    data.items.length === 0 ? h('p', { class: 'empty', text: S.tickets.none }) : data.items.map(card),
  ]);
}
