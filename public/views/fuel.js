// Fuel and costs: who fuelled and when, what each person owes for it, and the
// payment request to send. Reached from the Drives tab (it is not a tab itself).
// Money is whole cents and volume whole millilitres everywhere: nothing here
// uses floating point to decide an amount.
import { del, get, patch, post } from '../api.js';
import {
  actionBar,
  dateTimeField,
  driverSelect,
  field,
  fmtWhen,
  focusFirstInvalid,
  formatCentsInput,
  formatEuro,
  formatLitres,
  formatPrice,
  h,
  numberInput,
  readNumber,
  setBusy,
  showFieldErrors,
} from '../dom.js';
import { persistForm, restoredLine } from '../drafts.js';
import { odometerContext, odometerNote } from '../kmcheck.js';
import { S, errorText } from '../strings.js';
import { button, confirmSheet, emptyState, linkButton } from '../ui.js';

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
    ? S.fuel.carried(formatEuro(carried))
    : S.fuel.carriedBack(nameOf(fuel.userName, fuel.userId), nameOf(share.userName, share.userId), formatEuro(-carried));
  return [line, S.fuel.due(formatEuro(share.dueCents ?? share.cents))];
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
 * @param {(bar: Element | null, fuelId: number, action: () => Promise<unknown>, done: string) => unknown} run how the caller runs an action (busy buttons, toast, reload); bar = the row of buttons that was pressed
 * @returns {HTMLElement}
 */
