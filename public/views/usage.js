import { del, get, patch, post } from '../api.js';
import {
  dateTimeField,
  driveBody,
  driverSelect,
  field,
  fmtDriveRange,
  fmtRange,
  fmtWhen,
  focusFirstInvalid,
  h,
  kmOwnerControl,
  kmOwnerLine,
  linkNoteToOwner,
  numberInput,
  readDriveTimes,
  readNumber,
  saveErrorText,
  showFieldErrors,
} from '../dom.js';
import { S, errorText } from '../strings.js';

// Contains a form, so it is not re-rendered in the background.
export const live = false;

const DAY_MS = 86_400_000;
/** The reservation picker offers confirmed reservations from this far back to this far ahead. */
const PICKER_BACK_DAYS = 30;
const PICKER_AHEAD_DAYS = 14;
/** An ended reservation is suggested as the one you drove only this long afterwards. */
const SUGGEST_BACK_DAYS = 14;

/**
 * The reservations the picker offers: confirmed ones only, newest first, plus the
 * one the drive is already linked to even when it lies outside the fetched range.
 * No cut-off by count: an upcoming or older reservation must stay selectable.
 * @param {import('../api.js').Reservation[]} items
 * @param {import('../api.js').Reservation | null} [extra]
 * @returns {import('../api.js').Reservation[]}
 */
export function offeredReservations(items, extra = null) {
  /** @type {Map<number, import('../api.js').Reservation>} */
  const byId = new Map();
  for (const r of items) if (r.status === 'confirmed') byId.set(r.id, r);
  if (extra && extra.status === 'confirmed') byId.set(extra.id, extra);
  return [...byId.values()].sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));
}

/**
 * Which reservation to preselect for a new drive: the one the link asked for,
 * else my reservation that is running now and not registered yet, else my most
 * recent ended one (within two weeks) that is not registered, else none.
 * @param {import('../api.js').Reservation[]} offered newest first
 * @param {{ meId: number, nowIso: string, presetId: number | null }} o
 * @returns {import('../api.js').Reservation | null}
 */
export function suggestReservation(offered, o) {
  const preset = o.presetId === null ? undefined : offered.find((r) => r.id === o.presetId);
  if (preset) return preset;
  const mine = offered.filter((r) => r.userId === o.meId && r.kmState !== 'registered');
  const running = mine.find((r) => r.start <= o.nowIso && r.end > o.nowIso);
  if (running) return running;
  const oldest = new Date(Date.parse(o.nowIso) - SUGGEST_BACK_DAYS * DAY_MS).toISOString();
  return mine.find((r) => r.end <= o.nowIso && r.end >= oldest) ?? null;
}

/**
 * What a new drive starts with. Running or upcoming reservation (or none): the
 * drive starts now, the end is still open and the start reading is the last
 * known end reading. An ended reservation: its own times, readings left for the
 * person to enter. A reservation note fills an empty note.
 * @param {import('../api.js').Reservation | null} reservation
 * @param {string} nowIso
 * @param {number | null} lastReading
 * @returns {{ start: string, end: string | null, odometerStart: number | null, note: string }}
 */
export function defaultsFor(reservation, nowIso, lastReading) {
  const minute = new Date(Math.floor(Date.parse(nowIso) / 60_000) * 60_000).toISOString();
  if (reservation && reservation.end <= nowIso) {
    return { start: reservation.start, end: reservation.end, odometerStart: null, note: reservation.note };
  }
  return { start: minute, end: null, odometerStart: lastReading, note: reservation?.note ?? '' };
}

/**
 * The text of the submit button for what the form currently holds.
 * @param {'new' | 'draft' | 'completed'} mode
 * @param {boolean} hasEnd the end date-time is filled in
 * @param {boolean} hasReading the end reading is filled in
 */
export function submitLabel(mode, hasEnd, hasReading) {
  if (!hasEnd && !hasReading && mode !== 'completed') return S.usage.submitDraft;
  return mode === 'draft' ? S.usage.submitFinish : S.usage.submit;
}

