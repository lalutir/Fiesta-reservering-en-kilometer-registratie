// App shell: hash router, tab bar, session handling and the refresh loop.
import { ApiError, get, setUnauthorizedHandler } from './api.js';
import { h, setContent, toaster } from './dom.js';
import { S, errorText } from './strings.js';
import * as account from './views/account.js';
import * as agenda from './views/agenda.js';
import * as fuel from './views/fuel.js';
import * as history from './views/history.js';
import * as inbox from './views/inbox.js';
import * as login from './views/login.js';
import * as reserve from './views/reserve.js';
import * as usage from './views/usage.js';

/**
 * @typedef {object} Route
 * @property {string} name
 * @property {string | undefined} arg
 * @property {URLSearchParams} query
 */
/**
 * @typedef {object} View
 * @property {boolean} live re-render automatically when the page comes back or on a timer
 * @property {(app: import('./api.js').App, route: Route) => Promise<HTMLElement>} render
 */

/** @type {Record<string, View>} */
const VIEWS = { agenda, reserve, inbox, usage, fuel, history, account };
const TABS = [
  ['agenda', S.nav.agenda],
  ['reserve', S.nav.reserve],
  ['inbox', S.nav.inbox],
  ['usage', S.nav.usage],
  ['history', S.nav.history],
  ['account', S.nav.account],
];
// Routes that live under a tab: Fuel and costs is reached from Drives, so that tab stays highlighted.
const TAB_OF_ROUTE = { fuel: 'usage' };
const REFRESH_MS = 60_000;

const root = /** @type {HTMLElement} */ (document.getElementById('app'));

/** @type {import('./api.js').App | null} */
let app = null;
/** @type {HTMLElement | null} */
let viewHost = null;
/** @type {HTMLElement | null} */
let toastEl = null;
/** @type {HTMLElement | null} */
let inboxBadgeEl = null;
/** @type {HTMLElement | null} */
let drivesBadgeEl = null;
/** @type {HTMLElement | null} */
let inboxTabEl = null;
/** @type {HTMLElement | null} */
let drivesTabEl = null;
let renderToken = 0;

