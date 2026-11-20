import { del, get, post } from '../api.js';
import { VIEWS, calendarHash, clampKey, keyLabel, keysBetween, monthGrid, monthLabel, parseCalendar, reservationDays, stepTarget, viewRange, windowKeys } from '../calendar.js';
import { fmtRange, groupByDay, h, kmOwnerLabel, localDateKey, setBusy } from '../dom.js';
import { S, errorText } from '../strings.js';

export const live = true;

/** The kilometre line and the "Register km" button appear this long before a reservation starts (the push reminder's lead time). */
const LEAD_MS = 30 * 60_000;

/**
 * What a reservation card says about its kilometres and the one button it offers.
 * Nothing is shown before the lead time; the owner (or an admin) gets "Register km"
 * (or "Finish drive" for a started drive); another member gets "I drove this" only
 * once it has started and while nobody has registered or started a drive for it.
 * @param {import('../api.js').Reservation} r
 * @param {number} meId
 * @param {boolean} isAdmin
 * @param {string} nowIso
 * @returns {{ line: string | null, state: import('../api.js').KmState, action: { label: string, href: string } | null }}
 */
export function kmAction(r, meId, isAdmin, nowIso) {
  const none = { line: null, state: r.kmState ?? 'missing', action: null };
  if (r.status !== 'confirmed') return none;
  const drive = r.drive;
  if (r.kmState === 'registered' && drive) {
    // The driver stays the driver; when the kilometres are someone else's or shared, the line says so.
    const owner = kmOwnerLabel(drive, meId);
    const line = S.agenda.kmRegistered(drive.distanceKm ?? 0, drive.userId === meId ? S.me : drive.userName);
    return { line: owner ? `${line} · ${owner}` : line, state: 'registered', action: null };
  }
  if (r.kmState === 'draft' && drive) {
    const own = drive.userId === meId;
    return {
      line: own ? S.agenda.kmDraft : S.agenda.kmDraftBy(drive.userName),
      state: 'draft',
      action: own || isAdmin ? { label: S.agenda.finishDrive, href: `#/usage?edit=${drive.id}` } : null,
    };
  }
  const nowMs = Date.parse(nowIso);
  const startMs = Date.parse(r.start);
  if (r.userId === meId || isAdmin) {
    if (nowMs < startMs - LEAD_MS) return none;
    return { line: S.agenda.kmMissing, state: 'missing', action: { label: S.agenda.registerKm, href: `#/usage?res=${r.id}` } };
  }
  if (nowMs >= startMs) return { line: S.agenda.kmMissing, state: 'missing', action: { label: S.agenda.iDroveThis, href: `#/usage?res=${r.id}` } };
  return none;
}

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
  const km = kmAction(r, app.session.user.id, app.session.user.role === 'admin', nowIso);

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
    km.line ? h('div', { class: `km-line ${km.state}`, text: km.line }) : null,
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
      km.action ? h('a', { class: 'btn primary', href: km.action.href }, km.action.label) : null,
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

// ------------------------------------------------------------------ calendar views
// The view and the day live in the hash query (#/?view=week&date=2026-11-16), so the minute refresh,
// a reload and every action keep them. The date maths is in ../calendar.js; this part only draws.

/**
 * One button per view, the current one marked. aria-pressed is given as the strings 'true' and 'false':
 * h() leaves out a false attribute and writes a true one as an empty string, which is neither.
 * @param {import('../api.js').App} app
 * @param {import('../calendar.js').CalendarState} state
 */
function viewSwitcher(app, state) {
  return h(
    'div',
    { class: 'view-switch', role: 'group', 'aria-label': S.agenda.viewSwitchLabel },
    VIEWS.map((view) =>
      h(
        'button',
        { class: 'btn', type: 'button', 'aria-pressed': view === state.view ? 'true' : 'false', onclick: () => app.navigate(calendarHash(view, state.anchor)) },
        S.agenda.views[view],
      ),
    ),
  );
}

/**
 * Previous, Today and Next for a calendar view. Previous and Next are disabled when the period they lead to
 * is completely outside the six-month window; Today stays available.
 * @param {import('../api.js').App} app
 * @param {Exclude<import('../calendar.js').ViewName, 'list'>} view
 * @param {string} anchor
 * @param {import('../calendar.js').KeyWindow} win
 * @param {string} today
 */
function periodNav(app, view, anchor, win, today) {
  /** @param {-1 | 1} direction */
  const step = (direction) => {
    const target = stepTarget(view, anchor, direction, win);
    return h(
      'button',
      {
        class: 'btn',
        type: 'button',
        disabled: target.disabled,
        'aria-label': S.agenda.stepLabel[direction < 0 ? 'prev' : 'next'][view],
        onclick: () => app.navigate(calendarHash(view, target.key)),
      },
      direction < 0 ? S.agenda.prev : S.agenda.next,
    );
  };
  return h('div', { class: 'cal-nav' }, [
    step(-1),
    h('button', { class: 'btn', type: 'button', onclick: () => app.navigate(calendarHash(view, today)) }, S.agenda.today),
    step(1),
  ]);
}

/**
 * The reservations per local day for the days from..to: one that spans midnight is on every day it touches.
 * @param {import('../api.js').Reservation[]} items
 * @param {string} tz
 * @param {string} from
 * @param {string} to
 * @returns {Map<string, import('../api.js').Reservation[]>}
 */
function reservationsByDay(items, tz, from, to) {
  /** @type {Map<string, import('../api.js').Reservation[]>} */
  const byDay = new Map();
  const ordered = [...items].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id));
  for (const r of ordered) {
    for (const key of reservationDays(r, tz, from, to)) {
      const list = byDay.get(key);
      if (list) list.push(r);
      else byDay.set(key, [r]);
    }
  }
  return byDay;
}

