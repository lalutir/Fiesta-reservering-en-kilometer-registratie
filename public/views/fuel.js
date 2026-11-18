// Fuel and costs: who fuelled and when, what each person owes for it, and the
// payment request to send. Reached from the Drives tab (it is not a tab itself).
// Money is whole cents and volume whole millilitres everywhere: nothing here
// uses floating point to decide an amount.
import { del, get, patch, post } from '../api.js';
import { dateTimeField, driverSelect, field, fmtWhen, focusFirstInvalid, h, setBusy, showFieldErrors } from '../dom.js';
import { S, errorText } from '../strings.js';

// Contains forms, so it is not re-rendered in the background.
export const live = false;

const MAX_MILLILITRES = 200_000;
const MAX_TOTAL_CENTS = 1_000_000;

/**
 * A decimal typed by a person ("40,5", "1.859") as an integer scaled by 10^decimals,
 * without floats. More decimals than allowed, signs, exponents and text are refused
 * instead of being rounded away.
 * @param {string} text
 * @param {number} decimals
 * @returns {number | null}
 */
export function parseDecimal(text, decimals) {
  const m = /^(\d{0,9})(?:[.,](\d*))?$/.exec(text.trim());
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  return Number(m[1] || '0') * 10 ** decimals + Number(fraction.padEnd(decimals, '0') || '0');
}

/**
 * Integer division rounded half up, exact for the sizes used here.
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number}
 */
function roundedDivision(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  return Number((2n * n + d) / (2n * d));
}

/**
 * Work out litres, total and price per litre from any two of them (typed as text).
 * If all three are given, litres and total win and the price is derived from them.
 * @param {{ litres: string, total: string, price: string }} input
 * @returns {{ ok: true, millilitres: number, totalCents: number, pricePerLitreMillis: number } | { ok: false, errors: Record<string, string> }}
 */
export function deriveFuel(input) {
  /** @type {Record<string, string>} */
  const errors = {};
  /** @param {string} text @param {number} decimals @param {string} key @returns {number | undefined} */
  const read = (text, decimals, key) => {
    if (text.trim() === '') return undefined;
    const value = parseDecimal(text, decimals);
    if (value === null) errors[key] = 'invalid_amount';
    return value ?? undefined;
  };
  let millilitres = read(input.litres, 3, 'litres');
  let totalCents = read(input.total, 2, 'total');
  const price = read(input.price, 3, 'price');
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (millilitres !== undefined && totalCents !== undefined) {
    // nothing to work out
  } else if (millilitres !== undefined && price !== undefined && price > 0) {
    totalCents = roundedDivision(millilitres * price, 10_000);
  } else if (totalCents !== undefined && price !== undefined && price > 0) {
    millilitres = roundedDivision(totalCents * 10_000, price);
  } else {
    for (const [key, text] of /** @type {Array<[string, string]>} */ ([['litres', input.litres], ['total', input.total], ['price', input.price]])) {
      if (text.trim() === '') errors[key] = 'needs_two';
    }
    return { ok: false, errors };
  }
  const ml = /** @type {number} */ (millilitres);
  const cents = /** @type {number} */ (totalCents);
  if (ml < 1) errors['litres'] = 'too_small';
  else if (ml > MAX_MILLILITRES) errors['litres'] = 'too_large';
  if (cents < 1) errors['total'] = 'too_small';
  else if (cents > MAX_TOTAL_CENTS) errors['total'] = 'too_large';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, millilitres: ml, totalCents: cents, pricePerLitreMillis: roundedDivision(cents * 10_000, ml) };
}

/**
 * 1500 -> "15.00"
 * @param {number} cents
 */
export function fmtCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * 40000 -> "40.00", 40123 -> "40.123" (litres from millilitres)
 * @param {number} millilitres
 */
export function fmtLitres(millilitres) {
  const whole = Math.floor(millilitres / 1000);
  const rest = String(millilitres % 1000).padStart(3, '0');
  return millilitres % 10 === 0 ? `${whole}.${rest.slice(0, 2)}` : `${whole}.${rest}`;
}

/**
 * 1500 -> "1.500" (thousandths of a euro per litre)
 * @param {number} thousandths
 */
export function fmtPrice(thousandths) {
  return `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, '0')}`;
}

/**
 * The ways to hand a message to someone: a text message and WhatsApp, as links.
 * @param {string} message
 */
export function shareLinks(message) {
  const text = encodeURIComponent(message);
  return { sms: `sms:?&body=${text}`, whatsapp: `https://wa.me/?text=${text}` };
}

