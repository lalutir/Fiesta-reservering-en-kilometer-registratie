// The places of the app and the bar (phone) or rail (tablet and up) that leads to them.
//
// Five places fit a phone at 320 px; the other places are one more tap away on the page Meer (#/more), and from
// 768 px the rail lists them all, so there is no second tap at all. Everything in here that does not touch the page
// is pure (the route-to-place rules, the titles, the badge texts) and is tested without a DOM (test/nav.test.ts).
import { h } from './dom.js';
import { icon } from './icons.js';
import { S } from './strings.js';
import { themeControl } from './theme.js';
import { button } from './ui.js';

/** @typedef {{ name: string, href: string, label: string, icon: string, book?: boolean }} NavItem */

/** The five places of the bar. Boeken is raised and yellow: the one action that is one tap away from everywhere. @type {NavItem[]} */
export const PRIMARY = [
  { name: 'home', href: '#/home', label: S.nav.home, icon: 'home' },
  { name: 'agenda', href: '#/', label: S.nav.agenda, icon: 'calendar' },
  { name: 'reserve', href: '#/reserve', label: S.nav.reserve, icon: 'plus', book: true },
  { name: 'usage', href: '#/usage', label: S.nav.usage, icon: 'route' },
  { name: 'more', href: '#/more', label: S.nav.more, icon: 'more' },
];

/** The places under Meer. On a phone they are rows of the page Meer; in the rail they are links like the others. @type {NavItem[]} */
export const SECONDARY = [
  { name: 'inbox', href: '#/inbox', label: S.nav.inbox, icon: 'inbox' },
  { name: 'history', href: '#/history', label: S.nav.history, icon: 'history' },
  { name: 'car', href: '#/car', label: S.nav.car, icon: 'car' },
  { name: 'account', href: '#/account', label: S.nav.account, icon: 'user' },
];

/** The admin page is its own document, outside the hash router: a plain link, for admins only. @type {NavItem} */
export const ADMIN_ITEM = { name: 'admin', href: '/admin/', label: S.nav.admin, icon: 'shield' };

/** Which place of the bar a route belongs to: the sub-routes of Ritten keep Ritten lit, the places under Meer light Meer. @type {Record<string, string>} */
const PLACE_OF_ROUTE = { fuel: 'usage', tickets: 'usage', inbox: 'more', history: 'more', car: 'more', account: 'more' };

/** The page title of the routes that have no label of their own in the bar. @type {Record<string, string>} */
const SUBVIEW_TITLE = { fuel: S.fuel.title, tickets: S.tickets.title, more: S.nav.more };

/**
 * @param {string} routeName
 * @returns {string} the place of the bar this route lives under
 */
export function placeOf(routeName) {
  return PLACE_OF_ROUTE[routeName] ?? routeName;
}

/**
 * The links that show "you are here" for a route: its place in the bar and, in the rail, the link itself when it is one
 * of the places under Meer.
 * @param {string} routeName
 * @returns {string[]}
 */
export function currentPlaces(routeName) {
  const places = [placeOf(routeName)];
  if (SECONDARY.some((item) => item.name === routeName)) places.push(routeName);
  return places;
}

/**
 * @param {string} routeName
 * @returns {string | null} the title of the page (the browser tab, the history list), or null when it has none
 */
export function titleOf(routeName) {
  return SUBVIEW_TITLE[routeName] ?? [...PRIMARY, ...SECONDARY].find((item) => item.name === routeName)?.label ?? null;
}

/**
 * Only a launch with nothing after the address opens Start. "#/" is the Agenda (the README, the calendar and the
 * tests use that address) and every other hash is a screen somebody asked for, a push notification included.
 * @param {string} hash location.hash
 * @returns {boolean}
 */
export function bareLaunch(hash) {
  return hash === '';
}

/**
 * @param {'inbox' | 'usage' | 'more'} kind
 * @param {number} count
 * @returns {string} what a screen reader says for a tab that carries a count
 */
