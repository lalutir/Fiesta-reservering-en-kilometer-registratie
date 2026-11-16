import { del, get, patch, post } from '../api.js';
import { dateTimeField, driverSelect, field, fmtRange, h, numberInput, readNumber, readRange, saveErrorText, showFieldErrors } from '../dom.js';
import { S, errorText } from '../strings.js';

// Contains a form, so it is not re-rendered in the background.
export const live = false;

/**
 * Log a drive (who actually drove, when, optional odometer), list recent
 * drives and show kilometres per person.
 * @param {import('../api.js').App} app
 * @param {{ query: URLSearchParams }} route
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  const me = app.session.user;
  const isAdmin = me.role === 'admin';
  const nowIso = new Date().toISOString();
  const editId = Number(route.query.get('edit') ?? 0) || null;
  const presetReservation = Number(route.query.get('res') ?? 0) || null;

  const [list, summary, reservations] = await Promise.all([
    /** @type {Promise<{ items: import('../api.js').Usage[] }>} */ (get('/api/usage')),
    /** @type {Promise<{ items: Array<{ userId: number, userName: string, trips: number, km: number }>, totalKm: number }>} */ (get('/api/usage/summary')),
    /** @type {Promise<{ items: import('../api.js').Reservation[] }>} */ (get(`/api/reservations?status=confirmed&to=${encodeURIComponent(nowIso)}`)),
  ]);
  const existing = editId ? (list.items.find((u) => u.id === editId) ?? null) : null;
  const lastReading = list.items.find((u) => u.odometerEnd !== null)?.odometerEnd ?? null;

  /**
   * A confirmed reservation by id: from the list when it is there, otherwise from
   * the API (the list ends at "now" and the select below only shows the latest few).
   * @param {number | null} id
   * @returns {Promise<import('../api.js').Reservation | null>}
   */
  const findReservation = async (id) => {
    if (id === null) return null;
    const inList = reservations.items.find((r) => r.id === id);
    if (inList) return inList;
    try {
      const { reservation: found } = /** @type {{ reservation: import('../api.js').Reservation }} */ (await get(`/api/reservations/${id}`));
      return found.status === 'confirmed' ? found : null;
    } catch {
      return null;
    }
  };
  const preset = await findReservation(presetReservation);
  const linked = existing?.reservationId ?? preset?.id ?? null;
  const linkedReservation = await findReservation(linked);

  const driver = driverSelect(app.users, me.id, !isAdmin);
  driver.value = String(existing?.userId ?? preset?.userId ?? me.id);
  if (!isAdmin) driver.value = String(me.id);

  // Latest 20 reservations, newest first, plus the linked one even when it is older (or newer) than those.
  const offered = reservations.items.slice(-20);
  if (linkedReservation && !offered.some((r) => r.id === linkedReservation.id)) offered.push(linkedReservation);
  offered.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));
  const reservation = h('select', { name: 'reservation' }, [
    h('option', { value: '', text: S.usage.noReservation }),
    offered.map((r) => h('option', { value: String(r.id), text: `${r.userName}: ${fmtRange(r.start, r.end, app.tz)}` })),
  ]);
  if (linked !== null && offered.some((r) => r.id === linked)) reservation.value = String(linked);
  const initialLink = reservation.value;

  const roundedNow = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const presetEnd = preset && preset.end < roundedNow.toISOString() ? preset.end : roundedNow.toISOString();
  const start = dateTimeField(S.usage.start, existing?.start ?? preset?.start ?? new Date(roundedNow.getTime() - 3_600_000).toISOString(), app.tz);
  const end = dateTimeField(S.usage.end, existing?.end ?? presetEnd, app.tz);
  const odoStart = numberInput(existing ? existing.odometerStart : lastReading);
  const odoEnd = numberInput(existing ? existing.odometerEnd : null);
  const note = h('input', { type: 'text', maxlength: '500', value: existing?.note ?? '', autocomplete: 'off' });

  const fDriver = field(S.usage.driver, driver);
  const fReservation = field(S.usage.reservation, reservation);
  const fOdoStart = field(`${S.usage.odometerStart} (${S.usage.optional})`, odoStart);
  const fOdoEnd = field(`${S.usage.odometerEnd} (${S.usage.optional})`, odoEnd);
  const fNote = field(S.usage.note, note);
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, S.usage.submit);
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const all = [fDriver, fReservation, start, end, fOdoStart, fOdoEnd, fNote];
        for (const f of all) f.setError(null);
        formError.hidden = true;
        const range = readRange(start, end);
        if (!range) return;
        const a = readNumber(odoStart.value);
        const b = readNumber(odoEnd.value);
        const body = /** @type {Record<string, unknown>} */ ({ ...range, note: note.value });
        const reservationId = readNumber(reservation.value);
        if (existing) {
          // PATCH: null clears a value. The reservation link is only sent when the person
          // changed the select, so an untouched link can never be dropped by accident.
          Object.assign(body, { odometerStart: a, odometerEnd: b });
          if (reservation.value !== initialLink) body['reservationId'] = reservationId;
        } else {
          if (a !== null) body['odometerStart'] = a;
          if (b !== null) body['odometerEnd'] = b;
          if (reservationId !== null) body['reservationId'] = reservationId;
        }
        if (isAdmin && Number(driver.value) !== (existing?.userId ?? me.id)) body['userId'] = Number(driver.value);
        submit.disabled = true;
        try {
          if (existing) await patch(`/api/usage/${existing.id}`, body);
          else await post('/api/usage', body);
          app.toast(S.usage.saved);
          // Leave edit / prefilled mode; otherwise just reload the list with an empty form.
          if (existing || presetReservation) app.navigate('#/usage');
          else await app.refresh();
        } catch (err) {
          const apiErr = /** @type {import('../api.js').ApiError} */ (err);
          showFieldErrors(
            { start, end, odometerStart: fOdoStart, odometerEnd: fOdoEnd, reservationId: fReservation, userId: fDriver, note: fNote },
            apiErr,
          );
          formError.textContent = saveErrorText(apiErr, app.tz, S.usage.overlap);
          formError.hidden = false;
          submit.disabled = false;
        }
      },
    },
    [
      isAdmin ? fDriver.row : null,
      fReservation.row,
      start.row,
      end.row,
      fOdoStart.row,
      fOdoEnd.row,
      fNote.row,
      h('p', { class: 'hint', text: S.reserve.tzNote(app.tz) }),
      formError,
      h('div', { class: 'actions' }, [submit, existing ? h('a', { class: 'btn', href: '#/usage' }, S.cancel) : null]),
    ],
  );

  /** @param {import('../api.js').Usage} u */
  const row = (u) =>
    h('article', { class: 'card usage' }, [
      h('div', { class: 'row' }, [
        h('strong', { text: u.userId === me.id ? S.me : u.userName }),
        u.distanceKm !== null ? h('span', { class: 'badge-status confirmed', text: S.usage.km(u.distanceKm) }) : null,
      ]),
      h('div', { class: 'when', text: fmtRange(u.start, u.end, app.tz) }),
      u.odometerStart !== null || u.odometerEnd !== null
        ? h('div', { class: 'sub', text: `${u.odometerStart ?? '?'} → ${u.odometerEnd ?? '?'} km` })
        : null,
      u.note ? h('div', { class: 'note', text: u.note }) : null,
      u.can.edit || u.can.delete
        ? h('div', { class: 'actions' }, [
            u.can.edit ? h('a', { class: 'btn', href: `#/usage?edit=${u.id}` }, S.edit) : null,
            u.can.delete
              ? h(
                  'button',
                  {
                    class: 'btn danger',
                    type: 'button',
                    onclick: async () => {
                      if (!confirm(S.usage.confirmDelete)) return;
                      try {
                        await del(`/api/usage/${u.id}`);
                        app.toast(S.usage.deleted);
                      } catch (err) {
                        app.toast(errorText(/** @type {Error} */ (err)), true);
                      }
                      await app.refresh();
                    },
                  },
                  S.delete,
                )
              : null,
          ])
        : null,
    ]);

  return h('div', { class: 'usage-view' }, [
    h('h2', { text: existing ? S.usage.editTitle : S.usage.logTitle }),
    form,
    summary.items.length > 0
      ? h('section', { class: 'card' }, [
          h('h3', { text: S.usage.kmTotals }),
          h(
            'ul',
            { class: 'totals' },
            summary.items.map((s) => h('li', {}, [h('span', { text: s.userId === me.id ? S.me : s.userName }), h('span', { text: `${S.usage.km(s.km)} · ${S.usage.trips(s.trips)}` })])),
          ),
          h('p', { class: 'hint', text: S.usage.kmNote }),
        ])
      : null,
    h('h2', { text: S.usage.recent }),
    list.items.length === 0 ? h('p', { class: 'empty', text: S.usage.none }) : list.items.slice(0, 30).map(row),
  ]);
}