/**
 * @param {import('../api.js').FuelShare} share
 * @returns {'none' | 'requested' | 'paid' | 'changed' | 'paidChanged' | 'settled'}
 */
export function shareStatus(share) {
  if (share.request?.paidAt) return share.request.changed ? 'paidChanged' : 'paid';
  // A later payment covered it: not paid itself, but nothing is owed for it any more.
  if (share.settledBy) return 'settled';
  if (!share.request) return 'none';
  return share.request.changed ? 'changed' : 'requested';
}

/**
 * The lines about what rides along with a share: what is still open from earlier fill-ups (or taken
 * off for what the fueler owes back) and the total to pay. Empty when nothing is carried.
 * @param {import('../api.js').Fuel} fuel
 * @param {import('../api.js').FuelShare} share
 * @param {(name: string, id: number) => string} nameOf
 * @returns {string[]}
 */
export function carriedLines(fuel, share, nameOf) {
  const carried = share.carriedCents ?? 0;
  if (carried === 0) return [];
  const line = carried > 0
    ? S.fuel.carried(fmtCents(carried))
    : S.fuel.carriedBack(nameOf(fuel.userName, fuel.userId), nameOf(share.userName, share.userId), fmtCents(-carried));
  return [line, S.fuel.due(fmtCents(share.dueCents ?? share.cents))];
}

/**
 * carriedLines as rows. The last one is the total to pay, so it reads as the figure that matters.
 * @param {import('../api.js').Fuel} fuel
 * @param {import('../api.js').FuelShare} share
 * @param {(name: string, id: number) => string} nameOf
 * @returns {HTMLElement[]}
 */
export function carriedRows(fuel, share, nameOf) {
  const lines = carriedLines(fuel, share, nameOf);
  return lines.map((line, i) => h('div', { class: i === lines.length - 1 ? 'sub due' : 'sub', text: line }));
}

/**
 * "I have paid this request": the debtor's own button, the same on the History screen and on the Fuel card.
 * @param {import('../api.js').Fuel} fuel
 * @param {import('../api.js').FuelShare} share
 * @param {(event: Event, fuelId: number, action: () => Promise<unknown>, done: string) => unknown} run how the caller runs an action (busy buttons, toast, reload)
 * @returns {HTMLElement}
 */
export function selfPaidButton(fuel, share, run) {
  return h(
    'button',
    {
      class: 'btn small primary',
      type: 'button',
      onclick: (/** @type {Event} */ e) => void run(e, fuel.id, () => post(`/api/fuel/${fuel.id}/requests/${share.userId}/paid`, { paid: true }), S.fuel.iPaidSaved),
    },
    S.fuel.iPaid,
  );
}

/**
 * The line that says by how much a share moved after its request was made, or null when it did not.
 * @param {import('../api.js').FuelShare} share
 * @returns {string | null}
 */
export function changedLine(share) {
  const request = share.request;
  if (!request || !request.changed) return null;
  // What a request for this share would ask now (the share plus what is carried); older requests asked for the share alone.
  const difference = (request.currentCents ?? share.cents) - request.amountCents;
  const args = /** @type {const} */ ([fmtCents(request.amountCents), fmtCents(request.currentCents ?? share.cents), difference > 0, fmtCents(Math.abs(difference))]);
  return request.paidAt ? S.fuel.changedPaid(...args) : S.fuel.changedAsked(...args);
}

