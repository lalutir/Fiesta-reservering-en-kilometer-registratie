// Start: what matters right now, in the order it matters, built only from endpoints that already exist.
//
//   the car now (who has it, who is next) · answers waiting · kilometres to register · my next reservation ·
//   what I owe and what I am owed · the APK · damage · two quick rows
//
// Each block loads on its own: when one request fails only that block says so, with its own "Opnieuw proberen", and
// the rest of the screen is untouched. A block that has nothing to say about a thing that needs attention (no answers
// waiting, no kilometres to register) is simply not there; the others say what is empty and what to do about it.
// The rules for each block are pure functions (carNow, myNext, owedSummary, damageSummary) and are tested on their own.
import { get } from '../api.js';
import { fmtWhen, formatEuro, h, localDateKey } from '../dom.js';
import { icon } from '../icons.js';
import { S } from '../strings.js';
import { errorState, linkButton, listRow, skeleton } from '../ui.js';
import { reservationCard } from './agenda.js';
import { apkSummary } from './car.js';
import { fuelOwed } from './history.js';
import { pendingBanner } from './usage.js';

export const live = true;

/** A damage report is "new" this long after it was reported (nothing is stored for it: the report's own date says so). */
export const NEW_DAMAGE_MS = 7 * 86_400_000;
/** Drives and reservations a little way back and ahead are enough to know who has the car now and who is next. */
const LOOK_BACK_MS = 7 * 86_400_000;
const LOOK_AHEAD_MS = 60 * 86_400_000;

// ------------------------------------------------------------------ the rules

/**
 * Earliest start first; the id settles a tie. Swap the arguments for the latest first.
 * @param {{ start: string, id: number }} a
 * @param {{ start: string, id: number }} b
 */
const earliestFirst = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id);

/**
 * Who has the car now: someone with a drive that has started and not ended is on the road; otherwise the person whose
 * confirmed reservation covers this moment; otherwise nobody. The next confirmed reservation is named in every case.
 * @param {import('../api.js').Reservation[]} reservations
 * @param {import('../api.js').Usage[]} drives
 * @param {string} nowIso
 * @returns {{ state: 'driving' | 'reserved' | 'free', driving: import('../api.js').Usage | null, current: import('../api.js').Reservation | null, next: import('../api.js').Reservation | null }}
 */
export function carNow(reservations, drives, nowIso) {
  const driving = drives.filter((d) => d.status === 'draft').sort((a, b) => earliestFirst(b, a))[0] ?? null;
  const confirmed = reservations.filter((r) => r.status === 'confirmed').sort(earliestFirst);
  const current = confirmed.find((r) => r.start <= nowIso && nowIso < r.end) ?? null;
  const next = confirmed.find((r) => r.start > nowIso) ?? null;
  return { state: driving ? 'driving' : current ? 'reserved' : 'free', driving, current, next };
}

/**
 * The first confirmed reservation of this person that has not ended (one that is going on now counts).
 * @param {import('../api.js').Reservation[]} reservations
 * @param {number} meId
 * @param {string} nowIso
 * @returns {import('../api.js').Reservation | null}
 */
export function myNext(reservations, meId, nowIso) {
  return reservations.filter((r) => r.status === 'confirmed' && r.userId === meId && r.end >= nowIso).sort(earliestFirst)[0] ?? null;
}

/**
 * What this person owes and is owed, from the balances the server already works out, and how many payment
 * requests (asked, not yet paid) are waiting for their "Ik heb betaald".
 * @param {import('../api.js').Balance[]} balances
 * @param {import('../api.js').Fuel[]} fuels
 * @param {number} meId
 * @returns {{ owe: Array<{ name: string, cents: number }>, get: Array<{ name: string, cents: number }>, oweTotal: number, getTotal: number, open: number }}
 */
export function owedSummary(balances, fuels, meId) {
  const owe = balances.filter((b) => b.fromUserId === meId && b.cents > 0).map((b) => ({ name: b.toName, cents: b.cents }));
  const get = balances.filter((b) => b.toUserId === meId && b.cents > 0).map((b) => ({ name: b.fromName, cents: b.cents }));
  const sum = (/** @type {Array<{ cents: number }>} */ rows) => rows.reduce((total, r) => total + r.cents, 0);
  return { owe, get, oweTotal: sum(owe), getTotal: sum(get), open: fuelOwed(fuels, meId).filter((r) => r.open && r.share.request !== null).length };
}