/**
 * Log a drive (who actually drove, when, odometer), start one now and finish it
 * later, list recent drives and show kilometres per person.
 * @param {import('../api.js').App} app
 * @param {{ query: URLSearchParams }} route
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  const me = app.session.user;
  const isAdmin = me.role === 'admin';
  const now = new Date();
  const nowIso = now.toISOString();
  const editId = Number(route.query.get('edit') ?? 0) || null;
  const presetId = Number(route.query.get('res') ?? 0) || null;
  const from = new Date(now.getTime() - PICKER_BACK_DAYS * DAY_MS).toISOString();
  const to = new Date(now.getTime() + PICKER_AHEAD_DAYS * DAY_MS).toISOString();

  const [list, summary, reservations, pending] = await Promise.all([
    /** @type {Promise<{ items: import('../api.js').Usage[] }>} */ (get('/api/usage')),
    /** @type {Promise<{ items: Array<{ userId: number, userName: string, trips: number, km: number }>, together?: { trips: number, km: number }, totalKm: number }>} */ (get('/api/usage/summary')),
    /** @type {Promise<{ items: import('../api.js').Reservation[] }>} */ (get(`/api/reservations?status=confirmed&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)),
    /** @type {Promise<import('../api.js').Pending>} */ (get('/api/usage/pending')),
  ]);

  // A drive I started and have not finished is what this form is for: open it in finish mode.
  const openDraft = list.items.find((u) => u.userId === me.id && u.status === 'draft') ?? null;
  const existing = (editId ? list.items.find((u) => u.id === editId) : null) ?? (editId ? null : openDraft);
  const mode = /** @type {'new' | 'draft' | 'completed'} */ (existing ? existing.status : 'new');
  const lastReading = list.items.find((u) => u.odometerEnd !== null)?.odometerEnd ?? null;

  /**
   * A confirmed reservation by id: from the fetched range when it is there,
   * otherwise from the API (it may lie outside the range).
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
  // A drive keeps its link; a draft without one takes the reservation the link asked for (it is linked when finished).
  const wantedId = existing ? (existing.reservationId ?? (existing.status === 'draft' ? presetId : null)) : presetId;
  const offered = offeredReservations(reservations.items, await findReservation(wantedId));
  const selected = existing ? (offered.find((r) => r.id === wantedId) ?? null) : suggestReservation(offered, { meId: me.id, nowIso, presetId });
  const defaults = defaultsFor(existing ? null : selected, nowIso, lastReading);
  const initialLink = existing?.reservationId === null || existing?.reservationId === undefined ? '' : String(existing.reservationId);

  const driver = driverSelect(app.users, me.id, !isAdmin);
  driver.value = String(existing?.userId ?? selected?.userId ?? me.id);
  if (!isAdmin) driver.value = String(me.id);

  const reservation = h('select', { name: 'reservation' }, [
    h('option', { value: '', text: S.usage.noReservation }),
    offered.map((r) => h('option', { value: String(r.id), text: `${r.userName}: ${fmtRange(r.start, r.end, app.tz)}${S.usage.resState[r.kmState] ?? ''}` })),
  ]);
  if (selected) reservation.value = String(selected.id);

  const start = dateTimeField(S.usage.start, existing?.start ?? defaults.start, app.tz);
  // Finishing a draft: the end is now unless the person says otherwise. A new or open drive may leave it empty.
  const minuteNow = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const endInitial = existing ? (existing.end ?? minuteNow) : defaults.end;
  const end = dateTimeField(S.usage.end, endInitial, app.tz, {
    optional: mode !== 'completed',
    hint: mode !== 'completed' ? S.usage.endHint : undefined,
  });
  const odoStart = numberInput(existing ? existing.odometerStart : defaults.odometerStart);
  const odoEnd = numberInput(existing ? existing.odometerEnd : null);
  const note = h('input', { type: 'text', maxlength: '500', value: existing?.note ?? defaults.note, autocomplete: 'off' });

  const fDriver = field(S.usage.driver, driver);
  const fReservation = field(S.usage.reservation, reservation);
  const fOdoStart = field(S.usage.odometerStart, odoStart, lastReading === null ? undefined : S.usage.lastReading(lastReading));
  const fOdoEnd = field(S.usage.odometerEnd, odoEnd);
  const fNote = field(S.usage.note, note, S.noteHint);
  // Whose kilometres these are. The driver stays the driver (obligation, reminders, overlap); only the
  // kilometre totals and the fuel split follow the owner. Anything but "mine" makes the note required.
  const kmOwner = kmOwnerControl({
    users: app.users,
    meId: me.id,
    driverId: Number(driver.value),
    current: existing,
  });
  linkNoteToOwner(kmOwner, fNote, note);
  driver.addEventListener('change', () => kmOwner.setDriver(Number(driver.value)));
  const submit = h('button', { class: 'btn primary block', type: 'submit' });
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const draftLink = h('a', { class: 'btn small', href: '#/usage', hidden: true }, S.usage.pending.finish);

  const syncSubmit = () => {
    submit.textContent = submitLabel(mode, !end.isEmpty(), readNumber(odoEnd.value) !== null);
  };
  end.onInput(syncSubmit);
  odoEnd.addEventListener('input', syncSubmit);
  syncSubmit();

  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const all = [fDriver, fReservation, start, end, fOdoStart, fOdoEnd, kmOwner.field, fNote];
        for (const f of all) f.setError(null);
        formError.hidden = true;
        draftLink.hidden = true;
        const times = readDriveTimes(start, end);
        if (!times) {
          focusFirstInvalid(form);
          return;
        }
        const owner = kmOwner.read();
        const built = driveBody({
          mode,
          start: times.start,
          end: times.end,
          odometerStart: readNumber(odoStart.value),
          odometerEnd: readNumber(odoEnd.value),
          note: note.value,
          owner,
        });
        if (!built.ok) {
          // Nothing is sent: a missing note or person is reported on its field, right here.
          showFieldErrors({ end, odometerStart: fOdoStart, odometerEnd: fOdoEnd, kmUserId: kmOwner.field, note: fNote }, { fields: built.errors });
          focusFirstInvalid(form);
          return;
        }
        const body = built.body;
        // Going back to "mine" on an edit has to be said, since "self" is otherwise left out of the request.
        if (existing && owner.kmFor === 'self' && (existing.kmFor ?? 'self') !== 'self') {
          body['kmFor'] = 'self';
          body['kmUserId'] = null;
        }
        const reservationId = readNumber(reservation.value);
        if (existing) {
          // PATCH: the link is only sent when the person changed the select, so an untouched link can never be dropped.
          if (reservation.value !== initialLink) body['reservationId'] = reservationId;
        } else if (reservationId !== null) {
          body['reservationId'] = reservationId;
        }
        if (isAdmin && Number(driver.value) !== (existing?.userId ?? me.id)) body['userId'] = Number(driver.value);
        submit.disabled = true;
        try {
          if (existing) await patch(`/api/usage/${existing.id}`, body);
          else await post('/api/usage', body);
          const done = built.status === 'draft' ? S.usage.savedDraft : mode === 'draft' ? S.usage.finished : S.usage.saved;
          // A note is recommended, never required: an empty one only earns a friendly tip.
          app.toast(note.value.trim() === '' ? `${done} ${S.noteTip}` : done);
          // Leave edit / prefilled mode; otherwise just reload the list with an empty form.
          if (existing || presetId) app.navigate('#/usage');
          else await app.refresh();
        } catch (err) {
          const apiErr = /** @type {import('../api.js').ApiError} */ (err);
          showFieldErrors(
            { start, end, odometerStart: fOdoStart, odometerEnd: fOdoEnd, reservationId: fReservation, userId: fDriver, kmFor: kmOwner.field, kmUserId: kmOwner.field, note: fNote },
            apiErr,
          );
          formError.textContent = saveErrorText(apiErr, app.tz, S.usage.overlap);
          formError.hidden = false;
          focusFirstInvalid(form);
          if (apiErr.code === 'draft_exists' && typeof apiErr.body['draftId'] === 'number') {
            draftLink.setAttribute('href', `#/usage?edit=${apiErr.body['draftId']}`);
            draftLink.hidden = false;
          }
          submit.disabled = false;
        }
      },
    },
    [
      mode === 'draft' && existing
        ? h('p', { class: 'hint', text: S.usage.openDraft(fmtWhen(existing.start, app.tz)) })
        : null,
      isAdmin ? fDriver.row : null,
      fReservation.row,
      start.row,
      end.row,
      fOdoStart.row,
      fOdoEnd.row,
      kmOwner.row,
      fNote.row,
      h('p', { class: 'hint', text: S.reserve.tzNote(app.tz) }),
      formError,
      draftLink,
      h('div', { class: 'actions' }, [
        submit,
        existing ? h('a', { class: 'btn', href: '#/usage' }, S.cancel) : null,
        mode === 'draft' && existing
          ? h(
              'button',
              {
                class: 'btn danger',
                type: 'button',
                onclick: async () => {
                  if (!confirm(S.usage.confirmDeleteDraft)) return;
                  try {
                    await del(`/api/usage/${existing.id}`);
                    app.toast(S.usage.deleted);
                    app.navigate('#/usage');
                  } catch (err) {
                    app.toast(errorText(/** @type {Error} */ (err)), true);
                  }
                },
              },
              S.usage.deleteDraft,
            )
          : null,
      ]),
    ],
  );

  /** @param {import('../api.js').Usage} u */
  const row = (u) =>
    h('article', { class: 'card usage' }, [
      h('div', { class: 'row' }, [
        h('strong', { text: u.userId === me.id ? S.me : u.userName }),
        u.status === 'draft' ? h('span', { class: 'badge-status expired', text: S.usage.draftBadge }) : null,
        u.distanceKm !== null ? h('span', { class: 'badge-status confirmed', text: S.usage.km(u.distanceKm) }) : null,
      ]),
      h('div', { class: 'when', text: fmtDriveRange(u.start, u.end, app.tz) }),
      u.odometerStart !== null || u.odometerEnd !== null
        ? h('div', { class: 'sub', text: `${u.odometerStart ?? '?'} → ${u.odometerEnd ?? '?'} km` })
        : null,
      kmOwnerLine(u, me.id),
      u.note ? h('div', { class: 'note', text: u.note }) : null,
      u.fuelLocked ? h('p', { class: 'hint', text: S.usage.fuelLocked }) : null,
      u.can.edit || u.can.delete
        ? h('div', { class: 'actions' }, [
            u.can.edit ? h('a', { class: 'btn', href: `#/usage?edit=${u.id}` }, u.status === 'draft' ? S.usage.pending.finish : S.edit) : null,
            u.can.delete
              ? h(
                  'button',
                  {
                    class: 'btn danger',
                    type: 'button',
                    onclick: async () => {
                      if (!confirm(u.status === 'draft' ? S.usage.confirmDeleteDraft : S.usage.confirmDelete)) return;
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
    // Fuel and costs is a second place to go from here, so it sits next to the title where it is seen without scrolling past the form.
    h('div', { class: 'view-head' }, [
      h('h2', { text: mode === 'draft' ? S.usage.finishTitle : existing ? S.usage.editTitle : S.usage.logTitle }),
      h('a', { class: 'btn small', href: '#/fuel' }, S.usage.fuelLink),
    ]),
    pendingBanner(app, pending),
    form,
    summary.items.length > 0 || (summary.together?.km ?? 0) > 0
      ? h('section', { class: 'card' }, [
          h('h3', { text: S.usage.kmTotals }),
          h('ul', { class: 'totals' }, [
            summary.items.map((s) => h('li', {}, [h('span', { text: s.userId === me.id ? S.me : s.userName }), h('span', { text: `${S.usage.km(s.km)} · ${S.usage.trips(s.trips)}` })])),
            // The shared pool is not anybody's: it is shown on its own line (split equally when fuel is paid).
            summary.together && summary.together.km > 0
              ? h('li', {}, [h('span', { text: S.usage.kmTogetherTotal }), h('span', { text: `${S.usage.km(summary.together.km)} · ${S.usage.trips(summary.together.trips)}` })])
              : null,
          ]),
          h('p', { class: 'hint', text: S.usage.kmNote }),
          summary.together && summary.together.km > 0 ? h('p', { class: 'hint', text: S.usage.kmTogetherNote }) : null,
        ])
      : null,
    h('h2', { text: S.usage.recent }),
    list.items.length === 0 ? h('p', { class: 'empty', text: S.usage.none }) : list.items.slice(0, 30).map(row),
  ]);
}

/**
 * The kilometres still to register for the signed-in person: unfinished drives and
 * ended reservations without a completed registration. Null when there is nothing.
 * @param {import('../api.js').App} app
 * @param {import('../api.js').Pending} pending
 * @returns {HTMLElement | null}
 */
export function pendingBanner(app, pending) {
  const mine = pending.items[0];
  if (!mine || pending.count === 0) return null;
  const P = S.usage.pending;
  // A reservation that already has a draft is the same piece of work as the draft: only the draft is listed.
  const reservations = mine.reservations.filter((r) => r.kmState !== 'draft');
  // A named region, not a live region: it is there when the page opens and does not change under the reader.
  return h('section', { class: 'banner', 'aria-labelledby': 'pending-title' }, [
    h('h3', { id: 'pending-title', text: P.title(pending.count) }),
    h('p', { class: 'hint', text: P.intro }),
    h('ul', { class: 'pending' }, [
      mine.drafts.map((d) =>
        h('li', { class: 'pending-row' }, [
          h('div', { text: P.draft(fmtWhen(d.start, app.tz), d.odometerStart) }),
          h('div', { class: 'actions' }, [h('a', { class: 'btn small primary', href: `#/usage?edit=${d.id}` }, P.finish)]),
        ]),
      ),
      reservations.map((r) =>
        h('li', { class: 'pending-row' }, [
          h('div', { text: P.reservation(fmtRange(r.start, r.end, app.tz)) }),
          r.note ? h('div', { class: 'note', text: r.note }) : null,
          h('div', { class: 'actions' }, [
            h('a', { class: 'btn small primary', href: `#/usage?res=${r.id}` }, P.register),
            r.can.cancel
              ? h(
                  'button',
                  {
                    class: 'btn small',
                    type: 'button',
                    onclick: async () => {
                      if (!confirm(P.confirmCancelUnused)) return;
                      try {
                        await del(`/api/reservations/${r.id}`);
                        app.toast(P.cancelled);
                      } catch (err) {
                        app.toast(errorText(/** @type {Error} */ (err)), true);
                      }
                      await app.refresh();
                    },
                  },
                  P.cancelUnused,
                )
              : null,
          ]),
        ]),
      ),
    ]),
  ]);
}
