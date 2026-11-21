import { get } from '../api.js';
import { fmtDriveRange, fmtRange, fmtWhen, groupByDay, h, kmOwnerLine, setBusy } from '../dom.js';
import { kmMarkers } from '../kmcheck.js';
import { S, errorText } from '../strings.js';
import { carriedRows, fmtCents, selfPaidButton, shareStatus } from './fuel.js';

export const live = true;

/** Paid and settled fill-ups listed under "Fuel you owe" next to the open ones; older ones are on the Fuel screen. */
const SETTLED_SHOWN = 5;

/**
 * The fill-ups where this person has a share to pay, open ones first and then the latest few that are
 * paid or settled, each with the share to show. The fueler's own share of their own fill-up is not owed.
 * @param {import('../api.js').Fuel[]} fuels newest first, as the API sends them
 * @param {number} meId
 * @returns {Array<{ fuel: import('../api.js').Fuel, share: import('../api.js').FuelShare, open: boolean }>}
 */
export function fuelOwed(fuels, meId) {
  const rows = fuels.flatMap((fuel) => {
    const share = fuel.shares.find((s) => s.userId === meId);
    if (!share || !share.owes || fuel.userId === meId) return [];
    const done = Boolean(share.request?.paidAt) || Boolean(share.settledBy);
    return [{ fuel, share, open: !done }];
  });
  return [...rows.filter((r) => r.open), ...rows.filter((r) => !r.open).slice(0, SETTLED_SHOWN)];
}

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
  /** @type {[{ usage: HistoryUsage[], reservations: import('../api.js').Reservation[] }, { items: import('../api.js').Fuel[] } | null, import('../api.js').OdometerChain | null]} */
  const [data, fuel, odometer] = await Promise.all([
    get('/api/history'),
    // The fuel part and the kilometre markers are conveniences on this screen: if they cannot be loaded the history still shows.
    get('/api/fuel').catch(() => null),
    get('/api/odometer').catch(() => null),
  ]);
  const timeline = buildTimeline(data.usage, data.reservations, new Date().toISOString());
  const me = app.session.user.id;
  const owed = fuelOwed(fuel?.items ?? [], me);

  /**
   * After the view is rebuilt, keyboard and screen reader focus goes back to the fill-up the person
   * was working on (or the page heading when it is no longer listed), not to nowhere.
   * @param {number} fuelId
   */
  const refocus = (fuelId) => {
    const target = document.getElementById(`owed-${fuelId}`) ?? document.querySelector('.history-view h2');
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  /**
   * Run one action with its buttons disabled (a double tap cannot send it twice), report, and reload.
   * @param {Event} event
   * @param {number} fuelId
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

  /** @param {{ fuel: import('../api.js').Fuel, share: import('../api.js').FuelShare, open: boolean }} row */
  const owedRow = ({ fuel: f, share: s, open }) => {
    const status = shareStatus(s);
    // A request that exists keeps its amount; with none yet, the share plus what is carried is what is due.
    const due = s.dueCents && s.dueCents > 0 ? s.dueCents : (s.request?.amountCents ?? s.cents);
    // With something carried the rows add up in order (this fill-up, plus what is open, to pay), so the
    // total is not said twice; without it the one line is the amount.
    const carried = open ? carriedRows(f, s, (name, id) => (id === me ? S.me : name)) : [];
    const amountLine = !open
      ? S.history.fuelOwedPaid(fmtCents(s.request?.amountCents ?? due))
      : carried.length > 0
        ? S.history.fuelOwedShare(fmtCents(s.cents))
        : S.history.fuelOwedDue(fmtCents(due));
    return h('li', { class: 'share', id: `owed-${f.id}` }, [
      h('div', { class: 'row owed-head' }, [
        h('strong', { text: S.history.fuelOwedHeader(f.userName, fmtWhen(f.at, app.tz)) }),
        open ? null : h('span', { class: `chip ${status === 'paidChanged' ? 'changed' : status}`, text: S.fuel.status[status] }),
      ]),
      h('div', { text: amountLine }),
      carried,
      s.settledBy ? h('div', { class: 'sub', text: S.fuel.settledBy(fmtWhen(s.settledBy.at, app.tz)) }) : null,
      s.can.selfPaid ? h('div', { class: 'actions' }, [selfPaidButton(f, s, act)]) : null,
    ]);
  };

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
      kmOwnerLine(u, me),
      kmMarkers(u, odometer?.items ?? []),
      u.note ? h('div', { class: 'note', text: u.note }) : null,
    ]);
  };

  return h('div', { class: 'history-view' }, [
    h('h2', { text: S.history.title }),
    owed.length > 0
      ? h('section', { class: 'card', 'aria-labelledby': 'fuel-owed-title' }, [
          h('h3', { id: 'fuel-owed-title', text: S.history.fuelOwed }),
          owed.some((r) => r.open) ? h('p', { class: 'hint', text: S.history.fuelOwedIntro }) : null,
          h('ul', { class: 'shares' }, owed.map(owedRow)),
        ])
      : null,
    timeline.length === 0
      ? h('p', { class: 'empty', text: S.history.none })
      : groupByDay(timeline, (e) => e.start, app.tz).map((g) =>
          h('section', { class: 'day' }, [h('h3', { class: 'day-heading', text: g.label }), g.items.map(card)]),
        ),
    h('p', { class: 'hint center', text: S.agenda.windowNote(app.session.windowMonths) }),
  ]);
}