/**
 * The open damage reports: how many, the newest one, and whether it was reported in the last week.
 * @param {import('../api.js').DamageReport[]} reports
 * @param {string} nowIso
 * @returns {{ open: number, newest: import('../api.js').DamageReport | null, fresh: boolean }}
 */
export function damageSummary(reports, nowIso) {
  const open = reports.filter((r) => r.status === 'open').sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
  const newest = open[0] ?? null;
  return { open: open.length, newest, fresh: newest !== null && Date.parse(nowIso) - Date.parse(newest.createdAt) < NEW_DAMAGE_MS };
}

// ------------------------------------------------------------------ the blocks

/**
 * @typedef {object} Context
 * @property {import('../api.js').App} app
 * @property {string} nowIso
 * @property {string} today
 */
/**
 * @typedef {object} Block
 * @property {string} id
 * @property {string} title what to say when it could not be loaded
 * @property {string[]} paths the requests it needs
 * @property {boolean} [wide] takes the whole row of the grid
 * @property {(data: any[], ctx: Context) => HTMLElement | null} paint null: nothing to show
 */

/** @param {string} title @param {unknown} body @param {string} [extra] */
const section = (title, body, extra = '') => h('section', { class: `home-block${extra ? ` ${extra}` : ''}` }, [h('h3', { text: title }), body]);

