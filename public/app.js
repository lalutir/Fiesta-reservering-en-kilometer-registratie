// App shell: hash router, the bar of places (nav.js), session handling and the refresh loop.
import { ApiError, get, setUnauthorizedHandler } from './api.js';
import { h, setContent, toaster } from './dom.js';
import { clearAllDrafts } from './drafts.js';
import { bareLaunch, buildNav, titleOf } from './nav.js';
import { S, errorText } from './strings.js';
import { initTheme } from './theme.js';
import { errorState, overlayOpen, skeleton } from './ui.js';
import { enterPlace, installUndoFlush, isPending } from './undo.js';
import * as account from './views/account.js';
import * as agenda from './views/agenda.js';
import * as car from './views/car.js';
import * as fuel from './views/fuel.js';
import * as history from './views/history.js';
import * as home from './views/home.js';
import * as inbox from './views/inbox.js';
import * as login from './views/login.js';
import * as more from './views/more.js';
import * as reserve from './views/reserve.js';
import * as tickets from './views/tickets.js';
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
 * @property {(app: import('./api.js').App, route: Route, opts?: { silent?: boolean }) => Promise<HTMLElement>} render
 */

/** @type {Record<string, View>} */
const VIEWS = { home, more, agenda, reserve, inbox, usage, fuel, tickets, history, car, account };
const REFRESH_MS = 60_000;
/** A screen that answers faster than this shows no skeleton at all, so a quick answer does not flash. */
const SKELETON_DELAY_MS = 120;

const root = /** @type {HTMLElement} */ (document.getElementById('app'));

/** @type {import('./api.js').App | null} */
let app = null;
/** @type {HTMLElement | null} */
let viewHost = null;
/** @type {HTMLElement | null} */
let toastEl = null;
/** @type {ReturnType<typeof buildNav> | null} */
let nav = null;
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

/** Inbox (answers waiting) and Drives (kilometres to register) counts, fetched side by side. */
async function updateBadge() {
  if (!app || !nav) return;
  // Each badge is a convenience: if its request fails the other still updates, and the views report real errors.
  const [inbox, pending] = await Promise.allSettled([get('/api/inbox'), get('/api/usage/pending')]);
  if (inbox.status === 'fulfilled') nav.setBadge('inbox', inbox.value.incomingCount);
  if (pending.status === 'fulfilled') {
    // A draft that was deleted a moment ago (and can still be taken back) is not waiting for anything: the list leaves it out, so does the count.
    /** @type {import('./api.js').Usage[]} */
    const drafts = pending.value.items[0]?.drafts ?? [];
    nav.setBadge('usage', Math.max(0, pending.value.count - drafts.filter((d) => isPending(`draft:${d.id}`)).length));
  }
}

/**
 * After the person moves to another place: start at the top and put keyboard and
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
 * @param {{ silent?: boolean, navigated?: boolean, retry?: boolean }} [opts] silent = background refresh: keep what is shown
 *   on errors; navigated = the route changed (not a reload of the same view); retry = "Opnieuw proberen" on an error page
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
  // Walking to another place sends a delete that is waiting out its "Ongedaan maken" window, before the next screen asks for
  // the list it was in. Drawing the same place again (refresh(), the background render, #/usage?edit=9 back to #/usage) must
  // not: the lists leave out what is pending, and the toast is still offering to take it back.
  await enterPlace(route.name);
  if (token !== renderToken) return;
  nav?.setCurrent(route.name);
  const title = titleOf(route.name);
  document.title = title ? `${title} - ${S.appName}` : S.appName;
  const host = viewHost;
  // The old page gives way to a skeleton once the answer is slow, never sooner, and only where it has nothing left to show:
  // on a place the person walked to, on a retry after an error, and while the shell is still empty. Redrawing the same place
  // after an action (app.refresh(): approve, decline, cancel, delete) keeps what is on screen until the new page is ready.
  // A long list swapped for a short skeleton shrinks the document and the browser then clamps the scroll position, so the
  // page would come back at the top.
  const timer =
    !opts.silent && (opts.navigated || opts.retry || !host.hasChildNodes())
      ? setTimeout(() => token === renderToken && setContent(host, skeleton()), SKELETON_DELAY_MS)
      : undefined;
  try {
    const el = await view.render(app, route, { silent: opts.silent === true });
    if (token !== renderToken) return;
    setContent(host, el);
    if (opts.navigated) landOnView();
  } catch (err) {
    if (token !== renderToken || opts.silent) return;
    setContent(host, errorState(errorText(/** @type {ApiError} */ (err)), () => void renderCurrent({ retry: true })));
  } finally {
    clearTimeout(timer);
  }
  void updateBadge();
}

async function refresh() {
  await renderCurrent();
}

function backgroundRefresh() {
  // A sheet or a drawer is open, or a field has the keyboard: the page under it stays as it is.
  if (!app || document.hidden || isEditing() || overlayOpen()) return;
  const view = VIEWS[currentRoute().name];
  if (view?.live) void renderCurrent({ silent: true });
  else void updateBadge();
}

/** Build the bar and the view host once per sign-in. */
function buildShell(/** @type {import('./api.js').Session} */ session) {
  toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  viewHost = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const main = viewHost;
  nav = buildNav({ user: session.user, toast, onSignOut: () => void account.signOut(/** @type {import('./api.js').App} */ (app)) });
  setContent(
    root,
    h('div', { class: 'shell' }, [
      // The link must not change the hash: the hash is the router.
      h('a', { class: 'skip-link', href: '#view', onclick: (/** @type {Event} */ e) => (e.preventDefault(), main.focus()) }, S.ui.skipToContent),
      nav.rail,
      viewHost,
      toastEl,
    ]),
  );
}

/** @param {string | undefined} [notice] message shown above the login form */
function showLogin(notice) {
  app = null;
  viewHost = null;
  nav = null;
  renderToken++;
  // Whatever was typed and not sent belongs to the person who is gone: a shared phone must not show it to the next one.
  clearAllDrafts();
  document.title = `${S.login.title} - ${S.appName}`;
  setContent(root, login.render({ notice, onSuccess: () => void start() }));
}

/** @param {boolean} [quiet] true after an explicit sign-out: no "session ended" notice */
async function signedOut(quiet = false) {
  showLogin(quiet ? undefined : S.errors.unauthenticated);
}

async function start() {
  // Something to look at while the first requests run (also right after signing in).
  setContent(root, skeleton());
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
    setContent(root, errorState(errorText(/** @type {ApiError} */ (err)), () => void start()));
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
  // A launch with nothing after the address opens Start. replaceState does not fire hashchange: one render, not two.
  if (bareLaunch(location.hash)) window.history.replaceState(null, '', '#/home');
  await renderCurrent();
}

initTheme();
installUndoFlush();
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
