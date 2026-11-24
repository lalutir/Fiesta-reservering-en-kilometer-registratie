// "Ongedaan maken" for a delete: the item disappears at once, a toast offers to take it back for six seconds, and
// only then is the DELETE sent. The API has no soft delete, so undo is a client-side deferral, which has rules:
//  - Only deletes that tell nobody anything may be deferred (test/notify.test.ts: nobody is told): your own damage
//    report, an explanation of a gap in the kilometre check, and your own open drive when the kilometres are yours and
//    it is not linked to someone else's reservation. A notification cannot be called back, so anything that notifies
//    another person, or that other people react to, asks first in a confirm sheet instead.
//  - The delete is sent no later than: the end of the window, the moment the page is hidden or closing (keepalive,
//    so the browser finishes it), the next write the person does, and walking to another place (enterPlace). So a delete
//    is never lost to a closed tab, and a deferred delete cannot make a following write fail (a new draft while the old
//    one is "gone"). Every page that can defer a delete installs the page-hide flush (installUndoFlush): the app shell
//    and the admin page, which shows the same kilometre check.
//  - The offer ends when the delete is sent, whatever sent it: commitNow withdraws the toast (toast.dismiss) at that moment,
//    so "Ongedaan maken" is never on screen for something that is already on its way. Only if another message has taken the
//    toast's place meanwhile, that message stays.
//  - Redrawing the same place is NOT leaving it. A refresh, the one-minute background render and a move inside the same
//    route (the edit form of a drive back to the list of drives) must leave a waiting delete waiting, or the DELETE would
//    go out while the toast still offers "Ongedaan maken" and the button would do nothing.
//  - Lists hide what is pending (isPending), so a refresh in the six seconds does not bring the item back.
//  - If the request fails the item comes back and the person is told.
import { S } from './strings.js';

/** How long the person has to change their mind. */
export const UNDO_MS = 6000;

/**
 * @typedef {object} Entry
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {Promise<void>} [sending] set while the DELETE is on its way
 * @property {(o: { keepalive: boolean, noFlush: boolean }) => Promise<unknown>} commit pass the options on to del()
 * @property {() => void} withdraw take the "Ongedaan maken" toast away (the delete is being sent)
 * @property {() => void} onUndo bring the item back on screen
 * @property {(error: unknown) => void} onError the request failed: bring it back and say so
 */

/** @type {Map<string, Entry>} */
const pending = new Map();

/** @param {string} key 'damage:12' */
export function isPending(key) {
  return pending.has(key);
}

/**
 * The ids of the pending deletes of one kind, for a list that must leave them out.
 * @param {string} kind
 * @returns {Set<number>}
 */
export function pendingIds(kind) {
  const ids = new Set();
  for (const key of pending.keys()) if (key.startsWith(`${kind}:`)) ids.add(Number(key.slice(kind.length + 1)));
  return ids;
}

/**
 * Send one pending delete (once: a second call while it is on its way waits for the first).
 * @param {string} key
 * @param {boolean} keepalive
 * @returns {Promise<void>}
 */
function commitNow(key, keepalive) {
  const entry = pending.get(key);
  if (!entry) return Promise.resolve();
  if (entry.sending) return entry.sending;
  clearTimeout(entry.timer);
  // The delete is on its way, so the offer to take it back ends now: after walking to another place, switching to another
  // app or the next write the button would otherwise stay on screen and do nothing.
  entry.withdraw();
  entry.sending = (async () => {
    try {
      // noFlush: this request IS the flush, it must not start another one.
      await entry.commit({ keepalive, noFlush: true });
      pending.delete(key);
    } catch (error) {
      pending.delete(key);
      entry.onError(error);
    }
  })();
  return entry.sending;
}

/**
 * Take an item away now and delete it for real after the undo window.
 * @param {object} o
 * @param {string} o.key kind and id: 'damage:12'
 * @param {string} o.message what the toast says ("Schademelding verwijderd.")
 * @param {(o: { keepalive: boolean, noFlush: boolean }) => Promise<unknown>} o.commit sends the DELETE: pass the options on, del(path, o)
 * @param {() => void} o.onUndo
 * @param {(error: unknown) => void} o.onError
 * @param {import('./api.js').Toast} o.toast the toaster itself (not a bare function), so the offer can be withdrawn
 */
export function deferDelete(o) {
  if (pending.has(o.key)) return;
  const timer = setTimeout(() => void commitNow(o.key, false), UNDO_MS);
  /** @type {import('./api.js').ToastAction} */
  const action = {
    label: S.undo.action,
    // The button leaves with the window, or with an early send (withdraw): a visible "Ongedaan maken" that no longer does
    // anything would be a lie.
    ms: UNDO_MS,
    run: () => {
      const entry = pending.get(o.key);
      // Not reachable from the screen any more once the delete is on its way (commitNow withdrew the toast); kept for a press
      // that was already under way at that moment.
      if (!entry || entry.sending) return;
      clearTimeout(entry.timer);
      pending.delete(o.key);
      entry.onUndo();
      o.toast(S.undo.restored);
    },
  };
  pending.set(o.key, { timer, commit: o.commit, onUndo: o.onUndo, onError: o.onError, withdraw: () => o.toast.dismiss?.(action) });
  o.toast(o.message, false, action);
}

/** Send every pending delete now and wait for them (before a write, and when the person walks to another place). */
export async function flushPending() {
  await Promise.all([...pending.keys()].map((key) => commitNow(key, false)));
}

/** The route name last asked for: null until the first one. */
let place = /** @type {string | null} */ (null);
/** The flush started by the last walk to another place; a second draw of the same place waits for it too. */
let leaving = Promise.resolve();

/**
 * The shell calls this before it draws a route. Walking to another place (another route name) sends what waits, and
 * resolves when that is done, so the next screen asks for its list after the delete. Drawing the same place again does
 * not: a refresh, a background render, or a move inside the place (#/usage?edit=9 back to #/usage) keeps a delete that
 * is still in its "Ongedaan maken" window waiting.
 * @param {string} name the route name about to be shown ('car', 'usage', ...)
 * @returns {Promise<void>}
 */
export function enterPlace(name) {
  if (place !== null && place !== name) leaving = flushPending();
  place = name;
  return leaving;
}

let listening = false;

/** Send the pending deletes when the page goes to the background or closes. Once per page. */
export function installUndoFlush() {
  if (listening) return;
  listening = true;
  const now = () => {
    for (const key of [...pending.keys()]) void commitNow(key, true);
  };
  window.addEventListener('pagehide', now);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) now();
  });
}

/** For tests: forget everything without sending it, and let the next page install its listeners again. */
export function resetUndo() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  listening = false;
  place = null;
  leaving = Promise.resolve();
}
