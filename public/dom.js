// Safe DOM construction (text only, never innerHTML) and display helpers.
// The time helpers come from the same file the server uses (/shared/time.js).
import { formatLocal, localDateKey, localInputToUtc, utcToLocalInput } from '../shared/time.js';
import { S, errorText, fieldErrorText } from './strings.js';

export { formatLocal, localDateKey, localInputToUtc, utcToLocalInput };

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'required', 'readOnly', 'multiple']);

/**
 * Build an element. Props: `class`, `text`, `onclick`-style listeners, DOM
 * properties (value, checked, disabled, ...) and plain attributes. Children may
 * be nodes, strings, numbers, arrays of those, or falsy (skipped). Content is
 * always inserted as text, so user data can never become markup.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...unknown} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  /** @type {Array<[string, unknown]>} */
  const late = [];
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    } else if (key === 'value') late.push([key, value]); // after <option> children exist
    else if (PROPERTY_KEYS.has(key)) Reflect.set(el, key, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  for (const [key, value] of late) Reflect.set(el, key, value);
  return el;
}

/**
 * @param {Node} parent
 * @param {unknown[]} children
 */
function append(parent, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * Replace all children of an element.
 * @param {Element} el
 * @param {...unknown} children
 */
export function setContent(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/**
 * "Sat, 20 Nov 09:00 - 13:00" on one local day, otherwise both ends in full.
 * @param {string} startIso
 * @param {string} endIso
 * @param {string} tz
 */
export function fmtRange(startIso, endIso, tz) {
  if (localDateKey(startIso, tz) === localDateKey(endIso, tz)) {
    return `${formatLocal(startIso, tz, 'day')}, ${formatLocal(startIso, tz, 'time')} – ${formatLocal(endIso, tz, 'time')}`;
  }
  return `${formatLocal(startIso, tz, 'datetime')} – ${formatLocal(endIso, tz, 'datetime')}`;
}

/**
 * Group items by the local calendar day of their start, keeping their order.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} startOf
 * @param {string} tz
 * @returns {Array<{key: string, label: string, items: T[]}>}
 */
export function groupByDay(items, startOf, tz) {
  /** @type {Array<{key: string, label: string, items: T[]}>} */
  const groups = [];
  for (const item of items) {
    const iso = startOf(item);
    const key = localDateKey(iso, tz);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: formatLocal(iso, tz, 'day'), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * Disable (or re-enable) every button inside a container while a request runs,
 * so a double tap cannot send the same action twice.
 * @param {Element} container
 * @param {boolean} busy
 */
export function setBusy(container, busy) {
  for (const button of container.querySelectorAll('button')) button.disabled = busy;
}

let fieldSeq = 0;

/**
 * @typedef {object} Field
 * @property {HTMLElement} row
 * @property {(code: string | null | undefined) => void} setError show a validation code (or clear with null)
 */

/**
 * Tell assistive technology which controls are invalid and where the message is.
 * @param {HTMLElement[]} controls
 * @param {boolean} invalid
 * @param {string[]} describedBy ids of the hint (if any) and of the error message
 */
function markInvalid(controls, invalid, describedBy) {
  for (const control of controls) {
    if (invalid) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
    if (describedBy.length > 0) control.setAttribute('aria-describedby', describedBy.join(' '));
    else control.removeAttribute('aria-describedby');
  }
}

/**
 * A labelled form control with a place for its error message.
 * @param {string} label
 * @param {HTMLElement} control
 * @param {string} [hint]
 * @returns {Field}
 */
export function field(label, control, hint) {
  if (!control.id) control.id = `field-${++fieldSeq}`;
  const hintId = `${control.id}-hint`;
  const errorId = `${control.id}-error`;
  const error = h('span', { class: 'field-error', role: 'alert', id: errorId });
  const row = h('div', { class: 'field' }, [
    h('label', { for: control.id, text: label }),
    control,
    hint ? h('small', { class: 'hint', id: hintId, text: hint }) : null,
    error,
  ]);
  const baseline = hint ? [hintId] : [];
  markInvalid([control], false, baseline);
  return {
    row,
    setError: (code) => {
      error.textContent = code ? fieldErrorText(code) : '';
      row.classList.toggle('invalid', !!code);
      markInvalid([control], !!code, code ? [...baseline, errorId] : baseline);
    },
  };
}

/**
 * A date input and a time input that together mean one instant in the
 * household zone (so the phone's own time zone never matters).
 * @param {string} label
 * @param {string | null} iso initial instant (UTC ISO) or null for empty
 * @param {string} tz
 * @returns {Field & { getIso: () => string | null, setIso: (iso: string) => void }}
 */
export function dateTimeField(label, iso, tz) {
  const date = h('input', { type: 'date', required: true, 'aria-label': `${label}: ${S.reserve.date}` });
  const time = h('input', { type: 'time', required: true, step: '60', 'aria-label': `${label}: ${S.reserve.time}` });
  /** @param {string} value */
  const setIso = (value) => {
    const parts = utcToLocalInput(value, tz);
    date.value = parts.date;
    time.value = parts.time;
  };
  if (iso) setIso(iso);
  const errorId = `field-${++fieldSeq}-error`;
  const error = h('span', { class: 'field-error', role: 'alert', id: errorId });
  const row = h('div', { class: 'field' }, [
    h('span', { class: 'label', text: label }),
    h('div', { class: 'pair' }, [date, time]),
    error,
  ]);
  return {
    row,
    setError: (code) => {
      error.textContent = code ? fieldErrorText(code) : '';
      row.classList.toggle('invalid', !!code);
      markInvalid([date, time], !!code, code ? [errorId] : []);
    },
    getIso: () => localInputToUtc(date.value, time.value, tz),
    setIso,
  };
}

/**
 * Read a start/end pair of date-time fields. A field that does not hold a valid
 * date and time is marked, and the result is then null.
 * @param {ReturnType<typeof dateTimeField>} start
 * @param {ReturnType<typeof dateTimeField>} end
 * @returns {{ start: string, end: string } | null}
 */
export function readRange(start, end) {
  const startIso = start.getIso();
  const endIso = end.getIso();
  if (!startIso) start.setError('invalid_datetime');
  if (!endIso) end.setError('invalid_datetime');
  return startIso && endIso ? { start: startIso, end: endIso } : null;
}

/**
 * Put the per-field codes of an API error on the matching form fields.
 * @param {Record<string, Field>} fields keyed by the API field name
 * @param {{ fields: Record<string, string> }} err
 */
export function showFieldErrors(fields, err) {
  for (const [name, code] of Object.entries(err.fields)) fields[name]?.setError(code);
}

/**
 * Message for a failed save: an overlap names the booking in the way, anything
 * else gets the generic text for its error code.
 * @param {import('./api.js').ApiError} err
 * @param {string} tz
 * @param {(who: string, when: string) => string} overlapText
 */
export function saveErrorText(err, tz, overlapText) {
  const conflict = err.body['conflict'];
  return err.code === 'overlap' && conflict
    ? overlapText(conflict.userName, fmtRange(conflict.start, conflict.end, tz))
    : errorText(err);
}

/**
 * A whole-number input (odometer reading, reservation number).
 * @param {number | null | undefined} value
 * @param {string} [min]
 */
export function numberInput(value, min = '0') {
  return h('input', { type: 'number', inputmode: 'numeric', min, step: '1', value: value === null || value === undefined ? '' : String(value) });
}

/**
 * @param {string} value
 * @returns {number | null} null when empty
 */
export function readNumber(value) {
  const v = value.trim();
  return v === '' ? null : Number(v);
}

/**
 * The "who" drop-down: every active user, the signed-in one marked as "me".
 * @param {Array<{ id: number, displayName: string }>} users
 * @param {number} meId
 * @param {boolean} disabled
 */
export function driverSelect(users, meId, disabled) {
  return h(
    'select',
    { name: 'driver', disabled },
    users.map((u) => h('option', { value: String(u.id), text: u.id === meId ? `${u.displayName} (${S.me})` : u.displayName })),
  );
}

/**
 * A toast function that writes into the element `getEl` returns (null: nothing to show yet).
 * @param {() => HTMLElement | null} getEl
 * @returns {(message: string, isError?: boolean) => void}
 */
export function toaster(getEl) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return (message, isError = false) => {
    const el = getEl();
    if (!el) return;
    el.textContent = message;
    el.className = isError ? 'toast show error' : 'toast show';
    clearTimeout(timer);
    // An error says what to fix, so it stays long enough to read and act on.
    timer = setTimeout(() => getEl()?.classList.remove('show'), isError ? 8000 : 4000);
  };
}

/**
 * Round an instant up to the next full hour.
 * @param {Date} date
 * @returns {Date}
 */
export function nextFullHour(date) {
  const hour = 3_600_000;
  return new Date(Math.ceil((date.getTime() + 1) / hour) * hour);
}