/**
 * @param {import('../api.js').App} app
 * @param {{ query: URLSearchParams }} route
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  const me = app.session.user;
  const isAdmin = me.role === 'admin';
  /** @type {{ items: import('../api.js').Fuel[], balances: import('../api.js').Balance[] }} */
  const data = await get('/api/fuel');
  const editId = Number(route.query.get('edit') ?? 0) || null;
  const existing = editId ? (data.items.find((f) => f.id === editId && f.can.edit) ?? null) : null;

  // ------------------------------------------------------------------ form
  const nowMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const when = dateTimeField(S.fuel.when, existing?.at ?? nowMinute, app.tz);
  const who = driverSelect(app.users, me.id, !isAdmin);
  // A member can only edit their own fill-ups, so `existing` is theirs and the select (locked for them) already holds them.
  who.value = String(existing?.userId ?? me.id);
  const input = (/** @type {string} */ value) => h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value });
  const litres = input(existing ? fmtLitres(existing.millilitres) : '');
  const total = input(existing ? fmtCents(existing.totalCents) : '');
  const price = input('');
  const note = h('input', { type: 'text', maxlength: '500', value: existing?.note ?? '', autocomplete: 'off' });
  const fWho = field(S.fuel.who, who);
  const fLitres = field(S.fuel.litres, litres, S.fuel.enterTwo);
  const fTotal = field(S.fuel.total, total);
  const fPrice = field(S.fuel.pricePerLitre, price);
  const fNote = field(S.reserve.note, note, S.noteHint);
  const worked = h('p', { class: 'hint', 'aria-live': 'polite' });
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, S.fuel.save);

  const showWorked = () => {
    const d = deriveFuel({ litres: litres.value, total: total.value, price: price.value });
    worked.textContent = d.ok ? S.fuel.worked(fmtLitres(d.millilitres), fmtCents(d.totalCents), fmtPrice(d.pricePerLitreMillis)) : '';
  };
  for (const el of [litres, total, price]) el.addEventListener('input', showWorked);
  showWorked();

  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        for (const f of [fWho, fLitres, fTotal, fPrice, fNote, when]) f.setError(null);
        formError.hidden = true;
        const at = when.getIso();
        if (!at) {
          when.setError('invalid_datetime');
          focusFirstInvalid(form);
          return;
        }
        const derived = deriveFuel({ litres: litres.value, total: total.value, price: price.value });
        if (!derived.ok) {
          showFieldErrors({ litres: fLitres, total: fTotal, price: fPrice }, { fields: derived.errors });
          focusFirstInvalid(form);
          return;
        }
        const body = /** @type {Record<string, unknown>} */ ({ at, millilitres: derived.millilitres, totalCents: derived.totalCents, note: note.value });
        if (isAdmin && Number(who.value) !== (existing?.userId ?? me.id)) body['userId'] = Number(who.value);
        submit.disabled = true;
        try {
          if (existing) await patch(`/api/fuel/${existing.id}`, body);
          else await post('/api/fuel', body);
          app.toast(note.value.trim() === '' ? `${S.fuel.saved} ${S.noteTip}` : S.fuel.saved);
          app.navigate('#/fuel');
        } catch (err) {
          const apiErr = /** @type {import('../api.js').ApiError} */ (err);
          showFieldErrors({ at: when, userId: fWho, millilitres: fLitres, totalCents: fTotal, note: fNote }, apiErr);
          formError.textContent = errorText(apiErr);
          formError.hidden = false;
          focusFirstInvalid(form);
          submit.disabled = false;
        }
      },
    },
    [
      h('h3', { text: existing ? S.fuel.editTitle : S.fuel.addTitle }),
      isAdmin ? fWho.row : null,
      when.row,
      fLitres.row,
      fTotal.row,
      fPrice.row,
      worked,
      fNote.row,
      h('p', { class: 'hint', text: S.reserve.tzNote(app.tz) }),
      formError,
      h('div', { class: 'actions' }, [submit, existing ? h('a', { class: 'btn', href: '#/fuel' }, S.cancel) : null]),
    ],
  );

  // ------------------------------------------------------------- balances
  const balances = h('section', { class: 'card' }, [
    h('h3', { text: S.fuel.balances }),
    data.balances.length === 0
      ? h('p', { class: 'empty', text: S.fuel.nobodyOwes })
      : h(
          'ul',
          { class: 'totals' },
          data.balances.map((b) =>
            h('li', {}, [
              h('span', { text: S.fuel.owes(b.fromUserId === me.id ? S.me : b.fromName, b.toUserId === me.id ? S.me : b.toName, fmtCents(b.cents)) }),
            ]),
          ),
        ),
  ]);

  // --------------------------------------------------------------- the list
  /**
   * After the view is rebuilt, keyboard and screen reader focus goes back to the
   * fill-up the person was working on (or the page heading when it is gone), not to nowhere.
   * @param {number} fuelId
   */
  const refocus = (fuelId) => {
    const target = document.getElementById(`fuel-${fuelId}`) ?? document.querySelector('.fuel-view h2');
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  /**
   * Run an action with its buttons disabled (a double tap cannot send it twice),
   * report the outcome, and reload the view.
   * @param {Event} event the click that started it
   * @param {number} fuelId the fill-up the action belongs to
   * @param {() => Promise<unknown>} action
   * @param {string} done
   */
  const act = async (event, fuelId, action, done) => {
    const target = event.currentTarget;
    const bar = target instanceof Element ? target.closest('.actions') : null;
    if (bar) setBusy(bar, true);
    try {
      await action();
      app.toast(done);
    } catch (err) {
      app.toast(errorText(/** @type {Error} */ (err)), true);
    }
    await app.refresh();
    if (bar?.isConnected) setBusy(bar, false);
    refocus(fuelId);
  };

  /**
   * The payment request of one share, ready to hand over: the message, ways to send it,
   * and (to make or redo it) an optional payment link.
   * @param {import('../api.js').Fuel} fuel
   * @param {import('../api.js').FuelShare} share
   * @param {HTMLElement} host
   */
  const openPanel = (fuel, share, host) => {
    const link = h('input', { type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://', value: share.request?.link ?? '' });
    const fLink = field(S.fuel.panelLink, link, S.fuel.panelLinkHint);
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const message = h('div', {});

    /** @param {import('../api.js').FuelRequest} request */
    const showMessage = (request) => {
      const links = shareLinks(request.message);
      const text = h('textarea', { readOnly: true, rows: '5', 'aria-label': S.fuel.panelMessage, value: request.message });
      const copied = h('span', { class: 'hint', role: 'status' });
      message.replaceChildren(
        h('p', { class: 'hint', text: request.provider === 'tikkie' ? S.fuel.providerTikkie : S.fuel.providerManual }),
        text,
        h('div', { class: 'actions' }, [
          typeof navigator.share === 'function'
            ? h('button', { class: 'btn small primary', type: 'button', onclick: () => void navigator.share({ text: request.message }).catch(() => undefined) }, S.fuel.panelShare)
            : null,
          h('a', { class: 'btn small', href: links.sms }, S.fuel.panelSms),
          h('a', { class: 'btn small', href: links.whatsapp, target: '_blank', rel: 'noopener' }, S.fuel.panelWhatsapp),
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(request.message);
                  copied.textContent = S.fuel.panelCopied;
                } catch {
                  text.select();
                  copied.textContent = S.fuel.panelCopyFailed;
                }
              },
            },
            S.fuel.panelCopy,
          ),
        ]),
        copied,
      );
    };
    if (share.request) showMessage(share.request);

    const create = h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        onclick: async () => {
          fLink.setError(null);
          error.hidden = true;
          create.disabled = true;
          try {
            const body = /** @type {Record<string, unknown>} */ ({ debtorId: share.userId });
            if (link.value.trim() !== '') body['link'] = link.value.trim();
            /** @type {{ fuel: import('../api.js').Fuel }} */
            const res = await post(`/api/fuel/${fuel.id}/requests`, body);
            const request = res.fuel.shares.find((s) => s.userId === share.userId)?.request;
            if (request) showMessage(request);
            app.toast(S.fuel.requestSaved);
          } catch (err) {
            const apiErr = /** @type {import('../api.js').ApiError} */ (err);
            showFieldErrors({ link: fLink }, apiErr);
            error.textContent = errorText(apiErr);
            error.hidden = false;
          }
          create.disabled = false;
        },
      },
      share.request ? S.fuel.panelRedo : S.fuel.panelCreate,
    );
    // The panel opens below the whole list of shares, away from the button that was pressed:
    // focus goes to its title so a keyboard or screen reader user lands in it (and it scrolls into view).
    const titleId = `fuel-${fuel.id}-panel-${share.userId}`;
    const title = h('h4', { id: titleId, tabindex: '-1', text: S.fuel.panelTitle(share.userName) });
    host.replaceChildren(
      h('div', { class: 'panel-box', role: 'group', 'aria-labelledby': titleId }, [
        title,
        message,
        fLink.row,
        error,
        h('div', { class: 'actions' }, [
          create,
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              // Reloading shows the request that was just made (status and button label) on the card.
              onclick: async () => {
                await app.refresh();
                refocus(fuel.id);
              },
            },
            S.fuel.panelClose,
          ),
        ]),
      ]),
    );
    title.focus();
  };

  /**
   * A name as the viewer reads it: "me" for themselves.
   * @param {string} name
   * @param {number} id
   */
  const nameOf = (name, id) => (id === me.id ? S.me : name);

  /** @param {import('../api.js').Fuel} f */
  const card = (f) => {
    const panelHost = h('div', {});
    const lockedHint = (f.hasPaidRequests || f.settledByLater) && (isAdmin || f.userId === me.id);
    return h('article', { class: 'card fuel', id: `fuel-${f.id}` }, [
      h('div', { class: 'row' }, [
        h('strong', { text: S.fuel.header(f.userId === me.id ? S.me : f.userName, fmtLitres(f.millilitres), fmtCents(f.totalCents)) }),
        // Neutral: green is kept for "paid" and "confirmed", this is only a fact about the fill-up.
        h('span', { class: 'badge-status', text: S.fuel.perLitre(fmtPrice(f.pricePerLitreMillis)) }),
      ]),
      h('div', { class: 'when', text: fmtWhen(f.at, app.tz) }),
      f.note ? h('div', { class: 'note', text: f.note }) : null,
      h('div', { class: 'sub', text: f.firstInData || f.period.from === null ? S.fuel.periodFirst : S.fuel.periodBetween(fmtWhen(f.period.from, app.tz), fmtWhen(f.period.to, app.tz)) }),
      f.equalSplit ? h('div', { class: 'sub', text: S.fuel.equalSplit }) : null,
      f.togetherKm ? h('div', { class: 'sub', text: S.fuel.togetherNote(f.togetherKm) }) : null,
      h(
        'ul',
        { class: 'shares' },
        f.shares.map((s) => {
          const status = shareStatus(s);
          const isPaid = Boolean(s.request?.paidAt);
          const changedText = changedLine(s);
          const selfPaid = s.can.selfPaid === true;
          return h('li', { class: 'share' }, [
            h('div', { class: 'row' }, [
              h('strong', { text: s.userId === me.id ? S.me : s.userName }),
              h('span', { text: S.fuel.shareLine(s.km, fmtCents(s.cents)) }),
              s.owes
                ? h('span', { class: `chip ${status === 'paidChanged' ? 'changed' : status}`, text: S.fuel.status[status] })
                : s.userId === f.userId
                  ? h('span', { class: 'chip', text: S.fuel.paidTheBill })
                  : null,
            ]),
            carriedRows(f, s, nameOf),
            s.settledBy ? h('div', { class: 'sub', text: S.fuel.settledBy(fmtWhen(s.settledBy.at, app.tz)) }) : null,
            changedText ? h('div', { class: 'sub', text: changedText }) : null,
            s.can.request || s.can.markPaid || selfPaid
              ? h('div', { class: 'actions' }, [
                  s.can.request
                    ? // One primary action per share: when the person can also say "I have paid", that is the one.
                      h('button', { class: selfPaid ? 'btn small' : 'btn small primary', type: 'button', onclick: () => openPanel(f, s, panelHost) }, s.request ? S.fuel.shareRequest : S.fuel.request)
                    : null,
                  // Their own share: "I have paid" wins over the fueler's "Mark paid" (an admin who owes money sees only this one).
                  selfPaid
                    ? selfPaidButton(f, s, act)
                    : s.can.markPaid
                    ? h(
                        'button',
                        {
                          class: 'btn small',
                          type: 'button',
                          onclick: (/** @type {Event} */ e) => {
                            const paid = !isPaid;
                            if (!paid && !confirm(S.fuel.confirmUnpaid)) return;
                            void act(e, f.id, () => post(`/api/fuel/${f.id}/requests/${s.userId}/paid`, { paid }), paid ? S.fuel.paidSaved : S.fuel.unpaidSaved);
                          },
                        },
                        isPaid ? S.fuel.markUnpaid : S.fuel.markPaid,
                      )
                    : null,
                ])
              : null,
          ]);
        }),
      ),
      panelHost,
      lockedHint ? h('p', { class: 'hint', text: f.hasPaidRequests ? S.fuel.paidLocked : S.fuel.settledLocked }) : null,
      f.can.edit || f.can.delete
        ? h('div', { class: 'actions' }, [
            f.can.edit ? h('a', { class: 'btn', href: `#/fuel?edit=${f.id}` }, S.edit) : null,
            f.can.delete
              ? h(
                  'button',
                  {
                    class: 'btn danger',
                    type: 'button',
                    onclick: (/** @type {Event} */ e) => {
                      if (!confirm(S.fuel.confirmDelete)) return;
                      void act(e, f.id, () => del(`/api/fuel/${f.id}`), S.fuel.deleted);
                    },
                  },
                  S.delete,
                )
              : null,
          ])
        : null,
    ]);
  };

  return h('div', { class: 'fuel-view' }, [
    h('h2', { text: S.fuel.title }),
    h('p', {}, [h('a', { class: 'btn', href: '#/usage' }, S.fuel.back)]),
    balances,
    form,
    h('h2', { text: S.fuel.list }),
    data.items.length === 0 ? h('p', { class: 'empty', text: S.fuel.none }) : data.items.map(card),
  ]);
}
