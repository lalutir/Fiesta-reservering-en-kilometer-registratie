// Unsent form input survives leaving the screen and reloading the page: a person who starts a reservation,
// switches to the Agenda to check a date and comes back finds what they typed. (Not to be confused with a drive
// "draft", the half-registered drive on the server: this is only text in a form, kept on this device.)
//
// The rules, each pinned by test/drafts.test.ts:
//  - Only the fields the person changed are kept, per person (the key has the user id: a shared phone never shows
//    one person's text to another) and per form. A form that is back to its starting values keeps nothing.
//  - Only forms for a NEW record use this. A form that edits something, or that arrives prefilled from a link
//    (a reservation card, a gap in the kilometre check), must show what the server or the link says.
//  - Never a password: a control of type password is ignored.
//  - It goes after a save or when the person discards it, at sign-out and when the session ends, and after seven days.
//  - Storage can be blocked or full: that only means nothing is kept (storage.js).
import { h } from './dom.js';
import { storageGet, storageKeys, storageRemove, storageSet } from './storage.js';
import { S } from './strings.js';
import { button } from './ui.js';

const PREFIX = 'draft:v1:';
/** How long unsent input is kept. */
export const DRAFT_TTL_MS = 7 * 24 * 3_600_000;

/** @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} FormControl */

/** @param {FormControl} control */
const isPassword = (control) => control.getAttribute('type') === 'password';
/** @param {FormControl} control */
const isCheckbox = (control) => control.getAttribute('type') === 'checkbox';
/** @param {FormControl} control */
const valueOf = (control) => (isCheckbox(control) ? String(/** @type {HTMLInputElement} */ (control).checked) : control.value);

/**
 * @param {FormControl} control
 * @param {string} value
 */
function setValue(control, value) {
  if (isCheckbox(control)) /** @type {HTMLInputElement} */ (control).checked = value === 'true';
  else control.value = value;
}

/**
 * @param {number} userId
 * @param {string} name
 */
export const draftKey = (userId, name) => `${PREFIX}${userId}:${name}`;

/**
 * Restore what was typed into a new-record form earlier and keep saving changes from now on.
 * @param {object} o
 * @param {number} o.userId the signed-in person
 * @param {string} o.name the form ('reservation', 'drive', 'fuel', 'ticket', 'damage')
 * @param {Record<string, FormControl>} o.controls the form's controls by a stable name
 * @param {() => void} [o.onReset] runs after discard() put the starting values back (a label that follows a field, say)
 * @returns {{ restored: boolean, clear: () => void, discard: () => void }} clear = the save succeeded; discard = back to the starting values
 */
export function persistForm(o) {
  const key = draftKey(o.userId, o.name);
  /** @type {Array<[string, FormControl]>} */
  const entries = Object.entries(o.controls).filter(([, control]) => !isPassword(control));
  const defaults = new Map(entries.map(([name, control]) => [name, valueOf(control)]));

  let restored = false;
  const stored = storageGet(key);
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored);
      const fresh = typeof parsed?.at === 'number' && Date.now() - parsed.at < DRAFT_TTL_MS;
      if (fresh && parsed.values && typeof parsed.values === 'object') {
        for (const [name, control] of entries) {
          const value = parsed.values[name];
          if (typeof value !== 'string') continue;
          const before = valueOf(control);
          setValue(control, value);
          // A <select> keeps its old value when the saved one is no longer one of its options (a person who left since).
          if (valueOf(control) === value && value !== before) restored = true;
          else if (valueOf(control) !== value) setValue(control, before);
        }
      } else {
        storageRemove(key);
      }
    } catch {
      storageRemove(key);
    }
  }

  const save = () => {
    /** @type {Record<string, string>} */
    const values = {};
    for (const [name, control] of entries) {
      const now = valueOf(control);
      if (now !== defaults.get(name)) values[name] = now;
    }
    if (Object.keys(values).length === 0) storageRemove(key);
    else storageSet(key, JSON.stringify({ at: Date.now(), values }));
  };
  for (const [, control] of entries) {
    control.addEventListener('input', save);
    control.addEventListener('change', save);
  }

  return {
    restored,
    clear: () => storageRemove(key),
    discard: () => {
      for (const [name, control] of entries) setValue(control, defaults.get(name) ?? '');
      storageRemove(key);
      o.onReset?.();
    },
  };
}

/**
 * The line above a form whose input came back: what happened and a button to start over. Null when nothing was restored.
 * @param {ReturnType<typeof persistForm>} draft
 * @returns {HTMLElement | null}
 */
export function restoredLine(draft) {
  if (!draft.restored) return null;
  const notice = restoredNotice();
  const line = h('div', { class: 'restored', role: 'status' }, [
    h('span', { text: notice.text }),
    button({
      label: notice.clear,
      small: true,
      onclick: () => {
        draft.discard();
        line.remove();
      },
    }),
  ]);
  return line;
}

/** The message and the button to put above a form whose input was restored. */
export const restoredNotice = () => ({ text: S.ui.unsaved, clear: S.ui.unsavedClear });

/** Forget every unsent form on this device: sign-out, and a session that ended. */
export function clearAllDrafts() {
  for (const key of storageKeys(PREFIX)) storageRemove(key);
}
