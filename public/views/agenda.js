import { del, get, post } from '../api.js';
import { fmtRange, groupByDay, h, setBusy } from '../dom.js';
import { S, errorText } from '../strings.js';

export const live = true;

/**
 * One reservation as a card with the actions the server says are allowed.
 * @param {import('../api.js').App} app
 * @param {import('../api.js').Reservation} r
 * @param {boolean} past
 * @returns {HTMLElement}
 */
export function reservationCard(app, r, past) {
  const mine = r.userId === app.session.user.id;
  const iCreated = r.createdBy === app.session.user.id;
  const nowIso = new Date().toISOString();
  const canLogDrive = r.status === 'confirmed' && mine && r.start <= nowIso;

  /**
   * Runs one action; the card's buttons stay disabled until the list is reloaded.
   * @param {Event} event the click that started it
   * @param {() => Promise<unknown>} action
   * @param {string} done
   */
  const act = async (event, action, done) => {
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
  };

  const who = mine ? S.me : r.userName;
  const subtitle = r.suggestion
    ? iCreated
      ? S.agenda.suggestedFor(r.userName)
      : S.agenda.suggestedBy(r.createdByName)
    : null;
  const withdrawing = r.status !== 'confirmed';

  return h('article', { class: `card reservation ${r.status}${past ? ' past' : ''}` }, [
    h('div', { class: 'row' }, [
      h('strong', { class: 'what', text: who }),
      h('span', { class: `badge-status ${r.status}`, text: S.status[r.status] }),
    ]),
    h('div', { class: 'when', text: fmtRange(r.start, r.end, app.tz) }),
    subtitle ? h('div', { class: 'sub', text: subtitle }) : null,
    r.note ? h('div', { class: 'note', text: r.note }) : null,
    h('div', { class: 'actions' }, [
      r.can.approve
        ? h('button', { class: 'btn primary', type: 'button', onclick: (/** @type {Event} */ e) => void act(e, () => post(`/api/reservations/${r.id}/approve`), S.agenda.approved) }, S.agenda.approve)
        : null,
      r.can.decline
        ? h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: (/** @type {Event} */ e) => {
                // Declining cannot be undone and sits right next to Approve: ask first.
                if (!confirm(S.agenda.confirmDecline)) return;
                void act(e, () => post(`/api/reservations/${r.id}/decline`), S.agenda.declined);
              },
            },
            S.agenda.decline,
          )
        : null,
      canLogDrive ? h('a', { class: 'btn', href: `#/usage?res=${r.id}` }, S.agenda.logDrive) : null,
      r.can.edit ? h('a', { class: 'btn', href: `#/reserve/${r.id}` }, S.edit) : null,
      r.can.cancel
        ? h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onclick: (/** @type {Event} */ e) => {
                if (!confirm(withdrawing ? S.agenda.confirmWithdraw : S.agenda.confirmCancel)) return;
                void act(e, () => del(`/api/reservations/${r.id}`), withdrawing ? S.agenda.withdrawn : S.agenda.cancelled);
              },
            },
            withdrawing ? S.agenda.withdraw : S.agenda.cancelReservation,
          )
        : null,
    ]),
  ]);
}

/**
 * @param {import('../api.js').App} app
 * @param {import('../api.js').Reservation[]} items
 * @param {boolean} past
 */
function dayGroups(app, items, past) {
  return groupByDay(items, (r) => r.start, app.tz).map((g) =>
    h('section', { class: 'day' }, [h('h3', { class: 'day-heading', text: g.label }), g.items.map((r) => reservationCard(app, r, past))]),
  );
}

/**
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement>}
 */
export async function render(app) {
  /** @type {{ items: import('../api.js').Reservation[] }} */
  const { items: all } = await get('/api/reservations');
  // Declined and expired suggestions live in the inbox, not in the agenda.
  const items = all.filter((r) => r.status === 'confirmed' || r.status === 'pending');
  const nowIso = new Date().toISOString();
  const upcoming = items.filter((r) => r.end >= nowIso);
  // Newest first for what is behind us, oldest first for what is coming.
  const earlier = items.filter((r) => r.end < nowIso).reverse();
  return h('div', { class: 'agenda' }, [
    h('h2', { text: S.agenda.upcoming }),
    upcoming.length === 0
      ? h('div', { class: 'empty' }, [h('p', { text: S.agenda.nothingUpcoming }), h('a', { class: 'btn primary', href: '#/reserve' }, S.agenda.reserveCta)])
      : dayGroups(app, upcoming, false),
    earlier.length > 0
      ? h('details', { class: 'earlier' }, [h('summary', { text: `${S.agenda.past} (${earlier.length})` }), dayGroups(app, earlier, true)])
      : null,
    h('p', { class: 'hint center', text: S.agenda.windowNote(app.session.windowMonths) }),
  ]);
}