/** @type {Block[]} */
const BLOCKS = [
  {
    id: 'car',
    title: S.home.carNow,
    wide: true,
    paths: ['reservations', 'drives'],
    paint: ([reservations, drives], { app, nowIso }) => {
      const me = app.session.user.id;
      const now = carNow(reservations.items, drives.items, nowIso);
      const nextLine = now.next ? S.home.nextIs(now.next.userId === me ? S.meHead : now.next.userName, fmtWhen(now.next.start, app.tz)) : S.home.nothingPlanned;
      /** @type {string} */
      let big;
      /** @type {string} */
      let sub;
      if (now.driving) {
        big = now.driving.userId === me ? S.home.drivingMe : S.home.driving(now.driving.userName);
        sub = S.home.since(fmtWhen(now.driving.start, app.tz));
      } else if (now.current) {
        big = now.current.userId === me ? S.home.hasItMe : S.home.hasIt(now.current.userName);
        sub = S.home.reservedUntil(fmtWhen(now.current.end, app.tz));
      } else {
        big = S.home.free;
        sub = nextLine;
      }
      const mineDraft = now.driving && (now.driving.userId === me || app.session.user.role === 'admin') ? now.driving : null;
      return h('section', { class: `home-block car-now${now.state === 'free' ? '' : ' out'}` }, [
        icon('car'),
        h('div', { class: 'car-now-text' }, [
          h('h3', { text: S.home.carNow }),
          h('p', { class: 'big', text: big }),
          h('p', { class: 'sub', text: sub }),
          // While somebody has the car, the next person is still worth a line.
          now.state !== 'free' ? h('p', { class: 'sub', text: nextLine }) : null,
          mineDraft ? h('div', { class: 'actions' }, [linkButton({ label: S.home.finishDrive, href: `#/usage?edit=${mineDraft.id}`, variant: 'primary' })]) : null,
        ]),
      ]);
    },
  },
  {
    id: 'answers',
    title: S.home.answers,
    // A call to answer someone, like the kilometre banner below it: a full row, so a tablet or desktop grid has no hole beside it.
    wide: true,
    paths: ['inbox'],
    paint: ([inbox]) => {
      if (!inbox.incomingCount) return null;
      return section(S.home.answers, [h('p', { class: 'big', text: S.home.answersWaiting(inbox.incomingCount) }), h('div', { class: 'actions' }, [linkButton({ label: S.home.answersOpen, href: '#/inbox', variant: 'primary' })])]);
    },
  },
  {
    id: 'km',
    title: S.home.kmTitle,
    wide: true,
    paths: ['pending'],
    paint: ([pending], { app }) => pendingBanner(app, pending),
  },
  {
    id: 'mine',
    title: S.home.mine,
    paths: ['reservations'],
    paint: ([reservations], { app, nowIso }) => {
      const next = myNext(reservations.items, app.session.user.id, nowIso);
      if (!next) return section(S.home.mine, [h('p', { class: 'sub', text: S.home.mineNone }), h('div', { class: 'actions' }, [linkButton({ label: S.home.mineCta, href: '#/reserve' })])]);
      return section(S.home.mine, reservationCard(app, next, false), 'flat');
    },
  },
  {
    id: 'money',
    title: S.home.money,
    paths: ['fuel'],
    paint: ([fuel], { app }) => {
      const sum = owedSummary(fuel.balances, fuel.items, app.session.user.id);
      if (sum.owe.length === 0 && sum.get.length === 0 && sum.open === 0) return section(S.home.money, h('p', { class: 'sub', text: S.home.moneyNone }));
      /** @param {string} title @param {Array<{ name: string, cents: number }>} rows @param {(name: string) => string} who */
      const lines = (title, rows, who) =>
        rows.length === 0
          ? null
          : h('div', {}, [h('h4', { class: 'sub', text: title }), h('ul', { class: 'totals' }, rows.map((r) => h('li', {}, [h('span', { text: who(r.name) }), h('strong', { text: formatEuro(r.cents) })])))]);
      return section(S.home.money, [
        lines(S.home.youPay, sum.owe, S.home.to),
        lines(S.home.youGet, sum.get, S.home.from),
        sum.open > 0 ? h('p', { class: 'km-line missing', text: S.home.openRequests(sum.open) }) : null,
        h('div', { class: 'actions' }, [linkButton({ label: S.home.moneyOpen, href: '#/history', variant: sum.open > 0 ? 'primary' : 'secondary' })]),
      ]);
    },
  },
  {
    id: 'apk',
    title: S.car.apk.title,
    paths: ['apk'],
    paint: ([apkData], { today }) => {
      /** @type {import('../api.js').Apk} */
      const apk = apkData.apk;
      if (!apk.expiresOn) return section(S.car.apk.title, [h('p', { class: 'sub', text: S.car.apk.notSet }), h('div', { class: 'actions' }, [linkButton({ label: S.home.toCar, href: '#/car' })])]);
      const state = apkSummary(apk.expiresOn, today);
      return section(S.car.apk.title, [
        h('p', {}, [h('span', { class: `badge-status ${state.kind === 'ok' ? 'confirmed' : state.kind === 'expired' ? 'declined' : 'pending'}`, text: state.badge })]),
        h('p', { class: 'big', text: state.headline }),
        h('p', { class: 'sub', text: state.detail }),
        state.kind === 'ok' ? null : h('div', { class: 'actions' }, [linkButton({ label: S.home.toCar, href: '#/car' })]),
      ]);
    },
  },
  {
    id: 'damage',
    title: S.home.damage,
    paths: ['damage'],
    paint: ([damage], { app, nowIso }) => {
      const sum = damageSummary(damage.items, nowIso);
      if (!sum.newest) return section(S.home.damage, h('p', { class: 'sub', text: S.car.noneOpen }));
      return section(S.home.damage, [
        h('p', {}, [sum.fresh ? h('span', { class: 'badge-status declined', text: S.home.damageNew }) : null]),
        h('p', { class: 'big', text: S.home.damageOpen(sum.open) }),
        h('p', { class: 'sub', text: S.home.damageNewest(S.car.location[sum.newest.location], fmtWhen(sum.newest.createdAt, app.tz)) }),
        h('div', { class: 'actions' }, [linkButton({ label: S.home.toCar, href: '#/car' })]),
      ]);
    },
  },
  {
    id: 'quick',
    title: S.home.quick,
    wide: true,
    paths: [],
    paint: () =>
      section(
        S.home.quick,
        h('div', { class: 'list' }, [
          listRow({ title: S.home.quickFuel, sub: S.home.quickFuelSub, href: '#/fuel', icon: 'fuel' }),
          listRow({ title: S.home.quickDamage, sub: S.home.quickDamageSub, href: '#/car', icon: 'wrench' }),
        ]),
      ),
  },
];