export function badgeLabel(kind, count) {
  if (kind === 'usage') return S.usage.tabLabel(count);
  if (kind === 'more') return S.more.tabLabel(count);
  return S.inbox.tabLabel(count);
}

/**
 * @param {NavItem} item
 * @param {string[]} extraClass
 * @returns {HTMLAnchorElement}
 */
function tabLink(item, extraClass) {
  return h('a', { class: ['tab', item.book ? 'tab-book' : '', ...extraClass].filter(Boolean).join(' '), href: item.href, 'data-tab': item.name }, [
    item.book ? h('span', { class: 'tab-mark' }, icon(item.icon)) : icon(item.icon),
    h('span', { class: 'tab-label', text: item.label }),
  ]);
}

/**
 * The top bar and the bar or rail of places.
 * @param {object} o
 * @param {{ displayName: string, role: string }} o.user
 * @param {() => void} o.onSignOut
 * @param {(message: string, isError?: boolean) => void} o.toast
 * @returns {{ rail: HTMLElement, setCurrent: (routeName: string) => void, setBadge: (kind: 'inbox' | 'usage', count: number) => void }}
 */
export function buildNav(o) {
  const isAdmin = o.user.role === 'admin';
  /** @type {Map<string, HTMLAnchorElement>} */
  const links = new Map();
  /** @type {Map<string, HTMLElement>} */
  const badges = new Map();
  /**
   * @param {NavItem} item
   * @param {string[]} extraClass
   * @param {boolean} counted a count rides on this link (Ritten, Meer, and Inbox in the rail)
   */
  const add = (item, extraClass, counted) => {
    const link = tabLink(item, extraClass);
    links.set(item.name, link);
    if (counted) {
      const badge = h('span', { class: 'badge', hidden: true }, '0');
      badges.set(item.name, badge);
      link.appendChild(badge);
    }
    return link;
  };
  const tabs = [
    ...PRIMARY.map((item) => add(item, item.name === 'more' ? ['tab-more'] : [], item.name === 'usage' || item.name === 'more')),
    ...SECONDARY.map((item) => add(item, ['tab-secondary'], item.name === 'inbox')),
    isAdmin ? tabLink(ADMIN_ITEM, ['tab-secondary']) : null,
  ];
  const nav = h('nav', { class: 'tabs', 'aria-label': S.nav.label }, tabs);
  const rail = h('div', { class: 'rail' }, [
    h('header', { class: 'topbar' }, [h('h1', { class: 'title', text: S.appName }), h('span', { class: 'who', text: o.user.displayName })]),
    nav,
    h('div', { class: 'rail-foot' }, [
      h('span', { class: 'who', text: o.user.displayName }),
      themeControl(o.toast),
      button({ label: S.account.signOut, small: true, block: true, onclick: () => o.onSignOut() }),
    ]),
  ]);

  /**
   * @param {'inbox' | 'usage' | 'more'} name the link, which is also what it counts
   * @param {number} count
   */
  const show = (name, count) => {
    const badge = badges.get(name);
    const link = links.get(name);
    if (!badge || !link) return;
    badge.textContent = String(count);
    badge.hidden = count === 0;
    // The bare number means nothing to a screen reader: the link gets a name that says what it counts.
    if (count > 0) link.setAttribute('aria-label', badgeLabel(name, count));
    else link.removeAttribute('aria-label');
  };

  return {
    rail,
    setCurrent(routeName) {
      const here = currentPlaces(routeName);
      for (const [name, link] of links) {
        if (here.includes(name)) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
    setBadge(kind, count) {
      if (kind === 'usage') show('usage', count);
      else {
        // Answers waiting ride on the Inbox link in the rail and on Meer on a phone (Inbox is one of its rows).
        show('inbox', count);
        show('more', count);
      }
    },
  };
}
