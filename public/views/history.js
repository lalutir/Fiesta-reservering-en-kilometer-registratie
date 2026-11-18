import { get } from '../api.js';
import { fmtDriveRange, fmtRange, groupByDay, h } from '../dom.js';
import { S } from '../strings.js';

export const live = true;

/**
 * @typedef {import('../api.js').Usage & {
 *   reservation: { id: number, userId: number, userName: string, start: string, end: string } | null,
 *   sameDriver: boolean | null
 * }} HistoryUsage
 */

/**
 * Combine drives and confirmed reservations into one newest-first timeline:
 * every logged drive (with who reserved it) plus reservations that are over but
 * have no drive logged against them.
 * @param {HistoryUsage[]} usage
 * @param {import('../api.js').Reservation[]} reservations
 * @param {string} nowIso
 * @returns {Array<{ kind: 'drive', start: string, usage: HistoryUsage } | { kind: 'unused', start: string, reservation: import('../api.js').Reservation }>}
 */
export function buildTimeline(usage, reservations, nowIso) {
  const linked = new Set(usage.map((u) => u.reservationId).filter((id) => id !== null));
  /** @type {Array<{ kind: 'drive', start: string, usage: HistoryUsage } | { kind: 'unused', start: string, reservation: import('../api.js').Reservation }>} */
  const entries = usage.map((u) => ({ kind: /** @type {const} */ ('drive'), start: u.start, usage: u }));
  for (const r of reservations) {
    if (r.end >= nowIso || linked.has(r.id) || r.kmState === 'registered') continue;
    // A drive logged without a link but inside the reserved time also counts as used.
    // A drive that is still open (no end yet) runs up to now.
    const covered = usage.some((u) => u.start < r.end && r.start < (u.end ?? nowIso));
    if (!covered) entries.push({ kind: /** @type {const} */ ('unused'), start: r.start, reservation: r });
  }
  return entries.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
}

/**
 * Reserved versus actual driver, newest first.
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement>}
 */
export async function render(app) {
  /** @type {{ usage: HistoryUsage[], reservations: import('../api.js').Reservation[] }} */
  const data = await get('/api/history');
  const timeline = buildTimeline(data.usage, data.reservations, new Date().toISOString());
  const me = app.session.user.id;

  /** @param {typeof timeline[number]} entry */
  const card = (entry) => {
    if (entry.kind === 'unused') {
      const r = entry.reservation;
      return h('article', { class: 'card history unused' }, [
        h('div', { class: 'row' }, [h('strong', { text: S.history.reservedBy(r.userId === me ? S.me : r.userName) }), h('span', { class: 'badge-status expired', text: S.history.notDriven })]),
        h('div', { class: 'when', text: fmtRange(r.start, r.end, app.tz) }),
        r.note ? h('div', { class: 'note', text: r.note }) : null,
      ]);
    }
    const u = entry.usage;
    return h('article', { class: 'card history' }, [
      h('div', { class: 'row' }, [
        h('strong', { text: S.history.drivenBy(u.userId === me ? S.me : u.userName) }),
        u.status === 'draft' ? h('span', { class: 'badge-status expired', text: S.history.notFinished }) : null,
        u.distanceKm !== null ? h('span', { class: 'badge-status confirmed', text: S.usage.km(u.distanceKm) }) : null,
      ]),
      h('div', { class: 'when', text: fmtDriveRange(u.start, u.end, app.tz) }),
      h('div', { class: 'sub' }, [
        u.reservation ? S.history.reservedBy(u.reservation.userId === me ? S.me : u.reservation.userName) : S.history.noReservation,
        u.sameDriver === null ? null : ` · ${u.sameDriver ? S.history.sameDriver : S.history.otherDriver}`,
      ]),
      u.note ? h('div', { class: 'note', text: u.note }) : null,
    ]);
  };

  return h('div', { class: 'history-view' }, [
    h('h2', { text: S.history.title }),
    timeline.length === 0
      ? h('p', { class: 'empty', text: S.history.none })
      : groupByDay(timeline, (e) => e.start, app.tz).map((g) =>
          h('section', { class: 'day' }, [h('h3', { class: 'day-heading', text: g.label }), g.items.map(card)]),
        ),
    h('p', { class: 'hint center', text: S.agenda.windowNote(app.session.windowMonths) }),
  ]);
}