/** What each path name asks the server for: the same endpoints the other screens use, nothing new. @param {string} nowIso @returns {Record<string, string>} */
function endpoints(nowIso) {
  const now = Date.parse(nowIso);
  const range = (/** @type {number} */ back, /** @type {number} */ ahead) => `from=${encodeURIComponent(new Date(now - back).toISOString())}&to=${encodeURIComponent(new Date(now + ahead).toISOString())}`;
  return {
    reservations: `/api/reservations?status=confirmed&${range(LOOK_BACK_MS, LOOK_AHEAD_MS)}`,
    drives: `/api/usage?${range(LOOK_BACK_MS, 86_400_000)}`,
    pending: '/api/usage/pending',
    inbox: '/api/inbox',
    fuel: '/api/fuel',
    apk: '/api/car/apk',
    damage: '/api/damage',
  };
}

/**
 * What the last good answers were, per request, and for whom. A background refresh (silent) that cannot reach the server
 * for one request paints that block again from this, so the landing screen keeps what it showed instead of turning into
 * seven error blocks the moment the phone wakes up before its network does.
 * @type {{ userId: number, answers: Map<string, any> }}
 */
let lastGood = { userId: 0, answers: new Map() };

/**
 * @param {import('../api.js').App} app
 * @param {unknown} [_route] the hash route (Start has no parameters)
 * @param {{ silent?: boolean }} [opts] silent = background refresh: a block whose request failed keeps its last good answer
 * @returns {Promise<HTMLElement>}
 */
export async function render(app, _route, opts = {}) {
  const silent = opts.silent === true;
  // Anything that is not a background refresh (a visit, a retry, a redraw after an action) starts from what the server says
  // now, and a different person never sees the last answers of the one before.
  if (!silent || lastGood.userId !== app.session.user.id) lastGood = { userId: app.session.user.id, answers: new Map() };
  const good = lastGood.answers;
  const nowIso = new Date().toISOString();
  const urls = endpoints(nowIso);
  /** @type {Context} */
  const ctx = { app, nowIso, today: localDateKey(nowIso, app.tz) };
  /** One request per path and render: blocks that share a path share the answer. @type {Map<string, Promise<any>>} */
  const cache = new Map();
  const load = (/** @type {string} */ path) => {
    let promise = cache.get(path);
    if (!promise) {
      promise = get(/** @type {string} */ (urls[path]));
      cache.set(path, promise);
    }
    return promise;
  };

  /**
   * Fill a block's slot: its answer, nothing, or its own error with a retry that asks only for what failed. In a
   * background refresh a failed request is made up for by its last good answer, so only a block that never had one says so.
   * @param {Block} block
   * @param {HTMLElement} slot
   * @param {boolean} [quiet] true in a background refresh; a retry the person pressed is never quiet
   */
  const fill = async (block, slot, quiet = false) => {
    const settled = await Promise.allSettled(block.paths.map(load));
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') good.set(/** @type {string} */ (block.paths[i]), s.value);
    });
    const failed = block.paths.filter((_, i) => settled[i]?.status === 'rejected');
    if (failed.length > 0 && !(quiet && failed.every((p) => good.has(p)))) {
      // Forget the answers that failed, so the retry asks for them again (the ones that worked are kept).
      failed.forEach((p) => cache.delete(p));
      slot.replaceChildren(
        section(
          block.title,
          errorState(S.home.failed(block.title), () => {
            slot.replaceChildren(skeleton(1));
            void fill(block, slot);
          }),
        ),
      );
      return;
    }
    // Every answer is fresh, or (background refresh only) the last good one stands in for the one that did not come.
    const painted = block.paint(
      block.paths.map((p) => good.get(p)),
      ctx,
    );
    slot.replaceChildren(...(painted ? [painted] : []));
  };

  const slots = BLOCKS.map((block) => ({ block, slot: h('div', { class: `home-slot${block.wide ? ' wide' : ''}`, 'data-block': block.id }) }));
  await Promise.all(slots.map(({ block, slot }) => fill(block, slot, silent)));
  return h('div', { class: 'home-view' }, [h('h2', { text: S.nav.home }), h('div', { class: 'home' }, slots.map(({ slot }) => slot))]);
}