/**
 * Day, 3 days and Week: one section per local day (inside the window), each with the cards of the
 * reservations that touch it. The single h2 is the period; landOnView focuses it after a step.
 * @param {import('../api.js').App} app
 * @param {'day' | '3days' | 'week'} view
 * @param {import('../calendar.js').CalendarState} state
 * @param {import('../api.js').Reservation[]} items
 * @param {import('../calendar.js').KeyWindow} win
 * @param {string} today
 * @param {string} nowIso
 */
function daysView(app, view, state, items, win, today, nowIso) {
  const range = viewRange(view, state.anchor);
  const keys = keysBetween(clampKey(range.from, win), clampKey(range.to, win));
  const byDay = reservationsByDay(items, app.tz, keys[0] ?? range.from, keys[keys.length - 1] ?? range.to);
  const title =
    view === 'day' ? S.agenda.dayHeading(keyLabel(state.anchor, 'day'), state.anchor === today) : S.agenda.range(keyLabel(range.from, 'date'), keyLabel(range.to, 'date'));
  return [
    h('h2', { class: 'cal-title', text: title }),
    periodNav(app, view, state.anchor, win, today),
    keys.map((key) => {
      const list = byDay.get(key) ?? [];
      return h('section', { class: `day cal-day${key === today ? ' today' : ''}` }, [
        // A single day is named by the h2 already.
        view === 'day' ? null : h('h3', { class: 'day-heading', text: S.agenda.dayHeading(keyLabel(key, 'day'), key === today) }),
        list.length === 0 ? h('p', { class: 'hint', text: S.agenda.nothingThisDay }) : list.map((r) => reservationCard(app, r, r.end < nowIso)),
      ]);
    }),
  ];
}

/**
 * Month: a grid of days, Monday first, with the number of reservations on each; a day opens the Day view.
 * Days of the neighbouring months are shown muted, days outside the window cannot be opened.
 * @param {import('../api.js').App} app
 * @param {import('../calendar.js').CalendarState} state
 * @param {import('../api.js').Reservation[]} items
 * @param {import('../calendar.js').KeyWindow} win
 * @param {string} today
 */
function monthView(app, state, items, win, today) {
  const keys = monthGrid(state.anchor).flat();
  const byDay = reservationsByDay(items, app.tz, keys[0] ?? state.anchor, keys[keys.length - 1] ?? state.anchor);
  const month = state.anchor.slice(0, 7);
  const cells = keys.map((key) => {
    const list = byDay.get(key) ?? [];
    const pending = list.filter((r) => r.status === 'pending').length;
    const classes = ['cal-cell'];
    if (!key.startsWith(month)) classes.push('out');
    if (key === today) classes.push('today');
    if (pending > 0) classes.push('has-pending');
    return h(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        disabled: key < win.min || key > win.max,
        'aria-label': S.agenda.cellLabel(keyLabel(key, 'day'), key === today, list.length, pending),
        'aria-current': key === today ? 'date' : false,
        onclick: () => app.navigate(calendarHash('day', key)),
      },
      [h('span', { class: 'cal-num', 'aria-hidden': 'true', text: String(Number(key.slice(8))) }), list.length > 0 ? h('span', { class: 'cal-count', 'aria-hidden': 'true', text: String(list.length) }) : null],
    );
  });
  return [
    h('h2', { class: 'cal-title', text: monthLabel(state.anchor) }),
    periodNav(app, 'month', state.anchor, win, today),
    h('div', { class: 'cal-grid' }, [S.agenda.weekdays.map((d) => h('div', { class: 'cal-head', 'aria-hidden': 'true', text: d })), cells]),
    h('p', { class: 'hint', text: S.agenda.monthHint }),
  ];
}

/**
 * @param {import('../api.js').App} app
 * @param {{ query?: URLSearchParams }} [route] the hash route; its query holds view and date
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, route) {
  /** @type {{ items: import('../api.js').Reservation[] }} */
  const { items: all } = await get('/api/reservations');
  // Declined and expired suggestions live in the inbox, not in the agenda.
  const items = all.filter((r) => r.status === 'confirmed' || r.status === 'pending');
  const nowIso = new Date().toISOString();
  const win = windowKeys(nowIso, app.tz, app.session.windowMonths);
  const today = localDateKey(nowIso, app.tz);
  const state = parseCalendar(route?.query, today, win);
  const switcher = viewSwitcher(app, state);
  const windowNote = h('p', { class: 'hint center', text: S.agenda.windowNote(app.session.windowMonths) });
  const view = state.view;
  if (view !== 'list') {
    return h('div', { class: 'agenda calendar' }, [switcher, view === 'month' ? monthView(app, state, items, win, today) : daysView(app, view, state, items, win, today, nowIso), windowNote]);
  }
  const upcoming = items.filter((r) => r.end >= nowIso);
  // Newest first for what is behind us, oldest first for what is coming.
  const earlier = items.filter((r) => r.end < nowIso).reverse();
  return h('div', { class: 'agenda' }, [
    switcher,
    h('h2', { text: S.agenda.upcoming }),
    upcoming.length === 0
      ? h('div', { class: 'empty' }, [h('p', { text: S.agenda.nothingUpcoming }), h('a', { class: 'btn primary', href: '#/reserve' }, S.agenda.reserveCta)])
      : dayGroups(app, upcoming, false),
    earlier.length > 0
      ? h('details', { class: 'earlier' }, [h('summary', { text: `${S.agenda.past} (${earlier.length})` }), dayGroups(app, earlier, true)])
      : null,
    windowNote,
  ]);
}