export function selfPaidButton(fuel, share, run) {
  return button({
    label: S.fuel.iPaid,
    small: true,
    variant: 'primary',
    onclick: (/** @type {Event} */ e) => void run(actionBar(e), fuel.id, () => post(`/api/fuel/${fuel.id}/requests/${share.userId}/paid`, { paid: true }), S.fuel.iPaidSaved),
  });
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
  const args = /** @type {const} */ ([formatEuro(request.amountCents), formatEuro(request.currentCents ?? share.cents), difference > 0, formatEuro(Math.abs(difference))]);
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
  /** @type {[{ items: import('../api.js').Fuel[], balances: import('../api.js').Balance[] }, import('../api.js').OdometerChain | null]} */
  const [data, chain] = await Promise.all([
    get('/api/fuel'),
    // The kilometre check is a help on this screen: without it the form still works, without the last known reading.
    get('/api/odometer').catch(() => null),
  ]);
  const editId = Number(route.query.get('edit') ?? 0) || null;
  // The fueler or an admin can open a locked fill-up (a payment depends on it) to correct the odometer reading, and only that.
  const existing = editId ? (data.items.find((f) => f.id === editId && (f.can.edit || f.canOdometer === true)) ?? null) : null;
  const odometerOnly = existing !== null && !existing.can.edit;

  // ------------------------------------------------------------------ form
  const nowMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const when = dateTimeField(S.fuel.when, existing?.at ?? nowMinute, app.tz);
  const who = driverSelect(app.users, me.id, !isAdmin);
  // A member can only edit their own fill-ups, so `existing` is theirs and the select (locked for them) already holds them.
  who.value = String(existing?.userId ?? me.id);
  const input = (/** @type {string} */ value) => h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value });
  // Shown and prefilled with a comma and without grouping, so what is on screen parses back to the same number.
  const litres = input(existing ? formatLitres(existing.millilitres) : '');
  const total = input(existing ? formatCentsInput(existing.totalCents) : '');
  const price = input('');
  const odometer = numberInput(existing?.odometer ?? null);
  const note = h('input', { type: 'text', maxlength: '500', value: existing?.note ?? '', autocomplete: 'off' });
  const fWho = field(S.fuel.who, who);
  const fLitres = field(S.fuel.litres, litres, S.fuel.enterTwo);
  const fTotal = field(S.fuel.total, total);
  const fPrice = field(S.fuel.pricePerLitre, price);
  const fOdometer = field(S.fuel.odometer, odometer, S.fuel.odometerHint);
  const fNote = field(S.reserve.note, note, S.noteHint);
  const worked = h('p', { class: 'hint', 'aria-live': 'polite' });
  // The reading before this fill-up (or, during a trip, the trip's own readings), and a warning that never blocks a save.
  const kmNote = odometerNote({ tz: app.tz, meId: me.id });
  fOdometer.row.appendChild(kmNote.el);
  const showKmNote = () =>
    kmNote.show(odometerContext(chain?.readings ?? [], when.getIso() ?? existing?.at ?? nowMinute, { fuel: existing?.id ?? null }, true), readNumber(odometer.value));
  when.onInput(showKmNote);
  odometer.addEventListener('input', showKmNote);
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = button({ label: S.fuel.save, variant: 'primary', block: true, type: 'submit' });
  // A new fill-up keeps what was typed when the person leaves (to look something up) and comes back; a correction shows what the server has.
  const unsent = existing
    ? null
    : persistForm({
        userId: me.id,
        name: 'fuel',
        controls: { who, whenDate: when.controls.date, whenTime: when.controls.time, litres, total, price, odometer, note },
        onReset: () => {
          showWorked();
          showKmNote();
        },
      });
  // After the restore, so the note follows a restored reading and time too.
  showKmNote();

  const showWorked = () => {
    const d = deriveFuel({ litres: litres.value, total: total.value, price: price.value });
    worked.textContent = d.ok ? S.fuel.worked(formatLitres(d.millilitres), formatEuro(d.totalCents), formatPrice(d.pricePerLitreMillis)) : '';
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
        for (const f of [fWho, fLitres, fTotal, fPrice, fOdometer, fNote, when]) f.setError(null);
        formError.hidden = true;
        const reading = readNumber(odometer.value);
        // The reading is required for a new fill-up and for the odometer-only correction; a fill-up that already has one cannot lose it.
        // A fill-up from before the kilometre check existed may stay without (and then sends no reading).
        const readingMissing = reading === null && (!existing || odometerOnly || (existing.odometer ?? null) !== null);
        if (readingMissing) fOdometer.setError('required');
        // The odometer-only correction sends exactly the reading: nothing else of a locked fill-up is touched.
        /** @type {Record<string, unknown>} */
        let body = { odometer: reading };
        if (!odometerOnly) {
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
          body = { at, millilitres: derived.millilitres, totalCents: derived.totalCents, note: note.value };
          if (reading !== null) body['odometer'] = reading;
          if (isAdmin && Number(who.value) !== (existing?.userId ?? me.id)) body['userId'] = Number(who.value);
        }
        if (readingMissing) {
          focusFirstInvalid(form);
          return;
        }
        submit.disabled = true;
        try {
          if (existing) await patch(`/api/fuel/${existing.id}`, body);
          else await post('/api/fuel', body);
          unsent?.clear();
          app.toast(note.value.trim() === '' ? `${S.fuel.saved} ${S.noteTip}` : S.fuel.saved);
          app.navigate('#/fuel');
        } catch (err) {
          const apiErr = /** @type {import('../api.js').ApiError} */ (err);
          showFieldErrors({ at: when, userId: fWho, millilitres: fLitres, totalCents: fTotal, odometer: fOdometer, note: fNote }, apiErr);
          formError.textContent = errorText(apiErr);
          formError.hidden = false;
          focusFirstInvalid(form);
          submit.disabled = false;
        }
      },
    },
    [
      h('h3', { text: existing ? S.fuel.editTitle : S.fuel.addTitle }),
      unsent ? restoredLine(unsent) : null,
      odometerOnly ? h('p', { class: 'hint', text: S.fuel.odometerOnlyHint }) : null,
      // The only control that can change in the odometer-only correction comes first, above the locked ones.
      odometerOnly ? fOdometer.row : null,
      isAdmin ? fWho.row : null,
      when.row,
      fLitres.row,
      fTotal.row,
      fPrice.row,
      worked,
      odometerOnly ? null : fOdometer.row,
      fNote.row,
      h('p', { class: 'hint', text: S.reserve.tzNote(app.tz) }),
      formError,
      h('div', { class: 'actions' }, [submit, existing ? linkButton({ label: S.cancel, href: '#/fuel' }) : null]),
    ],
  );

  if (odometerOnly) {
    // Every other control is locked, so what is shown cannot be mistaken for something that will be saved.
    for (const row of [fWho.row, when.row, fLitres.row, fTotal.row, fPrice.row, fNote.row]) {
      for (const control of row.querySelectorAll('input, select')) /** @type {HTMLInputElement} */ (control).disabled = true;
    }
  }

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
              h('span', { text: S.fuel.owes(b.fromUserId === me.id ? S.me : b.fromName, b.toUserId === me.id ? S.me : b.toName, formatEuro(b.cents)) }),
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
   * @param {Element | null} bar the row of buttons the click came from (actionBar(event), read before any await)
   * @param {number} fuelId the fill-up the action belongs to
   * @param {() => Promise<unknown>} action
   * @param {string} done
   */
  const act = async (bar, fuelId, action, done) => {
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
            ? button({ label: S.fuel.panelShare, small: true, variant: 'primary', onclick: () => void navigator.share({ text: request.message }).catch(() => undefined) })
            : null,
          linkButton({ label: S.fuel.panelSms, href: links.sms, small: true }),
          linkButton({ label: S.fuel.panelWhatsapp, href: links.whatsapp, small: true, attrs: { target: '_blank', rel: 'noopener' } }),
          button({
            label: S.fuel.panelCopy,
            small: true,
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(request.message);
                copied.textContent = S.fuel.panelCopied;
              } catch {
                text.select();
                copied.textContent = S.fuel.panelCopyFailed;
              }
            },
          }),
        ]),
        copied,
      );
    };
    if (share.request) showMessage(share.request);

    const create = button({
      label: share.request ? S.fuel.panelRedo : S.fuel.panelCreate,
      small: true,
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
    });
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
          button({
            label: S.fuel.panelClose,
            small: true,
            // Reloading shows the request that was just made (status and button label) on the card.
            onclick: async () => {
              await app.refresh();
              refocus(fuel.id);
            },
          }),
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
        h('strong', { text: S.fuel.header(f.userId === me.id ? S.me : f.userName, formatLitres(f.millilitres), formatEuro(f.totalCents)) }),
        // Neutral: green is kept for "paid" and "confirmed", this is only a fact about the fill-up.
        h('span', { class: 'badge-status', text: S.fuel.perLitre(formatPrice(f.pricePerLitreMillis)) }),
      ]),
      h('div', { class: 'when', text: fmtWhen(f.at, app.tz) }),
      f.note ? h('div', { class: 'note', text: f.note }) : null,
      typeof f.odometer === 'number' ? h('div', { class: 'sub', text: S.fuel.odometerLine(f.odometer) }) : null,
      // Kilometres the odometer chain shows were driven but not registered, in this period. Display only: the split is unchanged.
      (f.unaccountedKm ?? 0) > 0 ? h('div', { class: 'sub km-flag', text: S.fuel.unaccounted(f.unaccountedKm ?? 0) }) : null,
      h('div', { class: 'sub', text: f.firstInData || f.period.from === null ? S.fuel.periodFirst : S.fuel.periodBetween(fmtWhen(f.period.from, app.tz), fmtWhen(f.period.to, app.tz)) }),
      // Equal split: nobody has personal kilometres in the period (nobody drove, or only together). Otherwise the pool follows the personal ratio.
      f.equalSplit ? h('div', { class: 'sub', text: f.togetherKm ? S.fuel.equalSplitTogether : S.fuel.equalSplit }) : null,
      f.togetherKm && !f.equalSplit ? h('div', { class: 'sub', text: S.fuel.togetherNote(f.togetherKm) }) : null,
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
              h('strong', { text: s.userId === me.id ? S.meHead : s.userName }),
              h('span', { text: S.fuel.shareLine(s.km, formatEuro(s.cents)) }),
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
                      button({ label: s.request ? S.fuel.shareRequest : S.fuel.request, small: true, variant: selfPaid ? 'secondary' : 'primary', onclick: () => openPanel(f, s, panelHost) })
                    : null,
                  // Their own share: "I have paid" wins over the fueler's "Mark paid" (an admin who owes money sees only this one).
                  selfPaid
                    ? selfPaidButton(f, s, act)
                    : s.can.markPaid
                      ? button({
                          label: isPaid ? S.fuel.markUnpaid : S.fuel.markPaid,
                          small: true,
                          onclick: async (/** @type {Event} */ e) => {
                            const bar = actionBar(e);
                            const paid = !isPaid;
                            // Taking the paid mark off tells the other person, so it asks first.
                            if (!paid && !(await confirmSheet(S.fuel.confirmUnpaid, { confirmLabel: S.fuel.markUnpaid }))) return;
                            void act(bar, f.id, () => post(`/api/fuel/${f.id}/requests/${s.userId}/paid`, { paid }), paid ? S.fuel.paidSaved : S.fuel.unpaidSaved);
                          },
                        })
                      : null,
                ])
              : null,
          ]);
        }),
      ),
      panelHost,
      lockedHint ? h('p', { class: 'hint', text: f.hasPaidRequests ? S.fuel.paidLocked : S.fuel.settledLocked }) : null,
      // A payment depends on this fill-up, so only the reading can be corrected (it moves no money).
      !f.can.edit && f.canOdometer ? h('div', { class: 'actions' }, [linkButton({ label: S.fuel.correctOdometer, href: `#/fuel?edit=${f.id}` })]) : null,
      f.can.edit || f.can.delete
        ? h('div', { class: 'actions' }, [
            f.can.edit ? linkButton({ label: S.edit, href: `#/fuel?edit=${f.id}` }) : null,
            f.can.delete
              ? button({
                  label: S.delete,
                  variant: 'danger',
                  onclick: async (/** @type {Event} */ e) => {
                    const bar = actionBar(e);
                    // A deleted fill-up changes what people owe, and tells them: ask first.
                    if (!(await confirmSheet(S.fuel.confirmDelete, { confirmLabel: S.delete }))) return;
                    void act(bar, f.id, () => del(`/api/fuel/${f.id}`), S.fuel.deleted);
                  },
                })
              : null,
          ])
        : null,
    ]);
  };

  return h('div', { class: 'fuel-view' }, [
    h('h2', { text: S.fuel.title }),
    h('p', {}, [linkButton({ label: S.fuel.back, href: '#/usage' })]),
    // On a wide screen the balances and the form sit beside the list of fill-ups.
    h('div', { class: 'split' }, [
      h('div', {}, [balances, form]),
      h('div', {}, [h('h2', { text: S.fuel.list }), h('p', { class: 'hint', text: S.fuel.adminNote }), data.items.length === 0 ? emptyState({ text: S.fuel.none }) : data.items.map(card)]),
    ]),
  ]);
}