/** @returns {Route} */
function currentRoute() {
  const [pathPart = '', queryPart = ''] = location.hash.replace(/^#/, '').split('?');
  const segments = pathPart.split('/').filter(Boolean);
  return { name: segments[0] ?? 'agenda', arg: segments[1], query: new URLSearchParams(queryPart) };
}

const toast = toaster(() => toastEl);

/** The user is typing in a form: do not rebuild the page under them. */
function isEditing() {
  const active = document.activeElement;
  return !!viewHost && !!active && viewHost.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
}

/**
 * @param {HTMLElement | null} badge
 * @param {HTMLElement | null} tab
 * @param {number} count
 * @param {(n: number) => string} label
 */
function showBadge(badge, tab, count, label) {
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
  // The bare number means nothing to a screen reader: give the tab a name that says what it counts.
  if (count > 0) tab?.setAttribute('aria-label', label(count));
  else tab?.removeAttribute('aria-label');
}

/** Inbox (answers waiting) and Drives (kilometres to register) counts, fetched side by side. */
async function updateBadge() {
  if (!app || !inboxBadgeEl) return;
  // Each badge is a convenience: if its request fails the other still updates, and the views report real errors.
  const [inbox, pending] = await Promise.allSettled([get('/api/inbox'), get('/api/usage/pending')]);
  if (inbox.status === 'fulfilled') showBadge(inboxBadgeEl, inboxTabEl, inbox.value.incomingCount, S.inbox.tabLabel);
  if (pending.status === 'fulfilled') showBadge(drivesBadgeEl, drivesTabEl, pending.value.count, S.usage.tabLabel);
}

/**
 * After the person moves to another tab: start at the top and put keyboard and
 * screen reader focus on the view's heading, so they know where they landed.
 */
function landOnView() {
  if (!viewHost) return;
  window.scrollTo(0, 0);
  const target = viewHost.querySelector('h2') ?? viewHost;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/**
 * @param {{ silent?: boolean, navigated?: boolean }} [opts] silent = background refresh: keep what is shown on errors;
 *   navigated = the route changed (not a reload of the same view)
 */
async function renderCurrent(opts = {}) {
  if (!app || !viewHost) return;
  const route = currentRoute();
  const view = VIEWS[route.name];
  if (!view) {
    location.replace('#/');
    return;
  }
  const token = ++renderToken;
  const tabName = /** @type {Record<string, string>} */ (TAB_OF_ROUTE)[route.name] ?? route.name;
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.getAttribute('data-tab') === tabName) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const tabLabel = route.name === 'fuel' ? S.fuel.title : TABS.find(([name]) => name === route.name)?.[1];
  document.title = tabLabel ? `${tabLabel} - ${S.appName}` : S.appName;
  try {
    const el = await view.render(app, route);
    if (token !== renderToken) return;
    setContent(viewHost, el);
    if (opts.navigated) landOnView();
  } catch (err) {
    if (token !== renderToken || opts.silent) return;
    const e = /** @type {ApiError} */ (err);
    setContent(
      viewHost,
      h('div', { class: 'card error-card' }, [
        h('p', { text: errorText(e) }),
        h('button', { class: 'btn', type: 'button', onclick: () => void renderCurrent() }, S.retry),
      ]),
    );
  }
  void updateBadge();
}

async function refresh() {
  await renderCurrent();
}

function backgroundRefresh() {
  if (!app || document.hidden || isEditing()) return;
  const view = VIEWS[currentRoute().name];
  if (view?.live) void renderCurrent({ silent: true });
  else void updateBadge();
}

/** Build the tab bar and view host once per sign-in. */
function buildShell(/** @type {import('./api.js').Session} */ session) {
  inboxBadgeEl = h('span', { class: 'badge', hidden: true }, '0');
  drivesBadgeEl = h('span', { class: 'badge', hidden: true }, '0');
  toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  viewHost = h('main', { class: 'view', id: 'view' });
  const tabs = TABS.map(([name, label]) => {
    const link = h('a', { class: 'tab', href: `#/${name === 'agenda' ? '' : name}`, 'data-tab': name }, [
      h('span', { class: 'tab-label' }, label),
      name === 'inbox' ? inboxBadgeEl : name === 'usage' ? drivesBadgeEl : null,
    ]);
    if (name === 'inbox') inboxTabEl = link;
    if (name === 'usage') drivesTabEl = link;
    return link;
  });
  setContent(
    root,
    h('div', { class: 'shell' }, [
      h('header', { class: 'topbar' }, [
        h('h1', { class: 'title', text: S.appName }),
        h('span', { class: 'who', text: session.user.displayName }),
        session.user.role === 'admin' ? h('a', { class: 'admin-link', href: '/admin/' }, S.nav.admin) : null,
      ]),
      viewHost,
      h('nav', { class: 'tabs', 'aria-label': 'Main' }, tabs),
      toastEl,
    ]),
  );
}

/** @param {string | undefined} [notice] message shown above the login form */
function showLogin(notice) {
  app = null;
  viewHost = null;
  inboxTabEl = null;
  drivesTabEl = null;
  renderToken++;
  document.title = `${S.login.title} - ${S.appName}`;
  setContent(root, login.render({ notice, onSuccess: () => void start() }));
}

/** @param {boolean} [quiet] true after an explicit sign-out: no "session ended" notice */
async function signedOut(quiet = false) {
  showLogin(quiet ? undefined : S.errors.unauthenticated);
}

async function start() {
  // Something to look at while the first requests run (also right after signing in).
  setContent(root, h('p', { class: 'empty', role: 'status', text: S.loading }));
  /** @type {import('./api.js').Session} */
  let session;
  /** @type {import('./api.js').UserRef[]} */
  let users;
  try {
    session = await get('/api/auth/me');
    ({ users } = await get('/api/users'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      showLogin();
      return;
    }
    setContent(
      root,
      h('div', { class: 'card error-card' }, [
        h('p', { text: errorText(/** @type {ApiError} */ (err)) }),
        h('button', { class: 'btn', type: 'button', onclick: () => void start() }, S.retry),
      ]),
    );
    return;
  }
  buildShell(session);
  app = {
    session,
    tz: session.timeZone,
    users,
    navigate: (hash) => {
      if (location.hash === hash) void renderCurrent();
      else location.hash = hash;
    },
    refresh,
    toast,
    signedOut,
  };
  await renderCurrent();
}

setUnauthorizedHandler(() => {
  if (app) void signedOut();
});
window.addEventListener('hashchange', () => void renderCurrent({ navigated: true }));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) backgroundRefresh();
});
setInterval(backgroundRefresh, REFRESH_MS);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // the app works without it; only offline start-up is lost
    });
  });
}

void start();
